import type { Definition, Predicate } from "./definition";
import { referencedPaths } from "./template";

/**
 * D339: what a trigger's `match` can read, per event type: the context dispatchEvent is handed at each place an event is dispatched
 * (dispatch.ts's callers), never the run's full context (context.ts). A match that reads a path its event never carries is always
 * false and the workflow never starts (TRC's Call booked, 2026-11-16: `{{appointment.closer.ghl_user_id}}` on appointment.booked,
 * whose match context has no closer). `event.*` is always there (the event's own data, with _source and _type).
 *
 * Kept by hand from the dispatch sites below; a site that starts carrying more adds it here, in the same change. Left out on purpose:
 * the test harness (simulate.ts) and the operator's replay of a stored event (/api/admin/events/replay, eventMatchContext): a match that
 * holds only there never starts the workflow on its own, which is the bug this guards against.
 */
const CONTACT = ["contact.id"];
const CONTACT_POLLED = ["contact.id", "contact.ghl_contact_id", "contact.tags"];   // poll.ts upsert, ledger-drift's late lead
const FORM = ["contact.id", "contact.ghl_contact_id", "form.id", "form.name", "form.response_id"];   // typeform.ts
const TERM = ["appointment.term.name", "appointment.term.category"];
const APPT_ROW = ["appointment.id", "appointment.starts_at", "appointment.status", "appointment.term.category"];   // the row read back (recordings.ts, inbound.ts, eventMatchContext)
const PHONE = ["recording.id", "recording.kind", "recording.direction", "recording.status", "recording.connected", "recording.duration_sec", "recording.has_transcript", "recording.caller"];
const MEETING = ["recording.id", "recording.title", "recording.duration_min"];
const AGREEMENT = ["agreement.agreement_id", "agreement.external_id", "agreement.name", "agreement.status", "agreement.sent_at", "agreement.signed_at", "agreement.signed", "agreement.sent_by"];
const PAYMENT = [...CONTACT, "opportunity.id"];   // payments.ts, deal-price.ts, commas.ts (an unlinked one carries nothing)

export const MATCH_CONTEXT: Record<string, readonly string[]> = {
  // poll.ts (contacts), typeform.ts, ledger-drift.ts, executor.ts tag steps
  "lead.created": [...CONTACT_POLLED, ...FORM],
  "tag.added": [...CONTACT_POLLED, ...FORM],
  "tag.removed": CONTACT_POLLED,
  "form.submitted": FORM,
  "message.received": CONTACT,
  // poll.ts:253 (and replay.ts:62): the booking as the poll saw it; no closer
  "appointment.booked": [...CONTACT, "appointment.id", "appointment.starts_at", "appointment.status", ...TERM, "appointment.self_booked", "appointment.set_by", "opportunity.id"],
  // poll.ts:289 (a moved or changed booking), executor.ts update_appointment
  "appointment.rescheduled": [...CONTACT, "appointment.id", "appointment.starts_at", "appointment.status", ...TERM, "appointment.self_booked"],
  "appointment.status_changed": [...CONTACT, "appointment.id", "appointment.starts_at", "appointment.status", ...TERM, "appointment.self_booked"],
  // disposition.ts
  "appointment.outcome": [...CONTACT, "appointment.id", ...TERM],
  "call.held": [...CONTACT, "appointment.id", ...TERM],
  // reassign.ts, executor.ts update_appointment
  "appointment.reassign_requested": [...CONTACT, "appointment.id", "appointment.starts_at", "appointment.status", ...TERM],
  "appointment.reassigned": [...CONTACT, "appointment.id"],
  // card-moves.ts, webhooks/slack.ts
  "card.moved": [...CONTACT, "appointment.id"],
  "slack.reaction": [...CONTACT, "appointment.id"],
  // recordings.ts:450, inbound.ts: the meeting and the booking it fits; no closer (a branch reads recording.closer)
  "recording.received": [...CONTACT, ...APPT_ROW, ...MEETING],
  // poll.ts:408: a phone call with what the dialer knew
  "call.logged": [...CONTACT, ...PHONE],
  // poll.ts:466, webhooks/agreement-request.ts
  "agreement.sent": [...CONTACT, ...AGREEMENT],
  "agreement.signed": [...CONTACT, ...AGREEMENT],
  "agreement.requested": CONTACT,
  // payments.ts, deal-price.ts, commas.ts; payment.received is also handed on again with eventMatchContext (payment-ask.ts)
  "payment.received": [...PAYMENT, ...APPT_ROW, ...MEETING, ...PHONE],
  "payment.failed": PAYMENT,
  "payment.refunded": PAYMENT,
  "payment.linked": PAYMENT,
  "payment.unlinked": PAYMENT,
  "payment.paid_in_full": PAYMENT,
  // executor.ts opportunity step
  "opportunity.won": [...CONTACT, "opportunity.id", "opportunity.status"],
  "opportunity.lost": [...CONTACT, "opportunity.id", "opportunity.status"],
  "opportunity.opened": [...CONTACT, "opportunity.id", "opportunity.status"],
  // eod.ts
  "eod.filed": ["user.id"],
  "eod.disagreement": ["user.id", ...CONTACT],
  "setter_call.filed": CONTACT,
  // ledger-drift.ts
  "drift.found": [],
  "drift.sales_call_cancelled": [...CONTACT, "appointment.id"],
  "drift.sales_call_unlinked": [...CONTACT, "appointment.id"],
  // alerts.ts: about the company, nothing but the event
  "alert.raised": [], "alert.repeated": [], "alert.resolved": [],
};
/** A record step that starts workflows (executor.ts, D87) hands on the person, the booking's id and the run's whole recording. */
const RECORD_STEP = [...CONTACT, "appointment.id"];
const ALL = [...new Set(Object.values(MATCH_CONTEXT).flat())];

