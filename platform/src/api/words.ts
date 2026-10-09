import { DateTime } from "luxon";
import type { Definition, Node, Edge } from "@/engine/definition";
import { branchTitle, collapsePlumbing, describeNode, durationWords, edgeWords, exitWords, humanWords, pathWords, predicateWords, waitWords, templateWords, walkOrder } from "@/engine/describe";
import { exampleContext, nodeExamples } from "@/engine/example";
import { scheduleWords } from "@/engine/when";
import type { Projected } from "@/engine/project";

/**
 * The words the dashboard shows for a workflow and for one run of it. The engine's own describe.ts says what a node does;
 * this file arranges that into the two shapes the pages use: the chart (nodes and edges with words) and the path (what one
 * run did, step by step, with the state of each step). The client lays the chart out; it never reads a definition itself.
 */
export type ChartKind = "trig" | "send" | "wait" | "reply" | "fork" | "check" | "tag" | "slack" | "crm" | "ai" | "end" | "other";
export type ChartNode = { id: string; kind: ChartKind; title: string; meta?: string; detail?: string; quote?: string; cond?: string; channel?: "sms" | "email" | "slack"; hidden?: boolean };
export type ChartEdge = { from: string; to: string; label: string; else?: boolean };
export type Chart = { nodes: ChartNode[]; edges: ChartEdge[] };

export type StepState = "ok" | "ghost" | "skip" | "warn" | "here" | "next" | "stop";
export type PathItem = { node_id: string; title: string; meta?: string; kind: ChartKind; state: StepState; at: string | null; note?: string; channel?: "sms" | "email" | "slack"; words?: string | null; send_state?: string };

export function kindOf(n: Node): ChartKind {
  switch (n.type) {
    case "trigger": return "trig";
    case "send_sms": case "send_email": case "notify_owner": case "send_document": return "send";
    case "wait": return "wait";
    case "wait_for_reply": return "reply";
    case "branch": return "fork";
    case "check": return "check";
    case "set_tag": case "remove_tag": return "tag";
    case "slack_post": return "slack";
    case "classify": case "analyze": return "ai";
    case "exit": return "end";
    case "update_contact": case "update_appointment": case "update_opportunity": case "pipeline_card": case "crm_record": case "create_task": case "record_outcome": case "note": return "crm";
    default: return "other";
  }
}

const channelOf = (n: Node): ChartNode["channel"] => n.type === "send_sms" ? "sms" : n.type === "send_email" ? "email" : n.type === "slack_post" || n.type === "notify_owner" ? "slack" : undefined;

/** Short title for a node on the chart or in a step row: "Text", "Email: You're booked", "Wait until 3 days before the call". */
export function shortTitle(def: Definition, n: Node): { title: string; meta?: string } {
  switch (n.type) {
    case "trigger": return n.schedule ? { title: "On a schedule", meta: scheduleWords(n.schedule) } : { title: describeNode(n).title.replace(/ — .*$/, "") };
    case "send_sms": return { title: "Text" };
    case "send_email": return { title: "Email", meta: templateWords(n.subject) };
    case "wait": { const w = waitWords(n.rule).replace(/^Wait (until )?/, "").replace(/\s*\(.*\)$/, "").replace(/^(\d+) hours?/, (_, h) => (+h >= 48 && +h % 24 === 0 ? `${+h / 24} days` : `${h} hour${+h === 1 ? "" : "s"}`)); return { title: w.replace(/^./, (c) => c.toUpperCase()) }; }
    case "wait_for_reply": return { title: "Wait for a reply", meta: `up to ${durationWords(n.timeout)}` };
    case "branch": { const outs = def.edges.filter((e) => e.from === n.id); const whens = outs.filter((e) => e.when); const reply = whens.length && whens.every((e) => JSON.stringify(e.when).includes("reply.")); return { title: reply ? "What did they say?" : whens.length === 1 ? `${edgeWords(whens[0]).replace(/^./, (c) => c.toUpperCase())}?` : branchTitle(def, n.id) }; }
    case "check": return { title: `Only if ${predicateWords(n.when)}` };
    case "slack_post": return { title: n.thread_of ? "Reply in the thread" : "Tell the team" };
    case "notify_owner": return { title: "Nudge the owner" };
    case "classify": return { title: "AI reads the reply" };
    case "analyze": return { title: `AI: ${({ classify: "is it a sales call?", notes: "call notes", rubric: "scores the call", objections: "objections" } as Record<string, string>)[n.into] ?? humanWords(n.into)}` };
    case "update_contact": return { title: "Update the contact" };
    case "pipeline_card": return { title: n.stage ? (n.if_missing === "skip" ? "Move the card" : "Create or move the card") : "Update the card", meta: n.stage ? pathWords(n.stage) : undefined };
    case "crm_record": return { title: `Write the ${humanWords(n.object.replace(/^custom_objects\./, ""))} record` };
    case "create_task": return { title: n.assign_to ? `Task for ${pathWords(n.assign_to)}` : "Task for the team" };
    case "note": return { title: "Leave a note" };
    case "record_outcome": return { title: `Record the call as ${n.outcome.replace(/_/g, " ")}` };
    case "update_appointment": return { title: `Mark the call ${Object.values(n.set).map((v) => String(v).replace(/_/g, " ")).join(", ")}` };
    case "exit": return { title: exitWords(n.reason) };
    default: { const d = describeNode(n); return { title: d.title }; }
  }
}

