import { scheduleWords } from "./when";
import type { Definition, Edge, Node, Predicate, WaitRule } from "./definition";
import { fallbacksOf } from "./definition";
import { exprSpans } from "./template";

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
    case "tags": case "set_tag": case "remove_tag": case "note": case "update_appointment": case "update_opportunity": case "pipeline_card": case "update_contact": case "create_task": case "crm_record": case "record_outcome": case "ensure_contact": return "crm";
    case "check": case "branch": return "decision";
    case "wait": case "wait_for_reply": case "wait_for_reaction": case "wait_for_event": return "wait";
    case "classify": case "analyze": return "ai";
    case "set_var": case "start_workflow": case "pause_runs": case "record": case "resume": case "lookup": return "control";
    case "webhook": return "message";
    case "health_check": case "availability_check": case "report": case "eod_due": case "leaderboard": return "control";
    case "exit": return "exit";
  }
}

/** D110: event types nothing emits any more; their row stays only while old events point at it, and nothing offers them as a start. */
export const RETIRED_EVENTS: ReadonlySet<string> = new Set(["eod.call_filed"]);

export const EVENT_LABELS: Record<string, string> = {
  "lead.created": "A new lead is added in GHL", "appointment.reassign_requested": "Someone asked to hand a call to another closer", "appointment.reassigned": "A call was handed to another closer", "schedule": "On a schedule", "eod.filed": "A closer filed their end-of-day form", "eod.disagreement": "Someone filed a call the other way from what the AI heard", "alert.raised": "An alert is raised: something broke", "alert.repeated": "An alert is still open (said again every hour until it is fixed)", "alert.resolved": "An alert is fixed (cleared)", "drift.found": "The hourly check found GHL and the engine's records disagree", "drift.sales_call_cancelled": "A Sales Call in GHL needs marking cancelled (its booking was cancelled)", "drift.sales_call_unlinked": "A Sales Call in GHL needs linking to its contact or closer card", "slack.reaction": "A team member reacted in Slack", "intent.reviewed": "A team member said whether Jev read it right", "setter_call.result": "Jev read what a setter call achieved", "setter_call.filed": "A setter answered an outbound call on their end of day",
  "appointment.booked": "Appointment booked", "appointment.rescheduled": "Appointment rescheduled", "appointment.status_changed": "An appointment's status changed", "appointment.outcome": "The call's outcome is filed",
  "call.held": "The call happened", "message.received": "They replied (text or email)", "tag.added": "Tag added", "tag.removed": "Tag removed", "card.moved": "Someone moved a card by hand in GHL",
  "payment.received": "Payment received", "payment.failed": "Payment failed", "payment.refunded": "Payment refunded", "payment.paid_in_full": "They have paid in full",
  "recording.received": "Fathom recording received", "run.started": "Another workflow started for them", "run.exited": "Another workflow stopped early for them", "send.suppressed": "A message was held back", "recording.unlinked": "A recording matched nobody", "recording.linked": "A recording was matched to a contact", "call.analyzed": "AI finished reading a call", "call.logged": "A dialer call came in from GHL", "call.closing": "Jev read a dialer call as a closing call", "agreement.sent": "Agreement sent", "intent.unanswered": "Nobody answered the team's question in time", "intent.unanswered_no_show": "A no-show after an unanswered cancel or reschedule read", "payment.unlinked": "A payment matched nobody", "agreement.signed": "Agreement signed",
  "opportunity.opened": "A deal was opened", "opportunity.won": "A deal was won", "opportunity.lost": "A deal was lost", "form.submitted": "A form was submitted",
};
const PATHS: Record<string, string> = {
  "contact.phone": "phone number", "contact.is_lead": "they are a lead", "contact.email": "email address", "contact.first_name": "first name", "contact.last_name": "last name", "contact.name": "full name", "contact.tags": "tags", "contact.timezone": "time zone", "contact.fetched_at": "when the CRM was last read for them", "contact.stale": "why the engine's copy stood in",
  "appointment.term.category": "call type", "appointment.status": "appointment status", "appointment.starts_at": "call time", "appointment.closer.first_name": "closer's first name", "appointment.closer.name": "closer", "appointment.closer.ghl_user_id": "the closer", "appointment.self_booked": "self-booked", "appointment.set_by": "setter", "appointment.setter.name": "setter", "appointment.setter.ghl_user_id": "the setter", "appointment.triager.name": "who ran their triage call", "appointment.triager.ghl_user_id": "who ran their triage call", "appointment.reschedule_url": "reschedule link", "appointment.meeting_url": "meeting link", "appointment.tracking.utm_source": "UTM source", "appointment.cancelled_by": "who cancelled", "appointment.cancel_reason": "cancel reason",
  "event.amount": "amount", "event.kind": "payment kind", "event.running_total": "running total", "event.contract_value": "program price", "event.outstanding": "outstanding", "event.cleared": "paid in full", "event.provider_payment_id": "transaction id", "event.paid_at": "paid at",
  "contact.ghl_contact_id": "CRM contact", "vars.setter_line": "setter line", "vars.booking_kind": "booking kind", "crm.location_id": "location id",
  "event._type": "this", "event._source": "the source", "event.to_name": "the stage it went to", "event.from_name": "the stage it left", "event.pipeline": "which board", "event.mover": "who moved it", "event.status.to": "new status", "event.status.from": "previous status", "event.outcome": "outcome", "event.tag": "tag",
  "reply.intent": "the reply", "reaction.reaction": "the tap", "reaction.user_name": "who tapped", "reply.last_inbound.body": "their reply", "reply.last_outbound.body": "our last message", "reply.top_guesses": "top guesses",
  "opportunity.status": "opportunity status", "company.name": "company name", "calendar.closer_call.url": "booking link", "calendar.booking.url": "booking link", "now": "today",
  "recording.transcript_text": "the transcript", "recording.share_url": "recording link", "recording.title": "meeting title", "recording.started_at": "the call started", "recording.ended_at": "the call ended", "contact.latest_appointment_id": "their latest booking", "contact.has_upcoming_call": "a closing call is on their calendar", "contact.latest_recording_id": "their latest recorded call", "recording.id": "this recording", "recording.duration_min": "call length (minutes)", "recording.closer.name": "closer", "recording.closer.ghl_user_id": "the closer", "recording.recorded_by.name": "who recorded", "recording.summary": "the recorder's summary", "recording.invitee_names": "attendees", "recording.matched_by": "how the contact was matched", "recording.external_id": "recording id",
  "recording.duration_sec": "call length (seconds)", "recording.caller.name": "who dialed", "recording.caller.ghl_user_id": "who dialed", "recording.set_until": "the Set window closes (the company's minutes after hang-up)", "recording.has_transcript": "there is a transcript", "recording.kind": "kind of recording", "recording.connected": "the call connected", "recording.direction": "call direction", "recording.status": "call status", "recording.url": "the recording",
  "contact.paid": "they have paid", "contact.agreement_signed": "they have signed the agreement", "contact.agreement_sent": "an agreement was sent", "contact.owner.name": "the contact's owner", "contact.owner.ghl_user_id": "the contact's owner", "contact.payments_count": "number of payments", "contact.cash_collected": "cash collected", "event.prior_total": "what they had paid before this", "agreement.signed_at": "when they signed", "agreement.name": "the agreement", "records.sales_call.key": "their Sales Call record", "crm.agreement_template": "the agreement template", "crm.agreement_sender": "who the agreement is from",
  "vars.min_seconds": "minimum call length (seconds)", "vars.classify.call_type": "the call type", "vars.classify.kind": "the recording", "vars.outcome.disposition": "how the call ended", "vars.classify.is_sales_call": "the AI called it a sales call", "vars.notes.digest": "the AI digest", "vars.notes.fit_quality": "fit score", "vars.booked_flag": "led-to-booking flag", "vars.outcome_line": "outcome line",
  "contact.closer.name": "the closer", "contact.closer.mention": "the closer (@mentioned)", "contact.closer.first_name": "the closer's first name", "contact.setter.name": "the setter", "contact.setter.mention": "the setter (@mentioned)", "contact.first_booked_at": "their first booking", "contact.days_to_close": "days from first booking to first payment", "contact.revenue": "the deal value", "contact.source": "lead source", "vars.cheer": "the AI's congratulations", "vars.notes.disposition": "the call's outcome", "vars.notes.pain": "their pains", "vars.notes.desire": "their goals", "vars.notes.objections": "their objections", "vars.notes.next_step": "the next step", "vars.rubric.overall_score": "the call score",
  "user.name": "the closer", "user.first_name": "the closer's first name", "user.mention": "the closer (@mention)", "user.slack_user_id": "the closer's Slack DM", "user.report_url": "their end-of-day link", "user.eod.all_lines": "their unfiled days, one line each with a link", "user.eod.earlier_lines": "earlier unfiled days with links", "user.eod.today.line": "today's link and call count", "user.eod.today.calls": "calls on their calendar today", "user.eod.today.filed": "today is filed", "user.eod.earlier_count": "earlier days still unfiled", "vars.lines": "the lines to send", "vars.report.body": "the wrap-up text", "vars.kind": "which wrap-up",
  "event.totals_line": "the day in one line", "event.corrections": "what was corrected", "event.corrected": "anything corrected", "event.corrections_count": "corrections", "event.day_label": "the day", "event.day_answers_lines": "their answers to the day questions", "event.calls": "each call", "event.user_id": "who filed", "event.refiled": "filed again",
  "setting.setter_result.set_within_min": "the Set window (minutes after hang-up)", "setting.calls.conversation_gap_min": "the gap between parts of one call (minutes)", "setting.calls.transcript_wait_min": "how long a transcript is waited for (minutes)",
  "vars.convo.transcript_text": "the whole conversation's transcript", "vars.convo.total_sec": "the whole conversation's length (seconds)", "vars.convo.total_min": "the whole conversation's length (minutes)", "vars.convo.count": "the parts of the call", "vars.convo.key": "the conversation", "vars.convo.first.started_at": "the call started", "vars.convo.first.id": "the call", "vars.convo_now.later_ready": "later parts already in", "vars.due.count": "days still to file", "vars.decided": "what the team decided", "vars.agreed": "whether the team agreed with Jev", "vars.card": "the Slack card's look", "vars.pay": "the payment's words", "vars.jev_read": "Jev's read, in words", "vars.jev_confidence": "how sure Jev was", "vars.jev_guesses": "Jev's guesses", "vars.card_suffix": "the card's name ending", "vars.call_type": "the call type", "vars.appt_line": "the booking line", "vars.nudge": "which nudge this is", "vars.mark": "the alert's mark", "vars.head": "the alert's headline", "vars.body": "the alert's text", "vars.icon": "the alert's face", "vars.drift_head": "how the drift questions start", "vars.drift_were": "the drift line's verb (it's or they've)", "event.as_icon": "the company's own alert face", "event.text": "the alert's text",
  "vars.booked.matched": "a booking came through a setter link", "vars.booked.appointment.booking_source": "how it was booked", "vars.booked.appointment.booked_at": "when it was booked", "vars.late.appointment.booking_source": "how it was booked", "vars.late.appointment.booked_at": "when it was booked",
  "vars.closing_booking.count": "bookings that line up", "vars.closing_booking.first.id": "the booking that lines up", "vars.booking_id": "the booking it lines up with", "vars.chosen": "the booking the team picked", "vars.parts_line": "the parts", "vars.unsure_line": "why the team is asked", "vars.booked_when": "when it was booked",
  "setting.setter_result.act": "setter-call actions are on", "vars.classify.result": "Jev's read of the result", "vars.classify.dq_reason": "Jev's DQ reason",
  "vars.result": "the result", "vars.decided_by": "who decided the result", "vars.asking": "Jev was unsure", "vars.jev_agreed": "Jev agreed", "vars.result_key": "the result's option", "vars.result_words": "the result", "vars.act_line": "what the actions do", "vars.dq_tag": "the DQ tag", "vars.task_due": "the next business day",
  "appointment.id": "an appointment", "appointment.external_id": "appointment id", "appointment.outcome": "appointment outcome", "appointment.call_outcome": "how the call went", "event.appointment_matched": "a matching appointment",
  "event.slot.from": "slot the call moved from", "event.previous_outcome": "the earlier answer", "event.previous_call_outcome": "the earlier call outcome", "appointment.pending_read.intent": "their unanswered reply",
  "company.operator_slack_id": "Slack id for the operator", "vars.due.overdue_count": "the number of calls blank for two days", "vars.__listen": "tap still listened for", "vars.call_key": "key for the Sales Call record", "appointment.slot_key": "this booking", "event.record_id": "the record the form names", "event.slot.to": "slot the call moved to",
  "event.channel": "Slack channel for the alert", "event.thread": "detail for its thread",
};
const VALUES: Record<string, string> = { sales_call: "a sales call", closed_won: "closed won", close_pending: "close pending", financing_denied: "financing denied", dq: "disqualified", unqualified: "disqualified", disposition: "a closer's form", "appointment.rescheduled": "a reschedule", "appointment.booked": "a new booking", "recording.received": "a Fathom recording", "payment.received": "a payment", "payment.refunded": "a refund", refund: "a refund", "call.closing": "a closing call Jev read", on_call: "rescheduled or cancelled on the call", human: "the team", noshow: "no-show", reschedule_request: "a reschedule request", follow_up: "follow up", first_call: "first call", closing: "closing call", setting: "a setting call", confirmation: "a confirmation call", phone: "a phone call", meeting: "a meeting" };

