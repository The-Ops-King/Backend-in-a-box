import type { Store, Tx } from "@/engine/store";
import type { EventRow, NewEvent } from "@/engine/types";
import { type Loaded, emptyLoaded, needs, project } from "./projector";
import { PROJ_TABLES, type ProjTable, type Rows } from "./tables";

/**
 * Running facts through the projectors. Every fact the engine records goes through `recordFact`, which appends it and,
 * when it is new, projects it in the same transaction, so a step that reads right after sees it. `rebuildProjections`
 * drops an offer's projections and runs its whole fact log through again in order: the same rows come out.
 */

/** Reads the rows a fact touches, as they are now. */
async function load(tx: Tx, e: EventRow): Promise<Loaded> {
  const loaded = emptyLoaded();
  const add = <T extends ProjTable>(table: T, rows: Rows[T][]) => { for (const r of rows) (loaded[table] as Map<string, Rows[T]>).set(r.id, r); };
  for (const n of needs(e)) {
    if ("id" in n) { const r = await tx.projGet(n.table, e.offerId, n.id); if (r) add(n.table, [r]); }
    else add(n.table, await tx.projFind(n.table, e.offerId, n.query));
  }
  return loaded;
}

/** Projects one fact: its row changes written in this transaction. */
export async function applyFact(tx: Tx, e: EventRow, zone?: string): Promise<void> {
  const z = zone ?? (await tx.offer(e.offerId))?.zone;
  if (!z) throw new Error(`fact ${e.id}: its offer is gone`);
  for (const c of project(e, await load(tx, e), { zone: z })) {
    if ("put" in c) await tx.projPut(c.put.table, c.put.row as never);
    else await tx.projInc(c.inc);
  }
}

/** Appends a fact; a new one is projected at once. The one way the engine records a fact. */
export async function recordFact(tx: Tx, e: NewEvent): Promise<{ event: EventRow; inserted: boolean }> {
  const r = await tx.appendEvent(e);
  if (r.inserted) await applyFact(tx, r.event);
  return r;
}

/** Drops one offer's projections and builds them again from its facts, in the order they were recorded. */
export async function rebuildProjections(store: Store, offerId: string): Promise<{ facts: number }> {
  return store.tx(async (tx) => {
    const offer = await tx.offer(offerId);
    if (!offer) throw new Error("no such offer");
    await tx.projClear(offerId);
    const facts = (await tx.events({ offerId })).sort((a, b) => a.id - b.id);
    for (const e of facts) await applyFact(tx, e, offer.zone);
    return { facts: facts.length };
  });
}

/** Every projection row of one offer, by table: for comparing a rebuild with what was built as the facts came. */
export async function projectionsOf(store: Store, offerId: string): Promise<{ [T in ProjTable]: Rows[T][] }> {
  return store.tx(async (tx) => {
    const out = {} as { [T in ProjTable]: Rows[T][] };
    for (const t of PROJ_TABLES) (out as Record<string, unknown>)[t] = await tx.projFind(t, offerId);
    return out;
  });
}
