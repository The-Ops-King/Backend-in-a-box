import { DateTime } from "luxon";
import type { PoolClient } from "pg";
import { many, one } from "@/db/client";
import { bookingFor, type Adapters, type AppointmentSnapshot, type Company, type ContactNote, type LiveCard, type ObjectRecord } from "@/adapters/types";
import { templates } from "@/templates";
import { buildContext, type CompanyRow, type RunRow } from "./context";
import { parseDefinition, type Definition, type Node } from "./definition";
import { render } from "./template";
import { evaluate } from "./predicate";
import { propertyValue } from "./executor";
import { bookingSourceValues, salesCallValues } from "./sales-call";
import { isTestContact, testContactSql, testDomains } from "./mode";
import { boundFieldIds, upsertContact } from "./poll";
import type { RecordingRow } from "./recordings";
import { transcriptFor } from "./transcripts";
import { outcomeTermFor } from "./disposition";
import { rollupRange } from "./metrics";

/**
 * D115: a closer's Sales Calls over a window, read back from the evidence and written the way Call booked writes them
 * (same key, same properties, the company's option keys), each field only from a fact; what cannot be established is left
 * blank and comes back as "most likely … because …" for a person to decide. Rows only in the ledger, nothing emitted,
 * no workflow started. A dry run writes nothing but its plan (audit_log), which the write can then apply exactly.
 */

type Attendance = "showed" | "noshow" | "cancelled" | "rescheduled" | "scheduled";
export type Evidence = { source: string; detail: string };
export type UnknownField = { field: string; likely: string; why: string };
export type SalesCallWrite = {
  object: string; key: string; properties: Record<string, unknown>; relate: { association: string; first: string; second: string }[];
  ledger: { appointment_id: string | null; outcome: string | null; call_outcome: string | null };
  link_contact: { contact_id: string; ghl_contact_id: string } | null;
};
export type SalesCallRow = {
  slot_key: string; kind: "booking" | "left_slot"; appointment_id: string | null;
  contact: { id: string | null; ghl_contact_id: string | null; name: string | null; email: string | null };
  starts_at: string; call_date: string; time: string; calendar: string; closer: string | null;
  /** what goes to the CRM for each evidenced field, in the company's own option keys */
  fields: Record<string, string | number>;
  evidence: Record<string, Evidence[]>;
  unknown: UnknownField[];
  remarks: string[];
  write: SalesCallWrite | null;
  skipped?: string; error?: string;
  written?: { record: "created" | "updated"; crm_id: string; related: string[]; ledger: string[]; kept: string[] };
};
export type SalesCallReport = {
  company: string; from: string; to: string; closer: string | null; dry_run: boolean; complete: boolean; resume_from?: string; plan_id?: string;
  rows: SalesCallRow[]; summary: Record<string, number>; errors: string[];
};
/** A person's call on what the evidence leaves open, or a person to leave out: each says why, and the plan keeps it. */
export type SalesCallDecision = { slot: string; fields: Record<string, string | number>; why: string };
export type SalesCallExclusion = { email: string; why: string };
export type SalesCallOptions = { from: Date; to: Date; closer?: string; dryRun?: boolean; eodObject?: string; budgetMs?: number; now?: Date; concurrency?: number; decide?: SalesCallDecision[]; exclude?: SalesCallExclusion[];
  /** where a pass that ran out of time stopped: the window (and what a decision may name) stays from `from` */
  resumeFrom?: Date };
export type LoadedCompany = { row: CompanyRow; adapterCompany: Company; bindings: Record<string, string> };

const RECORD_ID = "(this record)";   // stands in for the CRM id the write gets back
const PAID_SHOWED_WITHIN_H = 48;     // a payment this soon after the call is that call held
const CREDIT_DAYS = 30;              // a payment is the call's when no later call came first, up to this long after it
const NOTES_BEFORE_H = 2, NOTES_AFTER_D = 3;
const DISPOSITION_WORDS: Record<string, string> = {
  closed: "They agreed to buy and payment was arranged or taken on the call.",
  deposit: "They put down a deposit to hold their place; the rest of the price is still to come.",
  pending: "They agreed in principle; payment or paperwork is still to come.",
  follow_up: "No decision yet; a next conversation or a think-it-over was agreed.",
  lost: "They said no.",
  unqualified: "Not a fit: the team disqualified them.",
};
const ATTENDANCE_WORDS: Record<string, string> = {
  showed: "The prospect attended the call in question: it was held.",
  no_show: "The prospect did not turn up for the call in question.",
  cancelled: "The call in question was cancelled before it took place.",
  rescheduled: "The call in question was moved to another time, before or on the call.",
  not_said: "The text says nothing about the call in question, or what it says cannot be tied to that call.",
};
const NO_SHOW_WORD: Record<string, Attendance> = { showed: "showed", no_show: "noshow", cancelled: "cancelled", rescheduled: "rescheduled" };
/** What a card on the closer board says about the person's latest held call, as Card moved by hand files it (D88); the rest only leans. */
const STAGE_FILES: Record<string, { attendance: Attendance; disposition?: string }> = { no_show: { attendance: "noshow" }, lost: { attendance: "showed", disposition: "lost" }, disqualified: { attendance: "showed", disposition: "unqualified" } };
const STAGE_LEANS: Record<string, { attendance: Attendance; disposition?: string }> = { follow_up: { attendance: "showed", disposition: "follow_up" }, closed_won: { attendance: "showed", disposition: "closed" }, purchase: { attendance: "showed", disposition: "closed" }, cancelled: { attendance: "cancelled" }, rescheduled: { attendance: "rescheduled" } };

type Setup = {
  callBooked: Definition; k4: Extract<Node, { type: "crm_record" }>; objectKey: string; callType?: Extract<Node, { type: "set_var" }>;
  kindNode?: Extract<Node, { type: "classify" }>; analyzeNode?: Extract<Node, { type: "analyze" }>;
  fields: Map<string, { type?: string; options?: { key: string; label?: string }[] }> | null;
  dispositions: { key: string; meaning: string; reason?: string }[]; outcomes: ReturnType<typeof salesCallValues>; sources: { setter: string; self: string };
  board?: string; stages: Map<string, string>;
};
type Closer = { id: string; name: string; email: string; ghl_user_id: string | null };
type LedgerAppt = { id: string; contact_id: string; external_id: string; slot_key: string; starts_at: Date; status: string; self_booked: boolean | null; set_by: string | null; assigned_user_id: string | null; term_name: string; cal_name: string | null; closer_email: string | null; closer_name: string | null; outcome: string | null; call_outcome: string | null };
/** A slot a move left, as its own source tells it: when it was moved, to when, by whom. Its time is always its own start, never the replacement's. */
type Move = { source: string; at: Date | null; to: Date | null; by: string; reason: string };
type Slot = { kind: "booking" | "left_slot"; key: string; startsAt: Date; appt?: LedgerAppt; snap?: AppointmentSnapshot; move?: Move; calendar: string; termName: string; selfBooked: boolean | null; closer: Closer | null; contactId: string | null; email: string | null };
type Fact<T> = { value: T; source: string; detail: string; rank: number; tied?: boolean };
type Shared = {
  c: PoolClient; co: LoadedCompany; adapters: Adapters; setup: Setup; now: Date; eods: ObjectRecord[]; existing: Map<string, ObjectRecord>;
  daySlots: Map<string, Slot[]>; starts: Map<string, Date>; recreated: Map<string, { from: string; at: Date | null }>; notes: Map<string, Promise<ContactNote[]>>; cards: Map<string, Promise<LiveCard[]>>; coverage: Map<string, { since: Date; recorded: number; calls: number }>;
  staff: Set<string>; domains: string[]; decide: Map<string, SalesCallDecision>; exclude: SalesCallExclusion[];
};

const iso = (d: Date | string) => (typeof d === "string" ? d : d.toISOString());
const local = (d: Date | string, tz: string) => DateTime.fromJSDate(new Date(d)).setZone(tz);
const minutes = (ms: number) => Math.round(ms / 60000);
const pct = (p: number) => `${Math.round(p * 100)}%`;

