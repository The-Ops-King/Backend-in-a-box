import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { provision, type Http, type Setup } from "./provision";

const setup = JSON.parse(readFileSync(path.resolve(__dirname, "../../../installs/dating/ghl-setup.json"), "utf8")) as Setup;
const LOC = "loc1";

/** An in-memory GHL location answering the calls provision makes; `calls` keeps every request in order. */
function fakeGhl(seed: (g: ReturnType<typeof empty>) => void = () => {}) {
  const g = empty(); seed(g);
  let n = 0; const id = () => `id${++n}`;
  const calls: { method: string; path: string; body?: any }[] = [];   // eslint-disable-line @typescript-eslint/no-explicit-any
  const http: Http = async (method, p, opts) => {
    const body = opts?.body as any; calls.push({ method, path: p, body });   // eslint-disable-line @typescript-eslint/no-explicit-any
    const [route] = p.split("?");
    if (method === "GET") {
      if (route === `/locations/${LOC}`) return { location: { name: "Fake", timezone: g.timezone } };
      if (route === "/opportunities/pipelines") return { pipelines: g.pipelines };
      if (route === `/locations/${LOC}/customFields`) return { customFields: g.fields.filter((f) => p.endsWith(`model=${f.model}`)) };
      if (route === "/objects/") return { objects: g.objects };
      if (route === "/associations/") return { associations: g.associations };
      if (route === "/calendars/") return { calendars: g.calendars };
      if (route === "/users/") return { users: g.users };
      const ok = /^\/custom-fields\/object-key\/(.+)$/.exec(route);
      if (ok) return { fields: g.objFields.filter((f) => f.objectKey === ok[1]), folders: g.objects.some((o) => o.key === ok[1]) ? [{ id: `folder:${ok[1]}` }] : [] };
    }
    if (method === "POST" && route === "/opportunities/pipelines") { const p2 = { id: id(), name: body.name, stages: body.stages.map((s: { name: string; position: number }) => ({ id: id(), ...s })) }; g.pipelines.push(p2); return p2; }
    if (method === "POST" && route === `/locations/${LOC}/customFields`) { const f = { id: id(), name: body.name, dataType: body.dataType, model: body.model }; g.fields.push(f); return { customField: f }; }
    if (method === "POST" && route === "/objects/") {
      g.objects.push({ id: id(), key: body.key, labels: body.labels });
      g.objFields.push({ id: id(), name: body.primaryDisplayPropertyDetails.name, fieldKey: body.primaryDisplayPropertyDetails.key, dataType: "TEXT", objectKey: body.key, parentId: `folder:${body.key}` });
      return { object: g.objects.at(-1) };
    }
    if (method === "POST" && route === "/custom-fields/") { const f = { id: id(), name: body.name, fieldKey: body.fieldKey, dataType: body.dataType, objectKey: body.objectKey, parentId: body.parentId, options: body.options }; g.objFields.push(f); return { field: f }; }
    if (method === "POST" && route === "/associations/") { const a = { id: id(), ...body }; g.associations.push(a); return a; }
    if (method === "POST" && route === "/calendars/") { const c = { id: id(), ...body }; g.calendars.push(c); return { calendar: c }; }
    const pp = /^\/opportunities\/pipelines\/(.+)$/.exec(route);
    if (method === "PUT" && pp) { const pl = g.pipelines.find((x) => x.id === pp[1])!; pl.stages = body.stages.map((s: { id?: string }) => ({ ...s, id: s.id ?? id() })); return {}; }
    const cf = /^\/custom-fields\/(.+)$/.exec(route);
    if (method === "PUT" && cf) { const f = g.objFields.find((x) => x.id === cf[1])!; f.options = body.options; return {}; }
    throw new Error(`fake GHL has no ${method} ${p}`);
  };
  return { g, calls, http, writes: () => calls.filter((c) => c.method !== "GET") };
}
function empty() {
  return {
    timezone: "America/New_York",
    pipelines: [] as { id: string; name: string; stages: { id: string; name: string; position?: number }[] }[],
    fields: [] as { id: string; name: string; dataType: string; model: string }[],
    objects: [] as { id: string; key: string; labels: { singular: string; plural?: string } }[],
    objFields: [] as { id: string; name: string; fieldKey: string; dataType: string; objectKey: string; parentId?: string; options?: { key: string; label: string }[] }[],
    associations: [] as { id: string; key: string; firstObjectKey: string; secondObjectKey: string }[],
    calendars: [] as { id: string; name: string; slotDuration?: number; slotDurationUnit?: string; teamMembers?: { userId: string }[]; openHours?: unknown }[],
    users: [{ id: "mitch", email: "Mitch@RevSignals.io" }, { id: "other", email: "someone@else.com" }],
  };
}
// another business already in the location: its things must never be written to
const foreign = (g: ReturnType<typeof empty>) => {
  g.pipelines.push({ id: "theirPipe", name: "[NEW] Sales Pipeline", stages: [{ id: "s1", name: "New Leads", position: 0 }] });
  g.fields.push({ id: "theirSetter", name: "Setter: Team Member", dataType: "TEXT", model: "contact" });
  g.objects.push({ id: "theirObj", key: "custom_objects.sales_call", labels: { singular: "Sales Call" } });
  g.objFields.push({ id: "theirOutcome", name: "Outcome", fieldKey: "custom_objects.sales_call.outcome", dataType: "SINGLE_OPTIONS", objectKey: "custom_objects.sales_call", options: [{ key: "x", label: "X" }] });
  g.associations.push({ id: "theirAssoc", key: "contact_sales_call", firstObjectKey: "contact", secondObjectKey: "custom_objects.sales_call" });
  g.calendars.push({ id: "theirCal", name: "Strategy Session", slotDuration: 30 });
};

