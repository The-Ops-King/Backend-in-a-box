import type { PoolClient } from "pg";
import { one } from "@/db/client";
import type { Adapters, Company } from "@/adapters/types";
import { emitEvent, type EventRow } from "./dispatch";
import { recordPayment } from "./payments";

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

/** Known-contact entry point (tests, manual entry). Returns the payment event, or id -1 for a redelivered payment (nothing to dispatch). */
export async function applyPayment(c: PoolClient, companyId: string, contactId: string, p: { whopPaymentId: string; amount: number; currency: string; installmentNo?: number; status: "succeeded" | "failed" | "refunded"; paidAt: Date; raw: Record<string, unknown> }): Promise<EventRow> {
  const r = await recordPayment(c, companyId, { providerPaymentId: p.whopPaymentId, amount: p.status === "refunded" ? -Math.abs(p.amount) : p.amount, currency: p.currency, installmentNo: p.installmentNo, status: p.status, paidAt: p.paidAt, raw: p.raw }, contactId);
  if (r.outcome === "duplicate") {
    const prior = await one<EventRow>(c, "select * from events where company_id=$1 and event_type in ('payment.received','payment.failed','payment.refunded') and data->>'provider_payment_id'=$2 order by id desc limit 1", [companyId, p.whopPaymentId]);
    return prior ? { ...prior, id: -1 } : { id: -1, company_id: companyId, contact_id: contactId, opportunity_id: null, appointment_id: null, event_type: "payment.received", occurred_at: p.paidAt, source: "whop", data: {} };
  }
  return r.event;
}

/** Poll saw an assignedUserId we don't know → create an unclaimed user from the CRM roster (grill-me batch 4 #5). */
export async function ensureUser(c: PoolClient, adapters: Adapters, co: Company, ghlUserId: string): Promise<string | null> {
  const u = await one<{ id: string }>(c, "select id from users where company_id=$1 and ghl_user_id=$2", [co.id, ghlUserId]);
  if (u) return u.id;
  const roster = await adapters.read.listUsers(co);
  const found = roster.find((r) => r.id === ghlUserId);
  if (!found) return null;
  const row = await one<{ id: string }>(c, "insert into users (company_id, email, name, role, ghl_user_id) values ($1,$2,$3,'staff',$4) on conflict (company_id, ghl_user_id) do update set name=excluded.name returning id",
    [co.id, found.email ?? `${ghlUserId}@unclaimed.local`, found.name || ghlUserId, ghlUserId]);
  return row!.id;
}

/** A booking source outside the CRM names the host by email (Calendly). Resolve against the roster we already hold; never invent a user. */
export async function userIdByEmail(c: PoolClient, companyId: string, email: string | undefined): Promise<string | null> {
  if (!email) return null;
  const u = await one<{ id: string }>(c, "select id from users where company_id=$1 and lower(email)=lower($2) and active limit 1", [companyId, email.trim()]);
  return u?.id ?? null;
}
