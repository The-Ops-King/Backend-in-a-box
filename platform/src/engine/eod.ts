import type { PoolClient } from "pg";
import { randomBytes } from "node:crypto";
import { DateTime } from "luxon";
import { many, one } from "@/db/client";
import type { Adapters } from "@/adapters/types";
import { decrypt } from "./crypto";
import { loadCompany, type CompanyRow } from "./context";
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
export type EodPrefill = DayTotals & { day: string; closer: { id: string; name: string; email: string }; company: { id: string; name: string; slug: string; timezone: string }; calls: CallEntry[] };
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

/** Their day as the engine saw it. Every value here is a prefill the closer may correct. */
export async function prefill(c: PoolClient, company: CompanyRow, closer: { id: string; name: string; email: string }, day: string, now: DateTime = DateTime.now()): Promise<EodPrefill> {
  const tz = company.timezone;
  const from = DateTime.fromFormat(day, DAY_FMT, { zone: tz }).startOf("day"), to = from.endOf("day");
  const appts = await many<{ id: string; contact_id: string; contact: string; ghl_contact_id: string | null; starts_at: Date; ends_at: Date | null; status: string; outcome_cat: string | null; call_outcome_cat: string | null; notes: string | null }>(c, `
    select a.id, a.contact_id, trim(coalesce(ct.first_name,'')||' '||coalesce(ct.last_name,'')) as contact, ct.ghl_contact_id, a.starts_at, a.ends_at, a.status,
           ot.category as outcome_cat, cot.category as call_outcome_cat,
           (select fs.answers->>'notes' from form_submissions fs where fs.appointment_id=a.id order by fs.submitted_at desc limit 1) as notes
    from appointments a join contacts ct on ct.id=a.contact_id left join company_terms ot on ot.id=a.outcome_term left join company_terms cot on cot.id=a.call_outcome_term
    where a.company_id=$1 and a.assigned_user_id=$2 and a.starts_at >= $3 and a.starts_at <= $4 and a.status not in ('cancelled','invalid') order by a.starts_at`, [company.id, closer.id, from.toJSDate(), to.toJSDate()]);
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
  return { day, closer, company: { id: company.id, name: company.name, slug: company.slug, timezone: tz }, ...totalsOf(calls), calls };
}

/** The closer's end-of-day picture for a run about them (context root user.eod): today's calls and whether today is filed, and every earlier day in the last week with calls and no report. Lines are ready to post. */
export async function eodFacts(c: PoolClient, company: CompanyRow, userId: string, base: string, now = DateTime.now()): Promise<{ day: string; url: string; today: { calls: number; filed: boolean; line: string }; earlier: { day: string; label: string; calls: number; url: string }[]; earlier_count: number; earlier_lines: string; all_lines: string }> {
  const tz = company.timezone, local = now.setZone(tz), day = local.toFormat(DAY_FMT);
  const token = await tokenFor(c, userId), url = `${base}/eod/${token}`;
  const rows = await many<{ day: string; calls: number; filed: boolean }>(c, `
    select d.day::text as day, count(a.id)::int as calls, exists (select 1 from eod_reports r where r.company_id=$1 and r.user_id=$2 and r.day=d.day and r.submitted_at is not null) as filed
    from (select generate_series(($3::date - interval '7 days')::date, $3::date, interval '1 day')::date as day) d
    left join appointments a on a.company_id=$1 and a.assigned_user_id=$2 and a.status not in ('cancelled','invalid') and (a.starts_at at time zone $4)::date = d.day
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
  const pre = await prefill(c, company, closer, args.day);
  const changes = diffAnswers(pre, args.answers);
  let recorded = 0;
  const outcomeTerm = async (cat: string) => outcomeTermFor(c, company.id, cat);
  const callTerm = async (cat: string) => (await one<{ id: string }>(c, "select id from company_terms where company_id=$1 and domain='call_outcome' and category=$2 and active order by is_default desc, sort limit 1", [company.id, cat]))?.id ?? null;
  for (const call of args.answers.calls) {
    if (!call.outcome) continue;
    const outcomeTermId = await outcomeTerm(call.outcome === "no_show" ? "noshow" : call.outcome === "rescheduled" ? "rescheduled" : "showed"); if (!outcomeTermId) continue;
    const callCat = call.outcome === "closed" ? "closed" : call.outcome === "deposit" ? "deposit" : call.outcome === "follow_up" ? "follow_up" : call.outcome === "lost" ? "lost" : call.outcome === "dq" ? "unqualified" : null;
    const callOutcomeTermId = callCat ? (await callTerm(callCat)) ?? (callCat === "deposit" ? await callTerm("closed") : null) : null;
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
