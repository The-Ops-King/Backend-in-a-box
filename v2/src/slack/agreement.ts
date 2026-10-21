import { definitionOf } from "@/engine/interpreter";
import type { SlackApp } from "./app";
import { formSummary } from "./blocks";
import type { SlashCommand } from "./commands";
import { type Found, contactOf } from "./contacts";
import { audit } from "./data";
import { type BlockAction, type Pressed, type ViewSubmit, refuse } from "./interactions";
import { type Presser, may, presserOf, refusal } from "./people";
import { type Offer, routeCommand } from "./routing";
import { post, respondReplace, tell } from "./say";
import { openValue, signValue } from "./signed";

/**
 * /agreement: an owner, a manager, or the closer on that contact's deal asks for an agreement to go out. Slack never
 * sends it itself: the request is a fact (agreement.requested) that the offer's own workflow takes, so the send lock,
 * sandbox and every gate apply as to any send. An offer with no enabled workflow that takes it is told so, and nothing
 * is recorded.
 */
export const AGREEMENT_FORM = "agreement_form";
export const REQUESTED = "agreement.requested";
type Meta = { o: string; ch: string | null };

export function agreementModal(meta: string) {
  return {
    type: "modal", callback_id: AGREEMENT_FORM, private_metadata: meta,
    title: { type: "plain_text", text: "Send an agreement" }, submit: { type: "plain_text", text: "Send" }, close: { type: "plain_text", text: "Cancel" },
    blocks: [{ type: "input", block_id: "who", label: { type: "plain_text", text: "Who to" }, element: { type: "external_select", action_id: "contact", min_query_length: 2, placeholder: { type: "plain_text", text: "Name, email or phone" } } }],
  };
}

/** The enabled workflows of the offer a fact of this type starts. */
export async function workflowsOn(app: SlackApp, offerId: string, type: string): Promise<string[]> {
  return app.engine.store.tx(async (tx) => {
    const out: string[] = [];
    for (const w of await tx.workflows(offerId)) {
      if (!w.enabled || !w.currentVersionId) continue;
      const { def } = definitionOf((await tx.version(w.currentVersionId))!);
      if (def.nodes.some((n) => n.type === "trigger@1" && "event" in (n as { on: object }).on && (n as { on: { event: string } }).on.event === type)) out.push(w.name);
    }
    return out;
  });
}

/** An owner or a manager may ask for anyone; a closer only for a contact whose deal is theirs. */
async function mayFor(app: SlackApp, who: Presser, offerId: string, contactId: string): Promise<boolean> {
  if (!may(who, "agreement")) return false;
  if (who.operator || who.roles.includes("owner") || who.roles.includes("manager")) return true;
  if (!who.personId) return false;
  const [person, deals] = await app.engine.store.tx(async (tx) => [await tx.projGet("people", offerId, who.personId!), await tx.projFind("deals", offerId, { where: { contactId } })] as const);
  const keys = new Set([person?.crmUserId ? `crm:${person.crmUserId}` : "", person?.name ? `name:${person.name}` : ""].filter(Boolean));
  return deals.some((d) => d.ownerKey && keys.has(d.ownerKey));
}

/** The synchronous part of `/agreement` with nothing after it: the form opens now (views.open needs the command's trigger_id). */
export async function agreementCommandNow(app: SlackApp, cmd: SlashCommand): Promise<boolean> {
  if (cmd.text.trim() || !cmd.triggerId) return false;
  const routed = await routeCommand(app, cmd);
  if (!("offer" in routed)) return false;
  const who = await presserOf(app, routed.offer.id, cmd.teamId, cmd.userId);
  if (!may(who, "agreement")) return false;
  const meta = signValue(app.env.stateSecret, "modal", { o: routed.offer.id, ch: cmd.channelId || null }, { now: app.now(), ttlSec: 3600 });
  await app.port.openModal({ offerId: routed.offer.id }, cmd.triggerId, agreementModal(meta));
  return true;
}

/** `/agreement <email or phone>`: who it would go to, with Send and Cancel. */
export async function agreementCommand(app: SlackApp, cmd: SlashCommand, offer: Offer, text: string, inboxId: number): Promise<string> {
  const where = { offerId: offer.id, teamId: cmd.teamId, user: cmd.userId, channel: cmd.channelId, responseUrl: cmd.responseUrl };
  if (!text.trim()) { await tell(app, where, `cmd:${inboxId}`, "Slack didn't let me open the form; try `/agreement` again, or give their email: `/agreement ana@example.com`."); return "no form"; }
  const contact = await contactOf(app.db, offer.id, text.trim());
  if (!contact) { await tell(app, where, `cmd:${inboxId}`, `No one on ${offer.name} matches "${text.trim()}" (or more than one does). Try their exact email or phone.`); return "no contact"; }
  const who = await presserOf(app, offer.id, cmd.teamId, cmd.userId);
  if (!(await mayFor(app, who, offer.id, contact.id))) return refuse(app, { teamId: cmd.teamId, userId: cmd.userId, channel: cmd.channelId, responseUrl: cmd.responseUrl, actionId: "agreement" }, who, "agreement", inboxId);
  const sign = (a: string) => signValue(app.env.stateSecret, "button", { o: offer.id, a, v: contact.id }, { now: app.now(), ttlSec: 3600 });
  const m = formSummary({ title: "Send an agreement?", fields: [["To", contact.name], ["Email", contact.email ?? ""], ["Phone", contact.phone ?? ""]], buttons: [{ actionId: "agreement_send", label: "Send", value: sign("agreement_send"), style: "primary" }, { actionId: "agreement_cancel", label: "Cancel", value: sign("agreement_cancel") }] });
  await tell(app, where, `cmd:${inboxId}`, m.text, m.blocks);
  return "confirm";
}

