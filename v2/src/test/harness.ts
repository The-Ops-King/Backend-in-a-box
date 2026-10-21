import { db } from "@/db/client";
import { Engine } from "@/engine/engine";
import { FakePorts } from "@/engine/fake-ports";
import { MemStore } from "@/engine/mem-store";
import { PgStore } from "@/engine/pg-store";
import type { CrmContact } from "@/engine/ports";
import type { Store } from "@/engine/store";
import { type ContentSeed, FakeClock, install, setupOffer } from "@/engine/testkit";
import type { CrmWrites, Delivery, WorkflowRow } from "@/engine/types";
import { advanceTo } from "@/engine/drive";
import { freshEngineDb } from "./engine-db";

/** The stores every engine test runs against: memory always, Postgres when DATABASE_URL is set. */
export type StoreKind = "memory" | "postgres";
export const STORES: StoreKind[] = process.env.DATABASE_URL ? ["memory", "postgres"] : ["memory"];

export async function makeStore(kind: StoreKind): Promise<Store> {
  if (kind === "memory") return new MemStore();
  await freshEngineDb();
  return new PgStore(db());
}

type N = Record<string, unknown>;
export const window = { zone: "contact", opens: "08:00", closes: "20:00", outside: "earlier_same_day", transactional: "any_hour" };
/** A workflow definition from its nodes and edges, with the header filled in. */
export const flow = (id: string, nodes: N[], edges: N[], header: N = {}) => ({ schema: 2, id, name: id, reentry: { policy: "always" }, ...header, nodes, edges });
/** A chain of nodes, each to the next. */
export const chain = (...ids: string[]) => ids.slice(1).map((to, i) => ({ from: ids[i]!, to }));

export type Harness = Awaited<ReturnType<typeof harness>>;

/** One offer with its workflows installed and enabled, a fake clock, fake ports and an engine, on the store given. */
export async function harness(kind: StoreKind, o: {
  workflows: unknown[]; start?: string; zone?: string; settings?: Record<string, unknown>; content?: ContentSeed;
  contacts?: CrmContact[]; operator?: { emails?: string[]; phones?: string[] }; delivery?: Delivery; crmWrites?: CrmWrites;
}) {
  const store = await makeStore(kind);
  const clock = new FakeClock(o.start ?? "2026-10-26T14:00:00Z");
  const fp = new FakePorts(clock.now);
  for (const c of o.contacts ?? [{ id: "c1", phone: "+15550101001", email: "ana@example.com", timezone: "America/New_York", dnd: {} }]) fp.contacts.set(c.id, c);
  const offerId = await setupOffer(store, { slug: "acme", zone: o.zone ?? "America/Denver", settings: o.settings ?? {}, content: o.content ?? {}, operator: o.operator ?? {} });
  const wfs: Record<string, WorkflowRow> = {};
  for (const w of o.workflows) {
    const row = await install(store, offerId, w, { now: clock.now(), delivery: o.delivery ?? "live", crmWrites: o.crmWrites ?? "real" });
    wfs[row.key] = row;
  }
  const engine = new Engine({ store, ports: fp.ports(), now: clock.now, random: () => 0.5 });
  let n = 0;
  const h = {
    kind, store, clock, fp, engine, offerId, wfs,
    /** A fact arrives now. */
    /** A fact arrives now, and everything it makes due is done (as the job runner would at once). */
    ingest: async (type: string, x: { contact?: string | null; appointment?: string | null; deal?: string | null; payload?: N; key?: string } = {}) => {
      const r = await engine.ingest({ offerId, type, source: "test", dedupeKey: x.key ?? `test:${++n}`, contactId: x.contact === undefined ? "c1" : x.contact, appointmentId: x.appointment ?? null, dealId: x.deal ?? null, payload: x.payload ?? {} });
      await engine.runDue();
      return r;
    },
    /** Moves the clock on ("2h", "1d2h30m"), doing everything due on the way at its own time. */
    advance: async (by: string) => { const c = new FakeClock(clock.now()); c.advance(by); await advanceTo(engine, store, clock, c.now()); },
    due: () => engine.runDue(),
    runs: () => store.tx((tx) => tx.runs({ offerId })),
    run: async () => (await store.tx((tx) => tx.runs({ offerId })))[0]!,
    steps: async (runId?: string) => store.tx(async (tx) => tx.steps(runId ?? (await tx.runs({ offerId }))[0]!.id)),
    outbox: () => store.tx((tx) => tx.outboxRows({ offerId })),
    alerts: () => store.tx((tx) => tx.alerts({ offerId })),
    events: (type?: string) => store.tx((tx) => tx.events({ offerId, ...(type ? { types: [type] } : {}) })),
    posts: () => store.tx((tx) => tx.posts({ offerId })),
    /** The texts the fake messaging vendor was asked to send, in order. */
    texts: () => fp.effects("messaging").map((c) => (c.args as { body: string }).body),
  };
  return h;
}
