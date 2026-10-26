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
import { describeNode, edgeWords, templateWords } from "@/engine/describe";
import { KNOWN_ROOTS, referencedPaths } from "@/engine/template";
import { saveStepEdit } from "@/engine/edits";
import { failureRoles } from "@/engine/blocking";
import { propertyValue } from "@/engine/executor";
import type { Adapters } from "@/adapters/types";
import { GhlError } from "@/adapters/ghl/client";

const HAS_DB = !!process.env.DATABASE_URL;
process.env.BINDINGS_KEY ??= Buffer.alloc(32, 7).toString("base64");
const TZ = "America/Chicago";

const base = fakeAdapters();
const recordCalls: { op: string; object: string; id?: string; props?: Record<string, unknown> }[] = [];
let recordDown = 0;   // the next N record writes answer 503
const cardCalls: { id: string; status?: string; stageId?: string }[] = [];
let cardDown = 0;     // the next N card writes answer 503
const fake: Adapters = { ...base,
  read: { ...base.read, objectFields: async () => [{ key: "outcome", type: "SINGLE_OPTIONS" }, { key: "disposition", type: "SINGLE_OPTIONS" }, { key: "next_step", type: "TEXT" }, { key: "cash_collected", type: "MONETORY" }, { key: "duration_min", type: "NUMERICAL" }, { key: "objections_raised", type: "MULTIPLE_OPTIONS" }, { key: "score_total", type: "TEXT" }] },
  write: { ...base.write,
    updateRecord: async (_c, object, id, props) => { if (recordDown > 0) { recordDown--; throw new GhlError(503, "upstream unavailable", `/objects/${object}/records/${id}`); } recordCalls.push({ op: "update", object, id, props }); },
    createRecord: async (_c, object, props) => { recordCalls.push({ op: "create", object, props }); return { id: `REC-NEW-${recordCalls.length}` }; },
    updateOpportunity: async (_c, id, input) => { if (cardDown > 0) { cardDown--; throw new GhlError(503, "no healthy upstream", `/opportunities/${id}`); } cardCalls.push({ id, status: input.status, stageId: input.stageId }); },
    relateRecords: async (_c, assoc, first, second) => { recordCalls.push({ op: "relate", object: assoc, id: `${first}→${second}` }); } } };

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
  // D85: the context facts, said by a template with lookup instead; D87 deleted "booked within 30 minutes" and "led to a booking" (one Set: a setter-link booking in the Set window), has_upcoming_call stays
  flow("Facts", [trig("facts"),
    { id: "o3", type: "set_var", key: "old_up", value: "{{contact.has_upcoming_call}}" },
    { id: "l1", type: "lookup", query: "appointments_for_contact", params: { booking_source: "setter", booked_since: "{{recording.started_at}}", booked_until: "{{recording.set_until}}" }, into: "b30" },
    { id: "l2", type: "lookup", query: "appointments_for_contact", params: { status_not: "cancelled", booked_since: "{{recording.started_at}}" }, into: "led" },
    { id: "l3", type: "lookup", query: "appointments_for_contact", params: { kind: "closing", status_not: "cancelled,noshow", starts_since: "{{now}}", exclude: "{{appointment.id | default:}}" }, into: "up" },
    { id: "l4", type: "lookup", query: "calls_for_contact", params: { since: "{{recording.started_at}} -1d", kind: "phone", connected: "true", caller: "sam@x.com" }, into: "calls" },
    { id: "l5", type: "lookup", query: "last_event", params: { type: "appointment.booked" }, into: "last_booking" },
    { id: "l6", type: "lookup", query: "appointments_for_contact", params: { booking_source: "{{event.source_filter | default:}}", order: "booked_at" }, into: "all" },
    { id: "x1", type: "exit", reason: "done" }],
    [{ from: "t1", to: "o3" }, { from: "o3", to: "l1" }, { from: "l1", to: "l2" }, { from: "l2", to: "l3" }, { from: "l3", to: "l4" }, { from: "l4", to: "l5" }, { from: "l5", to: "l6" }, { from: "l6", to: "x1" }]),
  // D85: a record the engine did not make, by the CRM's own id
  flow("By id", [trig("byid"), { id: "n1", type: "crm_record", object: "custom_objects.sales_call", record_id: "{{event.record | default:}}", properties: { outcome: "{{event.outcome}}", disposition: "{{event.disp | default:}}", not_a_field: "x" },
    clear: ["disposition", "next_step", "cash_collected"], relate: [{ association: "ASSOC-1", first: "{{record.id}}", second: "{{contact.ghl_contact_id}}" }] }, { id: "x1", type: "exit", reason: "done" }], [{ from: "t1", to: "n1" }, { from: "n1", to: "x1" }]),
  flow("Typed", [trig("typed"), { id: "n1", type: "crm_record", object: "custom_objects.sales_call", record_id: "{{event.record}}", properties: { cash_collected: "{{event.cash | default:}}", duration_min: "{{event.minutes}}", objections_raised: "{{event.objections}}", score_total: "{{event.score}}", next_step: "{{event.next}}" } }, { id: "x1", type: "exit", reason: "done" }], [{ from: "t1", to: "n1" }, { from: "n1", to: "x1" }]),
  // D85: an opportunity won or lost, its event, its card
  flow("Close it", [trig("close"), { id: "n1", type: "update_opportunity", status: "{{event.status}}", lost_reason: "{{event.reason | default:}}", set: { contract_value: "{{event.value | default:}}" }, card: { pipeline: "{{crm.pipeline_x}}" } }, { id: "x1", type: "exit", reason: "done" }], [{ from: "t1", to: "n1" }, { from: "n1", to: "x1" }]),
  flow("Old form", [trig("oldform"), { id: "n1", type: "update_opportunity", set: { status: "lost", installments: 3, name: "ignored" } }, { id: "x1", type: "exit", reason: "done" }], [{ from: "t1", to: "n1" }, { from: "n1", to: "x1" }]),
  flow("On won", [{ id: "t1", type: "trigger", event: "opportunity.won" }, { id: "x1", type: "exit", reason: "done" }], [{ from: "t1", to: "x1" }]),
  flow("Bad lookup", [trig("badlookup"), { id: "l1", type: "lookup", query: "appointments_for_contact", params: { booked_since: "{{event.when}}" }, into: "x" }, { id: "x1", type: "exit", reason: "done" }], [{ from: "t1", to: "l1" }, { from: "l1", to: "x1" }]),
];

