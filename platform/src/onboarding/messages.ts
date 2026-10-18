/**
 * D149 (#49 P1): the wizard's messages step. Every text and email a client's contacts can get, workflow by workflow, with its
 * words as they stand. Each one is approved by Tyler, explicitly: a message whose words are a placeholder cannot be (D118: it
 * sends nothing), nor one carrying another client's words (Tyler: block it; the shipped templates still hold Hair's welcome, so
 * a new client would otherwise go live saying "save your hair"). An approval is of these exact words: changing them takes it
 * back. Words are changed here through the company's own words (D149), so they survive every upgrade and rebuild. A workflow the
 * offer does not use (off in the fit report) needs nothing approved. Done when every message that needs it is approved.
 */
import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { many, one } from "@/db/client";
import { parseDefinition, type Node } from "@/engine/definition";
import { isPlaceholderCopy } from "@/engine/readiness";
import { setWord } from "@/engine/words";
import type { CopyField } from "@/engine/copy";
import type { FitReport } from "./intake";

/** Words that belong to one client and must never reach another's contacts. `owner`: the slugs of the client they belong to. */
export const FOREIGN: { owner: RegExp; label: string; words: RegExp }[] = [
  { owner: /hair|syh/, label: "Hair's", words: /save ?your ?hair|\bhair\b|scalp|follicle|thinning|\ballan\b|clinician|burned[ _]before/gi },
];
export function foreignWords(slug: string, text: string): string[] {
  return FOREIGN.filter((f) => !f.owner.test(slug)).flatMap((f) => [...new Set((text.match(f.words) ?? []).map((m) => `${f.label} "${m}"`))]);
}

export type Message = {
  workflowId: string; workflow: string; slug: string | null; nodeId: string; channel: "sms" | "email"; title: string;
  fields: { field: CopyField; label: string; text: string }[];
  placeholder: boolean; foreign: string[]; needed: boolean; approved: { at: string; by: string } | null;
};
const hashOf = (fields: Message["fields"]) => createHash("sha256").update(JSON.stringify(fields.map((f) => [f.field, f.text]))).digest("hex").slice(0, 32);
const FIELD_LABEL: Record<string, string> = { subject: "Subject", template: "Message", substitute_template: "Instead, when the first is out of date" };

export async function listMessages(c: PoolClient, companyId: string): Promise<{ messages: Message[]; ready: boolean }> {
  const o = await one<{ slug: string; fit: FitReport | null; messages: Record<string, { hash: string; at: string; by: string }> }>(c, "select co.slug, o.fit, o.messages from onboarding o join companies co on co.id=o.company_id where o.company_id=$1", [companyId]);
  if (!o) return { messages: [], ready: false };
  const off = new Set((o.fit?.workflows ?? []).filter((w) => w.fit === "off").map((w) => w.slug));
  const rows = await many<{ id: string; name: string; slug: string | null; definition: unknown }>(c, `select w.id, w.name, t.slug, v.definition from workflows w left join workflow_templates t on t.id=w.template_id
    join workflow_versions v on v.workflow_id=w.id and v.version=w.current_version where w.company_id=$1 order by w.stage nulls last, w.sort, w.name`, [companyId]);
  const messages: Message[] = [];
  for (const r of rows) {
    let def; try { def = parseDefinition(r.definition); } catch { continue; }
    for (const n of def.nodes as (Node & Record<string, unknown>)[]) {
      if (n.type !== "send_sms" && n.type !== "send_email") continue;
      const fields = (["subject", "template", "substitute_template"] as const).filter((f) => typeof n[f] === "string").map((f) => ({ field: f as CopyField, label: FIELD_LABEL[f], text: n[f] as string }));
      const all = fields.map((f) => f.text).join("\n");
      const key = `${r.id}:${n.id}`, a = o.messages[key];
      messages.push({ workflowId: r.id, workflow: r.name, slug: r.slug, nodeId: n.id, channel: n.type === "send_sms" ? "sms" : "email", title: String(n.title ?? (n.type === "send_sms" ? "Text" : "Email")),
        fields, placeholder: fields.some((f) => isPlaceholderCopy(f.text)), foreign: foreignWords(o.slug, all), needed: !(r.slug && off.has(r.slug)),
        approved: a && a.hash === hashOf(fields) ? { at: a.at, by: a.by } : null });
    }
  }
  return { messages, ready: messages.filter((m) => m.needed).every((m) => m.approved) };
}

export type MessageResult = { ok: true } | { ok: false; status: number; why: string };

/** These exact words, approved; refused while they are a placeholder or carry another client's words. */
export async function approveMessage(c: PoolClient, companyId: string, args: { workflowId?: unknown; nodeId?: unknown; by?: string }): Promise<MessageResult> {
  const { messages } = await listMessages(c, companyId);
  const m = messages.find((x) => x.workflowId === args.workflowId && x.nodeId === args.nodeId);
  if (!m) return { ok: false, status: 404, why: "no such message" };
  if (m.placeholder) return { ok: false, status: 422, why: `"${m.title}" in ${m.workflow} is still a placeholder: write its words first` };
  if (m.foreign.length) return { ok: false, status: 422, why: `"${m.title}" in ${m.workflow} carries another client's words (${m.foreign.join(", ")}): change them first` };
  await c.query("update onboarding set messages = messages || jsonb_build_object($2::text, jsonb_build_object('hash', $3::text, 'at', now(), 'by', $4::text)) where company_id=$1", [companyId, `${m.workflowId}:${m.nodeId}`, hashOf(m.fields), args.by ?? "dashboard"]);
  await markStep(c, companyId, args.by ?? "dashboard");
  return { ok: true };
}

/** A message's words changed (kept as the company's own words, D149); the approval of the old words no longer counts. */
export async function editMessage(c: PoolClient, companyId: string, args: { workflowId?: unknown; nodeId?: unknown; field?: unknown; text?: unknown; by?: string }): Promise<MessageResult> {
  const w = await one(c, "select 1 from workflows where id=$1 and company_id=$2", [String(args.workflowId), companyId]);
  if (!w) return { ok: false, status: 404, why: "no such workflow on this company" };
  if (!["subject", "template", "substitute_template"].includes(String(args.field))) return { ok: false, status: 400, why: "field: subject, template or substitute_template" };
  const r = await setWord(c, { workflowId: String(args.workflowId), nodeId: String(args.nodeId), field: args.field as CopyField, text: String(args.text ?? ""), by: args.by });
  if (!r.ok) return { ok: false, status: 422, why: r.why };
  await markStep(c, companyId, args.by ?? "dashboard");
  return { ok: true };
}

async function markStep(c: PoolClient, companyId: string, by: string) {
  const { ready } = await listMessages(c, companyId);
  if (ready) await c.query("update onboarding set steps = steps || jsonb_build_object('messages', jsonb_build_object('done_at', now(), 'by', $2::text)) where company_id=$1 and not steps ? 'messages'", [companyId, by]);
  else await c.query("update onboarding set steps = steps - 'messages' where company_id=$1", [companyId]);
}
