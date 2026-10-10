import { DateTime } from "luxon";
import type { PoolClient } from "pg";
import { many } from "@/db/client";
import type { Company } from "@/adapters/types";
import type { GhlReads } from "@/adapters/ghl/metrics";
import { isTestContact, testContactSql } from "./mode";
import { MetricError, type GroupBy } from "./metric-registry";

/**
 * D73: people and deals are read from GHL at answer time ("Always GHL. It's the truth."). Leads are contacts by the CRM's
 * dateAdded; MQL / DQ is the answer to the company's work-situation field; closes are distinct people with a won card on
 * the Closer pipeline; calls and shows are the company's Sales Call records (one per booking, outcome filed from the EOD
 * form). The ledger only lends what GHL does not hold: the closer of a person's latest call, the UTM source of their latest
 * booking, and the booking source's own word that a call was cancelled before it started (which wins over the record, and
 * is shown as a mismatch to fix in GHL). A CRM that cannot be read is an error naming its status, never the replica's guess.
 */
export const GHL_SOURCE = "GHL, read just now";
export type GhlEntity = "lead" | "close" | "call";
export type CallClass = "showed" | "noshow" | "cancelled" | "rescheduled";
export const CALL_CLASSES: CallClass[] = ["showed", "noshow", "cancelled", "rescheduled"];
export type SalesCallConfig = { object: string; outcomes: Record<string, CallClass>; cancelledValue: string | null; dqDispositions: string[] };
export type CallMismatch = { name: string; ghl_contact_id: string; record_id: string; ghl: CallClass; booking_source: string };
export type ShowBreakdown = { booked: number; showed: number; noshow: number; cancelled: number; rescheduled: number; missing: number; missing_names: string[]; mismatches: CallMismatch[] };
export type Qualification = "mql" | "dq" | "unanswered" | "unrecognized";
export type QualifyConfig = { field: string; mql: string[]; dq: string[]; unansweredIsMql: boolean };
export type QualificationSummary = { mql: number; dq: number; unanswered: number; unrecognized: number; unrecognized_answers: string[]; unanswered_is_mql: boolean };

const norm = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();
/** An answer list as bound: a JSON array (what install writes), else one answer per line. */
export function answerList(v: string | undefined): string[] {
  if (!v?.trim()) return [];
  try { const j = JSON.parse(v); if (Array.isArray(j)) return j.map(String).map((s) => s.trim()).filter(Boolean); } catch { /* one per line */ }
  return v.split("\n").map((s) => s.trim()).filter(Boolean);
}
export function qualifyConfig(bindings: Record<string, string>): QualifyConfig | null {
  const field = bindings["crm.field_contact_work_situation"];
  if (!field) return null;
  return { field, mql: answerList(bindings["qualify.mql_answers"]), dq: answerList(bindings["qualify.dq_answers"]), unansweredIsMql: /^(true|yes|1)$/i.test(bindings["qualify.unanswered_is_mql"] ?? "") };
}
/**
 * The Sales Call object and what its values mean: `crm.object_sales_call`; `sales_call.outcomes` as JSON {value: showed |
 * noshow | cancelled | rescheduled} (values not in the map, and blanks, are not filed); `sales_call.dq_dispositions` as a JSON
 * list of the `disposition` values that are a sales DQ. The value written when a repair cancels a record is the map's
 * "cancelled" key when it has one, else its first cancelled value.
 */
export function salesCallConfig(bindings: Record<string, string>): SalesCallConfig | null {
  const object = bindings["crm.object_sales_call"];
  if (!object) return null;
  let map: Record<string, unknown> = {};
  try { map = JSON.parse(bindings["sales_call.outcomes"] ?? "{}") as Record<string, unknown>; } catch { map = {}; }
  const valid = Object.entries(map).filter(([, v]) => CALL_CLASSES.includes(v as CallClass)) as [string, CallClass][];
  const cancels = valid.filter(([, v]) => v === "cancelled").map(([k]) => k);
  return { object, outcomes: Object.fromEntries(valid.map(([k, v]) => [norm(k), v])), cancelledValue: cancels.find((k) => norm(k) === "cancelled") ?? cancels[0] ?? null,
    dqDispositions: answerList(bindings["sales_call.dq_dispositions"]).map(norm) };
}
export const filedClass = (outcome: unknown, cfg: SalesCallConfig): CallClass | null => cfg.outcomes[norm(answerText(outcome))] ?? null;
/**
 * A Sales Call's class: its filed outcome, except that a booking the source cancelled BEFORE the call's start is cancelled
 * whatever was filed (the owner's rule; `flipped` when that overrode a filed outcome). Cancelled after the start (a host
 * clearing the slot after a no-show), the filed outcome stands. A cancel whose time is unknown decides nothing.
 */
