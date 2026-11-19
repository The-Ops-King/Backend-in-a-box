/** D351: a custom-priced agreement takes its price from the contact's Contract Value, read once it is out, and never goes out unpriced unseen. */
import { describe, it, expect, beforeAll } from "vitest";
import { asOperator, one } from "@/db/client";
import { migrate } from "@/db/migrate";
import { fakeAdapters } from "./test-install";
import { encrypt } from "./crypto";
import { isOut, planAgreementPrice, priceRange, priceValue, pricedFromField, readAgreementPrice } from "./agreement-price";
import type { AgreementRow } from "./agreements";
import type { Adapters, Company } from "@/adapters/types";

process.env.BINDINGS_KEY ??= Buffer.alloc(32, 7).toString("base64");
const bindings: Record<string, string> = {
  "agreements.price_templates": "Beauty Moguls Service Agreement, Beauty Moguls Service Agreement (Guarantee)",
  "agreements.price_field": "crm.field_contact_revenue_generated", "crm.field_contact_revenue_generated": "F_CV",
  "agreements.price_range": "3000-15000", "slack.channel.agreements": "CAGR",
  "payments.price_from": "agreement, eod", "payments.full_by": "billing_reason", "payments.full_reasons": "one_time", "payments.price_slack": "3",
};

describe("D351: which agreements, which prices", () => {
  it("names the offer's own templates, whatever the case or spacing; others are not priced from the contact", () => {
    expect(pricedFromField("Beauty Moguls Service Agreement", bindings)).toBe(true);
    expect(pricedFromField("  beauty moguls  service agreement (guarantee) ", bindings)).toBe(true);
    expect(pricedFromField("($12,000 + Guarantee) Beauty Moguls Service Agreement", bindings)).toBe(false);
    expect(pricedFromField("Beauty Moguls Service Agreement", {})).toBe(false);
  });
  it("reads what a closer types into the field; empty, zero or words are no price", () => {
    expect(priceValue("7000")).toBe(7000);
    expect(priceValue("$7,000")).toBe(7000);
    expect(priceValue(7000.5)).toBe(7000.5);
    for (const v of ["", "0", "$0", "seven thousand", null, undefined, -5]) expect(priceValue(v)).toBeNull();
  });
  it("the range is the offer's; unset is no check", () => {
    expect(priceRange("3000-15000")).toEqual([3000, 15000]);
    expect(priceRange("$3,000 - $15,000")).toEqual([3000, 15000]);
    expect(priceRange(undefined)).toBeNull();
  });
  it("a draft is not out", () => {
    expect(isOut("draft")).toBe(false);
    expect(isOut("sent")).toBe(true);
    expect(isOut("completed")).toBe(true);
  });
});

