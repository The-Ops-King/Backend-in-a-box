/** D335: a calendar's call type is the offer's own, never the generic default beside it; a watched one with the wrong type is put right. */
import { describe, it, expect, beforeAll } from "vitest";
import { asOperator, one } from "@/db/client";
import { migrate } from "@/db/migrate";
import { installCompany } from "./install";
import { calendarWatch } from "./contact-ops";
import { fakeAdapters } from "./test-install";
import type { Adapters } from "@/adapters/types";

process.env.BINDINGS_KEY ??= Buffer.alloc(32, 7).toString("base64");
const SLUG = `d334-${Date.now()}`;
let co = "";
const base = fakeAdapters();
const cals = [{ id: "TAYLOR", name: "Consultation with Taylor", teamMemberIds: [] }, { id: "JUDITH", name: "Consultation with Judith", teamMemberIds: [] }, { id: "OTHER", name: "Other", teamMemberIds: [] }];
const fake: Adapters = { ...base, booking: { ...base.booking, ghl: { ...base.booking.ghl, listCalendars: async () => cals } } } as Adapters;
const watch = (calendar: string, extra: Record<string, unknown> = {}) => asOperator((c) => calendarWatch(c, fake, { company: SLUG, calendar, term: "closing", why: "test", ...extra } as never));
const termOf = (ext: string) => asOperator((c) => one<{ term: string }>(c, "select t.name as term from calendars k join company_terms t on t.id=k.appointment_term where k.company_id=$1 and k.external_id=$2", [co, ext])).then((r) => r?.term);

describe.skipIf(!process.env.DATABASE_URL)("D335: the offer's own call type", () => {
  beforeAll(async () => {
    await migrate();
    co = (await installCompany({ name: "D335", slug: SLUG, timezone: "UTC", locationId: "LOC-D335", pit: "pit", calendars: {}, templates: [] }, fake)).companyId;
  });

  it("named only by its kind, a calendar takes the call type the offer's other calendars of that kind use, not the generic default", async () => {
    expect(await watch("TAYLOR", { name: "Closing call", dryRun: false })).toMatchObject({ ok: true, was: "not watched" });
    expect(await watch("JUDITH", { dryRun: false })).toMatchObject({ ok: true, maps: expect.stringContaining("Closing call (closing)") });
    expect(await termOf("JUDITH")).toBe("Closing call");
  });

  it("two of that kind in use and none named is a question, not a guess", async () => {
    expect(await watch("OTHER", { name: "Strategy call", dryRun: false })).toMatchObject({ ok: true });
    expect(await watch("OTHER", { calendar: "OTHER" })).toMatchObject({ ok: true, maps: "already watched: nothing changed" });
    await asOperator((c) => c.query("update calendars set active=false where company_id=$1 and external_id='OTHER'", [co]));
    const fresh = [...cals, { id: "NEW", name: "New", teamMemberIds: [] }];
    const f2: Adapters = { ...fake, booking: { ...fake.booking, ghl: { ...fake.booking.ghl, listCalendars: async () => fresh } } } as Adapters;
    await asOperator((c) => c.query("update calendars set active=true where company_id=$1 and external_id='OTHER'", [co]));
    expect(await asOperator((c) => calendarWatch(c, f2, { company: SLUG, calendar: "NEW", term: "closing", why: "t", dryRun: false }))).toMatchObject({ ok: false, status: 400, error: expect.stringMatching(/say which/) });
  });

  it("a watched calendar with the wrong call type is put right, its bookings with it; the dry run says how many", async () => {
    await asOperator(async (c) => {
      const generic = (await one<{ id: string }>(c, "select id from company_terms where company_id=$1 and domain='appointment_type' and category='closing' and is_default", [co]))!.id;
      const k = (await one<{ id: string }>(c, "update calendars set appointment_term=$2 where company_id=$1 and external_id='JUDITH' returning id", [co, generic]))!.id;
      const ct = (await one<{ id: string }>(c, "insert into contacts (company_id, ghl_contact_id, first_name) values ($1,'G-D','Denise') returning id", [co]))!.id;
      await c.query("insert into appointments (company_id, contact_id, external_id, calendar_id, appointment_term, starts_at, ends_at, booked_at, status, source) values ($1,$2,'BK1',$3,$4, now()+interval '1 day', now()+interval '1 day 1 hour', now(),'confirmed','ghl')", [co, ct, k, generic]);
    });
    expect(await termOf("JUDITH")).toBe("Closing");
    expect(await watch("JUDITH", { name: "Closing call" })).toMatchObject({ ok: true, dryRun: true, maps: 'call type "Closing" → "Closing call" (its 1 booking with it)' });
    expect(await termOf("JUDITH")).toBe("Closing");
    expect(await watch("JUDITH", { name: "Closing call", dryRun: false })).toMatchObject({ ok: true, dryRun: false });
    expect(await termOf("JUDITH")).toBe("Closing call");
    expect(await asOperator((c) => one(c, "select t.name from appointments a join company_terms t on t.id=a.appointment_term where a.company_id=$1 and a.external_id='BK1'", [co]))).toEqual({ name: "Closing call" });
    expect(await asOperator((c) => one(c, "select 1 from audit_log where company_id=$1 and action='calendar.remapped'", [co]))).toBeTruthy();
    expect(await asOperator((c) => one(c, "select (config->>'catch_up') as cu from calendars where company_id=$1 and external_id='JUDITH'", [co]))).toEqual({ cu: "true" });   // set when first watched; a remap adds none
  });
});
