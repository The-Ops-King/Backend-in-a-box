/** D231: the closer a payment is credited to: whoever took their latest closing call that has happened, else the contact's owner. */
import { describe, it, expect, beforeAll } from "vitest";
import { asOperator, one } from "@/db/client";
import { migrate } from "@/db/migrate";
import { buildContext, loadCompany, type RunRow } from "./context";

process.env.BINDINGS_KEY ??= Buffer.alloc(32, 7).toString("base64");
let companyId = "", carly = "", jp = "", term = "", setterTerm = "";

describe.skipIf(!process.env.DATABASE_URL)("D231: contact.call_closer", () => {
  beforeAll(async () => {
    await migrate();
    await asOperator(async (c) => {
      companyId = (await one<{ id: string }>(c, "insert into companies (name, slug, timezone) values ('D231',$1,'America/New_York') returning id", [`d231-${Date.now()}`]))!.id;
      await c.query("insert into company_terms (company_id, domain, name, category, is_default, sort) select $1, domain, label, value, true, sort from core_categories", [companyId]);
      term = (await one<{ id: string }>(c, "select id from company_terms where company_id=$1 and domain='appointment_type' and category='closing'", [companyId]))!.id;
      setterTerm = (await one<{ id: string }>(c, "select id from company_terms where company_id=$1 and domain='appointment_type' and category<>'closing' limit 1", [companyId]))!.id;
      carly = (await one<{ id: string }>(c, "insert into users (company_id, email, name, role, ghl_user_id) values ($1,'carly@x.com','Carly Vu','closer','U-CARLY') returning id", [companyId]))!.id;
      jp = (await one<{ id: string }>(c, "insert into users (company_id, email, name, role, ghl_user_id) values ($1,'jp@x.com','Jose P','closer','U-JP') returning id", [companyId]))!.id;
    });
  });

  const ctxOf = (contact: string) => asOperator(async (c) => {
    const lc = await loadCompany(c, companyId);
    const run = { id: "00000000-0000-0000-0000-000000000000", company_id: companyId, contact_id: contact, appointment_id: null, opportunity_id: null, context: { vars: {}, event: {} }, started_at: new Date() } as unknown as RunRow;
    return (await buildContext(c, run, lc.row, lc.bindings)).contact as { call_closer?: { name: string; from: string } };
  });
  const book = (contact: string, closer: string, at: Date, opts: { status?: string; t?: string } = {}) => asOperator((c) => c.query("insert into appointments (company_id, contact_id, source, external_id, appointment_term, starts_at, ends_at, booked_at, status, assigned_user_id) values ($1,$2,'calendly',$3,$4,$5,$5,now(),$6,$7)", [companyId, contact, `E${Math.random()}`, opts.t ?? term, at, opts.status ?? "confirmed", closer]));

  it("the latest closing call that has happened names the closer; a cancelled, a future or a setter call does not; with none it is the contact owner", async () => {
    const ct = (await asOperator((c) => one<{ id: string }>(c, "insert into contacts (company_id, first_name, assigned_ghl_user_id) values ($1,'Jen','U-CARLY') returning id", [companyId])))!.id;
    expect((await ctxOf(ct)).call_closer).toMatchObject({ name: "Carly Vu", from: "contact owner" });
    const day = 86_400_000;
    await book(ct, carly, new Date(Date.now() - 3 * day));
    await book(ct, jp, new Date(Date.now() - 1 * day));
    await book(ct, carly, new Date(Date.now() - 0.5 * day), { status: "cancelled" });
    await book(ct, carly, new Date(Date.now() - 0.2 * day), { t: setterTerm });
    await book(ct, carly, new Date(Date.now() + 1 * day));
    expect((await ctxOf(ct)).call_closer).toMatchObject({ name: "Jose P", from: "latest call" });
  });
});
