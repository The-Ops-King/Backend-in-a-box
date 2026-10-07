import Link from "next/link";
import { notFound } from "next/navigation";
import { company, companyWorkflows, companyContacts, pollHealth, recentRuns, companyEvents, readiness } from "@/ui/queries";
import { ReadinessCard } from "@/ui/Readiness";
import { RunsTable } from "@/ui/RunsTable";
import { ago, badge } from "@/ui/format";
import { toggleMode } from "@/ui/actions";
export const dynamic = "force-dynamic";
export default async function CompanyPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params; const co = await company(slug); if (!co) notFound();
  const [wfs, contacts, polls, runs, events, ready] = await Promise.all([companyWorkflows(co.id), companyContacts(co.id), pollHealth(co.id), recentRuns(co.id), companyEvents(co.id), readiness(co.id, slug)]);
  const readyOf = new Map(ready.workflows.map((w) => [w.id, w]));
  return (<>
    <p className="sub"><Link href="/">Companies</Link> / {co.name}</p>
    <h1>{co.name}</h1>
    <p className="sub"><span className={badge(co.status)}>{co.status}</span> <span className={co.mode === "live" ? "badge b-live" : "badge b-shadow"}>{co.mode === "live" ? "LIVE" : "SHADOW"}</span> · {co.timezone} · sends {co.send_window_start.slice(0, 5)}–{co.send_window_end.slice(0, 5)}{co.sms_enabled ? "" : " · SMS off"} · <Link href={`/c/${slug}/appointments`}>Appointments</Link> · <Link href={`/c/${slug}/payments`}>Payments</Link> · <Link href={`/c/${slug}/recordings`}>Recordings</Link> · <Link href={`/c/${slug}/reports`}>Wrap-ups</Link> · <Link href={`/c/${slug}/triggers`}>Triggers</Link> · <Link href={`/c/${slug}/settings`}><strong>Settings</strong></Link> · <Link href={`/c/${slug}/sends`}>{co.mode === "live" ? "Sends" : "Would have sent"}</Link></p>
    <div className="card" style={{ marginBottom: 6, display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap" }}>
      <div style={{ flex: 1, minWidth: 260 }}>{co.mode === "live" ? <><strong>Live.</strong> Enabled workflows send real messages and write tags, notes and appointment changes to GHL.</> : <><strong>Shadow.</strong> Enabled workflows run fully but write nothing to GHL. Every message, tag and note is recorded as what <em>would</em> have happened. Read-only CRM access is enough.</>}</div>
      <form action={toggleMode}><input type="hidden" name="slug" value={slug} /><button className={`btn ${co.mode === "live" ? "btn-off" : "btn-on"}`} type="submit">{co.mode === "live" ? "Switch to shadow" : "Go live"}</button></form>
    </div>
    <ReadinessCard r={ready} />
    <h2>Workflows</h2>
    <div className="tbl"><table><thead><tr><th>Workflow</th><th>Triggers</th><th>Re-entry</th><th>Runs</th><th>Enabled</th><th>Ready</th></tr></thead><tbody>
      {wfs.map((w) => { const rd = readyOf.get(w.id); return <tr key={w.id}><td><Link href={`/c/${slug}/w/${w.id}`}><strong>{w.name}</strong></Link> <span className="mono" style={{ color: "var(--muted)" }}>v{w.current_version}{w.diverged ? " · edited" : ""}</span></td><td className="mono">{w.triggers.join(", ")}</td><td className="mono">{w.reentry_policy}</td><td>{w.runs_active} active / {w.runs_total}</td><td><span className={badge(w.enabled ? "active" : "paused")}>{w.enabled ? "on" : "off"}</span></td>
        <td>{!rd ? "—" : rd.ready ? <span className="badge b-live">ready</span> : <span className="badge b-failed" title={[...rd.missing.map((m) => `missing ${m}`), ...rd.gaps].join("\n")}>{rd.missing.length ? `missing ${rd.missing.length} binding${rd.missing.length > 1 ? "s" : ""}` : "not built yet"}</span>}</td></tr>; })}
    </tbody></table></div>
    <h2>Polling</h2>
    <div className="tbl"><table><thead><tr><th>Entity</th><th>Last success</th><th>Failures</th></tr></thead><tbody>
      {polls.map((p) => <tr key={p.entity}><td className="mono">{p.entity}</td><td>{p.last_success_at ? ago(p.last_success_at) : "never"}</td><td style={{ color: p.consecutive_failures ? "var(--bad)" : undefined }}>{p.consecutive_failures}</td></tr>)}
    </tbody></table></div>
    <h2>Runs</h2>
    <RunsTable runs={runs} slug={slug} />
    <h2>Latest events</h2>
    <div className="tbl"><table><thead><tr><th>When</th><th>Event</th><th>Contact</th><th>Detail</th></tr></thead><tbody>
      {events.map((e) => <tr key={e.id}><td>{ago(e.occurred_at)}</td><td><code>{e.event_type}</code> <span style={{ color: "var(--muted)", fontSize: 12 }}>{e.source}</span></td><td>{e.contact_id ? <Link href={`/c/${slug}/contacts/${e.contact_id}`}>{e.contact.trim() || "—"}</Link> : "—"}</td><td className="mono" style={{ color: "var(--muted)", fontSize: 12 }}>{["intent", "outcome", "type", "tag", "status", "reason", "channel"].filter((k) => e.data[k] !== undefined).map((k) => `${k}=${JSON.stringify(e.data[k])}`).join(" ")}</td></tr>)}
    </tbody></table></div>
    <h2>Contacts · most recently updated</h2>
    <div className="tbl"><table><thead><tr><th>Contact</th><th>Where they are</th><th>Events</th><th>Tags</th><th>Updated</th></tr></thead><tbody>
      {contacts.map((c) => <tr key={c.id}><td><Link href={`/c/${slug}/contacts/${c.id}`}>{`${c.first_name ?? ""} ${c.last_name ?? ""}`.trim() || c.id.slice(0, 8)}</Link></td><td className="mono">{c.stage ?? "—"}</td><td>{c.events}</td><td style={{ color: "var(--muted)" }}>{c.tags.slice(0, 4).join(", ")}{c.tags.length > 4 ? ` +${c.tags.length - 4}` : ""}</td><td>{ago(c.updated_at)}</td></tr>)}
    </tbody></table></div>
  </>);
}
