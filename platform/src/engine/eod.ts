import type { PoolClient } from "pg";
import { randomBytes } from "node:crypto";
import { DateTime } from "luxon";
import { many, one } from "@/db/client";
import type { Adapters, Company } from "@/adapters/types";
import { loadCompany, type CompanyRow } from "./context";
import { callTime, dispositionMeaning, dispositionValues, filedMeaning, closerNameOf, closerOptions, CLOSER_OPTIONS_KEY } from "./sales-call";
import { outcomeTermFor, recordDisposition } from "./disposition";
import { dispatchEvent, emitEvent } from "./dispatch";
import { mergeEodFields, missingAnswers, impossibleAnswers, totalsOf, outcomeLabel, isMoney, isRevenueOutcome, isSetterCall, choiceOf, valueFor, pitchedOf, TRIAGE_RESULT, type CallEntry, type CallMeaning, type DayTotals, type EodField } from "./eod-form";
import { SETTING_DEFAULTS, switchOn } from "./setting-defaults";

/**
 * D34. The closer's end-of-day report: one link per closer, no login. Opening it shows their day prefilled from what the
 * engine already knows (calendar, recordings and Jev's notes, payments); every value is editable; submitting records each
 * call's outcome through the disposition path (so the no-show texts and the CRM records follow), and anything they changed
 * from the prefill is posted to the alerts channel, because a wrong prefill is a data gap to fix at the source.
 * A DM goes out at the company's end-of-day time on days they had calls and have not filed; filing gets a ✅ on that DM.
 */
export type { CallOutcome, CallEntry, EodField, DayTotals } from "./eod-form";
export type EodPrefill = DayTotals & { day: string; closer: { id: string; name: string; email: string }; company: { id: string; name: string; slug: string; timezone: string }; calls: CallEntry[] };
export type EodAnswers = DayTotals & { calls: CallEntry[]; day_answers: Record<string, string> };

/**
 * The company's end-of-day form: their edits over the defaults (forms, purpose 'eod'; none stored = the defaults). D156: a company
 * whose DQ reasons are a list of their own (`eod.dq_reasons`, a core category domain: Dating's dating_dq_reason) asks why a DQ from it,
 * the same list Jev reads a setter's call into, so its read pre-fills the answer.
 */
export async function loadEodForm(c: PoolClient, companyId: string): Promise<EodField[]> {
  const row = await one<{ fields: EodField[] }>(c, "select fields from forms where company_id=$1 and purpose='eod' and active order by version desc limit 1", [companyId]);
  const fields = mergeEodFields(row?.fields);
  const domain = (await one<{ v: Buffer }>(c, "select value as v from bindings where company_id=$1 and key='eod.dq_reasons'", [companyId]))?.v.toString("utf8").trim();
  if (!domain) return fields;
  const options = (await many<{ label: string }>(c, "select label from core_categories where domain=$1 order by sort", [domain])).map((r) => r.label);
  return options.length ? fields.map((f) => (f.key === "dq_reason" ? { ...f, options } : f)) : fields;
}
export async function saveEodForm(c: PoolClient, companyId: string, fields: EodField[]): Promise<void> {
  const merged = mergeEodFields(fields);
  const row = await one<{ id: string }>(c, "select id from forms where company_id=$1 and purpose='eod' and active order by version desc limit 1", [companyId]);
  if (row) await c.query("update forms set fields=$2, version=version+1 where id=$1", [row.id, JSON.stringify(merged)]);
  else await c.query("insert into forms (company_id, purpose, name, fields) values ($1,'eod','End of day',$2)", [companyId, JSON.stringify(merged)]);
}

export const DAY_FMT = "yyyy-MM-dd";
const BOOKING_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** D156: a setter's outbound call on the form, by its conversation (the Discovery Call record's key) */
const DIAL_ID = /^dial:.+$/;
const dialId = (conversation: string) => `dial:${conversation}`;
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

/** One of the closer's Sales Calls in GHL that is one of the engine's bookings: filed or not, due or not. */
export type CloserSalesCall = { id: string; day: string; at: DateTime | null; name: string; ghl_contact_id: string | null; filed: boolean; due: boolean; appointment_id: string; attendance: string | null; call: string | null };

/**
 * D76/D82: the closer's Sales Calls in GHL (matched by the record's `closer` to their roster name) that are the engine's
 * bookings, each with whether it is filed (an outcome that means something other than "scheduled", or a disposition) and
 * due (the call time has passed; a record with only a day counts from the next day). `appointment_id` is the booking the
 * record is: one we wrote, one carrying a booking's id or slot, or the person's booking that same minute (that same day
 * when the record has no time). A record with no booking is left out: the engine has every booking from install on (D110).
 * Throws when GHL cannot be read.
 */
