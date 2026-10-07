import { DateTime } from "luxon";
import type { Definition, Node } from "./definition";
import { describeNode, branchTitle, edgeWords } from "./describe";
import { computeWaitUntil, deferIntoWindow } from "./waitrule";
import { resolvePath } from "./template";
import type { CompanyRow, RunRow } from "./context";

/**
 * What a run is going to do next, and when: the plan the engine will follow from where the run stands, computed with the
 * same wait and dark-hours rules the runner uses. Follows the straight path; stops at a decision (we cannot know the
 * answer yet), a reply-wait (we cannot know when they reply), or the exit. GHL shows "released to the next step at …";
 * this is that, for every parked contact.
 */
export type Projected = { node_id: string; title: string; kind: "wait" | "send" | "step" | "decision" | "exit"; at: string | null; note?: string };

export function projectRun(def: Definition, run: Pick<RunRow, "status" | "current_node" | "next_run_at" | "context">, company: Pick<CompanyRow, "timezone" | "send_window_start" | "send_window_end" | "quiet_allow_transactional">, ctx: Record<string, unknown>, now: DateTime<boolean> = DateTime.now()): Projected[] {
  if (!["active", "waiting"].includes(run.status)) return [];
  const byId = new Map(def.nodes.map((n) => [n.id, n]));
  const next = (id: string) => def.edges.filter((e) => e.from === id);
  const contactTz = ((ctx.contact as { timezone?: string } | undefined)?.timezone) ?? company.timezone;
  const out: Projected[] = [];
  let cursor: DateTime = run.next_run_at ? DateTime.fromJSDate(new Date(run.next_run_at)) : now;
  if (cursor < now) cursor = now;
  let id: string | null = run.current_node ?? def.nodes.find((n) => n.type === "trigger")?.id ?? null;
  for (let i = 0; id && i < 14; i++) {
    const n: Node | undefined = byId.get(id); if (!n) break;
    const d = n.type === "branch" ? { title: branchTitle(def, id) } : describeNode(n);
    if (n.type === "wait") {
      const pinned = n.rule.anchor === "now" ? (resolvePath(ctx, `vars.__wait.${n.id}.until`) as string | undefined) : undefined;
      let at: DateTime;
      try { at = pinned ? DateTime.fromISO(pinned) : deferIntoWindow(computeWaitUntil(n.rule, { now: cursor, contactTz, companyTz: company.timezone, ctx }).at, contactTz, company.send_window_start, company.send_window_end).at; }
      catch { out.push({ node_id: id, title: d.title, kind: "wait", at: null, note: "cannot compute yet (no appointment time)" }); break; }
      if (at > cursor) cursor = at;
      out.push({ node_id: id, title: d.title, kind: "wait", at: cursor.toISO() });
    } else if (n.type === "wait_for_reply") {
      out.push({ node_id: id, title: d.title, kind: "wait", at: null, note: `moves on the moment they reply, or after ${n.timeout}` });
      break;
    } else if (n.type === "send_sms" || n.type === "send_email") {
      const dark = n.kind === "transactional" && company.quiet_allow_transactional ? { at: cursor, deferred: false } : deferIntoWindow(cursor, contactTz, company.send_window_start, company.send_window_end);
      if (dark.deferred) cursor = dark.at;
      out.push({ node_id: id, title: d.title, kind: "send", at: cursor.toISO(), note: dark.deferred ? "held until the send window opens" : undefined });
    } else if (n.type === "branch" || n.type === "check") {
      out.push({ node_id: id, title: d.title, kind: "decision", at: cursor.toISO(), note: n.type === "check" ? `if not → ${describeNode(n).detail?.replace(/^If not → /, "") ?? "stops"}` : next(id).map(edgeWords).filter(Boolean).join(" / ") });
      break;
    } else if (n.type === "exit") {
      out.push({ node_id: id, title: d.title, kind: "exit", at: cursor.toISO() }); break;
    } else if (n.type !== "trigger") {
      out.push({ node_id: id, title: d.title, kind: "step", at: cursor.toISO() });
    }
    const edges = next(id).filter((e) => e.label !== "timeout");
    id = (edges[0] ?? next(id)[0])?.to ?? null;
  }
  return out;
}
