import type { PoolClient } from "pg";
import { asOperator, many, one } from "@/db/client";
import type { Adapters } from "@/adapters/types";
import { dispatchEvent, emitEvent } from "../dispatch";
import { runNow } from "../runner";
import { slackBot } from "../slack-conn";
import { findContact } from "./slack-link";

/**
 * D202 (Tyler: "a slack slash command for instant agreement instead of the tag ... we can configure which agreement gets sent").
 * `/agreement <who> <type>` sends that agreement to that person; `<who>` is a GHL contact link, an email or a phone (exact: sent
 * at once) or a full name (one match only; asked to confirm first). Without `<type>`, a button for each of the offer's agreements
 * (one agreement: that one). Without anything, a form. Sending is the Send agreement workflow's (`agreement.requested`), at once,
 * under the offer's mode and send lock like any send; what came of it is said back to the closer.
 */
export const AGREEMENT_COMMAND = "agreement";
export const AGREEMENT_FORM = "send_agreement";
/** `key`: the word after the person in the command (`/agreement rae@x.com deposit`). */
export type AgreementChoice = { key: string; label: string; template: string };
type Meta = { channel?: string };
export type Who = { id: string; name: string; email: string | null };
type Requester = { name: string; ghl_user_id: string | null };

const word = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(" ")[0] ?? "";
/** `agreements.list`: [{label, template, key?}], the GHL document templates a closer may send; unset, the offer's one agreement (crm.agreement_template). */
export function agreementChoices(bindings: Record<string, string>): AgreementChoice[] {
  let list: unknown;
  try { list = JSON.parse(bindings["agreements.list"] ?? "null"); } catch { list = null; }
  const ok = Array.isArray(list) ? list.filter((x): x is { label: string; template: string; key?: string } => !!x && typeof x.label === "string" && !!x.label.trim() && typeof x.template === "string" && !!x.template.trim()) : [];
  const out: AgreementChoice[] = [];
  for (const x of ok) {
    let key = word(typeof x.key === "string" && x.key.trim() ? x.key : x.label) || "agreement";
    if (out.some((o) => o.key === key)) key = `${key}${out.length + 1}`;
    out.push({ key, label: x.label.trim(), template: x.template.trim() });
  }
  if (out.length) return out;
  const one = bindings["crm.agreement_template"]?.trim();
  return one ? [{ key: "purchase", label: "Purchase agreement", template: one }] : [];
}

/** The command's words: who, then (if its last word is one of the offer's agreement keys) which. */
export function parseAgreementText(text: string, choices: AgreementChoice[]): { who: string; choice?: AgreementChoice } {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const last = words.at(-1)?.toLowerCase();
  const choice = words.length > 1 ? choices.find((c) => c.key === last) : undefined;
  return { who: (choice ? words.slice(0, -1) : words).join(" "), ...(choice ? { choice } : {}) };
}

const WHO_SQL = `select ct.id, trim(coalesce(ct.first_name,'')||' '||coalesce(ct.last_name,'')) as name,
    (select i.value from contact_identifiers i where i.company_id=ct.company_id and i.contact_id=ct.id and i.kind='email' and i.retired_at is null order by i.value limit 1) as email
  from contacts ct where ct.company_id=$1 and ct.id = any($2::uuid[]) and ct.merged_into is null and ct.gone_at is null order by 2, 3`;

/** An email, phone or GHL link/id names one contact exactly; anything else is a full name, which must fit exactly one. */
export async function resolveWho(c: PoolClient, companyId: string, typed: string): Promise<{ found: Who; exact: boolean } | { none: true } | { many: Who[] }> {
  const t = typed.trim();
  const exact = t.includes("@") || /\/contacts\/detail\//.test(t) || /^[A-Za-z0-9]{15,30}$/.test(t) || /\d{7,}/.test(t.replace(/\D/g, ""));
  let ids: string[];
  if (exact) { const hit = await findContact(c, companyId, t); ids = hit ? [hit.id] : []; }
  else ids = (await many<{ id: string }>(c, `select id from contacts where company_id=$1 and merged_into is null and gone_at is null
      and lower(regexp_replace(trim(coalesce(first_name,'')||' '||coalesce(last_name,'')), '\\s+', ' ', 'g')) = lower(regexp_replace($2, '\\s+', ' ', 'g')) order by id limit 6`, [companyId, t])).map((r) => r.id);
  if (!ids.length) return { none: true };
  const people = await many<Who>(c, WHO_SQL, [companyId, ids]);
  if (!people.length) return { none: true };
  return people.length === 1 ? { found: { ...people[0], name: people[0].name || "them" }, exact } : { many: people };
}

