import Link from "next/link";
import { Fragment } from "react";
import { notFound } from "next/navigation";
import { company, contact } from "@/ui/queries";
import { ago, badge, when } from "@/ui/format";
import { simulateAction } from "@/ui/actions";
import { SIM_ACTIONS } from "@/engine/simulate";
export const dynamic = "force-dynamic";
const summary = (t: string, d: Record<string, unknown>) => {
  // a status change carries {from, to}: say "confirmed → cancelled", never "[object Object]"
  const show = (v: unknown) => (v && typeof v === "object" && "from" in (v as object) && "to" in (v as object) ? `${String((v as { from: unknown }).from)} → ${String((v as { to: unknown }).to)}` : typeof v === "object" ? JSON.stringify(v) : String(v));
  const pick = ["intent", "outcome", "type", "tag", "plan", "reason", "status", "starts_at", "calendar_id", "amount", "channel", "cancelled_by", "cancel_reason", "matched_by", "simulated"].filter((k) => d[k] !== undefined && d[k] !== null).map((k) => `${k}: ${show(d[k])}`);
  return pick.length ? pick.join(" · ") : t.startsWith("run.") ? "" : Object.keys(d).length ? JSON.stringify(d).slice(0, 90) : "";
};
export default async function ContactPage({ params }: { params: Promise<{ slug: string; id: string }> }) {
  const { slug, id } = await params; const co = await company(slug); const ct = await contact(id); if (!co || !ct || ct.company_id !== co.id) notFound();
  const name = `${ct.first_name ?? ""} ${ct.last_name ?? ""}`.trim() || "Contact";
  return (<>
    <p className="sub"><Link href="/">Companies</Link> / <Link href={`/c/${slug}`}>{co.name}</Link> / {name}</p>
    <h1>{name}</h1>
    <p className="sub">{ct.timezone ?? co.timezone} · in GHL as <code>{ct.ghl_contact_id ?? "—"}</code> · {ct.tags.length ? ct.tags.join(", ") : "no tags"}</p>
    <details className="card" style={{ marginBottom: 12 }}>
      <summary><strong>Test harness</strong> <span className="muted">— stage a step for this person behind the scenes. Nothing reaches GHL, Calendly or a Zap{co.mode === "live" ? "; refused while the company is live" : ""}. Same as adding a <code>sys-test-&lt;action&gt;</code> tag in GHL.</span></summary>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 10 }}>
        {SIM_ACTIONS.map((a) => <form key={a} action={simulateAction}><input type="hidden" name="slug" value={slug} /><input type="hidden" name="companyId" value={co.id} /><input type="hidden" name="contactId" value={ct.id} /><input type="hidden" name="action" value={a} />
          <button className={`btn ${a === "reset" ? "btn-off" : ""}`} type="submit" disabled={co.mode === "live"}>{({ create: "Lead comes in", book: "Setter books a call", "book-self": "Books themselves", reschedule: "Reschedules", cancel: "Cancels", pay: "Pays", record: "Call recorded", reset: "Forget this person's runs" } as Record<string, string>)[a]}</button></form>)}
      </div>
    </details>
    <div className="grid g2" style={{ alignItems: "start" }}>
      <div>
        <h2 style={{ marginTop: 0 }}>Journey</h2>
        {ct.journey.length === 0 ? <div className="empty">No events yet.</div> :
        <ul className="journey">{ct.journey.map((e) => <li key={e.id}><span style={{ color: "var(--muted)" }}>{when(e.occurred_at, co.timezone)}</span><span><code>{e.event_type}</code> <span style={{ color: "var(--muted)", fontSize: 12 }}>{e.source}</span></span><span>{summary(e.event_type, e.data)}{e.run_id ? <> · <Link href={`/c/${slug}/r/${e.run_id}`}>run</Link></> : null}</span></li>)}</ul>}
      </div>
      <div>
        <h2 style={{ marginTop: 0 }}>Runs</h2>
        {ct.runs.length === 0 ? <div className="empty">None.</div> : <div className="tbl"><table><tbody>{ct.runs.map((r) => <tr key={r.id}><td><Link href={`/c/${slug}/r/${r.id}`}>{r.workflow}</Link></td><td><span className={badge(r.status)}>{r.status}</span></td><td>{r.exit_reason ?? ""}</td><td>{ago(r.started_at)}</td></tr>)}</tbody></table></div>}
        <h2>Messages</h2>
        {ct.msgs.length === 0 ? <div className="empty">None.</div> : <div className="tbl"><table><tbody>{ct.msgs.map((m, i) => <tr key={i}><td><span className="badge b-type">{m.channel} {m.direction === "inbound" ? "←" : "→"}</span></td><td style={{ whiteSpace: "pre-wrap" }}>{m.body ?? m.subject ?? "(email)"}</td><td>{ago(m.occurred_at)}</td></tr>)}</tbody></table></div>}
        <h2>Attributes</h2>
        {Object.keys(ct.attributes).length === 0 ? <div className="empty">No intake yet.</div> : <dl className="kv">{Object.entries(ct.attributes).map(([k, v]) => <Fragment key={k}><dt className="mono">{k}</dt><dd>{String(v)}</dd></Fragment>)}</dl>}
        <h2>Identifiers</h2>
        <dl className="kv">{ct.idents.map((i) => <Fragment key={i.kind + i.value}><dt>{i.kind}</dt><dd className="mono">{i.value}</dd></Fragment>)}</dl>
      </div>
    </div>
  </>);
}
