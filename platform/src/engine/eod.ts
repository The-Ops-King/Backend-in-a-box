import type { PoolClient } from "pg";
import { randomBytes } from "node:crypto";
import { DateTime } from "luxon";
import { many, one } from "@/db/client";
import type { Adapters, Company } from "@/adapters/types";
import { decrypt } from "./crypto";
import { loadCompany, type CompanyRow } from "./context";
import { callTime, filedMeaning, salesCallValues } from "./sales-call";
import { effectiveMode } from "./mode";
import { raise } from "./alerts";
import { outcomeTermFor, recordDisposition } from "./disposition";
import { dispatchEvent, emitEvent } from "./dispatch";
import { mergeEodFields, missingAnswers, totalsOf, outcomeLabel, MONEY, type CallEntry, type CallOutcome, type DayTotals, type EodField } from "./eod-form";

/**
 * D34. The closer's end-of-day report: one link per closer, no login. Opening it shows their day prefilled from what the
 * engine already knows (calendar, recordings and Jev's notes, payments); every value is editable; submitting records each
 * call's outcome through the disposition path (so the no-show texts and the CRM records follow), and anything they changed
 * from the prefill is posted to the alerts channel, because a wrong prefill is a data gap to fix at the source.
 * A DM goes out at the company's end-of-day time on days they had calls and have not filed; filing gets a ✅ on that DM.
 */
export type { CallOutcome, CallEntry, EodField, DayTotals } from "./eod-form";
export type EodPrefill = DayTotals & { day: string; closer: { id: string; name: string; email: string }; company: { id: string; name: string; slug: string; timezone: string }; calls: CallEntry[]; ghl_unread?: string };
export type EodAnswers = DayTotals & { calls: CallEntry[]; day_answers: Record<string, string> };

/** The company's end-of-day form: their edits over the defaults (forms, purpose 'eod'; none stored = the defaults). */
export async function loadEodForm(c: PoolClient, companyId: string): Promise<EodField[]> {
  const row = await one<{ fields: EodField[] }>(c, "select fields from forms where company_id=$1 and purpose='eod' and active order by version desc limit 1", [companyId]);
  return mergeEodFields(row?.fields);
}
export async function saveEodForm(c: PoolClient, companyId: string, fields: EodField[]): Promise<void> {
  const merged = mergeEodFields(fields);
  const row = await one<{ id: string }>(c, "select id from forms where company_id=$1 and purpose='eod' and active order by version desc limit 1", [companyId]);
  if (row) await c.query("update forms set fields=$2, version=version+1 where id=$1", [row.id, JSON.stringify(merged)]);
  else await c.query("insert into forms (company_id, purpose, name, fields) values ($1,'eod','End of day',$2)", [companyId, JSON.stringify(merged)]);
}

export const DAY_FMT = "yyyy-MM-dd";
/** A call on the closer's day: not cancelled, or cancelled only after its start (a host clearing a no-show's slot is not a cancel, D73), so its outcome is still theirs to file. */
const HELD_CALL = "(a.status not in ('cancelled','invalid') or (a.status='cancelled' and a.source_updated_at >= a.starts_at))";
export const todayFor = (tz: string, now = DateTime.now()) => now.setZone(tz).toFormat(DAY_FMT);

/** The closer's standing link id: made once, kept. */
export async function tokenFor(c: PoolClient, userId: string): Promise<string> {
  const u = await one<{ report_token: string | null }>(c, "select report_token from users where id=$1", [userId]);
  if (u?.report_token) return u.report_token;
  const t = `er_${randomBytes(18).toString("base64url")}`;
  await c.query("update users set report_token=$2 where id=$1", [userId, t]);
  return t;
}
export const closerByToken = (c: PoolClient, token: string) => one<{ id: string; company_id: string; name: string; email: string; role: string; active: boolean }>(c, "select id, company_id, name, email, role, active from users where report_token=$1", [token]);

