import type { FakeHttp } from "../framework/fake-http";
import type { J } from "../framework/types";

/**
 * Small fakes of the other vendors' APIs, on the fake HTTP layer: what each connector reads or writes, in the shapes v1
 * used against the real ones (Calendly, Jev) or the vendor documents (Anthropic's Messages API, Fathom, Whop).
 */

export class FakeCalendly {
  events = new Map<string, J>();
  invitees = new Map<string, J[]>();
  noShows: string[] = [];
  constructor(http: FakeHttp, token = "cal-token") {
    const auth = (h: Record<string, string>) => h.authorization === `Bearer ${token}`;
    http.on("POST", /^\/scheduled_events\/([^/]+)\/cancellation$/, (req) => {
      if (!auth(req.headers)) return { status: 401, body: { title: "Unauthenticated" } };
      const id = req.path.split("/")[2]!;
      const e = this.events.get(id);
      if (!e) return { status: 404, body: {} };
      if (e.status === "canceled") return { status: 403, body: { title: "Permission Denied", message: "Event is already canceled" } };
      e.status = "canceled";
      return { status: 201, body: { resource: { canceled_by: "host", reason: (req.body as J).reason } } };
    });
    http.on("GET", /^\/scheduled_events\/([^/]+)$/, (req) => { const e = this.events.get(req.path.split("/")[2]!); return e ? { status: 200, body: { resource: e } } : { status: 404, body: {} }; });
    http.on("GET", /^\/scheduled_events\/([^/]+)\/invitees$/, (req) => ({ status: 200, body: { collection: this.invitees.get(req.path.split("/")[2]!) ?? [], pagination: { next_page: null } } }));
    http.on("GET", "/scheduled_events", () => ({ status: 200, body: { collection: [...this.events.values()], pagination: { next_page: null } } }));
    http.on("POST", "/invitee_no_shows", (req) => { this.noShows.push(String((req.body as J).invitee)); return { status: 201, body: { resource: { uri: "https://api.calendly.com/invitee_no_shows/ns1" } } }; });
  }
  /** A booking as Calendly holds it: a scheduled event and its invitee. */
  book(id: string, x: { email: string; name?: string; start: string; eventType?: string; setter?: string; at: string }): { event: J; invitee: J } {
    const uri = `https://api.calendly.com/scheduled_events/${id}`;
    const event = { uri, name: "Strategy call", status: "active", start_time: x.start, end_time: new Date(Date.parse(x.start) + 1_800_000).toISOString(), event_type: `https://api.calendly.com/event_types/${x.eventType ?? "ET1"}`, location: { type: "zoom", join_url: "https://zoom.us/j/123456789" }, event_memberships: [{ user: "https://api.calendly.com/users/U1", user_email: "luis@team.com", user_name: "Luis Ortega" }], created_at: x.at, updated_at: x.at };
    const invitee = { uri: `${uri}/invitees/inv-${id}`, email: x.email, name: x.name ?? "Ana Lopez", first_name: null, last_name: null, status: "active", timezone: "America/New_York", text_reminder_number: "+15550100001", rescheduled: false, old_invitee: null, new_invitee: null, questions_and_answers: x.setter ? [{ question: "Who set this call?", answer: x.setter }] : [], tracking: { utm_source: "fb" }, cancel_url: "https://calendly.com/cancellations/x", reschedule_url: "https://calendly.com/reschedulings/x", no_show: null, cancellation: null, created_at: x.at, updated_at: x.at };
    this.events.set(id, event);
    this.invitees.set(id, [invitee]);
    return { event, invitee };
  }
}

export class FakeJev {
  answer: (body: J) => { status?: number; body?: unknown } = (b) => {
    const options = Object.keys(((b.questions as J).answer as J).criteria as J);
    return { body: { answers: { answer: { choice: options[0], confidence: 0.93, probabilities: Object.fromEntries(options.map((o, i) => [o, i === 0 ? 0.93 : 0.07 / (options.length - 1)])) }, ambiguous: { noul: 0.1 } } } };
  };
  calls: J[] = [];
  constructor(http: FakeHttp, key = "jev-key") {
    http.on("POST", "/v1/systemone", (req) => {
      if (req.headers.authorization !== `Bearer ${key}`) return { status: 401, body: { error: "bad key" } };
      this.calls.push(req.body as J);
      return this.answer(req.body as J);
    });
  }
}

export class FakeAnthropic {
  reply: (body: J) => { status?: number; body?: unknown } = () => ({ body: message('{"summary":"A good call","next_step":"send agreement"}') });
  calls: { body: J; headers: Record<string, string> }[] = [];
  constructor(http: FakeHttp, key = "sk-ant-test") {
    http.on("POST", "/v1/messages", (req) => {
      if (req.headers["x-api-key"] !== key) return { status: 401, body: { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } } };
      this.calls.push({ body: req.body as J, headers: req.headers });
      return this.reply(req.body as J);
    });
  }
}

export const message = (text: string, stop: string = "end_turn", extra: J = {}): J => ({
  id: "msg_1", type: "message", role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text }], stop_reason: stop, stop_sequence: null,
  usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, ...extra,
});

export class FakeFathom {
  transcripts = new Map<string, J[]>();
  meetings: J[] = [];
  constructor(http: FakeHttp, key = "fathom-key") {
    http.on("GET", /^\/external\/v1\/recordings\/([^/]+)\/transcript$/, (req) => {
      if (req.headers["x-api-key"] !== key) return { status: 401, body: {} };
      const t = this.transcripts.get(req.path.split("/")[4]!);
      return t ? { status: 200, body: { transcript: t } } : { status: 404, body: {} };
    });
    http.on("GET", "/external/v1/meetings", () => ({ status: 200, body: { items: this.meetings, next_cursor: null } }));
  }
}

export class FakeWhop {
  payments: J[] = [];
  constructor(http: FakeHttp) {
    http.on("GET", "/api/v1/payments", () => ({ status: 200, body: { data: this.payments, page_info: { has_next_page: false } } }));
  }
}
