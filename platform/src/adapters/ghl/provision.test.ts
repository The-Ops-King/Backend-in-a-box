import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { guard, provision, type Http, type Setup } from "./provision";
import { empty, fakeGhl, LOC } from "./fake-ghl";

const setup = JSON.parse(readFileSync(path.resolve(__dirname, "../../../installs/dating/ghl-setup.json"), "utf8")) as Setup;
// another business already in the location: its things must never be written to
const foreign = (g: ReturnType<typeof empty>) => {
  g.pipelines.push({ id: "theirPipe", name: "[NEW] Sales Pipeline", stages: [{ id: "s1", name: "New Leads", position: 0 }] });
  g.fields.push({ id: "theirSetter", name: "Setter: Team Member", dataType: "TEXT", model: "contact" });
  g.objects.push({ id: "theirObj", key: "custom_objects.sales_call", labels: { singular: "Sales Call" } });
  g.objFields.push({ id: "theirOutcome", name: "Outcome", fieldKey: "custom_objects.sales_call.outcome", dataType: "SINGLE_OPTIONS", objectKey: "custom_objects.sales_call", options: [{ key: "x", label: "X" }] });
  g.associations.push({ id: "theirAssoc", key: "contact_sales_call", firstObjectKey: "contact", secondObjectKey: "custom_objects.sales_call" });
  g.groups.push({ id: "theirGroup", name: "General Calendar", slug: "generalcalendar" });
  g.calendars.push({ id: "theirCal", name: "Strategy Session", slotDuration: 30, groupId: "theirGroup", teamMembers: [{ userId: "mitch" }] });
  g.calendars.push({ id: "theirLoose", name: "Dating Coach Intro", slotDuration: 30, teamMembers: [{ userId: "mitch" }] });   // in no group, a name near ours: still not the setup's
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
    expect((r.install.salesCall as { objections: string[] }).objections).toEqual(["price", "partner", "timing", "fear", "competitor", "think_about_it"]);   // D118: the field's own options
    expect((r.install.salesCall as { closerOptions: Record<string, string> }).closerOptions).toEqual({ "mitch@revsignals.io": "mitch", "nellysudri@gmail.com": "nelly" });
    expect(Object.values(r.install.calendars as Record<string, { term: string }>).map((c) => c.term).sort()).toEqual(["closing", "closing", "first_call"]);
    expect(r.install.closerCall).toBeTruthy(); expect(r.install.bookingCalendar).not.toBe(r.install.closerCall);
    const group = f.g.groups.find((x) => x.name === "Dating – Nelly")!;
    expect(group).toMatchObject({ locationId: LOC, slug: "dating-nelly", isActive: true });
    const ours = f.g.calendars.filter((c) => c.name.startsWith("Dating – "));
    expect(ours).toHaveLength(3);
    expect(ours.every((c) => c.groupId === group.id && c.teamMembers!.map((t) => t.userId).join() === "nelly")).toBe(true);
    expect(f.g.calendars.find((c) => c.id === "theirCal")).toMatchObject({ groupId: "theirGroup", teamMembers: [{ userId: "mitch" }] });
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

  it("D119: a stage the setup adds later goes where the setup puts it: Deposit after Follow Up on the closer pipeline already built, every stage kept with its id, the ones behind it a place down", async () => {
    const built = ["Scheduled", "Cancelled / No Show", "Follow Up", "Agreement Sent", "Closed Won", "Lost", "Disqualified"];
    const f = fakeGhl((g) => { foreign(g); g.pipelines.push({ id: "closer", name: "Dating – Closer Pipeline", stages: built.map((name, i) => ({ id: `c${i}`, name, position: i })) }); });
    const dry = await provision(setup, LOC, f.http, { apply: false });
    expect(dry.plan.find((l) => l.id === "closer" && l.action === "missing-on-ours")?.detail).toBe('adds "Deposit" after "Follow Up" (none removed or renamed; the stages behind a new one move down one)');
    await provision(setup, LOC, f.http, { apply: true });
    const put = f.writes().find((c) => c.method === "PUT" && c.path === "/opportunities/pipelines/closer")!;
    expect(put.body.stages).toEqual([
      { id: "c0", name: "Scheduled", position: 0 }, { id: "c1", name: "Cancelled / No Show", position: 1 }, { id: "c2", name: "Follow Up", position: 2 },
      { name: "Deposit", position: 3 },
      { id: "c3", name: "Agreement Sent", position: 4 }, { id: "c4", name: "Closed Won", position: 5 }, { id: "c5", name: "Lost", position: 6 }, { id: "c6", name: "Disqualified", position: 7 }]);
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

describe("D121: the setup's calendars go in its own group, and their team is the setup's", () => {
  const hours = [1, 2, 3, 4, 5].map((d) => ({ daysOfTheWeek: [d], hours: [{ openHour: 9, openMinute: 0, closeHour: 17, closeMinute: 0 }] }));
  // the three calendars as the first run made them: on Mitch, in no group (RapidCloser before D121)
  const built = (g: ReturnType<typeof empty>) => {
    foreign(g);
    for (const [id, name, min] of [["cDirect", "Dating – Strategy Call (Direct)", 45], ["cSetter", "Dating – Strategy Call (Setter)", 45], ["cTriage", "Dating – Triage Call", 15]] as const)
      g.calendars.push({ id, name, slotDuration: min, slotDurationUnit: "mins", openHours: hours, teamMembers: [{ userId: "mitch", priority: 0.5, isPrimary: true }] });
  };
  const calWrites = (f: ReturnType<typeof fakeGhl>) => f.writes().filter((c) => c.path.startsWith("/calendars"));

  it("the dry run only reads and says the exact before → after; apply makes the group and changes only the three; a second run is a no-op", async () => {
    const f = fakeGhl(built);
    const dry = await provision(setup, LOC, f.http, { apply: false });
    expect(f.writes()).toEqual([]);
    expect(dry.plan).toContainEqual({ action: "create", what: 'calendar group "Dating – Nelly"', detail: "slug dating-nelly; the setup's 3 calendars go in it" });
    expect(dry.plan).toContainEqual({ action: "change-on-ours", what: '  team of calendar "Dating – Strategy Call (Setter)"', id: "cSetter",
      detail: "Mitch Sapoff <Mitch@RevSignals.io> → Nelly S. <nellysudri@gmail.com>; calls already booked are not reassigned by this" });
    expect(dry.plan).toContainEqual({ action: "missing-on-ours", what: '  group of calendar "Dating – Triage Call"', id: "cTriage", detail: 'goes in "Dating – Nelly" (made above)' });
    expect(dry.plan.filter((l) => l.action === "change-on-ours").map((l) => l.id)).toEqual(["cDirect", "cSetter", "cTriage"]);
    expect(dry.plan.some((l) => l.what.includes('"Strategy Session"') || l.what.includes("Dating Coach"))).toBe(false);   // the other business's calendars (not the setup's "Wants Strategy Session" field)

    const sched = JSON.stringify(f.g.calendars.filter((c) => ["cDirect", "cSetter", "cTriage"].includes(c.id)).map((c) => [c.id, c.slotDuration, c.openHours]));
    const r = await provision(setup, LOC, f.http, { apply: true });
    const group = f.g.groups.find((x) => x.name === "Dating – Nelly")!;
    expect(calWrites(f).map((c) => `${c.method} ${c.path}`)).toEqual(["POST /calendars/groups", "PUT /calendars/cDirect", "PUT /calendars/cSetter", "PUT /calendars/cTriage"]);
    for (const c of calWrites(f).filter((x) => x.method === "PUT")) expect(c.body).toMatchObject({ teamMembers: [{ userId: "nelly", priority: 0.5, isPrimary: true }], groupId: group.id });
    // GHL resets the schedule a PUT leaves out: each calendar keeps its own length and hours
    expect(JSON.stringify(f.g.calendars.filter((c) => ["cDirect", "cSetter", "cTriage"].includes(c.id)).map((c) => [c.id, c.slotDuration, c.openHours]))).toBe(sched);
    expect(f.writes().some((c) => /their/.test(c.path) || /their/.test(JSON.stringify(c.body ?? {})))).toBe(false);
    expect(f.g.calendars.find((c) => c.id === "theirCal")).toMatchObject({ groupId: "theirGroup", teamMembers: [{ userId: "mitch" }] });
    expect(f.g.calendars.find((c) => c.id === "theirLoose")).toEqual({ id: "theirLoose", name: "Dating Coach Intro", slotDuration: 30, teamMembers: [{ userId: "mitch" }] });
    expect(f.g.groups.find((x) => x.id === "theirGroup")).toEqual({ id: "theirGroup", name: "General Calendar", slug: "generalcalendar" });
    expect(r.after!.every((l) => l.action === "exists")).toBe(true);
    expect(r.install._missing).toBeUndefined();

    const before = f.calls.length;
    const again = await provision(setup, LOC, f.http, { apply: true });
    expect(f.calls.slice(before).every((c) => c.method === "GET")).toBe(true);
    expect(again.writes).toEqual([]);
    expect(again.plan.every((l) => l.action === "exists")).toBe(true);
  });

  it("one who stays keeps their place; a group made by hand under the name is used, not made again", async () => {
    const two = { ...setup, team: ["nellysudri@gmail.com", "mitch@revsignals.io"] };
    const f = fakeGhl((g) => { built(g); g.groups.push({ id: "byHand", name: "dating - nelly", slug: "whatever" }); });
    const dry = await provision(two, LOC, f.http, { apply: false });
    expect(dry.plan.find((l) => l.id === "cDirect" && l.action === "change-on-ours")?.detail)
      .toBe("Mitch Sapoff <Mitch@RevSignals.io> → Nelly S. <nellysudri@gmail.com>, Mitch Sapoff <Mitch@RevSignals.io> (joins: Nelly S. <nellysudri@gmail.com>); calls already booked are not reassigned by this");
    await provision(two, LOC, f.http, { apply: true });
    expect(calWrites(f).some((c) => c.method === "POST")).toBe(false);
    expect(calWrites(f).find((c) => c.path === "/calendars/cSetter")!.body).toMatchObject({ groupId: "byHand", teamMembers: [{ userId: "nelly", priority: 0.5, isPrimary: false }, { userId: "mitch", priority: 0.5, isPrimary: true }] });
  });

  it("a calendar of the setup's in someone else's group is not moved; a taken slug makes no group and moves nothing", async () => {
    const f = fakeGhl((g) => { built(g); g.calendars.find((c) => c.id === "cTriage")!.groupId = "theirGroup"; g.groups.push({ id: "slugOwner", name: "Someone's", slug: "Dating-Nelly" }); });
    const r = await provision(setup, LOC, f.http, { apply: true });
    expect(r.plan).toContainEqual({ action: "blocked", what: 'calendar group "Dating – Nelly"', detail: `its slug "dating-nelly" is the group "Someone's"'s: not made (give the setup another slug)` });
    expect(r.plan).toContainEqual({ action: "exists-differs", what: '  group of calendar "Dating – Triage Call"', id: "cTriage", detail: 'in the group "General Calendar", not the setup\'s: not moved' });
    expect(calWrites(f).some((c) => c.method === "POST" || "groupId" in (c.body ?? {}))).toBe(false);
    expect(f.g.calendars.find((c) => c.id === "cTriage")!.groupId).toBe("theirGroup");
    expect(r.install._missing).toEqual(['calendar group "Dating – Nelly"']);
  });

  it("the guard: a calendar PUT only to a calendar the setup names, only its group and team, only the setup's group; never a group; nothing in a dry run", async () => {
    const sent: string[] = [];
    const http: Http = async (m, p) => { sent.push(`${m} ${p}`); return {}; };
    const own = { paths: new Set<string>(), calendars: new Set(["cSetter"]), group: "ourGroup" };
    const live = guard(http, true, own, []);
    await expect(live("PUT", "/calendars/theirCal", { body: { teamMembers: [] } })).rejects.toThrow(/not a calendar this setup names/);
    await expect(live("PUT", "/calendars/cSetter", { body: { teamMembers: [], name: "x" } })).rejects.toThrow(/name is never changed/);
    await expect(live("PUT", "/calendars/cSetter", { body: { groupId: "theirGroup" } })).rejects.toThrow(/not this setup's/);
    await expect(live("PUT", "/calendars/groups/ourGroup", { body: { name: "x" } })).rejects.toThrow(/not a calendar this setup names/);
    await expect(live("POST", "/calendars/", { body: { name: "x", groupId: "theirGroup" } })).rejects.toThrow(/not this setup's/);
    await expect(live("DELETE", "/calendars/cSetter")).rejects.toThrow(/never deletes/);
    await expect(guard(http, false, own, [])("PUT", "/calendars/cSetter", { body: { groupId: "ourGroup" } })).rejects.toThrow(/dry run/);
    expect(sent).toEqual([]);
    await live("PUT", "/calendars/cSetter", { body: { groupId: "ourGroup", teamMembers: [{ userId: "nelly" }] } });
    expect(sent).toEqual(["PUT /calendars/cSetter"]);
  });
});

describe("D122: the application fields go in the setup's own contact-field folder", () => {
  const app = setup.contactFields.filter((f) => f.folder === "Application");

  it("the dry run only reads (each folder by its id) and says the folder and its fields would be made", async () => {
    const f = fakeGhl(foreign);
    const r = await provision(setup, LOC, f.http, { apply: false });
    expect(f.writes()).toEqual([]);
    expect(r.plan).toContainEqual({ action: "create", what: 'contact field folder "Dating – Application"', detail: `holds ${app.length} contact fields` });
    expect(r.plan).toContainEqual({ action: "create", what: 'contact field "Dating – Ideal Partner"', detail: 'LARGE_TEXT, in "Dating – Application"' });
    expect(r.plan).toContainEqual({ action: "create", what: 'contact field "Dating – Age"', detail: 'NUMERICAL, in "Dating – Application"' });
  });

  it("apply makes the folder, then every application field in it (TEXT for choices, NUMERICAL age, LARGE_TEXT long text); a second run finds the folder by its fields and writes nothing", async () => {
    const f = fakeGhl(foreign);
    const r = await provision(setup, LOC, f.http, { apply: true });
    const folder = f.g.folders.find((x) => x.name === "Dating – Application")!;
    expect(f.writes().filter((c) => c.body?.documentType === "folder")).toEqual([{ method: "POST", path: `/locations/${LOC}/customFields`, body: { name: "Dating – Application", documentType: "folder", model: "contact", dataType: "TEXT" } }]);
    const made = f.g.fields.filter((x) => x.parentId === folder.id);
    expect(made.map((x) => x.name).sort()).toEqual(app.map((x) => `Dating – ${x.name}`).sort());
    expect(new Set(made.map((x) => x.dataType))).toEqual(new Set(["TEXT", "NUMERICAL", "LARGE_TEXT"]));
    expect(f.g.fields.find((x) => x.name === "Dating – UTM Source")!.parentId).toBe("default");   // the setup's other fields: no folder, as before
    expect(r.after!.every((l) => l.action === "exists")).toBe(true);
    expect((r.install.crm as Record<string, string>).field_contact_app_age).toBe(f.g.fields.find((x) => x.name === "Dating – Age")!.id);
    expect((r.install.typeform as { forms: Record<string, unknown> }).forms.AjY7UfXZ).toBeTruthy();
    const before = f.calls.length;
    const again = await provision(setup, LOC, f.http, { apply: true });
    expect(f.calls.slice(before).every((c) => c.method === "GET")).toBe(true);
    expect(again.plan.every((l) => l.action === "exists")).toBe(true);
  });

  it("a field made earlier outside the folder is bound, said and not moved (a field is never PUT); a folder GHL will not make is said and the fields go in without one", async () => {
    const f = fakeGhl((g) => { foreign(g); g.folders.push({ id: "appF", name: "Dating – Application" }); g.fields.push({ id: "inF", name: "Dating – Age", dataType: "NUMERICAL", model: "contact", parentId: "appF" }, { id: "outF", name: "Dating – Income", dataType: "TEXT", model: "contact", parentId: "default" }); });
    const r = await provision(setup, LOC, f.http, { apply: true });
    expect(r.plan).toContainEqual({ action: "exists", what: 'contact field folder "Dating – Application"', id: "appF" });
    expect(r.plan).toContainEqual({ action: "exists-differs", what: 'contact field "Dating – Income"', id: "outF", detail: 'TEXT, in the folder "Additional Info", not "Dating – Application": bound, not moved (move it by hand)' });
    expect((r.install.crm as Record<string, string>).field_contact_app_income).toBe("outF");
    expect(f.writes().some((c) => c.method === "PUT" && c.path.includes("customFields"))).toBe(false);
    expect(f.g.fields.filter((x) => x.parentId === "appF")).toHaveLength(app.length - 1);

    const g2 = fakeGhl((g) => { foreign(g); g.noFolders = true; });
    const r2 = await provision(setup, LOC, g2.http, { apply: true });
    expect(r2.plan.find((l) => l.what === 'contact field folder "Dating – Application"' && l.action === "blocked")?.detail).toMatch(/^GHL did not make it \(.*documentType should not exist\): its fields go in without a folder; make "Dating – Application" in GHL and move them into it by hand$/);
    expect(g2.g.fields.filter((x) => x.name === "Dating – Age")).toEqual([expect.objectContaining({ parentId: "default" })]);
  });
});