const num = (v: unknown): number => (v === null || v === undefined || v === "" ? 0 : Number(v) || 0);
const str = (v: unknown): string => (typeof v === "string" ? v : Array.isArray(v) ? v.map((x) => (typeof x === "string" ? x : (x as { objection?: string })?.objection ?? JSON.stringify(x))).join("; ") : v == null ? "" : String(v));

/** A closer's Sales Call in GHL that is due and blank: its call time has passed and nobody filed an outcome or a disposition. */
export type BlankSalesCall = { id: string; day: string; at: DateTime | null; name: string; ghl_contact_id: string | null; engine: boolean };
/** A row on the form for a Sales Call the engine has no booking for: keyed by the record, so filing it writes to that record. */
export const GHL_ROW = "ghl:";
/** What a held call puts on its Sales Call; a no-show or a call rescheduled on the call empties it (D77). */
export const HELD_CALL_PROPS = ["disposition", "cash_collected", "objection_primary", "next_step", "next_step_date", "payment_terms"];
const DISPOSITION: Partial<Record<CallOutcome, string>> = { closed: "closed_won", deposit: "closed_won", follow_up: "follow_up", lost: "lost", dq: "dq" };

/**
 * D76/D77: the closer's Sales Calls in GHL (matched by the record's `closer` to their roster name) that are due and blank:
 * the call time has passed (a record with only a day counts from the next day) and the outcome means nothing filed (blank, or
 * the company's "scheduled") with no disposition. `engine` marks a record that is one of the engine's own bookings (we wrote
 * or matched it, it carries a booking's id, or it is the person's booking that same minute); the rest were booked before
 * the engine was installed, and only the form can file them. Throws when GHL cannot be read.
 */
export async function blankSalesCalls(c: PoolClient, adapters: Adapters, adapterCompany: Company, companyId: string, bindings: Record<string, string>, closerName: string, tz: string, now: DateTime): Promise<BlankSalesCall[]> {
  const object = bindings["crm.object_sales_call"];
  if (!object || !closerName.trim()) return [];
  const today = now.setZone(tz).toISODate()!, who = closerName.trim().toLowerCase();
  const due: Omit<BlankSalesCall, "engine">[] = [];
  const recs = new Map<string, Record<string, unknown>>();
  for (const r of await adapters.read.objectRecords(adapterCompany, object)) {
    const p = r.properties;
    if (String(p.closer ?? "").trim().toLowerCase() !== who || filedMeaning(p.outcome, bindings) || String(p.disposition ?? "").trim()) continue;
    const cd = String(p.call_date ?? ""), dayOf = /^\d{4}-\d{2}-\d{2}$/.test(cd) ? DateTime.fromISO(cd, { zone: tz }) : null;
    const timed = callTime(p.scheduled_at, dayOf, tz), at = timed ?? dayOf;
    if (!at || (timed ? at > now : at.toISODate()! >= today)) continue;   // not due yet
    due.push({ id: r.id, day: at.setZone(tz).toISODate()!, at: timed, name: String(p.display_label ?? "").split(" — ")[0].trim() || r.id, ghl_contact_id: String(p.contact_id ?? "").trim() || null }); recs.set(r.id, p);
  }
  if (!due.length) return [];
  const ours = new Set((await many<{ v: string }>(c, "select ghl_record_id as v from crm_records where company_id=$1 and object_key=$2 and ghl_record_id = any($3::text[])", [companyId, object, due.map((r) => r.id)])).map((r) => r.v));
  const ext = due.map((r) => String(recs.get(r.id)!.external_id ?? "").trim()).filter(Boolean);
  const booked = new Set((await many<{ v: string }>(c, "select external_id as v from appointments where company_id=$1 and external_id = any($2::text[]) union select slot_key from appointments where company_id=$1 and slot_key = any($2::text[])", [companyId, ext])).map((r) => r.v));
  const people = due.map((r) => r.ghl_contact_id).filter((x): x is string => !!x);
  const theirs = await many<{ ghl: string; starts_at: Date }>(c, `select x.ghl, a.starts_at from appointments a join (select id as contact_id, ghl_contact_id as ghl from contacts where company_id=$1 and ghl_contact_id = any($2::text[])
      union select contact_id, value from contact_identifiers where company_id=$1 and kind='ghl_contact' and value = any($2::text[])) x on x.contact_id=a.contact_id where a.company_id=$1`, [companyId, people]);
  return due.map((r) => ({ ...r, engine: ours.has(r.id) || booked.has(String(recs.get(r.id)!.external_id ?? "").trim()) || theirs.some((t) => t.ghl === r.ghl_contact_id && (r.at ? DateTime.fromJSDate(t.starts_at).startOf("minute").toMillis() === r.at.startOf("minute").toMillis() : DateTime.fromJSDate(t.starts_at).setZone(tz).toISODate() === r.day)) }));
}

