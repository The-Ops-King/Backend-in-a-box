/** A fake GHL location for tests: answers the calls the provisioner makes (src/adapters/ghl/provision.ts), in memory. */
import type { Http } from "./provision";

export const LOC = "loc1";

/** An in-memory GHL location answering the calls provision makes; `calls` keeps every request in order. */
export function fakeGhl(seed: (g: ReturnType<typeof empty>) => void = () => {}) {
  const g = empty(); seed(g);
  let n = 0; const id = () => `id${++n}`;
  const calls: { method: string; path: string; body?: any }[] = [];   // eslint-disable-line @typescript-eslint/no-explicit-any
  const http: Http = async (method, p, opts) => {
    const body = opts?.body as any; calls.push({ method, path: p, body });   // eslint-disable-line @typescript-eslint/no-explicit-any
    const [route] = p.split("?");
    if (method === "GET") {
      if (route === `/locations/${LOC}`) return { location: { name: "Fake", timezone: g.timezone } };
      if (route === "/opportunities/pipelines") return { pipelines: g.pipelines };
      // as GHL does (RapidCloser, 2026-10-16): the list leaves folders out; a folder is read by its id
      if (route === `/locations/${LOC}/customFields`) return { customFields: g.fields.filter((f) => p.endsWith(`model=${f.model}`)) };
      const fo = new RegExp(`^/locations/${LOC}/customFields/(.+)$`).exec(route);
      if (fo) { const x = g.folders.find((y) => y.id === fo[1]); if (!x) throw new Error("404 no such field"); return { customField: { ...x, model: "contact", documentType: "folder" } }; }
      if (route === "/objects/") return { objects: g.objects };
      if (route === "/associations/") return { associations: g.associations };
      if (route === "/calendars/") return { calendars: g.calendars };
      if (route === "/calendars/groups") return { groups: g.groups };
      if (route === "/users/") return { users: g.users };
      const ok = /^\/custom-fields\/object-key\/(.+)$/.exec(route);
      if (ok) return { fields: g.objFields.filter((f) => f.objectKey === ok[1]), folders: g.objects.some((o) => o.key === ok[1]) ? [{ id: `folder:${ok[1]}` }] : [] };
    }
    if (method === "POST" && route === "/opportunities/pipelines") { const p2 = { id: id(), name: body.name, stages: body.stages.map((s: { name: string; position: number }) => ({ id: id(), ...s })) }; g.pipelines.push(p2); return p2; }
    if (method === "POST" && route === `/locations/${LOC}/customFields` && body.documentType === "folder") { const x = { id: id(), name: body.name }; if (g.noFolders) throw new Error("GHL 422 documentType should not exist"); g.folders.push(x); return { customFieldFolder: x }; }
    if (method === "POST" && route === `/locations/${LOC}/customFields`) { const f = { id: id(), name: body.name, dataType: body.dataType, model: body.model, parentId: body.parentId ?? "default" }; g.fields.push(f); return { customField: f }; }
    if (method === "POST" && route === "/objects/") {
      g.objects.push({ id: id(), key: body.key, labels: body.labels });
      g.objFields.push({ id: id(), name: body.primaryDisplayPropertyDetails.name, fieldKey: body.primaryDisplayPropertyDetails.key, dataType: "TEXT", objectKey: body.key, parentId: `folder:${body.key}` });
      return { object: g.objects.at(-1) };
    }
    if (method === "POST" && route === "/custom-fields/") { const f = { id: id(), name: body.name, fieldKey: body.fieldKey, dataType: body.dataType, objectKey: body.objectKey, parentId: body.parentId, options: body.options }; g.objFields.push(f); return { field: f }; }
    if (method === "POST" && route === "/associations/") { const a = { id: id(), ...body }; g.associations.push(a); return a; }
    if (method === "POST" && route === "/calendars/") { const c = { id: id(), ...body }; g.calendars.push(c); return { calendar: c }; }
    if (method === "POST" && route === "/calendars/groups") { const x = { id: id(), ...body }; g.groups.push(x); return { group: x }; }
    const cp = /^\/calendars\/([^/]+)$/.exec(route);
    // as GHL does: a calendar PUT resets the schedule it is not sent (seen live 2026-10-16)
    if (method === "PUT" && cp) { const cal = g.calendars.find((x) => x.id === cp[1])!; Object.assign(cal, { slotDuration: 30, slotInterval: 30, openHours: {} }, body); return { calendar: cal }; }
    const pp = /^\/opportunities\/pipelines\/(.+)$/.exec(route);
    if (method === "PUT" && pp) { const pl = g.pipelines.find((x) => x.id === pp[1])!; pl.stages = body.stages.map((s: { id?: string }) => ({ ...s, id: s.id ?? id() })); return {}; }
    const cf = /^\/custom-fields\/(.+)$/.exec(route);
    if (method === "PUT" && cf) { const f = g.objFields.find((x) => x.id === cf[1])!; f.options = body.options; return {}; }
    throw new Error(`fake GHL has no ${method} ${p}`);
  };
  return { g, calls, http, writes: () => calls.filter((c) => c.method !== "GET") };
}
export function empty() {
  return {
    timezone: "America/New_York",
    pipelines: [] as { id: string; name: string; stages: { id: string; name: string; position?: number }[] }[],
    fields: [] as { id: string; name: string; dataType: string; model: string; parentId?: string }[],
    folders: [{ id: "default", name: "Additional Info" }] as { id: string; name: string }[], noFolders: false,
    objects: [] as { id: string; key: string; labels: { singular: string; plural?: string } }[],
    objFields: [] as { id: string; name: string; fieldKey: string; dataType: string; objectKey: string; parentId?: string; options?: { key: string; label: string }[] }[],
    associations: [] as { id: string; key: string; firstObjectKey: string; secondObjectKey: string }[],
    calendars: [] as { id: string; name: string; groupId?: string; slotDuration?: number; slotDurationUnit?: string; slotInterval?: number; teamMembers?: { userId: string; priority?: number; isPrimary?: boolean }[]; openHours?: unknown }[],
    groups: [] as { id: string; name: string; slug: string; description?: string; isActive?: boolean }[],
    users: [{ id: "mitch", name: "Mitch Sapoff", email: "Mitch@RevSignals.io" }, { id: "nelly", name: "Nelly S.", email: "nellysudri@gmail.com" }, { id: "other", name: "Someone", email: "someone@else.com" }],
  };
}
