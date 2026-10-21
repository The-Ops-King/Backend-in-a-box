import fs from "node:fs";
import path from "node:path";
import { extractManifest, type Definition, type Edge, type Node } from "@/engine/definition";
import { constsOf, describeNode, edgeWords, onlyIfWords, predicateWords, untilWords, waitWords, walkOrder } from "@/engine/describe";
import { failureRoles } from "@/engine/blocking";

/**
 * The behavior spec: one offer's workflows written out so nothing is hidden. Every step in the order the run meets it,
 * numbered, with its exact words, conditions, waits, failure behaviour and every way out; the bindings it reads; and the
 * engine rules that act on it without being a step. Output is deterministic (sorted, no clock except `generatedAt`) so a
 * re-run diffs only where behaviour changed.
 */

export type SpecSource = "db" | "repo";

export type OfferInfo = {
  slug: string;
  name: string;
  source: SpecSource;
  timezone?: string;
  mode?: string;
  status?: string;
  smsEnabled?: boolean;
  sendWindow?: { start: string; end: string; transactionalAnyHour: boolean };
  playbook?: string;
};

export type WorkflowInfo = {
  slug: string;                       // file name
  name: string;
  stage?: string | null;
  template?: { slug: string; version?: number | null } | null;
  diverged?: boolean | null;
  enabled?: boolean | null;
  mode?: string | null;               // the workflow's own rung; null follows the offer
  sendsUnlockedAt?: string | null;
  sendsUnlockedBy?: string | null;
  version?: number | null;
  reentryWindow?: string | null;
  origin: string;                     // where this definition came from, in words
  note?: string | null;
  takesOver?: string | null;
  definition: Definition;
  bindings?: Record<string, string | { secret: true }>;   // db: the offer's values; repo: absent
};

/** Where in the engine each rule lives, located by an anchor line in the source so citations stay right as the files change. */
const ENGINE = path.resolve(__dirname, "../engine");
export function locate(file: string, anchor: string): string {
  const p = path.join(ENGINE, file);
  const lines = fs.existsSync(p) ? fs.readFileSync(p, "utf8").split("\n") : [];
  const i = lines.findIndex((l) => l.includes(anchor));
  return `platform/src/engine/${file}${i >= 0 ? `:${i + 1}` : ""}`;
}

const SENDS = new Set(["send_sms", "send_email", "send_document", "webhook"]);
const CRM_WRITES = new Set(["tags", "set_tag", "remove_tag", "update_contact", "ensure_contact", "create_task", "note", "update_appointment", "update_opportunity", "pipeline_card", "crm_record", "record_outcome"]);
const WAITS = new Set(["wait", "wait_for_reply", "wait_for_reaction", "wait_for_event"]);

const fence = (s: string, lang = "") => { const ticks = s.includes("```") ? "````" : "```"; return `${ticks}${lang}\n${s}\n${ticks}`; };
const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
const yes = (b: boolean | null | undefined, t: string, f: string, unknown = "unknown (repo)") => b === undefined || b === null ? unknown : b ? t : f;

/** The words a step sends or posts, verbatim, each under its own label. */
function messagesOf(n: Node): { label: string; text: string }[] {
  const out: { label: string; text: string }[] = [];
  const add = (label: string, text: unknown) => { if (typeof text === "string" && text !== "") out.push({ label, text }); };
  switch (n.type) {
    case "send_sms": add("Text message", n.template); add("Text used instead when the timing is stale", n.substitute_template); add("CRM snippet that replaces the text when found", n.ghl_template); break;
    case "send_email": add("Email subject", n.subject); add("Email body", n.template); add("Body used instead when the timing is stale", n.substitute_template); add("CRM email template that replaces it when found", n.ghl_template); break;
    case "slack_post": add("Slack post", n.template); for (const b of n.buttons ?? []) add(`Button "${b.text}" (${b.action}, value)`, b.value); break;
    case "notify_owner": add("Message to the owner", n.template); if (n.task) { add("Task title", n.task.title); } break;
    case "note": add("CRM note", n.template); break;
    case "create_task": add("Task title", n.title); add("Task body", n.body); break;
    case "send_document": add("Document template", n.template); add("Document name", n.name); break;
    case "analyze": add("AI prompt", n.prompt); add("AI input", n.input); break;
    case "classify": add("Question asked of the classifier", n.question); add("What it reads", n.input); add("What we sent (context)", n.state); for (const [k, v] of Object.entries(n.criteria ?? {})) add(`Option "${k}" means`, v); break;
    case "webhook": add(`${n.method} URL`, n.url); if (n.body !== undefined) add("Body", JSON.stringify(n.body, null, 2)); break;
    case "report": if (n.layout) add("Layout", JSON.stringify(n.layout, null, 2)); break;
    default: break;
  }
  return out;
}

