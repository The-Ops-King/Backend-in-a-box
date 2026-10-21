import type { SendWindow } from "@/workflow/definition";
import type { CrmContact } from "./ports";
import { inWindow, nextOpen } from "./time";
import type { CrmWrites, Delivery, GateCheck, GateDecision, OutboxRow } from "./types";

/**
 * The delivery gate: the one function every outbound effect passes before the dispatcher calls a port. It applies,
 * in this order, recording each decision on the row:
 *
 * 0. channel (only for a Slack post whose channel the triggering fact named): it goes ahead only when that channel is
 *    one of the offer's own Slack channel settings (slack.channel.*, the test channel aside); any other is held, with
 *    an alert, and never posted to.
 * 1. delivery: the workflow's delivery state. sandbox lets a contact effect reach only the operator's own address,
 *    puts a Slack post in the offer's test channel, and sends no outbound webhook; live lets everything through.
 * 2. crm_writes: dry records a CRM write without making it; real makes it.
 * 3. dnd: the contact's opt-out / do-not-disturb, as the CRM holds it at send time.
 * 4. window: the send window, for messages to the contact (receipts by the workflow's transactional rule).
 * 5. cap and breaker: at most N messages per contact per day across all workflows (held, with an alert, past it); an
 *    offer that sends more than M an hour trips the breaker, which holds every message to a contact until cleared.
 * 6. blank: a message whose rendered words have a blank variable, a refused value, a placeholder or no content is held.
 *
 * The first check that stops the row decides; checks after it are not reached. A check that does not apply to the
 * row's kind is recorded as not_applicable.
 */

export const CONTACT_MESSAGES = ["message.sms", "message.email"] as const;
const CONTACT_ACTIONS = ["scheduling.cancel", "esign.send", "esign.void"];
const TEAM_KINDS = ["message.slack", "slack.ask", "slack.react", "slack.unreact", "slack.update_post"];
const WORDED = ["message.sms", "message.email", "message.slack", "slack.ask", "slack.update_post", ...CONTACT_ACTIONS];

/** Settings the gate reads, and the platform defaults where Tyler set one. */
export const SETTING = { cap: "delivery.cap_per_day", breaker: "delivery.breaker_per_hour", testChannel: "slack.channel.test" } as const;
/** Tyler: at most 4 messages per contact per day across all workflows; each offer can override it. */
export const DEFAULT_CAP_PER_DAY = 4;
/** The breaker's sends per hour when an offer has not set one (a platform default for Tyler to confirm). */
export const DEFAULT_BREAKER_PER_HOUR = 30;

export type GateInput = {
  row: Pick<OutboxRow, "kind" | "effect" | "payload" | "contactId">;
  workflow: { delivery: Delivery; crmWrites: CrmWrites };
  operator: { emails: string[]; phones: string[] };
  /** The contact as the CRM holds it now; null when the CRM has no such contact; undefined when not read (no contact effect). */
  contact?: CrmContact | null;
  settings: Record<string, unknown>;
  sendWindow?: SendWindow;
  /** The zone the send window is read in for this contact. */
  windowZone: string;
  offer: { sendsPausedAt: Date | null };
  /** Contact messages already attempted: to this contact on their calendar day, and by the offer in the last hour. */
  counts: { contactToday: number; offerLastHour: number; day: string };
  now: Date;
};

export type GateResult = {
  decision: "send" | "suppress" | "hold" | "defer";
  checks: GateDecision[];
  /** defer: when to look again (the window's next opening). */
  at?: Date;
  /** send: the Slack channel the post goes to instead (sandbox). */
  channel?: string;
  /** hold: an operator should be told. The dispatcher scopes `key` to the offer (and to the row for a blank hold). */
  alert?: { key: string; kind: string; message: string };
  /** The breaker trips with this row. */
  tripBreaker?: boolean;
};

export const normPhone = (p: string | null | undefined) => (p ? p.replace(/[^\d]/g, "").replace(/^1(?=\d{10}$)/, "") : "");
export const normEmail = (e: string | null | undefined) => (e ? e.trim().toLowerCase() : "");

