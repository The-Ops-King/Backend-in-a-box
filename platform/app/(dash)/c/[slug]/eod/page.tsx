import Link from "next/link";
import { notFound } from "next/navigation";
import { DateTime } from "luxon";
import { asOperator, many } from "@/db/client";
import { company } from "@/ui/queries";
import { companyReports, tokenFor, totalsLine } from "@/engine/eod";
import { stamp } from "@/ui/format";
export const dynamic = "force-dynamic";

/** Filed end-of-day reports, newest first, with what each closer corrected; and every closer's standing link. */
export default async function EodListPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params; const co = await company(slug); if (!co) notFound();
  const [reports, closers] = await asOperator(async (c) => {
    const rs = await companyReports(c, co.id);
    const us = await many<{ id: string; name: string; email: string; role: string }>(c, "select id, name, email, role from users where company_id=$1 and active and role='closer' order by name", [co.id]);
    const withTokens = []; for (const u of us) withTokens.push({ ...u, token: await tokenFor(c, u.id) });
    return [rs, withTokens] as const;
  });
  const base = (process.env.PUBLIC_URL ?? process.env.TICK_URL ?? "").replace(/\/$/, "");
  return (<>
    <p className="sub"><Link href="/">Companies</Link> / <Link href={`/c/${slug}`}>{co.name}</Link> / End of day</p>
    <h1>End-of-day reports</h1>
    <p className="sub">Each closer gets a DM from the end-of-day reminder workflow on days they had calls, with their link. The link is standing: the same one every day, today by default, and it opens on their day only. What is filed starts the end-of-day filed workflow. <Link href={`/c/${slug}/settings#clock`}>The scheduled workflows</Link> · <Link href={`/c/${slug}/settings#team`}>who is a closer</Link> · <Link href={`/c/${slug}/settings#eodform`}>the questions</Link>.</p>
    <h2>Filed · {reports.filter((r) => r.submitted_at).length}</h2>
    {reports.length === 0 ? <div className="empty">Nothing yet.</div> : <ol className="tl">{reports.map((r) => <li key={r.id} className={`tl-row ${r.submitted_at ? "st-ok" : "st-waiting"}`}>
      <span className="tl-t">{DateTime.fromISO(r.day).toFormat("ccc LLL d")}</span>
      <span className="tl-w"><strong>{r.closer}</strong>{r.submitted_at ? <> · filed {stamp(r.submitted_at, co.timezone)}{r.answers ? ` · ${totalsLine({ ...r.answers, deposits: r.answers.deposits ?? 0, cash: Number(r.answers.cash), revenue: Number(r.answers.revenue) })}` : ""}</> : <> · <span className="badge b-waiting">not filed</span>{r.reminded_at ? ` · reminded ${stamp(r.reminded_at, co.timezone)}` : ""}</>}
        {r.changes?.length ? <span className="tl-d">Corrected: {r.changes.map((ch) => `${ch.contact ? `${ch.contact}: ` : ""}${ch.field} ${String(ch.from)} → ${String(ch.to)}`).join(" · ")}</span> : r.submitted_at ? <span className="tl-d">Nothing corrected: the prefill matched.</span> : null}</span>
    </li>)}</ol>}
    <h2>Closer links</h2>
    {closers.length === 0 ? <div className="empty">Nobody is marked as a closer yet. <Link href={`/c/${slug}/settings#team`}>Set roles</Link>.</div> : null}
    <div className="tbl"><table><tbody>{closers.map((u) => <tr key={u.id}><td><strong>{u.name}</strong> <span className="muted">{u.role}</span></td><td className="mono"><a href={`${base}/eod/${u.token}`}>{base}/eod/{u.token}</a></td></tr>)}</tbody></table></div>
  </>);
}