/** Their day as the engine saw it. Every value here is a prefill the closer may correct. With `adapters`, the day's blank Sales Calls booked before the engine (D77) are rows too. */
export async function prefill(c: PoolClient, company: CompanyRow, closer: { id: string; name: string; email: string }, day: string, now: DateTime = DateTime.now(), adapters?: Adapters): Promise<EodPrefill> {
  const tz = company.timezone;
  const from = DateTime.fromFormat(day, DAY_FMT, { zone: tz }).startOf("day"), to = from.endOf("day");
  const appts = await many<{ id: string; contact_id: string; contact: string; ghl_contact_id: string | null; starts_at: Date; ends_at: Date | null; status: string; outcome_cat: string | null; call_outcome_cat: string | null; notes: string | null }>(c, `
    select a.id, a.contact_id, trim(coalesce(ct.first_name,'')||' '||coalesce(ct.last_name,'')) as contact, ct.ghl_contact_id, a.starts_at, a.ends_at, a.status,
           ot.category as outcome_cat, cot.category as call_outcome_cat,
           (select fs.answers->>'notes' from form_submissions fs where fs.appointment_id=a.id order by fs.submitted_at desc limit 1) as notes
    from appointments a join contacts ct on ct.id=a.contact_id left join company_terms ot on ot.id=a.outcome_term left join company_terms cot on cot.id=a.call_outcome_term
    where a.company_id=$1 and a.assigned_user_id=$2 and a.starts_at >= $3 and a.starts_at <= $4 and ${HELD_CALL} order by a.starts_at`, [company.id, closer.id, from.toJSDate(), to.toJSDate()]);
  const calls: CallEntry[] = [];
  const loc = (await one<{ v: Buffer }>(c, "select value as v from bindings where company_id=$1 and key='crm.location_id'", [company.id]))?.v.toString("utf8");
  const price = num(company.contract_value_default);
  for (const a of appts) {
    const rec = await one<{ share_url: string | null; analysis: Record<string, unknown> }>(c, "select share_url, analysis from recordings where company_id=$1 and (appointment_id=$2 or (contact_id=$3 and started_at between $4 and $5)) order by started_at desc limit 1", [company.id, a.id, a.contact_id, from.toJSDate(), to.toJSDate()]);
    const notes = (rec?.analysis?.notes ?? {}) as Record<string, unknown>;
    const pay = await one<{ total: string }>(c, "select coalesce(sum(amount),0)::text as total from payments where company_id=$1 and contact_id=$2 and status='succeeded' and paid_at between $3 and $4", [company.id, a.contact_id, from.toJSDate(), to.toJSDate()]);
    const won = await one<{ v: string | null }>(c, "select contract_value::text as v from opportunities where company_id=$1 and contact_id=$2 and status='won' and won_at between $3 and $4 order by won_at desc limit 1", [company.id, a.contact_id, from.toJSDate(), to.toJSDate()]);
    const paid = num(pay?.total), contract = won?.v ? num(won.v) : price;
    const disp = str(notes.disposition);
    // D54: a call whose time has passed with no recording, no outcome and no money is presumed a no-show on the form only; nothing is marked until the closer answers
    const over = DateTime.fromJSDate(a.ends_at ?? a.starts_at) < now;
    // what the ledger says first (a recorded outcome, then money), then the presumption, then Jev's read of the transcript as the tentative pre-set
    const outcome: CallOutcome = a.outcome_cat === "noshow" || a.status === "noshow" ? "no_show" : a.outcome_cat === "rescheduled" ? "rescheduled"
      : a.call_outcome_cat === "closed" ? "closed" : a.call_outcome_cat === "deposit" ? "deposit" : a.call_outcome_cat === "follow_up" ? "follow_up" : a.call_outcome_cat === "lost" ? "lost" : a.call_outcome_cat === "unqualified" ? "dq"
      : paid > 0 ? (contract > 0 && paid < contract ? "deposit" : "closed") : won ? "closed"
      : over && !rec && !a.outcome_cat ? "no_show"
      : disp === "closed_won" ? "closed" : disp === "follow_up" || disp === "close_pending" ? "follow_up" : disp === "lost" ? "lost" : disp === "dq" ? "dq" : "";
    const money = MONEY.includes(outcome);
    const aboutParts = [str(notes.summary), str(notes.pain) && `Pains: ${str(notes.pain)}`, str(notes.desire) && `Goals: ${str(notes.desire)}`, str(notes.objections) && `Objections: ${str(notes.objections)}`].filter(Boolean);
    calls.push({ appointment_id: a.id, contact_id: a.contact_id, contact: a.contact || "—", starts_at: a.starts_at.toISOString(), href_contact: loc && a.ghl_contact_id ? `https://app.gohighlevel.com/v2/location/${loc}/contacts/detail/${a.ghl_contact_id}` : null, recording_url: rec?.share_url ?? null,
      outcome, revenue: money ? contract || paid || null : null, cash: money ? paid || null : null,
      next_date: str(notes.next_step_date) || null, next_steps: str(notes.next_step), dq_reason: "", dq_note: "", about: aboutParts.join("\n"), notes: a.notes ?? "", extra: {} });
  }
  // D77: Sales Calls booked before the engine was installed, blank in GHL: their own rows, filed straight to the record; a row filed here before stays on the form after GHL has its answer
  let ghlUnread: string | undefined;
  if (adapters) {
    const blank = (s: string): CallEntry => ({ appointment_id: s, contact_id: "", contact: "—", starts_at: from.toISO()!, href_contact: null, recording_url: null, outcome: "", revenue: null, cash: null, next_date: null, next_steps: "", dq_reason: "", dq_note: "", about: "", notes: "", extra: {} });
    try {
      const { adapterCompany, bindings } = await loadCompany(c, company.id);
      for (const r of (await blankSalesCalls(c, adapters, adapterCompany, company.id, bindings, closer.name, tz, now)).filter((x) => !x.engine && x.day === day)) {
        const ct = r.ghl_contact_id ? await one<{ id: string }>(c, "select id from contacts where company_id=$1 and ghl_contact_id=$2", [company.id, r.ghl_contact_id]) : null;
        calls.push({ ...blank(`${GHL_ROW}${r.id}`), record_id: r.id, contact_id: ct?.id ?? "", contact: r.name, starts_at: (r.at ?? from).toUTC().toISO()!, href_contact: loc && r.ghl_contact_id ? `https://app.gohighlevel.com/v2/location/${loc}/contacts/detail/${r.ghl_contact_id}` : null });
      }
    } catch (e) { ghlUnread = String((e as Error).message).slice(0, 200); }
    const filed = await one<{ answers: EodAnswers | null }>(c, "select answers from eod_reports where company_id=$1 and user_id=$2 and day=$3", [company.id, closer.id, day]);
    for (const f of filed?.answers?.calls ?? []) if (f.appointment_id.startsWith(GHL_ROW) && !calls.some((x) => x.appointment_id === f.appointment_id)) calls.push({ ...blank(f.appointment_id), contact_id: f.contact_id, contact: f.contact, starts_at: f.starts_at });
    calls.sort((a, b) => a.starts_at.localeCompare(b.starts_at));
  }
  return { day, closer, company: { id: company.id, name: company.name, slug: company.slug, timezone: tz }, ...totalsOf(calls), calls, ...(ghlUnread ? { ghl_unread: ghlUnread } : {}) };
}