describe("provision-ghl", () => {
  it("a dry run only reads, and says everything would be made", async () => {
    const f = fakeGhl(foreign);
    const r = await provision(setup, LOC, f.http, { apply: false });
    expect(f.writes()).toEqual([]);
    expect(r.writes).toEqual([]);
    expect(r.plan.filter((l) => l.action === "create").length).toBeGreaterThan(50);
    expect(r.plan.some((l) => l.action === "exists-differs" || l.action === "blocked")).toBe(false);
    expect((r.install._missing as string[]).length).toBeGreaterThan(30);
  });

  it("refuses to write in a dry run even if asked to, and never deletes", async () => {
    const f = fakeGhl();
    const r = await provision(setup, LOC, async (m, p, o) => { if (m !== "GET") throw new Error("reached the network"); return f.http(m, p, o); }, { apply: false });
    expect(r.writes).toEqual([]);
  });

  it("apply makes only what is missing, binds it all, and a second run is a no-op", async () => {
    const f = fakeGhl(foreign);
    const r = await provision(setup, LOC, f.http, { apply: true });
    expect(f.writes().every((c) => c.method === "POST")).toBe(true);
    expect(f.writes().map((c) => c.path)).not.toEqual(expect.arrayContaining([expect.stringMatching(/their/)]));
    expect(r.after!.every((l) => l.action === "exists")).toBe(true);
    expect(r.install._missing).toBeUndefined();
    const crm = r.install.crm as Record<string, string>;
    expect(crm.object_sales_call).toBe("custom_objects.dating_sales_call");
    expect(crm.stage_closer_closed_won).toBeTruthy();
    expect(crm.assoc_payment_opportunity).toBeTruthy();
    expect((r.install.salesCall as { object: string }).object).toBe("custom_objects.dating_sales_call");
    expect(Object.values(r.install.calendars as Record<string, { term: string }>).map((c) => c.term).sort()).toEqual(["closing", "closing", "first_call"]);
    expect(r.install.closerCall).toBeTruthy(); expect(r.install.bookingCalendar).not.toBe(r.install.closerCall);
    expect(f.g.calendars.filter((c) => c.id !== "theirCal").every((c) => (c.teamMembers ?? [])[0]?.userId === "mitch")).toBe(true);
    // the other business's things are as they were
    expect(f.g.pipelines.find((p) => p.id === "theirPipe")!.stages).toHaveLength(1);
    expect(f.g.objFields.find((x) => x.id === "theirOutcome")!.options).toEqual([{ key: "x", label: "X" }]);

    const before = f.calls.length;
    const again = await provision(setup, LOC, f.http, { apply: true });
    expect(f.calls.slice(before).every((c) => c.method === "GET")).toBe(true);
    expect(again.writes).toEqual([]);
    expect(again.plan.every((l) => l.action === "exists")).toBe(true);
    expect(again.install.crm).toEqual(r.install.crm);
  });

  it("after a partial run, adds only the missing stages, fields and options to its own things", async () => {
    const f = fakeGhl((g) => {
      foreign(g);
      g.pipelines.push({ id: "ours", name: "Dating - Setter Pipeline", stages: [{ id: "a", name: "New Lead", position: 0 }, { id: "b", name: "Custom Stage Tyler Added", position: 1 }] });
      g.objects.push({ id: "o1", key: "custom_objects.dating_sales_call", labels: { singular: "Dating Sales Call" } });
      g.objFields.push({ id: "f1", name: "Display Label", fieldKey: "custom_objects.dating_sales_call.display_label", dataType: "TEXT", objectKey: "custom_objects.dating_sales_call", parentId: "folder" });
      g.objFields.push({ id: "f2", name: "Closer", fieldKey: "custom_objects.dating_sales_call.closer", dataType: "SINGLE_OPTIONS", objectKey: "custom_objects.dating_sales_call", parentId: "folder", options: [{ key: "mitch", label: "Mitch" }, { key: "old", label: "Old" }] });
    });
    const r = await provision(setup, LOC, f.http, { apply: true });
    const puts = f.writes().filter((c) => c.method === "PUT");
    expect(puts.map((c) => c.path).sort()).toEqual(["/custom-fields/f2", "/opportunities/pipelines/ours"]);
    const stages = f.g.pipelines.find((p) => p.id === "ours")!.stages;
    expect(stages.slice(0, 2)).toMatchObject([{ id: "a", name: "New Lead", position: 0 }, { id: "b", name: "Custom Stage Tyler Added", position: 1 }]);
    expect(stages.map((s) => s.name)).toEqual(["New Lead", "Custom Stage Tyler Added", "Direct Booked", "Appointment Set", "Showed", "Cancelled", "DQ", "Not Interested"]);
    expect(f.g.objFields.find((x) => x.id === "f2")!.options!.map((o) => o.key)).toEqual(["mitch", "old", "nelly"]);
    expect(f.writes().filter((c) => c.path === "/objects/")).toHaveLength(2);   // the other two objects only
    expect(r.after!.every((l) => l.action === "exists")).toBe(true);
    expect((r.install.crm as Record<string, string>).pipeline_setter).toBe("ours");
  });

  it("refuses a type mismatch: a field it does not own by type is left alone, not duplicated and not bound", async () => {
    const f = fakeGhl((g) => { g.fields.push({ id: "clash", name: "Dating – Setter", dataType: "LARGE_TEXT", model: "contact" }); g.objects.push({ id: "x", key: "custom_objects.other", labels: { singular: "Dating Payment" } }); });
    const r = await provision(setup, LOC, f.http, { apply: true });
    expect(r.plan).toContainEqual(expect.objectContaining({ action: "exists-differs", what: 'contact field "Dating – Setter"', id: "clash" }));
    expect(f.writes().some((c) => c.path.includes("clash") || c.body?.name === "Dating – Setter")).toBe(false);
    expect((r.install.crm as Record<string, string>).field_contact_setter).toBeUndefined();
    expect(r.install._missing).toEqual(expect.arrayContaining(["field_contact_setter", "object_payment", "assoc_payment_contact", "assoc_payment_opportunity"]));
    // an object whose label is taken under another key is not made, and its associations wait
    expect(f.writes().some((c) => c.body?.key === "custom_objects.dating_payment")).toBe(false);
    expect(r.plan.filter((l) => l.action === "blocked").map((l) => l.what)).toHaveLength(2);
  });
});
