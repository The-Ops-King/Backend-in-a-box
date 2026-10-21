import type { SlackApp } from "./app";
import { type Block, clockTime } from "./blocks";
import { contactOf } from "./contacts";
import { audit, messageAt, offerRow, settleMessage, unsettleMessage } from "./data";
import { type Presser, may, presserOf, refusal } from "./people";
import { post, react, settle, tell } from "./say";
import { openValue, signValue } from "./signed";

/**
 * Buttons and modals (POST /slack/interactions). The offer, run and step a press is about come from the button's
 * signed value or the modal's signed metadata, never from what a person typed. Every press is acked at once; the work
 * runs after as a job, then the message is edited to say who pressed what and when, its buttons gone. A press on a
 * question already answered, or a closed one, gets a private "already handled by X". Who may press is checked against
 * the person's role on that offer; a refusal is private and recorded.
 *
 * Synchronous (Slack wants these inside its three seconds): opening the Link modal (views.open needs the press's
 * trigger_id), checking a modal's submission (an error goes back into the form), the contact search (/slack/options).
 */
export type BlockAction = {
  type: "block_actions"; teamId: string; userId: string; channel: string | null; ts: string | null; actionId: string; value: string; label: string | null;
  responseUrl: string | null; triggerId: string | null; actionTs: string | null; message: { text?: string; blocks?: Block[] } | null;
};
export type ViewSubmit = { type: "view_submission"; teamId: string; userId: string; callbackId: string; meta: string; values: Record<string, Record<string, { value?: string | null; selected_option?: { value?: string } | null }>>; viewId: string | null };
export type Suggestion = { type: "block_suggestion"; teamId: string; userId: string; actionId: string; query: string; meta: string };
export type Interaction = BlockAction | ViewSubmit | Suggestion | { type: "ignored"; why: string };

const s = (v: unknown) => (typeof v === "string" ? v : null);

export function parseInteraction(payload: unknown): Interaction {
  const p = (payload ?? {}) as Record<string, any>;
  const teamId = s(p.team?.id) ?? s(p.user?.team_id), userId = s(p.user?.id);
  if (!teamId || !userId) return { type: "ignored", why: "no team or user" };
  if (p.type === "block_actions") {
    const a = (p.actions ?? [])[0] ?? {};
    if (!s(a.action_id)) return { type: "ignored", why: "no action" };
    return {
      type: "block_actions", teamId, userId, channel: s(p.container?.channel_id) ?? s(p.channel?.id), ts: s(p.container?.message_ts) ?? s(p.message?.ts), actionId: a.action_id, value: s(a.value) ?? "",
      label: s(a.text?.text), responseUrl: s(p.response_url), triggerId: s(p.trigger_id), actionTs: s(a.action_ts), message: p.message ? { text: s(p.message.text) ?? "", blocks: Array.isArray(p.message.blocks) ? p.message.blocks : [] } : null,
    };
  }
  if (p.type === "view_submission") return { type: "view_submission", teamId, userId, callbackId: s(p.view?.callback_id) ?? "", meta: s(p.view?.private_metadata) ?? "", values: p.view?.state?.values ?? {}, viewId: s(p.view?.id) };
  if (p.type === "block_suggestion") return { type: "block_suggestion", teamId, userId, actionId: s(p.action_id) ?? "", query: s(p.value) ?? "", meta: s(p.view?.private_metadata) ?? "" };
  return { type: "ignored", why: `interaction ${String(p.type ?? "?")}` };
}

/** What a press is: the signed value's payload. */
export type Pressed = { o: string | null; a: string; v: string; r?: string; s?: string };

export const LINK_FORM = "link_contact";
export const LINK_ACTIONS: Record<string, "payment" | "recording"> = { link_payment: "payment", link_recording: "recording" };
type LinkMeta = { o: string; k: "payment" | "recording"; id: string; ch: string | null; ts: string | null };

/** The Link modal: a contact search (its options from /slack/options), with the press's offer and what to link signed in its metadata. */
export function linkModal(meta: string, kind: "payment" | "recording") {
  return {
    type: "modal", callback_id: LINK_FORM, private_metadata: meta,
    title: { type: "plain_text", text: "Link to a contact" }, submit: { type: "plain_text", text: "Link" }, close: { type: "plain_text", text: "Cancel" },
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: `Who is this ${kind} from? Search by name, email or phone.` } },
      { type: "input", block_id: "who", label: { type: "plain_text", text: "Contact" }, element: { type: "external_select", action_id: "contact", min_query_length: 2, placeholder: { type: "plain_text", text: "Name, email or phone" } } },
    ],
  };
}

