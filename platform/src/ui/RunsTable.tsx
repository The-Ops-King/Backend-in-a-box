import Link from "next/link";
import type { recentRuns } from "./queries";
import { ago, badge, when } from "./format";
export function RunsTable({ runs, slug }: { runs: Awaited<ReturnType<typeof recentRuns>>; slug?: string }) {
  if (!runs.length) return <div className="empty">No runs yet.</div>;
  return <div className="tbl"><table><thead><tr><th>Workflow</th><th>Contact</th><th>Status</th><th>At node</th><th>Next / exit</th><th>Started</th></tr></thead><tbody>
    {runs.map((r) => <tr key={r.id}><td><Link href={`/c/${slug ?? r.company_slug}/r/${r.id}`}>{r.workflow}</Link></td><td><Link href={`/c/${slug ?? r.company_slug}/contacts/${r.contact_id}`}>{r.contact.trim() || "—"}</Link></td><td><span className={badge(r.status)}>{r.status}</span></td><td className="mono">{r.current_node ?? "—"}</td><td>{r.status === "waiting" ? when(r.next_run_at) : r.exit_reason ?? "—"}</td><td>{ago(r.started_at)}</td></tr>)}
  </tbody></table></div>;
}