export async function closerSalesCalls(c: PoolClient, adapters: Adapters, adapterCompany: Company, companyId: string, bindings: Record<string, string>, closerName: string, tz: string, now: DateTime): Promise<CloserSalesCall[]> {
  const object = bindings["crm.object_sales_call"];
  if (!object || !closerName.trim()) return [];
  const today = now.setZone(tz).toISODate()!, who = closerName.trim().toLowerCase();
  // D118: the record may name the closer by the company's option key ("mitch") rather than by name
  const options = bindings[CLOSER_OPTIONS_KEY] ? closerOptions(bindings, await many<{ name: string; email: string | null; ghl_user_id: string | null }>(c, "select name, email, ghl_user_id from users where company_id=$1", [companyId])) : null;
  const recs: (Omit<CloserSalesCall, "appointment_id"> & { ext: string })[] = [];
  for (const r of await adapters.read.objectRecords(adapterCompany, object)) {
    const p = r.properties;
    if (closerNameOf(String(p.closer ?? ""), options).toLowerCase() !== who) continue;
    const cd = String(p.call_date ?? ""), dayOf = /^\d{4}-\d{2}-\d{2}$/.test(cd) ? DateTime.fromISO(cd, { zone: tz }) : null;
    const timed = callTime(p.scheduled_at, dayOf, tz), at = timed ?? dayOf;
    if (!at) continue;
    recs.push({ id: r.id, day: at.setZone(tz).toISODate()!, at: timed, name: String(p.display_label ?? "").split(" — ")[0].split(" · ")[0].trim() || r.id, ghl_contact_id: String(p.contact_id ?? "").trim() || null,
      filed: !!filedMeaning(p.outcome, bindings) || !!String(p.disposition ?? "").trim(), due: timed ? at <= now : at.toISODate()! < today, ext: String(p.external_id ?? "").trim(),
      attendance: filedMeaning(p.outcome, bindings), call: dispositionMeaning(p.disposition, bindings) });
  }
  if (!recs.length) return [];
  const ours = await many<{ rec: string; appt: string | null }>(c, `select cr.ghl_record_id as rec, a.id::text as appt from crm_records cr
      left join appointments a on a.company_id=cr.company_id and (a.external_id=cr.record_key or a.slot_key=cr.record_key)
      where cr.company_id=$1 and cr.object_key=$2 and cr.ghl_record_id = any($3::text[])`, [companyId, object, recs.map((r) => r.id)]);
  const ext = recs.map((r) => r.ext).filter(Boolean);
  const booked = await many<{ k: string; appt: string }>(c, "select external_id as k, id::text as appt from appointments where company_id=$1 and external_id = any($2::text[]) union all select slot_key, id::text from appointments where company_id=$1 and slot_key = any($2::text[])", [companyId, ext]);
  const people = [...new Set(recs.map((r) => r.ghl_contact_id).filter((x): x is string => !!x))];
  const theirs = await many<{ ghl: string; appt: string; starts_at: Date }>(c, `select x.ghl, a.id::text as appt, a.starts_at from appointments a join (select id as contact_id, ghl_contact_id as ghl from contacts where company_id=$1 and ghl_contact_id = any($2::text[])
      union select contact_id, value from contact_identifiers where company_id=$1 and kind='ghl_contact' and value = any($2::text[])) x on x.contact_id=a.contact_id where a.company_id=$1`, [companyId, people]);
  return recs.flatMap(({ ext: e, ...r }) => {
    const mine = ours.find((o) => o.rec === r.id), byId = e ? booked.find((b) => b.k === e) : undefined;
    const same = theirs.find((t) => t.ghl === r.ghl_contact_id && (r.at ? DateTime.fromJSDate(t.starts_at).startOf("minute").toMillis() === r.at.startOf("minute").toMillis() : DateTime.fromJSDate(t.starts_at).setZone(tz).toISODate() === r.day));
    const appt = mine?.appt ?? byId?.appt ?? same?.appt;
    return appt ? [{ ...r, appointment_id: appt }] : [];
  });
}

/**
 * D143: the triage calls' answers as GHL holds them: each call's Discovery Call record (the one the engine made for that booking),
 * its outcome (showed, no_show) as the attendance and its call_result (set, follow_up, dq, not_interested) as the call's meaning.
 */
export async function triageRecords(c: PoolClient, adapters: Adapters, adapterCompany: Company, companyId: string, bindings: Record<string, string>, appointmentIds: string[]): Promise<Map<string, { attendance: string | null; call: string | null }>> {
  // D200: the object the workflows write (unset, the default), not none
  const object = bindings["crm.object_discovery_call"] || SETTING_DEFAULTS["crm.object_discovery_call"].default, out = new Map<string, { attendance: string | null; call: string | null }>();
  if (!object || !appointmentIds.length) return out;
  const ours = await many<{ appt: string; rec: string }>(c, `select a.id::text as appt, cr.ghl_record_id as rec from appointments a join crm_records cr on cr.company_id=a.company_id and cr.object_key=$2 and cr.record_key=coalesce(a.slot_key, a.external_id)
    where a.company_id=$1 and a.id = any($3::uuid[]) and cr.ghl_record_id is not null`, [companyId, object, appointmentIds]);
  if (!ours.length) return out;
  const byId = new Map((await adapters.read.objectRecords(adapterCompany, object)).map((r) => [r.id, r.properties]));
  const meaning = Object.fromEntries(Object.entries(TRIAGE_RESULT).map(([m, v]) => [v, m]));
  for (const o of ours) {
    const p = byId.get(o.rec); if (!p) continue;
    const seen = String(p.outcome ?? "").trim();
    out.set(o.appt, { attendance: seen === "showed" ? "showed" : seen === "no_show" ? "noshow" : null, call: meaning[String(p.call_result ?? "").trim()] ?? null });
  }
  return out;
}

/**
 * D156 (Tyler, 2026-10-19: "Mitch's end-of-day form is going to be the source of truth, but we use Jev to fill it out with what we
 * think happened on that call ... Mitch is also going to be doing some outbound setting ... add those to his end of day"): with
 * `eod.setter_calls` on, a setter's GHL calls Jev read as setting calls (Setter call logged's setter_call.result, the latest read of
 * each conversation) are on their day. One with a person who had a triage call with them that day pre-fills that call's row; any
 * other is a row of its own (an outbound call, kind dial). `filed`: the answer the end of day last gave that conversation.
 */
type SetterRead = { conversation: string; contact_id: string; contact: string; ghl_contact_id: string | null; started_at: Date; share_url: string | null; day: string;
  result: string; dq_reason: string; digest: string; filed: string | null };
