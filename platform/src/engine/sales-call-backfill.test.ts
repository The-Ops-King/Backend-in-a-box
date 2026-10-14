/** D115: a closer's Sales Calls read back from the evidence, written as Call booked writes them, nothing guessed, nothing started. */
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { DateTime } from "luxon";
import type { PoolClient } from "pg";
import { asOperator, many, one } from "@/db/client";
import { migrate } from "@/db/migrate";
import { encrypt } from "@/engine/crypto";
import { loadCompany } from "@/engine/context";
import { backfillCompany } from "@/engine/backfill";
import { applySalesCallPlan, backfillSalesCalls, type SalesCallReport, type SalesCallRow } from "@/engine/sales-call-backfill";
import { installCompany } from "@/engine/install";
import { parseDefinition, extractManifest } from "@/engine/definition";
import { syncTriggers } from "@/engine/install";
import { fakeAdapters } from "@/engine/test-install";
import type { Adapters, AppointmentSnapshot, ContactSnapshot, LiveCard, ObjectRecord } from "@/adapters/types";

const HAS_DB = !!process.env.DATABASE_URL;
process.env.BINDINGS_KEY ??= Buffer.alloc(32, 7).toString("base64");
const TZ = "America/New_York";
const at = (daysAgo: number, h: number) => DateTime.now().setZone(TZ).minus({ days: daysAgo }).set({ hour: h, minute: 0, second: 0, millisecond: 0 });
const iso = (d: DateTime) => d.toUTC().toISO()!;

const people: Record<string, ContactSnapshot> = Object.fromEntries([
  ["GA", "Ann", "a@x.com", []], ["GB", "Bea", "b@x.com", []], ["GC", "Cat", "c@x.com", []], ["GD", "Dee", "d@x.com", []], ["GE", "Eve", "e@x.com", []],
  ["GF", "Fay", "f@x.com", []], ["GG", "Gus", "g@x.com", ["sys-test"]], ["GH", "Hal", "h@x.com", []], ["GI", "Ivy", "i@x.com", []], ["GJ", "Joy", "j@x.com", []],
].map(([id, first, email, tags]) => [id as string, { id: id as string, firstName: first as string, lastName: "Test", email: email as string, tags: tags as string[], customFields: {}, dateUpdated: iso(at(25, 9)), dateAdded: iso(at(25, 9)) }]));

const snap = (id: string, cal: string, contact: string | null, start: DateTime, extra: Partial<AppointmentSnapshot> = {}): AppointmentSnapshot => ({
  id, calendarId: cal, ...(contact ? { contactId: contact } : {}), assignedUserEmail: "carly@x.com", startTime: iso(start), endTime: iso(start.plus({ minutes: 45 })), status: "confirmed", dateAdded: iso(start.minus({ days: 3 })), raw: {}, ...extra });
const A = at(10, 15), B = at(9, 15), C0 = at(8, 11), C1 = at(8, 16), D = at(7, 15), E = at(6, 15), F = at(6, 17), G = at(5, 15), H = at(4, 15), I = at(3, 15), J = at(2, 15);
const bookings: Record<string, AppointmentSnapshot[]> = {
  CAL: [
    snap("evt-A", "CAL", "GA", A, { meetingUrl: "https://us06web.zoom.us/j/81111111111?pwd=x" }),
    snap("evt-B", "CAL", "GB", B, { status: "cancelled", cancellation: { by: "Bea", byType: "invitee", reason: "can't make it", at: iso(B.minus({ days: 1 })) } }),
    snap("evt-C0", "CAL", "GC", C0, { status: "cancelled", rescheduledTo: "evt-C1", cancellation: { by: "Carly Vu", byType: "host", reason: "Rescheduled", at: iso(C0.minus({ hours: 2 })) } }),
    snap("evt-C1", "CAL", "GC", C1, { rescheduledFrom: "evt-C0" }),
    snap("evt-D", "CAL", "GD", D),
    snap("evt-E", "CAL", "GE", E),
    snap("evt-F", "CAL", "GF", F, { assignedUserEmail: "annabelle@x.com" }),
    snap("evt-G", "CAL", "GG", G),
    snap("evt-H", "CAL", "GH", H),
    snap("evt-I", "CAL", "GI", I),
  ],
  DEMO: [snap("evt-J", "DEMO", null, J, { invitee: { email: "j@x.com", firstName: "Joy", lastName: "Test" } })],
};

