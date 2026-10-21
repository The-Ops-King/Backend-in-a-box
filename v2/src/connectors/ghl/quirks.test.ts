import { describe, expect, it } from "vitest";
import { connectorKit } from "../testkit/kit";
import { ghlPortsFor } from "./index";
import { canonicalApptStatus, apptStatus } from "./shapes";

/** Every GHL quirk v1 found against the real API is met once, inside the adapter. Each one here. */

const ctx = (offerId: string, key = "k") => ({ offerId, idempotencyKey: key });

async function bench() {
  const k = await connectorKit();
  const conn = await k.connectGhl();
  return { k, conn, ports: await ghlPortsFor(k.hub, conn) };
}

describe("GHL quirks, fixed in the adapter", () => {
  it("a contact PUT never carries tags (GHL would replace every tag the contact has)", async () => {
    const b = await bench();
    const k = b.k;
    await k.state.setFieldMap([{ offerId: k.offerId, provider: "ghl", object: "contact", canonicalField: "lead_source", providerFieldId: "CF-SRC", valueType: "text", options: {} }]);
    const ports = await ghlPortsFor(k.hub, b.conn);
    const c = k.ghl.seedContact({ locationId: "LOC1", tags: ["vip", "lead"] });
    await expect(ports.crm.updateContact(ctx(k.offerId), c.id, { set: { tags: "x" } })).rejects.toMatchObject({ failure: "permanent" });
    expect(k.http.to("PUT", `/contacts/${c.id}`)).toHaveLength(0);
    await ports.crm.updateContact(ctx(k.offerId), c.id, { set: { lead_source: "fb", first_name: "Ana" } });
    const put = k.http.to("PUT", `/contacts/${c.id}`)[0]!;
    expect(put.body).toEqual({ firstName: "Ana", customFields: [{ id: "CF-SRC", field_value: "fb" }] });
    expect(put.body).not.toHaveProperty("tags");
    expect(k.ghl.contacts.get(c.id)!.tags).toEqual(["vip", "lead"]);
    await ports.crm.addTags(ctx(k.offerId), c.id, ["booked"]);
    expect(k.ghl.contacts.get(c.id)!.tags).toEqual(["vip", "lead", "booked"]);
  });

  it("an appointment status change reads the appointment first and sends every field back (a PUT without the status resets it)", async () => {
    const { k, ports } = await bench();
    const a = k.ghl.seedAppointment({ locationId: "LOC1", contactId: "c1", calendarId: "CAL1", appointmentStatus: "noshow", title: "Call", assignedUserId: "U1" });
    await ports.scheduling.setStatus(ctx(k.offerId), { appointmentId: a.id, status: "showed" });
    const put = k.http.to("PUT", `/calendars/events/appointments/${a.id}`)[0]!;
    expect(k.http.to("GET", `/calendars/events/appointments/${a.id}`)).toHaveLength(1);
    expect(put.body).toMatchObject({ appointmentStatus: "showed", calendarId: "CAL1", startTime: a.startTime, endTime: a.endTime, title: "Call", assignedUserId: "U1" });
    expect(k.ghl.appts.get(a.id)!.appointmentStatus).toBe("showed");
    await ports.scheduling.cancel(ctx(k.offerId, "k2"), { appointmentId: a.id });
    expect(k.ghl.appts.get(a.id)!.appointmentStatus).toBe("cancelled");
    // the platform's words become GHL's: booked is confirmed, and GHL's no_show spelling is never sent
    await ports.scheduling.setStatus(ctx(k.offerId, "k3"), { appointmentId: a.id, status: "noshow" });
    expect(k.ghl.appts.get(a.id)!.appointmentStatus).toBe("noshow");
  });

  it("reads the status under its right spelling, and the misspelt appoinmentStatus when that is all there is", () => {
    expect(apptStatus({ id: "a", appointmentStatus: "showed", appoinmentStatus: "showed" })).toBe("showed");
    expect(apptStatus({ id: "a", appoinmentStatus: "noshow" })).toBe("noshow");
    expect(canonicalApptStatus("confirmed")).toBe("booked");
    expect(canonicalApptStatus("new")).toBe("booked");
    expect(canonicalApptStatus("completed")).toBe("showed");
  });

  it("a DATE custom field takes the day (GHL drops the time silently), in the field's zone", async () => {
    const b = await bench();
    const k = b.k;
    await k.state.setFieldMap([
      { offerId: k.offerId, provider: "ghl", object: "contact", canonicalField: "call_date", providerFieldId: "CF-DATE", valueType: "date", options: { zone: "America/Los_Angeles" } },
      { offerId: k.offerId, provider: "ghl", object: "contact", canonicalField: "first_call_day", providerFieldId: "CF-DATE2", valueType: "date", options: {} },
    ]);
    const ports = await ghlPortsFor(k.hub, b.conn);
    k.ghl.dateFields.add("CF-DATE");
    const c = k.ghl.seedContact({ locationId: "LOC1" });
    await ports.crm.updateContact(ctx(k.offerId), c.id, { set: { call_date: "2026-10-16T03:30:00Z", first_call_day: "2026-10-16T03:30:00Z" } });
    expect((k.http.to("PUT", `/contacts/${c.id}`)[0]!.body as { customFields: unknown[] }).customFields).toEqual([{ id: "CF-DATE", field_value: "2026-10-15" }, { id: "CF-DATE2", field_value: "2026-10-16" }]);
  });

  it("the contact search lags writes by ~10 s: a contact just made is found from memory, never made twice", async () => {
    const { k, ports } = await bench();
    const p = { match: ["email", "phone"], create: true, fillBlank: { email: "lag@example.com", phone: "+15550109999", first_name: "Lag" } };
    const first = await ports.crm.findOrCreateContact(ctx(k.offerId, "a"), null, p);
    k.http.advance(3_000);
    const second = await ports.crm.findOrCreateContact(ctx(k.offerId, "b"), null, p);
    expect(first.action).toBe("created");
    expect(second).toEqual({ id: first.id, action: "found" });
    expect(k.ghl.contacts.size).toBe(1);
    // and it is read by id, which is right at once, not searched
    expect(k.http.to("GET", `/contacts/${first.id}`).length).toBeGreaterThan(0);
  });

  it("found contacts get only their blank fields filled; a field the CRM holds is left alone", async () => {
    const { k, ports } = await bench();
    const c = k.ghl.seedContact({ locationId: "LOC1", email: "ana@example.com", firstName: "Ana" });
    await ports.crm.findOrCreateContact(ctx(k.offerId), null, { match: ["email"], create: true, fillBlank: { email: "ana@example.com", first_name: "Anna", last_name: "Lopez" } });
    expect(k.ghl.contacts.get(c.id)).toMatchObject({ firstName: "Ana", lastName: "Lopez" });
  });

  it("404 on a contact: a read says it is gone (null); a write fails for good, never tried again", async () => {
    const { k, ports } = await bench();
    expect(await ports.crm.getContact(ctx(k.offerId), "missing")).toBeNull();
    await expect(ports.crm.addTags(ctx(k.offerId), "missing", ["x"])).rejects.toMatchObject({ failure: "permanent", message: expect.stringMatching(/gone/) });
    expect(k.http.to("POST", "/contacts/missing/tags")).toHaveLength(1);
  });

  it("opportunities are searched with snake_case parameters (camelCase is a 422), and a card just made is not made again", async () => {
    const { k, ports } = await bench();
    const c = k.ghl.seedContact({ locationId: "LOC1" });
    const p = { pipeline: "PIPE", stage: "ST1", ifMissing: "create", pick: "open", name: "Ana" };
    const a = await ports.crm.moveDeal(ctx(k.offerId, "a"), c.id, p);
    const search = k.http.to("GET", "/opportunities/search")[0]!;
    expect([...search.query.keys()].sort()).toEqual(["contact_id", "limit", "location_id", "pipeline_id"]);
    const b = await ports.crm.moveDeal(ctx(k.offerId, "b"), c.id, { ...p, stage: "ST2" });
    expect(b).toEqual(a);
    expect(k.ghl.opps.size).toBe(1);
    expect(k.ghl.opps.get(a!.id)!.pipelineStageId).toBe("ST2");
    // fromStages: a card elsewhere is left where it is
    await ports.crm.moveDeal(ctx(k.offerId, "c"), c.id, { ...p, stage: "ST3", fromStages: ["ST1"] });
    expect(k.ghl.opps.get(a!.id)!.pipelineStageId).toBe("ST2");
  });

  it("custom object records: properties by their short key, numbers for money, null to clear, located updates; relating twice is done", async () => {
    const b = await bench();
    const k = b.k;
    await k.state.setFieldMap([{ offerId: k.offerId, provider: "ghl", object: "custom_objects.sales_call", canonicalField: "cash_collected", providerFieldId: "cash_collected", valueType: "money", options: {} }]);
    const ports = await ghlPortsFor(k.hub, b.conn);
    const made = await ports.crm.upsertRecord(ctx(k.offerId), { object: "custom_objects.sales_call", key: "cal-1", properties: { cash_collected: "$1,500", outcome: "showed" }, ifMissing: "create" });
    const rec = k.ghl.records.get(made.id)!;
    expect(rec.properties).toEqual({ cash_collected: 1500, outcome: "showed", external_id: "cal-1" });
    const again = await ports.crm.upsertRecord(ctx(k.offerId, "k2"), { object: "custom_objects.sales_call", key: "cal-1", properties: { outcome: "noshow" }, clear: ["cash_collected"], ifMissing: "create" });
    expect(again.id).toBe(made.id);
    expect(k.http.to("PUT", `/objects/custom_objects.sales_call/records/${made.id}`)[0]!.query.get("locationId")).toBe("LOC1");
    expect(k.ghl.records.get(made.id)!.properties).toEqual({ outcome: "noshow", external_id: "cal-1" });
    await ports.crm.relateRecords(ctx(k.offerId), { association: "AS1", first: made.id, second: "c1" });
    await ports.crm.relateRecords(ctx(k.offerId, "k3"), { association: "AS1", first: made.id, second: "c1" });
    expect(k.ghl.relations.size).toBe(1);
    await expect(ports.crm.upsertRecord(ctx(k.offerId), { object: "sales_call", properties: {}, key: "x", ifMissing: "create" })).rejects.toMatchObject({ failure: "permanent" });
  });

  it("a canonical field the field map does not have is refused, never guessed", async () => {
    const { k, ports } = await bench();
    const c = k.ghl.seedContact({ locationId: "LOC1" });
    await expect(ports.crm.updateContact(ctx(k.offerId), c.id, { set: { setter: "Mia" } })).rejects.toMatchObject({ failure: "permanent", message: expect.stringMatching(/field map has no contact field for "setter"/) });
    expect(k.http.to("PUT", `/contacts/${c.id}`)).toHaveLength(0);
  });
});
