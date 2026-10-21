import type { IncomingEvent } from "@/engine/engine";
import type { ConnectionStatus } from "@/engine/types";

/**
 * The connector framework's words. A connector is one vendor behind one or more ports: outbound, it implements the
 * port's verbs (src/engine/ports.ts); inbound, its normalizer turns what the vendor sent into canonical facts, each with
 * a dedupe key that is the same however the fact arrives (a webhook, a poll, the nightly reconcile). Nothing above a
 * connector names a vendor, a provider field id or an auth mode.
 */

export type Provider = "ghl" | "whop" | "fathom" | "typeform" | "calendly" | "generic" | "jev" | "anthropic";
export const PROVIDERS: readonly Provider[] = ["ghl", "whop", "fathom", "typeform", "calendly", "generic", "jev", "anthropic"];

/** Ports a connection serves. The engine calls the first five; the last three only bring facts in. */
export type ConnectorPort = "crm" | "messaging" | "scheduling" | "esign" | "ai" | "payments" | "recording" | "forms";

export type J = Record<string, unknown>;

/** One offer's connection on one port, credentials opened. */
export type Connection = {
  id: string;
  offerId: string;
  /** The port, or one verb of it ("ai.classify") when two providers share a port. */
  port: string;
  provider: Provider;
  /** GHL: oauth | pit. Calendly: webhook | polling. Others: null. */
  mode: string | null;
  status: ConnectionStatus;
  /** The vendor's account it is: a GHL location, a Calendly organization uri, a Whop company. */
  externalId: string | null;
  /** What is not secret: a generic door's field map, polling, Calendly's free-plan flag, the AI model id. */
  config: J;
  /** Opened at the moment of use; never logged, never stored anywhere but sealed on the row. */
  credentials: Record<string, string>;
};

/** A field map row: a canonical field and the provider's own field it is, on one object. */
export type FieldMapRow = {
  offerId: string;
  provider: Provider;
  object: string;
  canonicalField: string;
  providerFieldId: string;
  valueType: "text" | "date" | "datetime" | "number" | "money" | "options" | "checkbox" | "id";
  options: J;
};

/** A canonical fact a normalizer emits: what the engine ingests, with the offer it belongs to. */
export type CanonicalFact = IncomingEvent;

/** What one delivery came to: the facts it is, or why it is none. */
export type Normalized = {
  facts: CanonicalFact[];
  /** "facts", or why nothing: "ignored <type>", "stale", "unknown location", ... */
  outcome: string;
  /**
   * What the normalizer learned (the entity's new state, the echoes it matched), written only after its facts are
   * recorded: a delivery read again after a failure finds the same facts, never fewer.
   */
  commit?: () => Promise<void>;
};

/** A delivery as it sits in the inbox (raw body and headers), with the door it came through. */
export type Delivery = {
  id: number;
  source: string;
  deliveryId: string;
  eventType: string | null;
  locationId: string | null;
  connectionId: string | null;
  offerId: string | null;
  headers: Record<string, string>;
  body: string;
  receivedAt: Date;
  processedAt?: Date | null;
};

/** How a connector's job is queued: graphile-worker's add_job in production, a fake queue in tests. */
export type ConnectorTask =
  | "connector_inbox" | "ghl_refresh" | "ghl_agreements" | "ghl_poll" | "connector_reconcile" | "transcript_wait" | "calendly_poll";
export type Enqueue = (task: ConnectorTask, payload: J, opts?: { runAt?: Date; jobKey?: string }) => Promise<void>;
