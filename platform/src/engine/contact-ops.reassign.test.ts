/** D204: one offer's contacts handed to another team member (checked live first), and a calendar's owner moved with its upcoming bookings. */
import { describe, it, expect, beforeAll } from "vitest";
import { asOperator, one } from "@/db/client";
import { migrate } from "@/db/migrate";
import { installCompany } from "./install";
import { calendarOwner, calendarWatch, callCloser, callsByTime, contactsReassign } from "./contact-ops";
import { fakeAdapters } from "./test-install";
import type { Adapters, ContactSnapshot } from "@/adapters/types";

process.env.BINDINGS_KEY ??= Buffer.alloc(32, 7).toString("base64");
const SLUG = `d204-${Date.now()}`;
let co = "";
const crm = new Map<string, ContactSnapshot>();
const snap = (id: string, assignedTo: string, tags: string[]): ContactSnapshot => ({ id, firstName: id, assignedTo, tags, customFields: {}, dateUpdated: "2026-10-20T00:00:00Z", dateAdded: "2026-10-01T00:00:00Z" });
const writes: [string, string | undefined][] = [];
const base = fakeAdapters();
const fake: Adapters = { ...base, read: { ...base.read, getContact: async (_c, id) => crm.get(id) ?? null, listUsers: async () => [{ id: "GM", name: "Mitch Sapoff", email: "mitch@x.com" }, { id: "GN", name: "Nonie Wallace", email: "nonie@x.com" }] },
  write: { ...base.write, updateContact: async (_c, id, p) => { writes.push([id, p.assignedUserId]); } } };

