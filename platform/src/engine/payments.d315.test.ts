/** D315: an offer that goes by billing reason: a one-time payment at any price is the purchase in full, worth what was paid. */
import { describe, it, expect, beforeAll } from "vitest";
import { asOperator, one } from "@/db/client";
import { migrate } from "@/db/migrate";
import { installCompany } from "@/engine/install";
import { loadCompany } from "@/engine/context";
import { fakeAdapters } from "@/engine/test-install";
import { recordPayment, type GhlPay } from "@/engine/payments";
import type { Adapters, ContactSnapshot, ObjectRecord } from "@/adapters/types";

process.env.BINDINGS_KEY ??= Buffer.alloc(32, 7).toString("base64");
const SLUG = `d315-${Date.now()}`;
const person = (id: string, email: string): ContactSnapshot => ({ id, firstName: id, lastName: "Buyer", email, phone: null as never, tags: [], customFields: {}, dateUpdated: "2026-11-01T00:00:00Z", dateAdded: "2026-11-01T00:00:00Z" });
const PEOPLE = [person("G-ANA", "ana@x.com"), person("G-BEA", "bea@x.com"), person("G-CY", "cy@x.com")];
const base = fakeAdapters();
const ghl: Adapters = { ...base, read: { ...base.read, objectRecords: async (_c, key) => (key === "custom_objects.cash" ? cash : []), findDuplicate: async (_c, by) => ("email" in by ? PEOPLE.find((p) => p.email === by.email) ?? null : null), getContact: async (_c, id) => PEOPLE.find((p) => p.id === id) ?? null } };
// the deposit as Payment recorded writes it to GHL's Cash records (what was paid before is read from there)
const cash: ObjectRecord[] = [{ id: "CASH-BEA", createdAt: "", properties: { transaction_id: "p_bea_dep", amount: 500, type: "deposit", contact_id: "G-BEA", customer_email: "bea@x.com", occurred_at: "2026-11-01T00:00:00Z" } }];
let co = "", g: GhlPay;
const pay = (id: string, email: string, amount: number, billing_reason: string) => asOperator((c) => recordPayment(c, co, { providerPaymentId: id, amount, status: "succeeded", paidAt: new Date(), email, raw: { billing_reason } }, undefined, { dispatch: false, ghl: g }));
const worth = (opp: string) => asOperator((c) => one<{ v: number }>(c, "select contract_value::float as v from opportunities where id=$1", [opp]));
const fullEvent = (opp: string) => asOperator((c) => one(c, "select 1 from events where opportunity_id=$1 and event_type='payment.paid_in_full'", [opp]));

describe.skipIf(!process.env.DATABASE_URL)("D315: paid in full by billing reason", () => {
  beforeAll(async () => {
    await migrate();
    co = (await installCompany({ name: "D315", slug: SLUG, timezone: "America/New_York", locationId: "LOC", pit: "pit-fake", calendars: {}, templates: [] }, ghl)).companyId;
    await asOperator(async (c) => {
      for (const [k, v] of [["crm.object_payment", "custom_objects.cash"], ["payments.full_prices", "[10000,11500,12000]"], ["payments.price_slack", "3"], ["payments.deposit_under", "500"], ["payments.deposit_up_to", "500"], ["payments.deposit_words", "deposit"], ["payments.full_reasons", "one_time"], ["payments.full_by", "billing_reason"]])
        await c.query("insert into bindings (company_id,key,kind,value) values ($1,$2,'text',$3) on conflict (company_id,key) do update set value=excluded.value", [co, k, Buffer.from(v)]);
      const lc = await loadCompany(c, co);
      g = { ac: lc.adapterCompany, adapters: ghl, bindings: lc.bindings, tz: lc.row.timezone };
    });
  }, 180000);

  it("a one-time $8,800 from a new link is paid in full, the deal worth $8,800", async () => {
    const r = await pay("p_ana", "ana@x.com", 8800, "one_time");
    expect(r).toMatchObject({ outcome: "linked", payment: { kind: "paid_in_full" } });
    if (r.outcome !== "linked") return;
    expect(r.event.data).toMatchObject({ full_price: 8800, cleared: true });
    expect(await worth(r.event.opportunity_id!)).toEqual({ v: 8800 });
    expect(await fullEvent(r.event.opportunity_id!)).toBeTruthy();
  });

  it("$500 is a deposit; the one-time after it is the balance, the deal worth both", async () => {
    const d = await pay("p_bea_dep", "bea@x.com", 500, "one_time");
    expect(d).toMatchObject({ payment: { kind: "deposit" } });
    const b = await pay("p_bea_bal", "bea@x.com", 11000, "one_time");
    expect(b).toMatchObject({ outcome: "linked", payment: { kind: "balance" } });
    if (b.outcome !== "linked") return;
    expect(b.event.data).toMatchObject({ full_price: 11500, cleared: true, full_reason: true, prior_non_deposit_total: 0 });
    expect(await worth(b.event.opportunity_id!)).toEqual({ v: 11500 });
  });

  it("a subscription start is an installment, not paid in full", async () => {
    const r = await pay("p_cy", "cy@x.com", 4000, "subscription_create");
    expect(r).toMatchObject({ outcome: "linked", payment: { kind: "installment" } });
    if (r.outcome !== "linked") return;
    expect(await fullEvent(r.event.opportunity_id!)).toBeFalsy();
  });
});
