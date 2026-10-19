import type { PoolClient } from "pg";
import { many, one } from "@/db/client";
import type { Adapters, Company } from "@/adapters/types";

/**
 * D145 (Tyler: "I want the SMS lock as well. I'm the only one who can unlock sends."): a second guard, apart from the mode.
 * Every workflow starts with its sends locked; a locked workflow's text, email, agreement or outbound webhook goes only to an
 * operator's own address, checked against the contact as the CRM holds it at the moment of sending (the CRM sends to the phone
 * and email it has, not the replica's). Anything that cannot be checked is not sent.
 */
export type LockChannel = "sms" | "email" | "document" | "webhook";
export type LockVerdict = { ok: true; unlocked: boolean } | { ok: false; why: string; retry?: boolean };

export const normEmail = (e: string) => e.trim().toLowerCase();
/** E.164 for a US/CA number written any way (602-555-0199, (602) 555 0199, +16025550199); anything else as +digits. */
export function normPhone(p: string): string {
  const digits = p.replace(/\D/g, "");
  return digits.length === 10 ? `+1${digits}` : `+${digits}`;
}

export async function operatorAddresses(c: PoolClient): Promise<{ emails: Set<string>; phones: Set<string> }> {
  const rows = await many<{ kind: string; value: string }>(c, "select i.kind, i.value from person_identities i join people p on p.id=i.person_id where p.operator and i.kind in ('email','phone')");
  return { emails: new Set(rows.filter((r) => r.kind === "email").map((r) => r.value)), phones: new Set(rows.filter((r) => r.kind === "phone").map((r) => r.value)) };
}

export async function sendsUnlocked(c: PoolClient, workflowId: string): Promise<boolean> {
  return !!(await one<{ at: Date | null }>(c, "select sends_unlocked_at as at from workflows where id=$1", [workflowId]))?.at;
}

export async function checkSendLock(c: PoolClient, x: { adapters: Adapters; company: Company; workflowId: string; ghlContactId: string | null | undefined; channel: LockChannel }): Promise<LockVerdict> {
  if (await sendsUnlocked(c, x.workflowId)) return { ok: true, unlocked: true };
  const locked = "sends locked (D145): only Tyler's own addresses get anything until Tyler unlocks this workflow";
  if (!x.ghlContactId) return { ok: false, why: `${locked}; this run has no CRM contact to check` };
  let live;
  try { live = await x.adapters.read.getContact(x.company, x.ghlContactId); }
  catch (e) { return { ok: false, why: `${locked}; the CRM could not be asked who this is: ${String((e as Error).message).slice(0, 160)}`, retry: true }; }
  if (!live) return { ok: false, why: `${locked}; the CRM has no such contact` };
  const ops = await operatorAddresses(c);
  const email = live.email ? normEmail(live.email) : null, phone = live.phone ? normPhone(live.phone) : null;
  const byEmail = !!email && ops.emails.has(email), byPhone = !!phone && ops.phones.has(phone);
  const pass = x.channel === "sms" ? byPhone : x.channel === "webhook" ? byEmail || byPhone : byEmail;
  return pass ? { ok: true, unlocked: false } : { ok: false, why: `${locked}; ${x.channel === "sms" ? `the CRM's phone for this contact is not his` : x.channel === "webhook" ? "this contact is not him" : `the CRM's email for this contact is not his`}` };
}