describe.skipIf(!process.env.DATABASE_URL)("D204: reassign and calendar owner", () => {
  beforeAll(async () => {
    await migrate();
    co = (await installCompany({ name: "Reassign", slug: SLUG, timezone: "America/Phoenix", locationId: "LOC-D204", pit: "pit-fake", calendars: {}, templates: [] }, fake)).companyId;
    await asOperator(async (c) => {
      for (const [id, owner, tags] of [["A", "GM", ["dating"]], ["B", "GM", ["dating"]], ["C", "GM", ["other"]], ["D", "GN", ["dating"]], ["E", "GM", ["dating"]], ["F", "GM", ["dating"]]] as const)
        await c.query("insert into contacts (company_id, ghl_contact_id, first_name, tags, assigned_ghl_user_id, timezone, timezone_source) values ($1,$2,$2,$3,$4,'America/Phoenix','company_default')", [co, id, tags, owner]);
      const term = await one<{ id: string }>(c, "select id from company_terms where company_id=$1 and domain='appointment_type' limit 1", [co]);
      const mitch = await one<{ id: string }>(c, "select id from users where company_id=$1 and email='mitch@x.com'", [co]);
      const cal = await one<{ id: string }>(c, "insert into calendars (company_id, source, external_id, name, appointment_term, config) values ($1,'ghl','CAL-T','Strategy Session',$2,$3) returning id", [co, term!.id, JSON.stringify({ owner: mitch!.id })]);
      const ct = await one<{ id: string }>(c, "select id from contacts where company_id=$1 and ghl_contact_id='A'", [co]);
      for (const [ext, at] of [["P1", "-1 day"], ["U1", "1 day"], ["U2", "2 days"]] as const)
        await c.query(`insert into appointments (company_id, contact_id, external_id, calendar_id, appointment_term, assigned_user_id, starts_at, ends_at, booked_at, status, source) values ($1,$2,$3,$4,$5,$6, now() + $7::interval, now() + $7::interval + interval '15 minutes', now() - interval '3 days', 'confirmed', 'ghl')`, [co, ct!.id, ext, cal!.id, term!.id, mitch!.id, at]);
    });
    crm.set("A", snap("A", "GM", ["dating"])); crm.set("B", snap("B", "GM", ["dating"])); crm.set("E", snap("E", "GN", ["dating"])); crm.set("F", snap("F", "GM", []));
  });

  it("dry run lists Mitch's dating contacts only; the real run checks each live and moves only what still matches", async () => {
    const args = { company: SLUG, from: "mitch@x.com", to: "nonie@x.com", tag: "dating", why: "test" };
    const dry = await asOperator((c) => contactsReassign(c, fake, args));
    expect(dry).toMatchObject({ ok: true, dryRun: true, from: "Mitch Sapoff", to: "Nonie Wallace", count: 4, contacts: ["A", "B", "E", "F"] });
    expect(writes).toEqual([]);
    const real = await asOperator((c) => contactsReassign(c, fake, { ...args, dryRun: false }));
    expect(real).toMatchObject({ ok: true, moved: 2, contacts: ["A", "B"], skipped: [{ who: "E", why: "already Nonie Wallace's" }, { who: "F", why: "no longer tagged dating" }] });
    expect(writes).toEqual([["A", "GN"], ["B", "GN"]]);
    expect(await asOperator((c) => contactsReassign(c, fake, args))).toMatchObject({ count: 2, contacts: ["E", "F"] });   // re-run: only what is left
    expect(await asOperator((c) => contactsReassign(c, fake, { ...args, to: "nobody@x.com" }))).toMatchObject({ ok: false, status: 404 });
  });

  it("everyone's but Nelly's (no owner included): Nelly's and the new owner's own are left; each still checked live", async () => {
    await asOperator(async (c) => {
      for (const [id, owner] of [["G", null], ["H", "GL"], ["I", "GM"]] as const)
        await c.query("insert into contacts (company_id, ghl_contact_id, first_name, tags, assigned_ghl_user_id, timezone, timezone_source) values ($1,$2,$2,'{dating}',$3,'America/Phoenix','company_default')", [co, id, owner]);
      await c.query("insert into users (company_id, email, name, role, ghl_user_id) values ($1,'nelly@x.com','Nelly S.','closer','GL') on conflict do nothing", [co]);
    });
    crm.set("G", snap("G", "", ["dating"])); crm.set("I", snap("I", "GM", ["dating"]));
    const args = { company: SLUG, except: ["nelly@x.com"], to: "nonie@x.com", tag: "dating", why: "test" };
    const dry = await asOperator((c) => contactsReassign(c, fake, args));
    expect(dry).toMatchObject({ ok: true, dryRun: true, from: "anyone but Nelly S. and Nonie Wallace", contacts: ["E", "F", "G", "I"], byOwner: { "Mitch Sapoff": 3, "no owner": 1 } });
    expect(dry.ok && dry.byOwner["Nonie Wallace"]).toBeFalsy();
    writes.length = 0;
    const real = await asOperator((c) => contactsReassign(c, fake, { ...args, dryRun: false }));
    expect(real).toMatchObject({ moved: 2, contacts: ["G", "I"], skipped: [{ who: "E", why: "already Nonie Wallace's" }, { who: "F", why: "no longer tagged dating" }] });
    expect(await asOperator((c) => contactsReassign(c, fake, { ...args, from: "mitch@x.com" }))).toMatchObject({ ok: false, status: 400 });
  });

  it("calledTo: who has had a call (a past booking not cancelled, or a connected call in GHL) goes to Mitch; the rest to Nonie; a ring-out or 0-second call is no call", async () => {
    const calls: Record<string, { status: string; dur?: number }[]> = { K: [{ status: "completed", dur: 95 }], L: [{ status: "no-answer" }, { status: "completed", dur: 0 }], M: [] };
    const withCalls: Adapters = { ...fake, read: { ...fake.read, contactCalls: async (_c, id) => (calls[id] ?? []).map((x, i) => ({ id: `${id}${i}`, conversationId: `c${id}`, contactId: id, channel: "call" as const, direction: "outbound" as const, dateAdded: "2026-10-01T00:00:00Z", call: { status: x.status, durationSec: x.dur } })) } };
    await asOperator(async (c) => {
      for (const [id, owner] of [["J", null], ["K", null], ["L", "GM"], ["M", "GM"]] as const)
        await c.query("insert into contacts (company_id, ghl_contact_id, first_name, tags, assigned_ghl_user_id, timezone, timezone_source) values ($1,$2,$2,'{dating,called-test}',$3,'America/Phoenix','company_default')", [co, id, owner]);
      // J: a past booking that happened; also a cancelled one on M, which is no call
      const cal = await one<{ id: string; appointment_term: string }>(c, "select id, appointment_term from calendars where company_id=$1 limit 1", [co]);
      for (const [ct, ext, status] of [["J", "PJ", "confirmed"], ["M", "PM", "cancelled"]] as const)
        await c.query(`insert into appointments (company_id, contact_id, external_id, calendar_id, appointment_term, starts_at, ends_at, booked_at, status, source) select $1, id, $3, $4, $5, now() - interval '2 days', now() - interval '2 days' + interval '15 minutes', now() - interval '5 days', $6, 'ghl' from contacts where company_id=$1 and ghl_contact_id=$2`, [co, ct, ext, cal!.id, cal!.appointment_term, status]);
    });
    for (const id of ["J", "K", "L", "M"]) crm.set(id, snap(id, id === "L" || id === "M" ? "GM" : "", ["dating", "called-test"]));
    const args = { company: SLUG, except: ["nelly@x.com"], to: "nonie@x.com", calledTo: "mitch@x.com", tag: "called-test", why: "test" };
    const dry = await asOperator((c) => contactsReassign(c, withCalls, args));
    expect(dry).toMatchObject({ ok: true, dryRun: true, contacts: ["L", "M"], called: { to: "Mitch Sapoff", contacts: ["J", "K"] } });
    writes.length = 0;
    expect(await asOperator((c) => contactsReassign(c, withCalls, { ...args, dryRun: false }))).toMatchObject({ moved: 4, contacts: ["L", "M"], called: { count: 2, contacts: ["J", "K"] } });
    expect(writes.sort()).toEqual([["J", "GM"], ["K", "GM"], ["L", "GN"], ["M", "GN"]]);
  });

  it("the calendar's owner moves with its upcoming bookings; a past one stays", async () => {
    const args = { company: SLUG, calendar: "Strategy Session", owner: "nonie@x.com", why: "test" };
    expect(await asOperator((c) => calendarOwner(c, args))).toEqual({ ok: true, dryRun: true, calendar: "Strategy Session", was: "Mitch Sapoff", owner: "Nonie Wallace", upcoming: 2 });
    expect(await asOperator((c) => calendarOwner(c, { ...args, dryRun: false }))).toMatchObject({ ok: true, dryRun: false, upcoming: 2 });
    const rows = await asOperator((c) => c.query("select a.external_id, u.name from appointments a join users u on u.id=a.assigned_user_id where a.company_id=$1 order by a.external_id", [co]));
    expect(rows.rows.map((r) => [r.external_id, r.name])).toEqual([["P1", "Mitch Sapoff"], ["U1", "Nonie Wallace"], ["U2", "Nonie Wallace"]]);
    expect(await asOperator((c) => calendarOwner(c, args))).toMatchObject({ was: "Nonie Wallace", upcoming: 0 });
  });
  it("D215: one more calendar watched as install maps it: a dry run first, the owner's upcoming bookings, nothing twice", async () => {
    const withCal: Adapters = { ...fake, booking: { ...fake.booking, ghl: { ...fake.booking.ghl, listCalendars: async () => [{ id: "CAL-JP", name: "JP Strategy", teamMemberIds: ["GN"], bookingUrl: "https://x/jp" }] } } } as Adapters;
    const args = { company: SLUG, calendar: "jp strategy", term: "closing", name: "Follow-up call", owner: "nonie@x.com", booking: "self" as const, why: "test" };
    expect(await asOperator((c) => calendarWatch(c, withCal, args))).toMatchObject({ ok: true, dryRun: true, calendar: "JP Strategy", id: "CAL-JP", was: "not watched" });
    expect(await asOperator((c) => one(c, "select 1 from calendars where company_id=$1 and external_id='CAL-JP'", [co]))).toBeFalsy();
    expect(await asOperator((c) => calendarWatch(c, withCal, { ...args, dryRun: false }))).toMatchObject({ ok: true, dryRun: false, was: "not watched", maps: '"JP Strategy" → Follow-up call (closing) (self-booked)' });
    const row = await asOperator((c) => one<{ active: boolean; self_booked: boolean; booking_url: string; owner: string; term: string; category: string }>(c, "select cal.active, cal.self_booked, cal.booking_url, u.email as owner, t.name as term, t.category from calendars cal join users u on u.id=(cal.config->>'owner')::uuid join company_terms t on t.id=cal.appointment_term where cal.company_id=$1 and cal.external_id='CAL-JP'", [co]));
    expect(row).toEqual({ active: true, self_booked: true, booking_url: "https://x/jp", owner: "nonie@x.com", term: "Follow-up call", category: "closing" });
    expect(await asOperator((c) => calendarWatch(c, withCal, { ...args, dryRun: false }))).toMatchObject({ dryRun: false, was: "watched", maps: "already watched: nothing changed" });
    expect(await asOperator((c) => calendarWatch(c, withCal, { ...args, calendar: "nope" }))).toMatchObject({ ok: false, status: 404 });
  });
  it("D218: a past call's closer, in the replica and on its Sales Call by the option key; a dry run changes nothing", async () => {
    const recs: [string, Record<string, unknown>][] = [];
    const w: Adapters = { ...fake, write: { ...fake.write, updateRecord: async (_c, _o, id, p) => { recs.push([id, p]); } } } as Adapters;
    const appt = await asOperator(async (c) => {
      await c.query("insert into bindings (company_id, key, kind, value) values ($1,'crm.object_sales_call','id',$2),($1,'sales_call.closer_options','text',$3) on conflict do nothing", [co, Buffer.from("custom_objects.sales_call"), Buffer.from(JSON.stringify({ "nonie@x.com": "nonie" }))]);
      const cal = await one<{ id: string; appointment_term: string }>(c, "select id, appointment_term from calendars where company_id=$1 and external_id='CAL-T'", [co]);
      const ct = await one<{ id: string }>(c, "select id from contacts where company_id=$1 and ghl_contact_id='B'", [co]);
      const id = (await one<{ id: string }>(c, "insert into appointments (company_id, contact_id, external_id, calendar_id, appointment_term, starts_at, ends_at, booked_at, status, source) values ($1,$2,'HOSTLESS',$3,$4, now() - interval '3 days', now() - interval '3 days' + interval '30 minutes', now() - interval '4 days','confirmed','ghl') returning id", [co, ct!.id, cal!.id, cal!.appointment_term]))!.id;
      await c.query("insert into crm_records (company_id, object_key, record_key, ghl_record_id, properties) values ($1,'custom_objects.sales_call','HOSTLESS','SC-1','{}')", [co]);
      return id;
    });
    const args = { company: SLUG, appointments: ["HOSTLESS"], closer: "nonie@x.com", why: "test" };
    expect(await asOperator((c) => callCloser(c, w, args))).toMatchObject({ ok: true, dryRun: true, closer: "Nonie Wallace", calls: [{ id: appt, was: null, sales_call: "SC-1", ghl_closer: "nonie" }] });
    expect(recs).toEqual([]);
    expect(await asOperator((c) => callCloser(c, w, { ...args, dryRun: false }))).toMatchObject({ ok: true, dryRun: false });
    expect(recs).toEqual([["SC-1", { closer: "nonie" }]]);
    expect(await asOperator((c) => one(c, "select u.email from appointments a join users u on u.id=a.assigned_user_id where a.id=$1", [appt]))).toEqual({ email: "nonie@x.com" });
    expect(await asOperator((c) => callCloser(c, w, { ...args, closer: "nobody@x.com" }))).toMatchObject({ ok: false, status: 404 });
  });
  it("D205: upcoming calls to Nonie, past ones to Mitch, in the replica and on their Discovery records (Setter and owner, checked read back); limit proves one first", async () => {
    const recWrites: [string, Record<string, unknown>, string | undefined, string[] | undefined][] = [];
    const owners = new Map<string, string[]>([["R-FUT1", ["GM"]], ["R-FUT2", ["GM"]], ["R-PAST", ["GM"]]]);
    const withRecords: Adapters = { ...fake,
      write: { ...fake.write, updateRecord: async (_c, _k, id, props, add, remove) => { recWrites.push([id, props, add, remove]); owners.set(id, [...(owners.get(id) ?? []).filter((o) => !(remove ?? []).includes(o)), ...(add ? [add] : [])]); } },
      read: { ...fake.read, objectRecord: async (_c, _k, id) => ({ id, createdAt: "", properties: {}, owners: owners.get(id) ?? [] }) } };
    await asOperator(async (c) => {
      const cal = await one<{ id: string; appointment_term: string }>(c, "select id, appointment_term from calendars where company_id=$1 and name='Strategy Session'", [co]);
      const nelly = await one<{ id: string }>(c, "select id from users where company_id=$1 and email='nelly@x.com'", [co]);
      for (const [ext, at, slot, rec] of [["F1", "3 days", "S-F1", "R-FUT1"], ["F2", "4 days", "S-F2", "R-FUT2"], ["P2", "-3 days", "S-P2", null], ["P3", "-4 days", "S-P3", "R-PAST"]] as const) {
        await c.query(`insert into appointments (company_id, contact_id, external_id, calendar_id, appointment_term, assigned_user_id, starts_at, ends_at, booked_at, status, source, slot_key)
          select $1, id, $2, $3, $4, $5, now() + $6::interval, now() + $6::interval + interval '15 minutes', now() - interval '9 days', 'confirmed', 'ghl', $7 from contacts where company_id=$1 and ghl_contact_id='A'`, [co, ext, cal!.id, cal!.appointment_term, ext === "P2" ? nelly!.id : null, at, slot]);
        if (rec) await c.query("insert into crm_records (company_id, object_key, record_key, ghl_record_id, properties) values ($1,'custom_objects.discovery_call',$2,$3,$4)", [co, slot, rec, { setter: "Mitch Sapoff" }]);
      }
    });
    const args = { company: SLUG, calendar: "Strategy Session", future: "nonie@x.com", past: "mitch@x.com", why: "test" };
    const dry = await asOperator((c) => callsByTime(c, withRecords, args));
    expect(dry.ok && dry.records.map((r) => [r.who, r.to])).toEqual([["A", "Nonie Wallace"], ["A", "Nonie Wallace"]]);   // the past record already says Mitch
    expect(dry.ok && dry.bookings.map((b) => [b.from, b.to])).toEqual(expect.arrayContaining([["Nelly S.", "Mitch Sapoff"], ["nobody", "Nonie Wallace"]]));
    expect(recWrites).toEqual([]);
    const one1 = await asOperator((c) => callsByTime(c, withRecords, { ...args, dryRun: false, limit: 1 }));
    expect(one1).toMatchObject({ ok: true, records: [{ to: "Nonie Wallace", checked: "owner swapped" }], failed: [] });
    expect(recWrites).toEqual([["R-FUT1", { setter: "Nonie Wallace" }, "GN", ["GM"]]]);
    expect(await asOperator((c) => callsByTime(c, withRecords, { ...args, dryRun: false }))).toMatchObject({ records: [{ checked: "owner swapped" }], bookings: [] });
    expect(await asOperator((c) => callsByTime(c, withRecords, args))).toMatchObject({ bookings: [], records: [] });
    const rows = await asOperator((c) => c.query("select a.external_id, u.name from appointments a left join users u on u.id=a.assigned_user_id where a.company_id=$1 and a.external_id in ('F1','F2','P2','P3') order by 1", [co]));
    expect(rows.rows.map((r) => [r.external_id, r.name])).toEqual([["F1", "Nonie Wallace"], ["F2", "Nonie Wallace"], ["P2", "Mitch Sapoff"], ["P3", "Mitch Sapoff"]]);
  });

});
