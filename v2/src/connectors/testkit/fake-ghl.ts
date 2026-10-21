import type { FakeHttp, FakeReply, FakeRequest } from "../framework/fake-http";
import type { J } from "../framework/types";

/**
 * A fake GHL on the fake HTTP layer, with state, that behaves as v1 found the real one behaves (ghl/02-api-facts.md):
 * - the Version header is checked per family (calendars and conversations 2021-04-15, the rest 2021-07-28);
 * - a default client user agent is refused by "Cloudflare" (403, error code 1010);
 * - 100 requests per 10 s per location, with X-RateLimit-Remaining; past it, 429;
 * - a contact PUT with `tags` replaces every tag; a DATE custom field keeps only the day;
 * - an appointment PUT without appointmentStatus resets it to confirmed; answers carry the misspelt appoinmentStatus too;
 * - the contact and opportunity searches lag writes by 10 s; reading by id does not;
 * - opportunities search refuses camelCase parameters (422);
 * - a record DELETE refuses locationId (422); relating two related records answers 400;
 * - refresh tokens are single-use: a spent one is refused (400 invalid_grant).
 * Payload shapes are v1's verified ones where v1 had them; the rest follow GHL's docs and are marked in the tests that
 * rely on them as unverified until the Phase 0 checks.
 */

type Contact = J & { id: string; locationId: string; tags: string[]; customFields: { id: string; value: unknown }[]; dateAdded: string; dateUpdated: string; indexedAt: number };
type Opp = J & { id: string; locationId: string; contactId: string; pipelineId: string; pipelineStageId: string; status: string; name: string; updatedAt: string; indexedAt: number };
type Appt = J & { id: string; locationId: string; calendarId: string; contactId: string; appointmentStatus: string; startTime: string; endTime: string; dateUpdated: string };
type Message = J & { id: string; conversationId: string; contactId: string; direction: string; messageType: string; dateAdded: string };
type Rec = { id: string; objectKey: string; properties: J; owners: string[] };

const LAG_MS = 10_000;

export class FakeGhl {
  contacts = new Map<string, Contact>();
  opps = new Map<string, Opp>();
  appts = new Map<string, Appt>();
  messages: Message[] = [];
  records = new Map<string, Rec>();
  relations = new Set<string>();
  documents: J[] = [];
  tasks: J[] = [];
  notes: J[] = [];
  transcripts = new Map<string, J[]>();
  calendars: { id: string; name: string }[] = [];
  /** Custom field ids that are DATE fields. */
  dateFields = new Set<string>();
  /** Valid access tokens, by token: the location they are for. */
  tokens = new Map<string, string>();
  /** Refresh tokens: unspent ones by token, with their location. */
  refreshTokens = new Map<string, string>();
  spentRefreshTokens = new Set<string>();
  refreshCalls = 0;
  /** The next refresh answer is lost after GHL spent the token (a timeout after sending). */
  loseNextRefresh = false;
  private n = 0;
  private hits = new Map<string, number[]>();

  constructor(private http: FakeHttp) { this.routes(); }

  private id(p: string) { return `${p}${++this.n}`; }
  private now() { return this.http.now().getTime(); }
  private iso() { return this.http.now().toISOString(); }

  addToken(token: string, locationId: string) { this.tokens.set(token, locationId); }
  addRefresh(token: string, locationId: string) { this.refreshTokens.set(token, locationId); }

  seedContact(c: Partial<Contact> & { locationId: string }): Contact {
    const id = c.id ?? this.id("ct");
    const row = { tags: [], customFields: [], dateAdded: this.iso(), dateUpdated: this.iso(), indexedAt: this.now() - LAG_MS, ...c, id } as Contact;
    this.contacts.set(id, row);
    return row;
  }
  seedAppointment(a: Partial<Appt> & { locationId: string; contactId: string; calendarId: string }): Appt {
    const id = a.id ?? this.id("ap");
    const row = { appointmentStatus: "confirmed", startTime: new Date(this.now() + 86_400_000).toISOString(), endTime: new Date(this.now() + 86_400_000 + 1_800_000).toISOString(), dateAdded: this.iso(), dateUpdated: this.iso(), ...a, id } as Appt;
    this.appts.set(id, row);
    return row;
  }
  seedOpp(o: Partial<Opp> & { locationId: string; contactId: string; pipelineId: string; pipelineStageId: string }): Opp {
    const id = o.id ?? this.id("op");
    const row = { status: "open", name: "Deal", updatedAt: this.iso(), indexedAt: this.now() - LAG_MS, ...o, id } as Opp;
    this.opps.set(id, row);
    return row;
  }