const setterCallsOn = async (c: PoolClient, companyId: string) => switchOn({ "eod.setter_calls": (await one<{ v: Buffer }>(c, "select value as v from bindings where company_id=$1 and key='eod.setter_calls'", [companyId]))?.v.toString("utf8") ?? "" }, "eod.setter_calls");
async function setterReads(c: PoolClient, companyId: string, tz: string, userId: string, from: DateTime, to: DateTime): Promise<SetterRead[]> {
  const rows = await many<{ conversation: string; contact_id: string; contact: string; ghl_contact_id: string | null; started_at: Date; share_url: string | null; data: Record<string, string>; filed: Record<string, string> | null }>(c, `
    select distinct on (e.data->>'external_id') e.data->>'external_id' as conversation, e.contact_id, trim(coalesce(ct.first_name,'')||' '||coalesce(ct.last_name,'')) as contact, ct.ghl_contact_id,
           r.started_at, r.share_url, e.data,
           (select f.data from events f where f.company_id=e.company_id and f.event_type='setter_call.filed' and f.data->>'conversation' = e.data->>'external_id' order by f.id desc limit 1) as filed
    from events e join recordings r on r.company_id=e.company_id and r.id::text = e.data->>'recording_id' join contacts ct on ct.id=e.contact_id
    join users u on u.id=$2 and (u.ghl_user_id = r.raw->>'caller_ghl_user_id' or lower(u.email) = lower(r.recorded_by_email))
    where e.company_id=$1 and e.event_type='setter_call.result' and coalesce(e.data->>'call_type', 'setting') = 'setting' and r.started_at >= $3 and r.started_at <= $4
    order by e.data->>'external_id', e.id desc`, [companyId, userId, from.toJSDate(), to.toJSDate()]);
  const label = new Map((await many<{ domain: string; value: string; label: string }>(c, "select domain, value, label from core_categories where domain in ('dating_dq_reason','setter_dq_reason')")).map((r) => [`${r.domain}:${r.value}`, r.label]));
  return rows.map((r) => ({ conversation: r.conversation, contact_id: r.contact_id, contact: r.contact || "—", ghl_contact_id: r.ghl_contact_id, started_at: r.started_at, share_url: r.share_url,
    day: DateTime.fromJSDate(r.started_at).setZone(tz).toFormat(DAY_FMT), result: String(r.data.result ?? ""),
    dq_reason: r.data.dq_reason ? label.get(`${r.data.dq_domain || "setter_dq_reason"}:${r.data.dq_reason}`) ?? "" : "", digest: String(r.data.digest ?? ""), filed: r.filed?.result ?? null }))
    .sort((a, b) => a.started_at.getTime() - b.started_at.getTime());
}
/** Jev's result (or the end of day's last answer) as the form's answer for a setter's call: set, follow up, DQ, not interested */
const READ_MEANING: Record<string, CallMeaning> = { set: "qualified", follow_up: "follow_up", dq: "unqualified", not_interested: "lost" };

