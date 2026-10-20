import type { PoolClient } from "pg";
import { asOperator, many, one } from "@/db/client";
import type { Adapters } from "@/adapters/types";
import { linkPayment } from "../payments";
import { linkRecording } from "../recordings";
import { normEmail, normPhone } from "../identity";
import { slackBot } from "../slack-conn";

/**
 * D193 (Tyler: hand-linking back, as a Slack button). The Unlinked payment and Unmatched recording posts carry "Link to a contact";
 * the press opens a form for their email, phone or GHL contact link, and the submit links the payment or recording to that contact
 * exactly as a match on arrival would (linkPayment, linkRecording), then says so in the post's thread with a ✅ on it. Owners,
 * managers and the operator may link, as with the alert buttons.
 */
export const LINK_ACTIONS = { link_payment: "payment", link_recording: "recording" } as const;
export type LinkKind = (typeof LINK_ACTIONS)[keyof typeof LINK_ACTIONS];
export const LINK_FORM = "link_contact";
type Meta = { kind: LinkKind; id: string; channel?: string; ts?: string };

export const linkForm = (meta: Meta) => ({
  type: "modal", callback_id: LINK_FORM, private_metadata: JSON.stringify(meta),
  title: { type: "plain_text", text: "Link to a contact" }, submit: { type: "plain_text", text: "Link" }, close: { type: "plain_text", text: "Cancel" },
  blocks: [{ type: "input", block_id: "who", label: { type: "plain_text", text: "Their email, phone, or GHL contact link" },
    element: { type: "plain_text_input", action_id: "who", placeholder: { type: "plain_text", text: "rae@example.com" } } }],
});
export const parseMeta = (s: string | undefined): Meta | null => {
  try { const m = JSON.parse(s ?? "") as Meta; return (m.kind === "payment" || m.kind === "recording") && typeof m.id === "string" ? m : null; } catch { return null; }
};

/** The contact named by what was typed: a GHL contact link or id, an email, or a phone, against the contacts this company keeps. */
export async function findContact(c: PoolClient, companyId: string, typed: string): Promise<{ id: string; name: string } | null> {
  const t = typed.trim();
  const ghl = /\/contacts\/detail\/([A-Za-z0-9]+)/.exec(t)?.[1] ?? (/^[A-Za-z0-9]{15,30}$/.test(t) ? t : null);
  const sql = `select ct.id, trim(coalesce(ct.first_name,'')||' '||coalesce(ct.last_name,'')) as name from contacts ct where ct.company_id=$1 and ct.id in (
    select ct2.id from contacts ct2 where ct2.company_id=$1 and ct2.ghl_contact_id=$2
    union select i.contact_id from contact_identifiers i where i.company_id=$1 and i.retired_at is null and ((i.kind='ghl_contact' and i.value=$2) or (i.kind='email' and i.value=$3) or (i.kind='phone' and i.value=$4)))
    order by ct.id limit 2`;
  const rows = await many<{ id: string; name: string }>(c, sql, [companyId, ghl ?? "", t.includes("@") ? normEmail(t) : "", !t.includes("@") && /\d{7,}/.test(t.replace(/\D/g, "")) ? normPhone(t) ?? "" : ""]);
  return rows.length === 1 ? { id: rows[0].id, name: rows[0].name || "them" } : null;
}

/** The submit, checked before Slack's three seconds are up: an error goes back into the form; otherwise what to link. */
export async function checkSubmit(c: PoolClient, companyId: string, slackUser: string, meta: Meta, typed: string): Promise<{ error: string } | { contact: { id: string; name: string } }> {
  const u = await one<{ role: string }>(c, "select role from users where company_id=$1 and slack_user_id=$2 and active order by (role in ('owner','manager')) desc limit 1", [companyId, slackUser]);
  const op = await one<{ value: Buffer }>(c, "select value from bindings where company_id=$1 and key='bot.escalate_to'", [companyId]);
  if (!(u?.role === "owner" || u?.role === "manager" || op?.value.toString("utf8").trim() === slackUser)) return { error: "Only a manager can link." };
  const row = await one<{ link_status: string }>(c, `select link_status from ${meta.kind === "payment" ? "payments" : "recordings"} where company_id=$1 and id=$2`, [companyId, meta.id]);
  if (!row) return { error: `I can't find that ${meta.kind} any more.` };
  if (row.link_status === "linked") return { error: `That ${meta.kind} is already linked.` };
  const contact = await findContact(c, companyId, typed);
  return contact ? { contact } : { error: "No one in the CRM matches that (or more than one does). Paste their GHL contact link." };
}

/** After the answer: link, then the ✅ and a line in the post's thread. A failure is said in the thread too. */
export async function linkSubmitted(adapters: Adapters, companyId: string, slackUser: string, meta: Meta, contact: { id: string; name: string }): Promise<{ ok: boolean; why?: string }> {
  let ok = true, why: string | undefined;
  try {
    await asOperator(async (c) => { if (meta.kind === "payment") await linkPayment(c, companyId, meta.id, contact.id); else await linkRecording(c, companyId, meta.id, contact.id); });
    await asOperator((c) => c.query("insert into audit_log (company_id, action, target_type, target_id, after) values ($1,$2,$3,$4,$5)", [companyId, `${meta.kind}.linked_in_slack`, meta.kind, meta.id, { contact: contact.id, by: slackUser }]));
  } catch (e) { ok = false; why = String((e as Error).message); }
  const bot = await asOperator((c) => slackBot(c, companyId));
  if (bot && meta.channel && meta.ts) {
    const token = bot.token;
    await adapters.notifier.post(token, meta.channel, ok ? `✅ Linked to ${contact.name} by <@${slackUser}>.` : `Couldn't link it: ${why}.`, undefined, meta.ts).catch(() => null);
    if (ok) await adapters.notifier.react(token, meta.channel, meta.ts, "white_check_mark");
  }
  return ok ? { ok } : { ok, why };
}
