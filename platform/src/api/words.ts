import { DateTime } from "luxon";
import type { Definition, Node } from "@/engine/definition";
import { EVENT_LABELS, branchTitle, eventWords, untilWords, collapsePlumbing, constsOf, describeNode, durationWords, edgeWords, exitWords, humanWords, onlyIfWords, pathWords, predicateWords, skippedWords, waitWords, templateWords, walkOrder } from "@/engine/describe";
import { exampleContext, nodeExamples } from "@/engine/example";
import { UNREAD, UNREAD_MANY, namer, type Named, type Namer } from "./crm-names";
import { scheduleWords } from "@/engine/when";
import type { Projected } from "@/engine/project";
import { withImplicit } from "@/chart/implicit";
import { QUIET_COND, QUIET_ONLY_IF, quietWhenEmpty } from "@/engine/quiet";

/**
 * The words the dashboard shows for a workflow and for one run of it. The engine's own describe.ts says what a node does;
 * this file arranges that into the two shapes the pages use: the chart (nodes and edges with words) and the path (what one
 * run did, step by step, with the state of each step). The client lays the chart out; it never reads a definition itself.
 */
export type ChartKind = "trig" | "send" | "wait" | "reply" | "fork" | "check" | "tag" | "slack" | "crm" | "ai" | "end" | "other";
/** Who a Slack post appears as (D43: a Slack preview looks like Slack): the bot name and its emoji or image. */
export type SlackFace = { name: string; icon: string | null };
/** cond: the full condition, for the popover; onlyIf: a step with `only_if`, its condition short enough for the node ("a reschedule"); helper: a step that works behind the scenes (a wait, Jev reading, a value remembered), drawn small and grey (D111). */
/** label: the hand-written title an author gave the step, shown small beside the generated words (D112), never instead of them. */
/**
 * plumb (D114): a step that only keeps a value for the steps after it (set_var) or reads the engine's own ledger (lookup):
 * what it keeps, for a run of them drawn as one box; text: every value it can keep is words. group: such a box, drawn in
 * place of its steps (src/chart/group.ts), never sent by the API.
 */
export type Plumb = { verb: "remember" | "look up"; what: string; text?: boolean };
export type ChartNode = { id: string; kind: ChartKind; title: string; meta?: string; label?: string; detail?: string; quote?: string; cond?: string; onlyIf?: string; channel?: "sms" | "email" | "slack"; face?: SlackFace; thread?: boolean; react?: string | string[]; offer?: string[]; helper?: boolean; logo?: string; plumb?: Plumb; group?: string[] };
export type ChartEdge = { from: string; to: string; label: string; else?: boolean };
/** counts (D112): per step, the runs that reached it in the last `days` days (ghost runs too) and how many of those skipped it; on the workflow page's chart only. */
export type Chart = { nodes: ChartNode[]; edges: ChartEdge[]; counts?: { days: number; by: Record<string, { went: number; skipped: number }> } };

/** skip: the step's condition said no, or there was nothing to do; blocked: it meant to act but could not (not connected, refused). */
export type StepState = "ok" | "ghost" | "skip" | "blocked" | "warn" | "here" | "next" | "stop";
export type PathItem = { node_id: string; title: string; meta?: string; kind: ChartKind; state: StepState; at: string | null; note?: string; onlyIf?: string; channel?: "sms" | "email" | "slack"; face?: SlackFace; thread?: boolean; react?: string | string[]; offer?: string[]; words?: string | null; send_state?: string };

export function kindOf(n: Node): ChartKind {
  switch (n.type) {
    case "trigger": return "trig";
    case "send_sms": case "send_email": case "notify_owner": case "send_document": return "send";
    case "wait": return "wait";
    case "wait_for_reply": case "wait_for_reaction": case "wait_for_event": return "reply";
    case "branch": return "fork";
    case "check": return "check";
    case "tags": case "set_tag": case "remove_tag": return "tag";
    case "slack_post": return "slack";
    case "classify": case "analyze": return "ai";
    case "exit": return "end";
    case "update_contact": case "update_appointment": case "update_opportunity": case "pipeline_card": case "crm_record": case "create_task": case "record_outcome": case "note": case "ensure_contact": return "crm";
    case "record": return "other";
    default: return "other";
  }
}

