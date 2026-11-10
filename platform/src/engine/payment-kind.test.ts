/** D317: a payment recorded as the wrong kind is put right: ledger, deal, GHL Cash record and the closer card; a dry run first. */
import { describe, it, expect, beforeAll } from "vitest";
import { asOperator, one } from "@/db/client";
import { migrate } from "@/db/migrate";
import { fakeAdapters } from "./test-install";
import { setPaymentKind } from "./payment-kind";
import type { Adapters, Company } from "@/adapters/types";

const calls: unknown[][] = [];
const base = fakeAdapters();
const adapters: Adapters = { ...base, write: { ...base.write, updateRecord: async (...x: unknown[]) => { calls.push(["record", ...x.slice(1)]); }, updateOpportunity: async (...x: unknown[]) => { calls.push(["card", ...x.slice(1)]); } } as Adapters["write"] };
const ac = { id: "x", locationId: "L", pit: "p", timezone: "America/New_York", booking: { source: "ghl" } } as unknown as Company;
const bindings = { "crm.object_payment": "custom_objects.cash", "crm.pipeline_closer": "PIPE", "crm.stage_closer_deposit": "DEP", "crm.stage_closer_purchase": "PUR" };
let co = "", opp = "";

describe.skipIf(!process.env.DATABASE_URL)("D317: a payment's kind put right", () => {
  beforeAll(async () => {
    await migrate();
    await asOperator(async (c) => {
      co = (await one<{ id: string }>(c, "insert into companies (name, slug, timezone) values ('D317',$1,'America/New_York') returning id", [`d317-${Date.now()}`]))!.id;
      const ct = (await one<{ id: string }>(c, "insert into contacts (company_id, first_name) values ($1,'Carmen') returning id", [co]))!.id;
      opp = (await one<{ id: string }>(c, "insert into opportunities (company_id, contact_id, opened_by, status, contract_value) values ($1,$2,'test','won',1000) returning id", [co, ct]))!.id;
      await c.query("insert into payments (company_id, contact_id, opportunity_id, whop_payment_id, amount, status, paid_at, kind) values ($1,$2,$3,'pay_1',1000,'succeeded',now(),'paid_in_full')", [co, ct, opp]);
      await c.query("insert into crm_records (company_id, object_key, record_key, ghl_record_id, contact_id, properties) values ($1,'custom_objects.cash','pay_1','REC1',$2,$3)", [co, ct, { type: "paid_in_full", program_price: 1000 }]);
      await c.query("insert into pipeline_cards (company_id, opportunity_id, contact_id, ghl_opportunity_id, ghl_pipeline_id, ghl_stage_id, name) values ($1,$2,$3,'GOPP','PIPE','PUR','Carmen')", [co, opp, ct]);
      const pid = (await one<{ id: string }>(c, "select id from payments where company_id=$1 and whop_payment_id='pay_1'", [co]))!.id;
      await c.query("insert into events (company_id, contact_id, opportunity_id, event_type, source, occurred_at, data) values ($1,$2,$3,'payment.received','whop',now(),$4)", [co, ct, opp, { payment_id: pid, kind: "paid_in_full", amount: 1000, running_total: 1000, contract_value: 1000, outstanding: 0, cleared: true }]);
    });
  }, 180000);
  const run = (dryRun: boolean) => asOperator((c) => setPaymentKind(c, { companyId: co, ac, adapters, bindings, payment: "pay_1", kind: "deposit", price: 10000, why: "test", dryRun }));

  it("a $1,000 paid in full that was a deposit on a $10,000 deal: the dry run says it all and changes nothing", async () => {
    const r = await run(true);
    expect(r).toMatchObject({ ok: true, dryRun: true });
    if (!r.ok) return;
    expect(r.changes.map((x) => x.what)).toEqual(["payment kind", "deal price", "deal status", "Cash record type", "Cash record program_price", "closer card stage", "closer card value", "the payment's event (what a replay reads)"]);
    expect(calls).toEqual([]);
  });

  it("then put right: the deal reopens at $10,000, the Cash record says deposit, the card moves to Deposit; audited", async () => {
    expect(await run(false)).toMatchObject({ ok: true, dryRun: false });
    expect(await asOperator((c) => one(c, "select kind from payments where whop_payment_id='pay_1' and company_id=$1", [co]))).toEqual({ kind: "deposit" });
    expect(await asOperator((c) => one(c, "select status, contract_value::int v from opportunities where id=$1", [opp]))).toEqual({ status: "open", v: 10000 });
    expect(calls).toEqual([["record", "custom_objects.cash", "REC1", { type: "deposit", program_price: 10000 }], ["card", "GOPP", { stageId: "DEP", monetaryValue: 10000 }]]);
    expect(await asOperator((c) => one(c, "select ghl_stage_id from pipeline_cards where opportunity_id=$1", [opp]))).toEqual({ ghl_stage_id: "DEP" });
    expect(await asOperator((c) => one(c, "select 1 from audit_log where company_id=$1 and action='payment.kind_set'", [co]))).toBeTruthy();
    // D325: a workflow replayed for it reads the payment as it is now
    expect((await asOperator((c) => one<{ data: Record<string, unknown> }>(c, "select data from events where company_id=$1 and event_type='payment.received'", [co])))!.data).toMatchObject({ kind: "deposit", contract_value: 10000, running_total: 1000, outstanding: 9000, cleared: false });
  });

  it("refuses a kind it doesn't know and a payment that isn't the offer's", async () => {
    expect(await asOperator((c) => setPaymentKind(c, { companyId: co, ac, adapters, bindings, payment: "pay_1", kind: "nope" as never, why: "t" }))).toMatchObject({ ok: false, status: 400 });
    expect(await asOperator((c) => setPaymentKind(c, { companyId: co, ac, adapters, bindings, payment: "pay_x", kind: "deposit", why: "t" }))).toMatchObject({ ok: false, status: 404 });
  });
});
