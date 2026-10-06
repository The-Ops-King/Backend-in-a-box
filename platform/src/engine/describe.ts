import type { Definition, Edge, Node, Predicate, WaitRule } from "./definition";

/**
 * Plain-English descriptions of workflow pieces, shared by the flow chart and the step list so the two never disagree.
 * Anything a client reads here should read like an operator wrote it, not like the JSON underneath.
 */

export type NodeKind = "trigger" | "message" | "crm" | "decision" | "wait" | "ai" | "control" | "exit";

/** What family a node belongs to. Shapes and colors key off this, never off the raw type. */
export function kindOf(n: Node): NodeKind {
  switch (n.type) {
    case "trigger": return "trigger";
    case "send_sms": case "send_email": case "slack_post": return "message";
    case "set_tag": case "remove_tag": case "note": case "update_appointment": case "update_opportunity": case "pipeline_card": case "update_contact": case "create_task": return "crm";
    case "check": case "branch": return "decision";
    case "wait": case "wait_for_reply": return "wait";
    case "classify": return "ai";
    case "set_var": case "start_workflow": case "pause_runs": return "control";
    case "exit": return "exit";
  }
}

export const KIND_LABEL: Record<NodeKind, string> = { trigger: "Starts when", message: "Message out", crm: "CRM change", decision: "Decision", wait: "Wait", ai: "AI reads the reply", control: "Flow control", exit: "Stops" };

const EVENTS: Record<string, string> = {
  "lead.created": "New lead created", "contact.created": "New contact created",
  "appointment.booked": "Appointment booked", "appointment.rescheduled": "Appointment rescheduled", "appointment.status_changed": "Appointment status changed", "appointment.outcome": "Call outcome recorded",
  "call.held": "Call held", "message.received": "Reply received", "tag.added": "Tag added", "tag.removed": "Tag removed",
  "payment.received": "Payment received", "payment.failed": "Payment failed", "payment.paid_in_full": "Paid in full",
  "opportunity.opened": "Opportunity opened", "opportunity.won": "Deal won", "opportunity.lost": "Opportunity lost", "form.submitted": "Form submitted",
};
const PATHS: Record<string, string> = {
  "contact.phone": "phone number", "contact.email": "email address", "contact.first_name": "first name", "contact.last_name": "last name", "contact.name": "full name", "contact.tags": "tags", "contact.timezone": "time zone",
  "appointment.term.category": "call type", "appointment.status": "appointment status", "appointment.starts_at": "call time", "appointment.closer.first_name": "closer's first name", "appointment.closer.name": "closer", "appointment.closer.ghl_user_id": "the closer", "appointment.self_booked": "self-booked", "appointment.set_by": "setter", "appointment.reschedule_url": "reschedule link", "appointment.tracking.utm_source": "UTM source", "appointment.cancelled_by": "who cancelled", "appointment.cancel_reason": "cancel reason",
  "contact.ghl_contact_id": "contact id", "vars.setter_line": "setter line", "vars.booking_kind": "booking kind", "crm.location_id": "location id",
  "event.status.to": "new status", "event.status.from": "previous status", "event.outcome": "outcome", "event.tag": "tag",
  "reply.intent": "the reply", "reply.last_inbound.body": "their reply", "reply.last_outbound.body": "our last message", "reply.top_guesses": "top guesses",
  "opportunity.status": "opportunity status", "company.name": "company name", "calendar.closer_call.url": "booking link", "calendar.booking.url": "booking link", "now": "today",
};
const VALUES: Record<string, string> = { noshow: "no-show", reschedule_request: "a reschedule request", follow_up: "follow up", first_call: "first call", closing: "closing call" };

export const humanWords = (s: string) => s.replace(/^crm\./, "").replace(/[_.-]+/g, " ").replace(/\s+/g, " ").trim();
const value = (v: unknown) => typeof v === "string" ? VALUES[v] ?? `“${humanWords(v)}”` : JSON.stringify(v);
/** `{{a.b}}` or a bare path → the words a person uses for it. */
export function pathWords(p: unknown): string {
  if (typeof p !== "string") return String(p);
  const m = /^\{\{\s*([a-zA-Z0-9_.]+)(?:\s*\|[^}]*)?\s*\}\}$/.exec(p); const path = m ? m[1] : p;
  if (PATHS[path]) return PATHS[path];
  if (path.startsWith("crm.")) return humanWords(path);
  if (path.startsWith("event.")) return humanWords(path.slice(6));
  if (path.startsWith("vars.")) return humanWords(path.slice(5));
  if (path.startsWith("contact.fields.")) return humanWords(path.slice("contact.fields.".length));
  return humanWords(path.split(".").slice(-2).join(" "));
}
/** Message templates keep their text; bindings inside become their plain name so the chart does not show `{{calendar.closer_call.url}}`. */
export const templateWords = (t: string) => t.replace(/<[^>]+>/g, " ").replace(/\{\{\s*([a-zA-Z0-9_.]+)(?:\s*\|[^}]*)?\s*\}\}/g, (_, p) => `[${pathWords(p)}]`).replace(/\s+/g, " ").trim();