/** Closers, managers, the owner and the operator may send; the requester's GHL user is the sender. */
async function requester(c: PoolClient, companyId: string, slackUser: string): Promise<Requester | null> {
  const u = await one<Requester>(c, "select name, ghl_user_id from users where company_id=$1 and slack_user_id=$2 and active and role in ('owner','manager','closer') order by (role='closer') desc limit 1", [companyId, slackUser]);
  if (u) return u;
  const op = await one<{ value: Buffer }>(c, "select value from bindings where company_id=$1 and key='bot.escalate_to'", [companyId]);
  return op?.value.toString("utf8").trim() === slackUser ? { name: "the operator", ghl_user_id: null } : null;
}
const NOT_ALLOWED = "Only closers, managers and the operator can send agreements.";
const NO_ONE = (who: string) => `No one in the CRM matches "${who}". Use their full name, email, phone or GHL contact link.`;
const named = (p: Who) => `${p.name}${p.email ? ` (${p.email})` : ""}`;

const sendButton = (p: Who, x: AgreementChoice, text: string) => ({ type: "button", text: { type: "plain_text", text: text.slice(0, 75) }, action_id: "agreement_send", value: JSON.stringify({ c: p.id, t: x.template }), style: "primary" });
const cancelButton = { type: "button", text: { type: "plain_text", text: "Cancel" }, action_id: "agreement_cancel", value: "cancel" };
const ask = (text: string, buttons: unknown[]) => ({ response_type: "ephemeral", text, blocks: [{ type: "section", text: { type: "mrkdwn", text } }, { type: "actions", elements: buttons }] });

export type CommandAnswer =
  | { say: Record<string, unknown>; send?: undefined; form?: undefined }
  | { form: AgreementChoice[]; say?: undefined; send?: undefined }
  | { send: { contact: Who; choice: AgreementChoice; by: Requester }; say: Record<string, unknown>; form?: undefined };

/** The command, answered inside Slack's three seconds (a DB read only; any sending happens after the answer). */
export async function answerAgreementCommand(c: PoolClient, companyId: string, slackUser: string, bindings: Record<string, string>, text: string): Promise<CommandAnswer> {
  const by = await requester(c, companyId, slackUser);
  if (!by) return { say: { response_type: "ephemeral", text: NOT_ALLOWED } };
  const choices = agreementChoices(bindings);
  if (!choices.length) return { say: { response_type: "ephemeral", text: "This offer has no agreement set up yet (crm.agreement_template or agreements.list)." } };
  const { who, choice } = parseAgreementText(text, choices);
  if (!who) return { form: choices };
  const r = await resolveWho(c, companyId, who);
  if ("none" in r) return { say: { response_type: "ephemeral", text: NO_ONE(who) } };
  if ("many" in r) return { say: { response_type: "ephemeral", text: `More than one person is "${who}":\n${r.many.map((p) => `• ${named(p)}`).join("\n")}\nUse their email or GHL contact link. Nothing was sent.` } };
  const pick = choice ?? (choices.length === 1 ? choices[0] : undefined);
  if (!pick) return { say: ask(`Which agreement for ${named(r.found)}?`, [...choices.map((x) => sendButton(r.found, x, `Send ${x.label}`)), cancelButton]) };
  if (!r.exact) return { say: ask(`Send ${pick.label} to ${named(r.found)}?`, [sendButton(r.found, pick, "Send"), cancelButton]) };
  return { send: { contact: r.found, choice: pick, by }, say: { response_type: "ephemeral", text: `Sending ${pick.label} to ${named(r.found)}…` } };
}

/** A Send button from the command's answer: checked again (who pressed, that agreement, that person) before anything goes. */
export async function checkAgreementPress(c: PoolClient, companyId: string, slackUser: string, bindings: Record<string, string>, value: string): Promise<{ say: string } | { contact: Who; choice: AgreementChoice; by: Requester }> {
  const by = await requester(c, companyId, slackUser);
  if (!by) return { say: NOT_ALLOWED };
  let v: { c?: unknown; t?: unknown } = {};
  try { v = JSON.parse(value) as typeof v; } catch { return { say: "That button is out of date. Run /agreement again." }; }
  const choice = agreementChoices(bindings).find((x) => x.template === v.t);
  const uuid = typeof v.c === "string" && /^[0-9a-f-]{36}$/i.test(v.c) ? v.c : null;
  const contact = uuid ? (await many<Who>(c, WHO_SQL, [companyId, [uuid]]))[0] : undefined;
  if (!choice || !contact) return { say: "That agreement or person isn't there any more. Run /agreement again." };
  return { contact: { ...contact, name: contact.name || "them" }, choice, by };
}