/** The Call booked workflow's Sales Call step (keyed by the slot) and the Call recorded reads, the company's own copies first, else the shipped templates. */
async function loadSetup(c: PoolClient, co: LoadedCompany, adapters: Adapters): Promise<Setup> {
  const defs = (await many<{ definition: unknown; enabled: boolean }>(c, "select v.definition, w.enabled from workflows w join workflow_versions v on v.workflow_id=w.id and v.version=w.current_version where w.company_id=$1 order by w.enabled desc, w.created_at", [co.row.id]))
    .map((r) => { try { return parseDefinition(r.definition); } catch { return null; } }).filter((d): d is Definition => !!d);
  const shipped = (slug: string) => parseDefinition(JSON.parse(JSON.stringify(templates.find((t) => t.slug === slug)!.definition)));
  const listens = (d: Definition, ev: string) => d.nodes.some((n) => n.type === "trigger" && n.event === ev);
  const slotStep = (d: Definition) => d.nodes.find((n): n is Extract<Node, { type: "crm_record" }> => n.type === "crm_record" && (n.key ?? "").replace(/\s+/g, "") === "{{appointment.slot_key}}");
  const callBooked = defs.find((d) => listens(d, "appointment.booked") && slotStep(d)) ?? shipped("call-booked");
  const k4 = slotStep(callBooked); if (!k4) throw new Error("no Call booked step writes a Sales Call keyed by the call slot");
  const recorded = defs.find((d) => listens(d, "recording.received")) ?? shipped("call-recorded");
  const ctx = { crm: Object.fromEntries(Object.entries(co.bindings).filter(([k]) => k.startsWith("crm.")).map(([k, v]) => [k.slice(4), v])) };
  const objectKey = render(k4.object, ctx, { tz: co.row.timezone });
  let fields: Setup["fields"] = null;
  try { if (adapters.read.objectFields) { const f = await adapters.read.objectFields(co.adapterCompany, objectKey); if (f.length) fields = new Map(f.map((x) => [x.key, { type: x.type, options: x.options }])); } } catch { fields = null; }
  let map: Record<string, unknown> = {};
  try { map = JSON.parse(co.bindings["sales_call.dispositions"] ?? "{}") as Record<string, unknown>; } catch { map = {}; }
  const dispositions = Object.entries(map).map(([key, v]) => typeof v === "string" ? { key, meaning: v } : { key, meaning: String((v as { meaning?: string }).meaning ?? ""), reason: (v as { reason?: string }).reason }).filter((d) => d.meaning);
  const stages = new Map<string, string>();
  for (const [k, v] of Object.entries(co.bindings)) if (k.startsWith("crm.stage_closer_")) stages.set(v, k.slice("crm.stage_closer_".length));
  return {
    callBooked, k4, objectKey, callType: callBooked.nodes.find((n): n is Extract<Node, { type: "set_var" }> => n.type === "set_var" && n.key === "call_type"),
    kindNode: recorded.nodes.find((n): n is Extract<Node, { type: "classify" }> => n.type === "classify" && n.domain === "recording_kind"),
    analyzeNode: recorded.nodes.find((n): n is Extract<Node, { type: "analyze" }> => n.type === "analyze"),
    fields, dispositions, outcomes: salesCallValues(co.bindings), sources: bookingSourceValues(co.bindings), board: co.bindings["crm.pipeline_closer"], stages,
  };
}

