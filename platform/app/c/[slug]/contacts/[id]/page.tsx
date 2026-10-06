import Link from "next/link";
import { notFound } from "next/navigation";
import { company, contact } from "@/ui/queries";
import { ago, badge, when } from "@/ui/format";
export const dynamic = "force-dynamic";
const summary = (t: string, d: Record<string, unknown>) => {
  const pick = ["intent", "outcome", "type", "tag", "plan", "reason", "status", "calendar_id", "amount", "channel"].filter((k) => d[k] !== undefined).map((k) => `${k}: ${String(d[k])}`);
  return pick.length ? pick.join(" · ") : t.startsWith("run.") ? "" : Object.keys(d).length ? JSON.stringify(d).slice(0, 90) : "";
};
export default async function ContactPage({ params }: { params: Promise<{ slug: string; id: string }> }) {
  const { slug, id } = await params; const co = await company(slug); const ct = await contact(id); if (!co || !ct || ct.company_id !== co.id) notFound();
  const name = `${ct.first_name ?? ""} ${ct.last_name ?? ""}`.trim() || "Contact";
  return (<>
    <p className="sub"><Link href="/">Companies</Link> / <Link href={`/c/${slug}`}>{co.name}</Link> / {name}</p>
    <h1>{name}</h1>
    <p className="sub">{ct.timezone ?? co.timezone} · in GHL as <code>{ct.ghl_contact_id ?? "—"}</code> · {ct.tags.length ? ct.tags.join(", ") : "no tags"}</p>
    <div className="grid g2" style={{ alignItems: "start" }}>
      <div>
        <h2 style={{ marginTop: 0 }}>Journey</h2>
        {ct.journey.length === 0 ? <div className="empty">No events yet.</div> :
        <ul className="journey">{ct.journey.map((e) => <li key={e.id}><span style={{ color: "var(--muted)" }}>{when(e.occurred_at, co.timezone)}</span><span><code>{e.event_type}</code> <span style={{ color: "var(--muted)", fontSize: 12 }}>{e.source}</span></span><span>{summary(e.event_type, e.data)}{e.run_id ? <> · <Link href={`/c/${slug}/r/${e.run_id}`}>run</Link></> : null}</span></li>)}</ul>}
      </div>
      <div>
        <h2 style={{ marginTop: 0 }}>Runs</h2>
        {ct.runs.length === 0 ? <div className="empty">None.</div> : <table><tbody>{ct.runs.map((r) => <tr key={r.id}><td><Link href={`/c/${slug}/r/${r.id}`}>{r.workflow}</Link></td><td><span className={badge(r.status)}>{r.status}</span></td><td>{r.exit_reason ?? ""}</td><td>{ago(r.started_at)}</td></tr>)}</tbody></table>}
        <h2>Messages</h2>
        {ct.msgs.length === 0 ? <div className="empty">None.</div> : <table><tbody>{ct.msgs.map((m, i) => <tr key={i}><td><span className="badge b-type">{m.channel} {m.direction === "inbound" ? "←" : "→"}</span></td><td style={{ whiteSpace: "pre-wrap" }}>{m.body ?? m.subject ?? "(email)"}</td><td>{ago(m.occurred_at)}</td></tr>)}</tbody></table>}
        <h2>Attributes</h2>
        {Object.keys(ct.attributes).length === 0 ? <div className="empty">No intake yet.</div> : <dl className="kv">{Object.entries(ct.attributes).map(([k, v]) => <><dt key={k + "k"} className="mono">{k}</dt><dd key={k + "v"}>{String(v)}</dd></>)}</dl>}
        <h2>Identifiers</h2>
        <dl className="kv">{ct.idents.map((i) => <><dt key={i.kind + i.value + "k"}>{i.kind}</dt><dd key={i.kind + i.value + "v"} className="mono">{i.value}</dd></>)}</dl>
      </div>
    </div>
  </>);
}