/** Their day as the engine saw it: the closer's bookings that day (D110: the only rows), and D156 a setter's outbound calls. Every value here is a prefill the closer may correct. */
export async function prefill(c: PoolClient, company: CompanyRow, closer: { id: string; name: string; email: string }, day: string, now: DateTime = DateTime.now()): Promise<EodPrefill> {
  const tz = company.timezone;
  const from = DateTime.fromFormat(day, DAY_FMT, { zone: tz }).startOf("day"), to = from.endOf("day");
  const fields = await loadEodForm(c, company.id), v = (m: Parameters<typeof valueFor>[1]) => valueFor(fields, m);
  const appts = await many<{ id: string; contact_id: string; contact: string; ghl_contact_id: string | null; starts_at: Date; ends_at: Date | null; status: string; term_cat: string | null; set_since: boolean; outcome_cat: string | null; call_outcome_cat: string | null; notes: string | null; via: string | null; pitched: boolean | null }>(c, `
    select a.id, a.contact_id, a.pitched, trim(coalesce(ct.first_name,'')||' '||coalesce(ct.last_name,'')) as contact, ct.ghl_contact_id, a.starts_at, a.ends_at, a.status, tt.category as term_cat,
           exists (select 1 from appointments b join company_terms bt on bt.id=b.appointment_term where b.contact_id=a.contact_id and bt.category='closing' and b.booked_at > a.starts_at and b.status<>'cancelled') as set_since,
           ot.category as outcome_cat, cot.category as call_outcome_cat,
           (select fs.answers->>'notes' from form_submissions fs where fs.appointment_id=a.id order by fs.submitted_at desc limit 1) as notes,
           (select fs.answers->>'via' from form_submissions fs where fs.appointment_id=a.id order by fs.submitted_at desc limit 1) as via
    from appointments a join contacts ct on ct.id=a.contact_id left join company_terms ot on ot.id=a.outcome_term left join company_terms cot on cot.id=a.call_outcome_term left join company_terms tt on tt.id=a.appointment_term
    where a.company_id=$1 and a.assigned_user_id=$2 and a.starts_at >= $3 and a.starts_at <= $4 and ${HELD_CALL} order by a.starts_at`, [company.id, closer.id, from.toJSDate(), to.toJSDate()]);
  const calls: CallEntry[] = [];
  const loc = (await one<{ v: Buffer }>(c, "select value as v from bindings where company_id=$1 and key='crm.location_id'", [company.id]))?.v.toString("utf8");
  const href = (ghl: string | null) => (loc && ghl ? `https://app.gohighlevel.com/v2/location/${loc}/contacts/detail/${ghl}` : null);
  const price = num(company.contract_value_default);
  const reads = (await setterCallsOn(c, company.id)) ? await setterReads(c, company.id, tz, closer.id, from, to) : [];
  const triaged = new Set(appts.filter((a) => a.term_cat === "first_call").map((a) => a.contact_id));
  const dqOption = (label: string) => (label && fields.find((f) => f.key === "dq_reason")?.options?.includes(label) ? label : "");
  for (const a of appts) {
    // D143: a triage call (a first call) asks its own questions; "set" pre-fills when they have booked a closing call since
    if (a.term_cat === "first_call") {
      const t = (m: Parameters<typeof valueFor>[1]) => valueFor(fields, m, "triage");
      // D156: Jev's read of the setter's call with them that day, after what the ledger holds and a closing call booked since
      const read = reads.filter((r) => r.contact_id === a.contact_id).at(-1);
      const byRead = read && READ_MEANING[read.result] ? t({ call_outcome: READ_MEANING[read.result] }) : "";
      const outcome = a.outcome_cat === "noshow" || a.status === "noshow" ? t({ attendance: "noshow" }) : a.outcome_cat === "rescheduled" ? t({ attendance: "rescheduled" })
        : a.call_outcome_cat ? t({ call_outcome: a.call_outcome_cat as CallMeaning }) : a.set_since ? t({ call_outcome: "qualified" }) : byRead;
      const over = DateTime.fromJSDate(a.ends_at ?? a.starts_at) < now;
      const fromRead = !!byRead && outcome === byRead && !a.set_since && !a.call_outcome_cat;
      calls.push({ appointment_id: a.id, contact_id: a.contact_id, contact: a.contact || "—", starts_at: a.starts_at.toISOString(), href_contact: href(a.ghl_contact_id), recording_url: read?.share_url ?? null,
        kind: "triage", outcome, ...(over && !outcome ? { hint: read ? "Jev could not tell what this call achieved." : "Nothing recorded for this triage call yet." } : {}), ...(a.set_since && !a.call_outcome_cat ? { hint: "They booked a closing call since: set." } : {}),
        ...(fromRead ? { hint: "Jev's read of the call: check it." } : {}),
        revenue: null, cash: null, next_date: null, next_steps: "", dq_reason: fromRead && read!.result === "dq" ? dqOption(read!.dq_reason) : "", dq_note: "", lost_reason: "", about: read?.digest ?? "", notes: a.notes ?? "", extra: {} });
      continue;
    }
    const rec = await one<{ share_url: string | null; analysis: Record<string, unknown> }>(c, "select share_url, analysis from recordings where company_id=$1 and (appointment_id=$2 or (contact_id=$3 and started_at between $4 and $5)) order by started_at desc limit 1", [company.id, a.id, a.contact_id, from.toJSDate(), to.toJSDate()]);
    const notes = (rec?.analysis?.notes ?? {}) as Record<string, unknown>;
    // D119: a day whose payments were all deposits pre-fills Deposit; the amount says nothing about it
    const pay = await one<{ total: string; all_deposit: boolean }>(c, "select coalesce(sum(amount),0)::text as total, coalesce(bool_and(kind='deposit'),false) as all_deposit from payments where company_id=$1 and contact_id=$2 and status='succeeded' and paid_at between $3 and $4", [company.id, a.contact_id, from.toJSDate(), to.toJSDate()]);
    const won = await one<{ v: string | null }>(c, "select contract_value::text as v from opportunities where company_id=$1 and contact_id=$2 and status='won' and won_at between $3 and $4 order by won_at desc limit 1", [company.id, a.contact_id, from.toJSDate(), to.toJSDate()]);
    const paid = num(pay?.total), contract = won?.v ? num(won.v) : price;
    const disp = str(notes.disposition);
    // D80 (replaces D54's presumption): only evidence pre-fills. A past call with no recording, no outcome and no money opens BLANK with a hint, so a
    // failed recording or a phone call never becomes a no-show because nobody changed a default
    const over = DateTime.fromJSDate(a.ends_at ?? a.starts_at) < now;
    // what the ledger says first (a recorded or marked outcome, then money), then Jev's read of the transcript as the tentative pre-set
    // the company's own answer for what the ledger holds (B6): each outcome is found by what it means, not by its key
    const byCall = a.call_outcome_cat ? v({ call_outcome: a.call_outcome_cat as CallMeaning }) || (a.call_outcome_cat === "deposit" ? v({ call_outcome: "closed" }) : "") : "";
    const outcome: string = a.outcome_cat === "noshow" || a.status === "noshow" ? v({ attendance: "noshow" }) : a.outcome_cat === "rescheduled" ? v({ attendance: "rescheduled" })
      : byCall || (paid > 0 ? (pay?.all_deposit ? v({ call_outcome: "deposit" }) || v({ call_outcome: "closed" }) : v({ call_outcome: "closed" })) : won ? v({ call_outcome: "closed" })
      : disp === "closed_won" ? v({ call_outcome: "closed" }) : disp === "follow_up" ? v({ call_outcome: "follow_up" }) : disp === "close_pending" ? v({ call_outcome: "pending" }) || v({ call_outcome: "follow_up" }) : disp === "lost" ? v({ call_outcome: "lost" }) : disp === "dq" ? v({ call_outcome: "unqualified" }) : "");
    const money = isMoney(outcome, fields), contracted = isRevenueOutcome(outcome, fields);
    // A1 (D88): a card dragged to Lost or Disqualified filed the outcome; the form says so and asks why
    const moved = a.via === "card_moved" && (a.call_outcome_cat === "lost" || a.call_outcome_cat === "unqualified") ? `${a.notes ?? "Moved in the CRM"}. Say why.` : "";
    const aboutParts = [str(notes.summary), str(notes.pain) && `Pains: ${str(notes.pain)}`, str(notes.desire) && `Goals: ${str(notes.desire)}`, str(notes.objections) && `Objections: ${str(notes.objections)}`].filter(Boolean);
    calls.push({ appointment_id: a.id, contact_id: a.contact_id, contact: a.contact || "—", starts_at: a.starts_at.toISOString(), href_contact: loc && a.ghl_contact_id ? `https://app.gohighlevel.com/v2/location/${loc}/contacts/detail/${a.ghl_contact_id}` : null, recording_url: rec?.share_url ?? null,
      kind: "closing", outcome, ...(over && !rec && !outcome ? { hint: "No recording found for this call." } : {}), ...(moved ? { moved } : {}), revenue: contracted ? contract || paid || null : null, cash: money ? paid || null : null,
      next_date: str(notes.next_step_date) || null, next_steps: str(notes.next_step), dq_reason: "", dq_note: "", lost_reason: "", about: aboutParts.join("\n"), notes: a.notes ?? "", extra: {},
      // D225: what was filed, else the call review's read of the transcript (the closer confirms it)
      pitched: a.pitched === true ? "Yes" : a.pitched === false ? "No" : notes.pitched === true ? "Yes" : notes.pitched === false ? "No" : "" });
  }
  // D156: the setter's outbound calls with anyone who had no triage call with them that day, each a row; the answer filed before comes back
  for (const r of reads.filter((x) => !triaged.has(x.contact_id))) {
    const d = (m: Parameters<typeof valueFor>[1]) => valueFor(fields, m, "dial");
    const said = r.filed ?? r.result, outcome = READ_MEANING[said] ? d({ call_outcome: READ_MEANING[said] }) : "";
    calls.push({ appointment_id: dialId(r.conversation), contact_id: r.contact_id, contact: r.contact, starts_at: r.started_at.toISOString(), href_contact: href(r.ghl_contact_id), recording_url: r.share_url,
      kind: "dial", outcome, ...(!outcome ? { hint: "Jev could not tell what this call achieved." } : !r.filed ? { hint: "Jev's read of the call: check it." } : {}),
      revenue: null, cash: null, next_date: null, next_steps: "", dq_reason: !r.filed && r.result === "dq" ? dqOption(r.dq_reason) : "", dq_note: "", lost_reason: "", about: r.digest, notes: "", extra: {} });
  }
  calls.sort((x, y) => x.starts_at.localeCompare(y.starts_at));
  return { day, closer, company: { id: company.id, name: company.name, slug: company.slug, timezone: tz }, ...totalsOf(calls, fields), calls };
}