export async function backfillSalesCalls(c: PoolClient, co: LoadedCompany, adapters: Adapters, opts: SalesCallOptions): Promise<SalesCallReport> {
  const started = Date.now(), now = opts.now ?? new Date(), tz = co.row.timezone, dryRun = opts.dryRun ?? true;
  const report: SalesCallReport = { company: co.row.slug, from: iso(opts.from), to: iso(opts.to), closer: opts.closer ?? null, dry_run: dryRun, complete: true, rows: [], summary: {}, errors: [] };
  const setup = await loadSetup(c, co, adapters);

  let closer: Closer | null = null;
  if (opts.closer) {
    closer = (await one<Closer>(c, "select id, name, email, ghl_user_id from users where company_id=$1 and (lower(email)=lower($2) or ghl_user_id=$2)", [co.row.id, opts.closer.trim()])) ?? null;
    if (!closer) throw new Error(`no closer ${opts.closer} on the company's roster`);
    report.closer = closer.email;
  }
  const users = await many<Closer>(c, "select id, name, email, ghl_user_id from users where company_id=$1", [co.row.id]);
  const calendars = await many<{ id: string; external_id: string; name: string; term_name: string; self_booked: boolean | null }>(c,
    "select cal.id, cal.external_id, cal.name, t.name as term_name, cal.self_booked from calendars cal join company_terms t on t.id=cal.appointment_term where cal.company_id=$1 and cal.source=$2 and cal.active and t.category='closing'", [co.row.id, co.adapterCompany.booking.source]);

  const ledger = await many<LedgerAppt>(c, `select a.id, a.contact_id, a.external_id, coalesce(a.slot_key, a.external_id) as slot_key, a.starts_at, a.status, a.self_booked, a.set_by, a.assigned_user_id,
      t.name as term_name, cal.name as cal_name, u.email as closer_email, u.name as closer_name, ot.category as outcome, cot.category as call_outcome
    from appointments a join company_terms t on t.id=a.appointment_term left join calendars cal on cal.id=a.calendar_id left join users u on u.id=a.assigned_user_id
      left join company_terms ot on ot.id=a.outcome_term left join company_terms cot on cot.id=a.call_outcome_term
    where a.company_id=$1 and t.category='closing' and a.source<>'test' and a.starts_at >= $2 and a.starts_at <= $3 ${closer ? "and a.assigned_user_id=$4" : ""} order by a.starts_at`,
    closer ? [co.row.id, opts.from, opts.to, closer.id] : [co.row.id, opts.from, opts.to]);

  // the booking source's own account of each call: who cancelled and when, a move, a no-show mark (the ledger keeps only the latest slot of a moved call)
  const snaps = new Map<string, AppointmentSnapshot>();
  const calOf = new Map(calendars.map((x) => [x.external_id, x]));
  for (const cal of calendars) for (const s of await bookingFor(adapters, co.adapterCompany).appointmentsInWindow(co.adapterCompany, cal.external_id, opts.from, opts.to)) snaps.set(s.id, s);
  const userOf = (s: AppointmentSnapshot) => users.find((u) => (s.assignedUserEmail && u.email.toLowerCase() === s.assignedUserEmail) || (s.assignedUserId && u.ghl_user_id === s.assignedUserId)) ?? null;

  const slots: Slot[] = [];
  for (const a of ledger) {
    const cal = calendars.find((x) => x.name === a.cal_name);
    slots.push({ kind: "booking", key: a.slot_key, startsAt: a.starts_at, appt: a, snap: snaps.get(a.external_id), calendar: a.cal_name ?? a.term_name, termName: a.term_name, selfBooked: a.self_booked ?? cal?.self_booked ?? null,
      closer: users.find((u) => u.id === a.assigned_user_id) ?? null, contactId: a.contact_id, email: null });
  }
  const inLedger = new Set(ledger.map((a) => a.slot_key));
  const recreated = new Map<string, { from: string; at: Date | null }>();
  for (const s of snaps.values()) {
    const moved = s.status === "cancelled" && (!!s.rescheduledTo || (s.raw.invitee as { rescheduled?: boolean } | undefined)?.rescheduled === true);
    const at = new Date(s.startTime);
    if (!moved || inLedger.has(s.id) || at < opts.from || at > opts.to) continue;
    // Calendly re-makes an event when the host edits it in a connected calendar, often at the very same time: that call did not move,
    // so the event it replaced is no slot of its own (the poll sees no move either: under a minute is no reschedule)
    const next = s.rescheduledTo ? snaps.get(s.rescheduledTo) : undefined;
    if (next && Math.abs(new Date(next.startTime).getTime() - at.getTime()) < 60e3) { recreated.set(next.id, { from: s.id, at: s.cancellation?.at ? new Date(s.cancellation.at) : null }); continue; }
    const host = userOf(s); if (closer && host?.id !== closer.id) continue;
    const email = s.invitee?.email ?? null;
    // the person as the booking names them: the CRM's id (a GHL calendar), else the invitee's email (Calendly)
    const ct = s.contactId ? await one<{ contact_id: string }>(c, "select id as contact_id from contacts where company_id=$1 and ghl_contact_id=$2 union all select contact_id from contact_identifiers where company_id=$1 and kind='ghl_contact' and value=$2 and retired_at is null limit 1", [co.row.id, s.contactId])
      : email ? await one<{ contact_id: string }>(c, "select contact_id from contact_identifiers where company_id=$1 and kind='email' and value=$2 and retired_at is null", [co.row.id, email]) : null;
    const cal = calOf.get(s.calendarId), by = s.cancellation ? `${s.cancellation.byType === "host" ? "the host" : s.cancellation.byType === "invitee" ? "the invitee" : "someone"}${s.cancellation.by ? ` (${s.cancellation.by})` : ""}` : "someone";
    slots.push({ kind: "left_slot", key: s.id, startsAt: at, snap: s, move: { source: "Calendly", at: s.cancellation?.at ? new Date(s.cancellation.at) : null, to: next ? new Date(next.startTime) : null, by, reason: s.cancellation?.reason ?? "" }, calendar: cal?.name ?? s.title ?? "", termName: cal?.term_name ?? "", selfBooked: cal?.self_booked ?? null, closer: host, contactId: ct?.contact_id ?? null, email });
  }
  // a move the engine itself saw (a GHL calendar keeps the booking's id; the poll logs the slot it left and its time before the move)
  const seen = new Set(slots.map((x) => x.key));
  const moves = await many<{ data: { slot?: { from?: string }; starts_at?: { from?: string; to?: string } }; occurred_at: Date; appointment_id: string }>(c, `select e.data, e.occurred_at, e.appointment_id from events e
    join appointments a on a.id=e.appointment_id join company_terms t on t.id=a.appointment_term
    where e.company_id=$1 and e.event_type='appointment.rescheduled' and t.category='closing' and e.data->'slot'->>'from' is not null and e.data->'starts_at'->>'from' is not null ${closer ? "and a.assigned_user_id=$2" : ""} order by e.occurred_at`,
    closer ? [co.row.id, closer.id] : [co.row.id]);
  for (const m of moves) {
    const key = m.data.slot!.from!, at = new Date(m.data.starts_at!.from!);
    if (seen.has(key) || inLedger.has(key) || Number.isNaN(at.getTime()) || at < opts.from || at > opts.to) continue;
    const a = await one<LedgerAppt & { calendar_self: boolean | null }>(c, `select a.id, a.contact_id, a.assigned_user_id, a.self_booked, a.set_by, t.name as term_name, cal.name as cal_name, cal.self_booked as calendar_self
      from appointments a join company_terms t on t.id=a.appointment_term left join calendars cal on cal.id=a.calendar_id where a.id=$1`, [m.appointment_id]);
    if (!a) continue;
    seen.add(key);
    slots.push({ kind: "left_slot", key, startsAt: at, move: { source: "the engine's poll", at: m.occurred_at, to: m.data.starts_at?.to ? new Date(m.data.starts_at.to) : null, by: "the booking source", reason: "" },
      calendar: a.cal_name ?? a.term_name, termName: a.term_name, selfBooked: a.self_booked ?? a.calendar_self, closer: users.find((u) => u.id === a.assigned_user_id) ?? null, contactId: a.contact_id, email: null });
  }
  slots.sort((x, y) => x.startsAt.getTime() - y.startsAt.getTime() || x.key.localeCompare(y.key));
  checkDecisions(setup, slots, opts.decide ?? [], opts.exclude ?? []);

  const shared: Shared = {
    c, co, adapters, setup, now, eods: [], existing: new Map(), daySlots: new Map(), starts: new Map([...[...snaps.values()].map((x): [string, Date] => [x.id, new Date(x.startTime)]), ...ledger.map((a): [string, Date] => [a.external_id, a.starts_at])]), recreated, notes: new Map(), cards: new Map(), coverage: new Map(),
    staff: new Set(users.map((u) => u.email.toLowerCase())), domains: testDomains(co.bindings),
    decide: new Map((opts.decide ?? []).map((d) => [d.slot, d])), exclude: opts.exclude ?? [],
  };
  for (const s of slots) { const k = `${s.closer?.id ?? ""}:${local(s.startsAt, tz).toISODate()}`; shared.daySlots.set(k, [...(shared.daySlots.get(k) ?? []), s]); }
  for (const u of new Set(slots.map((s) => s.closer).filter((x): x is Closer => !!x))) { const cov = await recordingCoverage(c, co.row.id, u, opts.to, shared.domains); if (cov) shared.coverage.set(u.id, cov); }
  for (const r of await adapters.read.objectRecords(co.adapterCompany, setup.objectKey)) { const ext = String(r.properties.external_id ?? "").trim(); if (ext && !shared.existing.has(ext)) shared.existing.set(ext, r); }
  const eodObject = opts.eodObject ?? co.bindings["crm.object_closer_eod"];
  if (eodObject) { try { shared.eods = await adapters.read.objectRecords(co.adapterCompany, eodObject); } catch (e) { report.errors.push(`end-of-day reports could not be read: ${String((e as Error).message).slice(0, 200)}`); } }

  // which slots this pass reads: in order, a few at a time, until the time budget is spent (the rest are the next call's, from resume_from)
  const budget = opts.budgetMs ?? 240_000, width = Math.max(1, opts.concurrency ?? 4);
  const rows: SalesCallRow[] = [], first = opts.resumeFrom ? slots.findIndex((x) => x.startsAt >= opts.resumeFrom!) : 0;
  for (let i = first < 0 ? slots.length : first; i < slots.length; i += width) {
    if (Date.now() - started > budget) { report.complete = false; report.resume_from = slots[i].startsAt.toISOString(); break; }
    const batch = slots.slice(i, i + width);
    rows.push(...await Promise.all(batch.map((s) => readSlot(shared, s).catch((e): SalesCallRow => ({ ...blankRow(shared, s), error: String((e as Error).message).slice(0, 300) })))));
  }
  report.rows = rows;
  if (dryRun) {
    const plan = await one<{ id: string }>(c, "insert into audit_log (company_id, action, target_type, target_id, after) values ($1::uuid,'sales_calls.planned','company',$1::text,$2) returning id::text", [co.row.id, { from: report.from, to: report.to, closer: report.closer, rows }]);
    report.plan_id = plan!.id;
  } else await applyRows(c, co, adapters, rows, setup.objectKey, shared.existing, { from: opts.resumeFrom ?? opts.from, to: report.complete ? opts.to : new Date(report.resume_from!) });
  report.summary = summarize(rows);
  return report;
}

/** Writes a dry run's plan exactly as it was reviewed (D115): the same rows, the same properties, nothing read again but what is already in the CRM. */
export async function applySalesCallPlan(c: PoolClient, co: LoadedCompany, adapters: Adapters, planIds: string[]): Promise<SalesCallReport> {
  const rows: SalesCallRow[] = []; let from = "", to = "", closer: string | null = null;
  for (const id of planIds) {
    const p = await one<{ after: { from: string; to: string; closer: string | null; rows: SalesCallRow[] } }>(c, "select after from audit_log where id=$2::bigint and company_id=$1 and action='sales_calls.planned'", [co.row.id, id]);
    if (!p) throw new Error(`no sales-call plan ${id} for ${co.row.slug}`);
    rows.push(...p.after.rows); closer = p.after.closer;
    if (!from || p.after.from < from) from = p.after.from;
    if (!to || p.after.to > to) to = p.after.to;
  }
  const object = rows.find((r) => r.write)?.write?.object;
  const existing = new Map<string, ObjectRecord>();
  if (object) for (const r of await adapters.read.objectRecords(co.adapterCompany, object)) { const ext = String(r.properties.external_id ?? "").trim(); if (ext && !existing.has(ext)) existing.set(ext, r); }
  const report: SalesCallReport = { company: co.row.slug, from, to, closer, dry_run: false, complete: true, rows, summary: {}, errors: [] };
  if (object) await applyRows(c, co, adapters, rows, object, existing, { from: new Date(from), to: new Date(to) });
  report.summary = summarize(rows);
  return report;
}

function summarize(rows: SalesCallRow[]): Record<string, number> {
  const s: Record<string, number> = { calls: rows.length, written: 0, created: 0, updated: 0, skipped: 0, errors: 0, outcome_unknown: 0, unknown_fields: 0 };
  for (const r of rows) {
    if (r.skipped) { s.skipped++; continue; }
    if (r.error) s.errors++;
    if (r.written) { s.written++; s[r.written.record]++; }
    const o = r.fields.outcome; if (o !== undefined) s[`outcome_${o}`] = (s[`outcome_${o}`] ?? 0) + 1; else s.outcome_unknown++;
    s.unknown_fields += r.unknown.length;
  }
  return s;
}

