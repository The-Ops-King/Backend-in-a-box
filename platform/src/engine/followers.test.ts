/** D268: who set a closing call follows the contact: the setter whose link booked it, and whoever ran the triage before it. */
import { describe, it, expect, beforeAll } from "vitest";
import { asOperator, one } from "@/db/client";
import { migrate } from "@/db/migrate";
import { setsToFollow } from "@/engine/followers";

const TABLES = ["appointments", "contact_identifiers", "contacts", "calendars", "users", "company_terms"];
let co: string;
const ids: Record<string, string> = {};
describe.skipIf(!process.env.DATABASE_URL)("D268: setters to follow their sets", () => {
  beforeAll(async () => {
    await migrate();
    await asOperator(async (c) => {
      const old = await one<{ id: string }>(c, "select id from companies where slug='follow'");
      if (old) { for (const t of TABLES) await c.query(`delete from ${t} where company_id=$1`, [old.id]); await c.query("delete from companies where id=$1", [old.id]); }
      co = (await one<{ id: string }>(c, "insert into companies (name, slug, timezone) values ('Follow','follow','UTC') returning id"))!.id;
      await c.query("insert into company_terms (company_id, domain, name, category, is_default, sort) select $1, domain, label, value, true, sort from core_categories", [co]);
      const term = async (cat: string) => (await one<{ id: string }>(c, "select id from company_terms where company_id=$1 and domain='appointment_type' and category=$2 order by sort limit 1", [co, cat]))!.id;
      const closing = await term("closing"), triage = await term("first_call");
      for (const [k, name, ghl] of [["jake", "Jake Taylor", "GJ"], ["mitch", "Mitch Sapoff", "GM"], ["nelly", "Nelly S.", "GN"]]) ids[k] = (await one<{ id: string }>(c, "insert into users (company_id, email, name, role, ghl_user_id) values ($1,$2,$3,'setter',$4) returning id", [co, `${k}@f.test`, name, ghl]))!.id;
      const person = async (first: string, tags = "{}") => (await one<{ id: string }>(c, "insert into contacts (company_id, ghl_contact_id, first_name, tags) values ($1,$2,$3,$4) returning id", [co, `C-${first}`, first, tags]))!.id;
      const appt = (contact: string, t: string, ext: string, startsAgoH: number, bookedAgoH: number, user: string | null, setBy: string | null, status = "confirmed") =>
        c.query("insert into appointments (company_id, contact_id, source, external_id, starts_at, ends_at, booked_at, status, appointment_term, assigned_user_id, set_by) values ($1,$2,'ghl',$3,now() - make_interval(hours => $4),now() - make_interval(hours => $4) + interval '30 minutes',now() - make_interval(hours => $5),$6,$7,$8,$9)",
          [co, contact, ext, startsAgoH, bookedAgoH, status, t, user, setBy]);
      const ana = await person("Ana"), bo = await person("Bo"), cy = await person("Cy"), di = await person("Di"), ed = await person("Ed", "{sys-test}");
      await appt(ana, closing, "A", -24, 2, ids.nelly, "Jake Taylor");                                   // booked by Jake's link
      await appt(bo, triage, "B0", 5, 48, ids.mitch, null); await appt(bo, closing, "B", -24, 4, ids.nelly, "Jake Taylor");   // triaged by Mitch, booked by Jake: both
      await appt(cy, closing, "C", -24, 3, ids.nelly, null);                                             // self-booked, no triage: nobody
      await appt(di, triage, "D0", -10, 48, ids.mitch, null); await appt(di, closing, "D", -24, 3, ids.nelly, null);   // the triage comes after the booking: not its setter
      await appt(ed, closing, "E", -24, 3, ids.nelly, "Jake Taylor");                                    // a test contact
      await appt(ana, closing, "A-old", 900, 40 * 24, ids.nelly, "Mitch Sapoff");                        // booked before the window
    });
  });
  it("lists each set with its setters and why; self-booked, test and old ones are not listed", async () => {
    const sets = await asOperator((c) => setsToFollow(c, co, { since: new Date(Date.now() - 30 * 864e5), domains: [] }));
    expect(sets.map((s) => [s.contact, s.setters.map((u) => `${u.name}:${u.why}`)])).toEqual([["Bo", ["Jake Taylor:set_link", "Mitch Sapoff:triage"]], ["Ana", ["Jake Taylor:set_link"]]]);
  });
});
