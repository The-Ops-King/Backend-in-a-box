import type { PoolClient } from "pg";
import { randomBytes } from "node:crypto";
import { DateTime } from "luxon";
import { many, one } from "@/db/client";
import type { Adapters } from "@/adapters/types";
import { decrypt } from "./crypto";
import { loadCompany, type CompanyRow } from "./context";
import { outcomeTermFor, recordDisposition } from "./disposition";
import { destinationsFor } from "./alerts";

/**
 * D34. The closer's end-of-day report: one link per closer, no login. Opening it shows their day prefilled from what the
 * engine already knows (calendar, recordings and Jev's notes, payments); every value is editable; submitting records each
 * call's outcome through the disposition path (so the no-show texts and the CRM records follow), and anything they changed
 * from the prefill is posted to the alerts channel, because a wrong prefill is a data gap to fix at the source.
 * A DM goes out at the company's end-of-day time on days they had calls and have not filed; filing gets a ✅ on that DM.
 */
export type CallOutcome = "close" | "follow_up" | "no_show" | "lost" | "";
export type CallEntry = {
  appointment_id: string; contact_id: string; contact: string; starts_at: string; href_contact: string | null;
  attendance: "showed" | "no_show" | ""; outcome: CallOutcome;
  revenue: number | null; cash: number | null;                  // a close
  next_date: string | null; next_steps: string;                // a follow-up
  pains: string; goals: string; objections: string; notes: string;
  recording_url: string | null;
};
export type EodPrefill = { day: string; closer: { id: string; name: string; email: string }; company: { id: string; name: string; slug: string; timezone: string }; calls_count: number; closes: number; cash: number; revenue: number; calls: CallEntry[] };
export type EodAnswers = { calls_count: number; closes: number; cash: number; revenue: number; calls: CallEntry[]; general_notes?: string };

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
export async function prefill(c: PoolClient, company: CompanyRow, closer: { id: string; name: string; email: string }, day: string, base = ""): Promise<EodPrefill> {
  const tz = company.timezone;
  const from = DateTime.fromFormat(day, DAY_FMT, { zone: tz }).startOf("day"), to = from.endOf("day");
  const appts = await many<{ id: string; contact_id: string; contact: string; ghl_contact_id: string | null; starts_at: Date; status: string; outcome_cat: string | null; call_outcome_cat: string | null; notes: string | null }>(c, `
    select a.id, a.contact_id, trim(coalesce(ct.first_name,'')||' '||coalesce(ct.last_name,'')) as contact, ct.ghl_contact_id, a.starts_at, a.status,
           ot.category as outcome_cat, cot.category as call_outcome_cat,
           (select fs.answers->>'notes' from form_submissions fs where fs.appointment_id=a.id order by fs.submitted_at desc limit 1) as notes
    from appointments a join contacts ct on ct.id=a.contact_id left join company_terms ot on ot.id=a.outcome_term left join company_terms cot on cot.id=a.call_outcome_term
    where a.company_id=$1 and a.assigned_user_id=$2 and a.starts_at >= $3 and a.starts_at <= $4 and a.status not in ('cancelled','invalid') order by a.starts_at`, [company.id, closer.id, from.toJSDate(), to.toJSDate()]);
  const calls: CallEntry[] = [];
  let closes = 0, cash = 0, revenue = 0;
  const loc = (await one<{ v: Buffer }>(c, "select value as v from bindings where company_id=$1 and key='crm.location_id'", [company.id]))?.v.toString("utf8");
  for (const a of appts) {
    const rec = await one<{ share_url: string | null; analysis: Record<string, unknown> }>(c, "select share_url, analysis from recordings where company_id=$1 and (appointment_id=$2 or (contact_id=$3 and started_at between $4 and $5)) order by started_at desc limit 1", [company.id, a.id, a.contact_id, from.toJSDate(), to.toJSDate()]);
    const notes = (rec?.analysis?.notes ?? {}) as Record<string, unknown>;
    const pay = await one<{ total: string }>(c, "select coalesce(sum(amount),0)::text as total from payments where company_id=$1 and contact_id=$2 and status='succeeded' and paid_at between $3 and $4", [company.id, a.contact_id, from.toJSDate(), to.toJSDate()]);
    const won = await one<{ v: string | null }>(c, "select contract_value::text as v from opportunities where company_id=$1 and contact_id=$2 and status='won' and won_at between $3 and $4 order by won_at desc limit 1", [company.id, a.contact_id, from.toJSDate(), to.toJSDate()]);
    const paid = num(pay?.total);
    const disp = str(notes.disposition);
    const attendance: CallEntry["attendance"] = a.status === "showed" || a.outcome_cat === "showed" ? "showed" : a.status === "noshow" || a.outcome_cat === "noshow" ? "no_show" : rec ? "showed" : "";
    const outcome: CallOutcome = a.call_outcome_cat === "closed" || paid > 0 || won ? "close" : a.call_outcome_cat === "follow_up" || disp === "follow_up" || disp === "close_pending" ? "follow_up" : a.call_outcome_cat === "lost" || disp === "lost" || disp === "dq" ? "lost" : attendance === "no_show" ? "no_show" : disp === "closed_won" ? "close" : "";
    if (outcome === "close") { closes++; cash += paid; revenue += won?.v ? num(won.v) : paid; }
    calls.push({ appointment_id: a.id, contact_id: a.contact_id, contact: a.contact || "—", starts_at: a.starts_at.toISOString(), href_contact: loc && a.ghl_contact_id ? `https://app.gohighlevel.com/v2/location/${loc}/contacts/detail/${a.ghl_contact_id}` : null,
      attendance, outcome, revenue: outcome === "close" ? (won?.v ? num(won.v) : paid || null) : null, cash: outcome === "close" ? paid || null : null,
      next_date: str(notes.next_step_date) || null, next_steps: str(notes.next_step), pains: str(notes.pain), goals: str(notes.desire), objections: str(notes.objections), notes: a.notes ?? str(notes.summary), recording_url: rec?.share_url ?? null });
  }
  return { day, closer, company: { id: company.id, name: company.name, slug: company.slug, timezone: tz }, calls_count: calls.length, closes, cash, revenue, calls, ...(base ? {} : {}) };
}