export function predicateWords(p: Predicate): string {
  if ("exists" in p) return `${pathWords(p.exists)} exists`;
  if ("eq" in p) return `${pathWords(p.eq[0])} is ${value(p.eq[1])}`;
  if ("neq" in p) return `${pathWords(p.neq[0])} is not ${value(p.neq[1])}`;
  if ("gt" in p) return `${pathWords(p.gt[0])} > ${value(p.gt[1])}`; if ("gte" in p) return `${pathWords(p.gte[0])} ≥ ${value(p.gte[1])}`;
  if ("lt" in p) return `${pathWords(p.lt[0])} < ${value(p.lt[1])}`; if ("lte" in p) return `${pathWords(p.lte[0])} ≤ ${value(p.lte[1])}`;
  if ("in" in p) return `${pathWords(p.in[0])} is one of ${p.in[1].map(value).join(", ")}`;
  if ("and" in p) return p.and.map(predicateWords).join(" and "); if ("or" in p) return p.or.map(predicateWords).join(" or ");
  if ("not" in p) return `not (${predicateWords(p.not)})`;
  return JSON.stringify(p);
}

const clock = (hh: string, mm: string) => { const h = +hh; return `${h % 12 || 12}:${mm} ${h < 12 ? "AM" : "PM"}`; };
export function durationWords(d: string): string {
  const m = /^\+?(\d+)\s*(m|h|d|w)$/.exec(d.trim()); if (!m) return d;
  const n = +m[1], u = { m: "minute", h: "hour", d: "day", w: "week" }[m[2]]!; return `${n} ${u}${n === 1 ? "" : "s"}`;
}
export function waitWords(rule: WaitRule): string {
  const m = /^(day_of|day_before|day_after)@(\d{2}):(\d{2})$/.exec(rule.offset);
  const anchor = rule.anchor === "now" ? "" : rule.anchor === "appointment.starts_at" ? "the call" : pathWords(rule.anchor);
  if (m) {
    const when = m[1] === "day_of" ? `the day of ${anchor || "the call"}` : m[1] === "day_before" ? `the day before ${anchor || "the call"}` : anchor ? `the day after ${anchor}` : "the next day";
    return `Wait until ${clock(m[2], m[3])} ${when}`;
  }
  return anchor ? `Wait until ${durationWords(rule.offset)} ${rule.offset.startsWith("-") ? "before" : "after"} ${anchor}` : `Wait ${durationWords(rule.offset)}`;
}
const guardWords = (rule: WaitRule) => rule.guard ? ` (if that is less than ${durationWords(rule.guard.min_lead)} away, use ${waitWords({ ...rule, offset: rule.guard.fallback, guard: undefined }).replace(/^Wait until /, "")} instead)` : "";

export const exitWords = (reason: string) => ({ done: "Done", booked: "Done: booking recorded", cancelled_recorded: "Done: cancellation recorded", sent: "Done: sent", replied: "Done: they replied", no_reply: "Stop: no reply", no_phone: "Stop: no phone number", confirmed: "Done: confirmed", cancelled: "Done: cancelled", reschedule_sent: "Done: reschedule link sent", handed_to_human: "Stop: handed to a human", escalated: "Stop: escalated", sequence_done: "Done: sequence finished" } as Record<string, string>)[reason] ?? `Stop: ${humanWords(reason)}`;

export type NodeText = { title: string; detail?: string; quote?: string };

