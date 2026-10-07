import { DateTime } from "luxon";
import type { PoolClient } from "pg";
import { many, one } from "@/db/client";
import { bookingFor, type Adapters, type Company } from "@/adapters/types";
import type { CompanyRow } from "./context";
import { ensureUser } from "./lifecycle";
import { applyAppointment, boundFieldIds, upsertContact } from "./poll";
import { recordPhoneCall, settlePhoneCall } from "./recordings";
import { outcomeTermFor } from "./disposition";
import { rollupRange } from "./metrics";
import { recordPayment, type PaymentInput } from "./payments";
import { paymentInputs, whopListPayments } from "@/adapters/whop/client";

/**
 * History (D29): the facts the poll would have seen had the engine been watching, read back once over a window and written
 * the way a baseline poll writes them — rows only, no workflow starts (the payments ledger keeps its own payment.* facts). Contacts (arrival time), dialer calls (with
 * transcripts), bookings from the booking source, sales-call outcomes the old Zaps wrote onto GHL's Sales Call object, and
 * won opportunities, and payments from the processor's own API when a Whop key is bound (GHL holds no Payment records for
 * Hair; the Whop Zap never wrote them). Re-running is safe: every write is keyed on the source's id.
 */
export type BackfillReport = { from: string; to: string; contacts: number; calls: number; callsWithTranscript: number; appointments: number; outcomes: number; outcomesUnmatched: number; won: number; payments: number; paymentsUnlinked: number; days: number; errors: string[] };
export type PaymentsSource = (from: Date, to: Date) => Promise<PaymentInput[]>;

const OUTCOME_CATEGORY: Record<string, string> = { showed: "showed", show: "showed", no_show: "noshow", noshow: "noshow", "no-show": "noshow", cancelled: "cancelled", canceled: "cancelled", late_cancel: "cancelled", rescheduled: "rescheduled" };

export type BackfillStep = "contacts" | "calls" | "appointments" | "outcomes" | "won" | "payments";
export const BACKFILL_STEPS: BackfillStep[] = ["contacts", "calls", "appointments", "outcomes", "won", "payments"];