describe("lookup (pure)", () => {
  it("takes only the filters its query has, and reads in plain words", () => {
    const def = (params: Record<string, string>) => ({ schema: 1, reentry: "always", nodes: [{ id: "t1", type: "trigger", event: "tag.added" }, { id: "l1", type: "lookup", query: "calls_for_contact", params, into: "calls" }, { id: "x", type: "exit", reason: "done" }], edges: [{ from: "t1", to: "l1" }, { from: "l1", to: "x" }] });
    expect(() => parseDefinition(def({ sql: "select 1" }))).toThrow(/takes since, until, provider, caller, kind, connected, not sql/);
    expect(() => parseDefinition({ ...def({}), nodes: [{ id: "t1", type: "trigger", event: "tag.added" }, { id: "l1", type: "lookup", query: "anything", into: "x" }, { id: "x", type: "exit", reason: "done" }] })).toThrow();
    const n = parseDefinition(def({ since: "{{recording.started_at}} -1d", kind: "phone" })).nodes[1];
    const read = parseDefinition({ schema: 1, reentry: "always", nodes: [{ id: "t1", type: "trigger", event: "tag.added" }, { id: "l1", type: "lookup", query: "calls_for_contact", into: "calls" }, { id: "b1", type: "branch" }, { id: "x", type: "exit", reason: "done" }, { id: "y", type: "exit", reason: "none" }],
      edges: [{ from: "t1", to: "l1" }, { from: "l1", to: "b1" }, { from: "b1", to: "x", when: { eq: ["{{vars.calls.any}}", true] } }, { from: "b1", to: "y", else: true }] });
    expect(failureRoles(read).get("l1")).toEqual({ blocking: true, why: "step b1 reads what it looked up" });
    expect(failureRoles(parseDefinition(def({}))).get("l1")).toMatchObject({ blocking: false });
    expect(describeNode(n)).toEqual({ title: "Look up their recorded calls", detail: "since [the call started] -1d; kind phone; saved as calls for the steps after it (the engine's own question, read-only)" });
  });
});

