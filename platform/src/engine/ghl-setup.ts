import type { PoolClient } from "pg";
import { one } from "@/db/client";
import { ghl } from "@/adapters/ghl/client";
import { provision, printable, summary, type Http, type Setup } from "@/adapters/ghl/provision";
import { loadCompany } from "./context";

/**
 * D149: the additive GHL setup (src/adapters/ghl/provision.ts) run for one offer with the token the engine already holds, so no
 * copy of the token leaves the engine. `readGhl` shows what the location has; `setupGhl` plans (dry run) or applies a setup
 * that names only what it is about (a stage, an option): what it does not name it never reads as missing or touches.
 */
async function company(c: PoolClient, slug: string) {
  const co = await one<{ id: string }>(c, "select id from companies where slug=$1", [slug]);
  if (!co) return null;
  const { adapterCompany, bindings } = await loadCompany(c, co.id);
  const http: Http = (method, path, opts) => ghl(adapterCompany.pit, method, path, opts);
  return { id: co.id, loc: adapterCompany.locationId, http, bindings };
}

type Pipeline = { id: string; name: string; stages: { id: string; name: string; position?: number }[] };
type ObjField = { fieldKey: string; name: string; dataType?: string; options?: { key: string; label?: string }[] | null };
export async function readGhl(c: PoolClient, slug: string) {
  const co = await company(c, slug); if (!co) return null;
  const [p, ob] = await Promise.all([co.http("GET", `/opportunities/pipelines?locationId=${co.loc}`), co.http("GET", `/objects/?locationId=${co.loc}`)]);
  const custom = ((ob.objects ?? []) as { key: string; labels?: { singular?: string } }[]).filter((o) => o.key.startsWith("custom_objects."));
  const objects = await Promise.all(custom.map(async (o) => {
    const f = await co.http("GET", `/custom-fields/object-key/${o.key}?locationId=${co.loc}`);
    return { key: o.key, label: o.labels?.singular ?? o.key, fields: ((f.fields ?? []) as ObjField[]).map((x) => ({ key: x.fieldKey, name: x.name, type: x.dataType, ...(x.options?.length ? { options: x.options.map((op) => op.key) } : {}) })) };
  }));
  const pipelines = ((p.pipelines ?? []) as Pipeline[]).map((x) => ({ id: x.id, name: x.name, stages: [...x.stages].sort((a, b) => (a.position ?? 0) - (b.position ?? 0)).map((s) => ({ id: s.id, name: s.name })) }));
  const crm = Object.fromEntries(Object.entries(co.bindings).filter(([k]) => (k.startsWith("crm.") || k.startsWith("sales_call.")) && !k.startsWith("secret.")));
  return { location: co.loc, pipelines, objects, settings: crm };
}

const EMPTY: Omit<Setup, "pipelines" | "objects"> = { prefix: "", timezone: "", team: [], hours: { days: [], open: "09:00", close: "17:00" }, contactFields: [], opportunityFields: [], associations: [], calendars: [], install: {} };
export async function setupGhl(c: PoolClient, slug: string, partial: Partial<Setup>, apply: boolean) {
  const co = await company(c, slug); if (!co) return null;
  const setup: Setup = { ...EMPTY, pipelines: [], objects: [], ...partial };
  const tz = (await co.http("GET", `/locations/${co.loc}`)).location?.timezone;
  if (!setup.timezone) setup.timezone = tz ?? "";
  const r = await provision(setup, co.loc, co.http, { apply });
  return { apply, plan: printable(r.plan).split("\n"), summary: summary(r.plan), writes: r.writes, after: r.after ? summary(r.after) : undefined, crm: r.install.crm };
}
