import type { PoolClient } from "pg";
import { asOperator, many, one } from "@/db/client";
import type { Adapters } from "@/adapters/types";
import { dispatchEvent, emitEvent } from "../dispatch";
import { runNow } from "../runner";
import { slackBot } from "../slack-conn";
import { findContact } from "./slack-link";

/**
 * D202 (Tyler: "a slack slash command for instant agreement instead of the tag ... we can configure which agreement gets sent").
 * D214 (Tyler: "agreement email 12k guarantee" sends; "agreement email" asks which; "agreement 12k guarantee" asks who): the who
 * and the which come in either order. `<who>` is a GHL contact link, an email or a phone (exact: sent at once) or a full name (one
 * match only; asked to confirm first). The which is any of the agreement's phrases (its key, its label, the offer's `match` list),
 * word for word in any order, read the same way everywhere ("$12,000" = "12,000" = "12k", "guaranteed" = "guarantee"): one
 * agreement fits exactly, it is that one; words that fit several are offered as buttons. Without a which, a button for each of the
 * offer's agreements (one agreement: that one); without a who, a form asking who, the agreement already picked. Sending is the Send
 * agreement workflow's (`agreement.requested`), at once, under the offer's mode and send lock like any send; what came of it is said
 * back to the closer.
 */
export const AGREEMENT_COMMAND = "agreement";
export const AGREEMENT_FORM = "send_agreement";
/** `phrases`: what a closer may type for it (its key, its label, the offer's `match`), each as its words. */
export type AgreementChoice = { key: string; label: string; template: string; phrases: string[][] };
type Meta = { channel?: string };
export type Who = { id: string; name: string; email: string | null };
type Requester = { name: string; ghl_user_id: string | null };

const NOT = new Set(["no", "non", "without"]);
const FILLER = new Set(["a", "an", "the", "and", "with", "w", "plus", "for", "to", "send", "agreement", "contract"]);
/** A phrase's words, read one way: money as plain digits ("$12,000", "12k" → 12000), a trailing "s" or "ed" ("guaranteed" → guarantee), "no X" as one word, no filler. */
export function phraseWords(text: string): string[] {
  const norm = text.toLowerCase().replace(/(\d),(?=\d{3}\b)/g, "$1").replace(/(\d+(?:\.\d+)?)\s*k\b/g, (_, n: string) => String(Math.round(parseFloat(n) * 1000)));
  const words = norm.split(/[^a-z0-9]+/).filter(Boolean).map((w) => (/^[a-z]{4,}$/.test(w) ? w.replace(/(?<=e)d$|(?<!s)s$/, "") : w)).filter((w) => !FILLER.has(w));
  // "no guarantee" is one word, so it never reads as "guarantee"
  const out: string[] = [];
  for (let i = 0; i < words.length; i++) out.push(NOT.has(words[i]) && i + 1 < words.length ? `no-${words[++i]}` : words[i]);
  return out;
}
const sameWords = (a: string[], b: string[]) => a.length === b.length && a.every((w) => b.includes(w)) && b.every((w) => a.includes(w));

/** `agreements.list`: [{label, template, key?, match?}], the GHL document templates a closer may send; unset, the offer's one agreement (crm.agreement_template). */
export function agreementChoices(bindings: Record<string, string>): AgreementChoice[] {
  let list: unknown;
  try { list = JSON.parse(bindings["agreements.list"] ?? "null"); } catch { list = null; }
  const ok = Array.isArray(list) ? list.filter((x): x is { label: string; template: string; key?: string; match?: unknown } => !!x && typeof x.label === "string" && !!x.label.trim() && typeof x.template === "string" && !!x.template.trim()) : [];
  const out: AgreementChoice[] = [];
  for (const x of ok) {
    // a key as written ("12k-g"); none, the label's first word ("Deposit agreement" → deposit)
    let key = (typeof x.key === "string" && x.key.trim() ? x.key.trim().toLowerCase().replace(/\s+/g, "-") : x.label.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(" ")[0]) || "agreement";
    if (out.some((o) => o.key === key)) key = `${key}-${out.length + 1}`;
    const said = [key, x.label, ...(Array.isArray(x.match) ? x.match.filter((m): m is string => typeof m === "string") : [])];
    out.push({ key, label: x.label.trim(), template: x.template.trim(), phrases: said.map(phraseWords).filter((w) => w.length) });
  }
  if (out.length) return out;
  const one = bindings["crm.agreement_template"]?.trim();
  return one ? [{ key: "purchase", label: "Purchase agreement", template: one, phrases: [["purchase"]] }] : [];
}

