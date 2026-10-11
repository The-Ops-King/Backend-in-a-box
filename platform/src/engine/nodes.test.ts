/**
 * D85: the generic building blocks a template puts together instead of the engine hardcoding the behaviour. Driven through the
 * real runner against Postgres with fake adapters; each workflow here is a tiny one built for the block under test.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { DateTime } from "luxon";
import { asOperator, one, many } from "@/db/client";
import { migrate } from "@/db/migrate";
import { encrypt } from "@/engine/crypto";
import { emitEvent, dispatchEvent } from "@/engine/dispatch";
import { tick } from "@/engine/runner";
import { fakeAdapters } from "@/engine/test-install";
import { syncTriggers } from "@/engine/install";
import { parseDefinition, extractManifest } from "@/engine/definition";
import { describeNode, edgeWords } from "@/engine/describe";
import { saveStepEdit } from "@/engine/edits";
import type { Adapters } from "@/adapters/types";

const HAS_DB = !!process.env.DATABASE_URL;
process.env.BINDINGS_KEY ??= Buffer.alloc(32, 7).toString("base64");
const TZ = "America/Chicago";

const base = fakeAdapters();
const fake: Adapters = { ...base };

const TABLES = ["alerts", "slack_posts", "sends", "step_effects", "runs", "events", "slack_connections", "workflow_triggers", "workflows", "messages", "crm_records", "payments", "recordings", "appointments", "pipeline_cards", "opportunities", "calendars", "contact_identifiers", "contacts", "users", "company_terms", "bindings", "poll_cursors", "audit_log", "health_checks", "rollups_daily", "wrapups"];
let companyId: string;
let calId: string;
const terms: Record<string, string> = {};
type Run = { id: string; status: string; current_node: string | null; exit_reason: string | null; next_run_at: Date | null; wake_on_event: string | null; context: { vars: Record<string, unknown> } };
const run = (id: string) => asOperator((c) => one<Run>(c, "select id, status, current_node, exit_reason, next_run_at, wake_on_event, context from runs where id=$1", [id]));
const steps = (id: string, node: string) => asOperator((c) => many<{ status: string; result: Record<string, unknown> }>(c, "select status, result from run_steps where run_id=$1 and node_id=$2 order by started_at, id", [id, node]));
const wake = (id: string) => asOperator((c) => c.query("update runs set next_run_at=now() where id=$1", [id]));
const tickAt = (at: DateTime) => tick(fake, at as DateTime<true>, companyId);
let seq = 0;
const newContact = (first: string) => asOperator(async (c) => (await one<{ id: string }>(c, "insert into contacts (company_id, ghl_contact_id, first_name, last_name, timezone) values ($1,$2,$3,'Node',$4) returning id", [companyId, `GN${++seq}`, first, TZ]))!.id);
/** A booking on our table and the event the poll would emit for it. */
const book = (contactId: string, o: { self?: boolean | null; kind?: "closing" | "qualifying"; at?: Date; starts?: DateTime; status?: string; emit?: boolean } = {}) => asOperator(async (c) => {
  const starts = o.starts ?? DateTime.now().plus({ days: 2 });
  const id = (await one<{ id: string }>(c, `insert into appointments (company_id, contact_id, source, external_id, calendar_id, appointment_term, starts_at, ends_at, self_booked, booked_at, status)
    values ($1,$2,'ghl',$3,$4,$5,$6,$7,$8,$9,$10) returning id`, [companyId, contactId, `A${++seq}`, calId, terms[o.kind ?? "closing"], starts.toJSDate(), starts.plus({ minutes: 45 }).toJSDate(), o.self === undefined ? true : o.self, o.at ?? new Date(), o.status ?? "confirmed"]))!.id;
  if (o.emit !== false) await emitEvent(c, { company_id: companyId, contact_id: contactId, opportunity_id: null, appointment_id: id, event_type: "appointment.booked", source: "test", occurred_at: o.at, data: { self_booked: o.self === undefined ? true : o.self } });
  return id;
});
/** One `tag.added` event that picks the workflow (optionally about an appointment); returns the run it started. */
const fire = (contactId: string, tag: string, data: Record<string, unknown> = {}, appointmentId: string | null = null) => asOperator(async (c) => {
  const ev = await emitEvent(c, { company_id: companyId, contact_id: contactId, opportunity_id: null, appointment_id: appointmentId, event_type: "tag.added", source: "test", data: { tag, ...data } });
  return (await dispatchEvent(c, ev, { contact: { id: contactId } }))[0];
});
const trig = (tag: string) => ({ id: "t1", type: "trigger", event: "tag.added", match: { eq: ["{{event.tag}}", tag] } });
const flow = (name: string, nodes: Record<string, unknown>[], edges: Record<string, unknown>[]) => ({ schema: 1, reentry: "always", premise: { check: "contact_exists" }, name, nodes, edges });
/** trigger → the wait → "event" exit / "until" exit */
const waitFlow = (name: string, tag: string, wait: Record<string, unknown>) => flow(name, [trig(tag), { id: "n1", type: "wait_for_event", ...wait }, { id: "xe", type: "exit", reason: "got_event" }, { id: "xu", type: "exit", reason: "no_event" }],
  [{ from: "t1", to: "n1" }, { from: "n1", to: "xe", label: "event" }, { from: "n1", to: "xu", label: "until" }]);