function blankRow(sh: Shared, s: Slot): SalesCallRow {
  const tz = sh.co.row.timezone, at = local(s.startsAt, tz);
  return { slot_key: s.key, kind: s.kind, appointment_id: s.appt?.id ?? null, contact: { id: s.contactId, ghl_contact_id: null, name: null, email: s.email }, starts_at: s.startsAt.toISOString(), call_date: at.toISODate()!, time: at.toFormat("h:mm a"),
    calendar: s.calendar, closer: s.closer?.name ?? null, fields: {}, evidence: {}, unknown: [], remarks: [], write: null };
}

const memo = <T>(m: Map<string, Promise<T>>, k: string, f: () => Promise<T>) => { if (!m.has(k)) m.set(k, f()); return m.get(k)!; };

async function readSlot(sh: Shared, s: Slot): Promise<SalesCallRow> {
  const { c, co, adapters, setup } = sh, tz = co.row.timezone, row = blankRow(sh, s);
  const add = (field: string, source: string, detail: string) => { (row.evidence[field] ??= []).push({ source, detail }); };
  if (!s.contactId) { row.skipped = `nobody in the engine's ledger books as ${s.email ?? "this invitee"}`; return row; }
  const ct = await one<{ id: string; ghl_contact_id: string | null; name: string | null; tags: string[] }>(c, "select id, ghl_contact_id, nullif(trim(coalesce(first_name,'')||' '||coalesce(last_name,'')),'') as name, tags from contacts where id=$1", [s.contactId]);
  const emails = (await many<{ value: string }>(c, "select value from contact_identifiers where contact_id=$1 and kind='email' and retired_at is null order by created_at", [s.contactId])).map((e) => e.value);
  row.contact = { id: s.contactId, ghl_contact_id: ct?.ghl_contact_id ?? null, name: ct?.name ?? null, email: emails[0] ?? s.email };
  if (isTestContact({ tags: ct?.tags, emails }, sh.domains)) { row.skipped = "a test contact (sys-test or a test domain): counted nowhere"; return row; }
  if (emails.some((e) => sh.staff.has(e.toLowerCase()))) { row.skipped = "a team member's own booking"; return row; }
  const out = sh.exclude.find((x) => [...emails, s.email ?? ""].some((e) => e.toLowerCase() === x.email.trim().toLowerCase()));
  if (out) { row.skipped = `left out by the operator: ${out.why}`; return row; }

  // the CRM's id for the person: the replica's, else the CRM's one contact with that email (the write links it the poll's way)
  let link: SalesCallWrite["link_contact"] = null;
  if (!row.contact.ghl_contact_id && row.contact.email && adapters.read.contactsByEmail) {
    const hits = await adapters.read.contactsByEmail(co.adapterCompany, row.contact.email);
    if (hits.length === 1) { row.contact.ghl_contact_id = hits[0].id; link = { contact_id: s.contactId, ghl_contact_id: hits[0].id }; row.remarks.push(`GHL contact found by email (${row.contact.email}); the write links it to the engine's person`); }
    else if (hits.length > 1) { row.skipped = `${hits.length} GHL contacts carry ${row.contact.email}; a person picks one`; return row; }
  }
  if (!row.contact.ghl_contact_id) { row.skipped = `no GHL contact for ${row.contact.email ?? "this person"}`; return row; }
  const ghlId = row.contact.ghl_contact_id;

  const start = s.startsAt, snap = s.snap;
  const calls = await many<{ id: string; starts_at: Date; status: string }>(c, "select a.id, a.starts_at, a.status from appointments a join company_terms t on t.id=a.appointment_term where a.contact_id=$1 and t.category='closing' and a.source<>'test' order by a.starts_at", [s.contactId]);
  const nextStart = calls.find((x) => x.starts_at > start && x.id !== s.appt?.id && x.status !== "cancelled")?.starts_at ?? null;
  const until = new Date(Math.min(nextStart?.getTime() ?? Infinity, start.getTime() + CREDIT_DAYS * 864e5));

  // ---- attendance: the booking source's facts about the slot settle it outright (D73: a cancel counts by its timing)
  const att: Fact<Attendance>[] = [], disp: Fact<string>[] = [], leanAtt: Fact<Attendance>[] = [], leanDisp: Fact<string>[] = [];
  const cancelAt = snap?.cancellation?.at ? new Date(snap.cancellation.at) : null;
  const who = snap?.cancellation ? `${snap.cancellation.byType === "host" ? "the host" : snap.cancellation.byType === "invitee" ? "the invitee" : "someone"}${snap.cancellation.by ? ` (${snap.cancellation.by})` : ""}` : "";
  const why = snap?.cancellation?.reason ? `, reason "${snap.cancellation.reason}"` : "";
  let settled: Attendance | null = null;
  if (s.kind === "left_slot") {
    const m = s.move!;
    settled = "rescheduled";
    add("outcome", m.source, `this slot (${local(start, tz).toFormat("LLL d, h:mm a")}) was moved by ${m.by}${m.at ? ` on ${local(m.at, tz).toFormat("LLL d, h:mm a")}` : ""}${m.to ? ` to ${local(m.to, tz).toFormat("LLL d, h:mm a")}` : ""}${m.reason ? `, reason "${m.reason}"` : ""}`);
    if (m.at && m.at > start) row.remarks.push(`moved ${minutes(m.at.getTime() - start.getTime())} min after its start time: most likely they did not turn up and the call was moved`);
  } else if (snap?.status === "cancelled" || s.appt?.status === "cancelled") {
    if (cancelAt && cancelAt < start) { settled = "cancelled"; add("outcome", "Calendly", `cancelled by ${who} on ${local(cancelAt, tz).toFormat("LLL d, h:mm a")}, before the call${why}`); }
    else if (cancelAt) { row.remarks.push(`Calendly shows it cancelled by ${who} ${minutes(cancelAt.getTime() - start.getTime())} min after its start: a slot cleared after the call is not a cancel (D73)`); leanAtt.push({ value: "noshow", source: "Calendly", detail: `${who} cleared the slot ${minutes(cancelAt.getTime() - start.getTime())} min after the start, which is what a host does after a no-show`, rank: 3 }); }
    else row.remarks.push("cancelled at the booking source at a time it does not say: not counted as a cancel");
  } else if (start > sh.now) { settled = "scheduled"; add("outcome", "Calendly", "booked; the call is still ahead"); }
  const remade = s.snap ? sh.recreated.get(s.snap.id) : undefined;
  if (remade) row.remarks.push(`Calendly re-made this booking at the same time${remade.at ? ` on ${local(remade.at, tz).toFormat("LLL d, h:mm a")}` : ""} (an edit in the host's connected calendar): the call did not move, so the event it replaced (${remade.from}) has no record of its own`);
  else if (s.kind === "booking" && snap?.rescheduledFrom) { const was = sh.starts.get(snap.rescheduledFrom); row.remarks.push(`the booking moved here from ${was ? local(was, tz).toFormat("LLL d, h:mm a") : "an earlier slot"} (that slot has its own record, logged rescheduled)`); }
  const held = s.kind === "booking" && !settled;   // only a call that could have been held has a show, money or a card to read
  if (held && snap?.status === "noshow") att.push({ value: "noshow", source: "Calendly", detail: "the host marked the invitee a no-show", rank: 2 });

  // ---- recordings the ladder linked to this booking (D22, D102), and what the AI read in them
  let notes: Record<string, unknown> | null = null;
  const recs = held ? await many<RecordingRow>(c, "select * from recordings where company_id=$1 and appointment_id=$2 and link_status='linked' and provider<>'ghl' order by started_at", [co.row.id, s.appt!.id]) : [];
  const salesRecs: RecordingRow[] = [];
  let transcript = "";
  for (const r of recs) {
    const text = await transcriptFor({ adapters, adapterCompany: co.adapterCompany, bindings: co.bindings }, r);
    const kind = await recordingKind(sh, r, text);
    const label = `${r.title ?? "recording"} at ${local(r.started_at, tz).toFormat("h:mm a")} (${r.duration_min ?? "?"} min, matched by ${r.linked_by ?? "?"})`;
    if (kind.value === "sales_call") { salesRecs.push(r); transcript += (transcript ? "\n\n" : "") + text; att.push({ value: "showed", source: "Fathom", detail: `${label}; Jev read it as a sales call (${pct(kind.confidence)})`, rank: 1 }); }
    else leanAtt.push({ value: "showed", source: "Fathom", detail: `${label}, but Jev did not read it as a sales call (${kind.value}, ${pct(kind.confidence)})`, rank: 4 });
  }
  if (salesRecs[0]?.share_url) { row.fields.recording_url = salesRecs[0].share_url; add("recording_url", "Fathom", `${salesRecs[0].title ?? "the recording"}`); }

  // ---- money: the person's payments after this call and before their next one (the engine's own close credit, D73)
  const pays = held ? await many<{ amount: string; status: string; kind: string | null; paid_at: Date; whop_payment_id: string; contract_value: string | null }>(c, `select p.amount::text, p.status, p.kind, p.paid_at, p.whop_payment_id, o.contract_value::text
    from payments p left join opportunities o on o.id=p.opportunity_id where p.company_id=$1 and p.contact_id=$2 and p.status in ('succeeded','refunded') and p.paid_at >= $3 and p.paid_at < $4 order by p.paid_at`, [co.row.id, s.contactId, start, until]) : [];
  const cash = pays.reduce((n, p) => n + Number(p.amount), 0);
  if (pays.length && cash > 0) {
    const first = pays[0], hours = (first.paid_at.getTime() - start.getTime()) / 36e5;
    const words = pays.map((p) => `$${Number(p.amount).toLocaleString("en-US")} ${p.status}${p.kind ? ` (${p.kind})` : ""} on ${local(p.paid_at, tz).toFormat("LLL d")} [${p.whop_payment_id}]`).join("; ");
    row.fields.cash_collected = cash; add("cash_collected", "payments ledger", words);
    // the ledger calls a first payment short of the deal's value a deposit; with no value known that says nothing, so it is a close
    const meaning = pays.filter((p) => p.status === "succeeded").every((p) => p.kind === "deposit" && p.contract_value != null) ? "deposit" : "closed";
    const key = keyFor(setup, meaning);
    if (key) disp.push({ value: key, source: "payments ledger", detail: `paid after this call and before any later one: ${words}`, rank: 1 });
    if (hours <= PAID_SHOWED_WITHIN_H) att.push({ value: "showed", source: "payments ledger", detail: `paid ${Math.round(hours)} h after the call`, rank: 3 });
    else leanAtt.push({ value: "showed", source: "payments ledger", detail: `paid ${Math.round(hours / 24)} days after the call, with no other call between`, rank: 5 });
  }
  const won = held ? await one<{ contract_value: string | null; won_at: Date }>(c, "select contract_value::text, won_at from opportunities where company_id=$1 and contact_id=$2 and status='won' and won_at >= $3 and won_at < $4 and contract_value > 0 order by won_at limit 1", [co.row.id, s.contactId, start, until]) : null;
  if (won?.contract_value) { row.fields.contract_value = Number(won.contract_value); add("contract_value", "won deal", `won ${local(won.won_at, tz).toFormat("LLL d")} at $${Number(won.contract_value).toLocaleString("en-US")}`); }

  // ---- the card: where it sits says something about the person's latest held call before it moved there
  const cards = setup.board ? (await memo(sh.cards, ghlId, () => adapters.read.openCards(co.adapterCompany, ghlId))).filter((x) => x.pipelineId === setup.board) : [];
  const card = cards.length === 1 ? cards[0] : null;
  if (cards.length > 1) row.remarks.push(`${cards.length} cards on the closer board: none is related`);
  if (card && held) {
    const stage = setup.stages.get(card.stageId), movedAt = card.stageChangedAt ? new Date(card.stageChangedAt) : null;
    const tied = !!movedAt && movedAt > start && !calls.some((x) => x.id !== s.appt?.id && x.status !== "cancelled" && x.starts_at > start && x.starts_at < movedAt);
    const files = stage ? STAGE_FILES[stage] : undefined, leans = stage ? STAGE_LEANS[stage] : undefined;
    const words = `card on ${stage?.replace(/_/g, " ") ?? "a stage the engine has no name for"} since ${movedAt ? local(movedAt, tz).toFormat("LLL d, h:mm a") : "an unknown time"}`;
    if (tied && files) { att.push({ value: files.attendance, source: "GHL card", detail: `${words}, after this call and before any later one`, rank: 3 }); if (files.disposition) { const k = keyFor(setup, files.disposition); if (k) disp.push({ value: k, source: "GHL card", detail: words, rank: 2 }); } }
    else if (files || leans) { const l = (files ?? leans)!; leanAtt.push({ value: l.attendance, source: "GHL card", detail: tied ? words : `${words} (not tied to this call alone)`, rank: 2, tied }); if (l.disposition) { const k = keyFor(setup, l.disposition); if (k) leanDisp.push({ value: k, source: "GHL card", detail: words, rank: 2, tied }); } }
    if (card.status === "won" && tied && !disp.some((d) => d.source === "payments ledger")) { const k = keyFor(setup, "closed"); if (k) disp.push({ value: k, source: "GHL card", detail: `card won ${movedAt ? local(movedAt, tz).toFormat("LLL d") : ""}`.trim(), rank: 2 }); }
  }

  // ---- what people wrote: the closer's end-of-day report for that day and notes on the contact around the call, read by Jev (never matched by words)
  const texts = held ? await textsAbout(sh, s, ghlId, nextStart) : null;
  let textAtt: Classified | null = null;
  if (texts?.text) {
    textAtt = await jev(sh, texts.state, texts.text, Object.keys(ATTENDANCE_WORDS), ATTENDANCE_WORDS, "According to the text, what happened on the call in question?");
    const v = NO_SHOW_WORD[textAtt.value];
    if (v) att.push({ value: v, source: texts.source, detail: `${texts.detail}; Jev: ${textAtt.value.replace("_", "-")} (${pct(textAtt.confidence)})`, rank: 4 });
    else if (textAtt.lean && NO_SHOW_WORD[textAtt.lean.value]) leanAtt.push({ value: NO_SHOW_WORD[textAtt.lean.value], source: texts.source, detail: `${texts.detail}; Jev leaned ${textAtt.lean.value.replace("_", "-")} (${pct(textAtt.lean.p)}) without being sure`, rank: 1 });
  }

  let outcome: Attendance | null = settled;
  if (!outcome) {
    const vals = [...new Set(att.map((f) => f.value))];
    if (vals.length === 1) { outcome = vals[0]; for (const f of att) add("outcome", f.source, f.detail); }
    else if (vals.length > 1) {
      const best = [...att].sort((a, b) => a.rank - b.rank)[0];
      row.unknown.push({ field: "outcome", likely: best.value, why: `the evidence disagrees: ${att.map((f) => `${f.source} says ${f.value} (${f.detail})`).join("; ")}` });
    } else {
      // the card, moved after this call and before any later one, is the outcome when nothing says otherwise (D115 addendum)
      const card = uncontested(leanAtt);
      if (card) { outcome = card; for (const f of leanAtt) add("outcome", f.source, `${f.detail}; nothing says otherwise`); }
      else row.unknown.push(likelyAttendance(sh, s, leanAtt, salesRecs.length));
    }
  }
  if (outcome) row.fields.outcome = outcomeKey(setup, outcome);

  // ---- how a held call ended
  if (outcome === "showed" || (!outcome && (disp.length || salesRecs.length))) {
    if (salesRecs.length && transcript) {
      const t = await jev(sh, "A recorded sales call between the team's closer and a prospect.", transcript, [...setup.dispositions.map((d) => d.key), "unclear"], dispositionCriteria(setup), "How did this sales call end?", 0.7, 0.85);
      if (t.value !== "unclear") disp.push({ value: t.value, source: "Fathom transcript", detail: `Jev: ${t.value} (${pct(t.confidence)})`, rank: 4 });
      else if (t.lean) leanDisp.push({ value: t.lean.value, source: "Fathom transcript", detail: `Jev leaned ${t.lean.value} (${pct(t.lean.p)}) without being sure`, rank: 3 });
    }
    if (texts?.text) {
      const t = await jev(sh, texts.state, texts.text, [...setup.dispositions.map((d) => d.key), "not_said"], { ...dispositionCriteria(setup), not_said: "The text does not say how the call in question ended, or what it says cannot be tied to that call." }, "According to the text, how did the call in question end?");
      if (t.value !== "not_said" && t.value !== "unclear") disp.push({ value: t.value, source: texts.source, detail: `${texts.detail}; Jev: ${t.value} (${pct(t.confidence)})`, rank: 3 });
      else if (t.lean && t.lean.value !== "not_said") leanDisp.push({ value: t.lean.value, source: texts.source, detail: `Jev leaned ${t.lean.value} (${pct(t.lean.p)}) without being sure`, rank: 1 });
    }
    const vals = [...new Set(disp.map((f) => f.value))];
    if (outcome === "showed" && vals.length === 1) { row.fields.disposition = vals[0]; for (const f of disp) add("disposition", f.source, f.detail); }
    else if (vals.length > 1) { const best = [...disp].sort((a, b) => a.rank - b.rank)[0]; row.unknown.push({ field: "disposition", likely: best.value, why: `the evidence disagrees: ${disp.map((f) => `${f.source} says ${f.value} (${f.detail})`).join("; ")}` }); }
    else if (vals.length === 1) row.unknown.push({ field: "disposition", likely: vals[0], why: `${disp.map((f) => `${f.source}: ${f.detail}`).join("; ")}; left blank while it is unknown whether the call was held` });
    else if (outcome === "showed" && uncontested(leanDisp)) { row.fields.disposition = uncontested(leanDisp)!; for (const f of leanDisp) add("disposition", f.source, `${f.detail}; nothing says otherwise`); }
    else {
      const lean = [...leanDisp].sort((a, b) => a.rank - b.rank)[0];
      row.unknown.push({ field: "disposition", likely: lean?.value ?? "can't tell", why: lean ? leanDisp.map((f) => `${f.source}: ${f.detail}`).join("; ") : salesRecs.length ? "the transcript does not show how it ended and nobody wrote it down" : "no recording, no end-of-day line and no note says how it ended" });
    }
  }

  // ---- what was said: objections and the next step, as Call recorded reads them (prompt.call_review)
  if (salesRecs.length && transcript) {
    notes = await callNotes(sh, salesRecs, transcript);
    if (notes) {
      const obj = String(notes.primary_objection ?? "").trim();
      const objOpts = setup.fields?.get("objection_primary")?.options?.map((o) => o.key);
      if (obj && (!objOpts || objOpts.includes(obj))) { row.fields.objection_primary = obj; add("objection_primary", "Fathom transcript", `the call review: ${obj}`); }
      else if (obj) row.unknown.push({ field: "objection_primary", likely: obj, why: "the call review named an objection the field has no option for" });
      const next = String(notes.next_step ?? "").trim(), nextDate = String(notes.next_step_date ?? "").trim();
      const nextOpts = setup.fields?.get("next_step")?.options;
      if (next && nextOpts?.length) {
        const words = Object.fromEntries(nextOpts.map((o) => [o.key, o.label ?? o.key.replace(/_/g, " ")]));
        const t = await jev(sh, "The agreed next step at the end of a sales call.", `${next}${nextDate ? ` (by ${nextDate})` : ""}`, [...nextOpts.map((o) => o.key), "none"], { ...words, none: "None of the others describes it." }, "Which of these is the next step?");
        if (t.value !== "none" && t.value !== "unclear") { row.fields.next_step = t.value; add("next_step", "Fathom transcript", `the call review: "${next}"; Jev: ${t.value} (${pct(t.confidence)})`); }
        else row.unknown.push({ field: "next_step", likely: t.lean?.value ?? "none of the options", why: `the call review says "${next}"` });
      } else if (next) { row.fields.next_step = next; add("next_step", "Fathom transcript", "the call review"); }
      const summary = String(notes.summary ?? "").trim();
      if (summary) { row.fields.notes = summary; add("notes", "Fathom transcript", "the call review's summary"); }
    } else row.remarks.push("the call review could not be read (no AI key, or it failed): objections and next step left out");
  }

  const d = sh.decide.get(s.key);
  if (d) for (const [f, v] of Object.entries(d.fields)) {
    row.fields[f] = v; row.unknown = row.unknown.filter((u) => u.field !== f);
    row.evidence[f] = [{ source: "operator decision", detail: d.why }, ...(row.evidence[f] ?? [])];
  }
  row.write = await writeFor(sh, s, row, link);
  return row;
}

