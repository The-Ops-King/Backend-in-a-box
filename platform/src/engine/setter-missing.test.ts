/**
 * D121: a booking the engine takes as setter-booked whose setter nobody can name raises one engine alert, keyed by the
 * booking, closed (and the name put on the booking) the minute the setter is known; never a quiet "unknown". Every company:
 * a GHL calendar carries no setter, so a Dating-like setter calendar alerts on every booking until someone says; a Calendly
 * company (Hair's and PMU's shapes) alerts only when the setter question has no answer.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { DateTime } from "luxon";
import { asOperator, many, one } from "@/db/client";
import { migrate } from "@/db/migrate";
import { encrypt } from "@/engine/crypto";
import { installCompany } from "@/engine/install";
import { pollCompany } from "@/engine/poll";
import { fakeAdapters } from "@/engine/test-install";
import { mapEvent, type RawEvent, type RawInvitee } from "@/adapters/calendly/read";
import { SETTER_ALERT } from "@/engine/setter-missing";
import type { Adapters, AppointmentSnapshot, ContactSnapshot } from "@/adapters/types";

process.env.BINDINGS_KEY ??= Buffer.alloc(32, 7).toString("base64");
const NOW = DateTime.now();
const iso = (d: DateTime) => d.toUTC().toISO()!;
const START = NOW.plus({ days: 1 }).set({ hour: 15, minute: 0, second: 0, millisecond: 0 });
type Alert = { key: string; level: string; source: string; text: string; detail: Record<string, unknown>; resolved_at: Date | null };
const alertsOf = (companyId: string) => asOperator((c) => many<Alert>(c, "select key, level, source, text, detail, resolved_at from alerts where company_id=$1 and key like $2 order by first_seen", [companyId, `${SETTER_ALERT}%`]));
const apptOf = (companyId: string, ext: string) => asOperator((c) => one<{ id: string; self_booked: boolean | null; set_by: string | null }>(c, "select id, self_booked, set_by from appointments where company_id=$1 and external_id=$2", [companyId, ext]));

describe.skipIf(!process.env.DATABASE_URL)("D121: a setter-booked call with no setter is an engine alert", () => {
  // --- a Dating-like company: GHL calendars (no setter on a booking), a setter calendar, scope tag, shadow ---
  const crm = new Map<string, ContactSnapshot>();
  const person = (id: string, first: string, fields: Record<string, unknown> = {}): ContactSnapshot => ({ id, firstName: first, lastName: "Doe", tags: [], customFields: fields, email: `${id.toLowerCase()}@x.com`, dateUpdated: iso(NOW), dateAdded: iso(NOW.minus({ hours: 1 })) });
  let appts: AppointmentSnapshot[] = [];
  const reads: string[] = [];
  const base = fakeAdapters({ crm });
  const ghl: Adapters = { ...base,
    read: { ...base.read, getContact: async (_c, id) => { reads.push(id); return crm.get(id) ?? null; } },
    booking: { ...base.booking, ghl: { ...base.booking.ghl, appointmentsInWindow: async (_c, cal) => appts.filter((a) => a.calendarId === cal),
      listCalendars: async () => ["SET", "SELF", "Q"].map((id) => ({ id, name: { SET: "Dating – Strategy Call (Setter)", SELF: "Dating – Strategy Call (Direct)", Q: "Asks" }[id]!, teamMemberIds: [] })) } },
  };
  const booking = (id: string, calendarId: string, contactId: string, at = START): AppointmentSnapshot => ({ id, calendarId, contactId, startTime: iso(at), endTime: iso(at.plus({ minutes: 45 })), status: "confirmed", dateAdded: iso(NOW), raw: {} });
  let dating: string;
  const pollDating = () => pollCompany(ghl, dating);

  // --- a Calendly company with Hair's setter calendar (the calendar rule, D24) and PMU's (booking: setter) ---
  let cal: string;
  let events: AppointmentSnapshot[] = [];
  const cbase = fakeAdapters();
  const calendly: Adapters = { ...cbase, booking: { ...cbase.booking, calendly: { ...cbase.booking.calendly, appointmentsInWindow: async (_c, id) => events.filter((e) => e.calendarId === id) } } };
  const invitee = (id: string, calendarId: string, setBy?: string): AppointmentSnapshot => ({ id, calendarId, startTime: iso(START), endTime: iso(START.plus({ minutes: 45 })), status: "confirmed", invitee: { email: `${id}@x.com`, firstName: id, lastName: "Lee" }, setBy, raw: {} });

  beforeAll(async () => {
    await migrate();
    dating = (await installCompany({ name: "Dating Setter", slug: `setter-${Date.now()}`, timezone: "America/New_York", locationId: "LOC", pit: "pit", scopeTag: "dating",
      calendars: { SET: { term: "closing", booking: "setter" }, SELF: { term: "closing", booking: "self" }, Q: { term: "closing", booking: "question" } }, crm: { field_contact_setter: "fSetter" } }, ghl)).companyId;
    await asOperator((c) => c.query("update companies set status='onboarding' where id=$1", [dating]));   // never in another test's pollAll
    await pollDating();   // the silent baseline

    await asOperator(async (c) => {
      cal = (await one<{ id: string }>(c, "insert into companies (name, slug, timezone, status) values ('Cal setter',$1,'America/New_York','onboarding') returning id", [`calset-${Date.now()}`]))!.id;
      await c.query("insert into company_terms (company_id, domain, name, category, is_default, sort) select $1, domain, label, value, true, sort from core_categories", [cal]);
      await c.query("insert into bindings (company_id,key,kind,value) values ($1,'crm.location_id','id',$2),($1,'secret.ghl_pit','secret',$3),($1,'secret.calendly_token','secret',$4),($1,'calendly.organization','id',$5)", [cal, Buffer.from("L"), encrypt("p"), encrypt("tok"), Buffer.from("https://api.calendly.com/organizations/O")]);
      const term = (await one<{ id: string }>(c, "select id from company_terms where company_id=$1 and domain='appointment_type' and category='closing'", [cal]))!.id;
      await c.query(`insert into calendars (company_id, source, external_id, name, appointment_term, self_booked, config) values
        ($1,'calendly','HAIR_S','45 Min Strategy Call - S',$2,false,'{}'), ($1,'calendly','PMU_S','The Beauty Moguls Consultation S',$2,false,'{"booking":"setter"}'),
        ($1,'calendly','DIRECT','45 Min Strategy Call',$2,true,'{}')`, [cal, term]);
    });
    await pollCompany(calendly, cal);
  }, 60_000);
  afterAll(async () => { for (const id of [dating, cal]) if (id) await asOperator((c) => c.query("update runs set status='exited', next_run_at=null where company_id=$1", [id])); });

  it("a GHL setter-calendar booking (no setter on it, ever) raises one error, in shadow, worded plainly; a self or question booking raises none", async () => {
    crm.set("C1", person("C1", "Ann")); crm.set("C2", person("C2", "Bo")); crm.set("C3", person("C3", "Cy"));
    appts = [booking("A1", "SET", "C1"), booking("A2", "SELF", "C2"), booking("A3", "Q", "C3")];
    await pollDating();
    const a1 = (await apptOf(dating, "A1"))!;
    expect(a1).toMatchObject({ self_booked: false, set_by: null });
    expect((await apptOf(dating, "A2"))!.self_booked).toBe(true);
    expect((await apptOf(dating, "A3"))!.self_booked).toBe(true);   // a question nobody answered is self-booked (D24), not a missing setter
    const al = await alertsOf(dating);
    expect(al).toHaveLength(1);
    expect(al[0]).toMatchObject({ key: `${SETTER_ALERT}${a1.id}`, level: "error", source: "engine", resolved_at: null });
    const when = START.setZone("America/New_York").toFormat("ccc LLL d, h:mm a ZZZZ");
    expect(al[0].text).toBe(`Setter-booked call with no setter: Ann Doe, ${when} on Dating – Strategy Call (Setter). Say who set it: put the setter's name in Ann Doe's Setter field in GHL and this clears.`);
    expect((await asOperator((c) => one<{ mode: string }>(c, "select mode from companies where id=$1", [dating])))!.mode).toBe("shadow");
    // seen again on the next polls: still the one alert
    await pollDating(); await pollDating();
    expect(await alertsOf(dating)).toHaveLength(1);
  });

  it("closes when the Setter field is filled in GHL (read back even for a booker the tagged poll does not see); the name goes on the booking", async () => {
    const a1 = (await apptOf(dating, "A1"))!;
    crm.set("C1", person("C1", "Ann", { fSetter: "Jess Setter" }));
    reads.length = 0;
    await pollDating();   // read back at most every few minutes
    expect(reads.includes("C1")).toBe(false);
    expect((await alertsOf(dating))[0].resolved_at).toBeNull();
    await asOperator((c) => c.query("update alerts set detail = detail || '{\"checked_at\":\"2000-01-01T00:00:00Z\"}' where company_id=$1 and key like $2", [dating, `${SETTER_ALERT}%`]));
    await pollDating();
    expect(reads.filter((x) => x === "C1")).toHaveLength(1);
    expect((await alertsOf(dating))[0].resolved_at).not.toBeNull();
    expect((await apptOf(dating, "A1"))!.set_by).toBe("Jess Setter");
    expect(a1.id).toBeTruthy();
  });

  it("a Setter field already filled before the booking is not taken for this one: the alert says so and stays open until it changes", async () => {
    crm.set("C4", person("C4", "Dee", { fSetter: "Old Setter" }));
    appts = [booking("A4", "SET", "C4", START.plus({ hours: 2 }))];
    await pollDating();
    const a4 = (await apptOf(dating, "A4"))!;
    const open = (await alertsOf(dating)).find((x) => x.key === `${SETTER_ALERT}${a4.id}`)!;
    expect(open.text).toContain(`Their Setter field already says "Old Setter" from before this booking: if Old Setter set this one too, resolve this alert.`);
    expect(open.detail.setter_field_before).toBe("Old Setter");
    await asOperator((c) => c.query("update alerts set detail = detail || '{\"checked_at\":\"2000-01-01T00:00:00Z\"}' where company_id=$1 and key=$2", [dating, open.key]));
    await pollDating();
    expect((await alertsOf(dating)).find((x) => x.key === open.key)!.resolved_at).toBeNull();
    crm.set("C4", person("C4", "Dee", { fSetter: "New Setter" }));
    await asOperator((c) => c.query("update alerts set detail = detail || '{\"checked_at\":\"2000-01-01T00:00:00Z\"}' where company_id=$1 and key=$2", [dating, open.key]));
    await pollDating();
    expect((await alertsOf(dating)).find((x) => x.key === open.key)!.resolved_at).not.toBeNull();
    expect((await apptOf(dating, "A4"))!.set_by).toBe("New Setter");
  });

  it("a connected dial the booking came during (D87) names the setter: no alert, the caller on the booking", async () => {
    crm.set("C5", person("C5", "Eve"));
    appts = [booking("A5", "SET", "C5", START.plus({ hours: 4 }))];
    // the person exists and a team member's connected call to them is under way when the booking lands
    await asOperator(async (c) => {
      const ct = (await one<{ id: string }>(c, "insert into contacts (company_id, ghl_contact_id, first_name, last_name, timezone) values ($1,'C5','Eve','Doe','UTC') returning id", [dating]))!;
      await c.query("insert into users (company_id, email, name, role, ghl_user_id) values ($1,'sam@x.com','Sam Dialer','setter','uSam')", [dating]);
      await c.query(`insert into recordings (company_id, contact_id, provider, external_id, started_at, ended_at, raw) values ($1,$2,'ghl','call-5',now() - interval '10 minutes', now() - interval '2 minutes',
        '{"kind":"phone","direction":"outbound","call_status":"connected","duration_sec":480,"caller_ghl_user_id":"uSam"}')`, [dating, ct.id]);
    });
    await pollDating();
    const a5 = (await apptOf(dating, "A5"))!;
    expect(a5).toMatchObject({ self_booked: false, set_by: "Sam Dialer" });
    expect((await alertsOf(dating)).some((x) => x.key === `${SETTER_ALERT}${a5.id}`)).toBe(false);
  });

  it("Calendly (Hair's and PMU's setter calendars): only a truly missing answer alerts; an answer, or a self-booked calendar, does not", async () => {
    events = [invitee("h1", "HAIR_S", "Luis"), invitee("p1", "PMU_S", "Carly"), invitee("d1", "DIRECT"), invitee("h2", "HAIR_S"), invitee("p2", "PMU_S")];
    await pollCompany(calendly, cal);
    expect((await apptOf(cal, "h1"))!).toMatchObject({ self_booked: false, set_by: "Luis" });
    expect((await apptOf(cal, "p1"))!).toMatchObject({ self_booked: false, set_by: "Carly" });
    const al = await alertsOf(cal), h2 = (await apptOf(cal, "h2"))!.id, p2 = (await apptOf(cal, "p2"))!.id;
    expect(al.map((x) => x.detail.appointment_id).sort()).toEqual([h2, p2].sort());
    // no Setter field bound: a person says who and resolves it
    expect(al.find((x) => x.detail.appointment_id === h2)!.text).toMatch(/^Setter-booked call with no setter: h2 Lee, .* on 45 Min Strategy Call - S\. Say who set it, then resolve this alert\.$/);
  });

  it("Calendly's setter answer is missing only when blank: whitespace is no answer, any words are", () => {
    const e = { uri: "https://api.calendly.com/scheduled_events/E", name: "S", status: "active", start_time: iso(START), end_time: iso(START), event_type: "https://api.calendly.com/event_types/ET", created_at: iso(NOW), updated_at: iso(NOW), event_memberships: [], invitees_counter: { total: 1, active: 1 } } as RawEvent;
    const inv = (answer?: string) => ({ uri: "https://api.calendly.com/scheduled_events/E/invitees/I", email: "a@x.com", name: "A B", status: "active", rescheduled: false, updated_at: iso(NOW), questions_and_answers: answer === undefined ? [] : [{ question: "Who set this call?", answer }] }) as RawInvitee;
    const q = { questions: { setter: "Who set this call" } };
    expect(mapEvent(e, inv(), undefined, undefined, q).setBy).toBeUndefined();
    expect(mapEvent(e, inv("   "), undefined, undefined, q).setBy).toBeUndefined();
    expect(mapEvent(e, inv(" Luis "), undefined, undefined, q).setBy).toBe("Luis");
    expect(mapEvent(e, inv("not sure"), undefined, undefined, q).setBy).toBe("not sure");
  });
});