export function classifyCall(filed: CallClass | null, booking?: { status: string; cancelledAt: Date | null; startsAt: Date } | null): { cls: CallClass | "missing"; flipped: boolean; cancelUnknown: boolean } {
  if (booking?.status === "cancelled" && filed !== "cancelled") {
    if (!booking.cancelledAt) return { cls: filed ?? "missing", flipped: false, cancelUnknown: true };
    if (booking.cancelledAt.getTime() < booking.startsAt.getTime()) return { cls: "cancelled", flipped: filed !== null, cancelUnknown: false };
  }
  return { cls: filed ?? "missing", flipped: false, cancelUnknown: false };
}
const answerText = (v: unknown) => (Array.isArray(v) ? v.map(String).join(", ") : v === null || v === undefined ? "" : String(v)).trim();
/** The form's options are fixed, so the match is exact (trimmed, any case); anything else is unrecognized and never counted as qualifying. */
export function qualify(value: unknown, cfg: QualifyConfig): Qualification {
  const a = norm(answerText(value));
  if (!a) return "unanswered";
  if (cfg.dq.some((x) => norm(x) === a)) return "dq";
  if (cfg.mql.some((x) => norm(x) === a)) return "mql";
  return "unrecognized";
}

type Person = { ghl: string; name: string; at: DateTime; answer: string; q: Qualification | null; ownSource?: string };
type Close = { ghl: string; name: string; at: DateTime; value: number; assignedTo?: string; closer: string; utm: string | null };
/** A due Sales Call with the ledger appointment it matched one-to-one (by external id, else by the person and the start minute), if any. */
export type SalesCall = { id: string; ext: string; ghl: string; name: string; test: boolean; at: DateTime; filed: CallClass | null; disposition: string; cls: CallClass | "missing"; flipped: boolean; cancelUnknown: boolean;
  match: "one" | "none" | "many"; appt: { id: string; contact_id: string; status: string; source: string; outcome: string | null; starts_at: Date; cancelled_at: Date | null } | null; closer: string; utm: string | null; booking_source: string };
type Call = SalesCall;
export type GhlCtx = {
  c: PoolClient; companyId: string; ac: Company; bindings: Record<string, string>; reads: GhlReads; tz: string; start: Date; end: Date; now: Date;
  sourceField: string; domains: string[]; filters: { closer?: string; setter?: string; source?: string };
  memo: { leads?: Promise<{ people: Person[]; utm: Map<string, string | null> }>; closes?: Promise<Close[]>; calls?: Promise<Call[]>; sources: Map<string, string> };
};

async function read<T>(what: string, f: () => Promise<T>): Promise<T> {
  try { return await f(); }
  catch (e) {
    const status = (e as { status?: number }).status;
    throw new MetricError(`GHL could not be read (${what}${status ? `, ${status}` : ""}): ${String((e as Error).message).slice(0, 200)}`);
  }
}
const connected = (x: GhlCtx) => { if (!x.ac.pit || !x.ac.locationId) throw new MetricError("GHL is not connected for this company (no token or location bound), so people and deals cannot be read"); };

/** What the ledger knows about CRM ids: the latest booking's UTM source, the closer of the latest call, and whether any engine record behind the id is a test contact. */
async function ledgerFacts(x: GhlCtx, ids: string[]): Promise<Map<string, { utm: string | null; closer: string | null; test: boolean }>> {
  if (!ids.length) return new Map();
  const mine = "sa.contact_id in (select ct.id from contacts ct where ct.company_id=$1 and (ct.ghl_contact_id=x.ghl or ct.id in (select i.contact_id from contact_identifiers i where i.company_id=$1 and i.kind='ghl_contact' and i.value=x.ghl)))";
  const rows = await many<{ ghl: string; utm: string | null; closer: string | null; test: boolean }>(x.c, `select x.ghl,
      (select nullif(sa.tracking->>'utm_source','') from appointments sa where sa.company_id=$1 and sa.source<>'test' and coalesce(sa.tracking->>'utm_source','')<>'' and ${mine} order by sa.booked_at desc limit 1) as utm,
      (select sa.assigned_user_id::text from appointments sa where sa.company_id=$1 and sa.source<>'test' and ${mine} order by sa.starts_at desc limit 1) as closer,
      exists (select 1 from contacts ct where ct.company_id=$1 and (ct.ghl_contact_id=x.ghl or ct.id in (select i.contact_id from contact_identifiers i where i.company_id=$1 and i.kind='ghl_contact' and i.value=x.ghl)) and ${testContactSql("ct", "$3")}) as test
    from unnest($2::text[]) as x(ghl)`, [x.companyId, ids, x.domains]);
  return new Map(rows.map((r) => [r.ghl, { utm: r.utm, closer: r.closer, test: r.test }]));
}

