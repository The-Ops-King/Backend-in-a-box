import type { PoolClient } from "pg";
import { many } from "@/db/client";
import { parseDefinition, type Definition, type Node } from "./definition";
import { describeNode, humanWords, pathWords, templateWords } from "./describe";

/**
 * D77. Which steps hold the run when they keep failing, and which are skipped so the rest still runs.
 *
 * A step is BLOCKING when the run cannot go on without it: it decides where the run goes or waits (trigger, branch, check,
 * the waits, set_var, record, record_outcome, update_opportunity, start_workflow, pause_runs, resume, exit), or a later
 * step on its path reads what it produced (`cards.<board>` / `opportunity.*` after a pipeline_card, `record.*` after a
 * crm_record, the `into` of a classify / analyze / webhook / report / eod_due, `appointment.<field>` after an
 * update_appointment that sets it, a slack_post a later blocking wait_for_reaction waits on). Everything else is
 * NON-BLOCKING: its effect lives outside the run (tags, notes, tasks, contact updates, sends, Slack posts and reactions,
 * documents, records and cards nothing later reads, an `optional` analyze). Derived from the definition alone;
 * `blocking: true|false` on a step overrides it.
 */
export type Role = { blocking: boolean; why: string };

const CONTROL: Partial<Record<Node["type"], string>> = {
  trigger: "it starts the run", exit: "it ends the run", branch: "it decides where the run goes", check: "it decides whether the run goes on",
  wait: "the run waits on it", wait_for_reply: "the run waits on it", wait_for_reaction: "the run waits on it", resume: "it decides where the run goes",
  set_var: "later steps read what it remembers", record: "it is the run's own ledger", record_outcome: "it is the run's own ledger",
  update_opportunity: "it is the run's own ledger", start_workflow: "it hands the run on", pause_runs: "it stops the person's other runs",
};

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const pathRe = (p: string) => new RegExp(`(?<![\\w.])${esc(p)}(?![\\w-])`);

/** The context paths a step writes for the steps after it; empty when its effect is outside the run. */
function outputsOf(n: Node): { re: RegExp; what: string }[] {
  switch (n.type) {
    case "pipeline_card": {
      const board = /^\{\{\s*crm\.pipeline_([a-zA-Z0-9_]+)\s*\}\}$/.exec(n.pipeline.trim())?.[1];
      return [{ re: board ? pathRe(`cards.${board}`) : /(?<![\w.])cards\./, what: board ? `the ${humanWords(board)} card` : "the card" }, { re: pathRe("opportunity"), what: "the opportunity" }];
    }
    case "crm_record": return [{ re: pathRe("record"), what: "the record's id" }];
    case "classify": return [n.into, "reply.confidence", "reply.intent_confidence", "reply.top_guesses"].map((p) => ({ re: pathRe(p), what: pathWords(p) }));
    case "analyze": return (Array.isArray(n.into) ? n.into : [n.into]).map((k) => ({ re: pathRe(`vars.${k}`), what: `the AI's ${humanWords(k)}` }));
    case "webhook": return n.into ? [{ re: pathRe(`vars.${n.into}`), what: "the response" }] : [];
    case "report": return [{ re: pathRe(`vars.${n.into}`), what: "the wrap-up" }];
    case "eod_due": return [{ re: pathRe(`vars.${n.into}`), what: "the lines" }, { re: pathRe("vars.overdue_lines"), what: "the overdue lines" }];
    case "update_appointment": return Object.keys(n.set).map((k) => ({ re: pathRe(`appointment.${k}`), what: `the appointment's ${humanWords(k)}` }));
    default: return [];
  }
}

/** Every path a step or an edge condition reads: the inside of each {{…}}, and each `exists`. Titles are words, not reads. */
function readsOf(v: unknown, key?: string, out: string[] = []): string[] {
  if (typeof v === "string") { if (key === "exists") out.push(v); else for (const m of v.matchAll(/\{\{([^}]*)\}\}/g)) out.push(m[1]); }
  else if (Array.isArray(v)) v.forEach((x) => readsOf(x, key, out));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) if (k !== "title" && k !== "description") readsOf(x, k, out);
  return out;
}

