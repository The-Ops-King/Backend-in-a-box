/** D213: a calendar kept only for the calls already booked on it (`alerts: false`) is left out of the availability alerts; its bookings stay watched. */
import { describe, it, expect, beforeAll } from "vitest";
import { asOperator, one } from "@/db/client";
import { migrate } from "@/db/migrate";
import { installCompany } from "./install";
import { readCalendars, type HealthProbes } from "./health";
import { calendarAlerts } from "./contact-ops";
import { fakeAdapters } from "./test-install";

process.env.BINDINGS_KEY ??= Buffer.alloc(32, 7).toString("base64");
const SLUG = `d213-${Date.now()}`;
let co = "";
const probes = { ghlFreeSlots: async () => ({ ok: true, slots: 0, times: [] }), ghlCalendarTeam: async () => ({ ok: true, userIds: [] }) } as unknown as HealthProbes;

describe.skipIf(!process.env.DATABASE_URL)("D213: a calendar's availability alerts can be off", () => {
  beforeAll(async () => {
    await migrate();
    co = (await installCompany({ name: "Cal Alerts", slug: SLUG, timezone: "America/Phoenix", locationId: "LOC-D213", pit: "pit-fake", calendars: {}, templates: [] }, fakeAdapters())).companyId;
    await asOperator(async (c) => {
      const term = (await one<{ id: string }>(c, "select id from company_terms where company_id=$1 and domain='appointment_type' limit 1", [co]))!.id;
      for (const [ext, name] of [["NEW", "New link"], ["OLD", "Old link"]]) await c.query("insert into calendars (company_id, source, external_id, name, appointment_term) values ($1,'ghl',$2,$3,$4)", [co, ext, name, term]);
    });
  });

  it("off: the old link says nothing (empty or gone), the new one is still checked; on again: it is checked again; the switch is audited and dry-runs first", async () => {
    const row = { checks: { ghl_calendars: true, availability: false }, min_slots: 0, slots_days: 7 } as never;
    const company = async () => asOperator((c) => one(c, "select * from companies where id=$1", [co])) as never;
    const items = async () => (await asOperator(async (c) => readCalendars(c, await company(), fakeAdapters(), probes, row))).filter((f) => f.check === "ghl_calendars" && f.item).map((f) => f.item).sort();
    expect(await items()).toEqual(["NEW", "OLD"]);
    expect(await asOperator((c) => calendarAlerts(c, { company: SLUG, calendar: "OLD", alerts: false, why: "test" }))).toMatchObject({ ok: true, dryRun: true, was: true, alerts: false });
    expect(await items()).toEqual(["NEW", "OLD"]);
    expect(await asOperator((c) => calendarAlerts(c, { company: SLUG, calendar: "OLD", alerts: false, why: "test", dryRun: false }))).toMatchObject({ ok: true, dryRun: false, was: true });
    expect(await items()).toEqual(["NEW"]);
    expect(await asOperator((c) => one(c, "select active from calendars where company_id=$1 and external_id='OLD'", [co]))).toEqual({ active: true });   // still watched for its bookings
    await asOperator((c) => calendarAlerts(c, { company: SLUG, calendar: "OLD", alerts: true, why: "test", dryRun: false }));
    expect(await items()).toEqual(["NEW", "OLD"]);
  });
});
