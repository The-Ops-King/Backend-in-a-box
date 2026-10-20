/** D203: a contact's zone: their booking's, GHL's, their phone's area code, in that trust; unknown, the offer's, and a time shown names its zone. */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { asOperator, one } from "@/db/client";
import { migrate } from "@/db/migrate";
import { buildContext, loadCompany, type RunRow } from "./context";
import { render } from "./template";
import { phoneZone, setContactZone, withZoneName } from "./timezone";

describe("D203: zones from phone numbers and zone names on times", () => {
  it("a US or Canada area code gives its zone; toll-free, other countries and unknown areas give none", () => {
    expect(phoneZone("+16025551234")).toBe("America/Phoenix");
    expect(phoneZone("(212) 555-1234")).toBe("America/New_York");
    expect(phoneZone("+1 415 555 1234")).toBe("America/Los_Angeles");
    expect(phoneZone("+19155551234")).toBe("America/Denver");          // El Paso
    expect(phoneZone("+18505551234")).toBe("America/Chicago");         // the Florida panhandle, mostly Central
    expect(phoneZone("+14165551234")).toBe("America/Toronto");
    expect(phoneZone("+18005551234")).toBeNull();
    expect(phoneZone("+442071234567")).toBeNull();
    expect(phoneZone(null)).toBeNull();
  });
  it("a time in a zone not known to be the contact's carries the zone's name; one that already names it is left alone", () => {
    expect(withZoneName("h:mm a")).toBe("h:mm a ZZZZ");
    expect(withZoneName("h:mm a ZZZZ")).toBe("h:mm a ZZZZ");
    expect(withZoneName("cccc 'at Zoe's' h:mm a")).toBe("cccc 'at Zoe's' h:mm a ZZZZ");
    const at = { appointment: { starts_at: "2026-10-20T22:00:00.000Z" } };
    expect(render(`{{appointment.starts_at | date:"h:mm a"}}`, at, { tz: "America/Phoenix", tzKnown: true })).toBe("3:00 PM");
    expect(render(`{{appointment.starts_at | date:"h:mm a"}}`, at, { tz: "America/Los_Angeles", tzKnown: false })).toBe("3:00 PM PDT");
  });
});

const SLUG = "d203-zones";
let co = "";
const contact = (zone: string | null, source: string | null, phone?: string) => asOperator(async (c) => {
  const id = (await one<{ id: string }>(c, "insert into contacts (company_id, ghl_contact_id, first_name, timezone, timezone_source) values ($1,$2,'Zed',$3,$4) returning id", [co, `GZ${Math.random()}`, zone, source]))!.id;
  if (phone) await c.query("insert into contact_identifiers (company_id, contact_id, kind, value) values ($1,$2,'phone',$3)", [co, id, phone]);
  return id;
});
const zoneOf = (id: string) => asOperator((c) => one<{ timezone: string; timezone_source: string }>(c, "select timezone, timezone_source from contacts where id=$1", [id]));
const ctxOf = (id: string) => asOperator(async (c) => {
  const { row, bindings } = await loadCompany(c, co);
  const run = { id: "00000000-0000-0000-0000-000000000000", company_id: co, workflow_id: "00000000-0000-0000-0000-000000000000", workflow_version: 1, contact_id: id, opportunity_id: null, appointment_id: null, status: "active", current_node: null, next_run_at: null, context: {} } as unknown as RunRow;
  return (await buildContext(c, run, row, bindings)).contact as { timezone: string; timezone_known: boolean };
});

describe.skipIf(!process.env.DATABASE_URL)("D203: whose zone wins, and the run's", () => {
  const wipe = () => asOperator(async (c) => {
    const old = await one<{ id: string }>(c, "select id from companies where slug=$1", [SLUG]); if (!old) return;
    for (const t of ["contact_identifiers", "contacts"]) await c.query(`delete from ${t} where company_id=$1`, [old.id]);
    await c.query("delete from companies where id=$1", [old.id]);
  });
  beforeAll(async () => { await migrate(); await wipe(); co = (await asOperator((c) => one<{ id: string }>(c, "insert into companies (name, slug, timezone) values ('Zones', $1, 'America/Los_Angeles') returning id", [SLUG])))!.id; });
  afterAll(wipe);

  it("a booking beats GHL, GHL beats a phone's guess, and nothing below overwrites what is above", async () => {
    const id = await contact("America/Los_Angeles", "company_default");
    expect(await asOperator((c) => setContactZone(c, id, "America/Chicago", "phone"))).toBe(true);
    expect(await asOperator((c) => setContactZone(c, id, "America/Denver", "ghl"))).toBe(true);
    expect(await asOperator((c) => setContactZone(c, id, "America/New_York", "phone"))).toBe(false);
    expect(await asOperator((c) => setContactZone(c, id, "America/Phoenix", "booking"))).toBe(true);
    expect(await asOperator((c) => setContactZone(c, id, "America/Denver", "ghl"))).toBe(false);
    expect(await zoneOf(id)).toEqual({ timezone: "America/Phoenix", timezone_source: "booking" });
    expect(await asOperator((c) => setContactZone(c, id, "America/New_York", "booking"))).toBe(true);   // a newer booking: their latest choice
  });

  it("a run uses the contact's phone zone when nothing better is known and keeps it; with no clue it is the offer's, marked unknown", async () => {
    const az = await contact("America/Los_Angeles", "company_default", "+16025550142");
    expect(await ctxOf(az)).toMatchObject({ timezone: "America/Phoenix", timezone_known: true });
    expect(await zoneOf(az)).toEqual({ timezone: "America/Phoenix", timezone_source: "phone" });
    const booked = await contact("America/New_York", "booking", "+16025550143");
    expect(await ctxOf(booked)).toMatchObject({ timezone: "America/New_York", timezone_known: true });   // their booking, not their phone
    const nobody = await contact("America/Los_Angeles", "company_default", "+442071234567");
    expect(await ctxOf(nobody)).toMatchObject({ timezone: "America/Los_Angeles", timezone_known: false });
  });
});