/** Where a step's words go, when it sends or posts. */
function recipientOf(n: Node): string | null {
  switch (n.type) {
    case "send_sms": return `the contact's phone (${n.kind})`;
    case "send_email": return `the contact's email (${n.kind})`;
    case "send_document": return `the contact (from ${n.sender ?? "the default sender"})`;
    case "slack_post": {
      const fb = n.fallback_channel === undefined ? [] : Array.isArray(n.fallback_channel) ? n.fallback_channel : [n.fallback_channel];
      const bits = [`channel ${n.channel}`, fb.length ? `falls back to ${fb.join(", then ")}` : "", n.thread_of ? `in the thread of ${n.thread_of}` : "", n.thread_only ? "thread only" : "", n.edit ? "edits the earlier post" : "", n.as?.name ? `posted as "${n.as.name}"` : "", n.tag ? `remembered as ${n.tag}` : ""];
      return bits.filter(Boolean).join("; ");
    }
    case "notify_owner": return `the contact's owner by Slack DM${n.fallback_channel ? `, else ${n.fallback_channel}` : ""}${n.task ? "; plus a CRM task" : ""}`;
    case "webhook": return `${n.method} ${n.url}`;
    default: return null;
  }
}

function waitOf(n: Node): string | null {
  switch (n.type) {
    case "wait": return `${waitWords(n.rule)} (time zone: ${n.rule.tz}${n.rule.window ? `; a time after the send window moves back ${n.rule.window} it closes` : ""}${n.rule.guard ? `; if less than ${n.rule.guard.min_lead} away, ${n.rule.guard.fallback} instead` : ""})`;
    case "wait_for_reply": return `Wait for a reply on ${n.channel} for up to ${n.timeout}${n.until ? `, and no later than ${untilWords(n.until)}` : ""}; after the first reply, wait ${n.settle} for the rest`;
    case "wait_for_reaction": return `Wait for one of ${n.emojis.join(" ")} on ${n.of}${n.timeout ? ` for up to ${n.timeout}` : ""}${n.until ? `, until ${untilWords(n.until)}` : ""}${n.blocking ? "" : " (a listener: the run goes on and jumps when tapped)"}`;
    case "wait_for_event": return `Wait for "${n.event}" about the ${n.about}${n.match ? ` where ${predicateWords(n.match)}` : ""}${n.since ? `, counting one since ${n.since}` : ""}${n.until ? `, until ${untilWords(n.until)}` : ""}${n.respect_send_window ? "" : " (deadline ignores the send window)"}`;
    default: return null;
  }
}

function edgeLine(e: Edge, from: Node, num: Map<string, number>, consts: Record<string, unknown>): string {
  const words = edgeWords(e, from) || "always";
  const cond = e.when && !e.label ? "" : e.when ? ` (when ${predicateWords(e.when, consts)})` : "";
  return `- ${words}${cond} → step ${num.get(e.to) ?? "?"} (\`${e.to}\`)`;
}

