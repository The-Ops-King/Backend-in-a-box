import Link from "next/link";
import { notFound } from "next/navigation";
import { company, companySends } from "@/ui/queries";
import { ago, badge } from "@/ui/format";
export const dynamic = "force-dynamic";
export default async function SendsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params; const co = await company(slug); if (!co) notFound();
  const rows = await companySends(co.id);
  const shadow = co.mode === "shadow";
  return (<>
    <p className="sub"><Link href="/">Companies</Link> / <Link href={`/c/${slug}`}>{co.name}</Link> / {shadow ? "Would have sent" : "Sends"}</p>
    <h1>{shadow ? "What would have gone out" : "Sends"}</h1>
    <p className="sub">{shadow ? "The company is in shadow mode: these messages were rendered and recorded, not sent. Read them like a transcript of what the workflows would have done." : "Every message the engine sent, suppressed, or failed to send."} Latest 100.</p>
    {rows.length === 0 ? <div className="empty">Nothing yet. Turn on a workflow and let the poller see something happen.</div> :
    <table><thead><tr><th>When</th><th>To</th><th>Via</th><th>Status</th><th>Message</th><th>Workflow</th></tr></thead><tbody>
      {rows.map((s) => <tr key={s.id}>
        <td>{ago(s.sent_at ?? s.scheduled_for)}</td>
        <td><Link href={`/c/${slug}/contacts/${s.contact_id}`}>{s.contact.trim() || "—"}</Link></td>
        <td><span className="badge b-type">{s.channel}</span></td>
        <td><span className={badge(s.status)}>{s.status === "shadow" ? "would send" : s.status}</span>{s.suppressed_reason ? <div style={{ color: "var(--muted)", fontSize: 12 }}>{s.suppressed_reason}</div> : null}</td>
        <td style={{ whiteSpace: "pre-wrap", maxWidth: 520 }}>{s.rendered_body.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() || <span style={{ color: "var(--muted)" }}>(nothing rendered)</span>}</td>
        <td>{s.run_id ? <Link href={`/c/${slug}/r/${s.run_id}`}>{s.workflow ?? "run"}</Link> : "—"}</td>
      </tr>)}
    </tbody></table>}
  </>);
}