/**
 * D77: a form row for a Sales Call the engine never booked is written to that record directly, the same properties Call
 * outcome filed writes: the outcome in the company's own keys, the disposition for a held call, and null for what a held call
 * carried when the answer is a no-show or rescheduled on the call. Not in live (or for a non-test contact in test): noted, not written.
 */
async function fileGhlRow(c: PoolClient, adapters: Adapters, company: CompanyRow, call: CallEntry): Promise<"written" | "would" | "unchanged"> {
  const { adapterCompany, bindings } = await loadCompany(c, company.id);
  const object = bindings["crm.object_sales_call"], recordId = call.appointment_id.slice(GHL_ROW.length);
  const v = salesCallValues(bindings);
  const outcome = call.outcome === "no_show" ? v.noshow : call.outcome === "rescheduled" ? v.on_call : v.showed;
  const props: Record<string, unknown> = { ...(outcome ? { outcome } : {}) };
  if (DISPOSITION[call.outcome]) props.disposition = DISPOSITION[call.outcome];
  else for (const k of HELD_CALL_PROPS) props[k] = null;
  const effective = await effectiveMode(c, company.id, call.contact_id || null, company.mode, bindings);
  await c.query("insert into audit_log (company_id, action, target_type, target_id, after) values ($1,'eod.sales_call_filed','crm_record',$2,$3)", [company.id, recordId, { object, properties: props, written: effective === "real" }]);
  if (effective !== "real") return "would";
  await adapters.write.updateRecord(adapterCompany, object, recordId, props);
  return "written";
}

