import { scheduleWords } from "./when";
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
    case "send_sms": case "send_email": case "slack_post": case "send_document": case "notify_owner": return "message";
    case "tags": case "set_tag": case "remove_tag": case "note": case "update_appointment": case "update_opportunity": case "pipeline_card": case "update_contact": case "create_task": case "crm_record": case "record_outcome": return "crm";
    case "check": case "branch": return "decision";
    case "wait": case "wait_for_reply": return "wait";
    case "classify": case "analyze": return "ai";
    case "set_var": case "start_workflow": case "pause_runs": return "control";
    case "webhook": return "message";
    case "health_check": case "availability_check": case "report": return "control";
    case "exit": return "exit";
  }
}

export const KIND_LABEL: Record<NodeKind, string> = { trigger: "Starts when", message: "Message out", crm: "CRM change", decision: "Decision", wait: "Wait", ai: "AI reads", control: "Flow control", exit: "Stops" };

export const EVENT_LABELS: Record<string, string> = {
  "lead.created": "New lead created", "contact.created": "New contact created", "schedule": "On a schedule", "eod.filed": "End-of-day report filed", "slack.reaction": "A team member reacted in Slack",
  "appointment.booked": "Appointment booked", "appointment.rescheduled": "Appointment rescheduled", "appointment.status_changed": "Appointment status changed", "appointment.outcome": "Call outcome recorded",
  "call.held": "Call held", "message.received": "Reply received", "tag.added": "Tag added", "tag.removed": "Tag removed",
  "payment.received": "Payment received", "payment.failed": "Payment failed", "payment.paid_in_full": "Paid in full",
  "recording.received": "Fathom recording received", "intake.recorded": "Intake answers recorded", "contact.merged": "Two contacts merged", "stage.changed": "Pipeline stage changed", "run.started": "A workflow run started", "run.exited": "A workflow run stopped early", "send.suppressed": "A message was held back", "recording.unlinked": "Recording with no matching contact", "recording.linked": "Recording linked to a contact", "call.analyzed": "AI finished reading a call", "call.logged": "Dialer call logged", "agreement.sent": "Agreement sent", "agreement.signed": "Agreement signed",
  "opportunity.opened": "Opportunity opened", "opportunity.won": "Deal won", "opportunity.lost": "Opportunity lost", "form.submitted": "Form submitted",
};
const PATHS: Record<string, string> = {
  "contact.phone": "phone number", "contact.email": "email address", "contact.first_name": "first name", "contact.last_name": "last name", "contact.name": "full name", "contact.tags": "tags", "contact.timezone": "time zone",
  "appointment.term.category": "call type", "appointment.status": "appointment status", "appointment.starts_at": "call time", "appointment.closer.first_name": "closer's first name", "appointment.closer.name": "closer", "appointment.closer.ghl_user_id": "the closer", "appointment.self_booked": "self-booked", "appointment.set_by": "setter", "appointment.reschedule_url": "reschedule link", "appointment.tracking.utm_source": "UTM source", "appointment.cancelled_by": "who cancelled", "appointment.cancel_reason": "cancel reason",
  "event.amount": "amount", "event.kind": "payment kind", "event.running_total": "running total", "event.contract_value": "program price", "event.outstanding": "outstanding", "event.cleared": "paid in full", "event.provider_payment_id": "transaction id", "event.paid_at": "paid at",
  "contact.ghl_contact_id": "contact id", "vars.setter_line": "setter line", "vars.booking_kind": "booking kind", "crm.location_id": "location id",
  "event._type": "this", "event._source": "the source", "event.status.to": "new status", "event.status.from": "previous status", "event.outcome": "outcome", "event.tag": "tag",
  "reply.intent": "the reply", "reply.last_inbound.body": "their reply", "reply.last_outbound.body": "our last message", "reply.top_guesses": "top guesses",
  "opportunity.status": "opportunity status", "company.name": "company name", "calendar.closer_call.url": "booking link", "calendar.booking.url": "booking link", "now": "today",
  "recording.transcript_text": "the transcript", "recording.share_url": "recording link", "recording.title": "meeting title", "recording.started_at": "the call started", "recording.ended_at": "the call ended", "contact.latest_appointment_id": "their latest booking", "contact.latest_recording_id": "their latest recorded call", "recording.id": "this recording", "recording.duration_min": "call length (minutes)", "recording.closer.name": "closer", "recording.closer.ghl_user_id": "the closer", "recording.recorded_by.name": "who recorded", "recording.summary": "the recorder's summary", "recording.invitee_names": "attendees", "recording.matched_by": "how the contact was matched", "recording.external_id": "recording id",
  "recording.duration_sec": "call length (seconds)", "recording.caller.name": "who dialed", "recording.caller.ghl_user_id": "who dialed", "recording.led_to_booking": "a booking after the call", "recording.has_transcript": "there is a transcript", "recording.kind": "kind of recording", "recording.connected": "the call connected", "recording.direction": "call direction", "recording.status": "call status", "recording.url": "the recording",
  "contact.paid": "they have paid", "contact.agreement_signed": "they have signed the agreement", "contact.agreement_sent": "an agreement was sent", "contact.owner.name": "the contact's owner", "contact.owner.ghl_user_id": "the contact's owner", "contact.payments_count": "number of payments", "contact.cash_collected": "cash collected", "event.prior_total": "what they had paid before this", "agreement.signed_at": "when they signed", "agreement.name": "the agreement", "records.sales_call.key": "their Sales Call record", "crm.agreement_template": "the agreement template", "crm.agreement_sender": "who the agreement is from",
  "vars.min_seconds": "minimum call length (seconds)", "vars.classify.call_type": "the call type", "vars.classify.kind": "the recording", "vars.outcome.disposition": "how the call ended", "vars.classify.is_sales_call": "the AI called it a sales call", "vars.notes.digest": "the AI digest", "vars.notes.fit_quality": "fit score", "vars.booked_flag": "led-to-booking flag", "vars.outcome_line": "outcome line",
  "contact.closer.name": "the closer", "contact.closer.mention": "the closer (@mentioned)", "contact.closer.first_name": "the closer's first name", "contact.setter.name": "the setter", "contact.setter.mention": "the setter (@mentioned)", "contact.first_booked_at": "their first booking", "contact.days_to_close": "days from first booking to first payment", "contact.revenue": "the deal value", "contact.source": "lead source", "vars.cheer": "the AI's congratulations", "vars.notes.disposition": "the call's outcome", "vars.notes.pain": "their pains", "vars.notes.desire": "their goals", "vars.notes.objections": "their objections", "vars.notes.next_step": "the next step", "vars.rubric.overall_score": "the call score",
  "user.name": "the closer", "user.first_name": "the closer's first name", "user.mention": "the closer (@mention)", "user.slack_user_id": "the closer's Slack DM", "user.report_url": "their end-of-day link", "user.eod.all_lines": "their unfiled days, one line each with a link", "user.eod.earlier_lines": "earlier unfiled days with links", "user.eod.today.line": "today's link and call count", "user.eod.today.calls": "calls on their calendar today", "user.eod.today.filed": "today is filed", "user.eod.earlier_count": "earlier days still unfiled", "vars.lines": "the lines to send", "vars.report.body": "the wrap-up text", "vars.kind": "which wrap-up",
  "event.totals_line": "the day in one line", "event.corrections": "what was corrected", "event.corrected": "anything corrected", "event.corrections_count": "corrections", "event.day_label": "the day", "event.day_answers_lines": "their answers to the day questions", "event.calls": "each call", "event.user_id": "who filed", "event.refiled": "filed again",
  "appointment.id": "an appointment", "appointment.external_id": "appointment id", "appointment.outcome": "appointment outcome", "appointment.call_outcome": "how the call went", "event.appointment_matched": "a matching appointment",
};
const VALUES: Record<string, string> = { sales_call: "a sales call", closed_won: "closed won", close_pending: "close pending", financing_denied: "financing denied", dq: "disqualified", unqualified: "disqualified", disposition: "a closer's form", "appointment.rescheduled": "a reschedule", "appointment.booked": "a new booking", noshow: "no-show", reschedule_request: "a reschedule request", follow_up: "follow up", first_call: "first call", closing: "closing call", setting: "a setting call", confirmation: "a confirmation call", phone: "a phone call", meeting: "a meeting" };

