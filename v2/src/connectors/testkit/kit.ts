import crypto from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "@/db/client";
import { Engine } from "@/engine/engine";
import { FakePorts } from "@/engine/fake-ports";
import { MemStore } from "@/engine/mem-store";
import { PgStore } from "@/engine/pg-store";
import type { Store } from "@/engine/store";
import { setupOffer } from "@/engine/testkit";
import { freshEngineDb } from "@/test/engine-db";
import { FakeHttp } from "../framework/fake-http";
import { Hub } from "../framework/hub";
import { MemConnectorState } from "../framework/mem-state";
import { PgConnectorState } from "../framework/pg-state";
import type { ConnectorState, GhlToken } from "../framework/state";
import type { ConnectorTask, Enqueue, J } from "../framework/types";
import { connectorPorts, connectorTasks } from "../registry";
import { FakeGhl } from "./fake-ghl";

/**
 * A connector test bench: an offer on the engine (memory, or Postgres when asked and DATABASE_URL is set), the
 * connectors' state, the fake HTTP layer with a stateful fake GHL on it, a fake job queue that runs jobs at their
 * time on the fake clock, and the engine fed by the connectors. Nothing leaves the process.
 */

export type QueuedJob = { task: ConnectorTask; payload: J; runAt: Date; jobKey?: string };

export class FakeQueue {
  jobs: QueuedJob[] = [];
  ran: QueuedJob[] = [];
  constructor(private now: () => Date) {}
  enqueue: Enqueue = async (task, payload, opts) => {
    const job = { task, payload, runAt: opts?.runAt ?? this.now(), ...(opts?.jobKey ? { jobKey: opts.jobKey } : {}) };
    const i = opts?.jobKey ? this.jobs.findIndex((j) => j.jobKey === opts.jobKey) : -1;
    if (i >= 0) this.jobs[i] = job; else this.jobs.push(job);
  };
  /** The next job due, earliest first. */
  next(): QueuedJob | undefined { return [...this.jobs].sort((a, b) => a.runAt.getTime() - b.runAt.getTime())[0]; }
  take(job: QueuedJob) { this.jobs.splice(this.jobs.indexOf(job), 1); this.ran.push(job); }
}

export type Kit = Awaited<ReturnType<typeof connectorKit>>;

export async function connectorKit(o: { pg?: boolean; start?: string; zone?: string; offers?: number } = {}) {
  process.env.TOKEN_KEY ??= crypto.randomBytes(32).toString("base64");
  const http = new FakeHttp(o.start ?? "2026-10-26T14:00:00Z");
  const ghl = new FakeGhl(http);
  let store: Store, state: ConnectorState;
  if (o.pg) {
    await freshEngineDb();
    await db().execute(sql`truncate inbox, ghl_connections restart identity`);
    store = new PgStore(db()); state = new PgConnectorState(db());
  } else { store = new MemStore(); state = new MemConnectorState(); }
  const queue = new FakeQueue(http.now);
  const hub = new Hub({ state, store, http: http.deps(), enqueue: queue.enqueue, env: { ghlClientId: "cid", ghlClientSecret: "csecret" } });
  const fake = new FakePorts(http.now);
  const engine = new Engine({ store, ports: connectorPorts(hub, { slack: fake.ports().slack, http: fake.ports().http }), now: http.now, random: () => 0.5 });
  const ingested: J[] = [];
  hub.setIngest(async (f) => { const r = await engine.ingest(f); if (!r.duplicate) ingested.push(f as unknown as J); return { duplicate: r.duplicate }; });
  const offers: string[] = [];
  for (let i = 0; i < (o.offers ?? 1); i++) offers.push(await setupOffer(store, { slug: `offer${i + 1}`, zone: o.zone ?? "America/New_York" }));
  const tasks = connectorTasks(hub);

  const kit = {
    http, ghl, store, state, hub, queue, engine, ingested, offerId: offers[0]!, offers,
    /** Runs every job due by `until` (default now) at its own time, moving the fake clock to it. */
    async runJobs(until?: Date, max = 100_000): Promise<number> {
      let n = 0;
      for (; n < max; n++) {
        const j = queue.next();
        const limit = until ?? http.now();
        if (!j || j.runAt > limit) break;
        if (j.runAt > http.now()) http.setNow(j.runAt);
        queue.take(j);
        await tasks[j.task](j.payload);
      }
      if (until && http.now() < until) http.setNow(until);
      return n;
    },
    /** A GHL connection for an offer on the four GHL ports: OAuth (the app's tokens) or a private token. */
    async connectGhl(x: { offerId?: string; locationId?: string; mode?: "oauth" | "pit"; token?: string; expiresInMs?: number; config?: J } = {}) {
      const offerId = x.offerId ?? offers[0]!, loc = x.locationId ?? "LOC1", mode = x.mode ?? "oauth";
      const token = x.token ?? `${mode}-token-${loc}`;
      ghl.addToken(token, loc);
      if (mode === "oauth") {
        ghl.addRefresh(`refresh-${loc}`, loc);
        await setGhlToken(state, { locationId: loc, companyId: "CO1", accessToken: token, refreshToken: `refresh-${loc}`, expiresAt: new Date(http.now().getTime() + (x.expiresInMs ?? 20 * 3_600_000)), scopes: "contacts.write", status: "connected" });
      }
      const conns = [];
      for (const port of ["crm", "messaging", "scheduling", "esign"]) {
        conns.push(await state.upsertConnection({ offerId, port, provider: "ghl", mode, externalId: loc, config: x.config ?? {}, ...(mode === "pit" && port === "crm" ? { credentials: { token } } : mode === "pit" ? { credentials: { token } } : {}) }));
      }
      return conns[0]!;
    },
  };
  return kit;
}

/** Puts a location's tokens in place, as the OAuth callback does. */
export async function setGhlToken(state: ConnectorState, t: GhlToken): Promise<void> {
  if (state instanceof MemConnectorState) { state.tokens.set(t.locationId, structuredClone(t)); return; }
  const { seal } = await import("@/lib/secrets");
  const { ghlConnections } = await import("@/db/schema");
  const row = { locationId: t.locationId, companyId: t.companyId, accessTokenEnc: seal(t.accessToken), refreshTokenEnc: seal(t.refreshToken), expiresAt: t.expiresAt, scopes: t.scopes, status: t.status };
  await db().insert(ghlConnections).values(row).onConflictDoUpdate({ target: ghlConnections.locationId, set: row });
}

/** The facts the engine holds for an offer, oldest first: type, dedupe key and payload. */
export async function factsOf(store: Store, offerId: string): Promise<{ type: string; dedupeKey: string; contactId: string | null; appointmentId: string | null; payload: J; source: string }[]> {
  const rows = await store.tx((tx) => tx.events({ offerId, order: "asc" }));
  return rows.sort((a, b) => a.id - b.id).map((e) => ({ type: e.type, dedupeKey: e.dedupeKey, contactId: e.contactId, appointmentId: e.appointmentId, payload: e.payload as J, source: e.source }));
}
