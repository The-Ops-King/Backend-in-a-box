import type { TaskList } from "graphile-worker";
import { type AiPort, type CrmPort, type EsignPort, type MessagingPort, PortError, type Ports, type SchedulingPort } from "@/engine/ports";
import type { Hub } from "./framework/hub";
import type { CanonicalFact, Connection, ConnectorTask, J, Normalized } from "./framework/types";
import { lookForTranscript } from "./framework/transcripts";
import { ghlPortsFor } from "./ghl";
import { checkAgreements } from "./ghl/agreements";
import { refreshDue } from "./ghl/auth";
import { normalizeGhl } from "./ghl/normalize";
import { pollGhl, reconcileGhl } from "./ghl/poll";
import { normalizeWhop, reconcileWhop } from "./whop";
import { normalizeFathom, reconcileFathom } from "./fathom";
import { normalizeTypeform } from "./typeform";
import { calendlyScheduling, normalizeCalendly, pollCalendly } from "./calendly";
import { normalizeGeneric } from "./generic";
import { jevAi } from "./ai/jev";
import { anthropicAi } from "./ai/anthropic";

/**
 * Where the engine's ports meet the connectors: each call is routed by the offer's connection for that port (or verb)
 * to its provider, so a workflow names `crm.add_tag`, never GHL. Slack (the platform app) and outbound HTTP are not
 * connectors and are passed through.
 */

async function connected(hub: Hub, offerId: string, port: string): Promise<Connection> {
  const c = await hub.connectionFor(offerId, port);
  if (!c) throw new PortError("permanent", `the offer has no ${port.split(".")[0]} connection`);
  if (c.status !== "connected") throw new PortError("auth", `the offer's ${c.provider} connection is ${c.status.replace("_", " ")}`);
  return c;
}

const unsupported = (provider: string, port: string) => new PortError("permanent", `${provider} cannot serve the ${port} port`);

async function crmOf(hub: Hub, offerId: string): Promise<CrmPort> {
  const c = await connected(hub, offerId, "crm");
  if (c.provider === "ghl") return (await ghlPortsFor(hub, c)).crm;
  throw unsupported(c.provider, "crm");
}
async function messagingOf(hub: Hub, offerId: string): Promise<MessagingPort> {
  const c = await connected(hub, offerId, "messaging");
  if (c.provider === "ghl") return (await ghlPortsFor(hub, c)).messaging;
  throw unsupported(c.provider, "messaging");
}
async function schedulingOf(hub: Hub, offerId: string): Promise<SchedulingPort> {
  const c = await connected(hub, offerId, "scheduling");
  if (c.provider === "ghl") return (await ghlPortsFor(hub, c)).scheduling;
  if (c.provider === "calendly") return calendlyScheduling(hub, c);
  throw unsupported(c.provider, "scheduling");
}
async function esignOf(hub: Hub, offerId: string): Promise<EsignPort> {
  const c = await connected(hub, offerId, "esign");
  if (c.provider === "ghl") return (await ghlPortsFor(hub, c)).esign;
  throw unsupported(c.provider, "esign");
}
async function aiOf<V extends "classify" | "summarize">(hub: Hub, offerId: string, verb: V): Promise<Pick<AiPort, V>> {
  const c = await connected(hub, offerId, `ai.${verb}`);
  if (verb === "classify" && c.provider === "jev") return jevAi(hub, c) as unknown as Pick<AiPort, V>;
  if (verb === "summarize" && c.provider === "anthropic") return anthropicAi(hub, c) as unknown as Pick<AiPort, V>;
  throw unsupported(c.provider, `ai.${verb}`);
}