const TWO_HOURS = { anchor: "now", offset: "+2h", tz: "company" };
const DEFS = [
  waitFlow("Booked", "wfe", { event: "appointment.booked", until: TWO_HOURS, into: "booking" }),
  waitFlow("Booked since", "wfe-since", { event: "appointment.booked", since: "{{event.since}}", until: TWO_HOURS, into: "booking" }),
  waitFlow("Setter booked", "wfe-match", { event: "appointment.booked", match: { and: [{ eq: ["{{data.self_booked}}", false] }, { eq: ["{{vars.booking.appointment.kind}}", "closing"] }] }, until: TWO_HOURS, into: "booking" }),
  waitFlow("Appointment moved", "wfe-appt", { event: "appointment.status_changed", about: "appointment", until: TWO_HOURS }),
  waitFlow("Windowed", "wfe-window", { event: "appointment.booked", until: { anchor: "now", offset: "+1h", tz: "company" } }),
  waitFlow("Unwindowed", "wfe-nowindow", { event: "appointment.booked", until: { anchor: "now", offset: "+1h", tz: "company" }, respect_send_window: false }),
  // a loop back onto the same wait: an event it took once is not taken again, even when `since` reaches back before it
  flow("Twice", [trig("wfe-loop"), { id: "n1", type: "wait_for_event", event: "appointment.booked", since: "{{event.since}}", until: TWO_HOURS }, { id: "b1", type: "branch" }, { id: "s1", type: "set_var", key: "seen", value: "yes" },
    { id: "x2", type: "exit", reason: "twice" }, { id: "xu", type: "exit", reason: "no_event" }],
    [{ from: "t1", to: "n1" }, { from: "n1", to: "b1", label: "event" }, { from: "n1", to: "xu", label: "until" }, { from: "b1", to: "x2", when: { exists: "vars.seen" } }, { from: "b1", to: "s1", else: true }, { from: "s1", to: "n1" }]),
];