/** The agreements some typed words name: the ones a phrase of which they are exactly, else the ones a phrase of which holds every word. */
function fits(words: string[], choices: AgreementChoice[]): { exact: AgreementChoice[]; some: AgreementChoice[] } {
  if (!words.length) return { exact: [], some: [] };
  return { exact: choices.filter((x) => x.phrases.some((p) => sameWords(p, words))), some: choices.filter((x) => x.phrases.some((p) => words.every((w) => p.includes(w)))) };
}

/** Slack may hand back an email, phone or link it formatted (`<mailto:rae@x.com|rae@x.com>`): the address itself. */
export const unlinked = (text: string) => text.replace(/<(?:mailto:|tel:)?([^|>]+)(?:\|[^>]*)?>/g, "$1");

/**
 * The command's words: the which is the longest run at the start or the end of them that names an agreement (exactly one, else
 * several to choose from); the rest, filler aside, is the who. Nothing that names an agreement: all of it is the who.
 */
export function parseAgreementText(text: string, choices: AgreementChoice[]): { who: string; choice?: AgreementChoice; candidates?: AgreementChoice[] } {
  const raw = text.trim().split(/\s+/).filter(Boolean);
  const who = (ws: string[]) => { const w = [...ws]; while (w.length && FILLER.has(w[0].toLowerCase())) w.shift(); while (w.length && FILLER.has(w.at(-1)!.toLowerCase())) w.pop(); return w.join(" "); };
  let best: { who: string; exact: AgreementChoice[]; some: AgreementChoice[]; n: number } | null = null;
  for (let n = raw.length; n >= 1; n--) {
    for (const [span, rest] of [[raw.slice(raw.length - n), raw.slice(0, raw.length - n)], [raw.slice(0, n), raw.slice(n)]] as const) {
      const f = fits(phraseWords(span.join(" ")), choices);
      if (f.exact.length === 1) return { who: who([...rest]), choice: f.exact[0] };
      if (!best && f.some.length) best = { who: who([...rest]), ...f, n };
    }
  }
  if (best) return best.some.length === 1 ? { who: best.who, choice: best.some[0] } : { who: best.who, candidates: best.some };
  return { who: who(raw) };
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

// action_ids differ (agreement_send:<n>): Slack refuses a message whose buttons share one
const sendButton = (p: Who, x: AgreementChoice, text: string, n = 0) => ({ type: "button", text: { type: "plain_text", text: text.slice(0, 75) }, action_id: `agreement_send:${n}`, value: JSON.stringify({ c: p.id, t: x.template }), style: "primary" });
const cancelButton = { type: "button", text: { type: "plain_text", text: "Cancel" }, action_id: "agreement_cancel", value: "cancel" };
const ask = (text: string, buttons: unknown[]) => ({ response_type: "ephemeral", text, blocks: [{ type: "section", text: { type: "mrkdwn", text } }, { type: "actions", elements: buttons }] });

export type CommandAnswer =
  | { say: Record<string, unknown>; send?: undefined; form?: undefined }
  | { form: AgreementChoice[]; picked?: AgreementChoice; say?: undefined; send?: undefined }
  | { send: { contact: Who; choice: AgreementChoice; by: Requester }; say: Record<string, unknown>; form?: undefined };

/** The command, answered inside Slack's three seconds (a DB read only; any sending happens after the answer). */
export async function answerAgreementCommand(c: PoolClient, companyId: string, slackUser: string, bindings: Record<string, string>, text: string): Promise<CommandAnswer> {
  const by = await requester(c, companyId, slackUser);
  if (!by) return { say: { response_type: "ephemeral", text: NOT_ALLOWED } };
  const choices = agreementChoices(bindings);
  if (!choices.length) return { say: { response_type: "ephemeral", text: "This offer has no agreement set up yet (crm.agreement_template or agreements.list)." } };
  const { who, choice, candidates } = parseAgreementText(unlinked(text), choices);
  if (!who) return { form: choices, ...(choice ? { picked: choice } : {}) };
  const r = await resolveWho(c, companyId, who);
  if ("none" in r) return { say: { response_type: "ephemeral", text: NO_ONE(who) } };
  if ("many" in r) return { say: { response_type: "ephemeral", text: `More than one person is "${who}":\n${r.many.map((p) => `• ${named(p)}`).join("\n")}\nUse their email or GHL contact link. Nothing was sent.` } };
  const pick = choice ?? (choices.length === 1 ? choices[0] : undefined);
  if (!pick) return { say: ask(`Which agreement for ${named(r.found)}?`, [...(candidates ?? choices).map((x, n) => sendButton(r.found, x, `Send ${x.label}`, n)), cancelButton]) };
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

/** The form: who (and which, already picked when the command named it or the offer has one). */
export const agreementForm = (choices: AgreementChoice[], meta: Meta, picked?: AgreementChoice) => {
  const pre = picked ?? (choices.length === 1 ? choices[0] : undefined);
  const option = (x: AgreementChoice) => ({ text: { type: "plain_text", text: x.label.slice(0, 75) }, value: x.template });
  return {
    type: "modal", callback_id: AGREEMENT_FORM, private_metadata: JSON.stringify(meta),
    title: { type: "plain_text", text: "Send an agreement" }, submit: { type: "plain_text", text: "Send" }, close: { type: "plain_text", text: "Cancel" },
    blocks: [
      { type: "input", block_id: "who", label: { type: "plain_text", text: pre && picked ? `Who do you want to send ${pre.label} to?`.slice(0, 150) : "Who do you want to send it to?" }, hint: { type: "plain_text", text: "Their full name, email, phone or GHL contact link" }, element: { type: "plain_text_input", action_id: "who", placeholder: { type: "plain_text", text: "rae@example.com" } } },
      { type: "input", block_id: "which", label: { type: "plain_text", text: "Which agreement" }, element: { type: "static_select", action_id: "which", options: choices.map(option), ...(pre ? { initial_option: option(pre) } : {}) } },
    ],
  };
};

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
    if (step?.result?.document) {
      // a closer may send another, or a different one, to someone who signed before: said, so it is never a surprise
      const signed = await one<{ at: Date }>(c, "select max(signed_at) as at from agreements where contact_id=$1 and signed_at is not null and external_id is distinct from $2", [contact.id, String(step.result.document)]);
      return `✅ ${choice.label} sent to ${named(contact)}.${signed?.at ? ` (They signed an earlier agreement on ${signed.at.toISOString().slice(0, 10)}.)` : ""}`;
    }
    if (step?.result?.ghost || step?.result?.quiet) return `Not sent: the offer isn't live yet (${step.result.ghost ? "ghost" : "quiet"}), so nothing reaches a contact. It would have sent ${choice.label} to ${contact.name}.`;
    if (step?.result?.would_send_document) return `Not sent: ${String(step.result.why ?? "held")}. It would have sent ${choice.label} to ${contact.name}.`;
    if (step?.error) return `Couldn't send ${choice.label} to ${contact.name}: ${step.error}`;
    return `${choice.label} for ${contact.name} hasn't gone yet (${r?.status ?? "queued"}); the minute check will send it.`;
  });
}
