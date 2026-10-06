import Link from "next/link";
import { listCompanies, globalStats, recentRuns, engineState } from "@/ui/queries";
import { RunsTable } from "@/ui/RunsTable";
import { ago, badge, when } from "@/ui/format";
export const dynamic = "force-dynamic";
export default async function Home() {
  const [companies, stats, runs, state] = await Promise.all([listCompanies(), globalStats(), recentRuns(undefined, 15), engineState()]);
  return (<>
    <h1>Engine</h1>
    <p className="sub">Last scheduler tick {state?.value.last_tick ? ago(state.value.last_tick) : "never"}{state?.value.recovery ? " · in recovery mode" : ""}</p>
    <div className="grid g4">
      <div className="card stat"><div className="n">{stats?.companies ?? 0}</div><div className="l">active companies</div></div>
      <div className="card stat"><div className="n">{stats?.runs_24h ?? 0}</div><div className="l">runs started · 24h</div></div>
      <div className="card stat"><div className="n">{stats?.sends_24h ?? 0}</div><div className="l">messages sent · 24h</div></div>
      <div className="card stat"><div className="n" style={{ color: (stats?.failed_24h ?? 0) ? "var(--bad)" : undefined }}>{stats?.failed_24h ?? 0}</div><div className="l">failed runs · 24h</div></div>
    </div>
    <h2>Companies</h2>
    {companies.length === 0 ? <div className="empty">No companies yet. <code>pnpm install:company …</code></div> :
    <table><thead><tr><th>Company</th><th>Status</th><th>Contacts</th><th>Workflows</th><th>Active runs</th><th>Last poll</th></tr></thead><tbody>
      {companies.map((c) => <tr key={c.id}><td><Link href={`/c/${c.slug}`}><strong>{c.name}</strong></Link> <span className="mono" style={{ color: "var(--muted)" }}>{c.slug}</span></td><td><span className={badge(c.status)}>{c.status}</span></td><td>{c.contacts}</td><td>{c.workflows}</td><td>{c.active_runs}</td><td>{c.last_poll ? ago(c.last_poll) : "never"}</td></tr>)}
    </tbody></table>}
    <h2>Recent runs</h2>
    <RunsTable runs={runs} />
  </>);
}
