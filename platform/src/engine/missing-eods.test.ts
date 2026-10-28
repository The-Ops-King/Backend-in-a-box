/** D246: who owes an end of day, at a glance: the days before today with calls and no report, with the names still open; today is not late. */
import { describe, it, expect, beforeAll } from "vitest";
import { DateTime } from "luxon";
import { asOperator, one } from "@/db/client";
import { migrate } from "@/db/migrate";
import { loadCompany } from "./context";
import { missingEods, missingLines, formatMissingEods } from "./missing-eods";
import { planCommand } from "./bot";

process.env.BINDINGS_KEY ??= Buffer.alloc(32, 7).toString("base64");
const TZ = "America/New_York";
let companyId = "";

describe.skipIf(!process.env.DATABASE_URL)("D246: missing EODs", () => {
  beforeAll(async () => {
    await migrate();
    await asOperator(async (c) => {
      companyId = (await one<{ id: string }>(c, "insert into companies (name, slug, timezone) values ('D246',$1,$2) returning id", [`d246-${Date.now()}`, TZ]))!.id;
      await c.query("insert into company_terms (company_id, domain, name, category, is_default, sort) select $1, domain, label, value, true, sort from core_categories", [companyId]);
      const jose = (await one<{ id: string }>(c, "insert into users (company_id, email, name, role) values ($1,'jp@x.test','Jose P','closer') returning id", [companyId]))!.id;
      const mel = (await one<{ id: string }>(c, "insert into users (company_id, email, name, role) values ($1,'mel@x.test','Mel R','closer') returning id", [companyId]))!.id;
      await c.query("insert into users (company_id, email, name, role) values ($1,'gone@x.test','Carly V','staff')", [companyId]);
      const term = (await one<{ id: string }>(c, "select id from company_terms where company_id=$1 and domain='appointment_type' and category='closing'", [companyId]))!.id;
      const showed = (await one<{ id: string }>(c, "select id from company_terms where company_id=$1 and domain='appointment_outcome' and category='showed'", [companyId]))!.id;
      const fu = (await one<{ id: string }>(c, "select id from company_terms where company_id=$1 and domain='call_outcome' and category='follow_up'", [companyId]))!.id;
      const cal = (await one<{ id: string }>(c, "insert into calendars (company_id, external_id, name, appointment_term) values ($1,'CAL','Consultation',$2) returning id", [companyId, term]))!.id;
      const day = (n: number) => DateTime.now().setZone(TZ).minus({ days: n }).set({ hour: 11, minute: 0 }).toJSDate();
      const book = async (who: string, name: string, n: number, answered = false) => {
        const ct = (await one<{ id: string }>(c, "insert into contacts (company_id, first_name) values ($1,$2) returning id", [companyId, name]))!.id;
        await c.query("insert into appointments (company_id, contact_id, calendar_id, external_id, starts_at, ends_at, booked_at, status, appointment_term, assigned_user_id, outcome_term, call_outcome_term) values ($1,$2,$3,$4,$5,$5,now(),'confirmed',$6,$7,$8,$9)",
          [companyId, ct, cal, `E-${name}`, day(n), term, who, answered ? showed : null, answered ? fu : null]);
      };
      await book(jose, "Tommy", 2); await book(jose, "Kimberly", 1); await book(jose, "Elizabeth", 0);   // today's is not late
      await book(mel, "Ana", 1, true);   // answered: owes nothing
    });
  });

  it("lists each person who owes a day, with the open names; today is left out; someone up to date is not listed", async () => {
    const list = await asOperator(async (c) => missingEods(c, (await loadCompany(c, companyId)).row));
    expect(list.map((p) => [p.name, p.days.map((d) => d.names)])).toEqual([["Jose P", [["Tommy"], ["Kimberly"]]]]);
    expect(missingLines(list)[0]).toMatch(/^Jose P: \w{3} \w{3} \d+ \(Tommy\), \w{3} \w{3} \d+ \(Kimberly\)$/);
    expect(formatMissingEods(list, "PMU")).toMatch(/^⚠️ \*Missing EODs · PMU\* \(2 days\)\n• Jose P: /);
    expect(formatMissingEods([], "PMU")).toMatch(/Everyone is filed/);
    // the closers' private links are never in it; the operator's page is
    expect(formatMissingEods(list, "PMU", "https://biab.test/app/c/pmu/eod")).toMatch(/<https:\/\/biab\.test\/app\/c\/pmu\/eod\|Open each day's form on the End of day page>$/);
    expect(formatMissingEods(list, "PMU", "https://biab.test/app/c/pmu/eod")).not.toMatch(/\/eod\/[a-z0-9]{8,}/i);
  });

  it("/missing-eod plans without a period", () => {
    expect(planCommand({ command: "/missing-eod", text: "", userId: "U", channelId: "C" }, TZ)).toEqual({ plan: { shortcut: "missing-eod", title: "Missing EODs" } });
  });
});
