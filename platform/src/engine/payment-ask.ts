/**
 * D331: "Is this a full first payment or a deposit?" (Tyler, 2026-11-11: a first payment under the deposit line whose product doesn't
 * say "deposit" is asked about in Slack). The payment is held as a deposit until someone answers:
 *   - Deposit: it stays a deposit, and the question says who answered.
 *   - Full first payment: it is the first payment of a plan (an installment), not a deposit. The ledger, the deal, the GHL Cash record,
 *     the closer card and the payment's event are put right (`setPaymentKind`), and the workflows that took the payment run again for
 *     it, quietly (D326: they write, they tell no one), so the deal is won and tagged as a plan's first payment would have made it.
 * Only the offer's managers and its operator (`bot.escalate_to`) answer, as for the other money buttons (D200).
 */
import type { PoolClient } from "pg";
import { many, one } from "@/db/client";
import type { Adapters } from "@/adapters/types";
import { loadCompany } from "./context";
import { setPaymentKind } from "./payment-kind";
import { dispatchEvent, eventMatchContext, workflowTakes, type EventRow } from "./dispatch";

export const PAYMENT_KIND_ANSWERS = { first: "installment", deposit: "deposit" } as const;
export type KindAnswer = keyof typeof PAYMENT_KIND_ANSWERS;

/** "first:<payment id>" or "deposit:<payment id>". */
export function parseKindAnswer(value: string): { answer: KindAnswer; payment: string } | null {
  const m = /^(first|deposit):(.+)$/.exec(value.trim());
  return m ? { answer: m[1] as KindAnswer, payment: m[2] } : null;
}

export async function answerPaymentKind(c: PoolClient, adapters: Adapters, companyId: string, user: string, value: string): Promise<{ text: string; replayed: string[] }> {
  const a = parseKindAnswer(value);
  if (!a) return { text: "That button doesn't name a payment.", replayed: [] };
  const allowed = await one(c, `select 1 where exists (select 1 from users where company_id=$1 and slack_user_id=$2 and active and role in ('owner','manager'))
    or exists (select 1 from bindings where company_id=$1 and key='bot.escalate_to' and convert_from(value,'utf8')=$2)`, [companyId, user]);
  if (!allowed) return { text: "Only a manager can answer this one.", replayed: [] };
  const p = await one<{ id: string; amount: string; kind: string | null; contact: string | null }>(c,
    "select p.id, p.amount, p.kind, coalesce(nullif(trim(concat_ws(' ', ct.first_name, ct.last_name)), ''), 'them') as contact from payments p left join contacts ct on ct.id=p.contact_id where p.company_id=$1 and p.id::text=$2", [companyId, a.payment]);
  if (!p) return { text: "That payment isn't on this offer.", replayed: [] };
  const money = `$${Number(p.amount).toLocaleString("en-US")}`;
  const kind = PAYMENT_KIND_ANSWERS[a.answer];
  if (a.answer === "deposit" || p.kind === kind) {
    await c.query("insert into audit_log (company_id, action, target_type, target_id, after) values ($1,'payment.kind_answered','payment',$2,$3)", [companyId, p.id, { answer: a.answer, by: `slack:${user}`, kind: p.kind }]);
    return { text: `✅ <@${user}>: ${p.contact}'s ${money} is ${a.answer === "deposit" ? "a deposit" : "the first payment of a plan"}.`, replayed: [] };
  }
  const { adapterCompany: ac, bindings } = await loadCompany(c, companyId);
  const r = await setPaymentKind(c, { companyId, ac, adapters, bindings, payment: p.id, kind, why: `Slack: <@${user}> answered "full first payment"`, dryRun: false });
  if (!r.ok) return { text: `Couldn't change it: ${r.error}`, replayed: [] };
  const replayed = await replayQuietly(c, companyId, p.id, `Slack: <@${user}> answered "full first payment"`);
  await c.query("insert into audit_log (company_id, action, target_type, target_id, after) values ($1,'payment.kind_answered','payment',$2,$3)", [companyId, p.id, { answer: a.answer, by: `slack:${user}`, was: p.kind, now: kind, replayed }]);
  return { text: `✅ <@${user}>: ${p.contact}'s ${money} is the first payment of a plan, not a deposit. Recorded and the deal updated.`, replayed };
}

/** The workflows that took this payment's event run once more for it, writing only (D326's quiet replay, D257's again). */
export async function replayQuietly(c: PoolClient, companyId: string, paymentId: string, why: string): Promise<string[]> {
  const e = await one<EventRow>(c, "select * from events where company_id=$1 and event_type='payment.received' and data->>'payment_id'=$2 order by id desc limit 1", [companyId, paymentId]);
  if (!e) return [];
  const ctx = await eventMatchContext(c, e);
  const out: string[] = [];
  for (const w of await many<{ id: string; name: string }>(c, "select id, name from workflows where company_id=$1 and enabled order by name", [companyId])) {
    if (!(await workflowTakes(c, e, ctx, w.id))) continue;
    const going = await one(c, "select 1 from runs where workflow_id=$1 and triggered_by_event=$2 and status not in ('completed','exited','failed')", [w.id, e.id]);
    if (going) continue;
    await c.query("update runs set reentry_key = reentry_key || ':again:' || id::text where workflow_id=$1 and triggered_by_event=$2 and reentry_key not like '%:again:%'", [w.id, e.id]);
    const runs = await dispatchEvent(c, e, ctx, { workflowId: w.id });
    if (runs.length) await c.query("update runs set context = context || jsonb_build_object('replay', jsonb_build_object('quiet', true, 'why', $2::text)) where id = any($1::uuid[])", [runs, why]);
    if (runs.length) out.push(w.name);
  }
  return out;
}