/** The value of a card tied to this call when every other clue agrees with it. */
const uncontested = <T>(leans: Fact<T>[]): T | null => {
  const card = leans.find((f) => f.source === "GHL card" && f.tied);
  return card && leans.every((f) => f.value === card.value) ? card.value : null;
};

/** A decision names a call in the window and a value the field takes; a mistake stops the run before anything is read. */
function checkDecisions(setup: Setup, slots: Slot[], decide: SalesCallDecision[], exclude: SalesCallExclusion[]) {
  const keys = new Set(slots.map((x) => x.key)), bad: string[] = [];
  for (const d of decide) {
    if (!keys.has(d.slot)) bad.push(`${d.slot} is no call of this window`);
    if (!d.why?.trim()) bad.push(`the decision on ${d.slot} says no why`);
    for (const [f, v] of Object.entries(d.fields ?? {})) {
      const def = setup.fields?.get(f);
      if (setup.fields && !def) bad.push(`the Sales Call object has no ${f} field (${d.slot})`);
      else if (def?.options?.length && !def.options.some((o) => o.key === String(v))) bad.push(`${v} is no option of ${f} (${d.slot}): ${def.options.map((o) => o.key).join(", ")}`);
    }
  }
  if (new Set(decide.map((d) => d.slot)).size !== decide.length) bad.push("a call is decided twice");
  for (const x of exclude) if (!x.email?.trim() || !x.why?.trim()) bad.push("an exclusion needs an email and a why");
  if (bad.length) throw new Error(`decisions: ${bad.join("; ")}`);
}