/** The closer's end-of-day picture for a run about them (context root user.eod): today's calls and whether today is filed, and every earlier day in the last week with calls and no report. Lines are ready to post. */
export async function eodFacts(c: PoolClient, company: CompanyRow, userId: string, base: string, now = DateTime.now(), lookbackDays = 7): Promise<{ day: string; url: string; today: { calls: number; filed: boolean; line: string; open: string[]; moved: string[] }; earlier: { day: string; label: string; calls: number; url: string; open: string[]; moved: string[] }[]; earlier_count: number; earlier_lines: string; all_lines: string }> {
  const tz = company.timezone, local = now.setZone(tz), day = local.toFormat(DAY_FMT);
  const token = await tokenFor(c, userId), url = `${base}/eod/${token}`;
  // calls: the day's held calls with no answer on the ledger yet (a no-show, a call rescheduled on the call or a call
  // outcome is an answer; "showed" alone is not); open: those calls, for the reminder to check against GHL (D76)
  // A1 (D88): a call a card move filed as lost or DQ is still owed until the day is filed, so the closer says why
  const rows = await many<{ day: string; calls: number; open: string[]; moved: string[]; filed: boolean }>(c, `
    select d.day::text as day, count(a.id)::int as calls, coalesce(array_agg(a.id::text) filter (where a.id is not null), '{}') as open,
           coalesce(array_agg(a.id::text) filter (where a.id is not null and a.call_outcome_term is not null), '{}') as moved,
           exists (select 1 from eod_reports r where r.company_id=$1 and r.user_id=$2 and r.day=d.day and r.submitted_at is not null) as filed
    from (select generate_series(($3::date - interval '${lookbackDays} days')::date, $3::date, interval '1 day')::date as day) d
    left join (appointments a left join company_terms ot on ot.id=a.outcome_term left join company_terms cot on cot.id=a.call_outcome_term)
      on a.company_id=$1 and a.assigned_user_id=$2 and ${HELD_CALL} and (a.starts_at at time zone $4)::date = d.day
         and ((a.call_outcome_term is null and coalesce(ot.category, '') not in ('noshow', 'rescheduled', 'cancelled'))
           or (cot.category in ('lost', 'unqualified') and (select fs.answers->>'via' from form_submissions fs where fs.appointment_id=a.id order by fs.submitted_at desc limit 1) = 'card_moved'))
    group by d.day order by d.day`, [company.id, userId, day, tz]);
  // D156: a setter's outbound calls not answered on the end of day are owed too (a call with someone triaged with them that day is that row)
  if (await setterCallsOn(c, company.id)) {
    const from = local.minus({ days: lookbackDays }).startOf("day"), to = local.endOf("day");
    const triaged = new Set((await many<{ k: string }>(c, `select a.contact_id::text || '|' || to_char(a.starts_at at time zone $4, 'YYYY-MM-DD') as k from appointments a join company_terms t on t.id=a.appointment_term
      where a.company_id=$1 and a.assigned_user_id=$2 and t.category='first_call' and a.starts_at between $3 and $5 and ${HELD_CALL}`, [company.id, userId, from.toJSDate(), tz, to.toJSDate()])).map((r) => r.k));
    for (const r of await setterReads(c, company.id, tz, userId, from, to)) {
      if (r.filed || triaged.has(`${r.contact_id}|${r.day}`)) continue;
      const row = rows.find((x) => x.day === r.day); if (row) row.calls++;
    }
  }
  const label = (d: string) => DateTime.fromFormat(d, DAY_FMT, { zone: tz }).toFormat("ccc LLL d");
  const today = rows.find((r) => r.day === day) ?? { day, calls: 0, open: [], moved: [], filed: false };
  const earlier = rows.filter((r) => r.day < day && r.calls > 0 && !r.filed).map((r) => ({ day: r.day, label: label(r.day), calls: r.calls, url: `${url}?day=${r.day}`, open: r.open, moved: r.moved }));
  const line = (d: { label: string; calls: number; url: string }, when: string) => `• <${d.url}|${when}>: ${d.calls} call${d.calls === 1 ? "" : "s"}`;
  const todayLine = today.calls && !today.filed ? line({ label: "today", calls: today.calls, url }, "today") : "";
  const earlierLines = earlier.map((d) => line(d, d.label)).join("\n");
  return { day, url, today: { calls: today.calls, filed: today.filed, line: todayLine, open: today.open, moved: today.moved }, earlier, earlier_count: earlier.length, earlier_lines: earlierLines, all_lines: [todayLine, earlierLines].filter(Boolean).join("\n") };
}

export type Change = { field: string; from: unknown; to: unknown; contact?: string };
/**
 * What the closer corrected, as lines a person reads: "calls today 6 → 7", "Sarah: Follow up → Closed", "Sarah: cash $1,500 → $2,000".
 * Only a value the engine HAD and the closer changed is a correction; a blank they filled in is just their answer (D80).
 */
