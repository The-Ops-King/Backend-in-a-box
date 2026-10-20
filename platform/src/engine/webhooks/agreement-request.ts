import type { PoolClient } from "pg";
import { asOperator, many, one } from "@/db/client";
import type { Adapters } from "@/adapters/types";
import { dispatchEvent, emitEvent } from "../dispatch";
import { runNow } from "../runner";
import { slackBot } from "../slack-conn";
import { findContact } from "./slack-link";

/**
 * D202 (Tyler: "a slack slash command for instant agreement instead of the tag ... we can configure which agreement gets sent").
 * /agreement opens a form: who (email, phone or GHL contact link) and which of the offer's agreements. The submit is checked inside
 * Slack's three seconds, then `agreement.requested` is raised for that person and the Send agreement workflow sends it, at once,
 * under the offer's mode and send lock like any send; the closer is told in a DM what happened.
 */
export const AGREEMENT_COMMAND = "agreement";
export const AGREEMENT_FORM = "send_agreement";
export type AgreementChoice = { label: string; template: string };
type Meta = { channel?: string };

/** `agreements.list`: [{label, template}], the GHL document templates a closer may send; unset, the offer's one agreement (crm.agreement_template). */
export function agreementChoices(bindings: Record<string, string>): AgreementChoice[] {
  let list: unknown;
  try { list = JSON.parse(bindings["agreements.list"] ?? "null"); } catch { list = null; }
  const own = Array.isArray(list) ? list.filter((x): x is AgreementChoice => !!x && typeof x.label === "string" && !!x.label.trim() && typeof x.template === "string" && !!x.template.trim()).map((x) => ({ label: x.label.trim(), template: x.template.trim() })) : [];
  if (own.length) return own;
  const one = bindings["crm.agreement_template"]?.trim();
  return one ? [{ label: "Purchase agreement", template: one }] : [];
}

export const agreementForm = (choices: AgreementChoice[], meta: Meta) => ({
  type: "modal", callback_id: AGREEMENT_FORM, private_metadata: JSON.stringify(meta),
  title: { type: "plain_text", text: "Send an agreement" }, submit: { type: "plain_text", text: "Send" }, close: { type: "plain_text", text: "Cancel" },
  blocks: [
    { type: "input", block_id: "who", label: { type: "plain_text", text: "Their email, phone, or GHL contact link" }, element: { type: "plain_text_input", action_id: "who", placeholder: { type: "plain_text", text: "rae@example.com" } } },
    { type: "input", block_id: "which", label: { type: "plain_text", text: "Which agreement" }, element: { type: "static_select", action_id: "which",
      options: choices.map((x) => ({ text: { type: "plain_text", text: x.label.slice(0, 75) }, value: x.template })), ...(choices.length === 1 ? { initial_option: { text: { type: "plain_text", text: choices[0].label.slice(0, 75) }, value: choices[0].template } } : {}) } },
  ],
});
export const parseAgreementMeta = (s: string | undefined): Meta => { try { const m = JSON.parse(s ?? "{}") as Meta; return typeof m.channel === "string" ? { channel: m.channel } : {}; } catch { return {}; } };

type Requester = { name: string; ghl_user_id: string | null };
/** Closers, managers, the owner and the operator may send; the requester's GHL user is the sender. */
async function requester(c: PoolClient, companyId: string, slackUser: string): Promise<Requester | null> {
  const u = await one<Requester>(c, "select name, ghl_user_id from users where company_id=$1 and slack_user_id=$2 and active and role in ('owner','manager','closer') order by (role='closer') desc limit 1", [companyId, slackUser]);
  if (u) return u;
  const op = await one<{ value: Buffer }>(c, "select value from bindings where company_id=$1 and key='bot.escalate_to'", [companyId]);
  return op?.value.toString("utf8").trim() === slackUser ? { name: "the operator", ghl_user_id: null } : null;
}

