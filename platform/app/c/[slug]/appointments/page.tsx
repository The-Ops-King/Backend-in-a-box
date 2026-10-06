import Link from "next/link";
import { notFound } from "next/navigation";
import { company, companyAppointments } from "@/ui/queries";
import { badge, when } from "@/ui/format";
export const dynamic = "force-dynamic";
export default async function AppointmentsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params; const co = await company(slug); if (!co) notFound();
  const rows = await companyAppointments(co.id);
  const now = Date.now();
  return (<>
    <p className="sub"><Link href="/">Companies</Link> / <Link href={`/c/${slug}`}>{co.name}</Link> / Appointments</p>
    <h1>Appointments</h1>
    <p className="sub">Last 7 days and next 14. Past calls without a disposition are the ones to fill in.</p>
    {rows.length === 0 ? <div className="empty">No appointments in this window.</div> :
    <div className="tbl"><table><thead><tr><th>When</th><th>Contact</th><th>Type</th><th>Closer</th><th>Status</th><th>Outcome</th><th></th></tr></thead><tbody>
      {rows.map((a) => { const past = new Date(a.starts_at).getTime() < now; return (
        <tr key={a.id}><td>{when(a.starts_at, co.timezone)}</td><td><Link href={`/c/${slug}/contacts/${a.contact_id}`}>{a.contact.trim() || "—"}</Link></td><td>{a.term}</td><td>{a.closer ?? "—"}</td><td><span className={badge(a.status === "confirmed" ? "active" : a.status === "cancelled" || a.status === "noshow" ? "failed" : "waiting")}>{a.status}</span></td>
        <td>{a.outcome ? <><strong>{a.outcome}</strong>{a.call_outcome ? ` · ${a.call_outcome}` : ""}</> : past ? <span style={{ color: "var(--warn)" }}>needs disposition</span> : <span style={{ color: "var(--muted)" }}>upcoming</span>}</td>
        <td><Link href={`/c/${slug}/appointments/${a.id}`}>{a.outcome ? "view" : "disposition"}</Link></td></tr>); })}
    </tbody></table></div>}
  </>);
}