export type Change = { field: string; from: unknown; to: unknown; contact?: string };
/** What the closer corrected, as lines a person reads: "calls today 6 → 7", "Sarah: attendance showed → no_show". */
export function diffAnswers(pre: EodPrefill, ans: EodAnswers): Change[] {
  const out: Change[] = [];
  for (const k of ["calls_count", "closes", "cash", "revenue"] as const) if (num(pre[k]) !== num(ans[k])) out.push({ field: k.replace(/_/g, " "), from: pre[k], to: ans[k] });
  for (const call of ans.calls) {
    const p = pre.calls.find((x) => x.appointment_id === call.appointment_id); if (!p) continue;
    for (const k of ["attendance", "outcome", "revenue", "cash", "next_date"] as const) { const a = p[k] ?? "", b = call[k] ?? ""; if (String(a) !== String(b) && !(a === "" && b === "")) out.push({ field: k.replace(/_/g, " "), from: a || "blank", to: b || "blank", contact: p.contact }); }
  }
  return out;
}

/** File the day: store it, record each call's outcome through the disposition path, tell the alerts channel what was corrected, tick the DM. */
export async function submitEod(c: PoolClient, adapters: Adapters, args: { token: string; day: string; answers: EodAnswers }): Promise<{ ok: true; changes: Change[]; recorded: number } | { ok: false; why: string }> {
  const closer = await closerByToken(c, args.token); if (!closer || !closer.active || !closer.company_id) return { ok: false, why: "this link is not for anyone" };
  const { row: company } = await loadCompany(c, closer.company_id);
  const pre = await prefill(c, company, closer, args.day);
  const changes = diffAnswers(pre, args.answers);
  let recorded = 0;
  const showed = await outcomeTermFor(c, company.id, "showed"), noshow = await outcomeTermFor(c, company.id, "noshow");
  const callTerm = async (cat: string) => (await one<{ id: string }>(c, "select id from company_terms where company_id=$1 and domain='call_outcome' and category=$2 and active order by is_default desc, sort limit 1", [company.id, cat]))?.id ?? null;
  for (const call of args.answers.calls) {
    if (!call.attendance) continue;
    const outcomeTermId = call.attendance === "showed" ? showed : noshow; if (!outcomeTermId) continue;
    const callOutcomeTermId = call.attendance === "no_show" ? null : call.outcome === "close" ? await callTerm("closed") : call.outcome === "follow_up" ? await callTerm("follow_up") : call.outcome === "lost" ? await callTerm("lost") : null;
    const notes = [call.notes, call.pains && `Pains: ${call.pains}`, call.goals && `Goals: ${call.goals}`, call.objections && `Objections: ${call.objections}`, call.next_steps && `Next: ${call.next_steps}${call.next_date ? ` by ${call.next_date}` : ""}`, call.outcome === "close" ? `Closed: revenue ${call.revenue ?? "?"}, cash ${call.cash ?? "?"}` : ""].filter(Boolean).join("\n");
    try { await recordDisposition(c, { companyId: company.id, appointmentId: call.appointment_id, outcomeTermId, callOutcomeTermId, notes, userId: closer.id }); recorded++; } catch { /* an appointment that vanished: the rest still files */ }
  }
  const row = await one<{ id: string; dm_channel: string | null; dm_ts: string | null }>(c, `insert into eod_reports (company_id, user_id, day, prefill, answers, changes, submitted_at) values ($1,$2,$3,$4,$5,$6,now())
    on conflict (company_id, user_id, day) do update set prefill=excluded.prefill, answers=excluded.answers, changes=excluded.changes, submitted_at=now() returning id, dm_channel, dm_ts`, [company.id, closer.id, args.day, JSON.stringify(pre), JSON.stringify(args.answers), JSON.stringify(changes)]);
  // Slack: a ✅ on the reminder, and the corrections to the alerts channel
  const dest = await destinationsFor(c, company.id);
  if (dest.slackToken) {
    if (row?.dm_channel && row.dm_ts) { await adapters.notifier.react(dest.slackToken, row.dm_channel, row.dm_ts, "white_check_mark").catch(() => false); await adapters.notifier.post(dest.slackToken, row.dm_channel, `✅ Got it. ${args.answers.calls_count} call${args.answers.calls_count === 1 ? "" : "s"}, ${args.answers.closes} close${args.answers.closes === 1 ? "" : "s"}, $${args.answers.cash.toLocaleString("en-US")} collected.`, { name: "End of day", icon: ":clipboard:" }, row.dm_ts).catch(() => null); }
    if (dest.channel) {
      const lines = changes.map((ch) => `• ${ch.contact ? `${ch.contact}: ` : ""}${ch.field} ${fmt(ch.from)} → ${fmt(ch.to)}`);
      const text = `📝 *${closer.name}* filed ${DateTime.fromFormat(args.day, DAY_FMT).toFormat("ccc LLL d")}: ${args.answers.calls_count} calls, ${args.answers.closes} closes, $${args.answers.cash.toLocaleString("en-US")} cash, $${args.answers.revenue.toLocaleString("en-US")} revenue.${lines.length ? `\n*Corrected from what the engine had:*\n${lines.join("\n")}` : "\nNothing corrected: the prefill matched."}`;
      await adapters.notifier.post(dest.slackToken, dest.channel, text, { name: "End of day", icon: ":clipboard:" }).catch(() => null);
    }
  }
  return { ok: true, changes, recorded };
}
const fmt = (v: unknown) => (typeof v === "number" ? v.toLocaleString("en-US") : String(v ?? "blank"));

