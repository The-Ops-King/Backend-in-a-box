import Link from "next/link";
import type { Projected } from "@/engine/project";
import { when } from "./format";

/** "Released to the next step at …": the plan a run will follow, in order. */
export function PlanList({ plan, tz }: { plan: Projected[]; tz: string }) {
  if (!plan.length) return <div className="body muted">Nothing scheduled: this run moves when something happens (a reply, an event).</div>;
  return <ol className="plan">{plan.map((p, i) => <li key={i} className={`plan-${p.kind}`}><span className="plan-at">{p.at ? when(p.at, tz) : "—"}</span><span><strong>{p.title}</strong>{p.note ? <span className="muted"> · {p.note}</span> : null}</span></li>)}</ol>;
}

export function NextUp({ runs, slug, tz, showContact = false }: { runs: { run_id: string; workflow: string; contact_id: string | null; contact: string; status: string; next_run_at: Date | null; plan: Projected[] }[]; slug: string; tz: string; showContact?: boolean }) {
  if (!runs.length) return <div className="empty">Nothing in flight.</div>;
  return <div style={{ display: "grid", gap: 10 }}>{runs.map((r) => <div key={r.run_id} className="card">
    <div style={{ display: "flex", gap: 12, alignItems: "baseline", flexWrap: "wrap" }}>
      <strong><Link href={`/c/${slug}/r/${r.run_id}`}>{r.workflow}</Link></strong>
      {showContact ? (r.contact_id ? <Link href={`/c/${slug}/contacts/${r.contact_id}`}>{r.contact || "contact"}</Link> : <span className="muted">{r.contact}</span>) : null}
      <span className={`badge b-${r.status}`}>{r.status}</span>
      {r.next_run_at ? <span className="muted">releases {when(r.next_run_at, tz)}</span> : null}
    </div>
    <PlanList plan={r.plan} tz={tz} />
  </div>)}</div>;
}
