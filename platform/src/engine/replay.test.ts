/** D138: an upcoming booking with no run is handed to the booked-call workflows again, once; a call that has started, a cancelled one, and a baseline booking (unless asked) are not. */
import { describe, it, expect, beforeAll } from "vitest";
import { asOperator, many, one } from "@/db/client";
import { migrate } from "@/db/migrate";
import { installCompany, syncTriggers } from "@/engine/install";
import { emitEvent } from "@/engine/dispatch";
import { parseDefinition, extractManifest } from "@/engine/definition";
import { replayBookings, lateStart } from "@/engine/replay";
import { catchUpCalendar } from "@/engine/poll";
import { fakeAdapters, unlockSendsForTest } from "@/engine/test-install";
import { tick } from "@/engine/runner";

process.env.BINDINGS_KEY ??= Buffer.alloc(32, 7).toString("base64");
const SLUG = `d138-${Date.now()}`;
let co = "";
const appt = (hoursAhead: number, status = "confirmed", withEvent = true) => asOperator(async (c) => {
  const ct = (await one<{ id: string }>(c, "insert into contacts (company_id, ghl_contact_id, first_name) values ($1,$2,'Rae') returning id", [co, `G${Math.random()}`]))!.id;
  const term = (await one<{ id: string }>(c, "select id from company_terms where company_id=$1 and domain='appointment_type' and category='closing' limit 1", [co]))!.id;
  const a = (await one<{ id: string }>(c, "insert into appointments (company_id, contact_id, external_id, appointment_term, starts_at, ends_at, booked_at, status) values ($1,$2,$3,$4,now() + make_interval(hours => $5), now() + make_interval(hours => $5 + 1), now(),$6) returning id", [co, ct, `E${Math.random()}`, term, hoursAhead, status]))!.id;
  if (withEvent) await emitEvent(c, { company_id: co, contact_id: ct, opportunity_id: null, appointment_id: a, event_type: "appointment.booked", source: "ghl_poll", data: {} });
  return a;
});
const runs = (a: string) => asOperator((c) => many(c, "select 1 from runs where appointment_id=$1", [a]));