describe.skipIf(!process.env.DATABASE_URL)("D351: the price an agreement went out at", () => {
  const field: Record<string, unknown> = {};
  const posts: string[] = [];
  const base = fakeAdapters();
  const adapters: Adapters = { ...base,
    read: { ...base.read, getContact: async (_c: Company, id: string) => ({ id, tags: [], customFields: { F_CV: field[id] }, dateUpdated: "", dateAdded: "" }) } as Adapters["read"],
    write: { ...base.write, updateContact: async () => {}, updateOpportunity: async () => {}, updateRecord: async () => {}, addTag: async () => {}, removeTag: async () => {} } as unknown as Adapters["write"],
    notifier: { ...base.notifier, post: async (_t: string, ch: string, text: string) => { posts.push(`${ch}: ${text}`); return { ts: "1" }; } } as Adapters["notifier"] };
  const ac = { id: "x", locationId: "L", pit: "p", timezone: "America/New_York", booking: { source: "ghl" } } as unknown as Company;
  let co = "";
  const person = (first: string, ghl: string, cv: unknown) => asOperator(async (c) => {
    field[ghl] = cv;
    const ct = (await one<{ id: string }>(c, "insert into contacts (company_id, first_name, last_name, ghl_contact_id, assigned_ghl_user_id) values ($1,$2,'Doe',$3,'GU-JOSE') returning id", [co, first, ghl]))!.id;
    await c.query("insert into opportunities (company_id, contact_id, opened_by, status, contract_value) values ($1,$2,'test','open',10000)", [co, ct]);
    return ct;
  });
  const doc = (ct: string, name: string, status: string) => asOperator((c) => one<AgreementRow>(c,
    "insert into agreements (company_id, contact_id, external_id, name, status, sent_at) values ($1,$2,$3,$4,$5,now()) returning *", [co, ct, `D-${Math.random()}`, name, status])).then((r) => r!);
  const read = (row: AgreementRow) => asOperator((c) => readAgreementPrice(c, { companyId: co, ac, adapters, bindings }, row));
  const deal = (ct: string) => asOperator((c) => one<{ contract_value: string; price_source: string | null }>(c, "select contract_value, price_source from opportunities where contact_id=$1", [ct]));
  const alert = (row: AgreementRow) => asOperator((c) => one<{ level: string; text: string }>(c, "select level, text from alerts where key=$1 and resolved_at is null", [`agreements:price:${row.id}`]));

  beforeAll(async () => {
    await migrate();
    await asOperator(async (c) => {
      co = (await one<{ id: string }>(c, "insert into companies (name, slug, timezone) values ('D351',$1,'America/New_York') returning id", [`d347-${Date.now()}`]))!.id;
      for (const [k, v] of Object.entries(bindings)) await c.query("insert into bindings (company_id,key,kind,value) values ($1,$2,'text',$3)", [co, k, Buffer.from(v)]);
      await c.query("insert into slack_connections (company_id, team_id, bot_token, channels) values ($1,'T1',$2,'{}')", [co, encrypt("xoxb-fake")]);
      await c.query("insert into users (company_id, email, name, role, ghl_user_id, slack_user_id, active) values ($1,'jose@x.test','Jose','closer','GU-JOSE','UJOSE',true)", [co]);
    });
  }, 180000);

  it("sent at $7,000: the deal's price is $7,000 from the agreement, kept on it, and one line says so", async () => {
    const ct = await person("Jane", "G-JANE", "7000");
    const row = await doc(ct, "Beauty Moguls Service Agreement (Guarantee)", "sent");
    expect(await read(row)).toEqual({ price: 7000, problem: "none", posted: true });
    expect(await deal(ct)).toEqual({ contract_value: "7000.00", price_source: "agreement_sent" });
    expect(posts.at(-1)).toBe('CAGR: Agreement sent to Jane Doe at $7,000 ("Beauty Moguls Service Agreement (Guarantee)").');
    // read once: the field changing later does not re-price a contract already sent
    field["G-JANE"] = "12000";
    const again = await asOperator((c) => one<AgreementRow>(c, "select * from agreements where id=$1", [row.id]));
    expect(await read(again!)).toBeNull();
    expect((await deal(ct))!.contract_value).toBe("7000.00");
  });

  it("sent with Contract Value empty: an alert to void it, the closer tagged, and the deal's price left alone", async () => {
    const ct = await person("Empty", "G-EMPTY", "");
    const row = await doc(ct, "Beauty Moguls Service Agreement", "sent");
    expect(await read(row)).toEqual({ price: null, problem: "missing", posted: true });
    expect(posts.at(-1)).toContain("<@UJOSE>");
    expect(posts.at(-1)).toContain("*no price*");
    expect(await alert(row)).toMatchObject({ level: "error" });
    expect(await deal(ct)).toEqual({ contract_value: "10000.00", price_source: null });
  });

  it("700 for 7000: still the price it went out at, with a warning to check it", async () => {
    const ct = await person("Typo", "G-TYPO", "700");
    const row = await doc(ct, "Beauty Moguls Service Agreement", "viewed");
    expect(await read(row)).toMatchObject({ price: 700, problem: "out_of_range" });
    expect(posts.at(-1)).toContain("outside the usual $3,000 to $15,000");
    expect(await alert(row)).toMatchObject({ level: "warning" });
  });

  it("a draft is read only once it goes out; another agreement is never read", async () => {
    const ct = await person("Draft", "G-DRAFT", "8000");
    const draft = await doc(ct, "Beauty Moguls Service Agreement", "draft");
    expect(await read(draft)).toBeNull();
    expect(await read(await doc(ct, "($12,000) Beauty Moguls Service Agreement", "sent"))).toBeNull();
    expect((await deal(ct))!.contract_value).toBe("10000.00");
    expect(await read({ ...draft, status: "sent" })).toMatchObject({ price: 8000, problem: "none" });
  });

  it("an operator's re-check: the plan writes nothing; asked again, it reads the field as it is now", async () => {
    const ct = await person("Again", "G-AGAIN", "9000");
    const row = await doc(ct, "Beauty Moguls Service Agreement", "sent");
    await asOperator((c) => c.query("update agreements set price_read_at=now() where id=$1", [row.id]));   // held before the feature: read
    const held = (await asOperator((c) => one<AgreementRow>(c, "select * from agreements where id=$1", [row.id])))!;
    expect(await read(held)).toBeNull();
    const n = posts.length;
    const plan = await asOperator((c) => planAgreementPrice(c, { companyId: co, ac, adapters, bindings }, held));
    expect(plan).toMatchObject({ ok: true, price: 9000, problem: "none", channel: "CAGR", text: 'Agreement sent to Again Doe at $9,000 ("Beauty Moguls Service Agreement").' });
    expect(posts.length).toBe(n);
    expect((await deal(ct))!.contract_value).toBe("10000.00");
    expect(await asOperator((c) => readAgreementPrice(c, { companyId: co, ac, adapters, bindings }, held, { again: true }))).toEqual({ price: 9000, problem: "none", posted: true });
    expect(await deal(ct)).toEqual({ contract_value: "9000.00", price_source: "agreement_sent" });
  });
});
