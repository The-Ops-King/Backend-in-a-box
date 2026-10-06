import Link from "next/link";
import { notFound } from "next/navigation";
import { company, companyWorkflows, companyContacts, pollHealth, recentRuns, companyEvents } from "@/ui/queries";
import { RunsTable } from "@/ui/RunsTable";
import { ago, badge } from "@/ui/format";
export const dynamic = "force-dynamic";
export default async function CompanyPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params; const co = await company(slug); if (!co) notFound();
  const [wfs, contacts, polls, runs, events] = await Promise.all([companyWorkflows(co.id), companyContacts(co.id), pollHealth(co.id), recentRuns(co.id), companyEvents(co.id)]);
  return (<>
    <p className="sub"><Link href="/">Companies</Link> / {co.name}</p>
    <h1>{co.name}</h1>
    <p className="sub"><span className={badge(co.status)}>{co.status}</span> · {co.timezone} · sends {co.send_window_start.slice(0, 5)}–{co.send_window_end.slice(0, 5)} · <Link href={`/c/${slug}/appointments`}>Appointments</Link></p>
    <h2>Workflows</h2>
    <table><thead><tr><th>Workflow</th><th>Triggers</th><th>Re-entry</th><th>Runs</th><th>Enabled</th></tr></thead><tbody>
      {wfs.map((w) => <tr key={w.id}><td><Link href={`/c/${slug}/w/${w.id}`}><strong>{w.name}</strong></Link> <span className="mono" style={{ color: "var(--muted)" }}>v{w.current_version}{w.diverged ? " · edited" : ""}</span></td><td className="mono">{w.triggers.join(", ")}</td><td className="mono">{w.reentry_policy}</td><td>{w.runs_active} active / {w.runs_total}</td><td><span className={badge(w.enabled ? "active" : "paused")}>{w.enabled ? "on" : "off"}</span></td></tr>)}
    </tbody></table>
    <h2>Polling</h2>
    <table><thead><tr><th>Entity</th><th>Last success</th><th>Failures</th></tr></thead><tbody>
      {polls.map((p) => <tr key={p.entity}><td className="mono">{p.entity}</td><td>{p.last_success_at ? ago(p.last_success_at) : "never"}</td><td style={{ color: p.consecutive_failures ? "var(--bad)" : undefined }}>{p.consecutive_failures}</td></tr>)}
    </tbody></table>
    <h2>Runs</h2>
    <RunsTable runs={runs} slug={slug} />
    <h2>Latest events</h2>
    <table><thead><tr><th>When</th><th>Event</th><th>Contact</th><th>Detail</th></tr></thead><tbody>
      {events.map((e) => <tr key={e.id}><td>{ago(e.occurred_at)}</td><td><code>{e.event_type}</code> <span style={{ color: "var(--muted)", fontSize: 12 }}>{e.source}</span></td><td>{e.contact_id ? <Link href={`/c/${slug}/contacts/${e.contact_id}`}>{e.contact.trim() || "—"}</Link> : "—"}</td><td className="mono" style={{ color: "var(--muted)", fontSize: 12 }}>{["intent", "outcome", "type", "tag", "status", "reason", "channel"].filter((k) => e.data[k] !== undefined).map((k) => `${k}=${JSON.stringify(e.data[k])}`).join(" ")}</td></tr>)}
    </tbody></table>
    <h2>Contacts · most recently updated</h2>
    <table><thead><tr><th>Contact</th><th>Where they are</th><th>Events</th><th>Tags</th><th>Updated</th></tr></thead><tbody>
      {contacts.map((c) => <tr key={c.id}><td><Link href={`/c/${slug}/contacts/${c.id}`}>{`${c.first_name ?? ""} ${c.last_name ?? ""}`.trim() || c.id.slice(0, 8)}</Link></td><td className="mono">{c.stage ?? "—"}</td><td>{c.events}</td><td style={{ color: "var(--muted)" }}>{c.tags.slice(0, 4).join(", ")}{c.tags.length > 4 ? ` +${c.tags.length - 4}` : ""}</td><td>{ago(c.updated_at)}</td></tr>)}
    </tbody></table>
  </>);
}
