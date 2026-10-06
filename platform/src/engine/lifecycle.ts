import type { PoolClient } from "pg";
import { one } from "@/db/client";
import type { Adapters, Company } from "@/adapters/types";
import { emitEvent, type EventRow } from "./dispatch";

/** D13 §13: opportunity opens at first booking (per company setting), becomes a deal on first payment. */
export async function ensureOpportunityForBooking(c: PoolClient, companyId: string, contactId: string, appointmentId: string, bookedEvent: EventRow): Promise<string> {
  const co = await one<{ opp_opens_on: string }>(c, "select opp_opens_on from companies where id=$1", [companyId]);
  const open = await one<{ id: string }>(c, "select id from opportunities where company_id=$1 and contact_id=$2 and status='open' order by opened_at desc limit 1", [companyId, contactId]);
  let oppId = open?.id;
  if (!oppId && co?.opp_opens_on !== "pipeline_entry") {
    const row = await one<{ id: string }>(c, "insert into opportunities (company_id, contact_id, opened_by) values ($1,$2,'first_booking') returning id", [companyId, contactId]);
    oppId = row!.id;
    await emitEvent(c, { company_id: companyId, contact_id: contactId, opportunity_id: oppId, appointment_id: appointmentId, event_type: "opportunity.opened", source: "engine", data: { by: "first_booking", event_id: bookedEvent.id } });
  }
  if (oppId) await c.query("update appointments set opportunity_id=$2 where id=$1 and opportunity_id is null", [appointmentId, oppId]);
  return oppId ?? "";
}

export async function applyPayment(c: PoolClient, companyId: string, contactId: string, p: { whopPaymentId: string; amount: number; currency: string; installmentNo?: number; status: "succeeded" | "failed" | "refunded"; paidAt: Date; raw: Record<string, unknown> }): Promise<EventRow> {
  const opp = await one<{ id: string; contract_value: string | null }>(c, "select id, contract_value from opportunities where company_id=$1 and contact_id=$2 and status in ('open','won') order by opened_at desc limit 1", [companyId, contactId]);
  await c.query(`insert into payments (company_id, contact_id, opportunity_id, whop_payment_id, amount, currency, installment_no, status, paid_at, raw)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) on conflict (company_id, whop_payment_id) do nothing`,
    [companyId, contactId, opp?.id ?? null, p.whopPaymentId, p.amount, p.currency, p.installmentNo ?? null, p.status, p.paidAt, p.raw]);
  const ev = await emitEvent(c, { company_id: companyId, contact_id: contactId, opportunity_id: opp?.id ?? null, appointment_id: null, event_type: p.status === "succeeded" ? "payment.received" : "payment.failed", source: "whop", data: { amount: p.amount, currency: p.currency, installment_no: p.installmentNo } });
  if (p.status === "succeeded" && opp) {
    const co = await one<{ opp_won_on: string }>(c, "select opp_won_on from companies where id=$1", [companyId]);
    const won = await one<{ status: string }>(c, "select status from opportunities where id=$1", [opp.id]);
    if (won?.status === "open" && co?.opp_won_on === "first_payment") {
      await c.query("update opportunities set status='won', won_at=now() where id=$1", [opp.id]);
      await emitEvent(c, { company_id: companyId, contact_id: contactId, opportunity_id: opp.id, appointment_id: null, event_type: "opportunity.won", source: "engine", data: { by: "first_payment" } });
    }
    const sum = await one<{ total: string }>(c, "select coalesce(sum(amount),0) as total from payments where opportunity_id=$1 and status='succeeded'", [opp.id]);
    if (opp.contract_value && Number(sum!.total) >= Number(opp.contract_value)) {
      const already = await one(c, "select 1 from events where opportunity_id=$1 and event_type='payment.paid_in_full'", [opp.id]);
      if (!already) await emitEvent(c, { company_id: companyId, contact_id: contactId, opportunity_id: opp.id, appointment_id: null, event_type: "payment.paid_in_full", source: "engine", data: { total: Number(sum!.total) } });
    }
  }
  return ev;
}

/** Poll saw an assignedUserId we don't know → create an unclaimed user from the CRM roster (grill-me batch 4 #5). */
export async function ensureUser(c: PoolClient, adapters: Adapters, co: Company, ghlUserId: string): Promise<string | null> {
  const u = await one<{ id: string }>(c, "select id from users where company_id=$1 and ghl_user_id=$2", [co.id, ghlUserId]);
  if (u) return u.id;
  const roster = await adapters.read.listUsers(co);
  const found = roster.find((r) => r.id === ghlUserId);
  if (!found) return null;
  const row = await one<{ id: string }>(c, "insert into users (company_id, email, name, role, ghl_user_id) values ($1,$2,$3,'closer',$4) on conflict (company_id, ghl_user_id) do update set name=excluded.name returning id",
    [co.id, found.email ?? `${ghlUserId}@unclaimed.local`, found.name || ghlUserId, ghlUserId]);
  return row!.id;
}