const num = (v: unknown, dflt: number) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : dflt);

export function gate(input: GateInput): GateResult {
  const { row, now } = input;
  const at = now.toISOString();
  const checks: GateDecision[] = [];
  const note = (check: GateCheck, result: GateDecision["result"], why: string) => checks.push({ check, result, why, at });
  const kind = row.kind;
  const isMessage = (CONTACT_MESSAGES as readonly string[]).includes(kind);
  const toContact = row.effect === "contact";
  const p = row.payload as {
    kind?: "human" | "transactional"; notAfter?: string; render?: { blanks?: unknown[]; errors?: unknown[] }; missingContent?: string[]; text?: string; contactRequired?: boolean;
    fromFact?: boolean; channel?: string;
  };
  let channel: string | undefined;

  // 0. a channel the triggering fact named must be one of the offer's own
  if ((kind === "message.slack" || kind === "slack.ask") && p.fromFact && p.channel) {
    const mapped = Object.keys(input.settings).sort().find((k) => k.startsWith("slack.channel.") && k !== SETTING.testChannel && input.settings[k] === p.channel);
    if (!mapped) {
      note("channel", "hold", `the fact named the channel ${p.channel}, which is not one of the offer's Slack channel settings`);
      return { decision: "hold", checks, alert: { key: `unmapped-channel:${p.channel}`, kind: "unmapped_channel", message: `A Slack post was held: the fact named the channel ${p.channel}, which is not one of the offer's channels (slack.channel.*)` } };
    }
    note("channel", "pass", `${p.channel} is the offer's ${mapped}`);
  }

  // 1. delivery state
  if (toContact) {
    if (input.contact === null) { note("delivery", "suppress", "the CRM has no such contact"); return { decision: "suppress", checks }; }
    if (input.workflow.delivery === "sandbox") {
      const c = input.contact;
      const phones = new Set(input.operator.phones.map(normPhone)), emails = new Set(input.operator.emails.map(normEmail));
      const byPhone = !!c?.phone && phones.has(normPhone(c.phone)), byEmail = !!c?.email && emails.has(normEmail(c.email));
      const ok = kind === "message.sms" ? byPhone : kind === "message.email" || kind.startsWith("esign.") ? byEmail : byPhone || byEmail;
      if (!ok) { note("delivery", "suppress", `sandbox: ${kind === "message.sms" ? "the contact's phone" : kind === "message.email" || kind.startsWith("esign.") ? "the contact's email" : "the contact"} is not the operator's own`); return { decision: "suppress", checks }; }
      note("delivery", "pass", "sandbox: the operator's own address");
    } else note("delivery", "pass", "live");
  } else if (TEAM_KINDS.includes(kind)) {
    if (input.workflow.delivery === "sandbox") {
      const test = input.settings[SETTING.testChannel];
      if (kind === "message.slack" || kind === "slack.ask") {
        if (typeof test !== "string" || !test) { note("delivery", "hold", "sandbox: the offer has no test channel (slack.channel.test) to post in"); return { decision: "hold", checks, alert: { key: "sandbox-channel", kind: "sandbox_no_test_channel", message: "A sandbox Slack post was held: set slack.channel.test" } }; }
        channel = test;
        note("delivery", "reroute", `sandbox: posted in the test channel ${test}`);
      } else note("delivery", "pass", "sandbox: on a post the run made in the test channel");
    } else note("delivery", "pass", "live");
  } else if (row.effect === "external") {
    if (input.workflow.delivery === "sandbox") { note("delivery", "suppress", "sandbox: no outbound webhook"); return { decision: "suppress", checks }; }
    note("delivery", "pass", "live");
  } else note("delivery", "not_applicable", row.effect === "crm" ? "a CRM write (see crm_writes)" : "a read changes nothing");

  // 2. CRM writes
  if (row.effect === "crm") {
    if (input.workflow.crmWrites === "dry") { note("crm_writes", "suppress", "dry: the write is recorded, not made"); return { decision: "suppress", checks }; }
    note("crm_writes", "pass", "real");
  } else note("crm_writes", "not_applicable", "not a CRM write");

  // 3. opt-out and DND
  if (toContact) {
    const d = input.contact?.dnd ?? {};
    const on = kind === "message.sms" ? d.sms || d.all : kind === "message.email" || kind.startsWith("esign.") ? d.email || d.all : d.all;
    if (on) { note("dnd", "suppress", `the contact is do-not-disturb${kind === "message.sms" ? " for texts" : kind === "message.email" ? " for email" : ""}`); return { decision: "suppress", checks }; }
    note("dnd", "pass", "not do-not-disturb");
  } else note("dnd", "not_applicable", "does not reach the contact");

  // 4. the send window
  if (toContact && input.sendWindow) {
    const w = input.sendWindow;
    const human = isMessage && (p.kind ?? "human") === "human";
    const applies = human || w.transactional === "in_window";
    if (!applies) note("window", "pass", "a receipt may go at any hour");
    else if (inWindow(now, w, input.windowZone)) note("window", "pass", "inside the send window");
    else {
      const open = nextOpen(now, w, input.windowZone);
      if (p.notAfter && open.getTime() > new Date(p.notAfter).getTime()) { note("window", "suppress", "the window opens after the message stops making sense"); return { decision: "suppress", checks }; }
      note("window", "defer", `outside the send window: waits for ${open.toISOString()}`);
      return { decision: "defer", checks, at: open };
    }
  } else note("window", "not_applicable", toContact ? "the workflow has no send window" : "does not reach the contact");

  // 5. frequency cap and circuit breaker
  if (isMessage) {
    const cap = num(input.settings[SETTING.cap], DEFAULT_CAP_PER_DAY);
    if (input.counts.contactToday >= cap) {
      note("cap", "hold", `the contact has had ${input.counts.contactToday} messages today; the cap is ${cap}`);
      return { decision: "hold", checks, alert: { key: `cap:${row.contactId}:${input.counts.day}`, kind: "frequency_cap", message: `A message to contact ${row.contactId} was held: it would be number ${input.counts.contactToday + 1} today (cap ${cap})` } };
    }
    note("cap", "pass", `${input.counts.contactToday} of ${cap} today`);
  } else note("cap", "not_applicable", "not a message to the contact");
  if (toContact) {
    const limit = num(input.settings[SETTING.breaker], DEFAULT_BREAKER_PER_HOUR);
    if (input.offer.sendsPausedAt) { note("breaker", "hold", "sends are paused by the circuit breaker"); return { decision: "hold", checks }; }
    if (isMessage && input.counts.offerLastHour >= limit) {
      note("breaker", "hold", `the offer sent ${input.counts.offerLastHour} messages in the last hour (limit ${limit}): sends paused`);
      return { decision: "hold", checks, tripBreaker: true, alert: { key: "breaker", kind: "circuit_breaker", message: `Sends paused: ${input.counts.offerLastHour} messages in the last hour (limit ${limit})` } };
    }
    note("breaker", "pass", `${input.counts.offerLastHour} of ${limit} this hour`);
  } else note("breaker", "not_applicable", "does not reach the contact");

  // 6. blank-variable hold
  if (WORDED.includes(kind)) {
    const blanks = p.render?.blanks?.length ?? 0, errors = p.render?.errors?.length ?? 0;
    const placeholder = typeof p.text === "string" && /\{\{|\}\}/.test(p.text);
    const why = p.missingContent?.length ? `no content for ${p.missingContent.join(", ")}` : blanks ? `${blanks} blank variable${blanks > 1 ? "s" : ""}` : errors ? `${errors} refused value${errors > 1 ? "s" : ""}` : placeholder ? "a placeholder is left in the words" : "";
    if (why) return { decision: "hold", checks: [...checks, { check: "blank", result: "hold", why, at }], alert: { key: "blank", kind: "blank_hold", message: `A message was held: ${why}` } };
    note("blank", "pass", "every variable filled");
  } else note("blank", "not_applicable", "no words");

  return { decision: "send", checks, ...(channel ? { channel } : {}) };
}