/** The closer's end-of-day picture for a run about them (context root user.eod): today's calls and whether today is filed, and every earlier day in the last week with calls and no report. Lines are ready to post. */
export async function eodFacts(c: PoolClient, company: CompanyRow, userId: string, base: string, now = DateTime.now()): Promise<{ day: string; url: string; today: { calls: number; filed: boolean; line: string }; earlier: { day: string; label: string; calls: number; url: string }[]; earlier_count: number; earlier_lines: string; all_lines: string }> {
  const tz = company.timezone, local = now.setZone(tz), day = local.toFormat(DAY_FMT);
  const token = await tokenFor(c, userId), url = `${base}/eod/${token}`;
  const rows = await many<{ day: string; calls: number; filed: boolean }>(c, `
    select d.day::text as day, count(a.id)::int as calls, exists (select 1 from eod_reports r where r.company_id=$1 and r.user_id=$2 and r.day=d.day and r.submitted_at is not null) as filed
    from (select generate_series(($3::date - interval '7 days')::date, $3::date, interval '1 day')::date as day) d
    left join appointments a on a.company_id=$1 and a.assigned_user_id=$2 and ${HELD_CALL} and (a.starts_at at time zone $4)::date = d.day
    group by d.day order by d.day`, [company.id, userId, day, tz]);
  const label = (d: string) => DateTime.fromFormat(d, DAY_FMT, { zone: tz }).toFormat("ccc LLL d");
  const today = rows.find((r) => r.day === day) ?? { day, calls: 0, filed: false };
  const earlier = rows.filter((r) => r.day < day && r.calls > 0 && !r.filed).map((r) => ({ day: r.day, label: label(r.day), calls: r.calls, url: `${url}?day=${r.day}` }));
  const line = (d: { label: string; calls: number; url: string }, when: string) => `• <${d.url}|${when}>: ${d.calls} call${d.calls === 1 ? "" : "s"}`;
  const todayLine = today.calls && !today.filed ? line({ label: "today", calls: today.calls, url }, "today") : "";
  const earlierLines = earlier.map((d) => line(d, d.label)).join("\n");
  return { day, url, today: { calls: today.calls, filed: today.filed, line: todayLine }, earlier, earlier_count: earlier.length, earlier_lines: earlierLines, all_lines: [todayLine, earlierLines].filter(Boolean).join("\n") };
}