/** The chart for a workflow: every node with its words, every edge with its label. Plumbing (set_var) is routed around. */
export function chartOf(full: Definition, company: { name: string; timezone: string }, bindings: Record<string, string> = {}): Chart {
  const def = collapsePlumbing(full);
  const ctx = exampleContext(company, bindings);
  const nodes: ChartNode[] = def.nodes.map((n) => {
    const d = describeNode(n); const s = shortTitle(def, n);
    let quote: string | undefined;
    try { quote = n.type === "send_sms" || n.type === "send_email" || n.type === "slack_post" || n.type === "notify_owner" || n.type === "note" ? strip(nodeExamples(n, ctx, company.timezone)[0]?.example.text) : undefined; } catch { quote = d.quote; }
    const cond = n.type === "send_sms" || n.type === "send_email" ? (n.validity?.min_lead ? `Only when the call is more than ${durationWords(n.validity.min_lead)} away when this comes due` : undefined) : n.type === "check" ? `If not: ${exitWords(n.else_exit).toLowerCase()}` : undefined;
    // the AI reading a reply is plumbing between the wait and the fork; the chart routes around it, the popover of the fork says so
    return { id: n.id, kind: kindOf(n), title: s.title, meta: s.meta, detail: d.detail, quote, cond, channel: channelOf(n), hidden: n.type === "classify" || undefined };
  });
  const edges: ChartEdge[] = def.edges.map((e) => ({ from: e.from, to: e.to, label: edgeWords(e), else: e.else || undefined }));
  return { nodes, edges };
}