/** The classify step whose answer a gate reads, when there is one: the predicate names the path the step wrote into. */
function jevBehind(def: Definition, n: Extract<Node, { type: "check" }>): { question: string; threshold: number } | null {
  const refs = [...JSON.stringify(n.when).matchAll(/\{\{\s*([a-zA-Z0-9_.]+)/g)].map((m) => m[1]);
  for (const c of def.nodes) if (c.type === "classify" && refs.includes(c.into)) return { question: c.question ?? "what does this mean", threshold: c.threshold };
  return null;
}
const faceOf = (n: Node, bindings: Record<string, string> = {}): SlackFace | undefined => {
  if (n.type !== "slack_post" && n.type !== "notify_owner") return undefined;
  const as = n.as; const icons = as?.icon ? (Array.isArray(as.icon) ? as.icon : [as.icon]) : [];
  return { name: (as?.name ?? bindings["slack.name"] ?? "Engine").replace(/\{\{[^}]*\}\}/g, "").trim() || "Engine", icon: icons[0]?.trim() || null };
};
const threadOf = (n: Node): { thread?: boolean; react?: string | string[]; offer?: string[] } => n.type === "slack_post" ? { thread: !!n.thread_of || undefined, react: n.react, offer: n.offer } : {};
const channelOf = (n: Node): ChartNode["channel"] => n.type === "send_sms" ? "sms" : n.type === "send_email" ? "email" : n.type === "slack_post" || n.type === "notify_owner" ? "slack" : undefined;

/** A task title the way the team reads it: the contact's name placeholder becomes "them", any other binding its plain words. */
const taskWords = (t: string) => t.replace(/\{\{\s*contact\.(?:first_)?name(?:\s*\|[^}]*)?\s*\}\}/g, "them").replace(/\{\{\s*([a-zA-Z0-9_.]+)(?:\s*\|[^}]*)?\s*\}\}/g, (_, p) => pathWords(p)).replace(/\s+/g, " ").trim();
const cap = (t: string) => t.replace(/^./, (c) => c.toUpperCase());
const OUTCOME_WORDS: Record<string, string> = { noshow: "no-show", unqualified: "disqualified", dq: "disqualified", on_call: "rescheduled or cancelled on the call" };
const valueWords = (v: string) => OUTCOME_WORDS[v] ?? humanWords(v);
/** A few names, the rest counted: "New Lead, Scheduled and 5 more". */
/** The marker on words that stand in for a CRM name not read (D112): never shown as if they were the CRM's. */
const mark = (xs: (Named | null | undefined)[]) => { const un = xs.filter((x): x is Named => !!x && !x.read); return un.length ? ` (${un.length > 1 ? UNREAD_MANY : UNREAD})` : ""; };
const KEY_WORDS = namer({});
const one = (t: string) => /^\{\{[^}]*\}\}$/.test(t.trim());
/** The plain values a workflow's set_var steps can give a path (`vars.card.name` → "New call booked", "Call rescheduled"); null when one is not a plain literal. */
function varValues(def: Definition, path: string): string[] | null {
  const [, key, ...rest] = path.split(".");
  const sets = def.nodes.filter((n): n is Extract<Node, { type: "set_var" }> => n.type === "set_var" && n.key === key);
  if (!sets.length) return null;
  const vals = sets.flatMap((n) => [...(n.pick ? Object.values(n.pick) : [n.value]), ...(n.else_value !== undefined ? [n.else_value] : [])])
    .map((v) => rest.reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), v));
  const out = [...new Set(vals)];
  return out.every((v) => typeof v === "string" && v.trim() !== "" && !v.includes("{{")) ? (out as string[]) : null;
}
/** Text through templateWords, a `{{vars.x}}` that only ever holds two or three plain values written as them ("[full name] -- Direct/Setter"). */
const filled = (def: Definition, t: string) => templateWords(t.replace(/\{\{\s*(vars\.[a-zA-Z0-9_.]+)(?:\s*\|[^}]*)?\s*\}\}/g, (m, p: string) => { const v = varValues(def, p); return v && v.length <= 3 ? v.join("/") : m; }));
/** One value as a short thing: a picklist option or literal by its words, a single binding by its name, a var by its plain values. */
const valueOf = (def: Definition, v: string) => /^\{\{\s*picklist\./.test(v) ? pathWords(v) : !v.includes("{{") ? valueWords(v) : one(v) ? (/^\{\{\s*vars\./.test(v) && filled(def, v).replace(/^\[.*\]$/, "")) || pathWords(v) : filled(def, v);
/** What a Slack post is, in a few words: the name it posts as when that is plain, else the bold words it opens with, else its first words. */
function postWhat(def: Definition, n: Extract<Node, { type: "slack_post" | "notify_owner" }>): string {
  // bindings to words first (a link's url and text both hold `|`), then a Slack link to its text
  const first = n.template.split("\n")[0].replace(/\{\{[^}]*\}\}/g, (m) => templateWords(m)).replace(/<[^<>]*\|([^|<>]*)>/g, "$1").replace(/[*_~]/g, "").replace(/^\[[^\]]*\]\s+(?=[A-Z])/, "").replace(/\s+/g, " ").trim();
  // the first clause when the line runs on ("Linked to the booking, per [who tapped]")
  const clause = /^(.{12,}?)[;.—](\s|$)/.exec(first)?.[1].trim() ?? first;
  const lead = clause.length > 48 ? `${clause.slice(0, 46).replace(/\s+\S*$/, "")}…` : clause;
  const as = n.as?.name;
  // a reply under a post that has the same face says what it adds, not the face again
  const sameFace = n.type === "slack_post" && n.thread_of && def.nodes.some((x) => x.id !== n.id && x.type === "slack_post" && !x.thread_of && x.as?.name === as);
  if (sameFace && lead && !lead.startsWith("[")) return lead;
  if (as && !as.includes("{{")) return as;
  if (as && one(as)) { const v = /^\{\{\s*(vars\.[a-zA-Z0-9_.]+)/.exec(as); const vs = v ? varValues(def, v[1]) : null; if (vs) return vs.join(" or "); const d = /\|\s*default:([^|}]+)/.exec(as); if (d) return d[1].trim(); }
  const bold = /^\s*\*([^*{]+?):?\*/.exec(n.template); if (bold) return bold[1].trim();
  return lead;
}
/** Where a Slack post goes: under which post, or which channel or person. */
function postWhere(def: Definition, n: Extract<Node, { type: "slack_post" }>): string {
  const under: Record<string, string> = { appointment: "the booking post", recording: "the call review", alert: "the alert", "eod-reminder": "the reminder", decision: "the question", "closing-which": "the question", "setter-result": "the question" };
  if (n.thread_of) { const tag = /^tag:([a-z-]+):/.exec(n.thread_of)?.[1]; const parent = def.nodes.find((x) => x.id === n.thread_of); return `in the thread of ${(tag && under[tag]) ?? (parent?.type === "slack_post" ? `the ${postWhat(def, parent)} post` : "its post")}`; }
  const ch = /^\{\{\s*([a-zA-Z0-9_.]+)/.exec(n.channel)?.[1];
  if (ch === "user.slack_user_id") return "DM to the closer";
  if (ch === "company.operator_slack_id") return "DM to the operator";
  if (ch === "event.channel") return "to the alert's channel";
  return `to ${ch ? pathWords(ch) : `#${n.channel}`}`;
}
/** A card or record's facts: "outcome = rescheduled", "sets outcome, disposition", "+11 more fields". */
function recordFacts(def: Definition, props: Record<string, string>): string[] {
  const PRIORITY = ["outcome", "call_result", "disposition", "amount", "cash_collected", "status", "type"];
  const rank = (k: string) => { const i = PRIORITY.indexOf(k); return i < 0 ? 99 : i; };
  const entries = Object.entries(props).filter(([k]) => k !== "display_label" && k !== "external_id");
  const notable = entries.filter(([k, v]) => rank(k) < 99 || !v.includes("{{") || /^\{\{\s*picklist\./.test(v)).sort((a, b) => rank(a[0]) - rank(b[0]));
  const shown = (notable.length ? notable : entries).slice(0, 2);
  const set: string[] = [], bare: string[] = [];
  for (const [k, v] of shown) { const kw = humanWords(k.replace(/_id$/, "")), vw = valueOf(def, v); if (/_id$/.test(k) || vw.replace(/^the /, "") === kw) bare.push(kw); else set.push(`${kw} = ${vw}`); }
  const more = entries.length - shown.length;
  return [[...set, bare.length ? `sets ${bare.join(" and ")}` : ""].filter(Boolean).join(", "), more ? `+${more} more field${more === 1 ? "" : "s"}` : ""].filter(Boolean);
}
const LOOKUPS: Record<string, string> = { appointments_for_contact: "their bookings", calls_for_contact: "their recorded calls", call_conversation: "the whole conversation" };
function lookupWords(def: Definition, n: Extract<Node, { type: "lookup" }>): { title: string; meta?: string } {
  if (n.query === "last_event") return { title: describeNode(n).title };
  const p = n.params; const again = def.nodes.findIndex((x) => x.type === "lookup" && x.query === n.query) < def.nodes.indexOf(n) ? " again" : "";
  if (n.query === "call_conversation") return { title: `Look up the whole conversation${again}`, meta: again ? "a later part may have come in" : "a call in parts is read as one" };
  const window = (() => { const a = /\s-(\d+[mhd])$/.exec(p.starts_since ?? ""), b = /\s\+(\d+[mhd])$/.exec(p.starts_until ?? ""); return a && b && a[1] === b[1] ? `starting within ${durationWords(a[1])} either side of ${thing(pathWords((p.starts_since ?? "").replace(/\s-\d+[mhd]$/, ""))).replace(/ (started|ended)$/, "")}` : ""; })();
  const what = p.kind ? `their ${humanWords(p.kind)} calls` : LOOKUPS[n.query];
  return { title: `Look up ${what}${again}`, meta: [p.status_not ? `not ${humanWords(p.status_not)}` : "", p.closer ? `with ${pathWords(p.closer)}` : "", window].filter(Boolean).join(", ") || undefined };
}
const thing = (w: string) => /^(the|a|an|their|this|who|what|when|why|how|which|whether|today) /i.test(`${w} `) || /^Jev\b/.test(w) ? w : `the ${w}`;
const withThe = thing;
/** What each health check looks at, short, for the step's line (the full words are `CHECKS` in health.ts; a test keeps the two in step). */
export const HEALTH_CHECKS: Record<string, string> = { ghl_token: "the GHL token", ghl_calendars: "GHL calendars bookable", availability: "enough free slots", ghl_pipelines: "pipelines and stages", ghl_fields: "custom fields", ghl_users: "the team in GHL", duplicates: "duplicate contacts", ledger_drift: "the engine's records match GHL", meeting_links: "upcoming calls have a meeting link", calendly_token: "the Calendly token", calendly_calendars: "Calendly event types bookable", whop_key: "the Whop key", whop_webhook: "the Whop webhook", fathom_key: "the Fathom key", fathom_webhook: "the Fathom webhook", typeform_webhook: "the Typeform webhook", their_workflows: "their GHL workflows", slack: "Slack", anthropic: "the AI key", jev: "Jev", steps: "every step can fire", charts: "every chart draws its workflow exactly", urls: "links in messages" };
/** Slack text as words: bindings by name, a link by its text, no *bold* or _italic_ markers, one line. */
// templateWords drops <…> as html: Slack's links are kept apart from that and read by their text after the bindings are words
const slackPlain = (t: string) => templateWords(t.replace(/\s*\n\s*/g, " / ").replace(/</g, "\u0001").replace(/>/g, "\u0002")).replace(/\u0001[^\u0001\u0002]*\|([^|\u0001\u0002]*)\u0002/g, "$1").replace(/\u0001([^\u0001\u0002]*)\u0002/g, "$1").replace(/[\u0001\u0002]/g, "")
  .replace(/(^|[\s(\[])[*_~]+([^*_~\n]+?)[*_~]+(?=[\s.,:;)!?\]]|$)/gm, "$1$2").replace(/[*_~]{2,}/g, "").replace(/\s*\n\s*/g, " / ").replace(/\s+/g, " ").trim();
/** A value a set_var keeps, short: ‘the words’ (a long one cut), a binding by name, an emoji as itself, a structure by its parts. */
function kept(v: unknown): string {
  if (v === undefined || v === null || v === "") return "nothing";
  if (typeof v === "boolean") return v ? "yes" : "no";
  if (typeof v === "number") return String(v);
  if (Array.isArray(v)) return v.map(kept).join(" ");
  if (typeof v === "object") { const o = v as Record<string, unknown>; return "name" in o ? [kept(o.name), o.icons !== undefined ? kept(o.icons) : ""].filter(Boolean).join(" ") : Object.entries(o).map(([k, x]) => `${humanWords(k)} ${kept(x)}`).join(", "); }
  const t = String(v);
  if (/^:[a-z0-9_+-]+:$/.test(t.trim())) return t.trim();
  if (/^\+?\d+[mhdw]$/.test(t.trim())) return durationWords(t.trim());
  if (/^[a-z0-9]+(_[a-z0-9]+)+$/.test(t)) return `‘${valueWords(t)}’`;
  if (one(t)) return /^\{\{\s*picklist\./.test(t) ? `‘${pathWords(t)}’` : withThe(pathWords(t));
  const w = slackPlain(t); if (!w) return "nothing";
  return `‘${w.length > 60 ? `${w.slice(0, 58).replace(/\s+\S*$/, "")}…` : w}’`;
}
/** What a pick looks at: "the reply", "the earlier answer and the earlier call outcome". */
const ALERT_PATHS: Record<string, string> = { "event.kind": "the kind of alert", "event.level": "how bad it is", "event.detail.shape": "the shape of the drift found", "event.detail.fixed": "how many records were fixed" };
const pickedBy = (t: string, def?: Definition) => {
  // an alert's event fields are not a payment's: Health check's own words for them
  const alerts = !!def?.nodes.some((n) => n.type === "trigger" && n.event.startsWith("alert."));
  const ps = [...t.matchAll(/\{\{\s*([a-zA-Z0-9_.]+)[^}]*\}\}/g)].map((m) => (alerts && ALERT_PATHS[m[1]]) || withThe(pathWords(m[1]))); return ps.length ? ps.join(" and ") : slackPlain(t);
};
/** A pick's case as words: "showed:closed_won" → "showed, closed won"; empty → "nothing". */
const caseWords = (k: string) => k === "" ? "nothing" : k.split(/[:>]/).map((x) => (x === "" ? "nothing" : valueWords(x))).join(", ");
/** A trigger with a match reads as the event it really waits for: "Appointment cancelled", "Tag “reactivate” added". */
function triggerTitle(n: Node & { type: "trigger" }, nm: Namer = KEY_WORDS): string {
  const m = n.match as Record<string, unknown> | undefined;
  const eq = (path: string): string | undefined => { const find = (p: Record<string, unknown> | undefined): string | undefined => { if (!p) return undefined; if (Array.isArray(p.eq) && p.eq[0] === `{{${path}}}`) return String(p.eq[1]); if (Array.isArray(p.and)) for (const q of p.and as Record<string, unknown>[]) { const r = find(q); if (r) return r; } return undefined; }; return find(m); };
  const status = eq("event.status.to"), outcome = eq("event.outcome"), tag = eq("event.tag");
  if (n.event === "appointment.status_changed" && status) return `Appointment ${status.replace(/noshow/, "no-show")}`;
  if (n.event === "appointment.outcome" && outcome) return `Call marked ${outcome.replace(/noshow/, "no-show").replace(/_/g, " ")}`;
  if (n.event === "call.held" && outcome) return `Call held: ${outcome.replace(/_/g, " ")}`;
  if (n.event === "tag.added" && tag) return `Tag “${tag}” added`;
  if (n.event === "payment.received" && eq("event.prior_total") === "0") return "First payment received";
  // the engine says an open alert again every `alerts.repeat_minutes` (60 unless the company set it, alerts.ts)
  if (n.event === "alert.repeated") { const m = Number(nm.setting("alerts.repeat_minutes")) || 60; return `An alert is still open (said again every ${m % 60 === 0 ? (m === 60 ? "hour" : `${m / 60} hours`) : `${m} minutes`} until it is fixed)`; }
  return describeNode(n).title.replace(/ — .*$/, "");
}
/**
 * A node's words on the chart and in a step row (D112): always made from what the step is set to do, never from its
 * hand-written `title`, which goes along as `label` (shown small) so an edited setting can never hide behind old words.
 */
export function shortTitle(def: Definition, n: Node, nm: Namer = KEY_WORDS): { title: string; meta?: string; label?: string } {
  const g = generic(def, n, nm);
  // a task's `title` is the task itself (the words GHL shows), already in the words
  const label = n.title && n.type !== "create_task" && n.title.trim().toLowerCase() !== g.title.toLowerCase() ? n.title.trim() : undefined;
  return label ? { ...g, label } : g;
}
function generic(def: Definition, n: Node, nm: Namer): { title: string; meta?: string } {
  const list = (...xs: (string | false | 0 | undefined)[]) => xs.filter(Boolean).join(" · ") || undefined;
  switch (n.type) {
    case "trigger": { if (n.schedule) { const w = scheduleWords(n.schedule); const i = w.indexOf(", "); return { title: cap(i > 0 ? w.slice(0, i) : w), meta: i > 0 ? w.slice(i + 2) : undefined }; } return { title: triggerTitle(n, nm) }; }
    case "send_sms": return { title: "Text" };
    case "send_email": return { title: `Email: ${templateWords(n.subject)}` };
    case "send_document": return { title: describeNode(n).title };
    // a wait is drawn as its own step (D111): it says it waits, "Wait until 3 days before the call", "Wait 2 days"
    case "wait": { const w = waitWords(n.rule).replace(/\s*\(.*\)$/, "").replace(/\b(\d+) hours?\b/, (_, h) => (+h >= 48 && +h % 24 === 0 ? `${+h / 24} days` : `${h} hour${+h === 1 ? "" : "s"}`)); return { title: w }; }
    case "wait_for_reply": return { title: "Wait for a reply", meta: `up to ${durationWords(n.timeout)}` };
    case "wait_for_reaction": return { title: n.blocking ? "Wait for a tap in Slack" : "Listen for a tap in Slack", meta: `${n.emojis.map((e) => `:${e}:`).join(" ")}${n.timeout ? ` · up to ${durationWords(n.timeout)}` : ""}${!n.blocking ? " · the run goes on" : ""}` };
    case "lookup": return lookupWords(def, n);
    case "wait_for_event": return { title: `Wait for ${eventWords(n.event)}`, meta: n.until ? untilWords(n.until) : undefined };
    case "resume": return { title: "Go back to where the run was" };
    case "branch": { const outs = def.edges.filter((e) => e.from === n.id); const whens = outs.filter((e) => e.when); const reply = whens.length && whens.every((e) => JSON.stringify(e.when).includes("reply.")); return { title: reply ? "What did they say?" : whens.length === 1 ? `${cap(edgeWords(whens[0]))}?` : branchTitle(def, n.id) }; }
    case "check": return { title: `Check ${predicateWords(n.when, constsOf(def))}`, meta: n.retry ? `waits up to ${durationWords(n.retry.for)}` : undefined };
    case "slack_post": return { title: `Slack: ${postWhat(def, n)}`, meta: list(postWhere(def, n), n.react && `reacts ${(Array.isArray(n.react) ? n.react : [n.react]).map((e) => (/\{\{/.test(e) ? (varValues(def, /vars\.[a-zA-Z0-9_.]+/.exec(e)?.[0] ?? "") ?? [pathWords(e)]).map((x) => `:${x}:`).join(" or ") : `:${e}:`)).join(" ")}`, n.offer && `offers ${n.offer.map((e) => `:${e}:`).join(" ")} to tap`, n.buttons?.length && `with ${n.buttons.map((b) => b.text).join(" / ")}`) };
    case "notify_owner": return { title: `Slack DM to their owner: ${postWhat(def, n)}`, meta: n.task ? "and a CRM task" : undefined };
    case "classify": {
      if (n.domain === "reply_intent") return { title: "Jev reads the reply" };
      // the answers it picks from say what it decides; the question when they are many and it is short
      const keys = Object.keys(n.criteria ?? {}).filter((k) => k !== "other" && k !== "unclear").map((k) => humanWords(k).replace(/\bdq\b/g, "DQ"));
      const q = (n.question ?? humanWords(n.domain)).replace(/\?$/, "").replace(/^./, (c) => c.toLowerCase());
      return { title: `Jev: ${keys.length && keys.length <= 4 ? `${keys.slice(0, -1).join(", ")}${keys.length > 1 ? " or " : ""}${keys.at(-1)}` : q.length <= 40 || !keys.length ? q : `${keys.slice(0, 3).join(", ")} or ${keys.length - 3} more`}?` };
    }
    case "analyze": { const w: Record<string, string> = { classify: "is it a sales call?", notes: "call notes", rubric: "scorecard", objections: "objections", cheer: "a line of congratulations" }; const keys = Array.isArray(n.into) ? n.into : [n.into]; return { title: `AI: ${keys.map((k) => w[k] ?? humanWords(k)).join(" and ")}` }; }
    case "update_contact": {
      const fields = n.fields.map((f) => nm.field(f.id)), cleared = n.clear.map((id) => nm.field(id));
      const bits = [n.set.assign_to && `owner: ${pathWords(n.set.assign_to)}`, n.set.phone && "phone", n.set.timezone && "time zone", (n.set.first_name || n.set.last_name) && "name",
        ...fields.map((f) => f.text), ...cleared.map((f) => `clears ${f.text}`)].filter(Boolean) as string[];
      return { title: "Update the contact", meta: bits.length ? `${bits.join(", ")}${n.fields.length && n.fields.every((f) => f.if_empty) ? ", only where empty" : ""}${mark([...fields, ...cleared])}` : undefined };
    }
    case "pipeline_card": {
      const board = nm.board(n.pipeline), stage = n.stage ? nm.stage(n.stage) : null, from = (n.from_stages ?? []).map((x) => nm.stage(x));
      const title = stage ? `Move the card ‹${board.text} → ${stage.text}›` : n.status ? `Mark the card ${n.status} ‹${board.text}›` : `Update the card ‹${board.text}›`;
      const unread = [board, stage].filter((x): x is Named => !!x && !x.read);
      // every stage it moves from, never "and 5 more": which cards it leaves alone is what the step does
      return { title, meta: list(unread.length > 0 && `${unread.map((x) => x.text).join(", ")}:${mark(unread).replace(/[()]/g, "")}`, n.stage && n.status && (n.status === "open" ? "kept open" : `marked ${n.status}`), from.length > 0 && `only from ${from.map((x) => x.text).join(", ")}${mark(from)}`, n.if_missing === "skip" && "only if there is a card",
        n.keep_name ? "keeps its name" : n.name && n.if_missing !== "skip" && `named ${filled(def, n.name)}`, n.assign_to && `owner: ${pathWords(n.assign_to)}`, n.value && `value: ${filled(def, n.value)}`) };
    }
    case "crm_record": {
      const obj = nm.object(n.object);
      const key = n.key && !n.record_id && /^\{\{\s*event\.slot\./.test(n.key) ? ` for ${withThe(pathWords(n.key))}` : "";
      return { title: `${n.record_id || n.if_missing !== "create" ? "Update" : "Write"} the ${obj.text} record${key}${mark([obj])}`, meta: list(...recordFacts(def, n.properties), n.clear.length > 0 && `empties ${n.clear.length} field${n.clear.length === 1 ? "" : "s"}`) };
    }
    case "ensure_contact": { const tags = [...(n.tags === undefined ? [] : Array.isArray(n.tags) ? n.tags : [n.tags]), ...(n.scope_tag ? ["the company's scope tag"] : [])]; return { title: "Make sure the person is in GHL", meta: tags.length ? `tagged ${tags.join(", ")}` : undefined }; }
    case "create_task": { const t = taskWords(n.title); const who = n.assign_to ? pathWords(n.assign_to) : null; return { title: `Task${who ? ` for ${who}` : ""}: ${t[0].toLowerCase()}${t.slice(1)}`, meta: /\{\{/.test(n.due) ? `due ${templateWords(n.due).replace(/^\[|\]$/g, "")}` : `due in ${durationWords(n.due)}` }; }
    case "note": return { title: "Leave a note" };
    case "record_outcome": return { title: `Record the call as ${valueWords(n.outcome)}${n.call_outcome ? `, ${valueWords(n.call_outcome)}` : ""}`, meta: n.source === "disposition" ? "as if the closer filed it" : undefined };
    case "update_appointment": return "closer" in n.set || ("pending_read" in n.set && Object.keys(n.set).length === 1) ? { title: describeNode(n).title } : { title: `Mark the call ${Object.values(n.set).map((v) => valueWords(String(v))).join(", ")}` };
    case "update_opportunity": {
      const st = n.status ?? (typeof n.set.status === "string" ? n.set.status : undefined);
      const title = st === "open" ? "Reopen the opportunity" : st ? `Mark the opportunity ${/\{\{/.test(st) ? templateWords(st) : st}` : "Update the opportunity";
      return { title, meta: list(n.from?.length && `only if it is ${n.from.join(" or ")}`, n.card && `the ${nm.board(n.card.pipeline).text} card too${mark([nm.board(n.card.pipeline)])}`) };
    }
    case "set_var": {
      // what is kept, and each case in words: never the JSON, Slack's *bold* or a {{path}} the step holds (D112)
      const what = `Remember ${withThe(pathWords(`vars.${n.key}`))}`;
      // picked by a tap in Slack: the cases are the emoji tapped
      const tap = /\{\{\s*reaction\.reaction\b/.test(String(n.value));
      if (n.pick) return { title: what, meta: [`by ${pickedBy(String(n.value), def)}`, ...Object.entries(n.pick).map(([k, v]) => `${tap ? `:${k}:` : caseWords(k)} → ${kept(v)}`), n.else_value !== undefined && `otherwise ${kept(n.else_value)}`].filter(Boolean).join("; ") };
      if (n.when) return { title: what, meta: `${kept(n.value)} if ${predicateWords(n.when, constsOf(def))}${n.else_value !== undefined ? `, otherwise ${kept(n.else_value)}` : ""}` };
      return { title: `${what}: ${kept(n.value)}` };
    }
    case "record": return { title: `Log: ${EVENT_LABELS[n.event] ?? humanWords(n.event)}`, meta: list(n.appointment && `about ${withThe(pathWords(n.appointment))}`, n.start && "starts its workflows") };
    // the reason an author gave it, as the end of the run: "Done: they replied" (a stop is a way the run ends too)
    case "exit": return { title: exitWords(n.reason).replace(/^Stop: /, "Done: ") };
    case "report": return { title: describeNode(n).title };
    case "leaderboard": return { title: "Build the leaderboard", meta: `for ${/^\{\{/.test(n.period) ? pathWords(n.period) : n.period}` };
    case "availability_check": return { title: "Check bookable slots", meta: `alert under ${n.min_slots} in ${n.days} day${n.days === 1 ? "" : "s"}` };
    case "health_check": { const on = Object.keys(HEALTH_CHECKS).filter((k) => n.checks[k] !== false); return { title: "Run the health checks", meta: `${on.map((k) => HEALTH_CHECKS[k]).join(", ")} (each where the company uses it)` }; }
    default: return { title: describeNode(n).title };
  }
}

/** Which thing a step touches, for the logo on its node: the CRM, Slack, the booking tool, the recorder, the payment processor, the AI, the clock. */
export function logoOf(n: Node, bookingSource: "ghl" | "calendly" = "ghl"): string {
  switch (n.type) {
    case "trigger": { if (n.schedule) return "clock"; const e = n.event; if (e.startsWith("appointment.") || e === "call.held") return bookingSource; if (e.startsWith("recording.") || e.startsWith("call.")) return "fathom"; if (e.startsWith("payment.") || e.startsWith("opportunity.")) return "whop"; if (e === "eod.filed" || e === "form.submitted") return "form"; if (e.startsWith("agreement.")) return "doc"; return "ghl"; }
    case "send_sms": return "sms";
    case "send_email": return "email";
    case "slack_post": case "notify_owner": return "slack";
    case "classify": return "jev";
    case "analyze": return "ai";
    case "wait": return "clock";
    case "wait_for_reply": return "reply";
    case "wait_for_reaction": return "slack";
    case "wait_for_event": return logoOf({ id: n.id, type: "trigger", event: n.event }, bookingSource);
    case "branch": return "fork";
    case "check": return "if";
    case "exit": return "end";
    case "webhook": return "webhook";
    case "send_document": return "doc";
    case "health_check": case "availability_check": case "report": case "leaderboard": case "record": case "lookup": case "set_var": return "engine";
    case "update_appointment": return bookingSource;
    default: return "ghl";
  }
}

/** The popover's words for a step that points at CRM things, with every one of them by the CRM's name and listed in full. */
function namedDetail(def: Definition, n: Node, nm: Namer): string | undefined {
  if (n.type === "pipeline_card") {
    const board = nm.board(n.pipeline), stage = n.stage ? nm.stage(n.stage) : null, from = (n.from_stages ?? []).map((x) => nm.stage(x)), fields = n.fields.map((f) => ({ f: nm.field(f.id), v: templateWords(f.value) }));
    return [stage ? `On the ${board.text} board${mark([board])}, to ${stage.text}${mark([stage])}` : `On the ${board.text} board${mark([board])}; the card stays on its stage`, n.status && `marked ${n.status}`, n.assign_to && `owner → ${pathWords(n.assign_to)}`,
      fields.length > 0 && `sets ${fields.map((x) => `${x.f.text} = ${x.v}`).join(", ")}${mark(fields.map((x) => x.f))}`, from.length > 0 && `only a card on ${from.map((x) => x.text).join(", ")}${mark(from)} moves; a card on any other stage is left where it is`,
      n.keep_name ? `an existing card keeps its name${n.name ? `; a new one is named ${filled(def, n.name)}` : ""}` : n.name && `named ${filled(def, n.name)}`, n.if_missing === "skip" && "only if the card already exists; this step never makes one"].filter(Boolean).join("; ");
  }
  if (n.type === "update_contact") {
    const fields = n.fields.map((f) => ({ f: nm.field(f.id), v: templateWords(f.value), e: f.if_empty })), cleared = n.clear.map((id) => nm.field(id));
    const bits = [n.set.assign_to && `owner → ${pathWords(n.set.assign_to)}`, n.set.phone && "phone", n.set.timezone && "time zone", (n.set.first_name || n.set.last_name) && "name", ...fields.map((x) => `${x.f.text} = ${x.v}${x.e ? " (only if empty)" : ""}`), ...cleared.map((f) => `clear ${f.text}`)].filter(Boolean);
    return bits.length ? `${bits.join("; ")}${mark([...fields.map((x) => x.f), ...cleared])}` : undefined;
  }
  if (n.type === "crm_record") {
    const props = Object.entries(n.properties).map(([k, v]) => `${humanWords(k)} = ${valueOf(def, v)}`);
    return [n.record_id ? "The CRM's own record, made outside the engine; never makes one" : `Found by ${pathWords(n.key ?? "")}${n.if_missing === "create" ? "; made when there is none" : "; only a record that exists"}`, `writes ${props.join("; ")}`, n.clear.length > 0 && `empties ${n.clear.map((k) => humanWords(k)).join(", ")}`, n.relate.length > 0 && `linked to ${n.relate.length} related record${n.relate.length > 1 ? "s" : ""}`].filter(Boolean).join(". ");
  }
  return undefined;
}

/** The chart for a workflow: every node with its words, every edge with its label. Every step is on it (D111), the helpers small. names: the company's CRM names (D112); without them, a template's key words. */
export function chartOf(full: Definition, company: { name: string; timezone: string }, bindings: Record<string, string> = {}, bookingSource: "ghl" | "calendly" = "ghl", names: Namer = KEY_WORDS): Chart {
  const def = full;
  const ctx = exampleContext(company, bindings);
  const nodes: ChartNode[] = def.nodes.map((n) => {
    const d = describeNode(n); const s = shortTitle(full, n, names); const named = namedDetail(full, n, names); if (named) d.detail = named;
    // a gate that decides on what Jev said: the Jev mark, and the words say so (what was asked, how sure it had to be)
    const jevRef = n.type === "check" ? jevBehind(full, n) : null;
    if (jevRef) d.detail = `Jev answered “${jevRef.question}” and had to be at least ${Math.round(jevRef.threshold * 100)}% sure; a reading a careful person would doubt counts as unclear. ${d.detail ?? ""}`.trim();
    let quote: string | undefined;
    try { const ex = nodeExamples(n, ctx, company.timezone)[0]?.example.text; quote = n.type === "slack_post" || n.type === "notify_owner" ? ex?.trim() : n.type === "send_sms" || n.type === "send_email" || n.type === "note" ? strip(ex) : undefined; } catch { quote = d.quote; }
    // D124: a post quiet when empty is a sometimes-step only for a company with the setting on; for any other it always runs, and is drawn so
    const quiet = n.type === "slack_post" && !!n.quiet_when_empty && quietWhenEmpty(bindings);
    const onlyIf = [n.only_if ? onlyIfWords(n.only_if, constsOf(full)) : null, quiet ? QUIET_ONLY_IF : null].filter(Boolean).join(" and ") || undefined;
    const cond = quiet ? (n.only_if ? `Only if ${predicateWords(n.only_if)} and ${QUIET_COND.replace(/^Only if /, "")}` : QUIET_COND) : n.only_if ? `Only if ${predicateWords(n.only_if)}${n.type === "slack_post" && n.thread_only ? "; and only when the post it reacts to is in Slack" : ""}` : n.type === "slack_post" && n.thread_only ? "Only when the post it reacts to is in Slack; nothing is posted otherwise" : n.type === "pipeline_card" && n.if_missing === "skip" ? "Only if a card is already on that board; this step never creates one" : n.type === "pipeline_card" && !n.stage ? "Only when a card is already on that board: there is no stage to make one in" : n.type === "send_sms" || n.type === "send_email" ? (n.validity?.min_lead ? `Only when the call is more than ${durationWords(n.validity.min_lead)} away when this comes due` : undefined) : undefined;
    return { id: n.id, kind: kindOf(n), title: s.title, meta: s.meta, label: s.label, detail: n.type === "exit" ? exitWords(n.reason) : d.detail, quote, cond, onlyIf, channel: channelOf(n), face: faceOf(n, bindings), ...threadOf(n), helper: (n.type === "set_var" || n.type === "classify" || n.type === "lookup" || n.type === "wait") || undefined, logo: jevRef ? "jev" : logoOf(n, bookingSource), plumb: plumbOf(n, s.title) };
  });
  const edges: ChartEdge[] = def.edges.map((e) => ({ from: e.from, to: e.to, label: edgeWords(e, def.nodes.find((n) => n.id === e.from)), else: e.else || undefined }));
  // before the implicit ways (their words name steps by title) and again after (the ends they add are steps too)
  apart(nodes, edges); const chart = withImplicit(def, { nodes, edges }); apart(chart.nodes, chart.edges);
  return chart;
}

/** What a value-keeping or ledger-reading step keeps (D114); nothing for any other step. */
function plumbOf(n: Node, title: string): Plumb | undefined {
  if (n.type === "set_var") {
    const vals = [n.value, ...(n.pick ? Object.values(n.pick) : []), ...(n.else_value !== undefined ? [n.else_value] : [])];
    return { verb: "remember", what: withThe(pathWords(`vars.${n.key}`)), ...(vals.every((v) => typeof v === "string") ? { text: true } : {}) };
  }
  if (n.type === "lookup") return { verb: "look up", what: title.replace(/^Look up /, "") };
  return undefined;
}

/**
 * Two steps of one workflow never share a main line (D112): the chart's "on to “…”" names a step by it. Each is told
 * apart by the first thing that differs: its first fact, the wait before it, the way into it, the step before it; a
 * pair still alike is numbered.
 */
function apart(nodes: ChartNode[], edges: ChartEdge[]): void {
  const was = new Map(nodes.map((n) => [n.id, n])); const titleOf = new Map(nodes.map((n) => [n.id, n.title]));
  const into = (id: string) => edges.filter((e) => e.to === id);
  const low = (t: string) => t.replace(/^./, (c) => c.toLowerCase());
  const ways: ((n: ChartNode) => { add: string; meta?: string | undefined } | undefined)[] = [
    (n) => { if (!n.meta) return undefined; const [first, ...rest] = n.meta.split(" · "); return { add: ` · ${first}`, meta: rest.join(" · ") || undefined }; },
    (n) => { const i = into(n.id); const w = i.length === 1 ? was.get(i[0].from) : undefined; const t = w?.kind === "wait" ? titleOf.get(w.id)! : undefined; return t ? { add: `, ${t.startsWith("Wait until ") ? t.slice(11) : t.replace(/^Wait /, "after waiting ")}` } : undefined; },
    (n) => { const i = into(n.id); return i.length === 1 && i[0].label ? { add: `, ${i[0].else ? "otherwise" : `when ${low(i[0].label)}`}` } : undefined; },
    (n) => { const i = into(n.id); return i.length === 1 ? { add: `, after ‘${titleOf.get(i[0].from)?.replace(/[“”‹›]/g, "")}’` } : undefined; },
  ];
  const groups = new Map<string, ChartNode[]>(); for (const n of nodes) groups.set(n.title, [...(groups.get(n.title) ?? []), n]);
  for (const [title, group] of groups) {
    let left = group;
    for (const [k, way] of ways.entries()) {
      if (left.length < 2) break;
      const vals = left.map((n) => way(n)); const seen = new Map<string, number>(); for (const v of vals) if (v) seen.set(v.add, (seen.get(v.add) ?? 0) + 1);
      // "after …" only when it tells every one left apart; otherwise they are numbered alike
      if (k === ways.length - 1 && vals.some((v) => !v || seen.get(v.add) !== 1)) break;
      left = left.filter((n, i) => { const v = vals[i]; if (!v || seen.get(v.add) !== 1) return true; n.title = `${title}${v.add}`; if ("meta" in v) n.meta = v.meta; return false; });
    }
    const nth = (k: number) => `${k}${k % 10 === 2 && k % 100 !== 12 ? "nd" : k % 10 === 3 && k % 100 !== 13 ? "rd" : "th"}`;
    if (left.length > 1) left.forEach((n, i) => { if (i) n.title = `${title} (${nth(group.indexOf(n) + 1)} time)`; });
  }
}

const strip = (t: string | undefined) => t === undefined ? undefined : t.replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>/gi, "\n").replace(/<[^>]+>/g, "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();

type StepRow = { node_id: string; node_type: string; status: string; started_at: Date; finished_at: Date | null; result: Record<string, unknown>; error: string | null };
type SendRow = { idempotency_key: string; channel: string; status: string; rendered_body: string; sent_at: Date | null; suppressed_reason: string | null; error: string | null };
type RunLike = { id: string; status: string; current_node: string | null; next_run_at: Date | null; exit_reason: string | null; started_at: Date; step_held?: boolean };

/** A step's one-line fact, in words: why it was skipped, what failed, when they replied. */
function noteOf(s: StepRow, tz: string): string | undefined {
  const r = s.result ?? {};
  // D77: skipped after its tries (the run went on without it), or held: the run waits on this step, which alone is re-checked
  if (r.kind === "gave_up") return `Couldn't do it after ${r.tries ?? "its"} ${r.tries === 1 ? "try" : "tries"}${s.error ? ` (${s.error})` : ""}; the rest of the run went on without it${r.retried_by ? ` · retried by ${r.retried_by}, still failing` : " · Retry this step from the top of this page"}`;
  if (s.error && r.held) return `${s.error} · the run is paused on this step; it alone is re-checked ${typeof r.recheck_at === "string" ? stamp(r.recheck_at, tz) : "soon"} and the run carries on when it passes`;
  if (s.error) return typeof r.retry_at === "string" ? `${s.error} · trying again ${stamp(r.retry_at, tz)} (try ${r.attempt ?? 1} of ${r.of ?? "?"})` : r.paused ? `${s.error} · needs a hand: retry or skip this step` : s.error;
  if (typeof r.retried_by === "string") return `Done on a retry by ${r.retried_by}`;
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
/** What a step done in ghost would have done, or what quiet held back (D132), from the would_* its result carries. */
function heldWords(r: Record<string, unknown>): string {
  const list = (v: unknown) => (Array.isArray(v) ? v : [v]).map((t) => `“${String(t)}”`).join(", ");
  if (r.quiet) {
    if (typeof r.would_post === "string") return `Held back in quiet: ${typeof r.why === "string" ? r.why.replace(/^quiet mode: /, "") : "not a test channel"}; nothing was posted.`;
    return `Held back in quiet: ${r.would_send_document ? "the document was not sent" : r.would_call ? "the webhook was not called" : "it was not sent"}; nothing reaches a contact in quiet.`;
  }
  if (typeof r.ts === "string") return "Done in ghost: posted to the team, marked ghost; nothing went to the contact or the CRM.";
  const bits: string[] = [];
  if (r.would_tag) bits.push(`would have tagged ${list(r.would_tag)}`);
  if (r.would_untag) bits.push(`would have removed ${list(r.would_untag)}`);
  if (r.would_send) bits.push("would have sent it");
  if (r.would_send_document) bits.push("would have sent the document");
  if (r.would_note) bits.push("would have left the note");
  if (r.would_update) bits.push("would have updated the CRM");
  const task = r.would_create_task as { title?: string } | undefined; if (task) bits.push(task.title ? `would have made the task “${task.title}”` : "would have made the task");
  return `Done in ghost: ${bits.length ? bits.join("; ") : "this is what it would have done"}. Nothing was written to the CRM or sent to anyone.`;
}
const stamp = (iso: string, tz: string) => DateTime.fromISO(iso).setZone(tz).toFormat("ccc LLL d · h:mm a");

/**
 * What one run did and will do, in order: the steps it ran (their state and words), where it waits now, and the plan from
 * there. The strip on a list row and the feed on the run page are both this list.
 */
export function pathOf(full: Definition, run: RunLike, steps: StepRow[], sends: SendRow[], plan: Projected[], tz: string, names: Namer = KEY_WORDS): PathItem[] {
  const def = collapsePlumbing(full);
  const byId = new Map(def.nodes.map((n) => [n.id, n]));
  const out: PathItem[] = [];
  const sendFor = (nodeId: string) => sends.find((s) => s.idempotency_key === `${run.id}:${nodeId}`);
  const live = run.status === "active" || run.status === "waiting";
  // the trigger: a run always starts with one, whether or not a step row says so
  const trig = def.nodes.find((n) => n.type === "trigger" && (steps[0]?.node_id === n.id || !steps.some((s) => s.node_type === "trigger"))) ?? def.nodes.find((n) => n.type === "trigger");
  if (trig && !steps.some((s) => s.node_type === "trigger")) { const t = shortTitle(def, trig, names); out.push({ node_id: trig.id, title: t.title, meta: t.meta, kind: "trig", state: "ok", at: run.started_at.toISOString() }); }
  const order = new Map(walkOrder(def).map((id, i) => [id, i]));
  steps = [...steps].sort((a, b) => a.started_at.getTime() - b.started_at.getTime() || (order.get(a.node_id) ?? 999) - (order.get(b.node_id) ?? 999));
  const seen = new Set<string>();
  steps.forEach((s, i) => {
    if (s.node_type === "set_var") return;
    const n = byId.get(s.node_id);
    const t = n ? shortTitle(def, n, names) : { title: s.node_id };
    const last = i === steps.length - 1;
    let state: StepState = s.status === "ok" ? "ok" : s.status === "skipped" || s.status === "stale" ? "skip" : s.status === "failed" ? "warn" : s.status === "waiting" ? (live && run.current_node === s.node_id && !steps.slice(i + 1).some((x) => x.node_id === s.node_id) ? "here" : "ok") : s.status === "paused" ? "stop" : "ok";
    if (s.node_type === "wait" && state === "ok" && last && live && run.current_node === s.node_id) state = "here";
    if (state === "skip" && (s.result?.kind === "blocked" || s.result?.kind === "gave_up")) state = "blocked";
    if (state === "ok" && (s.result?.ghost || s.result?.shadow || s.result?.quiet)) state = "ghost";   // shadow: a row from before D132
    void last;
    // a wait row that already fired reads as done; a wait row the run still sits on reads as "here" with when it moves
    const send = sendFor(s.node_id);
    const item: PathItem = { node_id: s.node_id, title: t.title, meta: t.meta, kind: n ? kindOf(n) : "other", state, at: (state === "here" ? run.next_run_at?.toISOString() : null) ?? s.started_at.toISOString(), note: noteOf(s, tz) };
    if (n) { item.channel = channelOf(n); item.face = faceOf(n); Object.assign(item, threadOf(n)); }
    if (n?.only_if) item.onlyIf = onlyIfWords(n.only_if, constsOf(full));
    // rows written before D103 said "…; it is not" whatever the condition (wrong for a "not"): say what held instead
    if (n?.only_if && typeof s.result?.why === "string" && s.result.why.endsWith("; it is not")) item.note = `Didn't go out: ${skippedWords(n.only_if)}`;
    // D105's "the card is on <stage>" was worded from the binding key when the step ran: the CRM's name for that stage now
    if (typeof s.result?.stage === "string" && typeof s.result?.why === "string" && s.result.why.startsWith("left where it is: the card is on ")) { const st = names.stageId(s.result.stage); item.note = `Didn't go out: left where it is: the card is on ${st.text}${mark([st])}, a stage this step does not move from`; }
    if (state === "ghost") item.note = [item.note, heldWords(s.result ?? {})].filter(Boolean).join(" · ");
    if (send && send.rendered_body) { item.words = send.channel === "slack" ? send.rendered_body : strip(send.rendered_body) ?? null; item.send_state = send.status; if (send.status === "failed" && send.error) item.note = send.error; }
    if (s.node_type === "exit" && state === "ok") { const w = exitWords(run.exit_reason ?? "done"); item.title = "Done"; item.note = w.startsWith("Stop: ") ? w.replace(/^Stop: /, "") : undefined; }
    // the runner writes a second row for the same node when it parks and resumes (dark hours, a wait): one row, the later state
    if (out.length && out[out.length - 1].node_id === s.node_id) out[out.length - 1] = { ...out[out.length - 1], ...item, at: out[out.length - 1].at ?? item.at };
    else out.push(item);
    seen.add(s.node_id);
  });
  if (live) {
    // parked before any step row for the node (a wait the runner has not reached, or a reply-wait): say where
    const cur = run.current_node;
    if (cur && !out.some((x) => x.state === "here")) {
      const n = byId.get(cur); const already = out.find((x) => x.node_id === cur && x.state === "ok" && x.kind === "trig");
      if (already) { already.state = "here"; already.at = run.next_run_at?.toISOString() ?? already.at; }   // about to start: the trigger row is where it stands
      else if (n) { const t = shortTitle(def, n, names); out.push({ node_id: cur, title: t.title, meta: t.meta, kind: kindOf(n), state: "here", at: run.next_run_at?.toISOString() ?? null, channel: channelOf(n) }); }
    }
    for (const p of plan) {
      if (out.some((x) => x.node_id === p.node_id && (x.state === "here" || x.state === "next"))) continue;
      const n = byId.get(p.node_id); const t = n ? shortTitle(def, n, names) : { title: p.title };
      out.push({ node_id: p.node_id, title: t.title, meta: t.meta, kind: n ? kindOf(n) : "other", state: "next", at: p.at, note: p.note, channel: n ? channelOf(n) : undefined, onlyIf: n?.only_if ? onlyIfWords(n.only_if, constsOf(full)) : undefined });
    }
  } else if ((run.status === "failed" || run.status === "paused") && !out.some((x) => x.state === "warn")) {
    const cur = run.current_node; const n = cur ? byId.get(cur) : undefined;
    out.push({ node_id: cur ?? "?", title: n ? shortTitle(def, n, names).title : run.status === "paused" ? "Paused" : "Failed", kind: n ? kindOf(n) : "other", state: "warn", at: null, note: run.exit_reason ?? undefined });
  } else if (run.status === "exited" && !out.some((x) => x.kind === "end")) {
    out.push({ node_id: "exit", title: "Done", note: (run.exit_reason ?? "").replace(/^moot: /, "").replace(/_/g, " ") || undefined, kind: "end", state: "ok", at: run.started_at.toISOString() });
  }
  return out;
}

/** One run's state for a list row: the icon, the word under the strip, the date. */
export function runState(run: RunLike, path: PathItem[], tz: string): { state: "ok" | "here" | "warn" | "stop"; at: string; done: boolean } {
  if (run.status === "completed") { const words = exitWords(run.exit_reason ?? "done"); return { state: "ok", at: words.startsWith("Stop: ") ? `done · ${words.replace(/^Stop: /, "").toLowerCase()}` : "done", done: true }; }
  if (run.status === "failed") { const w = path.find((x) => x.state === "warn"); return { state: "warn", at: `failed: ${w ? w.title : run.exit_reason ?? "a step"}`, done: true }; }
  if (run.status === "exited") return { state: "ok", at: `done · ${(run.exit_reason ?? "").replace(/^moot: /, "").replace(/_/g, " ")}`, done: true };
  if (run.status === "paused") { const w = path.find((x) => x.state === "warn"); return { state: "warn", at: `${run.step_held ? "held: " : "paused: "}${w ? w.title : run.exit_reason ?? "a step"}`, done: true }; }
  const here = path.find((x) => x.state === "here");
  return { state: "here", at: here ? `${here.title}${here.meta ? ` · ${here.meta}` : ""}` : "in flight", done: false };
}