export const humanWords = (s: string) => s.replace(/^crm\./, "").replace(/[_.-]+/g, " ").replace(/\s+/g, " ").trim();
const listOf = (v?: string | string[]): string[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
const value = (v: unknown) => typeof v === "string" ? (v === "" ? "blank" : /^\{\{/.test(v) ? `the ${pathWords(v)}` : VALUES[v] ?? `“${humanWords(v)}”`) : JSON.stringify(v);   // a {{path}} on the right is a thing, not a literal
/** `{{a.b}}` or a bare path → the words a person uses for it. */
export function pathWords(p: unknown): string {
  if (typeof p !== "string") return String(p);
  const m = /^\{\{\s*([a-zA-Z0-9_.]+)(?:\s*\|[^}]*)?\s*\}\}$/.exec(p); const path = m ? m[1] : p;
  if (PATHS[path]) return PATHS[path];
  if (path.startsWith("crm.")) return humanWords(path);
  if (path.startsWith("event.")) return humanWords(path.slice(6));
  if (path.startsWith("vars.")) return humanWords(path.slice(5));
  if (path.startsWith("contact.fields.")) return humanWords(path.slice("contact.fields.".length));
  if (path.startsWith("cards.")) return `the ${humanWords(path.split(".")[1])} card${path.split(".").length > 2 ? ` ${humanWords(path.split(".").slice(2).join(" "))}` : ""}`;
  if (path.startsWith("record.")) return `the record ${humanWords(path.slice(7))}`;
  if (path.startsWith("prompt.")) return `the “${humanWords(path.slice(7))}” prompt`;
  if (path.startsWith("recording.")) return humanWords(path.slice(10));
  if (path.startsWith("appointment.answers.")) return `their answer to ${humanWords(path.slice("appointment.answers.".length))}`;
  return humanWords(path.split(".").slice(-2).join(" "));
}
/** Message templates keep their text; bindings inside become their plain name so the chart does not show `{{calendar.closer_call.url}}`. */
export const templateWords = (t: string) => t.replace(/<[^>]+>/g, " ").replace(/\{\{\s*([a-zA-Z0-9_.]+)(?:\s*\|[^}]*)?\s*\}\}/g, (_, p) => `[${pathWords(p)}]`).replace(/\s+/g, " ").trim();

/** A predicate as a person would say it. `consts` are the workflow's own set_var literals, so "≥ the minimum call length" reads "longer than 60 seconds". */
export function predicateWords(p: Predicate, consts: Record<string, unknown> = {}): string {
  const w = (q: Predicate) => predicateWords(q, consts);
  const lit = (v: unknown): unknown => { const m = typeof v === "string" ? /^\{\{\s*(vars\.[a-zA-Z0-9_.]+)\s*\}\}$/.exec(v) : null; return m && m[1] in consts ? consts[m[1]] : v; };
  // a measured thing compared to a number: "the call is longer than 60 seconds"
  const measure = (path: unknown, cmp: "gt" | "gte" | "lt" | "lte", raw: unknown): string | null => {
    const v = lit(raw); if (typeof v !== "number" || typeof path !== "string") return null;
    const m = /^\{\{\s*([a-zA-Z0-9_.]+)/.exec(path); const key = m ? m[1] : path;
    const unit = /duration_sec$|_sec$|_seconds$/.test(key) ? "second" : /duration_min$|_min$|_minutes$/.test(key) ? "minute" : /_days?$/.test(key) ? "day" : /_hours?$/.test(key) ? "hour" : null;
    if (!unit) return null;
    const subject = /^recording\./.test(key) ? "the call" : pathWords(key).replace(/ \((seconds|minutes|days|hours)\)$/, "");
    const n = `${v} ${unit}${v === 1 ? "" : "s"}`;
    return cmp === "gt" || cmp === "gte" ? `${subject} is longer than ${n}` : `${subject} is shorter than ${n}`;   // Tyler's words; the edge second is not worth a clause
  };
  // "they have signed" → "they have not signed"; "there is a transcript" → "there is no transcript"; "the AI called it …" → "the AI did not call it …"
  const negate = (t: string) => /^there is an? /.test(t) ? t.replace(/^there is an? /, "there is no ") : /^(they|we|you) have /.test(t) ? t.replace(/^(\w+) have /, "$1 have not ") : /^(.+?) (is|are|was|were) /.test(t) ? t.replace(/^(.+?) (is|are|was|were) /, "$1 $2 not ") : /^the AI called /.test(t) ? t.replace(/^the AI called /, "the AI did not call ") : `not ${t}`;
  if ("exists" in p) return `there is a ${pathWords(p.exists).replace(/^(a|an|the) /, "")}`;
  if ("eq" in p) return p.eq[1] === true ? pathWords(p.eq[0]) : p.eq[1] === false ? negate(pathWords(p.eq[0])) : `${pathWords(p.eq[0])} is ${value(lit(p.eq[1]))}`;
  if ("neq" in p) return p.neq[1] === true ? negate(pathWords(p.neq[0])) : p.neq[1] === false ? pathWords(p.neq[0]) : `${pathWords(p.neq[0])} is not ${value(lit(p.neq[1]))}`;
  if ("gt" in p) return measure(p.gt[0], "gt", p.gt[1]) ?? `${pathWords(p.gt[0])} is more than ${value(lit(p.gt[1]))}`;
  if ("gte" in p) return measure(p.gte[0], "gte", p.gte[1]) ?? `${pathWords(p.gte[0])} is at least ${value(lit(p.gte[1]))}`;
  if ("lt" in p) return measure(p.lt[0], "lt", p.lt[1]) ?? `${pathWords(p.lt[0])} is less than ${value(lit(p.lt[1]))}`;
  if ("lte" in p) return measure(p.lte[0], "lte", p.lte[1]) ?? `${pathWords(p.lte[0])} is at most ${value(lit(p.lte[1]))}`;
  if ("in" in p) { const vs = p.in[1].map((x) => value(lit(x))); return `${pathWords(p.in[0])} is ${vs.length > 1 ? `${vs.slice(0, -1).join(", ")} or ${vs.at(-1)}` : vs[0]}`; }
  if ("has" in p) return `${pathWords(p.has[0])} include ${value(lit(p.has[1]))}`;
  if ("and" in p) return p.and.map(w).join(" and "); if ("or" in p) return p.or.map(w).join(" or ");
  if ("not" in p) return "has" in p.not ? `${pathWords(p.not.has[0])} do not include ${value(lit(p.not.has[1]))}` : `not (${w(p.not)})`;
  return JSON.stringify(p);
}
/** The literals a workflow's unconditional set_var steps hold, keyed vars.<key>: the numbers its gates compare against. */
export const constsOf = (def: { nodes: Node[] }): Record<string, unknown> => Object.fromEntries(def.nodes.filter((n): n is Extract<Node, { type: "set_var" }> => n.type === "set_var" && !n.when).map((n) => [`vars.${n.key}`, n.value]));

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
  const hm = (t: string) => clock(t.slice(0, 2), t.slice(3, 5));
  const win = rule.earliest || rule.latest ? ` (${[rule.earliest ? `not before ${hm(rule.earliest)}` : "", rule.latest ? `not after ${hm(rule.latest)}` : ""].filter(Boolean).join(", ")})` : "";
  return (anchor ? `Wait until ${durationWords(rule.offset.replace(/^[-+]/, ""))} ${rule.offset.startsWith("-") ? "before" : "after"} ${anchor}` : `Wait ${durationWords(rule.offset.replace(/^[-+]/, ""))}`) + win;
}
const guardWords = (rule: WaitRule) => rule.guard ? ` (if that is less than ${durationWords(rule.guard.min_lead)} away, use ${waitWords({ ...rule, offset: rule.guard.fallback, guard: undefined }).replace(/^Wait until /, "")} instead)` : "";

export const exitWords = (reason: string) => ({ done: "Done", not_a_sales_call: "Stop: not a sales call", recorded_no_appointment: "Done: recorded, no appointment matched", booked: "Done: booking recorded", cancelled_recorded: "Done: cancellation recorded", recorded: "Done: recorded", sent: "Done: sent", replied: "Done: they replied", no_reply: "Done: no reply", no_phone: "Stop: no phone number", confirmed: "Done: confirmed", cancelled: "Done: cancelled", reschedule_sent: "Done: reschedule link sent", handed_to_human: "Stop: handed to a human", escalated: "Done: escalated to the owner", sequence_done: "Done: sequence finished" } as Record<string, string>)[reason] ?? `Stop: ${humanWords(reason)}`;

export type NodeText = { title: string; detail?: string; quote?: string };

/** One line a person understands, plus optional detail and a quoted message. */
export function describeNode(n: Node): NodeText {
  switch (n.type) {
    case "trigger": return n.schedule ? { title: `On a schedule: ${scheduleWords(n.schedule)}` } : { title: `${EVENT_LABELS[n.event] ?? humanWords(n.event)}${n.match ? ` — ${predicateWords(n.match)}` : ""}` };
    case "webhook": return { title: `Call ${n.method} ${n.url.replace(/^https?:\/\//, "").split("?")[0]}`, detail: `${n.body !== undefined ? "Sends a JSON body" : "No body"}${n.into ? `; the reply lands in ${n.into}` : ""}${n.on_error === "skip" ? "; a failure is noted and the run goes on" : "; a failure fails the run (and alerts)"}` };
    case "health_check": { const off = Object.entries(n.checks).filter(([, v]) => v === false).map(([k]) => k); return { title: "Run the health checks", detail: `${off.length ? `Every check except ${off.join(", ")}` : "Every check"}; failures become alerts${n.channel ? ` in ${pathWords(n.channel)}` : ""}` }; }
    case "availability_check": return { title: `Check bookable slots: fewer than ${n.min_slots} in the next ${n.days} day${n.days === 1 ? "" : "s"} is an alert`, detail: "Every active calendar; in a run about a booking, that booking's calendar" };
    case "report": return { title: `Build the ${/^\{\{/.test(n.kind) ? pathWords(n.kind.replace(/^\{\{\s*|\s*\}\}$/g, "")) : n.kind} wrap-up`, detail: `${n.breakdowns.length ? `Broken down by ${n.breakdowns.join(", ")}; ` : ""}into ${n.into}: body, period, numbers` };
    case "check": return { title: `Check ${predicateWords(n.when)}`, detail: `${n.retry ? `Waits up to ${durationWords(n.retry.for)} for it, looking every ${durationWords(n.retry.every)}. ` : ""}Otherwise the run ${exitWords(n.else_exit).replace(/^Stop: /, "stops: ").replace(/^Done: /, "ends: ").replace(/^Done$/, "ends")}` };
    case "branch": return { title: "Which way?" };
    case "wait": return { title: waitWords(n.rule), detail: `${n.rule.tz === "contact" ? "Contact's" : "Company's"} time zone${guardWords(n.rule)}` };
    case "wait_for_reply": return { title: `Wait for ${n.channel === "any" ? "a" : n.channel === "sms" ? "a text" : "an email"} reply`, detail: `Up to ${durationWords(n.timeout)}; continues the minute one arrives` };
    case "send_sms": return { title: n.kind === "transactional" ? "Send text (automated receipt, may go out in dark hours)" : "Send text", quote: templateWords(n.template), detail: n.validity?.min_lead ? `Only if at least ${durationWords(n.validity.min_lead)} before the call; otherwise ${n.on_stale === "skip" ? "skip it" : n.on_stale === "substitute" ? "send the fallback" : "pause for a human"}` : undefined };
    case "send_email": return { title: `Send email: “${templateWords(n.subject)}”`, quote: templateWords(n.template), detail: n.kind === "transactional" ? "Automated receipt: may go out in dark hours if the company allows it" : undefined };
    case "slack_post": { const bits = [n.react ? `reacts ${(Array.isArray(n.react) ? n.react : [n.react]).map((e) => `:${e}:`).join(" ")} on it` : "", n.offer ? `offers ${n.offer.map((e) => `:${e}:`).join(" ")} for a person to tap` : "", n.unreact ? `takes its own ${n.unreact.emojis.map((e) => `:${e}:`).join(" ")} off the post once decided` : ""].filter(Boolean);
      return { title: n.thread_of ? `Reply in the thread of that Slack post` : `Post to Slack (${pathWords(n.channel)})`, detail: bits.length ? bits.join("; ") : undefined, quote: templateWords(n.template) }; }
    case "send_document": return { title: `Send ${pathWords(n.template)} for signature`, detail: `${n.sender ? `From ${pathWords(n.sender)}; ` : ""}recorded in the agreements ledger; the poll reports when it is signed` };
    case "notify_owner": return { title: "Nudge the contact's owner", quote: templateWords(n.template), detail: `Slack DM when the owner is in Slack${n.fallback_channel ? `, else ${pathWords(n.fallback_channel)} with an @mention` : ""}${n.task ? `; CRM task “${templateWords(n.task.title)}” due in ${durationWords(n.task.due)}` : ""}` };
    case "classify": return { title: n.question ? `Jev: ${n.question.replace(/\?$/, "").replace(/^./, (c) => c.toLowerCase())}?` : "Jev reads the reply", detail: `Decides between ${Object.keys(n.criteria ?? {}).map((k) => humanWords(k)).join(", ") || `the ${humanWords(n.domain)} options`}; below ${Math.round(n.threshold * 100)}% sure, or a reply a careful person would doubt, goes to a person` };
    case "analyze": return { title: `AI ${n.format === "text" ? "writes" : "reads"} ${/^\{\{[^}]*\}\}$/.test(n.input.trim()) ? pathWords(n.input) : "from " + templateWords(n.input).split("\n")[0].replace(/:.*$/, "").toLowerCase() + " and more"} with ${pathWords(n.prompt)}`, detail: `Answer saved as ${Array.isArray(n.into) ? n.into.map(humanWords).join(" and ") : humanWords(n.into)}${n.format === "json" ? " (structured)" : ""}${n.optional ? "; skipped quietly when the AI cannot run" : ""}` };
    case "record_outcome": return { title: `Record the appointment as ${value(n.outcome)}`, detail: n.call_outcome ? `Call outcome ${value(n.call_outcome)}` : "On our record of the appointment; a show also fires “call held”" };
    // each quoted “+tag” / “−tag” becomes a chip under the word Tags on the chart
    case "tags": return { title: `Tags ${[...listOf(n.add).map((x) => `“+${x}”`), ...listOf(n.remove).map((x) => `“−${x}”`)].join(" ")}` };
    case "set_tag": { const t = Array.isArray(n.tag) ? n.tag : [n.tag]; return { title: `Add tag${t.length > 1 ? "s" : ""} ${t.map((x) => `“${x}”`).join(", ")}` }; }
    case "remove_tag": { const t = Array.isArray(n.tag) ? n.tag : [n.tag]; return { title: `Remove tag${t.length > 1 ? "s" : ""} ${t.map((x) => `“${x}”`).join(", ")}` }; }
    case "update_contact": {
      const bits = [n.set.assign_to ? `owner → ${pathWords(n.set.assign_to)}` : "", n.set.phone ? "phone" : "", n.set.timezone ? "time zone" : "", n.set.first_name || n.set.last_name ? "name" : "", ...n.fields.map((f) => `${pathWords(f.id)} = ${templateWords(f.value)}`), ...n.clear.map((id) => `clear ${pathWords(id)}`)].filter(Boolean);
      return { title: "Update the contact in the CRM", detail: bits.join("; ") || undefined };
    }
    case "note": return { title: "Leave an internal note", quote: templateWords(n.template) };
    case "update_appointment": return { title: `Mark appointment ${Object.entries(n.set).map(([k, v]) => `${humanWords(k)} → ${value(v)}`).join(", ")}` };
    case "update_opportunity": return { title: `Update opportunity: ${Object.entries(n.set).map(([k, v]) => `${humanWords(k)} → ${value(v)}`).join(", ")}` };
    case "pipeline_card": return {
      title: n.stage ? `${n.if_missing === "skip" ? "Move" : "Create or move"} pipeline card${n.name ? ` “${templateWords(n.name)}”` : ""}` : `Update the ${pathWords(n.pipeline)} card`,
      detail: `${n.stage ? `In the ${pathWords(n.pipeline)}, stage ${pathWords(n.stage)}` : "Card stays where it is"}${n.status ? `; marked ${n.status}` : ""}${n.assign_to ? `; owner → ${pathWords(n.assign_to)}` : ""}${n.fields.length ? `; set ${n.fields.map((f) => `${pathWords(f.id)} = ${templateWords(f.value)}`).join(", ")}` : ""}${n.if_missing === "skip" ? "; only if the card already exists" : ""}` };
    case "crm_record": return { title: `Write ${humanWords(n.object.replace(/^custom_objects\./, ""))} record`, detail: `Keyed by ${pathWords(n.key)}; ${Object.keys(n.properties).length} fields${n.relate.length ? `; linked to ${n.relate.length} related record${n.relate.length > 1 ? "s" : ""}` : ""}` };
    case "create_task": return { title: `Task for ${n.assign_to ? pathWords(n.assign_to) : "the team"}: “${templateWords(n.title)}”`, detail: `Due in ${durationWords(n.due)}`, quote: n.body ? templateWords(n.body) : undefined };
    case "set_var": { const w = (v: unknown) => typeof v === "string" ? templateWords(v) : JSON.stringify(v); return { title: `Remember ${humanWords(n.key)} = ${w(n.value)}`, detail: n.when ? `When ${predicateWords(n.when)}; otherwise ${w(n.else_value)}` : undefined }; }
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

/**
 * The definition without its plumbing: set_var nodes assemble a line of copy and mean nothing to a reader, so the chart and
 * the outline route around them (an edge into one continues to whatever it leads to). The engine still runs them.
 */
export function collapsePlumbing(def: Definition): Definition {
  const plumbing = new Set(def.nodes.filter((n) => n.type === "set_var").map((n) => n.id));
  if (!plumbing.size) return def;
  const next = (id: string): string => { let cur = id; const seen = new Set<string>(); while (plumbing.has(cur) && !seen.has(cur)) { seen.add(cur); const out = def.edges.find((e) => e.from === cur); if (!out) break; cur = out.to; } return cur; };
  const edges: Edge[] = [];
  for (const e of def.edges) { if (plumbing.has(e.from)) continue; const to = next(e.to); if (!edges.some((x) => x.from === e.from && x.to === to && x.label === e.label && JSON.stringify(x.when) === JSON.stringify(e.when) && x.else === e.else)) edges.push({ ...e, to }); }
  return { ...def, nodes: def.nodes.filter((n) => !plumbing.has(n.id)), edges };
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