export const agreementForm = (choices: AgreementChoice[], meta: Meta) => ({
  type: "modal", callback_id: AGREEMENT_FORM, private_metadata: JSON.stringify(meta),
  title: { type: "plain_text", text: "Send an agreement" }, submit: { type: "plain_text", text: "Send" }, close: { type: "plain_text", text: "Cancel" },
  blocks: [
    { type: "input", block_id: "who", label: { type: "plain_text", text: "Their full name, email, phone, or GHL contact link" }, element: { type: "plain_text_input", action_id: "who", placeholder: { type: "plain_text", text: "rae@example.com" } } },
    { type: "input", block_id: "which", label: { type: "plain_text", text: "Which agreement" }, element: { type: "static_select", action_id: "which",
      options: choices.map((x) => ({ text: { type: "plain_text", text: x.label.slice(0, 75) }, value: x.template })), ...(choices.length === 1 ? { initial_option: { text: { type: "plain_text", text: choices[0].label.slice(0, 75) }, value: choices[0].template } } : {}) } },
  ],
});

/** The form sent back (its Send is the confirmation): checked before Slack's three seconds are up; an error goes back under its field. */
export async function checkAgreementSubmit(c: PoolClient, companyId: string, slackUser: string, bindings: Record<string, string>, typed: string, template: string):
  Promise<{ errors: Record<string, string> } | { contact: Who; choice: AgreementChoice; by: Requester }> {
  const by = await requester(c, companyId, slackUser);
  if (!by) return { errors: { who: NOT_ALLOWED } };
  const choice = agreementChoices(bindings).find((x) => x.template === template);
  if (!choice) return { errors: { which: "Pick one of the agreements." } };
  const r = await resolveWho(c, companyId, typed);
  if ("none" in r) return { errors: { who: NO_ONE(typed.trim()) } };
  if ("many" in r) return { errors: { who: `More than one person has that name (${r.many.map(named).join("; ")}). Use their email or GHL contact link.` } };
  return { contact: r.found, choice, by };
}

/** Send it (the Send agreement workflow, at once) and say what came of it: through `reply` (the command's own answer), else a DM. */
export async function requestAgreement(adapters: Adapters, companyId: string, slackUser: string, contact: Who, choice: AgreementChoice, by: Requester, reply?: (text: string) => Promise<void>): Promise<string> {
  const runs = await asOperator(async (c) => {
    const ev = await emitEvent(c, { company_id: companyId, contact_id: contact.id, opportunity_id: null, appointment_id: null, event_type: "agreement.requested", source: "slack",
      data: { template: choice.template, label: choice.label, ...(by.ghl_user_id ? { sender: by.ghl_user_id } : {}), by: slackUser, by_name: by.name } });
    return dispatchEvent(c, ev, { contact: { id: contact.id } });
  });
  if (runs.length) await runNow(adapters, companyId);
  const said = runs.length ? await outcome(runs, choice, contact) : `Not sent: no workflow on this offer takes /agreement yet (Send agreement manually needs its update). Nothing went to ${contact.name}.`;
  if (reply) await reply(said).catch(() => null);
  else { const bot = await asOperator((c) => slackBot(c, companyId)); if (bot) await adapters.notifier.post(bot.token, slackUser, said).catch(() => null); }
  return said;
}

async function outcome(runIds: string[], choice: AgreementChoice, contact: Who): Promise<string> {
  return asOperator(async (c) => {
    const r = await one<{ status: string; exit_reason: string | null }>(c, "select status, exit_reason from runs where id = any($1::uuid[]) order by started_at limit 1", [runIds]);
    if (r?.exit_reason === "already_signed") return `${contact.name} has already signed. Nothing sent.`;
    const step = await one<{ result: Record<string, unknown> | null; error: string | null }>(c, "select s.result, s.error from run_steps s where s.run_id = any($1::uuid[]) and s.node_id='d1' order by s.id desc limit 1", [runIds]);
    if (step?.result?.document) return `✅ ${choice.label} sent to ${named(contact)}.`;
    if (step?.result?.ghost || step?.result?.quiet) return `Not sent: the offer isn't live yet (${step.result.ghost ? "ghost" : "quiet"}), so nothing reaches a contact. It would have sent ${choice.label} to ${contact.name}.`;
    if (step?.result?.would_send_document) return `Not sent: ${String(step.result.why ?? "held")}. It would have sent ${choice.label} to ${contact.name}.`;
    if (step?.error) return `Couldn't send ${choice.label} to ${contact.name}: ${step.error}`;
    return `${choice.label} for ${contact.name} hasn't gone yet (${r?.status ?? "queued"}); the minute check will send it.`;
  });
}