/** The command, before the form opens: who may, and that the offer has an agreement to offer. */
export async function checkAgreementCommand(c: PoolClient, companyId: string, slackUser: string, bindings: Record<string, string>): Promise<{ error: string } | { choices: AgreementChoice[] }> {
  if (!(await requester(c, companyId, slackUser))) return { error: "Only closers, managers and the operator can send agreements." };
  const choices = agreementChoices(bindings);
  return choices.length ? { choices } : { error: "This offer has no agreement set up yet (crm.agreement_template or agreements.list)." };
}

/** The submit, checked before Slack's three seconds are up: an error goes back into the form under the field it is about. */
export async function checkAgreementSubmit(c: PoolClient, companyId: string, slackUser: string, bindings: Record<string, string>, typed: string, template: string):
  Promise<{ errors: Record<string, string> } | { contact: { id: string; name: string }; choice: AgreementChoice; by: Requester }> {
  const by = await requester(c, companyId, slackUser);
  if (!by) return { errors: { who: "Only closers, managers and the operator can send agreements." } };
  const choice = agreementChoices(bindings).find((x) => x.template === template);
  if (!choice) return { errors: { which: "Pick one of the agreements." } };
  const contact = await findContact(c, companyId, typed);
  return contact ? { contact, choice, by } : { errors: { who: "No one in the CRM matches that (or more than one does). Paste their GHL contact link." } };
}

/** After the answer: ask for it, run what that starts now, and tell the closer what came of it. */
export async function requestAgreement(adapters: Adapters, companyId: string, slackUser: string, contact: { id: string; name: string }, choice: AgreementChoice, by: Requester): Promise<string> {
  const runs = await asOperator(async (c) => {
    const ev = await emitEvent(c, { company_id: companyId, contact_id: contact.id, opportunity_id: null, appointment_id: null, event_type: "agreement.requested", source: "slack",
      data: { template: choice.template, label: choice.label, ...(by.ghl_user_id ? { sender: by.ghl_user_id } : {}), by: slackUser, by_name: by.name } });
    return dispatchEvent(c, ev, { contact: { id: contact.id } });
  });
  if (runs.length) await runNow(adapters, companyId);
  const said = runs.length ? await outcome(runs, choice, contact) : `Not sent: no workflow on this offer takes /agreement yet (Send agreement manually needs its update). Nothing went to ${contact.name}.`;
  const bot = await asOperator((c) => slackBot(c, companyId));
  if (bot) await adapters.notifier.post(bot.token, slackUser, said).catch(() => null);
  return said;
}

async function outcome(runIds: string[], choice: AgreementChoice, contact: { name: string }): Promise<string> {
  return asOperator(async (c) => {
    const r = await one<{ status: string; exit_reason: string | null }>(c, "select status, exit_reason from runs where id = any($1::uuid[]) order by started_at limit 1", [runIds]);
    if (r?.exit_reason === "already_signed") return `${contact.name} has already signed. Nothing sent.`;
    const step = (await many<{ status: string; result: Record<string, unknown> | null; error: string | null }>(c, "select s.status, s.result, s.error from run_steps s where s.run_id = any($1::uuid[]) and s.node_id='d1' order by s.id desc limit 1", [runIds]))[0];
    if (step?.result?.document) return `✅ ${choice.label} sent to ${contact.name}.`;
    if (step?.result?.ghost || step?.result?.quiet) return `Not sent: the offer isn't live yet (${step.result.ghost ? "ghost" : "quiet"}), so nothing reaches a contact. It would have sent ${choice.label} to ${contact.name}.`;
    if (step?.result?.would_send_document) return `Not sent: ${String(step.result.why ?? "held")}. It would have sent ${choice.label} to ${contact.name}.`;
    if (step?.error) return `Couldn't send ${choice.label} to ${contact.name}: ${step.error}`;
    return `Asked for ${choice.label} to go to ${contact.name}; it hasn't gone yet (${r?.status ?? "queued"}). It will go on the next minute check.`;
  });
}