export async function agreementPressed(app: SlackApp, x: BlockAction, v: Pressed, inboxId: number): Promise<string> {
  const where = { offerId: v.o, teamId: x.teamId, user: x.userId, channel: x.channel, responseUrl: x.responseUrl };
  if (x.actionId === "agreement_cancel") {
    await respondReplace(app, where, `press:${inboxId}`, `Cancelled by <@${x.userId}>. Nothing sent.`);
    return "cancelled";
  }
  if (!v.o) return "no offer";
  const contact = await contactOf(app.db, v.o, v.v);
  if (!contact) { await respondReplace(app, where, `press:${inboxId}`, "I can't find that contact any more."); return "no contact"; }
  return requestAgreement(app, { offerId: v.o, contact, teamId: x.teamId, userId: x.userId, channel: x.channel, responseUrl: x.responseUrl, key: `slack:agreement:${x.actionTs ?? inboxId}`, inboxId, replaceOriginal: true });
}

export async function agreementSubmitNow(app: SlackApp, x: ViewSubmit): Promise<{ body?: unknown; job: boolean }> {
  if (x.callbackId !== AGREEMENT_FORM) return { job: false };
  const m = openValue<Meta>(app.env.stateSecret, "modal", x.meta, app.now());
  if (!m) return { body: { response_action: "errors", errors: { who: "This form has expired. Run /agreement again." } }, job: false };
  const contact = await contactOf(app.db, m.o, x.values.who?.contact?.selected_option?.value ?? "");
  if (!contact) return { body: { response_action: "errors", errors: { who: "Pick a contact from the list." } }, job: false };
  const who = await presserOf(app, m.o, x.teamId, x.userId);
  if (!(await mayFor(app, who, m.o, contact.id))) return { body: { response_action: "errors", errors: { who: refusal("agreement") } }, job: false };
  return { job: true };
}

export async function agreementSubmitted(app: SlackApp, x: ViewSubmit, inboxId: number): Promise<string> {
  if (x.callbackId !== AGREEMENT_FORM) return "ignored";
  const m = openValue<Meta>(app.env.stateSecret, "modal", x.meta, app.now());
  if (!m) return "expired";
  const contact = await contactOf(app.db, m.o, x.values.who?.contact?.selected_option?.value ?? "");
  if (!contact) return "no contact";
  return requestAgreement(app, { offerId: m.o, contact, teamId: x.teamId, userId: x.userId, channel: m.ch, responseUrl: null, key: `slack:agreement:view:${x.viewId ?? inboxId}`, inboxId, dm: true });
}

async function requestAgreement(app: SlackApp, r: { offerId: string; contact: Found; teamId: string; userId: string; channel: string | null; responseUrl: string | null; key: string; inboxId: number; replaceOriginal?: boolean; dm?: boolean }): Promise<string> {
  const where = { offerId: r.offerId, teamId: r.teamId, user: r.userId, channel: r.dm ? null : r.channel, responseUrl: r.responseUrl };
  const say = async (text: string) => {
    if (r.replaceOriginal && r.responseUrl) return respondReplace(app, where, `press:${r.inboxId}`, text);
    if (r.dm) return post(app, { offerId: r.offerId, teamId: r.teamId, channel: await dmChannel(app, r.offerId, r.userId) }, `press:${r.inboxId}`, { text, blocks: [{ type: "section", text: { type: "mrkdwn", text } }] }, { kind: "command" });
    return tell(app, where, `press:${r.inboxId}`, text);
  };
  const who = await presserOf(app, r.offerId, r.teamId, r.userId);
  if (!(await mayFor(app, who, r.offerId, r.contact.id))) {
    await audit(app.db, { offerId: r.offerId, teamId: r.teamId, userId: r.userId, action: "slack.refused", detail: { rule: "agreement", roles: who.roles }, at: app.now() });
    await say(refusal("agreement"));
    return "refused";
  }
  const takers = await workflowsOn(app, r.offerId, REQUESTED);
  if (!takers.length) { await say("This offer has no workflow that sends an agreement on request yet, so nothing was sent."); return "no workflow"; }
  await app.engine.ingest({ offerId: r.offerId, type: REQUESTED, source: "slack", dedupeKey: r.key, contactId: r.contact.id, payload: { by: who.personId ?? `slack:${r.userId}`, by_slack_user: r.userId, contact: { id: r.contact.id } } });
  await audit(app.db, { offerId: r.offerId, teamId: r.teamId, userId: r.userId, action: "slack.agreement_requested", detail: { contact: r.contact.id }, at: app.now() });
  await say(`📨 Requested by <@${r.userId}>: ${takers.join(", ")} sends ${r.contact.name}'s agreement.`);
  return "requested";
}

/** The DM channel with a person: opened through Slack when the job delivers it (`D` + their id stands for it until then). */
async function dmChannel(app: SlackApp, offerId: string, userId: string): Promise<string> {
  const r = await app.port.send({ offerId }, "conversations.open", { users: userId });
  return String((r.channel as { id?: string } | undefined)?.id ?? "");
}