/** The engine's ports, served by the connectors. */
export function connectorPorts(hub: Hub, pass: Pick<Ports, "slack" | "http">): Ports {
  return {
    crm: {
      getContact: async (c, id) => (await crmOf(hub, c.offerId)).getContact(c, id),
      findOrCreateContact: async (c, id, p) => (await crmOf(hub, c.offerId)).findOrCreateContact(c, id, p),
      updateContact: async (c, id, p) => (await crmOf(hub, c.offerId)).updateContact(c, id, p),
      addTags: async (c, id, t) => (await crmOf(hub, c.offerId)).addTags(c, id, t),
      removeTags: async (c, id, t) => (await crmOf(hub, c.offerId)).removeTags(c, id, t),
      markDnd: async (c, id, ch) => (await crmOf(hub, c.offerId)).markDnd(c, id, ch),
      moveDeal: async (c, id, p) => (await crmOf(hub, c.offerId)).moveDeal(c, id, p),
      setDealStatus: async (c, id, p) => (await crmOf(hub, c.offerId)).setDealStatus(c, id, p),
      updateDeal: async (c, id, p) => (await crmOf(hub, c.offerId)).updateDeal(c, id, p),
      createTask: async (c, id, p) => (await crmOf(hub, c.offerId)).createTask(c, id, p),
      addNote: async (c, id, b) => (await crmOf(hub, c.offerId)).addNote(c, id, b),
      upsertRecord: async (c, p) => (await crmOf(hub, c.offerId)).upsertRecord(c, p),
      relateRecords: async (c, p) => (await crmOf(hub, c.offerId)).relateRecords(c, p),
    },
    messaging: {
      sendSms: async (c, m) => (await messagingOf(hub, c.offerId)).sendSms(c, m),
      sendEmail: async (c, m) => (await messagingOf(hub, c.offerId)).sendEmail(c, m),
    },
    scheduling: {
      cancel: async (c, p) => (await schedulingOf(hub, c.offerId)).cancel(c, p),
      setStatus: async (c, p) => (await schedulingOf(hub, c.offerId)).setStatus(c, p),
    },
    esign: {
      send: async (c, p) => (await esignOf(hub, c.offerId)).send(c, p),
      void: async (c, p) => (await esignOf(hub, c.offerId)).void(c, p),
    },
    ai: {
      classify: async (c, p) => (await aiOf(hub, c.offerId, "classify")).classify(c, p),
      summarize: async (c, p) => (await aiOf(hub, c.offerId, "summarize")).summarize(c, p),
    },
    slack: pass.slack,
    http: pass.http,
  };
}

// ---- inbound ------------------------------------------------------------------------------------------------------------

/**
 * Reads one inbox delivery through its connector's normalizer and records its facts. Run as a job after the door has
 * answered. A delivery is read once: its outcome is kept on the row. A normalizer that cannot finish (the CRM is down)
 * leaves the row unread, to be read again; what it learned is written only after its facts are recorded.
 */
export async function processDelivery(hub: Hub, id: number): Promise<string> {
  const d = await hub.state.delivery(id);
  if (!d) return "no such delivery";
  if (d.processedAt) return "already read";
  let body: J;
  try { body = JSON.parse(d.body) as J; } catch { await hub.state.markDelivery(id, { outcome: "not JSON", at: hub.now() }); return "not JSON"; }
  let n: Normalized;
  let offerId: string | null = d.offerId;
  if (d.source === "ghl") {
    n = await normalizeGhl(hub, body, { source: "ghl", receivedAt: d.receivedAt });
  } else {
    const conn = d.connectionId ? await hub.state.connectionById(d.connectionId) : undefined;
    if (!conn) { await hub.state.markDelivery(id, { outcome: "its connection is gone", at: hub.now() }); return "its connection is gone"; }
    offerId = conn.offerId;
    n = d.source === "whop" ? await normalizeWhop(hub, conn, body)
      : d.source === "fathom" ? await normalizeFathom(hub, conn, body)
        : d.source === "typeform" ? await normalizeTypeform(hub, conn, body)
          : d.source === "calendly" ? await normalizeCalendly(hub, conn, body)
            : d.source === "generic" ? await normalizeGeneric(hub, conn, body, d.deliveryId)
              : { facts: [], outcome: `no normalizer for ${d.source}` };
  }
  let fresh = 0;
  for (const f of n.facts) if (!(await hub.ingest(f)).duplicate) fresh++;
  await n.commit?.();
  const outcome = n.facts.length ? `${n.facts.length} facts (${fresh} new)` : n.outcome;
  await hub.state.markDelivery(id, { outcome, offerId: offerId ?? n.facts[0]?.offerId ?? null, at: hub.now() });
  return outcome;
}