const keyFor = (setup: Setup, meaning: string) => setup.dispositions.find((d) => d.meaning === meaning)?.key ?? null;
const outcomeKey = (setup: Setup, a: Attendance) => ({ showed: setup.outcomes.showed, noshow: setup.outcomes.noshow, cancelled: setup.outcomes.cancelled, rescheduled: setup.outcomes.rescheduled, scheduled: setup.outcomes.scheduled })[a] || a;
const dispositionCriteria = (setup: Setup) => Object.fromEntries(setup.dispositions.map((d) => [d.key, `${DISPOSITION_WORDS[d.meaning] ?? d.meaning}${d.reason ? ` In particular: ${d.reason}.` : ""}`]));

function likelyAttendance(sh: Shared, s: Slot, leans: Fact<Attendance>[], recorded: number): UnknownField {
  const clues = [...leans].sort((a, b) => a.rank - b.rank);
  const why = clues.map((f) => `${f.source}: ${f.detail}`);
  const cov = s.closer ? coverageOf(sh, s.closer) : null;
  let likely: string = clues[0]?.value ?? "";
  if (!clues.length) why.push("no end-of-day line, note or card says what happened");
  if (cov && s.startsAt >= cov.since && cov.calls) {
    why.push(`${s.closer!.name.split(" ")[0]} recorded ${cov.recorded} of the ${cov.calls} uncancelled calls she had from ${local(cov.since, sh.co.row.timezone).toFormat("LLL d")} on, and this one has no recording`);
    if (!likely && !recorded && cov.recorded / cov.calls >= 0.5) likely = "noshow";
  } else if (!recorded) why.push("no recording (the closer was not recording calls yet)");
  return { field: "outcome", likely: likely || "can't tell", why: why.join("; ") };
}

function coverageOf(sh: Shared, closer: Closer): { since: Date; recorded: number; calls: number } | null {
  return sh.coverage.get(closer.id) ?? null;
}

/** How often the closer recorded the calls she held once she started recording at all: a clue, never a fact (a missing recording alone is no no-show). */
export async function recordingCoverage(c: PoolClient, companyId: string, closer: { id: string; email: string }, to: Date, domains: string[] = []): Promise<{ since: Date; recorded: number; calls: number } | null> {
  // from the first call she recorded (its booked start: a recording begins a minute or two after it)
  const first = await one<{ at: Date | null }>(c, "select min(least(r.started_at, a.starts_at)) as at from recordings r join appointments a on a.id=r.appointment_id where r.company_id=$1 and lower(r.recorded_by_email)=lower($2) and r.provider<>'ghl'", [companyId, closer.email]);
  if (!first?.at) return null;
  const r = await one<{ calls: number; recorded: number }>(c, `select count(*)::int as calls, count(*) filter (where exists (select 1 from recordings r where r.appointment_id=a.id and r.provider<>'ghl'))::int as recorded
    from appointments a join company_terms t on t.id=a.appointment_term join contacts ct on ct.id=a.contact_id
    where a.company_id=$1 and a.assigned_user_id=$2 and t.category='closing' and a.status<>'cancelled' and a.starts_at >= $3 and a.starts_at <= least($4, now()) and not ${testContactSql("ct", "$5")}`, [companyId, closer.id, first.at, to, domains]);
  return { since: first.at, recorded: r?.recorded ?? 0, calls: r?.calls ?? 0 };
}