const TOTAL_WORDS = { calls_count: "calls today", closes: "closes", deposits: "deposits", cash: "cash collected", revenue: "revenue generated" } as const;
const CALL_WORDS = { cash: "cash collected", revenue: "revenue generated", next_date: "follow-up date" } as const;
const money = (v: unknown) => `$${num(v).toLocaleString("en-US")}`;
const dayWords = (v: unknown) => { const d = DateTime.fromISO(String(v ?? "")); return d.isValid ? d.toFormat("ccc LLL d") : String(v ?? ""); };
export function diffAnswers(pre: EodPrefill, ans: EodAnswers, fields?: EodField[]): Change[] {
  const out: Change[] = [];
  for (const k of ["calls_count", "closes", "deposits", "cash", "revenue"] as const) if (num(pre[k]) !== num(ans[k])) out.push({ field: TOTAL_WORDS[k], from: k === "cash" || k === "revenue" ? money(pre[k]) : num(pre[k]), to: k === "cash" || k === "revenue" ? money(ans[k]) : num(ans[k]) });
  for (const call of ans.calls) {
    const p = pre.calls.find((x) => x.appointment_id === call.appointment_id); if (!p) continue;
    if (p.outcome && p.outcome !== call.outcome) out.push({ field: "", from: outcomeLabel(p.outcome, fields, p.kind), to: outcomeLabel(call.outcome, fields, p.kind), contact: p.contact });
    for (const k of ["cash", "revenue", "next_date"] as const) {
      const a = p[k] ?? "", b = call[k] ?? "";
      if (a === "" || String(a) === String(b)) continue;
      const show = k === "next_date" ? dayWords : money;
      out.push({ field: CALL_WORDS[k], from: show(a), to: b === "" ? "removed" : show(b), contact: p.contact });
    }
  }
  return out;
}
export const changeLine = (ch: Change) => `${ch.contact ? `${ch.contact}: ` : ""}${ch.field ? `${ch.field} ` : ""}${fmt(ch.from)} → ${fmt(ch.to)}`;

/** The disposition note for one call: everything the closer said about it, one line per thing. */
function dispositionNotes(call: CallEntry, fields: EodField[]): string {
  const meaning = choiceOf(call.outcome, fields, call.kind)?.call_outcome;
  const lines = [
    call.about && `About: ${call.about}`,
    call.notes,
    meaning === "unqualified" && (call.dq_reason || call.dq_note) ? `DQ: ${[call.dq_reason, call.dq_note].filter(Boolean).join(" - ")}` : "",
    meaning === "lost" && call.lost_reason ? `Lost: ${call.lost_reason}` : "",
    call.pitched && pitchedOf(call, fields) !== null && !isMoney(call.outcome, fields, call.kind) ? `Pitched: ${call.pitched}` : "",
    meaning === "follow_up" && (call.next_steps || call.next_date) ? `Next: ${call.next_steps}${call.next_date ? ` by ${call.next_date}` : ""}` : "",
    isMoney(call.outcome, fields, call.kind) ? `${outcomeLabel(call.outcome, fields)}: ${call.cash == null ? "?" : money(call.cash)} collected${isRevenueOutcome(call.outcome, fields) ? `, ${call.revenue == null ? "?" : money(call.revenue)} revenue generated` : ""}` : "",
    ...fields.filter((f) => f.scope === "call" && !f.builtin && !isSetterCall(call.kind) && call.extra?.[f.key]).map((f) => `${f.label}: ${call.extra[f.key]}`),
  ];
  return lines.filter(Boolean).join("\n");
}

/**
 * One call's answer through the disposition path, as the end-of-day form files it: "filed", "held" when the ledger already holds that
 * answer (filed before, a card moved by hand, the CRM's no-show; Call outcome filed already posted it, and a second run would post it
 * twice), "skipped" for no answer, an answer the company's list lacks, or an appointment that vanished. D126: the harness files one
 * staged call through this too. D134/D136: GHL decides, not the ledger. `ghl` is the call's Sales Call as GHL has it (read at
 * submit): an answer is held only when GHL already shows it; GHL blank or saying something else, it is filed again so Call
 * outcome filed writes GHL (a first filing that ran in ghost never reached it). No Sales Call read (GHL did not answer, or there
 * is none): the ledger decides, as before.
 */
export async function fileCall(c: PoolClient, companyId: string, fields: EodField[], call: CallEntry, userId: string, ghl?: { attendance: string | null; call: string | null }): Promise<{ status: "filed" | "held" | "skipped"; runs: number }> {
  const skipped = { status: "skipped" as const, runs: 0 };
  if (!call.outcome) return skipped;
  // B6: what the company's answer means decides what is filed, whatever the answer is called
  const choice = choiceOf(call.outcome, fields, call.kind); if (!choice) return skipped;
  const outcomeCat = choice.attendance;
  const outcomeTermId = await outcomeTermFor(c, companyId, outcomeCat); if (!outcomeTermId) return skipped;
  const callTerm = async (cat: string) => (await one<{ id: string }>(c, "select id from company_terms where company_id=$1 and domain='call_outcome' and category=$2 and active order by is_default desc, sort limit 1", [companyId, cat]))?.id ?? null;
  const callCat = choice.attendance === "showed" ? choice.call_outcome ?? null : null;
  const callOutcomeTermId = callCat ? (await callTerm(callCat)) ?? (callCat === "deposit" ? await callTerm("closed") : null) : null;
  const held = await one<{ outcome_term: string | null; call_outcome_term: string | null; status: string; pitched: boolean | null }>(c, "select outcome_term, call_outcome_term, status, pitched from appointments where id=$1 and company_id=$2", [call.appointment_id, companyId]);
  // D225: whether they were pitched rides on the filing; a refiled day that changes only that corrects it in place (filing the call
  // again would run Call outcome filed twice: its posts, its tags)
  const pitched = pitchedOf(call, fields);
  if (held && pitched !== null && held.pitched !== pitched) await c.query("update appointments set pitched=$2 where id=$1 and company_id=$3", [call.appointment_id, pitched, companyId]);
  // what GHL shows for this answer: a company with no deposit disposition writes a deposit as a close (as its call outcome term does)
  // a triage call's record (D143) holds the meaning itself (triageRecords); a Sales Call holds the company's disposition
  const dispositions = ghl && callCat && !isSetterCall(call.kind) ? dispositionValues(Object.fromEntries((await many<{ key: string; value: Buffer }>(c, "select key, value from bindings where company_id=$1 and key='sales_call.dispositions'", [companyId])).map((b) => [b.key, b.value.toString("utf8")]))) : {};
  const shownAs = !isSetterCall(call.kind) && callCat && !dispositions[callCat] && callCat === "deposit" ? "closed" : callCat;
  const ghlShows = ghl ? ghl.attendance === outcomeCat && (outcomeCat !== "showed" || !shownAs || ghl.call === shownAs) : null;
  if (ghlShows === true) return { status: "held", runs: 0 };
  if (ghlShows === null && held && (held.outcome_term === outcomeTermId ? outcomeCat !== "showed" || held.call_outcome_term === callOutcomeTermId : outcomeCat === "noshow" && !held.outcome_term && held.status === "noshow")) return { status: "held", runs: 0 };
  try { return { status: "filed", runs: (await recordDisposition(c, { companyId, appointmentId: call.appointment_id, outcomeTermId, callOutcomeTermId, notes: dispositionNotes(call, fields), dqReason: choice.call_outcome === "unqualified" ? call.dq_reason || undefined : undefined, pitched, userId })).runs }; } catch { return skipped; }
}

