import type { PoolClient } from "pg";
import { ghlCatalog, type Catalog } from "@/adapters/ghl/catalog";
import { loadCompany } from "@/engine/context";
import { NONE, namer, namesOf, type CrmNames, type Namer } from "./crm-names";

type Reader = (pit: string, locationId: string) => Promise<Catalog>;
const TTL = 10 * 60_000, FAIL_TTL = 60_000, TIMEOUT = 5_000;
const cache = new Map<string, { until: number; names: Promise<CrmNames> }>();
let reader: Reader = ghlCatalog;
/** Tests read names from a stub, never the CRM; null puts the CRM back. */
export const setCrmNamesReader = (r: Reader | null) => { reader = r ?? ghlCatalog; cache.clear(); };

async function readNames(pit: string, locationId: string, read: Reader): Promise<CrmNames> {
  if (!pit || !locationId) return NONE;
  let timer: NodeJS.Timeout | undefined;
  try { return namesOf(await Promise.race([read(pit, locationId), new Promise<never>((_, no) => { timer = setTimeout(() => no(new Error("timed out")), TIMEOUT); })])); }
  catch { return NONE; }
  finally { clearTimeout(timer); }
}

/**
 * The company's CRM names (D112) as a Namer over its bindings: one read of its pipelines, fields and objects, kept ten
 * minutes in memory per company (a failed read one minute); when the CRM cannot be read, the key words, marked.
 */
export async function crmNamer(c: PoolClient, companyId: string, read: Reader = reader): Promise<Namer> {
  const { bindings, adapterCompany } = await loadCompany(c, companyId);
  const now = Date.now(); let hit = cache.get(companyId);
  if (!hit || hit.until < now) {
    const names = readNames(adapterCompany.pit, adapterCompany.locationId, read);
    hit = { until: now + TTL, names }; cache.set(companyId, hit);
    void names.then((n) => { if (!n.read && cache.get(companyId) === hit) hit!.until = now + FAIL_TTL; });
  }
  return namer(bindings, await hit.names);
}