  /** A contact as GHL's API answers it (also the body of a Contact* webhook, with type and locationId). */
  contactJson(id: string): J {
    const { indexedAt: _i, ...c } = this.contacts.get(id)!;
    return structuredClone(c);
  }
  apptJson(id: string): J { const a = this.appts.get(id)!; return { ...structuredClone(a), appoinmentStatus: a.appointmentStatus }; }
  oppJson(id: string): J { const { indexedAt: _i, ...o } = this.opps.get(id)!; return structuredClone(o); }

  private reply(status: number, body: unknown, loc?: string): FakeReply {
    const headers: Record<string, string> = { "x-ratelimit-max": "100", "x-ratelimit-interval-milliseconds": "10000" };
    if (loc) headers["x-ratelimit-remaining"] = String(Math.max(0, 100 - (this.hits.get(loc) ?? []).length));
    return { status, body, headers };
  }

  /** Every request goes through the gate: user agent, token, version header, rate limit. */
  private gate(req: FakeRequest): { loc: string } | FakeReply {
    const ua = req.headers["user-agent"] ?? "";
    if (!ua || /^(node|undici|python|curl)/i.test(ua)) return { status: 403, body: "error code: 1010" };
    const token = (req.headers.authorization ?? "").replace(/^Bearer /, "");
    const loc = this.tokens.get(token);
    if (!loc) return { status: 401, body: { statusCode: 401, message: "Invalid JWT" } };
    const want = /^\/(calendars|conversations)(\/|$)/.test(req.path) ? "2021-04-15" : "2021-07-28";
    if (req.headers.version !== want) return { status: 400, body: { message: `version header must be ${want}` } };
    const recent = (this.hits.get(loc) ?? []).filter((t) => t > this.now() - 10_000);
    recent.push(this.now());
    this.hits.set(loc, recent);
    if (recent.length > 100) return this.reply(429, { message: "Too many requests" }, loc);
    return { loc };
  }

  private on(method: string, path: RegExp, fn: (req: FakeRequest, loc: string, m: RegExpMatchArray) => FakeReply) {
    this.http.on(method, path, (req) => { const g = this.gate(req); if (!("loc" in g)) return g; return fn(req, g.loc, req.path.match(path)!); });
  }

  private setFields(c: Contact, fields: { id: string; field_value?: unknown; value?: unknown }[]) {
    for (const f of fields) {
      let v = f.field_value ?? f.value;
      if (this.dateFields.has(f.id) && typeof v === "string") v = v.slice(0, 10);   // DATE fields keep the day only
      const i = c.customFields.findIndex((x) => x.id === f.id);
      if (i >= 0) c.customFields[i] = { id: f.id, value: v }; else c.customFields.push({ id: f.id, value: v });
    }
  }