export const humanWords = (s: string) => s.replace(/^crm\./, "").replace(/[_.-]+/g, " ").replace(/\s+/g, " ").trim();
const listOf = (v?: string | string[]): string[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
const value = (v: unknown) => typeof v === "string" ? (v === "" ? "blank" : /^\{\{/.test(v) ? thing(pathWords(v)) : VALUES[v] ?? `“${humanWords(v)}”`) : JSON.stringify(v);   // a {{path}} on the right is a thing, not a literal
const thing = (w: string) => /^(the|a|an|their|how|who|what|when|why|which) /i.test(w) ? w : `the ${w}`;
/** The `{{…}}` paths inside a string that holds more than one ("{{a}}:{{b}}"), else null. */
const partsOf = (v: unknown): string[] | null => { if (typeof v !== "string") return null; const ps = [...v.matchAll(/\{\{\s*([a-zA-Z0-9_.]+)[^}]*\}\}/g)].map((m) => m[1]); return ps.length > 1 ? ps : null; };
/** `{{a.b}}` or a bare path → the words a person uses for it. */
export function pathWords(p: unknown): string {
  if (typeof p !== "string") return String(p);
  const m = /^\{\{\s*([a-zA-Z0-9_.]+)(?:\s*\|[^}]*)?\s*\}\}$/.exec(p); const path = m ? m[1] : p;
  if (PATHS[path]) return PATHS[path];
  const crm = /^crm\.(stage|pipeline|field_contact|field_opportunity|object)_([a-z0-9_]+)$/.exec(path);
  if (crm) return crm[1] === "stage" ? stageWords(path) : crm[1] === "pipeline" ? `${humanWords(crm[2])} board` : humanWords(crm[2]);
  if (path.startsWith("slack.channel.")) return `the ${humanWords(path.slice("slack.channel.".length))} channel`;
  if (path.startsWith("picklist.")) { const v = path.split(".").at(-1)!; return VALUES[v]?.replace(/^an? /, "") ?? humanWords(v); }
  if (path.startsWith("crm.")) return humanWords(path);
  if (path.startsWith("event.")) return humanWords(path.slice(6));
  const item = /^vars\.([a-z0-9_]+?)s?\.items\.(\d+)\./.exec(path); if (item) return `${humanWords(item[1])} ${+item[2] + 1}`;
  if (path.startsWith("vars.")) return humanWords(path.slice(5));
  if (path.startsWith("data.")) return `the event's ${PATHS[`appointment.${path.slice(5)}`] ?? humanWords(path.slice(5))}`;   // what a wait_for_event match reads (D85)
  if (path.startsWith("contact.fields.")) return humanWords(path.slice("contact.fields.".length));
  if (path.startsWith("cards.")) return `the ${humanWords(path.split(".")[1])} card${path.split(".").length > 2 ? ` ${humanWords(path.split(".").slice(2).join(" "))}` : ""}`;
  if (path.startsWith("record.")) return `the record ${humanWords(path.slice(7))}`;
  if (path.startsWith("prompt.")) return `the “${humanWords(path.slice(7))}” prompt`;
  if (path.startsWith("recording.")) return humanWords(path.slice(10));
  if (path.startsWith("appointment.answers.")) return `their answer to ${humanWords(path.slice("appointment.answers.".length))}`;
  return humanWords(path.split(".").slice(-2).join(" "));
}
const titleCase = (t: string) => t.replace(/\b\w/g, (c) => c.toUpperCase());
/** A stage from its binding key, as the board names it: `crm.stage_closer_no_show` → "No Show" (the board's own name is in the key, D61). */
export function stageWords(p: string): string {
  const m = /crm\.stage_(?:(setter|closer)_)?([a-z0-9_]+)/.exec(p); return m ? titleCase(humanWords(m[2])).replace(/\bDq\b/g, "DQ") : pathWords(p);
}
/** What an `exists` asks for: a stage binding is the board's stage ("Deposit stage on the closer board", D119), anything else its words. */
const existsWords = (path: string) => { const m = /^crm\.stage_(setter|closer)_[a-z0-9_]+$/.exec(path); return m ? `${stageWords(path)} stage on the ${m[1]} board` : pathWords(path).replace(/^(a|an|the) /, ""); };
/** A card's board from its pipeline binding: `{{crm.pipeline_closer}}` → "closer". */
export const boardWords = (p: string) => /crm\.pipeline_([a-z0-9_]+)/.exec(p)?.[1].replace(/_/g, " ") ?? pathWords(p).replace(/ board$/, "");
/** Message templates keep their text; bindings inside become their plain name so the chart does not show `{{calendar.closer_call.url}}`. */
export const templateWords = (t: string) => {
  const s = t.replace(/<[^>]+>/g, " "); let out = "", at = 0;
  // an `each` is one bracket for the list it walks, not its inner {{item.*}} (D85)
  for (const x of exprSpans(s)) { const p = x.expr.split("|")[0].trim(); out += s.slice(at, x.start) + (/^[a-zA-Z0-9_.]+$/.test(p) ? `[${pathWords(p)}${/\|\s*each\b/.test(x.expr) ? ", one line each" : ""}]` : s.slice(x.start, x.end)); at = x.end; }
  return (out + s.slice(at)).replace(/\s+/g, " ").trim();
};

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
  // an hour of the day, read through `| date:HH`: "the call is at 9 AM or later"
  const hour = (path: unknown, cmp: "gt" | "gte" | "lt" | "lte", raw: unknown): string | null => {
    const v = lit(raw); if (typeof path !== "string" || !/\|\s*date:HH\s*\}\}$/.test(path) || !/^\d{1,2}$/.test(String(v))) return null;
    const h = +String(v) + (cmp === "gt" || cmp === "lte" ? 1 : 0); const at = `${h % 12 || 12} ${h % 24 < 12 ? "AM" : "PM"}`;
    const subject = /^\{\{\s*appointment\.starts_at\b/.test(path) ? "the call" : thing(pathWords(path.replace(/\s*\|[^}]*/, "")));
    return cmp === "gt" || cmp === "gte" ? `${subject} is at ${at} or later` : `${subject} is before ${at}`;
  };
  // two strings of several paths each ("{{a}}:{{b}}" against "{{c}}:{{d}}"), compared pair by pair
  const pairs = (l: unknown, r: unknown, same: boolean): string | null => {
    const a = partsOf(l), b = partsOf(r); if (!a || !b || a.length !== b.length) return null;
    const each = a.map((x, i) => `${thing(pathWords(x))} is ${same ? "" : "not "}${thing(pathWords(b[i]))}`);
    return same ? each.join(" and ") : `${each.length === 2 ? "either " : ""}${each.slice(0, -1).join(", ")} or ${each.at(-1)}`;
  };
  if ("exists" in p) { const t = existsWords(p.exists); return `there is ${/^[aeiou]/i.test(t) ? "an" : "a"} ${t}`; }
  if ("eq" in p && pairs(p.eq[0], p.eq[1], true)) return pairs(p.eq[0], p.eq[1], true)!;
  if ("neq" in p && pairs(p.neq[0], p.neq[1], false)) return pairs(p.neq[0], p.neq[1], false)!;
  for (const c of ["gt", "gte", "lt", "lte"] as const) if (c in p) { const [l, r] = (p as Record<string, [unknown, unknown]>)[c]; const h = hour(l, c, r); if (h) return h; }
  // a count against nothing: "there are no later parts already in"; only for a count named as a plain plural
  const none = (path: unknown) => { const t = pathWords(path); return /^(the|a|an|their|how|who|what) /i.test(t) ? null : t; };
  if ("eq" in p && lit(p.eq[1]) === 0 && none(p.eq[0])) return `there are no ${none(p.eq[0])}`;
  if ("gt" in p && lit(p.gt[1]) === 0 && none(p.gt[0])) return `there are ${none(p.gt[0])}`;
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
/** The words for a predicate not holding: "this is not a reschedule" → "this is a reschedule". */
export function notWords(p: Predicate, consts: Record<string, unknown> = {}): string {
  const w = (q: Predicate) => predicateWords(q, consts), n = (q: Predicate) => notWords(q, consts);
  if ("exists" in p) return `there is no ${existsWords(p.exists)}`;
  if ("eq" in p) return w({ neq: p.eq }); if ("neq" in p) return w({ eq: p.neq });
  if ("gt" in p) return w({ lte: p.gt }); if ("gte" in p) return w({ lt: p.gte }); if ("lt" in p) return w({ gte: p.lt }); if ("lte" in p) return w({ gt: p.lte });
  if ("in" in p) { const vs = p.in[1].map((x) => value(consts[String(x).replace(/^\{\{\s*|\s*\}\}$/g, "")] ?? x)); return `${pathWords(p.in[0])} is ${vs.length === 1 ? `not ${vs[0]}` : vs.length === 2 ? `neither ${vs[0]} nor ${vs[1]}` : `none of ${vs.slice(0, -1).join(", ")} or ${vs.at(-1)}`}`; }
  if ("has" in p) return w({ not: p });
  if ("not" in p) return w(p.not);
  if ("and" in p) return p.and.map(n).join(" or "); if ("or" in p) return p.or.map(n).join(" and ");
  return `not (${w(p)})`;
}
/**
 * Why a step with `only_if` was skipped: the condition, then what held instead. With `holds`, an "and" names only the
 * parts that failed ("only if setter-call actions are on and the result is follow up; the result is not follow up").
 */
