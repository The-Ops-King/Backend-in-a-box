/**
 * The ports: one small typed interface per kind of vendor, as the blueprint's port table has them. Workflows name a
 * port's verbs, never a vendor. Only the outbox dispatcher calls a port, never inside a database transaction, and
 * always with the outbox row's idempotency key.
 *
 * A port says how a call failed by throwing a PortError with its class:
 * - transient: try again later (429, 5xx, a timeout before anything was sent);
 * - auth: the connection's token is wrong or lost a scope; the connection pauses until a person fixes it;
 * - permanent: the vendor refused this request for good (400, 404, 422);
 * - ambiguous: the vendor may or may not have done it (a timeout after sending). Never retried.
 */

export type FailureClass = "transient" | "auth" | "permanent" | "ambiguous";

export class PortError extends Error {
  constructor(public failure: FailureClass, message: string, public status?: number) {
    super(message);
    this.name = "PortError";
  }
}

/** Who a call is for and the key that makes it once: the vendor is given the key wherever it takes one. */
export type CallContext = { offerId: string; idempotencyKey: string };

export type CrmContact = {
  id: string;
  phone: string | null;
  email: string | null;
  timezone?: string | null;
  /** Do not disturb, per channel or everything, as the CRM holds it now. */
  dnd: { sms?: boolean; email?: boolean; all?: boolean };
};

type Params = Record<string, unknown>;

export interface CrmPort {
  /** The contact as the CRM holds it right now: the delivery gate reads addresses and DND from here at send time. */
  getContact(c: CallContext, contactId: string): Promise<CrmContact | null>;
  findOrCreateContact(c: CallContext, contactId: string | null, p: Params): Promise<{ id: string; action: "found" | "created" }>;
  updateContact(c: CallContext, contactId: string, p: Params): Promise<void>;
  addTags(c: CallContext, contactId: string, tags: string[]): Promise<void>;
  removeTags(c: CallContext, contactId: string, tags: string[]): Promise<void>;
  markDnd(c: CallContext, contactId: string, channel: "sms" | "email" | "all"): Promise<void>;
  moveDeal(c: CallContext, contactId: string, p: Params): Promise<{ id: string } | null>;
  setDealStatus(c: CallContext, contactId: string, p: Params): Promise<void>;
  updateDeal(c: CallContext, contactId: string, p: Params): Promise<void>;
  createTask(c: CallContext, contactId: string, p: Params): Promise<{ id: string }>;
  addNote(c: CallContext, contactId: string, body: string): Promise<void>;
  upsertRecord(c: CallContext, p: Params): Promise<{ id: string }>;
  relateRecords(c: CallContext, p: Params): Promise<void>;
}

export interface MessagingPort {
  sendSms(c: CallContext, m: { contactId: string; to: string | null; body: string }): Promise<{ id: string }>;
  sendEmail(c: CallContext, m: { contactId: string; to: string | null; subject: string; body: string }): Promise<{ id: string }>;
}

export interface SchedulingPort {
  cancel(c: CallContext, p: { appointmentId: string; reason?: string }): Promise<void>;
  setStatus(c: CallContext, p: { appointmentId: string; status: string }): Promise<void>;
}

export interface EsignPort {
  send(c: CallContext, p: { contactId: string; template: string; sender?: string; name?: string }): Promise<{ id: string }>;
  void(c: CallContext, p: { agreementId: string }): Promise<void>;
}

export interface AiPort {
  classify(c: CallContext, p: { input: string; context?: string; prompt: string; options: string[]; threshold: number; ambiguityMax?: number; unclear: string }): Promise<{ value: string; confidence: number; guesses: { value: string; confidence: number }[] }>;
  summarize(c: CallContext, p: { prompt: string; input: string; format: "json" | "text"; maxTokens?: number }): Promise<unknown>;
}

export type SlackButton = { action: string; value: string; style?: string; label: string };
/**
 * `as` and `icons`: the persona the post is made under (its name; one icon, or several for the app to choose from).
 * `post` to a DM conversation's channel with `threadTs` replies in a DM's thread. `update` rewrites an earlier post in place.
 */
export interface SlackPort {
  post(c: CallContext, p: { channel: string; text: string; as?: string; icons?: string[]; threadTs?: string; buttons?: SlackButton[]; answers?: unknown; sandbox: boolean }): Promise<{ channel: string; ts: string }>;
  dm(c: CallContext, p: { user: string; text: string; as?: string; icons?: string[]; buttons?: SlackButton[]; answers?: unknown }): Promise<{ channel: string; ts: string } | null>;
  react(c: CallContext, p: { channel: string; ts: string; emojis: string[] }): Promise<void>;
  unreact(c: CallContext, p: { channel: string; ts: string; emojis: string[] }): Promise<void>;
  update(c: CallContext, p: { channel: string; ts: string; text: string; buttons?: SlackButton[] }): Promise<void>;
}

export interface HttpPort {
  request(c: CallContext, p: { url: string; method: string; headers?: Record<string, string>; body?: unknown }): Promise<{ status: number; body: unknown }>;
}

export type Ports = { crm: CrmPort; messaging: MessagingPort; scheduling: SchedulingPort; esign: EsignPort; ai: AiPort; slack: SlackPort; http: HttpPort };
export type PortName = keyof Ports;

/** Which port carries an outbox row's kind. */
export function portOf(kind: string): PortName {
  if (kind === "message.sms" || kind === "message.email") return "messaging";
  if (kind === "message.slack" || kind === "slack.ask" || kind.startsWith("slack.")) return "slack";
  const p = kind.split(".")[0];
  if (p === "crm" || p === "scheduling" || p === "esign" || p === "ai" || p === "http") return p;
  throw new Error(`no port carries ${kind}`);
}
