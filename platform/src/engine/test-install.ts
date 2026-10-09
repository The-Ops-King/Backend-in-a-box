import type { PoolClient } from "pg";
import { one } from "@/db/client";
import { templates } from "@/templates";
import { parseDefinition, extractManifest, type Definition } from "./definition";
import { syncTriggers } from "./install";

/** Tests: put one shipped template on a company the way install does (a version, its triggers), optionally changed first (a node's settings, a schedule time). */
export async function installTemplateForTest(c: PoolClient, companyId: string, slug: string, opts: { enabled?: boolean; patch?: (def: Definition) => void } = {}): Promise<string> {
  const t = templates.find((x) => x.slug === slug); if (!t) throw new Error(`no template ${slug}`);
  const def = parseDefinition(JSON.parse(JSON.stringify(t.definition)));
  opts.patch?.(def);
  const parsed = parseDefinition(def);
  const wf = (await one<{ id: string }>(c, "insert into workflows (company_id, name, reentry_policy, enabled) values ($1,$2,$3,$4) returning id", [companyId, t.name, parsed.reentry, opts.enabled ?? true]))!;
  await c.query("insert into workflow_versions (workflow_id, version, definition, manifest, note) values ($1,1,$2,$3,'test')", [wf.id, parsed, extractManifest(parsed)]);
  await syncTriggers(c, companyId, wf.id, parsed);
  return wf.id;
}

/** Tests: health probes that never touch a vendor; every calendar has a dozen slots, every key answers. */
export const fakeProbes: import("./health").HealthProbes = {
  ghlLocationOk: async () => ({ ok: true, name: "Test Co" }),
  ghlFreeSlots: async (_p, _cal, from) => ({ ok: true, slots: 12, times: Array.from({ length: 12 }, (_, i) => new Date(from.getTime() + (i % 6) * 864e5 + (9 + Math.floor(i / 6)) * 36e5).toISOString()) }),
  ghlCatalog: async () => ({ users: [], pipelines: [], contactFields: [], opportunityFields: [], associations: [], objects: [], tags: [], errors: [] }),
  calendlyWhoAmI: async () => ({ user: "u", organization: "o", email: "host@test", name: "Host" }), calendlyAvailableTimes: async () => ({ ok: true, slots: 12, times: [] }),
  whopPing: async () => true, whopGetWebhook: async () => ({ ok: true, found: true, enabled: true }), fathomPing: async () => true, fathomListWebhooks: async () => null, anthropicPing: async () => ({ ok: true }), urlOk: async () => ({ ok: true, status: 200 }),
};