export function renderWorkflow(offer: OfferInfo, w: WorkflowInfo, generatedAt: string): string {
  const def = w.definition;
  const order = walkOrder(def);
  const byId = new Map(def.nodes.map((n) => [n.id, n]));
  const num = new Map(order.map((id, i) => [id, i + 1]));
  const roles = failureRoles(def);
  const consts = constsOf(def);
  const out: string[] = [];
  const types = new Set(def.nodes.map((n) => n.type));

  out.push(`# ${w.name}`, "");
  out.push(`Offer: **${offer.name}** (\`${offer.slug}\`). Source: ${offer.source === "repo" ? "**from repo, may differ from live**" : "live database"}. Generated ${generatedAt}.`, "");
  out.push("| Setting | Value |", "| --- | --- |");
  out.push(`| Where this definition came from | ${cell(w.origin)} |`);
  out.push(`| Template | ${w.template ? `\`${w.template.slug}\`${w.template.version ? ` v${w.template.version}` : ""}` : "none (the offer's own workflow)"} |`);
  out.push(`| Edited since copied from the template | ${yes(w.diverged, "yes", "no")} |`);
  if (w.takesOver) out.push(`| Takes over | \`${w.takesOver}\` |`);
  out.push(`| Saved version | ${w.version ?? "unknown (repo)"} |`);
  out.push(`| Enabled | ${yes(w.enabled, "on", "off")} |`);
  out.push(`| Mode | ${w.mode ?? (offer.mode ? `follows the offer (${offer.mode})` : "unknown (repo)")} |`);
  out.push(`| Send lock | ${offer.source === "repo" ? "unknown (repo)" : w.sendsUnlockedAt ? `unlocked ${w.sendsUnlockedAt}${w.sendsUnlockedBy ? ` by ${w.sendsUnlockedBy}` : ""}` : "locked: texts, emails, documents and webhooks reach only the operator's own addresses"} |`);
  out.push(`| Runs again for the same person | ${def.reentry}${def.reentry_window ?? w.reentryWindow ? ` (window ${def.reentry_window ?? w.reentryWindow})` : ""}${def.reentry_key ? `; key ${def.reentry_key}` : ""} |`);
  out.push(`| Re-checked before every step | ${def.premise.check === "none" ? "nothing" : def.premise.check.replace(/_/g, " ")} |`);
  out.push(`| Send window | ${offer.sendWindow ? `${offer.sendWindow.start} to ${offer.sendWindow.end}, the contact's time zone${offer.sendWindow.transactionalAnyHour ? "; transactional messages may go at any hour" : ""}` : "the offer's (unknown in repo)"} |`);
  out.push(`| Steps | ${def.nodes.length} |`);
  if (w.note) out.push(`| Note | ${cell(w.note)} |`);
  out.push("");

  out.push("## Steps", "", "Every step, in the order a run meets it from the trigger. Steps that only assemble words (`set_var`) are listed too.", "");
  for (const id of order) {
    const n = byId.get(id)!;
    const d = describeNode(n);
    const role = roles.get(n.id);
    out.push(`### ${num.get(id)}. ${n.title ?? d.title}`, "");
    out.push(`- Step id \`${n.id}\`, type \`${n.type}\``);
    if (n.title && n.title !== d.title) out.push(`- Engine description: ${d.title}`);
    if (d.detail) out.push(`- Detail: ${d.detail}`);
    if (n.only_if) out.push(`- Runs only if: ${onlyIfWords(n.only_if, consts)} (otherwise skipped)`);
    const wait = waitOf(n); if (wait) out.push(`- Wait: ${wait}`);
    const to = recipientOf(n); if (to) out.push(`- Goes to: ${to}`);
    if (n.type === "send_sms" || n.type === "send_email") {
      if (n.validity) out.push(`- Timing check: ${n.validity.anchor.replace(/_/g, " ")}${n.validity.min_lead ? `, at least ${n.validity.min_lead} before` : ""}${n.validity.max_lag ? `, at most ${n.validity.max_lag} after` : ""}; when stale: ${n.on_stale}`);
    }
    if (role && n.type !== "trigger" && n.type !== "exit") out.push(`- If it keeps failing: ${role.blocking ? "the run is held on this step" : "after its tries it is skipped and the run goes on"} (${role.why}${n.blocking !== undefined ? "; set on the step" : ""})`);
    for (const m of messagesOf(n)) out.push("", `${m.label}:`, "", fence(m.text));
    const edges = def.edges.filter((e) => e.from === id);
    out.push("", edges.length ? "Next:" : "Next: the run ends here.");
    for (const e of edges) out.push(edgeLine(e, n, num, consts));
    out.push("", "<details><summary>Full step definition</summary>", "", fence(JSON.stringify(n, null, 2), "json"), "", "</details>", "");
  }

  const manifest = extractManifest(def).bindings;
  out.push("## Settings this workflow reads", "");
  if (!manifest.length) out.push("None.", "");
  else {
    out.push("| Key | Kind | Required to enable | Value |", "| --- | --- | --- | --- |");
    for (const b of manifest) {
      const v = w.bindings ? w.bindings[b.key] : undefined;
      const shown = !w.bindings ? "not read (repo)" : v === undefined ? (b.fallback ? `unbound: posts go to ${b.fallback}` : "**unbound**") : typeof v === "object" ? "set (secret, not shown)" : `\`${cell(v)}\``;
      out.push(`| \`${b.key}\` | ${b.kind} | ${b.required ? "yes" : "no"} | ${shown} |`);
    }
    out.push("");
  }

  out.push("## Engine rules that apply but are not steps", "", "These act on every run of this workflow from engine code. They are not in the definition above.", "");
  out.push(`- **Mode.** The workflow's own mode, else the offer's, decides what is real: ghost writes and sends nothing, test is real only for test contacts, quiet writes the CRM but reaches no contact, live is real. (${locate("mode.ts", "export const MODE_WORDS")}, ${locate("mode.ts", "export const runMode")})`);
  out.push(`- **Runs again?** A run's key is built from the re-entry policy; a second trigger with the same key starts nothing. A run that stops at a gate does not count. (${locate("reentry.ts", "export function reentryKey")})`);
  if (def.premise.check !== "none") out.push(`- **Premise re-check.** Before each step the engine reads the CRM live; when "${def.premise.check.replace(/_/g, " ")}" no longer holds, the run exits. (${locate("runner.ts", "async function premiseAlive")})`);
  out.push(`- **Failures.** Errors are sorted into transient, auth, permanent and unknown. A step is retried after 1 and 5 minutes; then a non-blocking step is skipped and a blocking one is held and looked at again after 15 minutes, then hourly. An auth or permanent failure pauses the run until it is fixed. (${locate("failures.ts", "export const RETRY_SCHEDULE")}, ${locate("failures.ts", "export const HOLD_RECHECK_MIN")}, ${locate("blocking.ts", "export function failureRoles")})`);
  out.push(`- **Step cap.** At most 50 steps run in one go; a run past that fails. After an outage, at most 20 sends per offer per tick. (${locate("runner.ts", "MAX_STEPS = 50")}, ${locate("runner.ts", "RECOVERY_SEND_CAP")})`);
  if ([...types].some((t) => SENDS.has(t))) {
    out.push(`- **Before any text or email goes out**, in this order: SMS switched on for the offer; timing still valid; the CRM's own template if named; the words rendered; the contact has the address; the mode holds it; already sent for this run and step (idempotency key run:step); already sent before a replay; Do Not Disturb; the send lock; then the CRM. A send the CRM did not clearly answer is never sent again. (${locate("executor.ts", "async function doSend")})`);
    out.push(`- **Send lock.** While locked, a text, email, document or webhook reaches a contact only when their live CRM phone or email is one of the operator's own. Changing any outbound step relocks the workflow. (${locate("send-lock.ts", "export async function checkSendLock")}, ${locate("send-lock.ts", "export async function relockIfOutboundChanged")})`);
    out.push(`- **Send window.** A text or email due outside the offer's send window waits until it opens, in the contact's time zone; a transactional one may go at any hour when the offer allows it. (${locate("runner.ts", "deferIntoWindow(now, tz")})`);
  }
  if ([...types].some((t) => CRM_WRITES.has(t))) out.push(`- **CRM writes** without a natural key (notes, tasks, cards, records) are claimed once per run and step so a retry never writes twice. In ghost mode they are skipped. (${locate("effects.ts", "export async function claimEffect")})`);
  if (types.has("slack_post") || types.has("notify_owner")) out.push(`- **Slack before live.** Until the workflow is live, every post goes to the offer's test channel with a ghost/test label, unless \`slack.live\` is set. (${locate("mode.ts", "export const TEST_CHANNEL_KEY")}, ${locate("mode.ts", "export const SLACK_LIVE_KEY")})`);
  if ([...types].some((t) => WAITS.has(t))) out.push(`- **Waits** are stored on the run (\`runs.next_run_at\`, \`wake_on_*\`), not held in memory; a reply, tap or event wakes the run at once. (${locate("runner.ts", "function listenerFired")})`);
  out.push("");
  return out.join("\n");
}