async function leads(x: GhlCtx) {
  connected(x);
  return (x.memo.leads ??= (async () => {
    const cfg = qualifyConfig(x.bindings);
    const raw = await read("contacts", () => x.reads.contactsAdded(x.ac, x.start, new Date(x.end.getTime() - 1)));
    const inWindow = raw.filter((k) => { const t = Date.parse(k.dateAdded); return t >= x.start.getTime() && t < x.end.getTime(); });
    const facts = await ledgerFacts(x, inWindow.map((k) => k.id));
    const people = inWindow.filter((k) => !isTestContact({ tags: k.tags, emails: [k.email] }, x.domains) && !facts.get(k.id)?.test).map((k): Person => ({
      ghl: k.id, name: `${k.firstName ?? ""} ${k.lastName ?? ""}`.trim() || k.email || k.id, at: DateTime.fromISO(k.dateAdded).setZone(x.tz),
      answer: cfg ? answerText(k.customFields[cfg.field]) : "", q: cfg ? qualify(k.customFields[cfg.field], cfg) : null, ownSource: x.sourceField ? answerText(k.customFields[x.sourceField]) || undefined : undefined }));
    return { people, utm: new Map([...facts].map(([k, v]) => [k, v.utm])) };
  })());
}

async function closes(x: GhlCtx): Promise<Close[]> {
  connected(x);
  return (x.memo.closes ??= (async () => {
    const pipeline = x.bindings["crm.pipeline_closer"];
    if (!pipeline) throw new MetricError("closes are counted on the Closer pipeline, and none is bound (crm.pipeline_closer)");
    const cards = (await read("won deals", () => x.reads.wonCards(x.ac, pipeline))).filter((k) => {
      const t = Date.parse(k.wonAt);
      return k.status === "won" && k.pipelineId === pipeline && !!k.contactId && t >= x.start.getTime() && t < x.end.getTime() && !isTestContact({ tags: k.contactTags, emails: [k.contactEmail] }, x.domains);
    });
    const facts = await ledgerFacts(x, [...new Set(cards.map((k) => k.contactId))]);
    const users = new Map((await many<{ id: string; ghl_user_id: string }>(x.c, "select id::text as id, ghl_user_id from users where company_id=$1 and ghl_user_id is not null", [x.companyId])).map((u) => [u.ghl_user_id, u.id]));
    const by = new Map<string, Close>();
    // a person with two won cards is one close; their value is every won card's
    for (const k of cards.sort((a, b) => Date.parse(a.wonAt) - Date.parse(b.wonAt))) {
      if (facts.get(k.contactId)?.test) continue;
      const prev = by.get(k.contactId);
      const f = facts.get(k.contactId);
      by.set(k.contactId, { ghl: k.contactId, name: k.contactName || k.contactId, at: DateTime.fromISO(k.wonAt).setZone(x.tz), value: (prev?.value ?? 0) + (k.monetaryValue ?? 0), assignedTo: k.assignedTo,
        closer: f?.closer ?? (k.assignedTo ? users.get(k.assignedTo) : undefined) ?? "", utm: f?.utm ?? null });
    }
    return [...by.values()];
  })());
}

/** A person's source: the lead-source field on their GHL contact (read live), else their latest booking's UTM, else unknown. */
async function sourcesOf(x: GhlCtx, list: { ghl: string; utm: string | null }[]): Promise<Map<string, string>> {
  for (const k of list) {
    if (x.memo.sources.has(k.ghl)) continue;
    const own = x.sourceField && k.ghl ? await read("a contact's lead source", () => x.reads.getContact(x.ac, k.ghl)).then((ct) => (ct ? answerText(ct.customFields[x.sourceField]) : "")) : "";
    x.memo.sources.set(k.ghl, own || k.utm || "unknown");
  }
  return x.memo.sources;
}

