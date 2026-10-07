import Link from "next/link";
import type { Readiness as R, Issue } from "@/engine/readiness";

/** The honest answer to "can I go live?", with every reason it is no. */
export function ReadinessCard({ r, title = "Ready to go live?" }: { r: R; title?: string }) {
  const blockers = r.issues.filter((i) => i.level === "blocker"), warnings = r.issues.filter((i) => i.level === "warning");
  return (
    <div className={`card ready ${r.ready ? "ready-yes" : "ready-no"}`} style={{ marginBottom: 6 }}>
      <div style={{ display: "flex", gap: 12, alignItems: "baseline", flexWrap: "wrap" }}>
        <strong style={{ fontSize: 18 }}>{title}</strong>
        <span className={`badge ${r.ready ? "b-live" : "b-failed"}`}>{r.ready ? "nothing blocking" : `${blockers.length} blocking`}</span>
        {warnings.length ? <span className="badge b-shadow">{warnings.length} to know about</span> : null}
      </div>
      {r.issues.length ? <ul className="ready-list">{[...blockers, ...warnings].map((i, n) => <IssueLine key={n} i={i} />)}</ul> : <div className="body muted">Everything this company needs is wired.</div>}
    </div>
  );
}
function IssueLine({ i }: { i: Issue }) {
  return <li className={i.level}><span className={`badge ${i.level === "blocker" ? "b-failed" : "b-shadow"}`}>{i.level === "blocker" ? "blocks" : "note"}</span> {i.text}{i.href ? <> <Link href={i.href}>open</Link></> : null}</li>;
}