/** The paths a predicate reads: `{{…}}` in any operand, and `exists`'s bare path. */
export function predicatePaths(p: Predicate): string[] {
  const out: string[] = [];
  const walk = (v: unknown) => { if (typeof v === "string") out.push(...referencedPaths(v)); else if (Array.isArray(v)) v.forEach(walk); };
  const go = (q: Predicate) => {
    if ("and" in q) q.and.forEach(go); else if ("or" in q) q.or.forEach(go); else if ("not" in q) go(q.not);
    else if ("exists" in q) out.push(q.exists.replace(/[{}\s]/g, ""));
    else for (const v of Object.values(q)) walk(v);
  };
  go(p);
  return [...new Set(out.map((x) => x.split("|")[0].trim()).filter(Boolean))];
}

/**
 * Whether a trigger on `event` can ever see `path` in its match. `startedByRecord`: some workflow of the offer (or the one being saved)
 * starts this event from a record step, which carries the run's recording whole. An event the engine does not dispatch itself (none
 * listed) is held to everything any dispatch carries.
 */
export function matchCarries(event: string, path: string, startedByRecord: boolean): boolean {
  if (path === "event" || path.startsWith("event.")) return true;
  if (startedByRecord && (path === "recording" || path.startsWith("recording."))) return true;
  const known = MATCH_CONTEXT[event];
  const carried = [...(known ?? ALL), ...(startedByRecord ? RECORD_STEP : []), ...(!known ? ["recording"] : [])];
  return carried.some((f) => f === path || f.startsWith(`${path}.`) || (f === "recording" && path.startsWith("recording.")));
}

/** The record-step events that start workflows, in these definitions. */
export const recordStarted = (defs: Pick<Definition, "nodes">[]) => new Set(defs.flatMap((d) => d.nodes.flatMap((n) => (n.type === "record" && n.start ? [n.event] : []))));

export type UnreachableMatch = { node: string; title?: string; event: string; path: string };
/** Every trigger match path in `def` its event's match context never carries. */
export function unreachableMatches(def: Pick<Definition, "nodes">, startedByRecord: Set<string>): UnreachableMatch[] {
  const out: UnreachableMatch[] = [];
  for (const n of def.nodes) {
    if (n.type !== "trigger" || !n.match) continue;
    for (const path of predicatePaths(n.match)) if (!matchCarries(n.event, path, startedByRecord.has(n.event))) out.push({ node: n.id, title: n.title, event: n.event, path });
  }
  return out;
}

const carriedOf = (event: string) => (MATCH_CONTEXT[event] ?? []).filter((f) => !MATCH_CONTEXT[event]!.some((g) => g !== f && g.startsWith(`${f}.`)));
/** The refusal, naming the field and the way to do it. */
export function describeUnreachable(u: UnreachableMatch): string {
  const has = carriedOf(u.event);
  return `${u.title ? `${u.title} (${u.node})` : `node ${u.node}`}: its match reads {{${u.path}}}, which ${u.event} never carries when it starts a workflow`
    + `${MATCH_CONTEXT[u.event] ? ` (it carries event.*${has.length ? `, ${has.join(", ")}` : ""})` : ""}, so the condition is always false and the workflow never starts.`
    + ` Read it in a branch as the first step instead: the run's context has the full ${u.path.split(".")[0]}.`;
}