/** What the vendors hold, and every write the engine makes to them. */
const world = {
  records: [] as ObjectRecord[], creates: 0, updates: [] as { id: string; properties: Record<string, unknown> }[], relations: [] as string[], jevAsked: [] as string[],
  cards: { GI: [{ id: "OPP-I", pipelineId: "P", stageId: "S-NS", status: "open", name: "Ivy", updatedAt: iso(I.plus({ hours: 2 })), stageChangedAt: iso(I.plus({ hours: 2 })) }], GA: [{ id: "OPP-A", pipelineId: "P", stageId: "S-FU", status: "open", name: "Ann", updatedAt: iso(A.plus({ days: 1 })), stageChangedAt: iso(A.plus({ days: 1 })) }] } as Record<string, LiveCard[]>,
};
const FIELDS = [["display_label"], ["external_id"], ["contact_id"], ["opportunity_id"], ["scheduled_at"], ["call_date", "DATE"], ["setter"], ["recording_url"], ["notes", "LARGE_TEXT"],
  ["closer", "SINGLE_OPTIONS", ["carly", "annabelle"]], ["outcome", "SINGLE_OPTIONS", ["scheduled", "showed", "no_show", "cancelled", "rescheduled"]], ["disposition", "SINGLE_OPTIONS", ["closed_won", "deposit", "dq", "no_offer", "follow_up", "lost"]],
  ["cash_collected", "MONETORY"], ["contract_value", "MONETORY"], ["next_step", "SINGLE_OPTIONS", ["follow_up_booked", "sending_info", "nurture", "dead"]], ["objection_primary", "SINGLE_OPTIONS", ["price", "timing", "none"]],
  ["call_type", "SINGLE_OPTIONS", ["closing", "demo"]], ["booking_source", "SINGLE_OPTIONS", ["setter", "direct"]]] as [string, string?, string[]?][];
const EOD: ObjectRecord[] = [{ id: "eod-H", createdAt: iso(H.plus({ hours: 8 })), properties: { report_date: H.toISODate(), report_label: "Carly", calls_scheduled: 1, calls_taken: 0, notes: "1 no show" } }];

