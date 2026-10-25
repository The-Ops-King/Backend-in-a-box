/** D237: the health check names each closing call coming up with no meeting link, and stops once the link comes. */
import { describe, it, expect, beforeAll } from "vitest";
import { DateTime } from "luxon";
import { asOperator, one } from "@/db/client";
import { migrate } from "@/db/migrate";
import { installCompany } from "./install";
import { sweep, CHECKS, type HealthProbes } from "./health";
import { fakeAdapters } from "./test-install";

process.env.BINDINGS_KEY ??= Buffer.alloc(32, 7).toString("base64");
const SLUG = `d236-${Date.now()}`;
const TZ = "America/Phoenix";
const NOW = DateTime.fromISO("2026-10-26T09:00:00", { zone: TZ }) as DateTime<true>;
let co = "";
const ids: Record<string, string> = {};

describe.skipIf(!process.env.DATABASE_URL)("D237: upcoming calls with no meeting link", () => {
  beforeAll(async () => {
    await migrate();
    co = (await installCompany({ name: "No Link", slug: SLUG, timezone: TZ, locationId: "LOC-D237", pit: "pit-fake", calendars: {}, templates: [] }, fakeAdapters())).companyId;
    await asOperator(async (c) => {
      const term = async (cat: string) => (await one<{ id: string }>(c, "select id from company_terms where company_id=$1 and domain='appointment_type' and category=$2 limit 1", [co, cat]))!.id;
      const closing = await term("closing"), first = await term("first_call");
      const sam = (await one<{ id: string }>(c, "insert into users (company_id, email, name, role) values ($1,'sam@x.com','Sam Closer','closer') returning id", [co]))!.id;
      const book = async (key: string, o: { hours: number; term?: string; link?: boolean; status?: string; source?: string }) => {
        const ct = (await one<{ id: string }>(c, "insert into contacts (company_id, ghl_contact_id, first_name, last_name, timezone) values ($1,$2,$3,'Doe',$4) returning id", [co, `G-${key}`, key, TZ]))!.id;
        const at = NOW.plus({ hours: o.hours });
        ids[key] = (await one<{ id: string }>(c, `insert into appointments (company_id, contact_id, source, external_id, appointment_term, assigned_user_id, starts_at, ends_at, booked_at, status, meeting_url)
          values ($1,$2,$3,$4,$5,$6,$7,$8,now(),$9,$10) returning id`, [co, ct, o.source ?? "calendly", `A-${key}`, o.term ?? closing, sam, at.toJSDate(), at.plus({ minutes: 45 }).toJSDate(), o.status ?? "confirmed", o.link ? "https://zoom.us/j/1" : null]))!.id;
      };
      await book("Nolink", { hours: 30 });
      await book("Linked", { hours: 5, link: true });
      await book("Triage", { hours: 5, term: first });
      await book("Cancelled", { hours: 5, status: "cancelled" });
      await book("Later", { hours: 72 });
      await book("Past", { hours: -2 });
      await book("Staged", { hours: 5, source: "test" });
    });
  });

  const run = async (row: Record<string, unknown> = {}) => {
    const checks = Object.fromEntries(CHECKS.map((k) => [k.id, k.id === "meeting_links"]));
    const company = await asOperator((c) => one(c, "select * from companies where id=$1", [co]));
    return (await asOperator((c) => sweep(c, company as never, fakeAdapters(), {} as HealthProbes, { checks, min_slots: 0, slots_days: 7, ...row }, NOW))).filter((f) => f.check === "meeting_links");
  };

  it("a closing call in the next 48 hours with no link is named, with its time, closer and CRM link; one with a link, a triage call, a cancelled, past, later or staged call is not", async () => {
    const f = await run();
    expect(f).toEqual([expect.objectContaining({ item: ids.Nolink, ok: false, level: "warning", text: "Nolink Doe's call Tue Oct 27, 3:00 PM has no meeting link (Sam Closer). Send them the link.",
      href: "https://app.gohighlevel.com/v2/location/LOC-D237/contacts/detail/G-Nolink" })]);
  });

  it("the window is the step's meeting_link_hours; the link arriving clears it", async () => {
    expect((await run({ meeting_link_hours: 96 })).map((f) => f.item).sort()).toEqual([ids.Later, ids.Nolink].sort());
    await asOperator((c) => c.query("update appointments set meeting_url='https://zoom.us/j/2' where id=$1", [ids.Nolink]));
    expect(await run()).toEqual([expect.objectContaining({ ok: true, text: "Every closing call in the next 48 hours has a meeting link." })]);
  });
});
