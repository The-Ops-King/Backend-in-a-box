import { notFound } from "next/navigation";
import { DateTime } from "luxon";
import { asOperator } from "@/db/client";
import { loadCompany } from "@/engine/context";
import { closerByToken, prefill, reportFor, todayFor, DAY_FMT, type EodAnswers, type EodPrefill } from "@/engine/eod";
import { EodForm } from "@/ui/EodForm";
export const dynamic = "force-dynamic";

/** The closer's end-of-day report (D34): their standing link, today by default, prefilled from the engine, editable, one Submit. */
export default async function EodPage({ params, searchParams }: { params: Promise<{ token: string }>; searchParams: Promise<{ day?: string; done?: string; changes?: string; error?: string }> }) {
  const { token } = await params; const sp = await searchParams;
  const data = await asOperator(async (c) => {
    const closer = await closerByToken(c, token); if (!closer || !closer.active || !closer.company_id) return null;
    const { row: company } = await loadCompany(c, closer.company_id);
    const day = sp.day && DateTime.fromFormat(sp.day, DAY_FMT).isValid ? sp.day : todayFor(company.timezone);
    const filed = await reportFor(c, company.id, closer.id, day);
    const pre = await prefill(c, company, closer, day);
    // a filed day opens with what they answered, so a second look edits rather than starts over
    const shown: EodPrefill = filed?.answers ? { ...pre, ...pickAnswers(filed.answers, pre) } : pre;
    return { closer, company, day, filed, pre: shown };
  });
  if (!data) notFound();
  const { closer, company, day, filed, pre } = data;
  const d = DateTime.fromFormat(day, DAY_FMT, { zone: company.timezone });
  const prev = d.minus({ days: 1 }).toFormat(DAY_FMT), next = d.plus({ days: 1 }).toFormat(DAY_FMT), isToday = day === todayFor(company.timezone);
  return (<>
    <p className="sub">{company.name} · end of day</p>
    <h1>{closer.name.split(" ")[0]}, your {isToday ? "day" : d.toFormat("cccc")}</h1>
    <p className="sub"><a href={`?day=${prev}`}>‹ {d.minus({ days: 1 }).toFormat("ccc LLL d")}</a> · <strong>{d.toFormat("cccc, LLL d")}</strong>{isToday ? " (today)" : <> · <a href={`?day=${next}`}>{d.plus({ days: 1 }).toFormat("ccc LLL d")} ›</a></>}</p>
    {sp.done !== undefined ? <div className="card ready" style={{ marginBottom: 10 }}><strong>✅ Filed.</strong> {sp.done} call{sp.done === "1" ? "" : "s"} recorded{Number(sp.changes) ? `, ${sp.changes} correction${sp.changes === "1" ? "" : "s"} noted` : ", everything matched"}. You can still change anything below and submit again.</div> : null}
    {sp.error ? <div className="card ready ready-no" style={{ marginBottom: 10 }}><strong>Not filed.</strong> {sp.error}</div> : null}
    {filed?.submitted_at && sp.done === undefined ? <div className="card ready" style={{ marginBottom: 10 }}><strong>Already filed</strong> at {DateTime.fromJSDate(filed.submitted_at).setZone(company.timezone).toFormat("h:mma")}. Submitting again replaces it.</div> : null}
    <p className="sub">Prefilled from your calendar, the recordings and today's payments. Fix anything that's off, then submit. Takes a minute.</p>
    <EodForm pre={pre} token={token} tz={company.timezone} />
  </>);
}

function pickAnswers(a: EodAnswers, pre: EodPrefill): Partial<EodPrefill> {
  const byId = new Map(a.calls.map((c) => [c.appointment_id, c]));
  return { calls_count: a.calls_count, closes: a.closes, cash: a.cash, revenue: a.revenue, calls: pre.calls.map((c) => { const x = byId.get(c.appointment_id); return x ? { ...c, ...x, href_contact: c.href_contact, recording_url: c.recording_url } : c; }) };
}
