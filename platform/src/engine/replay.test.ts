/** D138: an upcoming booking with no run is handed to the booked-call workflows again, once; a call that has started, a cancelled one, and a baseline booking (unless asked) are not. */
import { describe, it, expect, beforeAll } from "vitest";
import { asOperator, many, one } from "@/db/client";
import { migrate } from "@/db/migrate";
import { installCompany, syncTriggers } from "@/engine/install";
import { emitEvent } from "@/engine/dispatch";
import { parseDefinition, extractManifest } from "@/engine/definition";
import { replayBookings } from "@/engine/replay";
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
