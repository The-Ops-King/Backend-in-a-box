/** D270: the buyer and what they paid before come from GHL, and what a payment is from the offer's settings. */
import { describe, it, expect, beforeAll } from "vitest";
import { asOperator, one } from "@/db/client";
import { migrate } from "@/db/migrate";
import { encrypt } from "@/engine/crypto";
import { installCompany } from "@/engine/install";
import { loadCompany } from "@/engine/context";
import { fakeAdapters } from "@/engine/test-install";
import { recordPayment, type GhlPay } from "@/engine/payments";
import type { Adapters, ContactSnapshot, ObjectRecord } from "@/adapters/types";

process.env.BINDINGS_KEY ??= Buffer.alloc(32, 7).toString("base64");
const HAS_DB = !!process.env.DATABASE_URL;
const SLUG = `d268-${Date.now()}`;
const JEN: ContactSnapshot = { id: "G-JEN", firstName: "Jennyfer", lastName: "Cantrell", email: "jen@x.com", phone: "+15205550101", tags: [], customFields: {}, dateUpdated: "2026-10-20T00:00:00Z", dateAdded: "2026-10-01T00:00:00Z" };
const cash: ObjectRecord[] = [{ id: "CASH-250", createdAt: "", properties: { transaction_id: "pay_dep", amount: 250, type: "deposit", contact_id: "G-JEN", customer_email: "jen@x.com" } }];
const base = fakeAdapters();
const ghl: Adapters = { ...base, read: { ...base.read, objectRecords: async (_c, key) => (key === "custom_objects.cash" ? cash : []), findDuplicate: async (_c, by) => ("email" in by && by.email === "jen@x.com" ? JEN : "phone" in by && by.phone.replace(/\D/g, "").endsWith("5205550101") ? JEN : null), getContact: async (_c, id) => (id === "G-JEN" ? JEN : null) } };
let co = "", g: GhlPay;

describe.skipIf(!HAS_DB)("D270: payments read GHL, by the offer's settings", () => {
  beforeAll(async () => {
    await migrate();
    co = (await installCompany({ name: "D270", slug: SLUG, timezone: "America/New_York", locationId: "LOC", pit: "pit-fake", calendars: {}, templates: [] }, ghl)).companyId;
    await asOperator(async (c) => {
      for (const [k, v] of [["crm.object_payment", "custom_objects.cash"], ["payments.full_prices", "[10000,12000]"], ["payments.price_slack", "3"], ["payments.deposit_under", "500"], ["payments.deposit_words", "deposit"], ["payments.full_reasons", "one_time,subscription_create"]])
        await c.query("insert into bindings (company_id,key,kind,value) values ($1,$2,'text',$3) on conflict (company_id,key) do update set value=excluded.value", [co, k, Buffer.from(v)]);
      const lc = await loadCompany(c, co);
      g = { ac: lc.adapterCompany, adapters: ghl, bindings: lc.bindings, tz: lc.row.timezone };
    });
    void encrypt;
  });

  it("the buyer is found in GHL by email (the engine had never seen her), what she paid before is GHL's records: the $9,750 is her balance, the deal worth $10,000", async () => {
    const r = await asOperator((c) => recordPayment(c, co, { providerPaymentId: "pay_bal", amount: 9750, status: "succeeded", paidAt: new Date(), email: "jen@x.com", raw: { billing_reason: "one_time" } }, undefined, { dispatch: false, ghl: g }));
    expect(r).toMatchObject({ outcome: "linked", payment: { kind: "balance" } });
    if (r.outcome !== "linked") return;
    expect(r.event.data).toMatchObject({ prior_total: 250, prior_non_deposit_total: 0, running_total: 10000, cleared: true, full_price: 10000, billing_reason: "one_time", linked_by: "email" });
    expect(await asOperator((c) => one(c, "select ghl_contact_id from contacts where id=$1", [r.contactId]))).toEqual({ ghl_contact_id: "G-JEN" });
    expect(await asOperator((c) => one(c, "select contract_value::int as v from opportunities where id=$1", [r.event.opportunity_id]))).toEqual({ v: 10000 });
  });

  it("a one-time $9,997 is paid in full; a $0 charge is not recorded; nobody in GHL is an unlinked payment", async () => {
    const full = await asOperator((c) => recordPayment(c, co, { providerPaymentId: "pay_full", amount: 9997, status: "succeeded", paidAt: new Date(), phone: "(520) 555-0101", raw: { billing_reason: "one_time" } }, undefined, { dispatch: false, ghl: g }));
    expect(full).toMatchObject({ outcome: "linked", payment: { kind: "paid_in_full" } });
    expect(await asOperator((c) => recordPayment(c, co, { providerPaymentId: "pay_zero", amount: 0, status: "succeeded", paidAt: new Date(), email: "jen@x.com" }, undefined, { ghl: g }))).toEqual({ outcome: "skipped", why: "a $0 payment" });
    expect(await asOperator((c) => one(c, "select 1 from payments where company_id=$1 and whop_payment_id='pay_zero'", [co]))).toBeFalsy();
    expect(await asOperator((c) => recordPayment(c, co, { providerPaymentId: "pay_who", amount: 300, status: "succeeded", paidAt: new Date(), email: "nobody@x.com" }, undefined, { dispatch: false, ghl: g }))).toMatchObject({ outcome: "unlinked" });
  });
});