/** At the company's end-of-day time: every closer with calls that day and no filed report gets one DM with their link. Once per day. */
export async function remindDue(c: PoolClient, adapters: Adapters, now = DateTime.now(), onlyCompanyId?: string): Promise<{ reminded: { company: string; closer: string }[] }> {
  const out = { reminded: [] as { company: string; closer: string }[] };
  const base = (process.env.PUBLIC_URL ?? process.env.TICK_URL ?? "").replace(/\/$/, "");
  const companies = await many<{ id: string; slug: string; timezone: string; eod_at: string; eod_enabled: boolean }>(c, "select id, slug, timezone, eod_at::text as eod_at, eod_enabled from companies where status in ('active','hosted') and eod_enabled and ($1::uuid is null or id=$1)", [onlyCompanyId ?? null]);
  for (const co of companies) {
    const local = now.setZone(co.timezone); const day = local.toFormat(DAY_FMT);
    const [hh, mm] = co.eod_at.split(":").map(Number); if (local.hour < hh || (local.hour === hh && local.minute < mm)) continue;
    const from = local.startOf("day").toJSDate(), to = local.endOf("day").toJSDate();
    const closers = await many<{ id: string; name: string; email: string }>(c, `select distinct u.id, u.name, u.email from users u join appointments a on a.assigned_user_id=u.id
      where u.company_id=$1 and u.active and a.starts_at between $2 and $3 and a.status not in ('cancelled','invalid')
      and not exists (select 1 from eod_reports r where r.user_id=u.id and r.day=$4 and (r.submitted_at is not null or r.reminded_at is not null))`, [co.id, from, to, day]);
    if (!closers.length) continue;
    const dest = await destinationsFor(c, co.id); if (!dest.slackToken) continue;
    for (const u of closers) {
      const token = await tokenFor(c, u.id);
      let slackId = (await one<{ slack_user_id: string | null }>(c, "select slack_user_id from users where id=$1", [u.id]))?.slack_user_id ?? null;
      if (!slackId) { slackId = await adapters.notifier.lookupUserByEmail(dest.slackToken, u.email).catch(() => null); if (slackId) await c.query("update users set slack_user_id=$2 where id=$1", [u.id, slackId]); }
      let dm: { channel: string; ts: string } | null = null;
      if (slackId) { const r = await adapters.notifier.post(dest.slackToken, slackId, `Hey ${u.name.split(" ")[0]}, don't forget your end-of-day: <${base}/eod/${token}|open your report>. It's prefilled from your calendar and today's calls; fix anything that's off and hit submit.`, { name: "End of day", icon: ":clipboard:" }).catch(() => null); if (r) dm = { channel: slackId, ts: r.ts }; }
      await c.query("insert into eod_reports (company_id, user_id, day, reminded_at, dm_channel, dm_ts) values ($1,$2,$3,now(),$4,$5) on conflict (company_id, user_id, day) do update set reminded_at=now(), dm_channel=excluded.dm_channel, dm_ts=excluded.dm_ts", [co.id, u.id, day, dm?.channel ?? null, dm?.ts ?? null]);
      out.reminded.push({ company: co.slug, closer: u.name });
    }
  }
  return out;
}

export const reportFor = (c: PoolClient, companyId: string, userId: string, day: string) => one<{ id: string; submitted_at: Date | null; answers: EodAnswers | null; changes: Change[]; reminded_at: Date | null }>(c, "select id, submitted_at, answers, changes, reminded_at from eod_reports where company_id=$1 and user_id=$2 and day=$3", [companyId, userId, day]);
export const companyReports = (c: PoolClient, companyId: string, limit = 60) => many<{ id: string; day: string; closer: string; submitted_at: Date | null; reminded_at: Date | null; answers: EodAnswers | null; changes: Change[] }>(c, "select r.id, r.day::text as day, u.name as closer, r.submitted_at, r.reminded_at, r.answers, r.changes from eod_reports r join users u on u.id=r.user_id where r.company_id=$1 order by r.day desc, u.name limit $2", [companyId, limit]);
export const slackTokenFor = async (c: PoolClient, companyId: string) => { const conn = await one<{ bot_token: Buffer }>(c, "select bot_token from slack_connections where company_id=$1", [companyId]); return conn ? decrypt(conn.bot_token) : null; };
