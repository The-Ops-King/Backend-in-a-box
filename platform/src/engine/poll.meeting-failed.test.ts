/** D242: a booking whose meeting the source could not make (Calendly's Zoom failed) is an alert the minute it books, naming the host; the link arriving closes it. */
import { describe, it, expect, beforeAll } from "vitest";
import { DateTime } from "luxon";
import { asOperator, one } from "@/db/client";
import { migrate } from "@/db/migrate";
import { encrypt } from "@/engine/crypto";
import { pollCompany, meetingFailedKey } from "@/engine/poll";
import { fakeAdapters } from "@/engine/test-install";
import type { Adapters, AppointmentSnapshot, BookingRead } from "@/adapters/types";

process.env.BINDINGS_KEY ??= Buffer.alloc(32, 7).toString("base64");
let companyId = "";
const start = DateTime.now().plus({ days: 1 }).startOf("hour").toISO()!;
let snap: AppointmentSnapshot = { id: "EV-Z", calendarId: "CAL1", invitee: { email: "jonelle@x.test", firstName: "Jonelle" }, assignedUserEmail: "carly@x.test", startTime: start, endTime: start, status: "confirmed", meetingFailed: "zoom", dateUpdated: "2026-10-26T14:08:16Z", dateAdded: "2026-10-26T14:08:11Z" } as AppointmentSnapshot;
const read: BookingRead = { appointmentsInWindow: async () => [snap], getAppointment: async () => null, listCalendars: async () => [] };
const base = fakeAdapters();
const fake: Adapters = { ...base, booking: { ghl: read, calendly: read } };

describe.skipIf(!process.env.DATABASE_URL)("D242: a failed meeting is said the minute the call books", () => {
  beforeAll(async () => {
    await migrate();
    await asOperator(async (c) => {
      companyId = (await one<{ id: string }>(c, "insert into companies (name, slug, timezone) values ('D242',$1,'America/New_York') returning id", [`d242-${Date.now()}`]))!.id;
      await c.query("insert into bindings (company_id,key,kind,value) values ($1,'crm.location_id','id',$2),($1,'secret.ghl_pit','secret',$3)", [companyId, Buffer.from("L"), encrypt("p")]);
      await c.query("insert into company_terms (company_id, domain, name, category, is_default, sort) select $1, domain, label, value, true, sort from core_categories", [companyId]);
      await c.query("insert into calendars (company_id, source, external_id, name, appointment_term) select $1, 'ghl', 'CAL1', 'Closer', id from company_terms where company_id=$1 and domain='appointment_type' and category='closing'", [companyId]);
      await c.query("insert into users (company_id, email, name, role) values ($1,'carly@x.test','Carly Vu','closer')", [companyId]);
      await c.query("insert into poll_cursors (company_id, entity, cursor, last_success_at) values ($1,'appointments:CAL1','2026-10-01T00:00:00Z',now()) on conflict do nothing", [companyId]);
    });
  });

  it("raised on booking, naming the host and what to do; closed when the link turns up", async () => {
    await pollCompany(fake, companyId);
    const appt = (await asOperator((c) => one<{ id: string }>(c, "select id from appointments where company_id=$1 and external_id='EV-Z'", [companyId])))!.id;
    const open = await asOperator((c) => one<{ text: string }>(c, "select text from alerts where company_id=$1 and key=$2 and resolved_at is null", [companyId, meetingFailedKey(appt)]));
    expect(open?.text).toMatch(/^Jonelle just booked a call with Carly Vu \(.+\) and Calendly could not make the Zoom: Carly Vu's Zoom is not connected in Calendly\./);
    snap = { ...snap, meetingFailed: undefined, meetingUrl: "https://zoom.us/j/1", dateUpdated: "2026-10-26T15:00:00Z" };
    await pollCompany(fake, companyId);
    expect(await asOperator((c) => one(c, "select 1 from alerts where company_id=$1 and key=$2 and resolved_at is null", [companyId, meetingFailedKey(appt)]))).toBeFalsy();
  });
});
