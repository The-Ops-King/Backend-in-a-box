/** D350: Calendly bookings put on the matching GHL calendar so GHL's pre-call automations fire; cancels and moves follow. */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { asOperator, one } from "@/db/client";
import { migrate } from "@/db/migrate";
import { fakeAdapters } from "./test-install";
import { mirrorMap, mirrorToGhl, pickAssignee } from "./ghl-mirror";
import type { Adapters, AppointmentSnapshot, Company } from "@/adapters/types";

describe("D350: the map and who it's assigned to", () => {
  it("reads the map; anything unreadable is no map", () => {
    expect(mirrorMap({ "booking.ghl_mirror": '{"EVT-RR":"GCAL-RR","EVT-DEMO":"GCAL-DEMO"}' })).toEqual({ "EVT-RR": "GCAL-RR", "EVT-DEMO": "GCAL-DEMO" });
    expect(mirrorMap({ "booking.ghl_mirror": "not json" })).toEqual({});
    expect(mirrorMap({ "booking.ghl_mirror": '["x"]' })).toEqual({});
    expect(mirrorMap({})).toEqual({});
  });
  it("the booking's closer when GHL has them on the calendar's team, else the team's first", () => {
    expect(pickAssignee("JOSE", ["MARY", "JOSE"])).toBe("JOSE");
    expect(pickAssignee("MEL", ["MARY", "JOSE"])).toBe("MARY");
    expect(pickAssignee(null, ["MARY"])).toBe("MARY");
    expect(pickAssignee("JOSE", [])).toBeNull();
  });
});

