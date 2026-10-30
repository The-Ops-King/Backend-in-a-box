/** D244: one buyer, two calls in a day: each payment counts on the call it followed, so the day's cash is the money paid, once. */
import { describe, it, expect, beforeAll } from "vitest";
import { DateTime } from "luxon";
import { asOperator, one } from "@/db/client";
import { migrate } from "@/db/migrate";
import { loadCompany } from "./context";
import { prefill, todayFor } from "./eod";

process.env.BINDINGS_KEY ??= Buffer.alloc(32, 7).toString("base64");
const TZ = "America/New_York";
let companyId = "", jose = "";

describe.skipIf(!process.env.DATABASE_URL)("D244: the day's money, once", () => {
  beforeAll(async () => {
    await migrate();
    await asOperator(async (c) => {
      companyId = (await one<{ id: string }>(c, "insert into companies (name, slug, timezone, contract_value_default) values ('D244',$1,$2,10000) returning id", [`d244-${Date.now()}`, TZ]))!.id;
      await c.query("insert into company_terms (company_id, domain, name, category, is_default, sort) select $1, domain, label, value, true, sort from core_categories", [companyId]);
      jose = (await one<{ id: string }>(c, "insert into users (company_id, email, name, role) values ($1,'jp@x.test','Jose P','closer') returning id", [companyId]))!.id;
      const jen = (await one<{ id: string }>(c, "insert into contacts (company_id, ghl_contact_id, first_name, last_name) values ($1,'GJ','Jennyfer','C') returning id", [companyId]))!.id;
      const term = (await one<{ id: string }>(c, "select id from company_terms where company_id=$1 and domain='appointment_type' and category='closing'", [companyId]))!.id;
      const cal = (await one<{ id: string }>(c, "insert into calendars (company_id, external_id, name, appointment_term) values ($1,'CAL','Strategy',$2) returning id", [companyId, term]))!.id;
      const day = DateTime.now().setZone(TZ).minus({ days: 1 });
      const at = (h: number, m = 0) => day.set({ hour: h, minute: m, second: 0, millisecond: 0 }).toJSDate();
      for (const [ext, h] of [["A10", 10], ["A19", 19]] as const)
        await c.query("insert into appointments (company_id, contact_id, calendar_id, external_id, starts_at, ends_at, booked_at, status, appointment_term, assigned_user_id) values ($1,$2,$3,$4,$5,$5,now(),'confirmed',$6,$7)", [companyId, jen, cal, ext, at(h), term, jose]);
      const opp = (await one<{ id: string }>(c, "insert into opportunities (company_id, contact_id, opened_by, status, won_at, contract_value) values ($1,$2,'test','won',$3,10000) returning id", [companyId, jen, at(20, 4)]))!.id;
      await c.query("insert into payments (company_id, contact_id, opportunity_id, whop_payment_id, amount, status, kind, paid_at) values ($1,$2,$3,'p250',250,'succeeded','deposit',$4),($1,$2,$3,'p9750',9750,'succeeded','balance',$5)", [companyId, jen, opp, at(15, 25), at(20, 4)]);
    });
  });

  it("the $250 is the 10 AM call's (a deposit), the $9,750 the 7 PM call's (the close); $10,000 collected, not $20,000", async () => {
    const day = DateTime.fromFormat(todayFor(TZ), "yyyy-MM-dd", { zone: TZ }).minus({ days: 1 }).toFormat("yyyy-MM-dd");
    const pre = await asOperator(async (c) => prefill(c, (await loadCompany(c, companyId)).row, { id: jose, name: "Jose P", email: "jp@x.test" }, day));
    expect(pre.calls.map((x) => [x.cash, x.revenue])).toEqual([[250, null], [9750, 10000]]);
    expect(pre).toMatchObject({ cash: 10000, revenue: 10000, closes: 1, deposits: 1 });
  });
});
