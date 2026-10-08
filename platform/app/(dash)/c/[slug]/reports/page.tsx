import Link from "next/link";
import { notFound } from "next/navigation";
import { asOperator } from "@/db/client";
import { company } from "@/ui/queries";
import { companyReports } from "@/engine/reports";
import { when } from "@/ui/format";
export const dynamic = "force-dynamic";

/** Every wrap-up generated for this company, newest first, exactly as Slack got it (or would have, in shadow). */
export default async function ReportsPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ note?: string }> }) {
  const { slug } = await params; const sp = await searchParams; const co = await company(slug); if (!co) notFound();
  const rows = await asOperator((c) => companyReports(c, co.id));
  const status = (s: string | null) => s === "sent" ? <span className="badge b-live">posted</span> : s === "shadow" ? <span className="badge b-shadow">shadow · not posted</span> : <span className="badge b-type">{s ?? "not posted"}</span>;
  return (<>
    <p className="sub"><Link href="/">Companies</Link> / <Link href={`/c/${slug}`}>{co.name}</Link> / Wrap-ups</p>
    <h1>Wrap-ups</h1>
    <p className="sub">Daily, weekly and monthly, computed from the engine's ledger and posted to Slack on the schedule set in <Link href={`/c/${slug}/settings#reports`}>settings</Link>. Each one is kept here as sent.</p>
    {sp.note ? <div className="card" style={{ marginBottom: 12 }}>{sp.note}</div> : null}
    {rows.length === 0 ? <div className="empty">No wrap-ups yet. The first scheduled one runs at the time set in settings, or press “Generate now” there.</div> : rows.map((r) => (
      <div key={r.id} id={r.id} className="card" style={{ marginBottom: 12 }}>
        <div style={{ display: "flex", gap: 14, alignItems: "baseline", flexWrap: "wrap" }}><strong style={{ textTransform: "capitalize" }}>{r.kind}</strong><span className="muted">{r.period_start}{r.period_end !== r.period_start ? ` → ${r.period_end}` : ""}</span>{status(r.send_status)}{r.on_demand ? <span className="badge b-type">on demand</span> : null}<span className="muted" style={{ fontSize: 12 }}>generated {when(r.generated_at, co.timezone)}</span></div>
        <pre style={{ whiteSpace: "pre-wrap", fontSize: 12.5, marginTop: 10 }}>{r.body}</pre>
      </div>))}
  </>);
}