describe("wait_for_event (pure)", () => {
  it("needs a way on for the event and, with a deadline, for the deadline; one plain edge serves both", () => {
    const n = { id: "n1", type: "wait_for_event", event: "appointment.booked", until: TWO_HOURS };
    const def = (edges: Record<string, unknown>[]) => ({ schema: 1, reentry: "always", nodes: [{ id: "t1", type: "trigger", event: "tag.added" }, n, { id: "x", type: "exit", reason: "done" }, { id: "y", type: "exit", reason: "done" }], edges: [{ from: "t1", to: "n1" }, ...edges] });
    expect(() => parseDefinition(def([{ from: "n1", to: "x", label: "event" }]))).toThrow(/for the deadline/);
    expect(() => parseDefinition(def([{ from: "n1", to: "x", label: "until" }]))).toThrow(/for when the event comes/);
    expect(() => parseDefinition(def([{ from: "n1", to: "x" }]))).not.toThrow();
    expect(() => parseDefinition(def([{ from: "n1", to: "x", label: "event" }, { from: "n1", to: "y", label: "until" }]))).not.toThrow();
  });
  it("reads in plain words, and so do its two edges", () => {
    const n = parseDefinition(DEFS[2]).nodes.find((x) => x.id === "n1")!;
    expect(describeNode(n).title).toBe("Wait for appointment booked, up to 2 hours");
    expect(describeNode(n).detail).toBe("About this person, when not the event's self-booked and booking appointment kind is closing call; moves on the moment one arrives; only one after this step begins counts; nothing by then and it takes the no-event path (the deadline waits for the send window)");
    expect(edgeWords({ from: "n1", to: "x", label: "event" }, n)).toBe("appointment booked");
    expect(edgeWords({ from: "n1", to: "x", label: "until" }, n)).toBe("no appointment booked in time");
  });
});