/**
 * The period's Sales Call records whose scheduled time has passed (a record with only a call_date counts once that day is
 * over), harness bookings out and test contacts flagged (no number counts them; the repair still mends them), each classified. A record is tied to a ledger appointment only one-to-one:
 * the same external id, else the same person (GHL contact id) starting the same minute; none or several, it stands on its
 * own outcome. Closer: the record's closer name on the roster, else the name as written.
 */
/**
 * A Sales Call's start: an ISO stamp, or the display text an outside integration writes ("Mon Oct 5 · 10:00 AM EDT") read
 * on the record's call_date in the company's zone, trusted only when its zone abbreviation is the company zone's on that
 * day. Null when neither holds: the record then matches by person and day.
 */
export function callTime(v: unknown, day: DateTime | null, tz: string): DateTime | null {
  const s = String(v ?? "").trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) { const d = DateTime.fromISO(s); return d.isValid ? d.setZone(tz) : null; }
  const m = /(\d{1,2}):(\d{2})\s*([AP]M)\s*([A-Z]{2,5})?\s*$/i.exec(s);
  if (!m || !day) return null;
  const h = (Number(m[1]) % 12) + (m[3].toUpperCase() === "PM" ? 12 : 0);
  const at = day.set({ hour: h, minute: Number(m[2]), second: 0, millisecond: 0 });
  return !m[4] || at.toFormat("ZZZZ").toUpperCase() === m[4].toUpperCase() ? at : null;
}

async function calls(x: GhlCtx): Promise<Call[]> {
  connected(x);
  return (x.memo.calls ??= (async () => {
    const cfg = salesCallConfig(x.bindings);
    if (!cfg) throw new MetricError("calls and shows are read from the Sales Call records in GHL, and no object is bound (crm.object_sales_call)");
    if (!Object.keys(cfg.outcomes).length) throw new MetricError("the Sales Call outcomes are not mapped (sales_call.outcomes), so a show cannot be told from a no-show");
    const recs = await read("Sales Call records", () => x.reads.objectRecords(x.ac, cfg.object));
    const due = recs.flatMap((r) => {
      const p = r.properties, day = /^\d{4}-\d{2}-\d{2}$/.test(String(p.call_date ?? "")) ? DateTime.fromISO(String(p.call_date), { zone: x.tz }) : null;
      const sched = callTime(p.scheduled_at, day, x.tz);
      const at = sched ?? day;
      if (!at) return [];
      const passed = sched ? sched.toMillis() < x.now.getTime() : day!.plus({ days: 1 }).toMillis() <= x.now.getTime();
      return at.toMillis() >= x.start.getTime() && at.toMillis() < x.end.getTime() && passed ? [{ r, at, exact: !!sched }] : [];
    });
    type Hit = { rid: string; by_ext: boolean; id: string; contact_id: string; status: string; source: string; outcome: string | null; starts_at: Date; cancelled_at: Date | null; name: string | null; test: boolean };
    // the cancel time: the earliest of the source's own update stamp and the poll's status change to cancelled, both at or after it
    const hits = due.length ? await many<Hit>(x.c, `select x.rid, a.external_id = x.ext as by_ext, a.id::text as id, a.contact_id::text as contact_id, a.status, a.source, ot.category as outcome, a.starts_at,
        case when a.status='cancelled' then least(a.source_updated_at, (select min(e.occurred_at) from events e where e.company_id=a.company_id and e.appointment_id=a.id and e.event_type='appointment.status_changed' and e.data->'status'->>'to'='cancelled')) end as cancelled_at,
        nullif(trim(coalesce(ct.first_name,'')||' '||coalesce(ct.last_name,'')),'') as name, ${testContactSql("ct", "$6")} as test
      from unnest($2::text[], $3::text[], $4::text[], $5::timestamptz[], $8::text[]) as x(rid, ext, ghl, at, day)
      join appointments a on a.company_id=$1 and (a.external_id = x.ext or ((case when x.at is not null then date_trunc('minute', a.starts_at) = date_trunc('minute', x.at) else (a.starts_at at time zone $7)::date = x.day::date end)
        and a.contact_id in (select ct2.id from contacts ct2 where ct2.company_id=$1 and (ct2.ghl_contact_id=x.ghl or ct2.id in (select i.contact_id from contact_identifiers i where i.company_id=$1 and i.kind='ghl_contact' and i.value=x.ghl)))))
      join contacts ct on ct.id=a.contact_id left join company_terms ot on ot.id=a.outcome_term`,
      [x.companyId, due.map((d) => d.r.id), due.map((d) => String(d.r.properties.external_id ?? "")), due.map((d) => String(d.r.properties.contact_id ?? "")), due.map((d) => (d.exact ? d.at.toJSDate() : null)), x.domains, x.tz, due.map((d) => d.at.toISODate())]) : [];
    const facts = await ledgerFacts(x, [...new Set(due.map((d) => String(d.r.properties.contact_id ?? "")).filter(Boolean))]);
    const roster = await many<{ id: string; name: string }>(x.c, "select id::text as id, name from users where company_id=$1", [x.companyId]);
    const closerOf = (n: string) => { const w = n.trim().toLowerCase(); if (!w) return ""; const hit = roster.filter((u) => u.name.toLowerCase() === w); return hit.length === 1 ? hit[0].id : n.trim(); };
    const out: Call[] = [];
    for (const { r, at } of due) {
      const p = r.properties, ghlId = String(p.contact_id ?? "");
      const mine = hits.filter((h) => h.rid === r.id), byExt = mine.filter((h) => h.by_ext), cand = byExt.length ? byExt : mine;
      if (cand.some((h) => h.source === "test")) continue;
      const a = cand.length === 1 ? cand[0] : null;
      const filed = filedClass(p.outcome, cfg);
      const { cls, flipped, cancelUnknown } = classifyCall(filed, a ? { status: a.status, cancelledAt: a.cancelled_at, startsAt: a.starts_at } : null);
      out.push({ id: r.id, ext: String(p.external_id ?? ""), ghl: ghlId, test: cand.some((h) => h.test) || !!facts.get(ghlId)?.test, name: a?.name ?? (String(p.display_label ?? "").trim() || ghlId || r.id), at, filed, disposition: norm(answerText(p.disposition)), cls, flipped, cancelUnknown,
        match: cand.length === 1 ? "one" : cand.length ? "many" : "none", appt: a ? { id: a.id, contact_id: a.contact_id, status: a.status, source: a.source, outcome: a.outcome, starts_at: a.starts_at, cancelled_at: a.cancelled_at } : null,
        closer: closerOf(String(p.closer ?? "")), utm: facts.get(ghlId)?.utm ?? null, booking_source: a?.source === "calendly" ? "Calendly" : "the GHL calendar" });
    }
    return out.sort((a, b) => a.at.toMillis() - b.at.toMillis());
  })());
}