export type Change = { field: string; from: unknown; to: unknown; contact?: string };
/** What the closer corrected, as lines a person reads: "calls today 6 → 7", "Sarah: outcome Follow up → Closed". */
export function diffAnswers(pre: EodPrefill, ans: EodAnswers): Change[] {
  const out: Change[] = [];
  for (const k of ["calls_count", "closes", "deposits", "cash", "revenue"] as const) if (num(pre[k]) !== num(ans[k])) out.push({ field: k.replace(/_/g, " "), from: pre[k], to: ans[k] });
  for (const call of ans.calls) {
    const p = pre.calls.find((x) => x.appointment_id === call.appointment_id); if (!p) continue;
    if (p.outcome !== call.outcome) out.push({ field: "outcome", from: outcomeLabel(p.outcome), to: outcomeLabel(call.outcome), contact: p.contact });
    for (const k of ["revenue", "cash", "next_date"] as const) { const a = p[k] ?? "", b = call[k] ?? ""; if (String(a) !== String(b) && !(a === "" && b === "")) out.push({ field: k.replace(/_/g, " "), from: a || "blank", to: b || "blank", contact: p.contact }); }
  }
  return out;
}

/** The disposition note for one call: everything the closer said about it, one line per thing. */
function dispositionNotes(call: CallEntry, fields: EodField[]): string {
  const lines = [
    call.about && `About: ${call.about}`,
    call.notes,
    call.outcome === "dq" && (call.dq_reason || call.dq_note) ? `DQ: ${[call.dq_reason, call.dq_note].filter(Boolean).join(" - ")}` : "",
    call.outcome === "follow_up" && (call.next_steps || call.next_date) ? `Next: ${call.next_steps}${call.next_date ? ` by ${call.next_date}` : ""}` : "",
    MONEY.includes(call.outcome) ? `${outcomeLabel(call.outcome)}: contract ${call.revenue ?? "?"}, cash ${call.cash ?? "?"}` : "",
    ...fields.filter((f) => f.scope === "call" && !f.builtin && call.extra?.[f.key]).map((f) => `${f.label}: ${call.extra[f.key]}`),
  ];
  return lines.filter(Boolean).join("\n");
}