function adapters(): Adapters {
  const base = fakeAdapters({ crm: new Map(Object.entries(people)) });
  return { ...base,
    read: { ...base.read,
      listUsers: async () => [{ id: "U-CARLY", email: "carly@x.com", name: "Carly Vu" }, { id: "U-ANNA", email: "annabelle@x.com", name: "Annabelle Ray" }],
      objectRecords: async (_c, key) => (key === "custom_objects.sales_call" ? world.records.map((r) => ({ ...r, properties: { ...r.properties } })) : key === "custom_objects.closer_eod" ? EOD : []),
      objectFields: async (_c, key) => (key === "custom_objects.sales_call" ? FIELDS.map(([k, type, opts]) => ({ key: k, type: type ?? "TEXT", ...(opts ? { options: opts.map((o) => ({ key: o, label: o.replace(/_/g, " ") })) } : {}) })) : []),
      openCards: async (_c, id) => world.cards[id] ?? [],
      contactNotes: async () => [],
      contactsByEmail: async (_c, email) => Object.values(people).filter((p) => p.email === email),
    },
    booking: (() => { const b = { appointmentsInWindow: async (_c: unknown, cal: string) => bookings[cal] ?? [], getAppointment: async () => null, listCalendars: async () => [{ id: "CAL", name: "Consultation", teamMemberIds: [] }, { id: "DEMO", name: "Demo Call", teamMemberIds: [] }] }; return { ghl: b, calendly: b }; })(),
    write: { ...base.write,
      createRecord: async (_c, _o, properties) => { world.creates++; const id = `REC-${world.records.length + 1}`; world.records.push({ id, createdAt: new Date().toISOString(), properties }); return { id }; },
      updateRecord: async (_c, _o, id, properties) => { world.updates.push({ id, properties }); const r = world.records.find((x) => x.id === id); if (r) Object.assign(r.properties, properties); },
      relateRecords: async (_c, assoc, a, b) => { world.relations.push(`${assoc}:${a}→${b}`); },
    },
    classifier: { choice: async (_state, input, options, _t, opts) => {
      world.jevAsked.push(opts?.question ?? "");
      const pick = (v: string) => ({ value: v, confidence: 0.93, distribution: Object.fromEntries(options.map((o) => [o, o === v ? 0.93 : 0.07 / options.length])), unclear: false });
      if (opts?.question === "What kind of recording is this?") return pick("sales_call");
      if (opts?.question === "How did this sales call end?") return pick("follow_up");
      if (opts?.question === "Which of these is the next step?") return pick("follow_up_booked");
      if (opts?.question?.startsWith("According to the text, what happened")) return input.includes("1 no show") ? pick("no_show") : pick("not_said");
      return pick(options.includes("not_said") ? "not_said" : options[options.length - 1]);
    } },
    analyst: { analyze: async () => ({ text: "{}", parsed: { notes: { summary: "Ann wants more clients; agreed to talk again Friday.", primary_objection: "price", next_step: "Call again Friday", next_step_date: "" }, rubric: {} }, model: "fake", usage: { input: 0, output: 0, cacheRead: 0 } }) },
    recorder: {
      transcript: async () => [{ speaker: "Carly Vu", text: "Hi Ann" }, { speaker: "Ann", text: "Hi, the price worries me" }],
      meetings: async () => [{ recording_id: 501, title: "Ann and Carly Vu", recording_start_time: iso(A.plus({ minutes: 2 })), recording_end_time: iso(A.plus({ minutes: 50 })), meeting_url: "https://us06web.zoom.us/j/81111111111?pwd=other",
        calendar_invitees: [{ name: "Carly Vu", email: "carly@x.com", is_external: false }], recorded_by: { name: "Carly Vu", email: "carly@x.com" }, share_url: "https://fathom.video/share/ann", url: "https://fathom.video/calls/501" }],
    },
  };
}

let companyId: string;
async function wipe(c: PoolClient, slug: string) {
  const co = await one<{ id: string }>(c, "select id from companies where slug=$1", [slug]);
  if (!co) return;
  await c.query("delete from workflow_versions where workflow_id in (select id from workflows where company_id=$1)", [co.id]);
  for (const t of ["run_steps", "runs", "crm_records", "rollups_daily", "payments", "events", "recordings", "appointments", "opportunities", "workflow_triggers", "workflows", "calendars", "company_terms", "contact_identifiers", "contacts", "users", "bindings", "poll_cursors", "audit_log"])
    await c.query(t === "run_steps" ? "delete from run_steps where run_id in (select id from runs where company_id=$1)" : `delete from ${t} where company_id=$1`, [co.id]);
  await c.query("delete from companies where id=$1", [co.id]);
}
const pmuCopy = async (c: PoolClient, file: string) => {
  const def = parseDefinition((JSON.parse(readFileSync(`installs/pmu/${file}`, "utf8")) as { definition: unknown }).definition);
  const wf = (await one<{ id: string }>(c, "insert into workflows (company_id, name, reentry_policy, enabled) values ($1,$2,$3,true) returning id", [companyId, file.replace(".json", ""), def.reentry]))!;
  await c.query("insert into workflow_versions (workflow_id, version, definition, manifest, note) values ($1,1,$2,$3,'test')", [wf.id, def, extractManifest(def)]);
  await syncTriggers(c, companyId, wf.id, def);
};
const counts = () => asOperator(async (c) => ({
  events: Number((await one<{ n: string }>(c, "select count(*) as n from events where company_id=$1", [companyId]))!.n),
  runs: Number((await one<{ n: string }>(c, "select count(*) as n from runs where company_id=$1", [companyId]))!.n),
  records: Number((await one<{ n: string }>(c, "select count(*) as n from crm_records where company_id=$1", [companyId]))!.n),
  outcomes: Number((await one<{ n: string }>(c, "select count(*) as n from appointments where company_id=$1 and outcome_term is not null", [companyId]))!.n),
}));
const window = () => ({ from: at(20, 0).toJSDate(), to: new Date() });
const run = (opts: { dryRun: boolean; closer?: string }) => asOperator(async (c) => backfillSalesCalls(c, await loadCompany(c, companyId), adapters(), { ...window(), closer: opts.closer ?? "carly@x.com", dryRun: opts.dryRun, eodObject: "custom_objects.closer_eod" }));
const rowOf = (r: SalesCallReport, key: string) => r.rows.find((x) => x.slot_key === key) as SalesCallRow;