export type IndexRow = { w: WorkflowInfo; removed?: string };

export function renderIndex(offer: OfferInfo, rows: IndexRow[], generatedAt: string): string {
  const out: string[] = [];
  out.push(`# ${offer.name}: every workflow`, "");
  out.push(`Offer \`${offer.slug}\`. Source: ${offer.source === "repo" ? "**from repo, may differ from live**" : "live database"}. Generated ${generatedAt}.`, "");
  const facts = [
    offer.status ? `status ${offer.status}` : "", offer.mode ? `offer mode ${offer.mode}` : "", offer.timezone ? `time zone ${offer.timezone}` : "",
    offer.sendWindow ? `send window ${offer.sendWindow.start}–${offer.sendWindow.end}` : "", offer.smsEnabled === false ? "SMS off" : "", offer.playbook ? `playbook ${offer.playbook}` : "",
  ].filter(Boolean);
  if (facts.length) out.push(facts.join(" · "), "");
  out.push("| Workflow | Stage | On | Mode | Sends | Starts when | Steps | Contact-facing |", "| --- | --- | --- | --- | --- | --- | --- | --- |");
  const sorted = [...rows].sort((a, b) => (a.w.stage ?? "").localeCompare(b.w.stage ?? "") || a.w.name.localeCompare(b.w.name));
  for (const { w, removed } of sorted) {
    if (removed) { out.push(`| ${cell(w.name)} | ${w.stage ?? ""} | removed | | | ${cell(removed)} | | |`); continue; }
    const triggers = w.definition.nodes.filter((n) => n.type === "trigger").map((n) => describeNode(n).title).join("; ");
    const contact = w.definition.nodes.some((n) => SENDS.has(n.type)) ? "yes" : "no";
    const lock = offer.source === "repo" ? "?" : w.sendsUnlockedAt ? "unlocked" : "locked";
    out.push(`| [${cell(w.name)}](${w.slug}.md) | ${w.stage ?? ""} | ${yes(w.enabled, "on", "off", "?")} | ${w.mode ?? (offer.mode ? `(${offer.mode})` : "?")} | ${lock} | ${cell(triggers)} | ${w.definition.nodes.length} | ${contact} |`);
  }
  out.push("");
  return out.join("\n");
}

export const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "workflow";
