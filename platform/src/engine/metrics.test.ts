/** Setter metrics (D64): two setters, four leads, dials at known offsets; medians, averages, counts and the unassigned row. */
import { describe, it, expect, beforeAll } from "vitest";
import { asOperator, one } from "@/db/client";
import { migrate } from "@/db/migrate";
import { recordPhoneCall } from "./recordings";
import { setterMetrics } from "./metrics";

process.env.BINDINGS_KEY ??= Buffer.alloc(32, 7).toString("base64");
let companyId: string, term: string;
const T = (iso: string) => new Date(iso);
const min = (d: Date, m: number) => new Date(d.getTime() + m * 60_000);
// Phoenix (UTC-7, no DST): 2026-10-06 10:00 local = 17:00Z
const L1 = T("2026-10-06T17:00:00Z"), L2 = T("2026-10-06T18:00:00Z"), L3 = T("2026-10-07T16:00:00Z"), L4 = T("2026-10-07T19:00:00Z"), L5 = T("2026-10-05T16:00:00Z");

describe.skipIf(!process.env.DATABASE_URL)("setter metrics", () => {
  beforeAll(async () => {
    await migrate();
    await asOperator(async (c) => {
      const co = await one<{ id: string }>(c, "select id from companies where slug='metrics'");
      if (co) { for (const t of ["audit_log", "events", "recordings", "appointments", "contacts", "users", "company_terms"]) await c.query(`delete from ${t} where company_id=$1`, [co.id]); await c.query("delete from companies where id=$1", [co.id]); }
      companyId = (await one<{ id: string }>(c, "insert into companies (name, slug, timezone) values ('Metrics','metrics','America/Phoenix') returning id"))!.id;
      await c.query(`insert into company_terms (company_id, domain, name, category, is_default, sort) select $1, domain, label, value, true, sort from core_categories`, [companyId]);
      term = (await one<{ id: string }>(c, "select id from company_terms where company_id=$1 and domain='appointment_type' and category='closing'", [companyId]))!.id;
      await c.query("insert into users (company_id, email, name, role, ghl_user_id) values ($1,'luis@co.com','Luis','setter','U-LUIS'),($1,'mia@co.com','Mia','setter','U-MIA')", [companyId]);
      const lead = async (ghl: string, name: string, addedAt: Date, owner: string | null) => (await one<{ id: string }>(c, "insert into contacts (company_id, ghl_contact_id, first_name, ghl_added_at, assigned_ghl_user_id) values ($1,$2,$3,$4,$5) returning id", [companyId, ghl, name, addedAt, owner]))!.id;
      const l1 = await lead("C1", "One", L1, "U-LUIS"), l2 = await lead("C2", "Two", L2, "U-LUIS"), l3 = await lead("C3", "Three", L3, "U-MIA");
      await lead("C4", "Four", L4, "U-LUIS");                 // never dialled
      const l5 = await lead("C5", "Five", L5, "U-LUIS");      // arrived before the period; a dial to them in the period still counts as a dial
      const call = (externalId: string, contactId: string, startedAt: Date, status: string, durationSec: number, caller?: string, over: Partial<Parameters<typeof recordPhoneCall>[2]> = {}) =>
        recordPhoneCall(c, companyId, { externalId, contactId, startedAt, durationSec, direction: "outbound", status, callerGhlUserId: caller, ...over });
      await call("k1", l1, min(L1, 10), "completed", 120, "U-LUIS");                 // Luis, connected, 10 min after arrival
      await call("k2", l2, min(L2, 30), "no-answer", 0, "U-LUIS");                   // Luis, missed, 30 min: still the first dial
      await call("k3", l2, min(L2, 60), "completed", 90, "U-MIA");                   // Mia reaches the same lead later; speed to lead stays Luis's
      await call("k4", l3, min(L3, 5), "completed", 30, "U-MIA");                    // answered but under reached_seconds (60)
      await call("k5", l3, min(L3, 20), "completed", 200, "U-MIA");
      await call("k6", l1, min(L1, 120), "no-answer", 0);                            // no caller stamped
      await call("k7", l5, min(L1, 5), "busy", 0, "U-LUIS");                         // an old lead dialled in the period
      await call("k8", l1, min(L1, 15), "completed", 300, "U-LUIS", { direction: "inbound" });          // inbound: not a dial
      await call("k9", l1, min(L1, 16), "completed", 300, "U-LUIS", { raw: { simulated: true } });     // harness: never counts
      const appt = (ext: string, contactId: string, bookedAt: Date, setBy: string | null) => c.query("insert into appointments (company_id, contact_id, source, external_id, appointment_term, starts_at, ends_at, booked_at, status, self_booked, set_by) values ($1,$2,'ghl',$3,$4,$5,$5,$6,'confirmed',false,$7)", [companyId, contactId, ext, term, min(bookedAt, 24 * 60), bookedAt, setBy]);
      await appt("A1", l1, min(L1, 70), null);                      // an hour after Luis's dial, before the unassigned one: Luis's
      await appt("A2", l2, min(L2, 60 + 25 * 60), "Mia");            // more than a day after any dial, still in the period: the booking source named her
    });
  });

  it("per setter: leads, dials, connected, reached, speed to lead (median and average), never dialled, bookings", async () => {
    const m = await asOperator((c) => setterMetrics(c, companyId, { from: "2026-10-06", to: "2026-10-07" }));
    expect(m.setters.map((s) => s.name)).toEqual(["Luis", "Mia", "unassigned"]);
    const [luis, mia, none] = m.setters;
    expect(luis).toMatchObject({ leads_assigned: 3, never_dialled: 1, dials: 3, answered: 1, connected: 1, talk_sec: 120, contacts_reached: 1, leads_dialled_first: 2, bookings: 1 });
    expect(luis.stl_median_min).toBeCloseTo(20, 5); expect(luis.stl_avg_min).toBeCloseTo(20, 5);
    expect(mia).toMatchObject({ leads_assigned: 1, never_dialled: 0, dials: 3, answered: 3, connected: 2, talk_sec: 290, contacts_reached: 2, leads_dialled_first: 1, bookings: 1 });
    expect(mia.stl_median_min).toBeCloseTo(5, 5); expect(mia.stl_avg_min).toBeCloseTo(5, 5);
    expect(none).toMatchObject({ id: "unassigned", leads_assigned: 0, dials: 1, answered: 0, connected: 0, leads_dialled_first: 0, bookings: 0, stl_median_min: null });
  });
  it("totals: every lead that arrived, every dial, the median over all first dials, bookings counted once", async () => {
    const m = await asOperator((c) => setterMetrics(c, companyId, { from: "2026-10-06", to: "2026-10-07" }));
    expect(m).toMatchObject({ from: "2026-10-06", to: "2026-10-07", timezone: "America/Phoenix", reached_seconds: 60 });
    expect(m.totals).toMatchObject({ leads_assigned: 4, never_dialled: 1, dials: 7, answered: 4, connected: 3, talk_sec: 410, contacts_reached: 3, leads_dialled_first: 3, bookings: 2 });
    expect(m.totals.stl_median_min).toBeCloseTo(10, 5); expect(m.totals.stl_avg_min).toBeCloseTo(15, 5);
  });
  it("the range is the company's local days: a single day holds only that day's leads and dials", async () => {
    const m = await asOperator((c) => setterMetrics(c, companyId, { from: "2026-10-07", to: "2026-10-07" }));
    expect(m.totals).toMatchObject({ leads_assigned: 2, never_dialled: 1, dials: 2, connected: 1, leads_dialled_first: 1, bookings: 1 });   // A2 was booked that day
    expect(m.setters.map((s) => s.name)).toEqual(["Mia", "Luis"]);   // Luis: no dials that day, but a lead was assigned to him
    expect(m.setters[0]).toMatchObject({ dials: 2, bookings: 1 }); expect(m.setters[1]).toMatchObject({ dials: 0, leads_assigned: 1, never_dialled: 1, bookings: 0 });
    const empty = await asOperator((c) => setterMetrics(c, companyId, { from: "2026-09-01", to: "2026-09-02" }));
    expect(empty.setters).toEqual([]); expect(empty.totals.stl_median_min).toBeNull();
  });
});