/**
 * D156: an outbound call's answer: setter_call.filed, which the company's Setter call filed workflow takes (the Discovery Call record
 * of the conversation, the setter card). "held" when the end of day last filed this conversation the same way, so a refiled day writes
 * nothing twice.
 */
export async function fileDial(c: PoolClient, companyId: string, fields: EodField[], call: CallEntry, setter: { id: string; name: string }): Promise<{ status: "filed" | "held" | "skipped"; runs: number }> {
  const skipped = { status: "skipped" as const, runs: 0 };
  const choice = call.outcome ? choiceOf(call.outcome, fields, "dial") : undefined;
  const result = choice?.call_outcome ? TRIAGE_RESULT[choice.call_outcome] : undefined;
  if (!result) return skipped;
  const conversation = call.appointment_id.replace(/^dial:/, "");
  const read = await one<{ contact_id: string; data: Record<string, string> }>(c, "select contact_id, data from events where company_id=$1 and event_type='setter_call.result' and data->>'external_id'=$2 order by id desc limit 1", [companyId, conversation]);
  if (!read) return skipped;
  const last = await one<{ data: Record<string, string> }>(c, "select data from events where company_id=$1 and event_type='setter_call.filed' and data->>'conversation'=$2 order by id desc limit 1", [companyId, conversation]);
  const dq = result === "dq";
  const rec = await one<{ started_at: Date; share_url: string | null; direction: string | null; duration_sec: string | null; ghl_user_id: string | null }>(c, `select r.started_at, r.share_url, r.raw->>'direction' as direction, r.raw->>'duration_sec' as duration_sec,
    (select u.ghl_user_id from users u where u.id=$3) as ghl_user_id from recordings r where r.company_id=$1 and r.id::text=$2`, [companyId, read.data.recording_id ?? "", setter.id]);
  const data = { conversation, recording_id: read.data.recording_id, started_at: rec?.started_at.toISOString() ?? null, recording_url: rec?.share_url ?? "", direction: rec?.direction ?? "", duration_sec: rec?.duration_sec ?? "",
    setter: setter.name, setter_ghl_user_id: rec?.ghl_user_id ?? "", user_id: setter.id, result, predicted: read.data.result ?? "", jev_agreed: (read.data.result ?? "") === result,
    dq_reason: dq ? call.dq_reason : "", dq_note: dq ? call.dq_note : "", about: call.about, notes: call.notes, note: dispositionNotes(call, fields) };
  if (last && last.data.result === result && (last.data.dq_reason ?? "") === data.dq_reason) return { status: "held", runs: 0 };
  const ev = await emitEvent(c, { company_id: companyId, contact_id: read.contact_id, opportunity_id: null, appointment_id: null, event_type: "setter_call.filed", source: "user", data });
  return { status: "filed", runs: (await dispatchEvent(c, ev, { contact: { id: read.contact_id } })).length };
}