describe.skipIf(!HAS_DB)("sales-call history (D115)", () => {
  let dry: SalesCallReport;
  beforeAll(async () => {
    await migrate();
    await asOperator((c) => wipe(c, "scb"));
    companyId = (await installCompany({ name: "SCB", slug: "scb", timezone: TZ, locationId: "LOC-scb", pit: "fake", templates: ["new-lead"], contractValueDefault: 10000,
      calendars: { CAL: { term: "closing", booking: "self" }, DEMO: { term: "closing", name: "Demo call", booking: "self" } }, closers: ["carly@x.com", "annabelle@x.com"],
      crm: { pipeline_closer: "P", stage_closer_no_show: "S-NS", stage_closer_follow_up: "S-FU", stage_closer_lost: "S-LOST", assoc_sales_call_contact: "AS-C", assoc_sales_call_opportunity: "AS-O" },
      salesCall: { object: "custom_objects.sales_call", outcomes: { scheduled: "scheduled", showed: "showed", no_show: "noshow", cancelled: "cancelled", rescheduled: "rescheduled" },
        dispositions: { closed_won: "closed", deposit: "deposit", follow_up: "follow_up", lost: "lost", dq: "unqualified", no_offer: { meaning: "unqualified", reason: "No offer made" } }, dqDispositions: ["dq", "no_offer"], bookingSources: { setter: "setter", self: "direct" } },
    }, adapters())).companyId;
    await asOperator(async (c) => {
      await c.query("insert into bindings (company_id,key,kind,value) values ($1,'secret.fathom_api_key','secret',$2),($1,'secret.anthropic_key','secret',$3)", [companyId, encrypt("fk"), encrypt("ak")]);
      // the workflows that would answer what the backfill writes, switched on: nothing may start them
      for (const f of ["call-booked.json", "call-recorded.json", "call-outcome.json", "card-moved.json"]) await pmuCopy(c, f);
    });
    const pays = async () => [{ providerPaymentId: "pay_D", amount: 10000, status: "succeeded" as const, paidAt: D.plus({ hours: 2 }).toJSDate(), email: "d@x.com", raw: { backfill: true } }];
    const hist = await asOperator(async (c) => { const { row, adapterCompany, bindings } = await loadCompany(c, companyId); return backfillCompany(c, row, adapterCompany, adapters(), bindings, window(), pays, ["appointments", "recordings", "payments"]); });
    expect(hist).toMatchObject({ appointments: 10, recordings: 1, recordingsUnlinked: 0, payments: 1, errors: [] });
  });

  it("the recordings history links by the ladder and emits nothing", async () => {
    const r = await asOperator((c) => one<{ link_status: string; linked_by: string; appointment_id: string; transcript: unknown; raw: { transcript_status: string } }>(c, "select link_status, linked_by, appointment_id, transcript, raw from recordings where company_id=$1 and external_id='501'", [companyId]));
    expect(r).toMatchObject({ link_status: "linked", linked_by: "meeting", transcript: null, raw: { transcript_status: "at_source" } });
    expect(r!.appointment_id).toBe((await asOperator((c) => one<{ id: string }>(c, "select id from appointments where company_id=$1 and external_id='evt-A'", [companyId])))!.id);
    expect(await asOperator((c) => many(c, "select 1 from events where company_id=$1 and event_type like 'recording.%'", [companyId]))).toHaveLength(0);
    expect((await counts()).runs).toBe(0);
  });

  it("a dry run reads every field from evidence, says what it cannot know, and writes nothing", async () => {
    const before = await counts();
    dry = await run({ dryRun: true });
    expect(dry.complete).toBe(true);
    expect(dry.plan_id).toBeTruthy();
    // only the closer's calls: Annabelle's is not here; the moved slot is its own row
    expect(dry.rows.map((r) => r.slot_key).sort()).toEqual(["evt-A", "evt-B", "evt-C0", "evt-C1", "evt-D", "evt-E", "evt-G", "evt-H", "evt-I", "evt-J"]);
    expect(rowOf(dry, "evt-G").skipped).toMatch(/test contact/);

    const a = rowOf(dry, "evt-A");   // a recording: showed; the transcript says how it ended and what was said
    expect(a.fields).toMatchObject({ outcome: "showed", disposition: "follow_up", objection_primary: "price", next_step: "follow_up_booked", recording_url: "https://fathom.video/share/ann", closer: "carly", call_type: "closing", booking_source: "direct" });
    expect(a.evidence.outcome[0].source).toBe("Fathom");
    expect(a.write!.properties).toMatchObject({ external_id: "evt-A", contact_id: "GA", opportunity_id: "OPP-A", outcome: "showed", call_date: A.toISODate(), closer: "carly" });
    expect(rowOf(dry, "evt-B").fields.outcome).toBe("cancelled");
    expect(rowOf(dry, "evt-B").evidence.outcome[0].detail).toMatch(/before the call/);
    expect(rowOf(dry, "evt-C0")).toMatchObject({ kind: "left_slot", fields: { outcome: "rescheduled" } });
    expect(rowOf(dry, "evt-C0").write!.properties).toMatchObject({ external_id: "evt-C0", outcome: "rescheduled", call_date: C0.toISODate() });
    expect(rowOf(dry, "evt-C1").write!.properties.external_id).toBe("evt-C1");
    const d = rowOf(dry, "evt-D");   // money: closed, the cash, and a show (paid two hours after)
    expect(d.fields).toMatchObject({ outcome: "showed", disposition: "closed_won", cash_collected: 10000 });
    expect(d.write!.properties).toMatchObject({ cash_collected: 10000, disposition: "closed_won" });
    const e = rowOf(dry, "evt-E");   // nothing at all: blank, with an idea of what happened
    expect(e.fields.outcome).toBeUndefined();
    expect(e.write!.properties.outcome).toBeUndefined();
    expect(e.unknown.find((u) => u.field === "outcome")).toMatchObject({ likely: expect.any(String), why: expect.stringMatching(/no end-of-day line/) });
    expect(rowOf(dry, "evt-H").fields.outcome).toBe("no_show");   // the closer's end of day, read by Jev
    expect(rowOf(dry, "evt-H").evidence.outcome[0].source).toBe("end-of-day report");
    expect(rowOf(dry, "evt-I").fields.outcome).toBe("no_show");   // the card dragged to No Show after the call
    const j = rowOf(dry, "evt-J");   // a Demo call whose person the engine had no GHL id for: found by email, linked on write
    expect(j.fields).toMatchObject({ call_type: "demo" });
    expect(j.write!.link_contact).toMatchObject({ ghl_contact_id: "GJ" });

    expect(await counts()).toEqual(before);
    expect(world.creates + world.updates.length + world.relations.length).toBe(0);
  });

  it("the write applies the reviewed plan once: records keyed by the slot, related, in crm_records, the ledger's outcome, no runs", async () => {
    const before = await counts();
    const w = await asOperator(async (c) => applySalesCallPlan(c, await loadCompany(c, companyId), adapters(), [dry.plan_id!]));
    expect(w.summary).toMatchObject({ written: 9, created: 9, errors: 0, skipped: 1 });
    expect(world.records.map((r) => r.properties.external_id).sort()).toEqual(["evt-A", "evt-B", "evt-C0", "evt-C1", "evt-D", "evt-E", "evt-H", "evt-I", "evt-J"]);
    const recA = world.records.find((r) => r.properties.external_id === "evt-A")!;
    expect(world.relations).toEqual(expect.arrayContaining([`AS-C:GA→${recA.id}`, `AS-O:${recA.id}→OPP-A`]));
    expect(world.records.find((r) => r.properties.external_id === "evt-E")!.properties.outcome).toBeUndefined();
    const ours = await asOperator((c) => many<{ record_key: string; ghl_record_id: string }>(c, "select record_key, ghl_record_id from crm_records where company_id=$1 order by record_key", [companyId]));
    expect(ours.map((r) => r.record_key)).toEqual(["evt-A", "evt-B", "evt-C0", "evt-C1", "evt-D", "evt-E", "evt-H", "evt-I", "evt-J"]);
    const ledger = await asOperator((c) => many<{ external_id: string; status: string; outcome: string | null; call_outcome: string | null }>(c, `select a.external_id, a.status, ot.category as outcome, cot.category as call_outcome from appointments a
      left join company_terms ot on ot.id=a.outcome_term left join company_terms cot on cot.id=a.call_outcome_term where a.company_id=$1 order by a.external_id`, [companyId]));
    expect(Object.fromEntries(ledger.map((l) => [l.external_id, [l.status, l.outcome, l.call_outcome]]))).toMatchObject({
      "evt-A": ["showed", "showed", "follow_up"], "evt-B": ["cancelled", "cancelled", null], "evt-D": ["showed", "showed", "closed"], "evt-E": ["confirmed", null, null], "evt-H": ["noshow", "noshow", null], "evt-I": ["noshow", "noshow", null] });
    expect(await asOperator((c) => one<{ ghl_contact_id: string }>(c, "select ct.ghl_contact_id from contacts ct join appointments a on a.contact_id=ct.id where a.company_id=$1 and a.external_id='evt-J'", [companyId]))).toEqual({ ghl_contact_id: "GJ" });
    const after = await counts();
    expect(after.events).toBe(before.events);   // nothing emitted, so nothing can start
    expect(after.runs).toBe(0);
  });

  it("a second pass makes no second record and leaves a value someone filed in GHL alone", async () => {
    const recB = world.records.find((r) => r.properties.external_id === "evt-B")!;
    recB.properties.outcome = "showed";   // someone filed it in GHL meanwhile
    const created = world.creates;
    const again = await run({ dryRun: false });
    expect(world.creates).toBe(created);
    expect(again.summary).toMatchObject({ written: 9, updated: 9, created: 0 });
    expect(world.records.find((r) => r.properties.external_id === "evt-B")!.properties.outcome).toBe("showed");
    expect(rowOf(again, "evt-B").written!.kept).toEqual([expect.stringMatching(/^outcome/)]);
    expect(await asOperator((c) => many(c, "select 1 from crm_records where company_id=$1", [companyId]))).toHaveLength(9);
    expect((await counts()).runs).toBe(0);
  });

  it("another closer's pass sees only theirs", async () => {
    const r = await run({ dryRun: true, closer: "annabelle@x.com" });
    expect(r.rows.map((x) => x.slot_key)).toEqual(["evt-F"]);
  });
});