/** The synchronous part of an interaction: a Response to give Slack now, and whether a job follows. */
export async function interactNow(app: SlackApp, x: Interaction): Promise<{ body?: unknown; job: boolean }> {
  if (x.type === "block_actions" && LINK_ACTIONS[x.actionId]) {
    const v = openValue<Pressed>(app.env.stateSecret, "button", x.value, app.now());
    if (!v?.o) return { job: false };
    const who = await presserOf(app, v.o, x.teamId, x.userId);
    if (!may(who, "link")) return { job: true };   // the refusal is said by the job, privately
    if (!x.triggerId) return { job: true };
    const meta = signValue(app.env.stateSecret, "modal", { o: v.o, k: LINK_ACTIONS[x.actionId]!, id: v.v, ch: x.channel, ts: x.ts }, { now: app.now(), ttlSec: 3600 });
    await app.port.openModal({ offerId: v.o }, x.triggerId, linkModal(meta, LINK_ACTIONS[x.actionId]!));
    return { job: false };
  }
  if (x.type === "view_submission" && x.callbackId === LINK_FORM) {
    const m = openValue<LinkMeta>(app.env.stateSecret, "modal", x.meta, app.now());
    if (!m) return { body: { response_action: "errors", errors: { who: "This form has expired. Press Link again." } }, job: false };
    const who = await presserOf(app, m.o, x.teamId, x.userId);
    if (!may(who, "link")) return { body: { response_action: "errors", errors: { who: refusal("link") } }, job: false };
    const chosen = x.values.who?.contact?.selected_option?.value ?? "";
    if (!chosen || !(await contactOf(app.db, m.o, chosen))) return { body: { response_action: "errors", errors: { who: "Pick a contact from the list." } }, job: false };
    return { job: true };
  }
  if (x.type === "view_submission") {
    const { agreementSubmitNow } = await import("./agreement");
    return agreementSubmitNow(app, x);
  }
  return { job: x.type === "block_actions" };
}

/** The work after the ack. Gives back what was done, for the record and for tests. */
export async function handleInteraction(app: SlackApp, x: Interaction, inboxId: number): Promise<string> {
  if (x.type === "view_submission") {
    if (x.callbackId === LINK_FORM) return linkSubmitted(app, x, inboxId);
    const { agreementSubmitted } = await import("./agreement");
    return agreementSubmitted(app, x, inboxId);
  }
  if (x.type !== "block_actions") return "ignored";
  const purpose = x.actionId === "pick" ? "pick" : "button";
  const v = openValue<Pressed & Record<string, unknown>>(app.env.stateSecret, purpose, x.value, app.now());
  const where = { offerId: v?.o ?? null, teamId: x.teamId, user: x.userId, channel: x.channel, responseUrl: x.responseUrl };
  if (!v) { await tell(app, where, `press:${inboxId}`, "That button isn't one of mine, or it has expired."); return "unsigned"; }
  if (v.o && !(await offerRow(app.db, v.o))) return "no offer";
  if (x.actionId === "pick") { const { picked } = await import("./commands"); return picked(app, x, v, inboxId); }
  if (x.actionId === "ask") return answerAsk(app, x, v, inboxId);
  if (x.actionId.startsWith("alert_")) { const { pressAlert } = await import("./alerts"); return pressAlert(app, x, v, inboxId); }
  if (LINK_ACTIONS[x.actionId]) {
    // reached only when the modal was not opened: a refusal, or no trigger to open it with
    const who = await presserOf(app, v.o, x.teamId, x.userId);
    if (!may(who, "link")) return refuse(app, x, who, "link", inboxId);
    await tell(app, where, `press:${inboxId}`, "Slack didn't give me a way to open the form; press Link again.");
    return "no trigger";
  }
  if (x.actionId === "agreement_send" || x.actionId === "agreement_cancel") { const { agreementPressed } = await import("./agreement"); return agreementPressed(app, x, v, inboxId); }
  return "ignored";
}

export async function refuse(app: SlackApp, x: { teamId: string; userId: string; channel: string | null; responseUrl: string | null; actionId?: string }, who: Presser, rule: Parameters<typeof refusal>[0], inboxId: number): Promise<string> {
  await audit(app.db, { offerId: who.offerId, teamId: x.teamId, userId: x.userId, action: "slack.refused", detail: { rule, action: x.actionId ?? null, roles: who.roles }, at: app.now() });
  await tell(app, { offerId: who.offerId, teamId: x.teamId, user: x.userId, channel: x.channel, responseUrl: x.responseUrl }, `press:${inboxId}`, refusal(rule));
  return "refused";
}

const pressedLine = (label: string, userId: string, at: Date, zone: string) => `*${label}* · pressed by <@${userId}> · ${clockTime(at, zone)}`;