/** File the day: check the required answers, store it, record each call's outcome through the disposition path, tell the alerts channel what was corrected, tick the DM. */
export async function submitEod(c: PoolClient, args: { token: string; day: string; answers: EodAnswers; adapters?: Adapters }): Promise<{ ok: true; changes: Change[]; recorded: number } | { ok: false; why: string }> {
  const closer = await closerByToken(c, args.token); if (!closer || !closer.active || !closer.company_id) return { ok: false, why: "this link is not for anyone" };
  const { row: company, adapterCompany, bindings } = await loadCompany(c, closer.company_id);
  const fields = await loadEodForm(c, company.id);
  const missing = missingAnswers(fields, args.answers.calls, args.answers.day_answers ?? {});
  if (missing.length) return { ok: false, why: `Still needed: ${missing.join("; ")}` };
  const impossible = impossibleAnswers(args.answers.calls);
  if (impossible.length) return { ok: false, why: `Check ${impossible.join("; ")}` };
  const pre = await prefill(c, company, closer, args.day, DateTime.now());
  // a row that is not a booking (a "ghl:<record>" row from a form opened before D110) is dropped before anything is stored; D156: nor is
  // an outbound-call row the engine did not put on this day
  args = { ...args, answers: { ...args.answers, calls: args.answers.calls.filter((x) => BOOKING_ID.test(x.appointment_id) || (DIAL_ID.test(x.appointment_id) && pre.calls.some((p) => p.appointment_id === x.appointment_id))) } };
  // D143: what a call is comes from the booking, never from the browser
  args = { ...args, answers: { ...args.answers, calls: args.answers.calls.map((x) => ({ ...x, kind: pre.calls.find((p) => p.appointment_id === x.appointment_id)?.kind ?? x.kind })) } };
  const changes = diffAnswers(pre, args.answers, fields);
  // D134/D136: each call's Sales Call as GHL has it decides whether the answer is still to be filed; GHL not read: the ledger decides
  let inGhl = new Map<string, { attendance: string | null; call: string | null }>();
  if (args.adapters) { try { inGhl = new Map((await closerSalesCalls(c, args.adapters, adapterCompany, company.id, bindings, closer.name, company.timezone, DateTime.now())).map((r) => [r.appointment_id, { attendance: r.attendance, call: r.call }])); } catch { /* GHL did not answer */ } }
  const triage = args.answers.calls.filter((x) => x.kind === "triage").map((x) => x.appointment_id);
  if (args.adapters && triage.length) { try { for (const [k, v] of await triageRecords(c, args.adapters, adapterCompany, company.id, bindings, triage)) inGhl.set(k, v); } catch { /* GHL did not answer */ } }
  let recorded = 0;
  for (const call of args.answers.calls) {
    const r = call.kind === "dial" ? await fileDial(c, company.id, fields, call, closer) : await fileCall(c, company.id, fields, call, closer.id, inGhl.get(call.appointment_id));
    if (r.status !== "skipped") recorded++;
  }
  const wasFiled = (await one<{ submitted_at: Date | null }>(c, "select submitted_at from eod_reports where company_id=$1 and user_id=$2 and day=$3", [company.id, closer.id, args.day]))?.submitted_at ?? null;
  const row = await one<{ id: string }>(c, `insert into eod_reports (company_id, user_id, day, prefill, answers, changes, submitted_at) values ($1,$2,$3,$4,$5,$6,now())
    on conflict (company_id, user_id, day) do update set prefill=excluded.prefill, answers=excluded.answers, changes=excluded.changes, submitted_at=now() returning id`, [company.id, closer.id, args.day, JSON.stringify(pre), JSON.stringify(args.answers), JSON.stringify(changes)]);
  // the report is an event: the eod-filed workflow posts the summary, threads under the reminder, sends it wherever else the company wants it
  const corrections = changes.map(changeLine);
  const dayAnswers = fields.filter((f) => f.scope === "day" && args.answers.day_answers?.[f.key]).map((f) => ({ key: f.key, label: f.label, answer: args.answers.day_answers[f.key] }));
  const ev = await emitEvent(c, { company_id: company.id, contact_id: null, opportunity_id: null, appointment_id: null, event_type: "eod.filed", source: "user",
    data: { user_id: closer.id, report_id: row?.id, day: args.day, day_label: DateTime.fromFormat(args.day, DAY_FMT).toFormat("ccc LLL d"), totals_line: totalsLine(args.answers, pitchCount(args.answers.calls, fields)), pitched: pitchCount(args.answers.calls, fields), held_calls: heldCount(args.answers.calls, fields), calls_count: args.answers.calls_count, closes: args.answers.closes, deposits: args.answers.deposits, cash: args.answers.cash, revenue: args.answers.revenue,
      calls: args.answers.calls.map((x) => ({ contact: x.contact, contact_id: x.contact_id, appointment_id: x.appointment_id, kind: x.kind ?? "closing", outcome: x.outcome, outcome_label: outcomeLabel(x.outcome, fields, x.kind), meaning: choiceOf(x.outcome, fields, x.kind)?.call_outcome ?? choiceOf(x.outcome, fields, x.kind)?.attendance ?? null, revenue: x.revenue, cash: x.cash, next_date: x.next_date, next_steps: x.next_steps, dq_reason: x.dq_reason, dq_note: x.dq_note, lost_reason: x.lost_reason ?? "", pitched: pitchedOf(x, fields) === null ? "" : pitchedOf(x, fields) ? "Yes" : "No", not_pitched: pitchedOf(x, fields) === false, about: x.about, notes: x.notes, ...x.extra })),
      // A1 (D88): why each lost or DQ call went that way, for the summary
      reasons: args.answers.calls.map((x) => ({ x, m: choiceOf(x.outcome, fields, x.kind)?.call_outcome })).filter(({ x, m }) => (m === "lost" && x.lost_reason) || (m === "unqualified" && (x.dq_reason || x.dq_note)))
        .map(({ x, m }) => ({ contact: x.contact, outcome_label: outcomeLabel(x.outcome, fields, x.kind), reason: m === "lost" ? x.lost_reason : [x.dq_reason, x.dq_note].filter(Boolean).join(" - ") })),
      corrections, corrections_lines: corrections.map((x) => `• ${x}`).join("\n"), corrections_block: corrections.length ? `*Corrected from what the engine had:*\n${corrections.map((x) => `• ${x}`).join("\n")}` : "", corrections_count: corrections.length, corrected: corrections.length > 0, day_answers: dayAnswers, day_answers_lines: dayAnswers.map((d) => `*${d.label}* ${d.answer}`).join("\n"), refiled: !!wasFiled } });
  await dispatchEvent(c, ev, { user: { id: closer.id } });
  return { ok: true, changes, recorded };
}
const fmt = (v: unknown) => (typeof v === "number" ? v.toLocaleString("en-US") : String(v ?? "blank"));
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
/** D225: the closing calls that happened, and how many of them were pitched (a close or a deposit was). */
export const heldCount = (calls: CallEntry[], fields: EodField[]) => calls.filter((x) => !isSetterCall(x.kind) && choiceOf(x.outcome, fields, x.kind)?.attendance === "showed").length;
export const pitchCount = (calls: CallEntry[], fields: EodField[]) => calls.filter((x) => pitchedOf(x, fields) === true).length;
/** "3 calls, 2 pitched, 1 close, 1 deposit, $1,500 collected, $4,000 revenue generated" (deposits only when there are any; pitched when known, D225). */
export const totalsLine = (t: DayTotals, pitched?: number) => [plural(t.calls_count, "call"), pitched === undefined ? "" : `${pitched} pitched`, plural(t.closes, "close"), t.deposits ? plural(t.deposits, "deposit") : "", `$${t.cash.toLocaleString("en-US")} collected`, `$${t.revenue.toLocaleString("en-US")} revenue generated`].filter(Boolean).join(", ");

export const reportFor = (c: PoolClient, companyId: string, userId: string, day: string) => one<{ id: string; submitted_at: Date | null; answers: EodAnswers | null; changes: Change[]; reminded_at: Date | null }>(c, "select id, submitted_at, answers, changes, reminded_at from eod_reports where company_id=$1 and user_id=$2 and day=$3", [companyId, userId, day]);
export const companyReports = (c: PoolClient, companyId: string, limit = 60) => many<{ id: string; day: string; closer: string; submitted_at: Date | null; reminded_at: Date | null; answers: EodAnswers | null; changes: Change[] }>(c, "select r.id, r.day::text as day, u.name as closer, r.submitted_at, r.reminded_at, r.answers, r.changes from eod_reports r join users u on u.id=r.user_id where r.company_id=$1 order by r.day desc, u.name limit $2", [companyId, limit]);