const strip = (t: string | undefined) => t === undefined ? undefined : t.replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>/gi, "\n").replace(/<[^>]+>/g, "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();

type StepRow = { node_id: string; node_type: string; status: string; started_at: Date; finished_at: Date | null; result: Record<string, unknown>; error: string | null };
type SendRow = { idempotency_key: string; channel: string; status: string; rendered_body: string; sent_at: Date | null; suppressed_reason: string | null; error: string | null };
type RunLike = { id: string; status: string; current_node: string | null; next_run_at: Date | null; exit_reason: string | null; started_at: Date };

/** A step's one-line fact, in words: why it was skipped, what failed, when they replied. */
function noteOf(s: StepRow, tz: string): string | undefined {
  const r = s.result ?? {};
  if (s.error) return s.error;
  if (s.status === "stale" || s.status === "skipped") {
    if (typeof r.why === "string") return `Didn't go out: ${r.why}`;
    if (r.kind === "noop") return "Nothing to do here";
    return "Skipped";
  }
  const bits: string[] = [];
  if (typeof r.replied_at === "string") bits.push(`They replied ${stamp(r.replied_at, tz)}`);
  if (r.timed_out) bits.push("No reply in time");
  if (typeof r.value === "string" && r.value) bits.push(r.value);
  if (typeof r.quiet_hours_until === "string") bits.push(`Held for the send window until ${stamp(r.quiet_hours_until, tz)}`);
  return bits.join(" · ") || undefined;
}
const stamp = (iso: string, tz: string) => DateTime.fromISO(iso).setZone(tz).toFormat("ccc LLL d · h:mm a");

/**
 * What one run did and will do, in order: the steps it ran (their state and words), where it waits now, and the plan from
 * there. The strip on a list row and the feed on the run page are both this list.
 */
export function pathOf(full: Definition, run: RunLike, steps: StepRow[], sends: SendRow[], plan: Projected[], tz: string): PathItem[] {
  const def = collapsePlumbing(full);
  const byId = new Map(def.nodes.map((n) => [n.id, n]));
  const out: PathItem[] = [];
  const sendFor = (nodeId: string) => sends.find((s) => s.idempotency_key === `${run.id}:${nodeId}`);
  const live = run.status === "active" || run.status === "waiting";
  // the trigger: a run always starts with one, whether or not a step row says so
  const trig = def.nodes.find((n) => n.type === "trigger" && (steps[0]?.node_id === n.id || !steps.some((s) => s.node_type === "trigger"))) ?? def.nodes.find((n) => n.type === "trigger");
  if (trig && !steps.some((s) => s.node_type === "trigger")) { const t = shortTitle(def, trig); out.push({ node_id: trig.id, title: t.title, meta: t.meta, kind: "trig", state: "ok", at: run.started_at.toISOString() }); }
  const order = new Map(walkOrder(def).map((id, i) => [id, i]));
  steps = [...steps].sort((a, b) => a.started_at.getTime() - b.started_at.getTime() || (order.get(a.node_id) ?? 999) - (order.get(b.node_id) ?? 999));
  const seen = new Set<string>();
  steps.forEach((s, i) => {
    if (s.node_type === "set_var") return;
    const n = byId.get(s.node_id);
    const t = n ? shortTitle(def, n) : { title: s.node_id };
    const last = i === steps.length - 1;
    let state: StepState = s.status === "ok" ? "ok" : s.status === "skipped" || s.status === "stale" ? "skip" : s.status === "failed" ? "warn" : s.status === "waiting" ? (live && run.current_node === s.node_id && !steps.slice(i + 1).some((x) => x.node_id === s.node_id) ? "here" : "ok") : s.status === "paused" ? "stop" : "ok";
    if (s.node_type === "wait" && state === "ok" && last && live && run.current_node === s.node_id) state = "here";
    if (state === "ok" && s.result?.shadow) state = "ghost";
    void last;
    // a wait row that already fired reads as done; a wait row the run still sits on reads as "here" with when it moves
    const send = sendFor(s.node_id);
    const item: PathItem = { node_id: s.node_id, title: t.title, meta: t.meta, kind: n ? kindOf(n) : "other", state, at: (state === "here" ? run.next_run_at?.toISOString() : null) ?? s.started_at.toISOString(), note: noteOf(s, tz) };
    if (n) item.channel = channelOf(n);
    if (state === "ghost") item.note = [item.note, "Done in shadow: nothing was written to the CRM or sent to anyone; this is what it would have done."].filter(Boolean).join(" · ");
    if (send && send.rendered_body) { item.words = send.channel === "slack" ? send.rendered_body : strip(send.rendered_body) ?? null; item.send_state = send.status; if (send.status === "failed" && send.error) item.note = send.error; }
    if (s.node_type === "exit" && state === "ok") item.title = exitWords(run.exit_reason ?? "done");
    // the runner writes a second row for the same node when it parks and resumes (dark hours, a wait): one row, the later state
    if (out.length && out[out.length - 1].node_id === s.node_id) out[out.length - 1] = { ...out[out.length - 1], ...item, at: out[out.length - 1].at ?? item.at };
    else out.push(item);
    seen.add(s.node_id);
  });
  if (live) {
    // parked before any step row for the node (a wait the runner has not reached, or a reply-wait): say where
    const cur = run.current_node;
    if (cur && !out.some((x) => x.state === "here")) {
      const n = byId.get(cur);
      if (n) { const t = shortTitle(def, n); out.push({ node_id: cur, title: t.title, meta: t.meta, kind: kindOf(n), state: "here", at: run.next_run_at?.toISOString() ?? null, channel: channelOf(n) }); }
    }
    for (const p of plan) {
      if (out.some((x) => x.node_id === p.node_id && (x.state === "here" || x.state === "next"))) continue;
      const n = byId.get(p.node_id); const t = n ? shortTitle(def, n) : { title: p.title };
      out.push({ node_id: p.node_id, title: t.title, meta: t.meta, kind: n ? kindOf(n) : "other", state: "next", at: p.at, note: p.note, channel: n ? channelOf(n) : undefined });
    }
  } else if (run.status === "failed" && !out.some((x) => x.state === "warn")) {
    const cur = run.current_node; const n = cur ? byId.get(cur) : undefined;
    out.push({ node_id: cur ?? "?", title: n ? shortTitle(def, n).title : "Failed", kind: n ? kindOf(n) : "other", state: "warn", at: null, note: run.exit_reason ?? undefined });
  } else if (run.status === "exited" && !out.some((x) => x.kind === "end")) {
    out.push({ node_id: "exit", title: `Done: ${(run.exit_reason ?? "").replace(/^moot: /, "").replace(/_/g, " ")}`, kind: "end", state: "ok", at: run.started_at.toISOString() });
  }
  return out;
}

/** One run's state for a list row: the icon, the word under the strip, the date. */
export function runState(run: RunLike, path: PathItem[], tz: string): { state: "ok" | "here" | "warn" | "stop"; at: string; done: boolean } {
  if (run.status === "completed") { const words = exitWords(run.exit_reason ?? "done"); return { state: "ok", at: words === "Done" ? "done" : `done · ${words.replace(/^(Done|Stop): /, "").toLowerCase()}`, done: true }; }
  if (run.status === "failed") { const w = path.find((x) => x.state === "warn"); return { state: "warn", at: `failed: ${w ? w.title : run.exit_reason ?? "a step"}`, done: true }; }
  if (run.status === "exited") return { state: "ok", at: `done · ${(run.exit_reason ?? "").replace(/^moot: /, "").replace(/_/g, " ")}`, done: true };
  if (run.status === "paused") return { state: "stop", at: "paused", done: true };
  const here = path.find((x) => x.state === "here");
  return { state: "here", at: here ? `${here.title}${here.meta ? ` · ${here.meta}` : ""}` : "in flight", done: false };
}
export { stamp as stampWords };