type Classified = { value: string; confidence: number; lean?: { value: string; p: number } };
async function jev(sh: Shared, state: string, input: string, options: string[], criteria: Record<string, string>, question: string, threshold = 0.75, ambiguityMax = 0.8): Promise<Classified> {
  const r = await sh.adapters.classifier.choice(state, input, options, threshold, { apiKey: sh.co.bindings["secret.jev_key"] || process.env.JEV_API_KEY, criteria, ambiguityMax, question });
  const top = Object.entries(r.distribution).sort((a, b) => b[1] - a[1])[0];
  return { value: r.unclear ? "unclear" : r.value, confidence: r.confidence, ...(r.unclear && top && top[1] > 0 ? { lean: { value: top[0], p: top[1] } } : {}) };
}

/** Call recorded's own question (its recording_kind step), answered once per recording: an earlier answer on the row is reused. */
async function recordingKind(sh: Shared, r: RecordingRow, text: string): Promise<{ value: string; confidence: number }> {
  const prior = (r.analysis?.classify as { kind?: { value?: string; confidence?: number } } | undefined)?.kind;
  if (prior?.value) return { value: prior.value, confidence: prior.confidence ?? 1 };
  if (!text.trim()) return { value: "no transcript", confidence: 0 };
  const n = sh.setup.kindNode;
  const options = (await many<{ value: string }>(sh.c, "select value from core_categories where domain='recording_kind' order by sort")).map((x) => x.value);
  const t = await jev(sh, "", text, options.length ? options : ["sales_call", "internal", "other"], n?.criteria ?? {}, n?.question ?? "What kind of recording is this?", n?.threshold ?? 0.8, n?.ambiguity_max ?? 0.8);
  return { value: t.value, confidence: t.confidence };
}

/** Call recorded's call review (prompt.call_review) of the call's transcript; an earlier review on the recording is reused. */
async function callNotes(sh: Shared, recs: RecordingRow[], transcript: string): Promise<Record<string, unknown> | null> {
  const prior = recs.map((r) => r.analysis?.notes).find((n) => n && typeof n === "object" && Object.keys(n as object).length) as Record<string, unknown> | undefined;
  if (prior) return prior;
  const key = sh.co.bindings["secret.anthropic_key"] || process.env.ANTHROPIC_API_KEY;
  const node = sh.setup.analyzeNode;
  if (!key || !node) return null;
  const prompts = Object.fromEntries(Object.entries(sh.co.bindings).filter(([k]) => k.startsWith("prompt.")).map(([k, v]) => [k.slice(7), v]));
  const system = render(node.prompt, { prompt: prompts }, { tz: sh.co.row.timezone }).trim();
  if (!system) return null;
  try {
    const r = await sh.adapters.analyst.analyze(key, { system, input: transcript, format: "json", maxTokens: node.max_tokens });
    const v = r.parsed as Record<string, unknown> | undefined;
    const n = v && typeof v.notes === "object" ? (v.notes as Record<string, unknown>) : v;
    return n && typeof n === "object" ? n : null;
  } catch { return null; }
}

/** The closer's end-of-day report for the call's day (a record naming the closer and dated that day) and the contact's notes around the call. */
async function textsAbout(sh: Shared, s: Slot, ghlId: string, nextStart: Date | null): Promise<{ text: string; state: string; source: string; detail: string } | null> {
  const tz = sh.co.row.timezone, day = local(s.startsAt, tz), date = day.toISODate()!;
  const names = s.closer ? [s.closer.name, s.closer.name.split(" ")[0], s.closer.email].map((x) => x.trim().toLowerCase()) : [];
  const flat = (v: unknown): string => v && typeof v === "object" && !Array.isArray(v) && "value" in (v as object) ? String((v as { value: unknown }).value) : Array.isArray(v) ? v.join(", ") : String(v ?? "");
  const eod = sh.eods.filter((r) => Object.values(r.properties).some((v) => String(v).slice(0, 10) === date) && Object.values(r.properties).some((v) => typeof v === "string" && names.includes(v.trim().toLowerCase())));
  const parts: string[] = [], sources: string[] = [], details: string[] = [];
  for (const r of eod) {
    parts.push(`The closer's end-of-day report for ${day.toFormat("cccc LLL d")}:\n${Object.entries(r.properties).map(([k, v]) => `${k.replace(/_/g, " ")}: ${flat(v)}`).join("\n")}`);
    sources.push("end-of-day report");
    const said = Object.entries(r.properties).filter(([, v]) => typeof v === "string" && v.length > 3 && !names.includes(v.trim().toLowerCase()) && !/^\d{4}-\d{2}-\d{2}/.test(v)).map(([, v]) => String(v).replace(/\s+/g, " ").trim());
    details.push(`${s.closer?.name.split(" ")[0] ?? "the closer"}'s end of day for ${date}${said.length ? `: "${said.join(" / ").slice(0, 160)}"` : ""}`);
  }
  if (sh.adapters.read.contactNotes) {
    const from = s.startsAt.getTime() - NOTES_BEFORE_H * 36e5, to = Math.min(nextStart?.getTime() ?? Infinity, s.startsAt.getTime() + NOTES_AFTER_D * 864e5);
    const notes = (await memo(sh.notes, ghlId, () => sh.adapters.read.contactNotes!(sh.co.adapterCompany, ghlId))).filter((n) => { const t = Date.parse(n.dateAdded); return t >= from && t <= to; });
    for (const n of notes) { parts.push(`A note on the contact, written ${local(n.dateAdded, tz).toFormat("LLL d, h:mm a")}:\n${n.body.replace(/<[^>]+>/g, " ").slice(0, 4000)}`); }
    if (notes.length) { sources.push("GHL notes"); details.push(`${notes.length} note${notes.length > 1 ? "s" : ""} on the contact from ${notes.map((n) => local(n.dateAdded, tz).toFormat("LLL d h:mm a")).join(", ")}`); }
  }
  if (!parts.length) return null;
  const same = (sh.daySlots.get(`${s.closer?.id ?? ""}:${date}`) ?? []).filter((x) => x !== s);
  const say = (x: Slot) => `${local(x.startsAt, tz).toFormat("h:mm a")}, ${x.termName || x.calendar}${x.kind === "left_slot" ? " (moved to another time at the booking source)" : x.snap?.status === "cancelled" ? " (cancelled at the booking source)" : ""}`;
  const state = `The call in question: ${say(s)} on ${day.toFormat("cccc LLL d")}, with the closer ${s.closer?.name ?? "unknown"}.` + (same.length ? ` The closer's other calls that day: ${same.map(say).join("; ")}.` : " It was the closer's only call that day.");
  return { text: parts.join("\n\n"), state, source: sources.join(" + "), detail: details.join("; ") };
}