/** `only` narrows the pass (a payments-only pull after a key is bound, say); the rollup always runs. */
export async function backfillCompany(c: PoolClient, co: CompanyRow, ac: Company, adapters: Adapters, bindings: Record<string, string>, window: { from: Date; to: Date }, payments?: PaymentsSource, only?: BackfillStep[]): Promise<BackfillReport> {
  const rep: BackfillReport = { from: window.from.toISOString(), to: window.to.toISOString(), contacts: 0, calls: 0, callsWithTranscript: 0, appointments: 0, outcomes: 0, outcomesUnmatched: 0, won: 0, payments: 0, paymentsUnlinked: 0, days: 0, errors: [] };
  const step = async (name: BackfillStep | "rollups", fn: () => Promise<void>) => { if (name !== "rollups" && only && !only.includes(name)) return; try { await fn(); } catch (e) { rep.errors.push(`${name}: ${String((e as Error).message).slice(0, 300)}`); } };

  await step("contacts", async () => {
    const keep = boundFieldIds(bindings);
    for (const s of await adapters.read.contactsAddedBetween(ac, window.from, window.to)) { await upsertContact(c, co.id, co.timezone, s, keep); rep.contacts++; }
  });

  await step("calls", async () => {
    for (const m of await adapters.read.callsBetween(ac, window.from, window.to)) {
      let contact = await one<{ id: string }>(c, "select id from contacts where company_id=$1 and ghl_contact_id=$2", [co.id, m.contactId]);
      if (!contact) { const live = await adapters.read.getContact(ac, m.contactId); if (!live) continue; contact = { id: (await upsertContact(c, co.id, co.timezone, live)).id }; }
      const call = m.call ?? { status: m.status ?? "" };
      if (call.userId) await ensureUser(c, adapters, ac, call.userId);
      const { recording, isNew } = await recordPhoneCall(c, co.id, { externalId: m.id, contactId: contact.id, startedAt: new Date(m.dateAdded), durationSec: call.durationSec ?? 0, direction: m.direction, status: call.status, callerGhlUserId: call.userId,
        conversationUrl: `https://app.gohighlevel.com/v2/location/${ac.locationId}/conversations/conversations/${m.contactId}`, raw: { backfill: true } });
      if (!isNew) continue;
      rep.calls++;
      const media = recording.raw.transcript_status === "pending" ? await adapters.read.callMedia(ac, m.id) : null;
      if (media?.transcript) rep.callsWithTranscript++;
      await settlePhoneCall(c, recording, media, { silent: true });
    }
  });

  await step("appointments", async () => {
    const cals = await many<{ external_id: string }>(c, "select external_id from calendars where company_id=$1 and source=$2 and active", [co.id, ac.booking.source]);
    for (const cal of cals) {
      for (const s of await bookingFor(adapters, ac).appointmentsInWindow(ac, cal.external_id, window.from, window.to)) {
        const before = await one(c, "select 1 from appointments where company_id=$1 and source=$2 and external_id=$3", [co.id, ac.booking.source, s.id]);
        await applyAppointment(c, co, ac, adapters, s, undefined, true);
        if (!before) rep.appointments++;
      }
    }
  });

  await step("outcomes", async () => {
    // the old Zaps wrote each closing call onto GHL's Sales Call object, keyed by the booking's id, with the outcome filled in after the call
    const recs = (await adapters.read.objectRecords(ac, "custom_objects.sales_call")).filter((r) => typeof r.properties.outcome === "string" && r.properties.outcome);
    for (const r of recs) {
      const cat = OUTCOME_CATEGORY[String(r.properties.outcome).toLowerCase()]; if (!cat) continue;
      const ext = typeof r.properties.external_id === "string" ? r.properties.external_id : null;
      const ghlContact = typeof r.properties.contact_id === "string" ? r.properties.contact_id : null;
      const callDate = typeof r.properties.call_date === "string" ? r.properties.call_date : null;
      const appt = (ext && (await one<{ id: string; outcome_term: string | null }>(c, "select id, outcome_term from appointments where company_id=$1 and external_id=$2", [co.id, ext])))
        || (ghlContact && callDate && (await one<{ id: string; outcome_term: string | null }>(c, "select a.id, a.outcome_term from appointments a join contacts ct on ct.id=a.contact_id where a.company_id=$1 and ct.ghl_contact_id=$2 and (a.starts_at at time zone $3)::date=$4::date order by a.starts_at limit 1", [co.id, ghlContact, co.timezone, callDate])));
      if (!appt) { rep.outcomesUnmatched++; continue; }
      if (appt.outcome_term) continue;   // the engine already knows; history never overwrites the present
      const term = await outcomeTermFor(c, co.id, cat); if (!term) { rep.errors.push(`no appointment_outcome term for ${cat}`); break; }
      await c.query("update appointments set outcome_term=$2, status=case when $3 in ('showed','noshow') then $3 else status end where id=$1", [appt.id, term, cat]);
      rep.outcomes++;
    }
  });

  await step("won", async () => {
    const valueField = bindings["crm.field_opportunity_contract_value"];
    for (const o of await adapters.read.wonOpportunities(ac, window.from, window.to)) {
      const contact = o.contactId ? await one<{ id: string }>(c, "select id from contacts where company_id=$1 and ghl_contact_id=$2", [co.id, o.contactId]) : null;
      if (!contact) continue;
      const fromField = valueField ? Number(o.customFields[valueField]) : NaN;
      const value = Number.isFinite(fromField) && fromField > 0 ? fromField : o.monetaryValue && o.monetaryValue > 0 ? o.monetaryValue : null;
      const r = await c.query(`insert into opportunities (company_id, contact_id, ghl_opportunity_id, status, opened_at, opened_by, won_at, contract_value) values ($1,$2,$3,'won',$4,'backfill',$5,$6)
        on conflict (company_id, ghl_opportunity_id) do update set status='won', won_at=coalesce(opportunities.won_at, excluded.won_at), contract_value=coalesce(opportunities.contract_value, excluded.contract_value)`,
        [co.id, contact.id, o.id, new Date(o.createdAt), new Date(o.wonAt), value]);
      rep.won += r.rowCount ?? 0;
    }
  });

  await step("payments", async () => {
    // the processor's own list (Whop API key bound), through the same ledger path as a webhook: linked by email / phone / member id, else unlinked for the dashboard to fix
    const source = payments ?? (bindings["secret.whop_api_key"] ? async (f: Date, t: Date) => (await whopListPayments(bindings["secret.whop_api_key"], f, t)).flatMap(paymentInputs) : null);
    if (!source) return;
    for (const p of await source(window.from, window.to)) {
      const r = await recordPayment(c, co.id, p);
      if (r.outcome === "duplicate") continue;
      rep.payments++; if (r.outcome === "unlinked") rep.paymentsUnlinked++;
    }
  });

  await step("rollups", async () => {
    const from = DateTime.fromJSDate(window.from).setZone(co.timezone).toISODate()!, to = DateTime.fromJSDate(window.to).setZone(co.timezone).toISODate()!;
    await rollupRange(c, co.id, from, to, co.timezone);
    rep.days = Math.round(DateTime.fromISO(to).diff(DateTime.fromISO(from), "days").days) + 1;
  });
  await c.query("insert into audit_log (company_id, action, target_type, target_id, after) values ($1,'history.backfilled','company',$2,$3)", [co.id, co.id, rep]);
  return rep;
}