/** The operator's addresses, added or removed (app/api/admin/people/operator). One operator person, made on first use. */
export async function setOperatorAddresses(c: PoolClient, x: { name?: string; add?: { emails?: string[]; phones?: string[] }; remove?: { emails?: string[]; phones?: string[] } }): Promise<{ emails: string[]; phones: string[] }> {
  const bad = [...(x.add?.emails ?? []), ...(x.remove?.emails ?? [])].find((e) => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e.trim()));
  if (bad) throw new Error(`not an email: ${bad}`);
  const badPhone = [...(x.add?.phones ?? []), ...(x.remove?.phones ?? [])].find((p) => normPhone(p).length < 11);
  if (badPhone) throw new Error(`not a phone number: ${badPhone}`);
  let op = await one<{ id: string }>(c, "select id from people where operator order by created_at limit 1");
  if (!op) op = await one<{ id: string }>(c, "insert into people (name, operator) values ($1, true) returning id", [x.name?.trim() || "Operator"]);
  const before = await operatorAddresses(c);
  for (const [kind, list, norm] of [["email", x.add?.emails, normEmail], ["phone", x.add?.phones, normPhone]] as const)
    for (const v of list ?? []) {
      const taken = await one<{ person_id: string }>(c, "select person_id from person_identities where kind=$1 and value=$2 and workspace=''", [kind, norm(v)]);
      if (taken && taken.person_id !== op!.id) throw new Error(`${norm(v)} already belongs to someone else on the roster`);
      if (!taken) await c.query("insert into person_identities (person_id, kind, value) values ($1,$2,$3)", [op!.id, kind, norm(v)]);
    }
  for (const [kind, list, norm] of [["email", x.remove?.emails, normEmail], ["phone", x.remove?.phones, normPhone]] as const)
    for (const v of list ?? []) await c.query("delete from person_identities where person_id=$1 and kind=$2 and value=$3", [op!.id, kind, norm(v)]);
  const after = await operatorAddresses(c);
  const out = { emails: [...after.emails].sort(), phones: [...after.phones].sort() };
  await c.query("insert into audit_log (action, target_type, target_id, before, after) values ('operator.addresses','person',$1,$2,$3)", [op!.id, { emails: [...before.emails].sort(), phones: [...before.phones].sort() }, out]);
  return out;
}

/**
 * Lock or unlock one workflow's sends (app/api/admin/workflows/sends). `confirm` must repeat "<company slug>/<workflow name>"
 * exactly: an unlock is never a by-product of another call, and never more than one workflow.
 */
export async function setSendLock(c: PoolClient, x: { company: string; workflow: string; unlock: boolean; confirm: string; by: string }): Promise<{ ok: true; workflow: string; unlocked: boolean; changed: boolean } | { ok: false; status: number; error: string }> {
  const co = await one<{ id: string }>(c, "select id from companies where slug=$1", [x.company]);
  if (!co) return { ok: false, status: 404, error: "no such company" };
  const wfs = await many<{ id: string; name: string; at: Date | null }>(c, "select w.id, w.name, w.sends_unlocked_at as at from workflows w left join workflow_templates t on t.id=w.template_id where w.company_id=$1 and (t.slug=$2 or lower(w.name)=lower($2))", [co.id, x.workflow]);
  if (wfs.length !== 1) return { ok: false, status: 404, error: wfs.length ? "ambiguous workflow name" : "no such workflow for this company" };
  const w = wfs[0];
  if (x.confirm !== `${x.company}/${w.name}`) return { ok: false, status: 400, error: `confirm must be exactly "${x.company}/${w.name}"` };
  if (!x.by?.trim()) return { ok: false, status: 400, error: "by is required (who said to)" };
  const changed = !!w.at !== x.unlock;
  if (changed) {
    await c.query("update workflows set sends_unlocked_at=$2, sends_unlocked_by=$3 where id=$1", [w.id, x.unlock ? new Date() : null, x.unlock ? x.by.trim() : null]);
    await c.query("insert into audit_log (company_id, action, target_type, target_id, before, after) values ($1,$2,'workflow',$3,$4,$5)", [co.id, x.unlock ? "workflow.sends_unlocked" : "workflow.sends_locked", w.id, { unlocked: !!w.at }, { unlocked: x.unlock, by: x.by.trim() }]);
  }
  return { ok: true, workflow: w.name, unlocked: x.unlock, changed };
}