  private routes() {
    const B = (r: FakeRequest) => (r.body ?? {}) as J;
    // ---- oauth ----
    this.http.on("POST", "/oauth/token", (req) => {
      this.refreshCalls++;
      const b = B(req);
      const rt = String(b.refresh_token ?? "");
      if (b.grant_type !== "refresh_token") return { status: 400, body: { error: "unsupported_grant_type" } };
      if (this.spentRefreshTokens.has(rt) || !this.refreshTokens.has(rt)) return { status: 400, body: { error: "invalid_grant", error_description: "Invalid refresh token" } };
      const loc = this.refreshTokens.get(rt)!;
      this.refreshTokens.delete(rt);
      this.spentRefreshTokens.add(rt);
      const access = this.id("at-"), refresh = this.id("rt-");
      this.addToken(access, loc);
      this.addRefresh(refresh, loc);
      if (this.loseNextRefresh) { this.loseNextRefresh = false; return { timeout: true, sent: true }; }
      return { status: 200, body: { access_token: access, refresh_token: refresh, expires_in: 86399, scope: "contacts.write", locationId: loc } };
    });
    // ---- contacts ----
    this.on("GET", /^\/contacts\/search\/duplicate$/, (req, loc) => {
      const email = req.query.get("email")?.toLowerCase(), phone = req.query.get("number");
      const c = [...this.contacts.values()].find((x) => x.locationId === loc && x.indexedAt <= this.now() - LAG_MS && ((email && String(x.email ?? "").toLowerCase() === email) || (phone && x.phone === phone)));
      return this.reply(200, { contact: c ? this.contactJson(c.id) : null }, loc);
    });
    this.on("POST", /^\/contacts\/search$/, (req, loc) => {
      const b = B(req);
      const gte = Date.parse(String((((b.filters as J[] | undefined)?.[0]?.value ?? {}) as J).gte ?? 0));
      const list = [...this.contacts.values()].filter((x) => x.locationId === loc && x.indexedAt <= this.now() - LAG_MS && Date.parse(x.dateUpdated) >= gte).sort((a, b2) => a.dateUpdated.localeCompare(b2.dateUpdated));
      return this.reply(200, { contacts: list.map((c) => this.contactJson(c.id)), total: list.length }, loc);
    });
    this.on("GET", /^\/contacts\/([^/]+)$/, (_req, loc, m) => {
      const c = this.contacts.get(m[1]!);
      return c && c.locationId === loc ? this.reply(200, { contact: this.contactJson(c.id) }, loc) : this.reply(404, { message: "Contact not found" }, loc);
    });
    this.on("POST", /^\/contacts\/$/, (req, loc) => {
      const b = B(req);
      const c = this.seedContact({ ...(b as J), locationId: loc, indexedAt: this.now(), tags: (b.tags as string[] | undefined) ?? [], customFields: [] } as unknown as Contact);
      this.setFields(c, (b.customFields as { id: string }[] | undefined) ?? []);
      return this.reply(201, { contact: { id: c.id } }, loc);
    });
    this.on("PUT", /^\/contacts\/([^/]+)$/, (req, loc, m) => {
      const c = this.contacts.get(m[1]!);
      if (!c) return this.reply(404, { message: "Contact not found" }, loc);
      const { customFields, tags, ...rest } = B(req);
      Object.assign(c, rest);
      if (Array.isArray(tags)) c.tags = tags as string[];   // a PUT's tags replace every tag
      if (Array.isArray(customFields)) this.setFields(c, customFields as { id: string }[]);
      c.dateUpdated = this.iso(); c.indexedAt = this.now();
      return this.reply(200, { succeded: true, contact: this.contactJson(c.id) }, loc);
    });
    this.on("POST", /^\/contacts\/([^/]+)\/tags$/, (req, loc, m) => {
      const c = this.contacts.get(m[1]!);
      if (!c) return this.reply(404, { message: "Contact not found" }, loc);
      for (const t of (B(req).tags as string[]) ?? []) if (!c.tags.includes(t)) c.tags.push(t);
      c.dateUpdated = this.iso(); c.indexedAt = this.now();
      return this.reply(201, { tags: c.tags }, loc);
    });
    this.on("DELETE", /^\/contacts\/([^/]+)\/tags$/, (req, loc, m) => {
      const c = this.contacts.get(m[1]!);
      if (!c) return this.reply(404, { message: "Contact not found" }, loc);
      const drop = (B(req).tags as string[]) ?? [];
      c.tags = c.tags.filter((t) => !drop.includes(t));
      c.dateUpdated = this.iso(); c.indexedAt = this.now();
      return this.reply(200, { tags: c.tags }, loc);
    });
    this.on("POST", /^\/contacts\/([^/]+)\/tasks$/, (req, loc, m) => { if (!this.contacts.has(m[1]!)) return this.reply(404, {}, loc); const t = { id: this.id("tk"), contactId: m[1], ...B(req) }; this.tasks.push(t); return this.reply(201, { task: t }, loc); });
    this.on("POST", /^\/contacts\/([^/]+)\/notes$/, (req, loc, m) => { if (!this.contacts.has(m[1]!)) return this.reply(404, {}, loc); const n = { id: this.id("nt"), contactId: m[1], ...B(req) }; this.notes.push(n); return this.reply(201, { note: n }, loc); });
    // ---- opportunities ----
    this.on("GET", /^\/opportunities\/search$/, (req, loc) => {
      if (req.query.has("locationId") || req.query.has("contactId")) return this.reply(422, { message: "property locationId should not exist" }, loc);
      const contact = req.query.get("contact_id"), pipeline = req.query.get("pipeline_id"), date = req.query.get("date");
      const since = date ? Date.UTC(Number(date.slice(6)), Number(date.slice(0, 2)) - 1, Number(date.slice(3, 5))) : 0;
      const list = [...this.opps.values()].filter((o) => o.locationId === loc && o.indexedAt <= this.now() - 3_000 && (!contact || o.contactId === contact) && (!pipeline || o.pipelineId === pipeline) && Date.parse(o.updatedAt) >= since);
      return this.reply(200, { opportunities: list.map((o) => this.oppJson(o.id)) }, loc);
    });
    this.on("GET", /^\/opportunities\/(?!search$)([^/]+)$/, (_r, loc, m) => { const o = this.opps.get(m[1]!); return o ? this.reply(200, { opportunity: this.oppJson(o.id) }, loc) : this.reply(404, {}, loc); });
    this.on("POST", /^\/opportunities\/$/, (req, loc) => { const o = this.seedOpp({ ...(B(req) as J), locationId: loc, indexedAt: this.now() } as unknown as Opp); return this.reply(201, { opportunity: { id: o.id } }, loc); });
    this.on("PUT", /^\/opportunities\/([^/]+)$/, (req, loc, m) => {
      const o = this.opps.get(m[1]!);
      if (!o) return this.reply(404, {}, loc);
      Object.assign(o, B(req), { updatedAt: this.iso() });
      return this.reply(200, { opportunity: this.oppJson(o.id) }, loc);
    });
    // ---- calendars ----
    this.on("GET", /^\/calendars\/$/, (_r, loc) => this.reply(200, { calendars: this.calendars }, loc));
    this.on("GET", /^\/calendars\/events$/, (req, loc) => {
      if (!req.query.get("calendarId") && !req.query.get("userId") && !req.query.get("groupId")) return this.reply(422, { message: "one of userId, calendarId or groupId is required" }, loc);
      const list = [...this.appts.values()].filter((a) => a.locationId === loc && a.calendarId === req.query.get("calendarId"));
      return this.reply(200, { events: list.map((a) => this.apptJson(a.id)) }, loc);
    });
    this.on("GET", /^\/calendars\/events\/appointments\/([^/]+)$/, (_r, loc, m) => { const a = this.appts.get(m[1]!); return a ? this.reply(200, { appointment: this.apptJson(a.id) }, loc) : this.reply(404, {}, loc); });
    this.on("PUT", /^\/calendars\/events\/appointments\/([^/]+)$/, (req, loc, m) => {
      const a = this.appts.get(m[1]!);
      if (!a) return this.reply(404, {}, loc);
      const b = B(req);
      Object.assign(a, b);
      if (b.appointmentStatus === undefined) a.appointmentStatus = "confirmed";   // the quirk: a PUT without it resets it
      if (a.appointmentStatus === "completed") a.appointmentStatus = "showed";
      a.dateUpdated = this.iso();
      return this.reply(200, { appointment: this.apptJson(a.id) }, loc);
    });
    // ---- conversations ----
    this.on("POST", /^\/conversations\/messages$/, (req, loc) => {
      const b = B(req);
      const conv = this.messages.find((x) => x.contactId === b.contactId)?.conversationId ?? this.id("cv");
      const msg: Message = { id: this.id("ms"), conversationId: conv, contactId: String(b.contactId), direction: "outbound", messageType: b.type === "SMS" ? "TYPE_SMS" : "TYPE_EMAIL", body: b.message, subject: b.subject, dateAdded: this.iso() };
      this.messages.push(msg);
      return this.reply(201, { messageId: msg.id, conversationId: conv, ...(b.type === "Email" ? { emailMessageId: msg.id } : {}) }, loc);
    });
    this.on("GET", /^\/conversations\/search$/, (req, loc) => {
      const contact = req.query.get("contactId"), after = Number(req.query.get("startAfterDate") ?? 0);
      const convs = new Map<string, { id: string; contactId: string; lastMessageDate: number }>();
      for (const m of this.messages) {
        if (contact && m.contactId !== contact) continue;
        const t = Date.parse(m.dateAdded);
        const cur = convs.get(m.conversationId);
        if (!cur || t > cur.lastMessageDate) convs.set(m.conversationId, { id: m.conversationId, contactId: m.contactId, lastMessageDate: t });
      }
      return this.reply(200, { conversations: [...convs.values()].filter((c) => c.lastMessageDate > after).sort((a, b) => a.lastMessageDate - b.lastMessageDate) }, loc);
    });
    this.on("GET", /^\/conversations\/([^/]+)\/messages$/, (_r, loc, m) => this.reply(200, { messages: { messages: this.messages.filter((x) => x.conversationId === m[1]).map((x) => structuredClone(x)), nextPage: false } }, loc));
    this.on("GET", /^\/conversations\/locations\/([^/]+)\/messages\/([^/]+)\/transcription$/, (_r, loc, m) => {
      const t = this.transcripts.get(m[2]!);
      return t ? this.reply(200, t, loc) : this.reply(400, { message: "CONVERSATIONS_MSG_RECORDING_NOT_FOUND" }, loc);
    });
    // ---- custom objects ----
    this.on("POST", /^\/objects\/([^/]+)\/records\/search$/, (req, loc, m) => {
      const q = String(B(req).query ?? "");
      const list = [...this.records.values()].filter((r) => r.objectKey === m[1] && (!q || JSON.stringify(r.properties).includes(q)));
      return this.reply(200, { records: list.map((r) => structuredClone(r)) }, loc);
    });
    this.on("POST", /^\/objects\/([^/]+)\/records$/, (req, loc, m) => { const b = B(req); const r: Rec = { id: this.id("rc"), objectKey: m[1]!, properties: (b.properties ?? {}) as J, owners: (b.owners as string[] | undefined) ?? [] }; this.records.set(r.id, r); return this.reply(201, { record: { id: r.id } }, loc); });
    this.on("PUT", /^\/objects\/([^/]+)\/records\/([^/]+)$/, (req, loc, m) => {
      if (!req.query.get("locationId")) return this.reply(422, { message: "locationId is required" }, loc);
      const r = this.records.get(m[2]!);
      if (!r) return this.reply(404, {}, loc);
      for (const [k, v] of Object.entries((B(req).properties ?? {}) as J)) { if (v === null) delete r.properties[k]; else r.properties[k] = v; }
      return this.reply(200, { record: structuredClone(r) }, loc);
    });
    this.on("DELETE", /^\/objects\/([^/]+)\/records\/([^/]+)$/, (req, loc, m) => (req.query.get("locationId") ? this.reply(422, { message: "property locationId should not exist" }, loc) : (this.records.delete(m[2]!), this.reply(200, {}, loc))));
    this.on("POST", /^\/associations\/relations$/, (req, loc) => {
      const b = B(req);
      const k = `${b.associationId}:${b.firstRecordId}:${b.secondRecordId}`;
      if (this.relations.has(k)) return this.reply(400, { message: "relation already exists" }, loc);
      this.relations.add(k);
      return this.reply(201, { id: this.id("rl") }, loc);
    });
    // ---- documents ----
    this.on("POST", /^\/proposals\/templates\/send$/, (req, loc) => { const b = B(req); const d = { _id: this.id("doc"), name: "Agreement", status: "sent", locationId: loc, createdAt: this.iso(), recipients: [{ id: b.contactId, entityName: "contacts", isPrimary: true, hasCompleted: false }] }; this.documents.unshift(d); return this.reply(200, { document: { _id: d._id } }, loc); });
    this.on("GET", /^\/proposals\/document$/, (req, loc) => {
      const limit = Math.min(21, Number(req.query.get("limit") ?? 21)), skip = Number(req.query.get("skip") ?? 0);
      const list = this.documents.filter((d) => d.locationId === loc);
      return this.reply(200, { documents: list.slice(skip, skip + limit).map((d) => structuredClone(d)), total: list.length }, loc);
    });
  }

  /** Marks a document signed, as a person signing it in GHL would. */
  sign(docId: string) { const d = this.documents.find((x) => x._id === docId)!; d.status = "completed"; d.updatedAt = this.iso(); (d.recipients as J[])[0]!.hasCompleted = true; (d.recipients as J[])[0]!.signedDate = this.iso(); }
}