const counted = async (x: GhlCtx) => (await calls(x)).filter((k) => !k.test);
const mismatchOf = (k: Call): CallMismatch | null => (k.flipped && k.filed ? { name: k.name, ghl_contact_id: k.ghl, record_id: k.id, ghl: k.filed, booking_source: k.booking_source } : null);

/** The show-rate breakdown the answer carries: every due call by class, the names nobody filed, and the mismatches to fix in GHL. */
export async function showBreakdown(x: GhlCtx): Promise<ShowBreakdown> {
  const list = (await counted(x)).filter((k) => !x.filters.closer || k.closer === x.filters.closer);
  const pool = x.filters.source ? await (async () => { const s = await sourcesOf(x, list); return list.filter((k) => (s.get(k.ghl) ?? "unknown").toLowerCase() === x.filters.source!.toLowerCase()); })() : list;
  const n = (c: Call["cls"]) => pool.filter((k) => k.cls === c).length;
  return { booked: pool.length, showed: n("showed"), noshow: n("noshow"), cancelled: n("cancelled"), rescheduled: n("rescheduled"), missing: n("missing"),
    missing_names: pool.filter((k) => k.cls === "missing").map((k) => k.name), mismatches: pool.flatMap((k) => { const m = mismatchOf(k); return m ? [m] : []; }) };
}

/** For the health sweep's repair: every due Sales Call in a window, classified and matched. */
export async function salesCallsFor(x: Omit<GhlCtx, "filters" | "memo">): Promise<SalesCall[]> {
  return calls({ ...x, filters: {}, memo: { sources: new Map() } });
}

/** The closes of a period, newest first: who, credited to whom, when won (the /closes list). */
export async function closesFor(x: GhlCtx): Promise<{ ghl: string; name: string; closer: string; at: DateTime; value: number }[]> {
  return (await closes(x)).filter((k) => !x.filters.closer || k.closer === x.filters.closer).sort((a, b) => b.at.toMillis() - a.at.toMillis()).map((k) => ({ ghl: k.ghl, name: k.name, closer: k.closer, at: k.at, value: k.value }));
}