export function skippedWords(p: Predicate, holds?: (q: Predicate) => boolean): string {
  const failed = "and" in p && holds ? p.and.filter((q) => !holds(q)) : null;
  return `only if ${predicateWords(p)}; ${failed?.length ? failed.map((q) => notWords(q)).join(" and ") : notWords(p)}`;
}
/** A condition short enough for the node on the chart: "a reschedule", "not a reschedule". */
export const onlyIfWords = (p: Predicate, consts: Record<string, unknown> = {}) => predicateWords(p, consts).replace(/^this is not /, "not ").replace(/^this is /, "");
/** The literals a workflow's unconditional set_var steps hold, keyed vars.<key>: the numbers its gates compare against. */
export const constsOf = (def: { nodes: Node[] }): Record<string, unknown> => Object.fromEntries(def.nodes.filter((n): n is Extract<Node, { type: "set_var" }> => n.type === "set_var" && !n.when && !n.pick).map((n) => [`vars.${n.key}`, n.value]));

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
  if (anchor && /^[-+]?0+\s*[smhdw]$/.test(rule.offset)) return `Wait until ${anchor}${win}`;
  return (anchor ? `Wait until ${durationWords(rule.offset.replace(/^[-+]/, ""))} ${rule.offset.startsWith("-") ? "before" : "after"} ${anchor}` : `Wait ${durationWords(rule.offset.replace(/^[-+]/, ""))}`) + win;
}
const guardWords = (rule: WaitRule) => rule.guard ? ` (if that is less than ${durationWords(rule.guard.min_lead)} away, use ${waitWords({ ...rule, offset: rule.guard.fallback, guard: undefined }).replace(/^Wait until /, "")} instead)` : "";