/** The nightly reconcile for one connection (by provider), and when it runs next. */
export async function reconcile(hub: Hub, connectionId: string): Promise<{ facts: number; missed: number }> {
  const conn = await hub.state.connectionById(connectionId);
  if (!conn || conn.status !== "connected") return { facts: 0, missed: 0 };
  const now = hub.now();
  const from = new Date(now.getTime() - 26 * 3_600_000);
  let out = { facts: 0, missed: 0 };
  const record = async (facts: CanonicalFact[]) => {
    let missed = 0;
    for (const f of facts) if (!(await hub.ingest(f)).duplicate) missed++;
    if (missed > 5) await hub.alert({ offerId: conn.offerId, key: `reconcile:${conn.provider}`, kind: "reconcile_missed", message: `The nightly ${conn.provider} check found ${missed} things from the last 26 hours that never arrived as webhooks. They are recorded now; the ${conn.provider} webhooks may be failing.`, detail: { missed } });
    return { facts: facts.length, missed };
  };
  if (conn.provider === "ghl") out = await reconcileGhl(hub, conn);
  else if (conn.provider === "whop") out = await record((await reconcileWhop(hub, conn, from, now)).facts);
  else if (conn.provider === "fathom") out = await record((await reconcileFathom(hub, conn, from, now)).facts);
  const next = new Date(now.getTime() + 86_400_000);
  await hub.enqueue("connector_reconcile", { connectionId }, { runAt: next, jobKey: `reconcile:${connectionId}` });
  return out;
}

/** The connectors' jobs, by task name, for the worker (graphile-worker) and for tests' fake queue. */
export function connectorTasks(hub: Hub): Record<ConnectorTask, (payload: J) => Promise<unknown>> {
  return {
    connector_inbox: (p) => processDelivery(hub, Number(p.id)),
    ghl_refresh: () => refreshDue(hub),
    ghl_agreements: (p) => checkAgreements(hub, String(p.locationId)),
    ghl_poll: async (p) => { const c = await hub.state.connectionById(String(p.connectionId)); return c ? pollGhl(hub, c) : undefined; },
    calendly_poll: async (p) => { const c = await hub.state.connectionById(String(p.connectionId)); return c ? pollCalendly(hub, c) : undefined; },
    connector_reconcile: (p) => reconcile(hub, String(p.connectionId)),
    transcript_wait: (p) => lookForTranscript(hub, Number(p.id)),
  };
}

export const connectorTaskList = (hub: Hub): TaskList =>
  Object.fromEntries(Object.entries(connectorTasks(hub)).map(([k, fn]) => [k, async (payload: unknown) => { await fn((payload ?? {}) as J); }]));

/**
 * Starts what a connection runs on its own: the reconcile every night, the private-token poll, Calendly's free-plan
 * poll, the token refresh. Called when a connection is made and when the worker starts.
 */
export async function startConnection(hub: Hub, conn: Connection): Promise<void> {
  const now = hub.now();
  if (["ghl", "whop", "fathom"].includes(conn.provider)) await hub.enqueue("connector_reconcile", { connectionId: conn.id }, { runAt: new Date(now.getTime() + 86_400_000), jobKey: `reconcile:${conn.id}` });
  if (conn.provider === "ghl" && conn.mode === "pit") await hub.enqueue("ghl_poll", { connectionId: conn.id }, { runAt: now, jobKey: `ghl_poll:${conn.id}` });
  if (conn.provider === "ghl" && conn.mode !== "pit") await hub.enqueue("ghl_refresh", {}, { runAt: now, jobKey: "ghl_refresh" });
  if (conn.provider === "calendly" && conn.mode === "polling") await hub.enqueue("calendly_poll", { connectionId: conn.id }, { runAt: now, jobKey: `calendly_poll:${conn.id}` });
}
