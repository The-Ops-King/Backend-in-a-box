import { Node, type Definition } from "./definition";

/**
 * D33, continued. Everything a workflow step depends on outside the engine, listed from the definition itself, so the
 * sweep checks every step of every workflow without anyone remembering to add it. A new node type must declare what it
 * needs here (NODE_NEEDS) or coverage.test fails: nothing ships unchecked.
 *
 * Kinds the sweep knows how to verify live, and kinds it can only report as "not verifiable" (VERIFIES).
 */
export type RefKind = "webhook"
  | "binding"            // a {{crm.*}} / {{calendar.*}} / {{slack.channel.*}} / {{prompt.*}} / {{secret.*}} the step reads
  | "ghl_template"       // an SMS snippet / email builder template id in the CRM
  | "custom_object"      // a custom object key the step writes records to
  | "workflow"           // another workflow this one hands off to
  | "classify_domain"    // a core_categories domain the classifier chooses from
  | "event"              // the event type a trigger listens for
  | "documents"          // Documents & Contracts send (needs the token's documents scope)
  | "anthropic"          // the AI key
  | "slack"              // a Slack connection (DMs; channel is a binding)
  | "url";               // a literal http(s) link in copy that a person will click

export type Ref = { kind: RefKind; value: string; node: string; what: string };
export const VERIFIES: Record<RefKind, "live" | "unverifiable"> = {
  binding: "live", custom_object: "live", workflow: "live", classify_domain: "live", event: "live", anthropic: "live", slack: "live", url: "live",
  ghl_template: "unverifiable",   // GHL has no cheap "does template X exist" read for snippets/builder templates
  documents: "unverifiable",      // listing templates needs the documents scope the shadow token does not carry
  webhook: "unverifiable",        // a POST endpoint is not probed: a GET or HEAD at it would be a false alarm (and sometimes a real call)
};

const refsIn = (v: unknown, node: string, what: string, out: Ref[]) => {
  const walk = (x: unknown) => {
    if (typeof x === "string") {
      for (const m of x.matchAll(/\{\{\s*([a-zA-Z0-9_.]+)/g)) { const p = m[1]; if (/^(crm|calendar|slack\.channel|prompt|secret)\./.test(p)) out.push({ kind: "binding", value: p.startsWith("calendar.") || p.startsWith("prompt.") ? p.split(".").slice(0, 2).join(".") : p.startsWith("slack.channel.") ? p.split(".").slice(0, 3).join(".") : p.split(" ")[0], node, what }); }
      for (const m of x.matchAll(/https?:\/\/[^\s<>|"')\]]+/g)) if (!/\{\{/.test(m[0])) out.push({ kind: "url", value: m[0].replace(/[.,;:]+$/, ""), node, what });
    } else if (Array.isArray(x)) x.forEach(walk);
    else if (x && typeof x === "object") Object.values(x).forEach(walk);
  };
  walk(v);
};

/** What each node type needs from outside, beyond the bindings its templates mention. Every type in the Node union must be here. */
export const NODE_NEEDS: { [T in Node["type"]]: (n: Extract<Node, { type: T }>) => Ref[] } = {
  trigger: (n) => (n.schedule ? [] : [{ kind: "event", value: n.event, node: n.id, what: "the event it starts on" }]),
  webhook: (n) => [{ kind: "webhook", value: n.url, node: n.id, what: "the endpoint it calls" }],
  health_check: () => [], availability_check: () => [], report: () => [], assume_no_show: () => [],
  wait: () => [], wait_for_reply: () => [], branch: () => [], check: () => [], exit: () => [], set_var: () => [], pause_runs: () => [],
  send_sms: (n) => (n.ghl_template ? [{ kind: "ghl_template", value: n.ghl_template, node: n.id, what: "the CRM text template" }] : []),
  send_email: (n) => (n.ghl_template ? [{ kind: "ghl_template", value: n.ghl_template, node: n.id, what: "the CRM email template" }] : []),
  slack_post: (n) => [{ kind: "slack", value: "connection", node: n.id, what: "Slack" }],
  notify_owner: (n) => [{ kind: "slack", value: "connection", node: n.id, what: "Slack (DM)" }],
  send_document: (n) => [{ kind: "documents", value: n.template, node: n.id, what: "the agreement template" }],
  set_tag: () => [], remove_tag: () => [], note: () => [], update_appointment: () => [], update_opportunity: () => [], update_contact: () => [], create_task: () => [], record_outcome: () => [], pipeline_card: () => [],
  crm_record: (n) => [{ kind: "custom_object", value: n.object, node: n.id, what: "the custom object" }],
  classify: (n) => [{ kind: "classify_domain", value: n.domain, node: n.id, what: "the options the AI picks from" }],
  analyze: (n) => [{ kind: "anthropic", value: "key", node: n.id, what: "the AI key" }],
  start_workflow: (n) => [{ kind: "workflow", value: n.workflow, node: n.id, what: "the workflow it hands off to" }],
};

/** Every outside dependency of a workflow, deduplicated by (kind, value). */
export function workflowRefs(def: Definition): Ref[] {
  const out: Ref[] = [];
  for (const n of def.nodes) {
    refsIn(n, n.id, n.type.replace(/_/g, " "), out);
    out.push(...(NODE_NEEDS[n.type] as (x: Node) => Ref[])(n));
  }
  refsIn(def.edges, "edges", "a branch condition", out);
  const seen = new Set<string>();
  return out.filter((r) => { const k = `${r.kind}:${r.value}`; if (seen.has(k)) return false; seen.add(k); return true; });
}

/** The node types the engine runs, from the schema itself. */
export const NODE_TYPES: Node["type"][] = Node.options.map((o) => o.shape.type.value as Node["type"]);
