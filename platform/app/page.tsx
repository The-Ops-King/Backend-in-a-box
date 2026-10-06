import Link from "next/link";
import { listCompanies, globalStats, recentRuns, engineState } from "@/ui/queries";
import { RunsTable } from "@/ui/RunsTable";
import { ago, badge, when } from "@/ui/format";
export const dynamic = "force-dynamic";
export default async function Home() {
  let data: [Awaited<ReturnType<typeof listCompanies>>, Awaited<ReturnType<typeof globalStats>>, Awaited<ReturnType<typeof recentRuns>>, Awaited<ReturnType<typeof engineState>>];
  try { data = await Promise.all([listCompanies(), globalStats(), recentRuns(undefined, 15), engineState()]); }
  catch (e) { return <Setup error={String((e as Error).message)} />; }
  const [companies, stats, runs, state] = data;
  return (<>
    <h1>Engine</h1>
    <p className="sub">Last scheduler tick {state?.value.last_tick ? ago(state.value.last_tick) : "never"}{state?.value.recovery ? " · in recovery mode" : ""}</p>
    <div className="grid g4">
      <div className="card stat"><div className="n">{stats?.companies ?? 0}</div><div className="l">active companies</div></div>
      <div className="card stat"><div className="n">{stats?.runs_24h ?? 0}</div><div className="l">runs started · 24h</div></div>
      <div className="card stat"><div className="n">{stats?.sends_24h ?? 0}{(stats?.shadow_24h ?? 0) > 0 ? <span style={{ fontSize: 15, color: "var(--muted)", fontWeight: 500 }}> + {stats?.shadow_24h} shadow</span> : null}</div><div className="l">messages sent · 24h</div></div>
      <div className="card stat"><div className="n" style={{ color: (stats?.failed_24h ?? 0) ? "var(--bad)" : undefined }}>{stats?.failed_24h ?? 0}</div><div className="l">failed runs · 24h</div></div>
    </div>
    <h2>Companies</h2>
    {companies.length === 0 ? <div className="empty">No companies yet. <code>pnpm install:company …</code></div> :
    <div className="tbl"><table><thead><tr><th>Company</th><th>Status</th><th>Contacts</th><th>Workflows</th><th>Active runs</th><th>Last poll</th></tr></thead><tbody>
      {companies.map((c) => <tr key={c.id}><td><Link href={`/c/${c.slug}`}><strong>{c.name}</strong></Link> <span className="mono" style={{ color: "var(--muted)" }}>{c.slug}</span></td><td><span className={badge(c.status)}>{c.status}</span> <span className={c.mode === "live" ? "badge b-live" : "badge b-shadow"}>{c.mode}</span></td><td>{c.contacts}</td><td>{c.workflows}</td><td>{c.active_runs}</td><td>{c.last_poll ? ago(c.last_poll) : "never"}</td></tr>)}
    </tbody></table></div>}
    <h2>Recent runs</h2>
    <RunsTable runs={runs} />
  </>);
}

function Setup({ error }: { error: string }) {
  const noUrl = !process.env.DATABASE_URL;
  return (<>
    <h1>Engine</h1>
    <p className="sub">Deployed, not configured yet.</p>
    <div className="card" style={{ maxWidth: 720 }}>
      <h2 style={{ marginTop: 0 }}>What's missing</h2>
      <ol style={{ lineHeight: 1.9, paddingLeft: 20 }}>
        <li><strong>Database</strong> — {noUrl ? <>no <code>DATABASE_URL</code>. In Vercel: project → Storage → Create → Postgres. It sets the variable; redeploy.</> : <>connection failed: <code>{error}</code></>}</li>
        <li><strong>Migrate</strong> — <code>POST /api/admin/migrate</code> with <code>Authorization: Bearer CRON_SECRET</code>.</li>
        <li><strong>Install a company</strong> — <code>POST /api/admin/install</code> with the company JSON, same header. Workflows install off.</li>
      </ol>
    </div>
  </>);
}