/** Confirm / Cancel / Reschedule on a card: the answer to the run's waiting ask step. */
async function answerAsk(app: SlackApp, x: BlockAction, v: Pressed, inboxId: number): Promise<string> {
  const where = { offerId: v.o, teamId: x.teamId, user: x.userId, channel: x.channel, responseUrl: x.responseUrl };
  if (!v.o || !v.r || !v.s || !x.channel || !x.ts) return "incomplete";
  const msg = await messageAt(app.db, x.teamId, x.channel, x.ts);
  // the press must be on the very post that run's step made
  if (!msg || msg.offerId !== v.o || msg.runId !== v.r || msg.node !== v.s) { await tell(app, where, `press:${inboxId}`, "I can't find the question this button belongs to."); return "no post"; }
  const who = await presserOf(app, v.o, x.teamId, x.userId);
  if (!may(who, "ask")) return refuse(app, { ...x }, who, "ask", inboxId);
  const offer = (await offerRow(app.db, v.o))!;
  const label = x.label ?? v.v;
  const stale = async (by: string) => { await tell(app, where, `press:${inboxId}`, `Already handled by ${by}.`); return "stale"; };
  if (msg.settled) return stale(settledBy(msg.settled));
  const earlier = await app.engine.store.tx((tx) => tx.events({ offerId: v.o!, types: ["ask.answered"], runId: v.r!, node: v.s!, limit: 1 }));
  if (earlier[0]) return stale(await personName(app, v.o, String(earlier[0].payload.person ?? "someone")));
  const run = await app.engine.store.tx((tx) => tx.run(v.r!));
  if (!run || !["active", "waiting", "paused"].includes(run.status)) {
    await settle(app, { offerId: v.o, teamId: x.teamId, channel: x.channel, ts: x.ts }, x.message, "This question closed before it was answered.");
    return stale("the workflow (it closed)");
  }
  const at = app.now();
  if (!(await settleMessage(app.db, msg.id, { user: x.userId, name: who.name, action: "ask", value: v.v, label, at: at.toISOString() }))) {
    const again = await messageAt(app.db, x.teamId, x.channel, x.ts);
    return stale(settledBy(again?.settled));
  }
  try {
    await app.engine.answer({ offerId: v.o, channel: x.channel, ts: x.ts, value: v.v, person: who.personId ?? `slack:${x.userId}`, at, dedupeKey: `slack:${x.teamId}:${x.actionTs ?? inboxId}:${x.userId}` });
  } catch (e) {
    await unsettleMessage(app.db, msg.id);
    await tell(app, where, `press:${inboxId}`, `That didn't go through: ${e instanceof Error ? e.message : String(e)}`);
    return "failed";
  }
  await settle(app, { offerId: v.o, teamId: x.teamId, channel: x.channel, ts: x.ts }, x.message, pressedLine(label, x.userId, at, offer.zone));
  await audit(app.db, { offerId: v.o, teamId: x.teamId, userId: x.userId, action: "slack.answered", detail: { run: v.r, node: v.s, value: v.v }, at });
  return "answered";
}

export function settledBy(settled: unknown): string {
  const st = (settled ?? {}) as { user?: string; label?: string; at?: string };
  return st.user ? `<@${st.user}>${st.label ? ` (${st.label})` : ""}` : "someone";
}

async function personName(app: SlackApp, offerId: string, person: string): Promise<string> {
  if (person.startsWith("slack:")) return `<@${person.slice(6)}>`;
  const p = await app.engine.store.tx((tx) => tx.projGet("people", offerId, person));
  return p?.name ?? person;
}

/** The Link modal sent back: the payment (or recording) is linked to the chosen contact, by a fact that says who did it. */
async function linkSubmitted(app: SlackApp, x: ViewSubmit, inboxId: number): Promise<string> {
  const m = openValue<LinkMeta>(app.env.stateSecret, "modal", x.meta, app.now());
  if (!m) return "expired";
  const who = await presserOf(app, m.o, x.teamId, x.userId);
  if (!may(who, "link")) return refuse(app, { teamId: x.teamId, userId: x.userId, channel: m.ch, responseUrl: null }, who, "link", inboxId);
  const contact = await contactOf(app.db, m.o, x.values.who?.contact?.selected_option?.value ?? "");
  if (!contact) return "no contact";
  const at = app.now();
  const by = who.personId ?? `slack:${x.userId}`;
  await app.engine.ingest({
    offerId: m.o, type: m.k === "payment" ? "payment.linked" : "recording.linked", occurredAt: at, source: "slack", dedupeKey: `slack:link:${m.k}:${m.id}:${contact.id}`, contactId: contact.id,
    payload: { ...(m.k === "payment" ? { payment_id: m.id } : { recording_id: m.id }), by, by_slack_user: x.userId },
  });
  await audit(app.db, { offerId: m.o, teamId: x.teamId, userId: x.userId, action: `slack.linked_${m.k}`, detail: { id: m.id, contact: contact.id }, at });
  if (m.ch && m.ts) {
    const offer = (await offerRow(app.db, m.o))!;
    const msg = await messageAt(app.db, x.teamId, m.ch, m.ts);
    if (msg) await settleMessage(app.db, msg.id, { user: x.userId, name: who.name, action: `link_${m.k}`, label: "Link", at: at.toISOString() });
    const w = { offerId: m.o, teamId: x.teamId };
    await post(app, { ...w, channel: m.ch, threadTs: m.ts }, `link:${m.k}:${m.id}:said`, { text: `✅ Linked to ${contact.name} by <@${x.userId}>.`, blocks: [{ type: "section", text: { type: "mrkdwn", text: `✅ Linked to *${contact.name}* by <@${x.userId}>.` } }] }, { kind: "command" });
    await react(app, { ...w, channel: m.ch, ts: m.ts }, `link:${m.k}:${m.id}:check`, "white_check_mark");
    await settle(app, { ...w, channel: m.ch, ts: m.ts }, null, pressedLine(`Linked to ${contact.name}`, x.userId, at, offer.zone));
  }
  return "linked";
}
