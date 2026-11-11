/** D322: the deal's price from what was sold, and its payments checked again each time it is set: Carmen Thomas's deal, step by step. */
import { describe, it, expect, beforeAll } from "vitest";
import { asOperator, one, many } from "@/db/client";
import { migrate } from "@/db/migrate";
import { fakeAdapters } from "./test-install";
import { priceFromName, reconcileDeal, setDealPrice } from "./deal-price";
import { deriveKind, payRulesOf } from "./payments";
import type { Adapters, Company } from "@/adapters/types";

const writes: unknown[][] = [];
const base = fakeAdapters();
const adapters: Adapters = { ...base, write: { ...base.write,
  updateRecord: async (_c: unknown, ...x: unknown[]) => { writes.push(["record", ...x]); },
  updateOpportunity: async (_c: unknown, ...x: unknown[]) => { writes.push(["card", ...x]); },
  updateContact: async (_c: unknown, ...x: unknown[]) => { writes.push(["contact", ...x]); },
  addTag: async (_c: unknown, id: string, t: string) => { writes.push(["tag+", id, t]); },
  removeTag: async (_c: unknown, id: string, t: string) => { writes.push(["tag-", id, t]); } } as Adapters["write"] };
const ac = { id: "x", locationId: "L", pit: "p", timezone: "America/New_York", booking: { source: "ghl" } } as unknown as Company;
const bindings: Record<string, string> = { "payments.price_from": "agreement, eod", "payments.full_by": "billing_reason", "payments.full_reasons": "one_time", "payments.price_slack": "3",
  "payments.tag_paid_full": "pay-paid-full", "payments.tag_plan_active": "pay-plan-active", "crm.object_payment": "custom_objects.cash", "crm.pipeline_closer": "PIPE", "crm.field_contact_revenue_generated": "F_REV" };
let co = "", ct = "", opp = "";
const deps = () => ({ companyId: co, ac, adapters, bindings, dispatch: false });
const pay = (id: string, amount: number, kind: string) => asOperator(async (c) => {
  await c.query("insert into payments (company_id, contact_id, opportunity_id, whop_payment_id, amount, status, paid_at, kind) values ($1,$2,$3,$4,$5,'succeeded',now(),$6)", [co, ct, opp, id, amount, kind]);
  await c.query("insert into crm_records (company_id, object_key, record_key, ghl_record_id, contact_id, properties) values ($1,'custom_objects.cash',$2,$3,$4,$5)", [co, id, `REC-${id}`, ct, { type: kind }]);
});
const tags = () => asOperator((c) => one<{ tags: string[] }>(c, "select tags from contacts where id=$1", [ct])).then((r) => r!.tags);

describe("D322: an agreement's name says its price", () => {
  it("reads the first dollar amount", () => {
    expect(priceFromName("($9,997 + Guarantee) Beauty Moguls Service Agreement")).toBe(9997);
    expect(priceFromName("($12,000) - Beauty Moguls Service Agreement")).toBe(12000);
    expect(priceFromName("($11,500) - Beauty Moguls Service Agreement Copy")).toBe(11500);
    expect(priceFromName("Beauty Moguls Agreement")).toBeNull();
  });
  it("a price from what was sold decides even the first payment; with none, a payment after a deposit is a plan", () => {
    const r = { ...payRulesOf(bindings), reason: "one_time", priorPaid: 0 };
    expect(deriveKind(3000, 0, 10000, "succeeded", false, { ...r, priceKnown: true })).toBe("installment");
    expect(deriveKind(9997, 0, 10000, "succeeded", false, { ...r, priceKnown: true })).toBe("paid_in_full");
    expect(deriveKind(3000, 1000, null, "succeeded", false, r)).toBe("installment");
    expect(deriveKind(3000, 0, null, "succeeded", false, r)).toBe("paid_in_full");   // the first one-time payment with no price: D315 stands
    // D329: under the deposit line is a deposit only as the first money; Carmen's last $1,000s were the plan's end
    const pmu = { ...payRulesOf({ ...bindings, "payments.deposit_under": "2000" }), reason: "one_time", priorPaid: 0 };
    expect(deriveKind(1000, 0, null, "succeeded", false, pmu)).toBe("deposit");
    expect(deriveKind(1000, 8000, 10000, "succeeded", false, { ...pmu, priorPaid: 7000, priceKnown: true })).toBe("installment");
    expect(deriveKind(1000, 9000, 10000, "succeeded", false, { ...pmu, priorPaid: 8000, priceKnown: true })).toBe("balance");
  });
});