/** File the day: check the required answers, store it, record each call's outcome through the disposition path, tell the alerts channel what was corrected, tick the DM. */
export async function submitEod(c: PoolClient, adapters: Adapters, args: { token: string; day: string; answers: EodAnswers }): Promise<{ ok: true; changes: Change[]; recorded: number } | { ok: false; why: string }> {
  const closer = await closerByToken(c, args.token); if (!closer || !closer.active || !closer.company_id) return { ok: false, why: "this link is not for anyone" };
  const { row: company } = await loadCompany(c, closer.company_id);
  const fields = await loadEodForm(c, company.id);
  const missing = missingAnswers(fields, args.answers.calls, args.answers.day_answers ?? {});
  if (missing.length) return { ok: false, why: `Still needed: ${missing.join("; ")}` };
  const pre = await prefill(c, company, closer, args.day, DateTime.now(), adapters);
  // a GHL row the form did not offer this closer is dropped before anything is stored or written (D77)
  args = { ...args, answers: { ...args.answers, calls: args.answers.calls.filter((x) => !x.appointment_id.startsWith(GHL_ROW) || pre.calls.some((p) => p.appointment_id === x.appointment_id)) } };
  const changes = diffAnswers(pre, args.answers);
  const before = (await reportFor(c, company.id, closer.id, args.day))?.answers?.calls ?? [];
  let recorded = 0;
  const outcomeTerm = async (cat: string) => outcomeTermFor(c, company.id, cat);
  const callTerm = async (cat: string) => (await one<{ id: string }>(c, "select id from company_terms where company_id=$1 and domain='call_outcome' and category=$2 and active order by is_default desc, sort limit 1", [company.id, cat]))?.id ?? null;
  for (const call of args.answers.calls) {
    if (!call.outcome) continue;
    if (call.appointment_id.startsWith(GHL_ROW)) {
      // a row this form offered (the closer's own blank record, or one they filed here before); one GHL already holds this answer for is not written again
      const offered = pre.calls.find((x) => x.appointment_id === call.appointment_id)!;
      if (!offered.record_id && before.find((x) => x.appointment_id === call.appointment_id)?.outcome === call.outcome) { recorded++; continue; }
      try { await fileGhlRow(c, adapters, company, call); recorded++; }
      catch (e) { await raise(c, { companyId: company.id, key: `eod:sales_call:${call.appointment_id.slice(GHL_ROW.length)}`, level: "warning", source: "engine", href: `/app/c/${company.slug}`, text: `Couldn't write ${closer.name}'s answer for ${call.contact} (${outcomeLabel(call.outcome)}) to its Sales Call in GHL: ${String((e as Error).message).slice(0, 200)}. Filing the day again retries it.`, detail: { record_id: call.appointment_id.slice(GHL_ROW.length), outcome: call.outcome } }); }
      continue;
    }
    const outcomeCat = call.outcome === "no_show" ? "noshow" : call.outcome === "rescheduled" ? "rescheduled" : "showed";
    const outcomeTermId = await outcomeTerm(outcomeCat); if (!outcomeTermId) continue;
    const callCat = call.outcome === "closed" ? "closed" : call.outcome === "deposit" ? "deposit" : call.outcome === "follow_up" ? "follow_up" : call.outcome === "lost" ? "lost" : call.outcome === "dq" ? "unqualified" : null;
    const callOutcomeTermId = callCat ? (await callTerm(callCat)) ?? (callCat === "deposit" ? await callTerm("closed") : null) : null;
    // an answer the ledger already holds (filed before, a card moved by hand, the CRM's no-show) is not filed again: Call outcome filed already posted it, and a second run would post it twice
    const held = await one<{ outcome_term: string | null; call_outcome_term: string | null; status: string }>(c, "select outcome_term, call_outcome_term, status from appointments where id=$1 and company_id=$2", [call.appointment_id, company.id]);
    if (held && (held.outcome_term === outcomeTermId ? outcomeCat !== "showed" || held.call_outcome_term === callOutcomeTermId : outcomeCat === "noshow" && !held.outcome_term && held.status === "noshow")) { recorded++; continue; }
    try { await recordDisposition(c, { companyId: company.id, appointmentId: call.appointment_id, outcomeTermId, callOutcomeTermId, notes: dispositionNotes(call, fields), userId: closer.id }); recorded++; } catch { /* an appointment that vanished: the rest still files */ }
  }
  const wasFiled = (await one<{ submitted_at: Date | null }>(c, "select submitted_at from eod_reports where company_id=$1 and user_id=$2 and day=$3", [company.id, closer.id, args.day]))?.submitted_at ?? null;
  const row = await one<{ id: string }>(c, `insert into eod_reports (company_id, user_id, day, prefill, answers, changes, submitted_at) values ($1,$2,$3,$4,$5,$6,now())
    on conflict (company_id, user_id, day) do update set prefill=excluded.prefill, answers=excluded.answers, changes=excluded.changes, submitted_at=now() returning id`, [company.id, closer.id, args.day, JSON.stringify(pre), JSON.stringify(args.answers), JSON.stringify(changes)]);
  // the report is an event: the eod-filed workflow posts the summary, threads under the reminder, sends it wherever else the company wants it
  const corrections = changes.map((ch) => `${ch.contact ? `${ch.contact}: ` : ""}${ch.field} ${fmt(ch.from)} → ${fmt(ch.to)}`);
  const dayAnswers = fields.filter((f) => f.scope === "day" && args.answers.day_answers?.[f.key]).map((f) => ({ key: f.key, label: f.label, answer: args.answers.day_answers[f.key] }));
  const ev = await emitEvent(c, { company_id: company.id, contact_id: null, opportunity_id: null, appointment_id: null, event_type: "eod.filed", source: "user",
    data: { user_id: closer.id, report_id: row?.id, day: args.day, day_label: DateTime.fromFormat(args.day, DAY_FMT).toFormat("ccc LLL d"), totals_line: totalsLine(args.answers), calls_count: args.answers.calls_count, closes: args.answers.closes, deposits: args.answers.deposits, cash: args.answers.cash, revenue: args.answers.revenue,
      calls: args.answers.calls.map((x) => ({ contact: x.contact, contact_id: x.contact_id, appointment_id: x.appointment_id, outcome: x.outcome, outcome_label: outcomeLabel(x.outcome), revenue: x.revenue, cash: x.cash, next_date: x.next_date, next_steps: x.next_steps, dq_reason: x.dq_reason, dq_note: x.dq_note, about: x.about, notes: x.notes, ...x.extra })),
      corrections, corrections_lines: corrections.map((x) => `• ${x}`).join("\n"), corrections_block: corrections.length ? `*Corrected from what the engine had:*\n${corrections.map((x) => `• ${x}`).join("\n")}` : "", corrections_count: corrections.length, corrected: corrections.length > 0, day_answers: dayAnswers, day_answers_lines: dayAnswers.map((d) => `*${d.label}* ${d.answer}`).join("\n"), refiled: !!wasFiled } });
  await dispatchEvent(c, ev, { user: { id: closer.id } });
  return { ok: true, changes, recorded };
}
const fmt = (v: unknown) => (typeof v === "number" ? v.toLocaleString("en-US") : String(v ?? "blank"));
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
/** "3 calls, 1 close, 1 deposit, $1,500 cash, $4,000 revenue" (deposits only when there are any). */
export const totalsLine = (t: DayTotals) => [plural(t.calls_count, "call"), plural(t.closes, "close"), t.deposits ? plural(t.deposits, "deposit") : "", `$${t.cash.toLocaleString("en-US")} cash`, `$${t.revenue.toLocaleString("en-US")} revenue`].filter(Boolean).join(", ");

export const reportFor = (c: PoolClient, companyId: string, userId: string, day: string) => one<{ id: string; submitted_at: Date | null; answers: EodAnswers | null; changes: Change[]; reminded_at: Date | null }>(c, "select id, submitted_at, answers, changes, reminded_at from eod_reports where company_id=$1 and user_id=$2 and day=$3", [companyId, userId, day]);
export const companyReports = (c: PoolClient, companyId: string, limit = 60) => many<{ id: string; day: string; closer: string; submitted_at: Date | null; reminded_at: Date | null; answers: EodAnswers | null; changes: Change[] }>(c, "select r.id, r.day::text as day, u.name as closer, r.submitted_at, r.reminded_at, r.answers, r.changes from eod_reports r join users u on u.id=r.user_id where r.company_id=$1 order by r.day desc, u.name limit $2", [companyId, limit]);
export const slackTokenFor = async (c: PoolClient, companyId: string) => { const conn = await one<{ bot_token: Buffer }>(c, "select bot_token from slack_connections where company_id=$1", [companyId]); return conn ? decrypt(conn.bot_token) : null; };
