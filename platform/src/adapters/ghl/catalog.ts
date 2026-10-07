import { ghl } from "./client";

/**
 * Settings-time lookups: the lists a person picks from instead of pasting ids (ghl/02-api-facts.md). Each list fails
 * on its own — a token without one scope still yields the others, and the screen says which list it could not load.
 */
export type Catalog = {
  users: { id: string; name: string; email?: string }[];
  pipelines: { id: string; name: string; stages: { id: string; name: string }[] }[];
  contactFields: { id: string; name: string; type?: string }[];
  opportunityFields: { id: string; name: string; type?: string }[];
  associations: { id: string; key: string; label: string }[];
  objects: { key: string; label: string }[];
  errors: string[];
};

export async function ghlCatalog(pit: string, locationId: string): Promise<Catalog> {
  const out: Catalog = { users: [], pipelines: [], contactFields: [], opportunityFields: [], associations: [], objects: [], errors: [] };
  const tryGet = async <T,>(label: string, path: string, pick: (r: T) => void) => { try { pick(await ghl<T>(pit, "GET", path)); } catch (e) { out.errors.push(`${label}: ${String((e as Error).message).slice(0, 140)}`); } };
  await Promise.all([
    tryGet<{ users: { id: string; name?: string; firstName?: string; lastName?: string; email?: string }[] }>("users", `/users/?locationId=${locationId}`, (r) => { out.users = (r.users ?? []).map((u) => ({ id: u.id, name: (u.name ?? `${u.firstName ?? ""} ${u.lastName ?? ""}`.trim()) || u.id, email: u.email })); }),
    tryGet<{ pipelines: { id: string; name: string; stages?: { id: string; name: string }[] }[] }>("pipelines", `/opportunities/pipelines?locationId=${locationId}`, (r) => { out.pipelines = (r.pipelines ?? []).map((p) => ({ id: p.id, name: p.name, stages: (p.stages ?? []).map((s) => ({ id: s.id, name: s.name })) })); }),
    tryGet<{ customFields: { id: string; name: string; dataType?: string; model?: string }[] }>("contact fields", `/locations/${locationId}/customFields?model=contact`, (r) => { out.contactFields = (r.customFields ?? []).map((f) => ({ id: f.id, name: f.name, type: f.dataType })); }),
    tryGet<{ customFields: { id: string; name: string; dataType?: string }[] }>("opportunity fields", `/locations/${locationId}/customFields?model=opportunity`, (r) => { out.opportunityFields = (r.customFields ?? []).map((f) => ({ id: f.id, name: f.name, type: f.dataType })); }),
    tryGet<{ associations: { id: string; key: string; firstObjectLabel?: string; secondObjectLabel?: string; firstObjectKey?: string; secondObjectKey?: string }[] }>("associations", `/associations/?locationId=${locationId}&skip=0&limit=100`, (r) => { out.associations = (r.associations ?? []).map((a) => ({ id: a.id, key: a.key, label: `${a.firstObjectLabel ?? a.firstObjectKey ?? "?"} ↔ ${a.secondObjectLabel ?? a.secondObjectKey ?? "?"} (${a.key})` })); }),
    tryGet<{ objects: { key: string; labels?: { singular?: string; plural?: string } }[] }>("custom objects", `/objects/?locationId=${locationId}`, (r) => { out.objects = (r.objects ?? []).map((o) => ({ key: o.key, label: o.labels?.singular ?? o.key })); }),
  ]);
  return out;
}