export function failureRoles(def: Definition): Map<string, Role> {
  const out = new Map<string, Role>();
  const next = new Map<string, string[]>();
  for (const e of def.edges) next.set(e.from, [...(next.get(e.from) ?? []), e.to]);
  const byId = new Map(def.nodes.map((n) => [n.id, n]));
  for (const n of def.nodes) {
    if (n.type !== "wait_for_reaction" && typeof n.blocking === "boolean") { out.set(n.id, { blocking: n.blocking, why: `set on the step (blocking: ${n.blocking})` }); continue; }
    const ctl = CONTROL[n.type];
    if (ctl) { out.set(n.id, { blocking: true, why: ctl }); continue; }
    if (n.type === "analyze" && n.optional) { out.set(n.id, { blocking: false, why: "optional: the steps after it go on without its answer" }); continue; }
    const outputs = outputsOf(n);
    // the steps after this one on any path, up to a step that writes the same output again (a later record step's own `relate` reads its own record)
    const rewrites = (m: Node) => m.type === n.type && (m.type === "crm_record" || (m.type === "pipeline_card" && n.type === "pipeline_card" && m.pipeline === n.pipeline));
    let reader: { id: string; what: string } | undefined;
    const seen = new Set([n.id]), queue = [...(next.get(n.id) ?? [])];
    while (queue.length && !reader) {
      const id = queue.shift()!; if (seen.has(id)) continue; seen.add(id);
      const m = byId.get(id)!;
      // a wait for a tap on this very post (a listener goes on without it, so only a blocking wait counts)
      if (n.type === "slack_post" && m.type === "wait_for_reaction" && m.blocking && (m.of === n.id || (!!n.tag && m.of === `tag:${n.tag}`))) { reader = { id, what: "the post" }; break; }
      const reads = [...readsOf(m.type === "crm_record" ? { ...m, relate: [] } : m), ...def.edges.filter((e) => e.from === id && e.when).flatMap((e) => readsOf(e.when))];
      const hit = outputs.find((o) => reads.some((r) => o.re.test(r)));
      if (hit) { reader = { id, what: hit.what }; break; }
      if (!rewrites(m)) queue.push(...(next.get(id) ?? []));
    }
    // a branch right after the step reads through its edges
    if (!reader) { const hit = outputs.find((o) => def.edges.some((e) => e.from === n.id && e.when && readsOf(e.when).some((r) => o.re.test(r)))); if (hit) reader = { id: n.id, what: hit.what }; }
    out.set(n.id, reader ? { blocking: true, why: `step ${reader.id} reads ${reader.what}` } : { blocking: false, why: "nothing later in the run reads what it does" });
  }
  return out;
}

const lower = (s: string) => s.replace(/^[A-Z](?![A-Z])/, (c) => c.toLowerCase());
const quoteList = (v: string | string[] | undefined) => (v === undefined ? [] : Array.isArray(v) ? v : [v]).map((t) => `“${/^\s*\{\{/.test(t) ? templateWords(t) : t}”`).join(", ");

/** What the step does, as the words after "Couldn't": "add the tag “stat-showed”", "send the text". */
export function doingWords(n: Node): string {
  switch (n.type) {
    case "set_tag": return `add the tag ${quoteList(n.tag)}`;
    case "remove_tag": return `take off the tag ${quoteList(n.tag)}`;
    case "tags": return [n.add ? `add the tag ${quoteList(n.add)}` : "", n.remove ? `take off ${quoteList(n.remove)}` : ""].filter(Boolean).join(" and ") || "change the tags";
    case "note": return "leave the note on the contact";
    case "update_contact": return "update the contact in the CRM";
    case "create_task": return `create the task “${templateWords(n.title)}”`;
    case "notify_owner": return "nudge the contact's owner";
    case "send_sms": return "send the text";
    case "send_email": return `send the email “${templateWords(n.subject)}”`;
    case "send_document": return "send the agreement for signature";
    case "slack_post": return n.title ? lower(n.title) : n.thread_of ? "reply in the Slack thread" : `post to Slack (${pathWords(n.channel)})`;
    case "pipeline_card": return `move the ${pathWords(n.pipeline).replace(/^pipeline /, "")} card${n.title ? ` (${n.title})` : ""}`;
    case "crm_record": return `${n.if_missing === "create" ? "create" : "update"} the ${humanWords(n.object.replace(/^custom_objects\./, "")).replace(/\b[a-z]/g, (c) => c.toUpperCase())} record`;
    case "update_appointment": return "update the booking in the CRM";
    case "webhook": return `call ${n.url.replace(/^https?:\/\//, "").split(/[/?]/)[0] || "the webhook"}`;
    default: return lower(n.title ?? describeNode(n).title);
  }
}

/**
 * Other workflows that lean on what a skipped step would have done, in words for the alert ("" when none): the booking
 * status it sets starts them, or they update the card / record this step makes. D77: never skipped without saying so.
 */
export async function dependentsWords(c: PoolClient, companyId: string, workflowId: string, n: Node): Promise<string> {
  // the one write whose event the engine dispatches to other workflows itself (a tag or a send is only noted in the ledger)
  const events = n.type === "update_appointment" && "status" in n.set ? ["appointment.status_changed"] : [];
  const names = new Set<string>();
  if (events.length) for (const r of await many<{ name: string }>(c, "select distinct w.name from workflow_triggers t join workflows w on w.id=t.workflow_id where t.company_id=$1 and t.enabled and w.enabled and w.id<>$2 and t.event_type = any($3::text[])", [companyId, workflowId, events])) names.add(r.name);
  if ((n.type === "crm_record" && n.if_missing === "create") || (n.type === "pipeline_card" && n.if_missing === "create")) {
    const others = await many<{ name: string; definition: unknown }>(c, "select w.name, v.definition from workflows w join workflow_versions v on v.workflow_id=w.id and v.version=w.current_version where w.company_id=$1 and w.enabled and w.id<>$2", [companyId, workflowId]);
    for (const o of others) {
      let def: Definition; try { def = parseDefinition(o.definition); } catch { continue; }
      if (def.nodes.some((m) => (n.type === "crm_record" && m.type === "crm_record" && m.object === n.object && m.if_missing !== "create") || (n.type === "pipeline_card" && m.type === "pipeline_card" && m.pipeline === n.pipeline && m.if_missing === "skip"))) names.add(o.name);
    }
  }
  if (!names.size) return "";
  const list = [...names].sort().map((x) => `"${x}"`).join(", ");
  return n.type === "crm_record" || n.type === "pipeline_card" ? ` ${list} ${names.size === 1 ? "updates" : "update"} what this step makes and will find nothing until it is retried.` : ` ${list} ${names.size === 1 ? "starts" : "start"} on what this step does and did not start for it.`;
}