describe.skipIf(!process.env.DATABASE_URL)("D350: putting bookings on GHL", () => {
  const created: { calendarId: string; contactId: string; assignedUserId: string; startTime: string; address?: string }[] = [];
  const updated: { id: string; patch: Record<string, unknown> }[] = [];
  let existing: AppointmentSnapshot[] = [];
  let refuse: string | null = null;
  const base = fakeAdapters();
  const adapters: Adapters = { ...base,
    booking: { ...base.booking, ghl: { ...base.booking.ghl,
      listCalendars: async () => [{ id: "GCAL-RR", name: "The Beauty Moguls Consultation RR (Calendly)", teamMemberIds: ["G-MARY", "G-JOSE"] }],
      calendarTeam: async (_c: Company, id: string) => (id === "GCAL-HIDDEN" ? ["G-MARY"] : []),
      appointmentsInWindow: async () => existing } },
    write: { ...base.write,
      createAppointment: async (_c: Company, input: (typeof created)[number]) => { if (refuse) throw new Error(refuse); created.push(input); return { id: `GA-${created.length}` }; },
      updateAppointment: async (_c: Company, id: string, patch: Record<string, unknown>) => { updated.push({ id, patch }); } } as unknown as Adapters["write"] };
  const ac = { id: "x", locationId: "L", pit: "p", timezone: "America/New_York", booking: { source: "calendly" } } as unknown as Company;
  let co = "", cal = "", other = "", term = "", mel = "", jose = "";
  const bindings = () => ({ "booking.ghl_mirror": '{"EVT-RR":"GCAL-RR"}', "booking.ghl_mirror_from": "2026-11-19T00:00:00Z" });
  const run = (dryRun = false) => asOperator((c) => mirrorToGhl(c, { companyId: co, ac, adapters, bindings: bindings() }, { dryRun }));
  const hours = (h: number) => new Date(Date.now() + h * 3600e3);
  const booking = (o: { first: string; ghl?: string | null; on?: string; inH?: number; bookedAt?: Date; status?: string; closer?: string }) => asOperator(async (c) => {
    const ct = (await one<{ id: string }>(c, "insert into contacts (company_id, first_name, last_name, ghl_contact_id) values ($1,$2,'Doe',$3) returning id", [co, o.first, o.ghl === undefined ? `G-${o.first}` : o.ghl]))!.id;
    const s = hours(o.inH ?? 24);
    return (await one<{ id: string }>(c, `insert into appointments (company_id, contact_id, source, external_id, calendar_id, appointment_term, assigned_user_id, starts_at, ends_at, booked_at, status, meeting_url)
      values ($1,$2,'calendly',$3,$4,$5,$6,$7,$8,$9,$10,'https://zoom.us/j/1') returning id`,
      [co, ct, `cal-${Math.random()}`, o.on ?? cal, term, o.closer ?? null, s, new Date(s.getTime() + 3600e3), o.bookedAt ?? new Date(), o.status ?? "confirmed"]))!.id;
  });
  const appt = (id: string) => asOperator((c) => one<{ crm_appointment_id: string | null; crm_status: string | null }>(c, "select crm_appointment_id, crm_status from appointments where id=$1", [id]));
  const alert = () => asOperator((c) => one<{ text: string }>(c, "select text from alerts where company_id=$1 and key='appointments:ghl-mirror:GCAL-RR' and resolved_at is null", [co]));

  beforeAll(async () => {
    await migrate();
    await asOperator(async (c) => {
      co = (await one<{ id: string }>(c, "insert into companies (name, slug, timezone) values ('D350',$1,'America/New_York') returning id", [`d350-${Date.now()}`]))!.id;
      await c.query("insert into company_terms (company_id, domain, name, category, is_default, sort) select $1, domain, label, value, true, sort from core_categories", [co]);
      term = (await one<{ id: string }>(c, "select id from company_terms where company_id=$1 and domain='appointment_type' and category='closing' limit 1", [co]))!.id;
      cal = (await one<{ id: string }>(c, "insert into calendars (company_id, source, external_id, name, appointment_term) values ($1,'calendly','EVT-RR','The Beauty Moguls Consultation RR',$2) returning id", [co, term]))!.id;
      other = (await one<{ id: string }>(c, "insert into calendars (company_id, source, external_id, name, appointment_term) values ($1,'calendly','EVT-STRAT','Beauty Moguls Strategy',$2) returning id", [co, term]))!.id;
      jose = (await one<{ id: string }>(c, "insert into users (company_id, email, name, role, ghl_user_id, active) values ($1,'jose@x.test','Jose','closer','G-JOSE',true) returning id", [co]))!.id;
      mel = (await one<{ id: string }>(c, "insert into users (company_id, email, name, role, ghl_user_id, active) values ($1,'mel@x.test','Mel','closer','G-MEL',true) returning id", [co]))!.id;
    });
  }, 180000);
  beforeEach(async () => {
    created.length = 0; updated.length = 0; existing = []; refuse = null;
    await asOperator((c) => c.query("update appointments set status='cancelled', crm_status='cancelled' where company_id=$1", [co]));
  });

  it("a new booking on a mapped calendar: confirmed on GHL at its time, its link on it, assigned to its closer", async () => {
    const a = await booking({ first: "Jane", closer: jose });
    const r = await run();
    expect(r.errors).toBe(0);
    expect(created).toEqual([expect.objectContaining({ calendarId: "GCAL-RR", contactId: "G-Jane", assignedUserId: "G-JOSE", address: "https://zoom.us/j/1" })]);
    expect(await appt(a)).toEqual({ crm_appointment_id: "GA-1", crm_status: "confirmed" });
    expect((await run()).actions).toEqual([]);   // once
  });

  it("a closer GHL doesn't have on the calendar: the team's first; nobody to assign: it says so", async () => {
    await booking({ first: "Mia", closer: mel });
    await run();
    expect(created[0].assignedUserId).toBe("G-MARY");
  });

  it("not put on GHL: a past call, one booked before booking.ghl_mirror_from, an unmapped calendar, a person not in GHL", async () => {
    await booking({ first: "Past", inH: -2 });
    await booking({ first: "Old", bookedAt: new Date("2026-11-01T00:00:00Z") });
    await booking({ first: "Strat", on: other });
    await booking({ first: "NoGhl", ghl: null });
    expect((await run()).actions).toEqual([]);
    expect(created).toEqual([]);
  });

  it("GHL already has it for that person at that time: adopted, never doubled", async () => {
    const a = await booking({ first: "Twin" });
    existing = [{ id: "GA-THERE", calendarId: "GCAL-RR", contactId: "G-Twin", startTime: "", endTime: "", status: "confirmed", raw: {} }];
    expect((await run()).actions).toEqual([expect.objectContaining({ action: "adopt", ghl_id: "GA-THERE" })]);
    expect(created).toEqual([]);
    expect(await appt(a)).toEqual({ crm_appointment_id: "GA-THERE", crm_status: "confirmed" });
  });

  it("cancelled at the source: cancelled on GHL; moved: moved on GHL, still confirmed", async () => {
    const a = await booking({ first: "Cara" }), b = await booking({ first: "Moe" });
    await run();
    const [ga, gb] = [(await appt(a))!.crm_appointment_id, (await appt(b))!.crm_appointment_id];
    await asOperator(async (c) => {
      await c.query("update appointments set status='cancelled' where id=$1", [a]);
      await c.query("update appointments set starts_at=starts_at + interval '1 day', ends_at=ends_at + interval '1 day' where id=$1", [b]);
    });
    await run();
    expect(updated).toEqual(expect.arrayContaining([{ id: ga, patch: { status: "cancelled" } }, { id: gb, patch: expect.objectContaining({ status: "confirmed" }) }]));
    expect((await appt(a))!.crm_status).toBe("cancelled");
    expect((await run()).actions).toEqual([]);
  });

  it("GHL refuses: one alert for the calendar, retried next pass, cleared once it works", async () => {
    const a = await booking({ first: "Rex" });
    refuse = "The user id not part of calendar team.";
    expect((await run()).errors).toBe(1);
    expect((await alert())!.text).toContain("The user id not part of calendar team.");
    expect((await appt(a))!.crm_appointment_id).toBeNull();
    refuse = null;
    await run();
    expect((await appt(a))!.crm_appointment_id).toBe("GA-1");
    expect(await alert()).toBeFalsy();
  });

  it("a calendar GHL's list leaves out (a Calendly integration's): its team read by its id", async () => {
    await asOperator((c) => c.query("update bindings set value=$2 where company_id=$1 and key='booking.ghl_mirror'", [co, Buffer.from('{"EVT-RR":"GCAL-HIDDEN"}')]));
    const hidden = () => asOperator((c) => mirrorToGhl(c, { companyId: co, ac, adapters, bindings: { ...bindings(), "booking.ghl_mirror": '{"EVT-RR":"GCAL-HIDDEN"}' } }));
    await booking({ first: "Hid", closer: jose });
    expect((await hidden()).errors).toBe(0);
    expect(created).toEqual([expect.objectContaining({ calendarId: "GCAL-HIDDEN", assignedUserId: "G-MARY" })]);
  });

  it("a dry run says what it would do and writes nothing", async () => {
    const a = await booking({ first: "Dry" });
    expect((await run(true)).actions).toEqual([expect.objectContaining({ action: "create", who: "Dry Doe", assignee: "G-MARY" })]);
    expect(created).toEqual([]);
    expect((await appt(a))!.crm_appointment_id).toBeNull();
  });
});