const timeKey = (g: GroupBy, at: DateTime) => (g === "day" ? at.toISODate()! : g === "week" ? at.startOf("week").toISODate()! : at.toFormat("yyyy-MM"));

/** One GHL-read metric for the period, per group ("" when not split), with the work-situation summary for the MQL family. */
export async function ghlRows(x: GhlCtx, metric: string, entity: GhlEntity, label: string, groupBy?: GroupBy): Promise<{ rows: Map<string, number>; qualification?: QualificationSummary }> {
  if (x.filters.setter) throw new MetricError(`${label} cannot be filtered by setter`);
  if (x.filters.closer && entity === "lead") throw new MetricError(`${label} cannot be filtered by closer`);
  const rows = new Map<string, number>();
  const add = (k: string, v: number) => rows.set(k, (rows.get(k) ?? 0) + v);
  const src = (s: string | undefined) => (s ?? "unknown").toLowerCase();
  if (entity === "lead") {
    const { people, utm } = await leads(x);
    const sourceOf = (p: Person) => p.ownSource || utm.get(p.ghl) || "unknown";
    const cfg = qualifyConfig(x.bindings);
    if ((metric === "mqls" || metric === "marketing_dqs") && (!cfg || (!cfg.mql.length && !cfg.dq.length)))
      throw new MetricError(`${label} come from the answer to the CRM's work-situation field, and ${!cfg ? "no field is bound (crm.field_contact_work_situation)" : "no answers are set (qualify.mql_answers, qualify.dq_answers)"}`);
    const pool = people.filter((p) => !x.filters.source || src(sourceOf(p)) === src(x.filters.source));
    const counts = (p: Person) => metric === "leads" ? true : metric === "marketing_dqs" ? p.q === "dq" : p.q === "mql" || (p.q === "unanswered" && !!cfg?.unansweredIsMql);
    for (const p of pool) if (counts(p)) add(!groupBy ? "" : groupBy === "source" ? sourceOf(p) : timeKey(groupBy, p.at), 1);
    const qualification = metric === "mqls" && cfg ? {
      mql: pool.filter((p) => p.q === "mql").length, dq: pool.filter((p) => p.q === "dq").length, unanswered: pool.filter((p) => p.q === "unanswered").length,
      unrecognized: pool.filter((p) => p.q === "unrecognized").length, unrecognized_answers: [...new Set(pool.filter((p) => p.q === "unrecognized").map((p) => p.answer))].slice(0, 5), unanswered_is_mql: cfg.unansweredIsMql } : undefined;
    return { rows, qualification };
  }
  if (entity === "call") {
    const list = await counted(x);
    const dqs = salesCallConfig(x.bindings)?.dqDispositions ?? [];
    if (metric === "sales_dqs" && !dqs.length) throw new MetricError("sales DQs are the Sales Call records whose disposition is a DQ, and no DQ disposition is set (sales_call.dq_dispositions)");
    const sources = groupBy === "source" || x.filters.source ? await sourcesOf(x, list) : null;
    const counts = (k: Call) => metric === "calls_booked_due" || (metric === "shows" ? k.cls === "showed" : metric === "no_shows" ? k.cls === "noshow" : metric === "sales_dqs" ? dqs.includes(k.disposition) : k.cls === "cancelled");
    for (const k of list) {
      if (!counts(k) || (x.filters.closer && k.closer !== x.filters.closer)) continue;
      if (x.filters.source && src(sources!.get(k.ghl)) !== src(x.filters.source)) continue;
      add(!groupBy ? "" : groupBy === "source" ? sources!.get(k.ghl)! : groupBy === "closer" ? k.closer : groupBy === "setter" ? "" : timeKey(groupBy, k.at), 1);
    }
    return { rows };
  }
  const list = await closes(x);
  const sources = groupBy === "source" || x.filters.source ? await sourcesOf(x, list) : null;
  for (const k of list) {
    if (x.filters.closer && k.closer !== x.filters.closer) continue;
    if (x.filters.source && src(sources!.get(k.ghl)) !== src(x.filters.source)) continue;
    add(!groupBy ? "" : groupBy === "source" ? sources!.get(k.ghl)! : groupBy === "closer" ? k.closer : groupBy === "setter" ? "" : timeKey(groupBy, k.at), metric === "revenue" ? k.value : 1);
  }
  return { rows };
}