export const exitWords = (reason: string) => ({ done: "Done", not_a_sales_call: "Stop: not a sales call", recorded_no_appointment: "Done: recorded, no appointment matched", booked: "Done: booking recorded", cancelled_recorded: "Done: cancellation recorded", recorded: "Done: recorded", sent: "Done: sent", replied: "Done: they replied", no_reply: "Done: no reply", no_phone: "Stop: no phone number", confirmed: "Done: confirmed", cancelled: "Done: cancelled", reschedule_sent: "Done: reschedule link sent", handed_to_human: "Stop: handed to a human", escalated: "Done: escalated to the owner", sequence_done: "Done: sequence finished", rebooked: "Done: they booked a new call" } as Record<string, string>)[reason] ?? `Stop: ${humanWords(reason)}`;

export type NodeText = { title: string; detail?: string; quote?: string };

/** One line a person understands, plus optional detail and a quoted message. */
export function describeNode(n: Node): NodeText {
  switch (n.type) {
    case "trigger": return n.schedule ? { title: `On a schedule: ${scheduleWords(n.schedule)}` } : { title: `${EVENT_LABELS[n.event] ?? humanWords(n.event)}${n.match ? ` — ${predicateWords(n.match)}` : ""}` };
    case "webhook": return { title: `Call ${n.method} ${n.url.replace(/^https?:\/\//, "").split("?")[0]}`, detail: `${n.body !== undefined ? "Sends a JSON body" : "No body"}${n.into ? `; the reply lands in ${n.into}` : ""}${n.on_error === "skip" ? "; a failure is noted and the run goes on" : "; a failure fails the run (and alerts)"}` };
    case "health_check": { const off = Object.entries(n.checks).filter(([, v]) => v === false).map(([k]) => k); return { title: "Run the health checks", detail: `${off.length ? `Every check except ${off.join(", ")}` : "Every check"}; failures become alerts${n.channel ? ` in ${pathWords(n.channel)}` : ""}` }; }
    case "availability_check": return { title: `Check bookable slots: fewer than ${n.min_slots} in the next ${n.days} day${n.days === 1 ? "" : "s"} is an alert`, detail: "Every active calendar; in a run about a booking, that booking's calendar" };
    case "eod_due": return { title: `What the closer still has to file (${n.period === "evening" ? "today and earlier" : "earlier days"})`, detail: "Days with calls and no end-of-day report, and days whose Sales Calls in GHL still have no outcome; blank for two days or more, the operator is told too" };
    case "report": return { title: `Build the ${/^\{\{/.test(n.kind) ? pathWords(n.kind.replace(/^\{\{\s*|\s*\}\}$/g, "")) : n.kind} wrap-up`, detail: `${n.breakdowns.length ? `Broken down by ${n.breakdowns.join(", ")}; ` : ""}into ${n.into}: body, period, numbers` };
    case "leaderboard": return { title: `Build the leaderboard for ${/^\{\{/.test(n.period) ? pathWords(n.period.replace(/^\{\{\s*|\s*\}\}$/g, "")) : n.period}`, detail: `Closers by cash collected (closes and close rate beside), setters by sets (the show rate of their sets beside); into ${n.into}: body, closers, setters, period` };
    case "check": return { title: `Check ${predicateWords(n.when)}`, detail: `${n.retry ? `Waits up to ${durationWords(n.retry.for)} for it, looking every ${durationWords(n.retry.every)}. ` : ""}Otherwise the run ${n.else_pause ? `pauses for a person: ${n.else_pause}` : exitWords(n.else_exit).replace(/^Stop: /, "stops: ").replace(/^Done: /, "ends: ").replace(/^Done$/, "ends")}` };
    case "branch": return { title: "Which way?" };
    case "wait": return { title: waitWords(n.rule), detail: `${n.rule.tz === "contact" ? "Contact's" : "Company's"} time zone${guardWords(n.rule)}` };
    case "wait_for_reply": return { title: `Wait for ${n.channel === "any" ? "a" : n.channel === "sms" ? "a text" : "an email"} reply`, detail: `Up to ${durationWords(n.timeout)}; continues the minute one arrives` };
    case "wait_for_reaction": return n.blocking
      ? { title: `Wait for a reaction on ${n.of.startsWith("tag:") ? "that Slack post" : "the post before"}: ${n.emojis.map((e) => `:${e}:`).join(" ")}`, detail: `${n.timeout ? `Up to ${durationWords(n.timeout)}; ` : ""}continues the minute a team member taps one of them on that very message; any other reaction, or a tap on another post, changes nothing${n.timeout ? "; silence continues with no decision" : ""}` }
      : { title: `Listen for a reaction on ${n.of.startsWith("tag:") ? "that Slack post" : "the post before"}: ${n.emojis.map((e) => `:${e}:`).join(" ")}`, detail: `The run goes on at once; a tap on that very message, whenever it comes, pulls the run to the tap path and \"go back\" returns it to where it was${n.until ? `; nobody by ${waitWords(n.until).replace(/^Wait until /, "").replace(/^Wait /, "")} and it takes the no-answer path` : ""}` };
    case "wait_for_event": return { title: `Wait for ${eventWords(n.event)}${n.until ? `, ${untilWords(n.until)}` : ""}`,
      detail: [`About ${n.about === "appointment" ? "this booking" : "this person"}${n.match ? `, when ${predicateWords(n.match)}` : ""}; moves on the moment one arrives`, n.since ? `one already there from ${templateWords(n.since)} counts at once` : "only one after this step begins counts", n.until ? `nothing by then and it takes the no-event path${n.respect_send_window ? " (the deadline waits for the send window)" : ""}` : "without a deadline it waits for the event alone"].join("; ") };
    case "lookup": {
      const what = { appointments_for_contact: "their bookings", calls_for_contact: "their recorded calls", call_conversation: "the whole conversation this call is part of (the same caller's calls to them, each starting within the gap of the last one ending)", last_event: `the last ${n.params.type ? n.params.type.split(",").map((t) => eventWords(t.trim())).join(" or ") : "event"}` }[n.query];
      const filters = Object.entries(n.params).filter(([k]) => n.query !== "last_event" || k !== "type").map(([k, v]) => `${humanWords(k)} ${/\{\{/.test(v) ? templateWords(v) : humanWords(v)}`);
      return { title: `Look up ${what}`, detail: `${filters.length ? `${filters.join("; ")}; ` : ""}saved as ${humanWords(n.into)} for the steps after it (the engine's own question, read-only)` };
    }
    case "resume": return { title: "Go back to where the run was", detail: "The step the listener pulled the run away from, with its own due time; nothing to go back to, and the run simply goes on" };
    case "send_sms": return { title: n.kind === "transactional" ? "Send text (automated receipt, may go out in dark hours)" : "Send text", quote: templateWords(n.template), detail: n.validity?.min_lead ? `Only if at least ${durationWords(n.validity.min_lead)} before the call; otherwise ${n.on_stale === "skip" ? "skip it" : n.on_stale === "substitute" ? "send the fallback" : "pause for a human"}` : undefined };
    case "send_email": return { title: `Send email: “${templateWords(n.subject)}”`, quote: templateWords(n.template), detail: n.kind === "transactional" ? "Automated receipt: may go out in dark hours if the company allows it" : undefined };
    case "slack_post": { const bits = [n.react ? `reacts ${(Array.isArray(n.react) ? n.react : [n.react]).map((e) => (/\{\{/.test(e) ? pathWords(e) : `:${e}:`)).join(" ")} on it` : "", n.offer ? `offers ${n.offer.map((e) => `:${e}:`).join(" ")} for a person to tap` : "", n.buttons?.length ? `with the button${n.buttons.length > 1 ? "s" : ""} ${n.buttons.map((b) => `“${b.text}”${b.only_if ? ` (only if ${predicateWords(b.only_if)})` : ""}`).join(", ")}` : "", n.unreact ? (n.unreact.emojis.some((e) => /\{\{/.test(e)) ? "takes back the reaction an earlier answer left on the post" : `takes its own ${n.unreact.emojis.map((e) => `:${e}:`).join(" ")} off the post once decided`) : "", n.react_on ? `reacts ${n.react_on.emojis.map((e) => (/\{\{/.test(e) ? pathWords(e) : `:${e}:`)).join(" ")} on ${n.react_on.of.startsWith("tag:") ? `the post remembered as ${templateWords(n.react_on.of.slice(4))}` : "an earlier post"}` : ""].filter(Boolean);
      return { title: n.thread_of ? `Reply in the thread of that Slack post` : `Post to Slack (${pathWords(n.channel)}${fallbacksOf(n.fallback_channel).map((f) => `, else ${pathWords(f)}`).join("")})`, detail: bits.length ? bits.join("; ") : undefined, quote: templateWords(n.template) }; }
    case "send_document": return { title: `Send ${pathWords(n.template)} for signature`, detail: `${n.sender ? `From ${pathWords(n.sender)}; ` : ""}recorded in the agreements ledger; the poll reports when it is signed` };
    case "notify_owner": return { title: "Nudge the contact's owner", quote: templateWords(n.template), detail: `Slack DM when the owner is in Slack${n.fallback_channel ? `, else ${pathWords(n.fallback_channel)} with an @mention` : ""}${n.task ? `; CRM task “${templateWords(n.task.title)}” due in ${durationWords(n.task.due)}` : ""}` };
    case "classify": return { title: n.question ? `Jev: ${n.question.replace(/\?$/, "").replace(/^./, (c) => c.toLowerCase())}?` : "Jev reads the reply", detail: `Decides between ${Object.keys(n.criteria ?? {}).map((k) => humanWords(k)).join(", ") || `the ${humanWords(n.domain)} options`}; below ${Math.round(n.threshold * 100)}% sure, or a reply a careful person would doubt, goes to a person` };
    case "analyze": return { title: `AI ${n.format === "text" ? "writes" : "reads"} ${/^\{\{[^}]*\}\}$/.test(n.input.trim()) ? pathWords(n.input) : "from " + templateWords(n.input).split("\n")[0].replace(/:.*$/, "").toLowerCase() + " and more"} with ${pathWords(n.prompt)}`, detail: `Answer saved as ${Array.isArray(n.into) ? n.into.map(humanWords).join(" and ") : humanWords(n.into)}${n.format === "json" ? " (structured)" : ""}${n.optional ? "; skipped quietly when the AI cannot run" : ""}` };
    case "record_outcome": return { title: `Record the appointment as ${value(n.outcome)}`, detail: n.call_outcome ? `Call outcome ${value(n.call_outcome)}` : "On our record of the appointment; a show also fires “call held”" };
    // each quoted “+tag” / “−tag” becomes a chip under the word Tags on the chart
    case "tags": { const word = (x: string) => (/^\s*\{\{/.test(x) ? templateWords(x) : x); return { title: `Tags ${[...listOf(n.add).map((x) => `“+${word(x)}”`), ...listOf(n.remove).map((x) => `“−${word(x)}”`)].join(" ")}`, ...(n.keep ? { detail: `Never takes off ${listOf(n.keep).map(word).join(", ")}` } : {}) }; }
    case "set_tag": { const t = Array.isArray(n.tag) ? n.tag : [n.tag]; return { title: `Add tag${t.length > 1 ? "s" : ""} ${t.map((x) => `“${x}”`).join(", ")}` }; }
    case "remove_tag": { const t = Array.isArray(n.tag) ? n.tag : [n.tag]; return { title: `Remove tag${t.length > 1 ? "s" : ""} ${t.map((x) => `“${x}”`).join(", ")}` }; }
    case "update_contact": {
      const bits = [n.set.assign_to ? `owner → ${pathWords(n.set.assign_to)}` : "", n.set.phone ? "phone" : "", n.set.timezone ? "time zone" : "", n.set.first_name || n.set.last_name ? "name" : "", ...n.fields.map((f) => `${pathWords(f.id)} = ${templateWords(f.value)}${f.if_empty ? " (only if empty)" : ""}`), ...n.clear.map((id) => `clear ${pathWords(id)}`), ...n.followers.map((f) => `follower + ${pathWords(f)}`)].filter(Boolean);
      return { title: "Update the contact in the CRM", detail: bits.join("; ") || undefined };
    }
    case "note": return { title: "Leave an internal note", quote: templateWords(n.template) };
    case "update_appointment": if ("closer" in n.set) return { title: `Hand the call to ${value(n.set.closer)}`, detail: "Who has the call in the engine: their end of day, their name in the reminders, kept through reschedules (D254)" };
      return "pending_read" in n.set && Object.keys(n.set).length === 1
      ? { title: n.set.pending_read === null ? "Clear the pending read on the appointment" : "Note Jev's pending read on the appointment", detail: n.set.pending_read === null ? "A person decided; the appointment no longer carries an open question" : "What Jev read, how sure it was and when, kept until a person decides; a no-show after it is a possible cancel" }
      : { title: `Mark appointment ${Object.entries(n.set).filter(([k]) => k !== "pending_read").map(([k, v]) => `${humanWords(k)} → ${value(v)}`).join(", ")}` };
    case "update_opportunity": {
      const st = n.status ?? (typeof n.set.status === "string" ? n.set.status : undefined), rest = Object.entries(n.set).filter(([k]) => k !== "status").map(([k, v]) => `${humanWords(k)} → ${value(v)}`);
      const w = (t: string) => (/\{\{/.test(t) ? templateWords(t) : t);
      return { title: st ? `Mark the opportunity ${w(st)}` : `Update opportunity: ${rest.join(", ")}`,
        detail: [st && n.lost_reason ? `lost reason ${w(n.lost_reason)}` : "", st && rest.length ? `also ${rest.join(", ")}` : "", n.card ? `the ${boardWords(n.card.pipeline)} card marked the same way${n.card.stage ? `, moved to ${pathWords(n.card.stage)}` : ""}` : "", st ? "a change to won or lost is recorded as Deal won or Opportunity lost and starts the workflows that listen for it" : ""].filter(Boolean).join("; ") || undefined };
    }
    case "pipeline_card": return {
      title: n.stage ? `${n.if_missing === "skip" ? "Move" : "Create or move"} pipeline card${n.name && !n.keep_name ? ` “${templateWords(n.name)}”` : ""}` : `Update the ${boardWords(n.pipeline)} card`,
      detail: `${n.stage ? `In the ${pathWords(n.pipeline)}, stage ${pathWords(n.stage)}` : "Card stays where it is"}${n.status ? `; marked ${n.status}` : ""}${n.assign_to ? `; owner → ${pathWords(n.assign_to)}` : ""}${n.followers.length ? `; followed by ${n.followers.map((f) => pathWords(f)).join(", ")}` : ""}${n.value ? `; value ${templateWords(n.value)}` : ""}${n.fields.length ? `; set ${n.fields.map((f) => `${pathWords(f.id)} = ${templateWords(f.value)}`).join(", ")}` : ""}${n.from_stages?.length ? `; only a card on ${n.from_stages.map((x) => pathWords(x)).join(", ")} moves (a card on any other stage is left where it is)` : ""}${n.keep_name ? `; an existing card keeps its name${n.name ? `, a new one is named “${templateWords(n.name)}”` : ""}` : ""}${n.if_missing === "skip" ? "; only if the card already exists" : ""}` };
    case "crm_record": return { title: `${n.if_missing !== "create" || n.record_id ? "Update" : "Write"} ${humanWords((/^\{\{\s*crm\.object_([a-z0-9_]+)/.exec(n.object)?.[1] ?? n.object).replace(/^custom_objects\./, ""))} record`, detail: `${n.record_id ? `The CRM's own record ${/\{\{/.test(n.record_id) ? templateWords(n.record_id) : n.record_id}, made outside the engine; never creates one` : `Keyed by ${pathWords(n.key)}`}; ${Object.keys(n.properties).length} fields${n.relate.length ? `; linked to ${n.relate.length} related record${n.relate.length > 1 ? "s" : ""}` : ""}${n.clear.length ? `; empties ${n.clear.map((k) => (/\{\{/.test(k) ? pathWords(k) : humanWords(k))).join(", ")} unless this answer sets them` : ""}${n.record_id ? "" : n.if_missing === "skip" ? "; only if the record already exists" : n.if_missing === "match" ? "; only a record that exists, found by the booking when the engine did not write it" : ""}` };
    case "ensure_contact": return { title: "Make sure the person is in the CRM", detail: `Found by their CRM id, email or phone, else created${n.tags || n.scope_tag ? `; tagged ${[...listOf(n.tags).map((t) => `“${t}”`), ...(n.scope_tag ? ["with the company's scope tag"] : [])].join(", ")}` : ""}; fields the CRM has blank are filled, nothing it holds is overwritten` };
    case "create_task": return { title: `Task for ${n.assign_to ? pathWords(n.assign_to) : "the team"}: “${templateWords(n.title)}”`, detail: /\{\{/.test(n.due) ? `Due ${templateWords(n.due)}` : `Due in ${durationWords(n.due)}`, quote: n.body ? templateWords(n.body) : undefined };
    case "set_var": { const w = (v: unknown): string => typeof v === "string" ? templateWords(v) : Array.isArray(v) ? v.map(w).join(", ") : v && typeof v === "object" ? Object.entries(v).map(([k, x]) => `${humanWords(k)} ${w(x) || "blank"}`).join("; ") : JSON.stringify(v);
      if (n.pick) return { title: `Remember ${humanWords(n.key)}, picked by ${w(n.value)}`, detail: `${Object.entries(n.pick).map(([k, v]) => `${humanWords(k)} → ${w(v)}`).join("; ")}${n.else_value !== undefined ? `; otherwise ${w(n.else_value)}` : ""}` };
      return { title: `Remember ${humanWords(n.key)} = ${w(n.value)}`, detail: n.when ? `When ${predicateWords(n.when)}; otherwise ${w(n.else_value)}` : undefined }; }
    case "record": return { title: `Record: ${EVENT_LABELS[n.event] ?? humanWords(n.event)}`, detail: `An event in the ledger${Object.keys(n.data).length ? ` with ${Object.keys(n.data).map((k) => humanWords(k)).join(", ")}` : ""}${n.appointment ? `, about ${templateWords(n.appointment)}` : ""}; ${n.start ? "it starts the workflows that listen for it (once)" : "nothing leaves the engine"}` };
    case "start_workflow": return { title: `Hand off to “${humanWords(n.workflow)}”` };
    case "pause_runs": return { title: `Pause the ${n.scope === "contact" ? "contact's" : "appointment's"} other workflows` };
    case "exit": return { title: exitWords(n.reason) };
  }
}

/** A branch reads as the question its outgoing edges answer: "setter booked or self-booked?" */
export function branchTitle(def: Definition, nodeId: string): string {
  const labels = def.edges.filter((e) => e.from === nodeId).map((e) => edgeWords(e)).filter((w) => w && w !== "otherwise");
  const els = def.edges.some((e) => e.from === nodeId && e.else);
  if (!labels.length) return "Which way?";
  return `${labels.join(", or ")}${els && labels.length === 1 ? ", or neither" : ""}?`.replace(/^./, (c) => c.toUpperCase());
}

/** An event type as a person says it, lower-cased for the middle of a sentence: "appointment booked". */
export const eventWords = (t: string) => (EVENT_LABELS[t] ?? humanWords(t)).replace(/^[A-Z](?![A-Z])/, (c) => c.toLowerCase());
/** A deadline as the end of a sentence: "up to 2 hours", "until 15 minutes after the call ended". */
export const untilWords = (rule: WaitRule) => { const w = waitWords(rule); return w.startsWith("Wait until ") ? w.replace(/^Wait /, "") : w.replace(/^Wait /, "up to "); };

/** `from`: the step the edge leaves, when its labels mean something of their own (an event wait's `event` and `until`, D85). */
export function edgeWords(e: Edge, from?: Node): string {
  if (from?.type === "wait_for_event" && (e.label === "event" || e.label === "until")) return e.label === "event" ? eventWords(from.event) : `no ${eventWords(from.event)} in time`;
  if (e.label === "timeout") return "no reply in time";
  if (e.label === "tap") return "a team member taps";
  if (e.label === "until") return "nobody tapped in time";
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