describe.skipIf(!HAS_DB)("building blocks (D85)", () => {
  beforeAll(async () => {
    await migrate().catch((e: Error) => { if (!/events_source_check/.test(e.message)) throw e; });
    await asOperator(async (c) => {
      const co = await one<{ id: string }>(c, "select id from companies where slug='nodes'");
      if (co) {
        await c.query("delete from run_steps where run_id in (select id from runs where company_id=$1)", [co.id]);
        await c.query("delete from workflow_versions where workflow_id in (select id from workflows where company_id=$1)", [co.id]);
        for (const t of TABLES) await c.query(`delete from ${t} where company_id=$1`, [co.id]);
        await c.query("delete from companies where id=$1", [co.id]);
      }
      companyId = (await one<{ id: string }>(c, "insert into companies (name, slug, timezone, mode, send_window_start, send_window_end) values ('Nodes Co','nodes',$1,'live','00:00','23:59') returning id", [TZ]))!.id;
      await c.query("insert into company_terms (company_id, domain, name, category, is_default, sort) select $1, domain, label, value, true, sort from core_categories", [companyId]);
      await c.query("insert into bindings (company_id,key,kind,value) values ($1,'crm.location_id','id',$2),($1,'secret.ghl_pit','secret',$3)", [companyId, Buffer.from("LOC"), encrypt("p1")]);
      for (const k of ["closing", "qualifying"]) terms[k] = (await one<{ id: string }>(c, "select id from company_terms where company_id=$1 and domain='appointment_type' and category=$2", [companyId, k]))!.id;
      calId = (await one<{ id: string }>(c, "insert into calendars (company_id, external_id, name, appointment_term, active) values ($1,'CAL1','Closer',$2,true) returning id", [companyId, terms.closing]))!.id;
      for (const d of DEFS) {
        const { name, ...definition } = d;
        const def = parseDefinition(definition);
        const wf = (await one<{ id: string }>(c, "insert into workflows (company_id, name, reentry_policy, enabled) values ($1,$2,'always',true) returning id", [companyId, name]))!;
        await c.query("insert into workflow_versions (workflow_id, version, definition, manifest, note) values ($1,1,$2,$3,'nodes test')", [wf.id, def, extractManifest(def)]);
        await syncTriggers(c, companyId, wf.id, def);
      }
    });
  });

  describe("wait_for_event", () => {
    it("an event already there at or after `since` counts at once; without `since` an earlier one does not", async () => {
      const ct = await newContact("Ana");
      const t0 = DateTime.now();
      await book(ct, { at: t0.minus({ minutes: 10 }).toJSDate() });
      const r1 = await fire(ct, "wfe-since", { since: t0.minus({ minutes: 30 }).toISO() });
      const r2 = await fire(ct, "wfe");
      await tickAt(t0);
      const a = (await run(r1))!;
      expect(a).toMatchObject({ status: "completed", exit_reason: "got_event", wake_on_event: null });
      expect(a.context.vars.booking).toMatchObject({ matched: true, type: "appointment.booked", data: { self_booked: true }, appointment: { kind: "closing", booking_source: "self", status: "confirmed" } });
      expect(await run(r2)).toMatchObject({ status: "waiting", current_node: "n1", wake_on_event: "appointment.booked" });
    });

    it("an event mid-wait wakes the run at once (no polling) and it takes the event edge; the deadline was pinned on entry", async () => {
      const ct = await newContact("Ben");
      const t0 = DateTime.now();
      const id = await fire(ct, "wfe");
      await tickAt(t0);
      let r = (await run(id))!;
      expect(r).toMatchObject({ status: "waiting", current_node: "n1", wake_on_event: "appointment.booked" });
      const deadline = r.next_run_at!.getTime();
      expect(Math.abs(deadline - t0.plus({ hours: 2 }).toMillis())).toBeLessThan(2000);
      expect(await tickAt(t0.plus({ minutes: 1 }))).toMatchObject({ claimed: 0 });   // not due, not polled
      await book(ct, { self: false });
      r = (await run(id))!;
      expect(r.next_run_at!.getTime()).toBeLessThanOrEqual(Date.now());   // woken by the emit itself
      await tickAt(t0.plus({ minutes: 2 }));
      r = (await run(id))!;
      expect(r).toMatchObject({ status: "completed", exit_reason: "got_event", wake_on_event: null });
      expect((await steps(id, "n1")).at(-1)).toMatchObject({ status: "ok", result: { event: "appointment.booked" } });
    });

    it("no event: the run takes the until edge at the deadline, with `matched: false`", async () => {
      const ct = await newContact("Cy");
      const t0 = DateTime.now();
      const id = await fire(ct, "wfe");
      await tickAt(t0);
      await wake(id); await tickAt(t0.plus({ minutes: 90 }));
      expect(await run(id)).toMatchObject({ status: "waiting", current_node: "n1" });
      await wake(id); await tickAt(t0.plus({ hours: 2, minutes: 1 }));
      const r = (await run(id))!;
      expect(r).toMatchObject({ status: "completed", exit_reason: "no_event", wake_on_event: null });
      expect(r.context.vars.booking).toEqual({ matched: false });
    });

    it("`match` filters: a self-booked call wakes the run but does not count, and the deadline stays where it was; a setter-booked closing call counts", async () => {
      const ct = await newContact("Di");
      const t0 = DateTime.now();
      const id = await fire(ct, "wfe-match");
      await tickAt(t0);
      const deadline = (await run(id))!.next_run_at!.getTime();
      await book(ct, { self: true });
      await book(ct, { self: false, kind: "qualifying" });
      await tickAt(t0.plus({ minutes: 30 }));
      let r = (await run(id))!;
      expect(r).toMatchObject({ status: "waiting", current_node: "n1" });
      expect(r.next_run_at!.getTime()).toBe(deadline);
      expect(r.context.vars.booking).toBeUndefined();
      await book(ct, { self: false });
      await tickAt(t0.plus({ minutes: 40 }));
      r = (await run(id))!;
      expect(r).toMatchObject({ status: "completed", exit_reason: "got_event" });
      expect(r.context.vars.booking).toMatchObject({ matched: true, data: { self_booked: false }, appointment: { booking_source: "setter", kind: "closing" } });
    });

    it("another person's event neither wakes nor moves the run", async () => {
      const ct = await newContact("Eve"), other = await newContact("Fay");
      const t0 = DateTime.now();
      const id = await fire(ct, "wfe");
      await tickAt(t0);
      const before = (await run(id))!.next_run_at!.getTime();
      await book(other, { self: false });
      expect((await run(id))!.next_run_at!.getTime()).toBe(before);
      await wake(id); await tickAt(t0.plus({ minutes: 5 }));
      expect(await run(id)).toMatchObject({ status: "waiting", current_node: "n1" });
    });

    it("about: appointment: only an event about the run's own booking counts, not the same person's other booking", async () => {
      const ct = await newContact("Gus");
      const mine = await book(ct, { emit: false }), theirs = await book(ct, { emit: false });
      const t0 = DateTime.now();
      const id = await fire(ct, "wfe-appt", {}, mine);
      await tickAt(t0);
      expect(await run(id)).toMatchObject({ status: "waiting", wake_on_event: "appointment.status_changed" });
      const changed = (appt: string) => asOperator((c) => emitEvent(c, { company_id: companyId, contact_id: ct, opportunity_id: null, appointment_id: appt, event_type: "appointment.status_changed", source: "test", data: { status: { from: "confirmed", to: "cancelled" } } }));
      await changed(theirs);
      await tickAt(t0.plus({ minutes: 1 }));
      expect(await run(id)).toMatchObject({ status: "waiting", current_node: "n1" });
      await changed(mine);
      await tickAt(t0.plus({ minutes: 2 }));
      const r = (await run(id))!;
      expect(r).toMatchObject({ status: "completed", exit_reason: "got_event" });
      expect(r.context.vars.waited).toMatchObject({ matched: true, appointment: { id: mine } });
    });

    it("the deadline waits for the send window like `wait`, unless the step opts out", async () => {
      const ct = await newContact("Hal");
      await asOperator((c) => c.query("update companies set send_window_start='09:00', send_window_end='17:00' where id=$1", [companyId]));
      try {
        const at = DateTime.now().setZone(TZ).set({ hour: 20, minute: 0, second: 0, millisecond: 0 });
        const a = await fire(ct, "wfe-window"), b = await fire(ct, "wfe-nowindow");
        await tickAt(at);
        expect(DateTime.fromJSDate((await run(a))!.next_run_at!).setZone(TZ).toISO()).toBe(at.plus({ days: 1 }).set({ hour: 9 }).toISO());
        expect(DateTime.fromJSDate((await run(b))!.next_run_at!).setZone(TZ).toISO()).toBe(at.plus({ hours: 1 }).toISO());
      } finally { await asOperator((c) => c.query("update companies set send_window_start='00:00', send_window_end='23:59' where id=$1", [companyId])); }
    });

    it("an event the step already took is not taken again when the run comes back to it", async () => {
      const ct = await newContact("Ivy");
      const t0 = DateTime.now();
      await book(ct, { at: t0.minus({ minutes: 5 }).toJSDate() });
      const id = await fire(ct, "wfe-loop", { since: t0.minus({ hours: 1 }).toISO() });
      await tickAt(t0);
      let r = (await run(id))!;
      expect(r).toMatchObject({ status: "waiting", current_node: "n1", wake_on_event: "appointment.booked" });
      expect(r.context.vars.seen).toBe("yes");
      await book(ct);
      await tickAt(t0.plus({ minutes: 1 }));
      r = (await run(id))!;
      expect(r).toMatchObject({ status: "completed", exit_reason: "twice" });
      expect((await steps(id, "n1")).filter((s) => s.status === "ok").map((s) => s.result.event_id)).toHaveLength(2);
    });

    it("its deadline is a knob on the step, edited like a wait's", async () => {
      const wf = (await asOperator((c) => one<{ id: string }>(c, "select id from workflows where company_id=$1 and name='Booked'", [companyId])))!.id;
      expect(await asOperator((c) => saveStepEdit(c, { workflowId: wf, nodeId: "n1", edit: { type: "wait_for_event", until_offset: "+3x" } }))).toMatchObject({ ok: false, why: /is not a wait/ });
      expect(await asOperator((c) => saveStepEdit(c, { workflowId: wf, nodeId: "n1", edit: { type: "wait_for_event", until_offset: "+3h" } }))).toMatchObject({ ok: true, version: 2, changed: ["until"] });
      const def = (await asOperator((c) => one<{ definition: { nodes: { id: string; until?: unknown }[] } }>(c, "select definition from workflow_versions where workflow_id=$1 and version=2", [wf])))!.definition;
      expect(def.nodes.find((n) => n.id === "n1")!.until).toEqual({ ...TWO_HOURS, offset: "+3h" });
    });
  });
});