describe("crm_record by id (pure)", () => {
  it("needs our key or the CRM's id, and says which record it updates", () => {
    const def = (n: Record<string, unknown>) => ({ schema: 1, reentry: "always", nodes: [{ id: "t1", type: "trigger", event: "tag.added" }, { id: "r1", type: "crm_record", object: "custom_objects.sales_call", properties: { outcome: "x" }, ...n }, { id: "x", type: "exit", reason: "done" }], edges: [{ from: "t1", to: "r1" }, { from: "r1", to: "x" }] });
    expect(() => parseDefinition(def({}))).toThrow(/needs a key \(our own\) or a record_id/);
    const n = parseDefinition(def({ record_id: "{{vars.found.id}}" })).nodes[1];
    expect(describeNode(n).title).toBe("Update sales call record");
    expect(describeNode(n).detail).toMatch(/^The CRM's own record \[found id\], made outside the engine; never creates one; 1 fields/);
  });
});

describe("a record property goes as its CRM field's type (pure; found live 2026-10-12: \"1500\" isn't a valid number for Cash Collected; 2026-10-14: a create wants the currency)", () => {
  it("numbers for numeric fields, an amount with its currency for money fields, whatever the key is called; arrays for multi-option and checkbox fields, text for the rest", () => {
    expect(propertyValue("cash_collected", "1500", "MONETORY")).toEqual({ currency: "default", value: 1500 });
    expect(propertyValue("cash_collected", "1,500.50", "MONETORY")).toEqual({ currency: "default", value: 1500.5 });
    expect(propertyValue("refund", "-$750", "MONETARY")).toEqual({ currency: "default", value: -750 });
    expect(propertyValue("calls", "3", "NUMERICAL")).toBe(3);
    expect(propertyValue("ratio", "0.25", "FLOAT")).toBe(0.25);
    expect(propertyValue("cash_collected", "unknown", "MONETORY")).toBe("unknown");   // not a number: the CRM says so in its own words, the engine does not invent one
    expect(propertyValue("objections_raised", '["price","timing"]', "MULTIPLE_OPTIONS")).toEqual(["price", "timing"]);
    expect(propertyValue("objections_raised", "price, timing", "MULTIPLE_OPTIONS")).toEqual(["price", "timing"]);
    expect(propertyValue("led_to_booking", "yes", "CHECKBOX")).toEqual(["yes"]);
    expect(propertyValue("score_total", "8", "TEXT")).toBe("8");   // a text field named like a number stays text
    expect(propertyValue("notes", "[draft]", "LARGE_TEXT")).toBe("[draft]");
    expect(propertyValue("next_step_date", "2026-10-12", "DATE")).toBe("2026-10-12");
    expect(propertyValue("disposition", "closed_won", "SINGLE_OPTIONS")).toBe("closed_won");
  });
  it("with no type (the object's fields could not be read) the key's name is the only hint, as before", () => {
    expect(propertyValue("amount", "1500", undefined)).toBe(1500);
    expect(propertyValue("duration_min", "41", undefined)).toBe(41);
    expect(propertyValue("cash_collected", "1500", undefined)).toBe("1500");
    expect(propertyValue("led_to_booking", '["yes"]', undefined)).toEqual(["yes"]);
  });
});

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

describe("lists in templates (pure)", () => {
  it("read on the chart as the list they walk, and pass the save-time path check", () => {
    const t = 'Today:\n{{vars.days | each:"• {{item.label}}: {{item.count}} calls" | join:"\\n" | default:none}} for {{contact.first_name}}';
    expect(templateWords(t)).toBe("Today: [days, one line each] for [first name]");
    expect(referencedPaths(t).every((p) => KNOWN_ROOTS.includes(p.split(".")[0]))).toBe(true);
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
      await c.query("insert into bindings (company_id,key,kind,value) values ($1,'crm.location_id','id',$2),($1,'secret.ghl_pit','secret',$3),($1,'crm.pipeline_x','id',$4)", [companyId, Buffer.from("LOC"), encrypt("p1"), Buffer.from("PIPE1")]);
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

  describe("lookup", () => {
    const record = (contactId: string, started: DateTime) => asOperator(async (c) => (await one<{ id: string }>(c, `insert into recordings (company_id, contact_id, provider, external_id, started_at, ended_at, duration_min, recorded_by_email, raw, link_status)
      values ($1,$2,'ghl_dialer',$3,$4,$5,30,'sam@x.com',$6,'linked') returning id`, [companyId, contactId, `R${++seq}`, started.toJSDate(), started.plus({ minutes: 30 }).toJSDate(), { kind: "phone", call_status: "connected", direction: "outbound" }]))!.id);
    type Vars = Record<string, { any?: boolean; count?: number; items?: Record<string, unknown>[]; found?: boolean; type?: string } & Record<string, unknown>>;
    const facts = async (contactId: string, recId: string, extra: Record<string, unknown> = {}) => { const id = await fire(contactId, "facts", { recording_id: recId, ...extra }); await tickAt(DateTime.now()); const r = (await run(id))!; expect(r).toMatchObject({ status: "completed" }); return r.context.vars as Vars; };
    const same = (v: Vars) => { expect(String(v.up.any)).toBe(v.old_up); };

    it("set by a setter-link booking in the Set window (D87), led to a booking, has an upcoming call: each said with lookup; the upcoming call agrees with the engine's own fact", async () => {
      await asOperator((c) => c.query("insert into users (company_id, name, email, role) values ($1,'Sam Setter','sam@x.com','setter') on conflict do nothing", [companyId]));
      const t = DateTime.now().minus({ hours: 3 });
      const cases: { first: string; setup: (ct: string) => Promise<unknown>; want: [boolean, boolean, boolean] }[] = [
        { first: "Ja", setup: (ct) => book(ct, { at: t.plus({ minutes: 40 }).toJSDate(), self: false }), want: [true, true, true] },          // a setter-link booking 10 minutes after the call ended
        { first: "Ka", setup: (ct) => book(ct, { at: t.plus({ minutes: 70 }).toJSDate() }), want: [false, true, true] },                       // self-booked forty minutes after: not this call's
        { first: "Lu", setup: (ct) => book(ct, { at: t.plus({ minutes: 10 }).toJSDate(), kind: "qualifying" }), want: [false, true, false] },  // not a closing call
        { first: "Mo", setup: (ct) => book(ct, { at: t.plus({ minutes: 10 }).toJSDate(), status: "cancelled" }), want: [false, false, false] }, // cancelled
        { first: "Ny", setup: (ct) => book(ct, { at: t.minus({ days: 3 }).toJSDate(), starts: DateTime.now().minus({ days: 1 }) }), want: [false, false, false] }, // booked before, and already past
        { first: "Os", setup: async () => {}, want: [false, false, false] },
      ];
      for (const k of cases) {
        const ct = await newContact(k.first); await k.setup(ct);
        const v = await facts(ct, await record(ct, t));
        same(v);
        expect([v.b30.any, v.led.any, v.up.any], k.first).toEqual(k.want);
      }
    });

    it("answers plain data: the items with their facts, first and last, the calls, the last event", async () => {
      const ct = await newContact("Pia");
      const t = DateTime.now().minus({ hours: 2 });
      const a1 = await book(ct, { at: t.plus({ minutes: 5 }).toJSDate(), self: false, starts: DateTime.now().plus({ days: 1 }) });
      const a2 = await book(ct, { at: t.plus({ minutes: 75 }).toJSDate(), self: true, starts: DateTime.now().plus({ days: 3 }) });
      const v = await facts(ct, await record(ct, t));
      expect(v.up).toMatchObject({ count: 2, any: true, first: { id: a1, kind: "closing", booking_source: "setter", status: "confirmed" }, last: { id: a2, booking_source: "self" } });
      expect(v.b30).toMatchObject({ count: 1, first: { id: a1 } });
      expect(v.calls).toMatchObject({ count: 1, items: [{ kind: "phone", connected: true, caller: "Sam Setter", provider: "ghl_dialer", duration_min: 30 }] });
      expect(v.last_booking).toMatchObject({ found: true, count: 2, type: "appointment.booked", data: { self_booked: true } });
      const s = await facts(ct, await record(ct, t), { source_filter: "setter" });
      expect(s.all).toMatchObject({ count: 1, first: { id: a1 } });
    });

    it("a filter that is not a time fails the step with the reason, never a guess (nothing reads it here, so the run goes on without it, D77)", async () => {
      const ct = await newContact("Quin");
      const id = await fire(ct, "badlookup", { when: "next tuesday" });
      await tickAt(DateTime.now());
      expect(await run(id)).toMatchObject({ status: "completed" });
      const rows = await asOperator((c) => many<{ status: string; result: Record<string, unknown>; error: string }>(c, "select status, result, error from run_steps where run_id=$1 and node_id='l1'", [id]));
      expect(rows).toMatchObject([{ status: "skipped", result: { kind: "gave_up", class: "permanent" }, error: expect.stringMatching(/booked_since "next tuesday" is not a time/) }]);
    });
  });
  describe("crm_record by the CRM's id", () => {
    const ledger = (ghl: string) => asOperator((c) => many<{ record_key: string; ghl_record_id: string; properties: Record<string, unknown> }>(c, "select record_key, ghl_record_id, properties from crm_records where company_id=$1 and ghl_record_id=$2", [companyId, ghl]));
    it("updates that record: unknown properties dropped and named, clear empties what this answer does not set (a money field as no money, D245), relate links it; never a create", async () => {
      const ct = await newContact("Rae"); recordCalls.length = 0;
      const id = await fire(ct, "byid", { record: "REC-9", outcome: "showed" });
      await tickAt(DateTime.now());
      expect(await run(id)).toMatchObject({ status: "completed" });
      expect(recordCalls).toEqual([{ op: "update", object: "custom_objects.sales_call", id: "REC-9", props: { outcome: "showed", disposition: null, next_step: null, cash_collected: { currency: "default", value: 0 } } }, { op: "relate", object: "ASSOC-1", id: expect.stringMatching(/^REC-9→GN\d+$/) }]);
      expect((await steps(id, "n1"))[0]).toMatchObject({ status: "ok", result: { record: "updated", by_crm_id: true, crm_id: "REC-9", not_on_object: ["not_a_field"] } });
      expect(await ledger("REC-9")).toEqual([{ record_key: "ghl:REC-9", ghl_record_id: "REC-9", properties: { outcome: "showed", disposition: null, next_step: null, cash_collected: { currency: "default", value: 0 } } }]);
      // a second answer: the ledger row is the same one, a set value is not cleared
      await fire(ct, "byid", { record: "REC-9", outcome: "showed", disp: "closed_won" }); await tickAt(DateTime.now());
      expect(recordCalls.filter((r) => r.op === "update").at(-1)!.props).toEqual({ outcome: "showed", disposition: "closed_won", next_step: null, cash_collected: { currency: "default", value: 0 } });   // D245: GHL takes no empty money field
      expect(await ledger("REC-9")).toMatchObject([{ record_key: "ghl:REC-9", properties: { disposition: "closed_won" } }]);
    });
    it("a record the engine already keeps under its own key is updated under that key, not a second ledger row", async () => {
      const ct = await newContact("Sol");
      await asOperator((c) => c.query("insert into crm_records (company_id, object_key, record_key, ghl_record_id, contact_id, properties) values ($1,'custom_objects.sales_call','booking:B1','REC-10',$2,'{}')", [companyId, ct]));
      await fire(ct, "byid", { record: "REC-10", outcome: "noshow" }); await tickAt(DateTime.now());
      expect(await ledger("REC-10")).toMatchObject([{ record_key: "booking:B1", properties: { outcome: "noshow" } }]);
    });
    it("an id that renders empty is nothing to update; a CRM outage is retried in place and writes once when it is back", async () => {
      const ct = await newContact("Tia"); recordCalls.length = 0;
      const a = await fire(ct, "byid", { outcome: "showed" });
      await tickAt(DateTime.now());
      expect((await steps(a, "n1"))[0]).toMatchObject({ status: "skipped", result: { kind: "noop", why: expect.stringMatching(/rendered empty/) } });
      recordDown = 1;
      const b = await fire(ct, "byid", { record: "REC-11", outcome: "showed" });
      await tickAt(DateTime.now());
      expect(await run(b)).toMatchObject({ status: "waiting", current_node: "n1" });
      await wake(b); await tickAt(DateTime.now().plus({ minutes: 1 }));
      expect(await run(b)).toMatchObject({ status: "completed" });
      expect(recordCalls.filter((r) => r.op === "update" || r.op === "create")).toEqual([{ op: "update", object: "custom_objects.sales_call", id: "REC-11", props: { outcome: "showed", disposition: null, next_step: null, cash_collected: { currency: "default", value: 0 } } }]);
    });
    it("each property goes as the object's field type says: money as an amount with its currency, numbers as numbers, options as a list, text as text; an empty value is left out, never 0 (found live 2026-10-12)", async () => {
      const ct = await newContact("Ivo"); recordCalls.length = 0;
      await fire(ct, "typed", { record: "REC-20", cash: 1500, minutes: "41", objections: "price, timing", score: 8, next: "42" }); await tickAt(DateTime.now());
      expect(recordCalls).toEqual([{ op: "update", object: "custom_objects.sales_call", id: "REC-20", props: { cash_collected: { currency: "default", value: 1500 }, duration_min: 41, objections_raised: ["price", "timing"], score_total: "8", next_step: "42" } }]);
      recordCalls.length = 0;
      await fire(ct, "typed", { record: "REC-20", minutes: "12", objections: '["price"]', score: "", next: "call back" }); await tickAt(DateTime.now());
      expect(recordCalls).toEqual([{ op: "update", object: "custom_objects.sales_call", id: "REC-20", props: { duration_min: 12, objections_raised: ["price"], next_step: "call back" } }]);
    });
    it("in shadow nothing reaches the CRM and the ledger is not told it did", async () => {
      const ct = await newContact("Uma"); recordCalls.length = 0;
      await asOperator((c) => c.query("update companies set mode='ghost' where id=$1", [companyId]));
      try {
        const id = await fire(ct, "byid", { record: "REC-12", outcome: "showed" });
        await tickAt(DateTime.now());
        expect(recordCalls).toEqual([]);
        expect(await ledger("REC-12")).toEqual([]);
        expect((await steps(id, "n1"))[0]).toMatchObject({ status: "ok", result: { ghost: true, would_update: { outcome: "showed" }, crm_id: "REC-12" } });
      } finally { await asOperator((c) => c.query("update companies set mode='live' where id=$1", [companyId])); }
    });
  });
  describe("update_opportunity", () => {
    const opp = (contactId: string) => asOperator(async (c) => (await one<{ id: string }>(c, "insert into opportunities (company_id, contact_id, opened_by) values ($1,$2,'test') returning id", [companyId, contactId]))!.id);
    const card = (contactId: string, oppId: string, ghl: string) => asOperator((c) => c.query("insert into pipeline_cards (company_id, opportunity_id, contact_id, ghl_opportunity_id, ghl_pipeline_id, ghl_stage_id, name, status) values ($1,$2,$3,$4,'PIPE1','STAGE1','Card','open')", [companyId, oppId, contactId, ghl]));
    const row = (id: string) => asOperator((c) => one<{ status: string; won_at: Date | null; lost_at: Date | null; contract_value: string | null; installments: number | null; reason: string | null }>(c, "select o.status, o.won_at, o.lost_at, o.contract_value::text, o.installments, t.category as reason from opportunities o left join company_terms t on t.id=o.lost_reason_term where o.id=$1", [id]));
    const events = (oppId: string) => asOperator((c) => many<{ event_type: string; data: Record<string, unknown> }>(c, "select event_type, data from events where opportunity_id=$1 and event_type like 'opportunity.%' order by id", [oppId]));
    const wonRuns = (contactId: string) => asOperator((c) => many(c, "select r.id from runs r join workflows w on w.id=r.workflow_id where w.company_id=$1 and w.name='On won' and r.contact_id=$2", [companyId, contactId]));

    it("won: the ledger, one opportunity.won that starts the workflows listening for it, the card marked won; saying it again changes nothing", async () => {
      const ct = await newContact("Vic"), o = await opp(ct); await card(ct, o, "GO-1"); cardCalls.length = 0;
      const id = await fire(ct, "close", { status: "won", value: "2999" });
      await tickAt(DateTime.now());
      expect(await run(id)).toMatchObject({ status: "completed" });
      expect(await row(o)).toMatchObject({ status: "won", won_at: expect.any(Date), contract_value: "2999.00" });
      expect(await events(o)).toEqual([{ event_type: "opportunity.won", data: { by: "workflow", node: "n1", from: "open" } }]);
      expect(await wonRuns(ct)).toHaveLength(1);
      expect(cardCalls).toEqual([{ id: "GO-1", status: "won", stageId: "STAGE1" }]);
      expect((await steps(id, "n1"))[0]).toMatchObject({ status: "ok", result: { status: { from: "open", to: "won" }, card: { card: "moved", card_status: "won" } } });
      await fire(ct, "close", { status: "won" }); await tickAt(DateTime.now());
      expect(await events(o)).toHaveLength(1);
      expect(await wonRuns(ct)).toHaveLength(1);
    });

    it("lost with a reason the company has (by key or name) is kept on the ledger; one it lacks is kept on the event and named; no card is nothing to mark", async () => {
      const a = await newContact("Wes"), oa = await opp(a);
      await fire(a, "close", { status: "lost", reason: "Price" }); await tickAt(DateTime.now());
      expect(await row(oa)).toMatchObject({ status: "lost", lost_at: expect.any(Date), reason: "price" });
      expect(await events(oa)).toEqual([{ event_type: "opportunity.lost", data: { by: "workflow", node: "n1", from: "open", lost_reason: "price" } }]);
      const b = await newContact("Xan"), ob = await opp(b);
      const id = await fire(b, "close", { status: "lost", reason: "weather" }); await tickAt(DateTime.now());
      expect(await row(ob)).toMatchObject({ status: "lost", reason: null });
      expect(await events(ob)).toEqual([{ event_type: "opportunity.lost", data: { by: "workflow", node: "n1", from: "open", lost_reason: "weather", lost_reason_unknown: true } }]);
      expect((await steps(id, "n1"))[0]).toMatchObject({ status: "ok", result: { lost_reason_unknown: expect.stringMatching(/no lost reason "weather"/), card: { kind: "noop" } } });
    });

    it("a card the CRM cannot take is retried in place: the event is not emitted twice and the card is written once", async () => {
      const ct = await newContact("Yul"), o = await opp(ct); await card(ct, o, "GO-2"); cardCalls.length = 0; cardDown = 1;
      const id = await fire(ct, "close", { status: "lost" });
      await tickAt(DateTime.now());
      expect(await run(id)).toMatchObject({ status: "waiting", current_node: "n1" });
      await wake(id); await tickAt(DateTime.now().plus({ minutes: 1 }));
      expect(await run(id)).toMatchObject({ status: "completed" });
      expect(await events(o)).toHaveLength(1);
      expect(cardCalls).toEqual([{ id: "GO-2", status: "lost", stageId: "STAGE1" }]);
    });

    it("a status that is not open, won or lost is a fault on the step; the older `set` form still writes the ledger, and its status change is an event now too", async () => {
      const a = await newContact("Zed"); await opp(a);
      const id = await fire(a, "close", { status: "maybe" }); await tickAt(DateTime.now());
      expect(await run(id)).toMatchObject({ status: "paused", exit_reason: expect.stringMatching(/status is open, won or lost, not "maybe"/) });
      const b = await newContact("Abe"), ob = await opp(b);
      await fire(b, "oldform"); await tickAt(DateTime.now());
      expect(await row(ob)).toMatchObject({ status: "lost", installments: 3 });
      expect(await events(ob)).toEqual([{ event_type: "opportunity.lost", data: { by: "workflow", node: "n1", from: "open" } }]);
    });
  });
});
