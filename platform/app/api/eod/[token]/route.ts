import { DateTime } from "luxon";
import { asOperator } from "@/db/client";
import { fail, ok, readJson } from "@/api/http";
import { liveAdapters } from "@/adapters";
import { loadCompany } from "@/engine/context";
import { closerByToken, loadEodForm, prefill, reportFor, submitEod, todayFor, DAY_FMT, type EodAnswers, type EodPrefill, type CallEntry } from "@/engine/eod";
import { OUTCOMES, dayFields, totalsOf, type CallOutcome } from "@/engine/eod-form";
export const dynamic = "force-dynamic";

/** The closer's day (D34): their standing link is the key. Today by default, prefilled, with what they already filed. */
export async function GET(req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params; const q = new URL(req.url).searchParams.get("day");
  const data = await asOperator(async (c) => {
    const closer = await closerByToken(c, token); if (!closer || !closer.active || !closer.company_id) return null;
    const { row: company } = await loadCompany(c, closer.company_id);
    const day = q && DateTime.fromFormat(q, DAY_FMT).isValid ? q : todayFor(company.timezone);
    const filed = await reportFor(c, company.id, closer.id, day);
    const pre = await prefill(c, company, closer, day);
    const fields = await loadEodForm(c, company.id);
    const shown: EodPrefill = filed?.answers ? { ...pre, ...pickAnswers(filed.answers, pre) } : pre;
    const d = DateTime.fromFormat(day, DAY_FMT, { zone: company.timezone });
    return { closer: { first_name: closer.name.split(" ")[0], name: closer.name }, company: { name: company.name, timezone: company.timezone }, day, is_today: day === todayFor(company.timezone), prev: d.minus({ days: 1 }).toFormat(DAY_FMT), next: d.plus({ days: 1 }).toFormat(DAY_FMT),
      filed: filed?.submitted_at ? { at: filed.submitted_at, changes: filed.changes?.length ?? 0 } : null, pre: shown, seen: { calls: pre.calls_count, cash: pre.cash }, fields, day_answers: filed?.answers?.day_answers ?? {}, outcomes: OUTCOMES };
  });
  return data ? ok(data) : fail(404, "this link is not for anyone");
}

/** The closer pressed Submit. */
export async function POST(req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const body = await readJson<{ day?: string; calls_count?: number | string; closes?: number | string; deposits?: number | string; cash?: number | string; revenue?: number | string; calls?: CallEntry[]; day_answers?: Record<string, string> }>(req);
  if (!body?.day || !Array.isArray(body.calls)) return fail(400, "day and calls are required");
  const num = (v: unknown) => (v === "" || v === null || v === undefined ? null : Number(String(v).replace(/[,$]/g, "")) || 0);
  const r = await asOperator(async (c) => {
    const closer = await closerByToken(c, token); if (!closer?.company_id) return { ok: false as const, why: "this link is not for anyone" };
    const fields = await loadEodForm(c, closer.company_id);
    const extraKeys = fields.filter((x) => x.scope === "call" && !x.builtin).map((x) => x.key);
    const calls: CallEntry[] = body.calls!.map((x) => ({ appointment_id: String(x.appointment_id), contact_id: String(x.contact_id ?? ""), contact: String(x.contact ?? ""), starts_at: String(x.starts_at ?? ""), href_contact: null, recording_url: null,
      outcome: String(x.outcome ?? "") as CallOutcome, revenue: num(x.revenue), cash: num(x.cash), next_date: x.next_date ? String(x.next_date) : null, next_steps: String(x.next_steps ?? ""), dq_reason: String(x.dq_reason ?? ""), dq_note: String(x.dq_note ?? ""), about: String(x.about ?? ""), notes: String(x.notes ?? ""),
      extra: Object.fromEntries(extraKeys.map((k) => [k, String((x.extra ?? {})[k] ?? "")]).filter(([, v]) => v !== "")) }));
    const t = totalsOf(calls);
    const dayKeys = dayFields(fields).map((f) => f.key);
    const day_answers = Object.fromEntries(Object.entries(body.day_answers ?? {}).filter(([k, v]) => dayKeys.includes(k) && String(v) !== "").map(([k, v]) => [k, String(v)]));
    const answers: EodAnswers = { calls_count: num(body.calls_count) ?? 0, closes: num(body.closes) ?? t.closes, deposits: num(body.deposits) ?? t.deposits, cash: num(body.cash) ?? t.cash, revenue: num(body.revenue) ?? t.revenue, calls, day_answers };
    return submitEod(c, liveAdapters, { token, day: body.day!, answers });
  });
  return r.ok ? ok({ ok: true, recorded: r.recorded, changes: r.changes.length }) : fail(422, r.why);
}

function pickAnswers(a: EodAnswers, pre: EodPrefill): Partial<EodPrefill> {
  const byId = new Map(a.calls.map((c) => [c.appointment_id, c]));
  return { calls_count: a.calls_count, closes: a.closes, deposits: a.deposits ?? 0, cash: a.cash, revenue: a.revenue, calls: pre.calls.map((c) => { const x = byId.get(c.appointment_id); return x ? { ...c, ...x, extra: x.extra ?? {}, href_contact: c.href_contact, recording_url: c.recording_url } : c; }) };
}