describe.skipIf(!process.env.DATABASE_URL)("D322: the deal's price, and paid in full against it", () => {
  beforeAll(async () => {
    await migrate();
    await asOperator(async (c) => {
      co = (await one<{ id: string }>(c, "insert into companies (name, slug, timezone) values ('D322',$1,'America/New_York') returning id", [`d322-${Date.now()}`]))!.id;
      for (const [k, v] of Object.entries(bindings)) await c.query("insert into bindings (company_id,key,kind,value) values ($1,$2,'text',$3)", [co, k, Buffer.from(v)]);
      ct = (await one<{ id: string }>(c, "insert into contacts (company_id, first_name, last_name, ghl_contact_id) values ($1,'Carmen','Thomas','G-CAR') returning id", [co]))!.id;
      opp = (await one<{ id: string }>(c, "insert into opportunities (company_id, contact_id, opened_by, status) values ($1,$2,'test','won') returning id", [co, ct]))!.id;
      await c.query("insert into pipeline_cards (company_id, opportunity_id, contact_id, ghl_opportunity_id, ghl_pipeline_id, ghl_stage_id, name) values ($1,$2,$3,'GOPP','PIPE','S','Carmen')", [co, opp, ct]);
    });
    await pay("p_dep", 1000, "deposit");
    await pay("p_3k", 3000, "installment");
  }, 180000);

  it("the closer's end of day says $10,000: a plan, $4,000 of $10,000; Revenue Generated, the card and the Cash records follow", async () => {
    const r = await asOperator((c) => setDealPrice(c, { ...deps(), contactId: ct, price: 10000, source: "eod" }));
    expect(r).toMatchObject({ changed: true, price: 10000, reconciled: { total: 4000, cleared: false, overpaid: false, kinds: [], tags: { add: ["pay-plan-active"], remove: [] } } });
    expect(await tags()).toEqual(["pay-plan-active"]);
    expect(writes).toEqual(expect.arrayContaining([["contact", "G-CAR", { customFields: [{ id: "F_REV", field_value: "10000" }] }], ["card", "GOPP", { monetaryValue: 10000 }], ["record", "custom_objects.cash", "REC-p_3k", { program_price: 10000 }]]));
  });

  it("the signed agreement says $9,997 (within the slack of $10,000): it takes over, quietly", async () => {
    const r = await asOperator((c) => setDealPrice(c, { ...deps(), contactId: ct, price: 9997, source: "agreement" }));
    expect(r).toMatchObject({ changed: true, price: 9997, source: "agreement" });
    expect(await asOperator((c) => one(c, "select 1 from alerts where company_id=$1 and key like 'payments:price:%'", [co]))).toBeFalsy();
  });

  it("then $6,000 from another link: $10,000 of $9,997 is paid in full, the last payment the balance, the tags swapped", async () => {
    await pay("p_6k", 6000, "installment");
    const r = await asOperator((c) => reconcileDeal(c, { ...deps(), opportunityId: opp, contactId: ct }));
    expect(r).toMatchObject({ total: 10000, cleared: true, overpaid: false, kinds: [{ payment: "p_6k", was: "installment", now: "balance" }], tags: { add: ["pay-paid-full"], remove: ["pay-plan-active"] } });
    expect(await tags()).toEqual(["pay-paid-full"]);
    expect(await asOperator((c) => one(c, "select 1 from events where opportunity_id=$1 and event_type='payment.paid_in_full'", [opp]))).toBeTruthy();
  });

  it("a later end of day saying $12,000 doesn't replace the agreement: it stands, and an alert says they differ", async () => {
    const r = await asOperator((c) => setDealPrice(c, { ...deps(), contactId: ct, price: 12000, source: "eod" }));
    expect(r).toMatchObject({ changed: false, price: 9997, kept: "agreement" });
    expect((await asOperator((c) => many<{ text: string }>(c, "select text from alerts where company_id=$1 and key like 'payments:price:%'", [co])))[0].text).toContain("the agreement's price stands");
  });

  it("$2,000 more than the price: still paid in full, and an alert says so", async () => {
    await pay("p_2k", 2000, "installment");
    const r = await asOperator((c) => reconcileDeal(c, { ...deps(), opportunityId: opp, contactId: ct }));
    expect(r).toMatchObject({ total: 12000, cleared: true, overpaid: true });
    expect((await asOperator((c) => one<{ text: string }>(c, "select text from alerts where company_id=$1 and key like 'payments:overpaid:%'", [co])))!.text).toBe("Carmen Thomas has paid $12,000 on a $9,997 deal: check the price or the charges.");
  });

  it("a person's price beats the agreement: $12,000, and the deal is back on a plan", async () => {
    const r = await asOperator((c) => setDealPrice(c, { ...deps(), contactId: ct, price: 12000, source: "operator" }));
    expect(r).toMatchObject({ changed: true, price: 12000, reconciled: { total: 12000, cleared: true } });
    const r2 = await asOperator((c) => setDealPrice(c, { ...deps(), contactId: ct, price: 15000, source: "operator" }));
    expect(r2).toMatchObject({ reconciled: { cleared: false, kinds: [{ payment: "p_2k", was: "balance", now: "installment" }], tags: { add: ["pay-plan-active"], remove: ["pay-paid-full"] } } });
  });

  it("an offer that doesn't list the source is left alone", async () => {
    const r = await asOperator((c) => setDealPrice(c, { ...deps(), bindings: { ...bindings, "payments.price_from": "" }, contactId: ct, price: 5000, source: "eod" }));
    expect(r).toMatchObject({ changed: false, price: null });
  });
});