describe.skipIf(!process.env.DATABASE_URL)("D138: replaying bookings", () => {
  beforeAll(async () => {
    await migrate();
    co = (await installCompany({ name: "Replay", slug: SLUG, timezone: "America/Phoenix", locationId: "LOC-D138", pit: "pit-fake", calendars: {}, templates: [] }, fakeAdapters())).companyId;
    await asOperator(async (c) => {
      const nodes = [{ id: "t1", type: "trigger", event: "appointment.booked" }, { id: "x1", type: "exit", reason: "done" }];
      const def = parseDefinition({ schema: 1, reentry: "always", premise: { check: "none" }, nodes, edges: [{ from: "t1", to: "x1" }] });
      const wf = (await one<{ id: string }>(c, "insert into workflows (company_id, name, reentry_policy, enabled) values ($1,'Booked','always',true) returning id", [co]))!;
      await c.query("insert into workflow_versions (workflow_id, version, definition, manifest) values ($1,1,$2,$3)", [wf.id, def, extractManifest(def)]);
      await syncTriggers(c, co, wf.id, def);
    });
  });

  it("dry run says what it would do and starts nothing; the real one starts the booked workflow once; again, it is refused while its run goes and after unless asked again (D142)", async () => {
    const a = await appt(24);
    expect(await asOperator((c) => replayBookings(c, co, [a], { dryRun: true }))).toMatchObject([{ appointment_id: a, would: "replay" }]);
    expect(await runs(a)).toEqual([]);
    expect(await asOperator((c) => replayBookings(c, co, [a], { dryRun: false }))).toMatchObject([{ would: "replay", runs_started: 1 }]);
    expect((await runs(a)).length).toBe(1);
    expect(await asOperator((c) => replayBookings(c, co, [a], { dryRun: false }))).toMatchObject([{ would: "skip", why: "a run of it is still going" }]);
    // D142: its run over, it is refused unless asked again (its workflows changed, what the old run made taken back)
    await asOperator((c) => c.query("update runs set status='completed', finished_at=now() where appointment_id=$1", [a]));
    expect(await asOperator((c) => replayBookings(c, co, [a], { dryRun: false }))).toMatchObject([{ would: "skip", why: "it already has runs (again: true hands it on anyway)" }]);
    expect(await asOperator((c) => replayBookings(c, co, [a], { dryRun: false, again: true }))).toMatchObject([{ would: "replay", runs_started: 1 }]);
    expect((await runs(a)).length).toBe(2);
  });

  it("refused: a call that has started, a cancelled booking; a baseline booking only when asked, with an event recorded for it", async () => {
    const past = await appt(-1), cancelled = await appt(24, "cancelled"), baseline = await appt(48, "confirmed", false);
    expect((await asOperator((c) => replayBookings(c, co, [past, cancelled, baseline], { dryRun: false }))).map((r) => r.why)).toEqual(["the call has started", "cancelled", "a baseline booking (no event): replay it with baseline: true"]);
    expect(await asOperator((c) => replayBookings(c, co, [baseline], { dryRun: false, baseline: true }))).toMatchObject([{ would: "replay", runs_started: 1 }]);
    expect(await asOperator((c) => one(c, "select source, data->>'replay' as replay from events where appointment_id=$1 and event_type='appointment.booked'", [baseline]))).toEqual({ source: "engine", replay: "true" });
  });

  it("D195: handed to one workflow (the pre-call at its unlock): only that workflow starts, the booked one never runs again; a booking it is still running is skipped; one whose event a go-live cleared gets a new one", async () => {
    const pre = await asOperator(async (c) => {
      const nodes = [{ id: "t1", type: "trigger", event: "appointment.booked" }, { id: "w1", type: "wait", rule: { anchor: "appointment.starts_at", offset: "-1h" } }, { id: "x1", type: "exit", reason: "done" }];
      const def = parseDefinition({ schema: 1, reentry: "once_per_appointment", reentry_key: "{{appointment.starts_at}}", premise: { check: "none" }, nodes, edges: [{ from: "t1", to: "w1" }, { from: "w1", to: "x1" }] });
      const wf = (await one<{ id: string }>(c, "insert into workflows (company_id, name, reentry_policy, enabled) values ($1,'Pre-call','once_per_appointment',true) returning id", [co]))!;
      await c.query("insert into workflow_versions (workflow_id, version, definition, manifest) values ($1,1,$2,$3)", [wf.id, def, extractManifest(def)]);
      await syncTriggers(c, co, wf.id, def);
      return wf.id;
    });
    const a = await appt(30), cleared = await appt(40, "confirmed", false);
    const byWf = (x: string) => asOperator((c) => many<{ name: string }>(c, "select w.name from runs r join workflows w on w.id=r.workflow_id where r.appointment_id=$1 order by w.name", [x]));
    expect(await asOperator((c) => replayBookings(c, co, [a, cleared], { dryRun: false, workflowId: pre }))).toMatchObject([{ would: "replay", runs_started: 1 }, { would: "replay", runs_started: 1 }]);
    expect(await byWf(a)).toEqual([{ name: "Pre-call" }]);
    expect(await byWf(cleared)).toEqual([{ name: "Pre-call" }]);
    expect(await asOperator((c) => replayBookings(c, co, [a], { dryRun: false, workflowId: pre }))).toMatchObject([{ would: "skip", why: "a run of it is still going" }]);
    // D210: restart stops the one still going (its key freed) and starts it afresh; a dry run only says so
    const live = () => asOperator((c) => many<{ status: string; exit_reason: string | null }>(c, "select status, exit_reason from runs where appointment_id=$1 and workflow_id=$2 order by started_at", [a, pre]));
    expect(await asOperator((c) => replayBookings(c, co, [a], { dryRun: true, workflowId: pre, restart: true }))).toMatchObject([{ would: "restart" }]);
    expect((await live()).map((r) => r.status)).toEqual(["active"]);
    expect(await asOperator((c) => replayBookings(c, co, [a], { dryRun: false, workflowId: pre, restart: true }))).toMatchObject([{ would: "restart", runs_started: 1 }]);
    expect(await live()).toEqual([{ status: "exited", exit_reason: "restarted by the operator" }, { status: "active", exit_reason: null }]);
  });

  it("D290: started at a step: a late pre-call begins at its reminder's wait and never reaches its booking text; a send or a step it lacks is refused", async () => {
    const pre = await asOperator(async (c) => {
      const nodes = [{ id: "t1", type: "trigger", event: "appointment.booked" }, { id: "s1", type: "send_sms", template: "you're booked", kind: "transactional" }, { id: "w1", type: "wait", rule: { anchor: "appointment.starts_at", offset: "-1h" } }, { id: "x1", type: "exit", reason: "done" }];
      const def = parseDefinition({ schema: 1, reentry: "once_per_appointment", reentry_key: "{{appointment.starts_at}}", premise: { check: "none" }, nodes, edges: [{ from: "t1", to: "s1" }, { from: "s1", to: "w1" }, { from: "w1", to: "x1" }] });
      const wf = (await one<{ id: string }>(c, "insert into workflows (company_id, name, reentry_policy, enabled) values ($1,'Late pre-call','once_per_appointment',true) returning id", [co]))!;
      await c.query("insert into workflow_versions (workflow_id, version, definition, manifest) values ($1,1,$2,$3)", [wf.id, def, extractManifest(def)]);
      await syncTriggers(c, co, wf.id, def);
      return wf.id;
    });
    const a = await appt(50);
    await expect(asOperator((c) => replayBookings(c, co, [a], { dryRun: false, workflowId: pre, startAt: "s1" }))).rejects.toThrow(/s1 is a send_sms/);
    await expect(asOperator((c) => replayBookings(c, co, [a], { dryRun: false, workflowId: pre, startAt: "nope" }))).rejects.toThrow(/has no step nope/);
    expect(await asOperator((c) => replayBookings(c, co, [a], { dryRun: false, workflowId: pre, startAt: "w1" }))).toMatchObject([{ would: "replay", runs_started: 1 }]);
    expect(await asOperator((c) => one(c, "select current_node from runs where appointment_id=$1 and workflow_id=$2", [a, pre]))).toEqual({ current_node: "w1" });
    await tick(fakeAdapters(), undefined, co);
    expect(await asOperator((c) => many(c, "select s.node_id from run_steps s join runs r on r.id=s.run_id where r.appointment_id=$1 and r.workflow_id=$2 and s.node_id='s1'", [a, pre]))).toEqual([]);
    expect(await asOperator((c) => many(c, "select 1 from sends where company_id=$1 and appointment_id=$2", [co, a])).catch(() => [])).toEqual([]);
  });

  it("D292: where a booking found late starts: the first wait when the way on sends before it; else as usual", () => {
    const def = (nodes: [string, string][], edges: [string, string][]) => ({ nodes: nodes.map(([id, type]) => ({ id, type })), edges: edges.map(([from, to]) => ({ from, to })) });
    expect(lateStart(def([["t1", "trigger"], ["c0", "check"], ["s1", "send_sms"], ["r24", "wait"], ["m", "send_sms"]], [["t1", "c0"], ["c0", "s1"], ["s1", "r24"], ["r24", "m"]]))).toBe("r24");
    expect(lateStart(def([["t1", "trigger"], ["w", "wait"], ["s", "send_sms"]], [["t1", "w"], ["w", "s"]]))).toBeUndefined();
    expect(lateStart(def([["t1", "trigger"], ["b", "branch"], ["s", "send_sms"], ["w", "wait"]], [["t1", "b"], ["b", "s"], ["b", "w"]]))).toBeUndefined();
    expect(lateStart(def([["t1", "trigger"], ["n", "slack_post"], ["x", "exit"]], [["t1", "n"], ["n", "x"]]))).toBeUndefined();
  });

  it("D292: a calendar watched once it had bookings: after its silent first read, a call still ahead starts late (past its booking text), a past one does not, and only once", async () => {
    const wf = await asOperator(async (c) => {
      const nodes = [{ id: "t1", type: "trigger", event: "appointment.booked" }, { id: "s1", type: "send_sms", template: "you're booked", kind: "transactional" }, { id: "w1", type: "wait", rule: { anchor: "appointment.starts_at", offset: "-1h" } }, { id: "x1", type: "exit", reason: "done" }];
      const def = parseDefinition({ schema: 1, reentry: "once_per_appointment", reentry_key: "{{appointment.starts_at}}", premise: { check: "none" }, nodes, edges: [{ from: "t1", to: "s1" }, { from: "s1", to: "w1" }, { from: "w1", to: "x1" }] });
      const w = (await one<{ id: string }>(c, "insert into workflows (company_id, name, reentry_policy, enabled) values ($1,'Catch-up pre-call','once_per_appointment',true) returning id", [co]))!;
      await c.query("insert into workflow_versions (workflow_id, version, definition, manifest) values ($1,1,$2,$3)", [w.id, def, extractManifest(def)]);
      await syncTriggers(c, co, w.id, def);
      const term = (await one<{ id: string }>(c, "select id from company_terms where company_id=$1 and domain='appointment_type' and category='closing' limit 1", [co]))!.id;
      const cal = (await one<{ id: string }>(c, "insert into calendars (company_id, source, external_id, name, appointment_term, config) values ($1,'ghl','CAL-CU','Late calendar',$2,'{\"catch_up\": true}') returning id", [co, term]))!.id;
      return { id: w.id, cal, term };
    });
    const ahead = await appt(30, "confirmed", false), past = await appt(-30, "confirmed", false);
    await asOperator((c) => c.query("update appointments set calendar_id=$2 where id = any($1::uuid[])", [[ahead, past], wf.cal]));
    expect(await asOperator((c) => catchUpCalendar(c, co, "CAL-CU"))).toBe(1);
    expect(await asOperator((c) => one(c, "select current_node from runs where appointment_id=$1 and workflow_id=$2", [ahead, wf.id]))).toEqual({ current_node: "w1" });
    expect(await runs(past)).toEqual([]);
    expect(await asOperator((c) => one(c, "select config ? 'catch_up' as marked from calendars where id=$1", [wf.cal]))).toEqual({ marked: false });
    expect(await asOperator((c) => catchUpCalendar(c, co, "CAL-CU"))).toBe(0);
  });

  it("D200: handed on again, what the earlier run already emailed them is not emailed again; force sends it; one only held in quiet still goes", async () => {
    const sent: string[] = [];
    const adapters = fakeAdapters();
    adapters.sender = { ...adapters.sender, sendEmail: async (_c, to) => { sent.push(to); return { externalId: `e${sent.length}`, accepted: true }; } };
    const wf = await asOperator(async (c) => {
      await c.query("update workflows set enabled=false where company_id=$1", [co]);
      const nodes = [{ id: "t1", type: "trigger", event: "appointment.booked" }, { id: "m1", type: "send_email", subject: "See you", template: "Hi" }, { id: "x1", type: "exit", reason: "done" }];
      const def = parseDefinition({ schema: 1, reentry: "always", premise: { check: "none" }, nodes, edges: [{ from: "t1", to: "m1" }, { from: "m1", to: "x1" }] });
      const w = (await one<{ id: string }>(c, "insert into workflows (company_id, name, reentry_policy, enabled) values ($1,'Booked email','always',true) returning id", [co]))!;
      await c.query("insert into workflow_versions (workflow_id, version, definition, manifest) values ($1,1,$2,$3)", [w.id, def, extractManifest(def)]);
      await syncTriggers(c, co, w.id, def);
      await c.query("update companies set mode='live', send_window_start='00:00', send_window_end='23:59' where id=$1", [co]);
      return w.id;
    });
    await unlockSendsForTest(co);
    const a = await appt(24);
    await asOperator((c) => c.query("insert into contact_identifiers (company_id, contact_id, kind, value) select company_id, contact_id, 'email', 'rae@example.com' from appointments where id=$1", [a]));
    const ghl = (await asOperator((c) => one<{ g: string }>(c, "select ct.ghl_contact_id as g from appointments ap join contacts ct on ct.id=ap.contact_id where ap.id=$1", [a])))!.g;
    const finish = async () => { for (let i = 0; i < 3; i++) await tick(adapters, undefined, co); };
    const statuses = () => asOperator((c) => many<{ status: string; suppressed_reason: string | null }>(c, "select s.status, s.suppressed_reason from sends s join runs r on r.id=s.run_id where r.workflow_id=$1 and r.appointment_id=$2 order by r.started_at", [wf, a]));
    await asOperator((c) => replayBookings(c, co, [a], { dryRun: false }));
    await finish();
    expect(sent).toEqual([ghl]);
    await asOperator((c) => replayBookings(c, co, [a], { dryRun: false, again: true }));
    await finish();
    expect(sent).toEqual([ghl]);
    expect((await statuses()).map((x) => [x.status, x.suppressed_reason?.startsWith("replay:") ?? false])).toEqual([["sent", false], ["suppressed", true]]);
    await asOperator((c) => replayBookings(c, co, [a], { dryRun: false, again: true, force: true }));
    await finish();
    expect(sent).toEqual([ghl, ghl]);
    // a step only held (quiet) in the earlier run never reached them: a replay sends it
    const b = await appt(30);
    await asOperator((c) => c.query("insert into contact_identifiers (company_id, contact_id, kind, value) select company_id, contact_id, 'email', 'rae2@example.com' from appointments where id=$1", [b]));
    await asOperator((c) => c.query("update companies set mode='quiet' where id=$1", [co]));
    await asOperator((c) => replayBookings(c, co, [b], { dryRun: false }));
    await finish();
    await asOperator((c) => c.query("update companies set mode='live' where id=$1", [co]));
    const before = sent.length;
    await asOperator((c) => replayBookings(c, co, [b], { dryRun: false, again: true }));
    await finish();
    expect(sent.length).toBe(before + 1);
  });
});