/** The record as Call booked writes it (its own step, rendered), with the evidenced fields over it; a property the object lacks is left out. */
async function writeFor(sh: Shared, s: Slot, row: SalesCallRow, link: SalesCallWrite["link_contact"]): Promise<SalesCallWrite> {
  const { c, co, setup } = sh, tz = co.row.timezone;
  const run = { id: "00000000-0000-0000-0000-000000000000", company_id: co.row.id, contact_id: s.contactId, appointment_id: s.appt?.id ?? null, opportunity_id: null, context: { vars: {}, event: {} }, started_at: new Date() } as unknown as RunRow;
  const ctx = await buildContext(c, run, co.row, co.bindings);
  if (ctx.contact && row.contact.ghl_contact_id) (ctx.contact as Record<string, unknown>).ghl_contact_id = row.contact.ghl_contact_id;
  if (s.kind === "left_slot" || !ctx.appointment) {
    const closer = s.closer ? { first_name: s.closer.name.split(" ")[0], name: s.closer.name, email: s.closer.email, ghl_user_id: s.closer.ghl_user_id } : undefined;
    ctx.appointment = { slot_key: s.key, external_id: s.key, starts_at: s.startsAt.toISOString(), set_by: s.snap?.setBy ?? null, self_booked: s.selfBooked, term: { name: s.termName, category: "closing" }, closer };
  }
  const cards = setup.board && row.contact.ghl_contact_id ? (await memo(sh.cards, row.contact.ghl_contact_id, () => sh.adapters.read.openCards(co.adapterCompany, row.contact.ghl_contact_id!))).filter((x) => x.pipelineId === setup.board) : [];
  (ctx.cards as Record<string, unknown>).closer = cards.length === 1 ? { id: cards[0].id, stage: cards[0].stageId, name: cards[0].name } : undefined;
  const appt = ctx.appointment as { self_booked?: boolean | null };
  const self = appt.self_booked ?? s.selfBooked;
  ctx.vars = { booking_source: self === true ? setup.sources.self : self === false ? setup.sources.setter : "" };
  const env = { tz, companyTz: tz };
  if (setup.callType) {
    // the step's own rule, as the executor's set_var applies it
    const n = setup.callType, chosen = (raw: unknown) => (typeof raw === "string" ? render(raw, ctx, env) : raw);
    let v: unknown;
    if (n.pick) { const k = String(chosen(n.value) ?? ""); v = chosen(k in n.pick ? n.pick[k] : n.else_value); }
    else v = chosen(n.when && !evaluate(n.when, ctx) ? n.else_value : n.value);
    (ctx.vars as Record<string, unknown>).call_type = v;
  }
  const props: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(setup.k4.properties)) { if (k === "outcome") continue; const r = render(v, ctx, env); if (r.trim()) props[k] = r; }
  for (const [k, v] of Object.entries(row.fields)) props[k] = String(v);
  const known = setup.fields, out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(props)) { if (known && !known.has(k)) { if (row.fields[k] !== undefined) row.remarks.push(`the Sales Call object has no ${k} field: left out`); continue; } out[k] = propertyValue(k, String(v), known?.get(k)?.type); }
  // what Call booked's own step says about the call, as evidence for the fields it fills
  const said = (k: string, source: string, detail: string) => { if (out[k] !== undefined && !(k in row.fields)) { row.fields[k] = out[k] as string; (row.evidence[k] ??= []).push({ source, detail }); } };
  said("closer", "booking source", `the host of the booking, ${s.closer?.email ?? "?"}`);
  said("call_type", "calendar", `booked on ${s.calendar}`);
  said("booking_source", "calendar", self === true ? `${s.calendar} is a self-booking calendar` : `${s.calendar} is a setter's calendar`);
  said("setter", "booking answer", "the setter named on the booking");
  if (self == null && setup.sources.self) row.unknown.push({ field: "booking_source", likely: "can't tell", why: "the calendar does not say whether a setter or the person booked it" });
  const relate = setup.k4.relate.map((r) => { const rc = { ...ctx, record: { id: RECORD_ID } }; return { association: render(r.association, rc, env), first: render(r.first, rc, env), second: render(r.second, rc, env) }; }).filter((r) => r.association && r.first && r.second);
  const meaning = (a: unknown) => (a === undefined ? null : Object.entries({ showed: setup.outcomes.showed, noshow: setup.outcomes.noshow, cancelled: setup.outcomes.cancelled, rescheduled: setup.outcomes.rescheduled }).find(([, k]) => k === a)?.[0] ?? null);
  const dispMeaning = row.fields.disposition !== undefined ? setup.dispositions.find((d) => d.key === row.fields.disposition)?.meaning ?? null : null;
  return { object: setup.objectKey, key: s.key, properties: out, relate, ledger: { appointment_id: s.kind === "booking" ? s.appt!.id : null, outcome: meaning(row.fields.outcome), call_outcome: dispMeaning }, link_contact: link };
}

/**
 * The writes, one call at a time, each on its own: a record keyed by the slot (ours, else one the CRM already holds with that
 * external id, so a re-run or an interrupted run never makes a second), only into fields the CRM has blank or already equal (a
 * value someone filed stays), related to the person and their card, kept in crm_records so later workflows update the same
 * record; the ledger's outcome only where the engine has none. Nothing is emitted. The days are rolled up after.
 */
async function applyRows(c: PoolClient, co: LoadedCompany, adapters: Adapters, rows: SalesCallRow[], objectKey: string, existing: Map<string, ObjectRecord>, window: { from: Date; to: Date }): Promise<void> {
  for (const row of rows) {
    const w = row.write; if (!w || row.skipped || row.error) continue;
    try {
      if (w.link_contact) {
        const live = await adapters.read.getContact(co.adapterCompany, w.link_contact.ghl_contact_id);
        if (live) await upsertContact(c, co.row.id, co.row.timezone, live, boundFieldIds(co.bindings));
      }
      const ours = await one<{ ghl_record_id: string | null }>(c, "select ghl_record_id from crm_records where company_id=$1 and object_key=$2 and record_key=$3", [co.row.id, w.object, w.key]);
      const inCrm = existing.get(w.key);
      let crmId = ours?.ghl_record_id ?? inCrm?.id ?? null;
      const kept: string[] = [], props = { ...w.properties };
      if (inCrm) for (const [k, v] of Object.entries(props)) {
        const cur = inCrm.properties[k], blank = cur === undefined || cur === null || cur === "" || (Array.isArray(cur) && !cur.length);
        if (!blank && JSON.stringify(cur) !== JSON.stringify(v) && String((cur as { value?: unknown })?.value ?? cur) !== String(v)) { kept.push(`${k} (GHL has ${JSON.stringify(cur)})`); delete props[k]; }
      }
      let record: "created" | "updated";
      if (crmId) { if (Object.keys(props).length) await adapters.write.updateRecord(co.adapterCompany, w.object, crmId, props); record = "updated"; }
      else { crmId = (await adapters.write.createRecord(co.adapterCompany, w.object, props)).id; record = "created"; existing.set(w.key, { id: crmId, createdAt: new Date().toISOString(), properties: props }); }
      const related: string[] = [];
      for (const r of w.relate) { const first = r.first === RECORD_ID ? crmId : r.first, second = r.second === RECORD_ID ? crmId : r.second; await adapters.write.relateRecords(co.adapterCompany, r.association, first, second); related.push(`${first}→${second}`); }
      await c.query(`insert into crm_records (company_id, object_key, record_key, ghl_record_id, contact_id, properties) values ($1,$2,$3,$4,$5,$6)
        on conflict (company_id, object_key, record_key) do update set ghl_record_id=coalesce(crm_records.ghl_record_id, excluded.ghl_record_id), properties=crm_records.properties || excluded.properties, updated_at=now()`,
        [co.row.id, w.object, w.key, crmId, row.contact.id, props]);
      const ledger: string[] = [];
      if (w.ledger.appointment_id) {
        const a = await one<{ outcome_term: string | null; call_outcome_term: string | null }>(c, "select outcome_term, call_outcome_term from appointments where id=$1 and company_id=$2", [w.ledger.appointment_id, co.row.id]);
        if (a && w.ledger.outcome && !a.outcome_term) {
          const term = await outcomeTermFor(c, co.row.id, w.ledger.outcome);
          if (term) { await c.query("update appointments set outcome_term=$2, status=case when $3 in ('showed','noshow') then $3 else status end where id=$1", [w.ledger.appointment_id, term, w.ledger.outcome]); ledger.push(`outcome ${w.ledger.outcome}`); }
        } else if (a?.outcome_term && w.ledger.outcome) ledger.push("outcome already in the ledger: kept");
        if (a && w.ledger.call_outcome && !a.call_outcome_term) {
          const t = await one<{ id: string }>(c, "select id from company_terms where company_id=$1 and domain='call_outcome' and category=$2 and active order by is_default desc, sort limit 1", [co.row.id, w.ledger.call_outcome]);
          if (t) { await c.query("update appointments set call_outcome_term=$2 where id=$1", [w.ledger.appointment_id, t.id]); ledger.push(`call outcome ${w.ledger.call_outcome}`); }
        }
      }
      row.written = { record, crm_id: crmId, related, ledger, kept };
    } catch (e) { row.error = String((e as Error).message).slice(0, 300); }
  }
  const tz = co.row.timezone;
  await rollupRange(c, co.row.id, DateTime.fromJSDate(window.from).setZone(tz).toISODate()!, DateTime.fromJSDate(window.to).setZone(tz).toISODate()!, tz);
  await c.query("insert into audit_log (company_id, action, target_type, target_id, after) values ($1::uuid,'sales_calls.backfilled','company',$1::text,$2)", [co.row.id, { object: objectKey, from: window.from, to: window.to, summary: summarize(rows) }]);
}