/** One line a person understands, plus optional detail and a quoted message. */
export function describeNode(n: Node): NodeText {
  switch (n.type) {
    case "trigger": return { title: `${EVENTS[n.event] ?? humanWords(n.event)}${n.match ? ` — ${predicateWords(n.match)}` : ""}` };
    case "check": return { title: `Check if ${predicateWords(n.when)}`, detail: `If not → ${exitWords(n.else_exit).toLowerCase()}` };
    case "branch": return { title: "Which way?" };
    case "wait": return { title: waitWords(n.rule), detail: `${n.rule.tz === "contact" ? "Contact's" : "Company's"} time zone${guardWords(n.rule)}` };
    case "wait_for_reply": return { title: `Wait for ${n.channel === "any" ? "a" : n.channel === "sms" ? "a text" : "an email"} reply`, detail: `Up to ${durationWords(n.timeout)}; continues the minute one arrives` };
    case "send_sms": return { title: "Send text", quote: templateWords(n.template), detail: n.validity?.min_lead ? `Only if at least ${durationWords(n.validity.min_lead)} before the call; otherwise ${n.on_stale === "skip" ? "skip it" : n.on_stale === "substitute" ? "send the fallback" : "pause for a human"}` : undefined };
    case "send_email": return { title: `Send email: “${templateWords(n.subject)}”`, quote: templateWords(n.template) };
    case "slack_post": return { title: `Post to Slack (${pathWords(n.channel)})`, quote: templateWords(n.template) };
    case "classify": return { title: "AI reads the reply", detail: `Decides between the ${humanWords(n.domain)} options; below ${Math.round(n.threshold * 100)}% sure counts as unclear` };
    case "set_tag": { const t = Array.isArray(n.tag) ? n.tag : [n.tag]; return { title: `Add tag${t.length > 1 ? "s" : ""} ${t.map((x) => `“${x}”`).join(", ")}` }; }
    case "remove_tag": { const t = Array.isArray(n.tag) ? n.tag : [n.tag]; return { title: `Remove tag${t.length > 1 ? "s" : ""} ${t.map((x) => `“${x}”`).join(", ")}` }; }
    case "update_contact": {
      const bits = [n.set.assign_to ? `owner → ${pathWords(n.set.assign_to)}` : "", n.set.phone ? "phone" : "", n.set.timezone ? "time zone" : "", n.set.first_name || n.set.last_name ? "name" : "", ...n.fields.map((f) => `${pathWords(f.id)} = ${templateWords(f.value)}`), ...n.clear.map((id) => `clear ${pathWords(id)}`)].filter(Boolean);
      return { title: "Update the contact in the CRM", detail: bits.join("; ") || undefined };
    }
    case "note": return { title: "Leave an internal note", quote: templateWords(n.template) };
    case "update_appointment": return { title: `Mark appointment ${Object.entries(n.set).map(([k, v]) => `${humanWords(k)} → ${value(v)}`).join(", ")}` };
    case "update_opportunity": return { title: `Update opportunity: ${Object.entries(n.set).map(([k, v]) => `${humanWords(k)} → ${value(v)}`).join(", ")}` };
    case "pipeline_card": return { title: `${n.if_missing === "skip" ? "Move" : "Create or move"} pipeline card “${templateWords(n.name)}”`, detail: `In the ${pathWords(n.pipeline)}, stage ${pathWords(n.stage)}${n.assign_to ? `; owner → ${pathWords(n.assign_to)}` : ""}${n.fields.length ? `; set ${n.fields.map((f) => `${pathWords(f.id)} = ${templateWords(f.value)}`).join(", ")}` : ""}${n.if_missing === "skip" ? "; only if the card already exists" : ""}` };
    case "create_task": return { title: `Task for ${n.assign_to ? pathWords(n.assign_to) : "the team"}: “${templateWords(n.title)}”`, detail: `Due in ${durationWords(n.due)}`, quote: n.body ? templateWords(n.body) : undefined };
    case "set_var": return { title: `Remember ${humanWords(n.key)} = ${typeof n.value === "string" ? templateWords(n.value) : JSON.stringify(n.value)}` };
    case "start_workflow": return { title: `Hand off to “${humanWords(n.workflow)}”` };
    case "pause_runs": return { title: `Pause the ${n.scope === "contact" ? "contact's" : "appointment's"} other workflows` };
    case "exit": return { title: exitWords(n.reason) };
  }
}

/** A branch reads as the question its outgoing edges answer: "setter booked or self-booked?" */
export function branchTitle(def: Definition, nodeId: string): string {
  const labels = def.edges.filter((e) => e.from === nodeId).map(edgeWords).filter((w) => w && w !== "otherwise");
  const els = def.edges.some((e) => e.from === nodeId && e.else);
  if (!labels.length) return "Which way?";
  return `${labels.join(", or ")}${els && labels.length === 1 ? ", or neither" : ""}?`.replace(/^./, (c) => c.toUpperCase());
}

export function edgeWords(e: Edge): string {
  if (e.label === "timeout") return "no reply in time";
  if (e.label === "replied") return "they replied";
  if (e.label) return humanWords(e.label);
  if (e.else) return "otherwise";
  if (e.when) return predicateWords(e.when);
  return "";
}

/** Walk order from the triggers, breadth-first, so a list reads top to bottom the way the flow runs. */
export function walkOrder(def: Definition): string[] {
  const out = (id: string) => def.edges.filter((e) => e.from === id);
  const order: string[] = []; const seen = new Set<string>();
  const q = def.nodes.filter((n) => n.type === "trigger").map((n) => n.id);
  while (q.length) { const id = q.shift()!; if (seen.has(id)) continue; seen.add(id); order.push(id); for (const e of out(id)) q.push(e.to); }
  for (const n of def.nodes) if (!seen.has(n.id)) order.push(n.id);
  return order;
}
