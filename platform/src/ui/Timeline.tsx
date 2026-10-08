import type { Definition } from "@/engine/definition";
import { branchTitle, describeNode, exitWords } from "@/engine/describe";
import { badge, stamp } from "./format";

type Step = { node_id: string; node_type: string; status: string; started_at: Date; finished_at: Date | null; result: Record<string, unknown>; error: string | null };
type Send = { channel: string; status: string; rendered_body: string; sent_at: Date | null; suppressed_reason: string | null; error: string | null };

/**
 * What happened to one contact in one run, in order, with the clock: "10/08/26 @ 13:32 · Agreement signed", "13:33 · Add tag
 * stat-agreement-signed · shadow". The path they took, where it waited, where it failed. Read-only.
 */
export function Timeline({ def, steps, sends, tz, startedAt, status, exitReason, nextRunAt, currentNode }: { def: Definition; steps: Step[]; sends: Send[]; tz: string; startedAt: Date; status: string; exitReason: string | null; nextRunAt: Date | null; currentNode: string | null }) {
  const byId = new Map(def.nodes.map((n) => [n.id, n]));
  const words = (id: string) => { const n = byId.get(id); return n ? (n.type === "branch" ? branchTitle(def, id) : describeNode(n).title) : id; };
  const detail = (s: Step): string => {
    const r = s.result ?? {};
    if (s.error) return s.error;
    const bits: string[] = [];
    if (r.shadow) bits.push("shadow");
    for (const k of Object.keys(r)) if (k.startsWith("would_")) bits.push(`${k.replace(/^would_/, "would ").replace(/_/g, " ")}: ${short(r[k])}`);
    if (typeof r.why === "string") bits.push(r.why);
    if (typeof r.value === "string") bits.push(r.value);
    if (typeof r.until === "string") bits.push(`until ${stamp(r.until, tz)}`);
    if (typeof r.quiet_hours_until === "string") bits.push(`dark hours · until ${stamp(r.quiet_hours_until, tz)}`);
    if (typeof r.deadline === "string") bits.push(`reply deadline ${stamp(r.deadline, tz)}`);
    if (typeof r.replied_at === "string") bits.push(`they replied ${stamp(r.replied_at, tz)}`);
    if (r.timed_out) bits.push("no reply in time");
    if (typeof r.in_thread_of === "string") bits.push("in the thread");
    return bits.join(" · ");
  };
  const lastStep = steps.at(-1);
  return <ol className="tl">
    <li className="tl-row st-ok"><span className="tl-t">{stamp(startedAt, tz)}</span><span className="tl-w">Started{def.nodes.find((n) => n.type === "trigger") ? `: ${words(def.nodes.find((n) => n.type === "trigger")!.id)}` : ""}</span></li>
    {steps.filter((s) => s.node_type !== "trigger" && s.node_type !== "exit").map((s, i) => <li key={i} className={`tl-row st-${s.status}`}>
      <span className="tl-t">{stamp(s.started_at, tz)}</span>
      <span className="tl-w">{words(s.node_id)}<span className={badge(s.status)} style={{ marginLeft: 8 }}>{s.status}</span>{detail(s) ? <span className={`tl-d ${s.error ? "bad" : ""}`}>{detail(s)}</span> : null}</span>
    </li>)}
    {status === "waiting" && nextRunAt ? <li className="tl-row st-waiting"><span className="tl-t">{stamp(nextRunAt, tz)}</span><span className="tl-w">Next: {currentNode ? words(currentNode) : "continues"}<span className="badge b-waiting" style={{ marginLeft: 8 }}>scheduled</span></span></li> : null}
    {["completed", "exited", "failed", "paused"].includes(status) ? <li className={`tl-row st-${status === "completed" ? "ok" : status}`}><span className="tl-t">{stamp(lastStep?.finished_at ?? lastStep?.started_at ?? startedAt, tz)}</span><span className="tl-w">{status === "completed" ? exitWords(exitReason ?? "done") : status === "failed" ? "Failed" : status === "paused" ? "Paused" : `Stopped: ${(exitReason ?? "").replace(/_/g, " ")}`}{status === "failed" && exitReason ? <span className="tl-d bad">{exitReason}</span> : null}</span></li> : null}
    {sends.length ? <li className="tl-row tl-sends"><span className="tl-t" /><span className="tl-w"><div className="muted" style={{ fontSize: 12.5, letterSpacing: ".04em", textTransform: "uppercase", marginBottom: 4 }}>Messages</div>{sends.map((s, i) => <div key={i} className="tl-send"><span className="badge b-type">{s.channel}</span> <span className={badge(s.status)}>{s.status}</span> <span className="tl-body">{s.rendered_body.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 240)}</span>{s.suppressed_reason ? <span className="tl-d">{s.suppressed_reason}</span> : null}{s.error ? <span className="tl-d bad">{s.error}</span> : null}</div>)}</span></li> : null}
  </ol>;
}
const short = (v: unknown) => { const s = typeof v === "string" ? v : JSON.stringify(v); return s.length > 120 ? `${s.slice(0, 119)}…` : s; };
