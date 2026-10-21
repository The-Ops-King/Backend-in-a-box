import { type CallContext, type CrmContact, type FailureClass, PortError, type PortName, type Ports } from "./ports";

/**
 * In-memory ports for tests and the simulator. Every call is recorded with its idempotency key; a failure can be
 * queued for the next call(s) to a port (or one of its methods). Nothing here reaches a vendor.
 */

export type FakeCall = { port: PortName; method: string; key: string; args: unknown; at: Date; ok: boolean; failure?: FailureClass };
type Failure = { port: PortName; method?: string; failure: FailureClass; times: number; message: string; status?: number };

export class FakePorts {
  calls: FakeCall[] = [];
  contacts = new Map<string, CrmContact>();
  /** How ai.classify answers: by the input, or the first option with full confidence. */
  classify: (p: { input: string; options: string[] }) => { value: string; confidence: number } = (p) => ({ value: p.options[0]!, confidence: 1 });
  summarize: (p: { input: string }) => unknown = () => ({});
  private failures: Failure[] = [];
  private n = 0;

  constructor(private clock: () => Date = () => new Date()) {}

  /** The next `times` calls to that port (and method, when given) fail with that class. */
  failNext(f: { port: PortName; method?: string; failure: FailureClass; times?: number; message?: string; status?: number }) {
    this.failures.push({ ...f, times: f.times ?? 1, message: f.message ?? `${f.port} ${f.failure} failure` });
  }

  /** Calls that did something (not reads), in order. */
  effects(port?: PortName): FakeCall[] { return this.calls.filter((c) => c.ok && c.method !== "getContact" && (!port || c.port === port)); }

  /** Idempotency keys a vendor saw succeed more than once: always empty when the outbox does its job. */
  duplicates(): string[] {
    const seen = new Map<string, number>();
    for (const c of this.effects()) seen.set(`${c.port}.${c.method}:${c.key}`, (seen.get(`${c.port}.${c.method}:${c.key}`) ?? 0) + 1);
    return [...seen].filter(([, n]) => n > 1).map(([k]) => k);
  }

  private async call<T>(port: PortName, method: string, c: CallContext, args: unknown, answer: () => T): Promise<T> {
    const i = this.failures.findIndex((f) => f.port === port && (!f.method || f.method === method));
    if (i >= 0) {
      const f = this.failures[i]!;
      if (--f.times <= 0) this.failures.splice(i, 1);
      this.calls.push({ port, method, key: c.idempotencyKey, args, at: this.clock(), ok: false, failure: f.failure });
      throw new PortError(f.failure, f.message, f.status);
    }
    this.calls.push({ port, method, key: c.idempotencyKey, args, at: this.clock(), ok: true });
    return answer();
  }
  private id(prefix: string) { return `${prefix}-${++this.n}`; }

  ports(): Ports {
    const call = this.call.bind(this);
    const contact = (id: string) => this.contacts.get(id) ?? null;
    return {
      crm: {
        getContact: (c, id) => call("crm", "getContact", c, { id }, () => (contact(id) ? structuredClone(contact(id)!) : null)),
        findOrCreateContact: (c, id, p) => call("crm", "findOrCreateContact", c, { id, ...p }, () => ({ id: id ?? this.id("contact"), action: id ? ("found" as const) : ("created" as const) })),
        updateContact: (c, id, p) => call("crm", "updateContact", c, { id, ...p }, () => undefined),
        addTags: (c, id, tags) => call("crm", "addTags", c, { id, tags }, () => undefined),
        removeTags: (c, id, tags) => call("crm", "removeTags", c, { id, tags }, () => undefined),
        markDnd: (c, id, channel) => call("crm", "markDnd", c, { id, channel }, () => {
          const k = contact(id);
          if (k) k.dnd = { ...k.dnd, [channel]: true };
        }),
        moveDeal: (c, id, p) => call("crm", "moveDeal", c, { id, ...p }, () => ({ id: this.id("deal") })),
        setDealStatus: (c, id, p) => call("crm", "setDealStatus", c, { id, ...p }, () => undefined),
        updateDeal: (c, id, p) => call("crm", "updateDeal", c, { id, ...p }, () => undefined),
        createTask: (c, id, p) => call("crm", "createTask", c, { id, ...p }, () => ({ id: this.id("task") })),
        addNote: (c, id, body) => call("crm", "addNote", c, { id, body }, () => undefined),
        upsertRecord: (c, p) => call("crm", "upsertRecord", c, p, () => ({ id: this.id("record") })),
        relateRecords: (c, p) => call("crm", "relateRecords", c, p, () => undefined),
      },
      messaging: {
        sendSms: (c, m) => call("messaging", "sendSms", c, m, () => ({ id: this.id("sms") })),
        sendEmail: (c, m) => call("messaging", "sendEmail", c, m, () => ({ id: this.id("email") })),
      },
      scheduling: {
        cancel: (c, p) => call("scheduling", "cancel", c, p, () => undefined),
        setStatus: (c, p) => call("scheduling", "setStatus", c, p, () => undefined),
      },
      esign: {
        send: (c, p) => call("esign", "send", c, p, () => ({ id: this.id("agreement") })),
        void: (c, p) => call("esign", "void", c, p, () => undefined),
      },
      ai: {
        classify: (c, p) => call("ai", "classify", c, p, () => ({ ...this.classify(p), guesses: [] })),
        summarize: (c, p) => call("ai", "summarize", c, p, () => this.summarize(p)),
      },
      slack: {
        post: (c, p) => call("slack", "post", c, p, () => ({ channel: p.channel, ts: `${1000 + ++this.n}.000100` })),
        dm: (c, p) => call("slack", "dm", c, p, () => (p.user ? { channel: `D-${p.user}`, ts: `${1000 + ++this.n}.000100` } : null)),
        react: (c, p) => call("slack", "react", c, p, () => undefined),
        unreact: (c, p) => call("slack", "unreact", c, p, () => undefined),
        update: (c, p) => call("slack", "update", c, p, () => undefined),
      },
      http: { request: (c, p) => call("http", "request", c, p, () => ({ status: 200, body: {} })) },
    };
  }
}
