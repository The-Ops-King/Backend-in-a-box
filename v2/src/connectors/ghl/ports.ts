import { toMs } from "@/workflow/duration";
import { type CallContext, type CrmContact, type CrmPort, type EsignPort, type MessagingPort, PortError, type SchedulingPort } from "@/engine/ports";
import type { FieldMap } from "../framework/field-map";
import type { Hub } from "../framework/hub";
import type { Connection, J } from "../framework/types";
import type { GhlApi, GhlTarget } from "./api";
import { targetOf } from "./api";
import { type RawAppointment, type RawContact, type RawOpportunity, crmContact, customFieldsOf, ghlApptStatus, isObj, str } from "./shapes";
import { firstCheckAt } from "./agreements";

/**
 * GHL behind the CRM, messaging, scheduling and e-sign ports. Every quirk GHL has is met here, once, each with a test
 * (ghl.test.ts):
 * - a contact PUT never carries `tags` (GHL replaces every tag the contact has with them): tags go through their own calls;
 * - an appointment PUT that leaves out `appointmentStatus` resets it to confirmed: the appointment is read first and
 *   every field sent back, the status always;
 * - a DATE custom field drops the time: the field map's date type sends the day;
 * - the contact search lags writes by about 10 s: a contact or card this process just made is found from memory, and
 *   after a write a contact is read by id, never searched;
 * - opportunities search takes snake_case parameters;
 * - a custom object record is deleted without locationId (GHL refuses it there) but updated with it;
 * - relating two records already related answers 400 or 409: that is done, not a failure.
 * Each write records what it is expected to change (an echo) before it is made, so its webhook is known as ours.
 */

export const ECHO_WINDOW_MS = 15 * 60_000;
const RECENT_MS = 2 * 60_000;

/** The contact fields GHL holds natively, by canonical name; every other field goes through the field map. */
export const STANDARD_FIELDS: Record<string, string> = {
  first_name: "firstName", last_name: "lastName", name: "name", email: "email", phone: "phone", timezone: "timezone", source: "source",
  owner: "assignedTo", assigned_user_id: "assignedTo", address: "address1", city: "city", state: "state", postal_code: "postalCode", country: "country",
  company_name: "companyName", website: "website", date_of_birth: "dateOfBirth",
};

/** A create whose answer was lost and that a re-read did not find: GHL's searches lag, so it may still have been made. */
const lost = (what: string) => new PortError("ambiguous", `GHL did not answer the ${what}, and a re-read did not find it yet; it may have been made, so it is not sent again`);

const blank = (v: unknown) => v === undefined || v === null || (typeof v === "string" && v.trim() === "") || (Array.isArray(v) && v.length === 0);

export type GhlPorts = { crm: CrmPort; messaging: MessagingPort; scheduling: SchedulingPort; esign: EsignPort };

export function ghlPorts(hub: Hub, api: GhlApi, conn: Connection, map: FieldMap): GhlPorts {
  const t: GhlTarget = targetOf(conn);
  const loc = t.locationId;
  const echo = async (c: CallContext, entity: string, entityId: string, change: J) => {
    const now = hub.now();
    await hub.state.addEcho({ offerId: conn.offerId, provider: "ghl", entity, entityId, change, outboxKey: c.idempotencyKey, createdAt: now, expiresAt: new Date(now.getTime() + ECHO_WINDOW_MS) });
  };
  const recentKey = (k: string) => `${conn.offerId}:${k}`;
  const remember = (k: string, id: string) => hub.recent.set(recentKey(k), { id, at: hub.now().getTime() });
  const recalled = (k: string) => { const r = hub.recent.get(recentKey(k)); return r && hub.now().getTime() - r.at < RECENT_MS ? r.id : undefined; };

  // ---- contacts ----------------------------------------------------------------------------------------------------

  const readContact = async (id: string): Promise<RawContact | null> => {
    const out = await api.call(t, { method: "GET", path: `/contacts/${encodeURIComponent(id)}`, accept: [400, 404, 422] });
    if ("confirmed" in out) return null;
    if (out.status === 404 || ((out.status === 400 || out.status === 422) && /not found/i.test(out.text))) return null;
    if (out.status >= 400) throw new PortError("permanent", `GHL ${out.status} reading contact ${id}: ${out.text.slice(0, 200)}`, out.status);
    return ((out.body as J).contact ?? null) as RawContact | null;
  };
  const gone = (id: string) => new PortError("permanent", `the contact ${id} is gone from GHL (404)`, 404);
  /** A write to a contact: a 404 is a contact that is gone. */
  const contactWrite = async (id: string, r: Parameters<GhlApi["call"]>[1]) => {
    const out = await api.call(t, { ...r, accept: [404] });
    if (!("confirmed" in out) && out.status === 404) throw gone(id);
    return out;
  };

  const findDuplicate = async (by: { email?: string; phone?: string }): Promise<RawContact | null> => {
    const k = by.email ? `email:${by.email.toLowerCase()}` : `phone:${by.phone}`;
    const mine = recalled(k);
    if (mine) return readContact(mine);
    const r = await api.json<{ contact?: RawContact | null }>(t, { method: "GET", path: "/contacts/search/duplicate", query: { locationId: loc, ...(by.email ? { email: by.email } : { number: by.phone }) } });
    return r.contact ?? null;
  };

  /** Canonical fields as GHL's contact body: native fields by name, the rest as customFields through the field map. */
  const contactBody = (fields: J, clear: string[] = []): J => {
    const body: J = {};
    const custom: J = {};
    for (const [k, v] of Object.entries(fields)) {
      if (k === "tags") throw new PortError("permanent", "tags are written with crm.add_tag and crm.remove_tag, never as a field (GHL's contact PUT would replace every tag)");
      if (STANDARD_FIELDS[k]) body[STANDARD_FIELDS[k]!] = v; else custom[k] = v;
    }
    const customFields: { id: string; field_value: unknown }[] = map.write("contact", custom).map((f) => ({ id: f.id, field_value: f.value }));
    for (const k of clear) {
      if (STANDARD_FIELDS[k]) body[STANDARD_FIELDS[k]!] = "";
      else customFields.push({ id: map.idOf("contact", k), field_value: "" });
    }
    if (customFields.length) body.customFields = customFields;
    delete body.tags;   // never on a PUT: tags there replace every tag the contact has
    return body;
  };
  const currentValue = (k: RawContact, field: string): unknown => STANDARD_FIELDS[field] ? k[STANDARD_FIELDS[field]!] : customFieldsOf(k)[map.idOf("contact", field)];

  const putContact = async (c: CallContext, id: string, body: J) => {
    if (!Object.keys(body).length) return;
    await echo(c, "contact", id, { fields: Object.fromEntries([...Object.entries(body).filter(([k]) => k !== "customFields"), ...((body.customFields as { id: string; field_value: unknown }[] | undefined) ?? []).map((f) => [f.id, f.field_value])]) });
    await contactWrite(id, { method: "PUT", path: `/contacts/${encodeURIComponent(id)}`, body });
  };

  const fillBlanks = async (c: CallContext, k: RawContact, fill: J) => {
    const set = Object.fromEntries(Object.entries(fill).filter(([f, v]) => !blank(v) && blank(currentValue(k, f))));
    await putContact(c, k.id, contactBody(set));
  };

  const crm: CrmPort = {
    async getContact(_c, id): Promise<CrmContact | null> {
      const k = await readContact(id);
      return k ? crmContact(k) : null;
    },

    async findOrCreateContact(c, contactId, p) {
      const match = (p.match as string[] | undefined) ?? ["crm_id", "email", "phone"];
      const fill = Object.fromEntries(Object.entries((p.fillBlank ?? {}) as J).filter(([, v]) => !blank(v)));
      const email = str(fill.email)?.toLowerCase(), phone = str(fill.phone);
      for (const m of match) {
        const k = m === "crm_id" && contactId ? await readContact(contactId) : m === "email" && email ? await findDuplicate({ email }) : m === "phone" && phone ? await findDuplicate({ phone }) : null;
        if (k) { await fillBlanks(c, k, fill); return { id: k.id, action: "found" as const }; }
      }
      if (p.create === false) throw new PortError("permanent", "no such contact in GHL, and this step does not create one");
      const body = { locationId: loc, ...contactBody(fill) };
      // GHL's search lags its writes, so "not found" is not "not made": found is done, anything else is unknown
      const confirm = async () => { const k = email ? await findDuplicate({ email }) : phone ? await findDuplicate({ phone }) : null; if (k) return { contact: k }; throw lost("contact create"); };
      const r = await api.json<{ contact?: { id: string } }>(t, { method: "POST", path: "/contacts/", body, write: true, confirm });
      const id = r.contact?.id;
      if (!id) throw new PortError("ambiguous", "GHL answered the contact create without an id");
      if (email) remember(`email:${email}`, id);
      if (phone) remember(`phone:${phone}`, id);
      // its ContactCreate webhook is the platform's (recorded as soon as the id is known)
      await echo(c, "contact", id, { created: true });
      return { id, action: "created" as const };
    },

    async updateContact(c, id, p) {
      const set = Object.fromEntries(Object.entries((p.set ?? {}) as J).filter(([, v]) => !blank(v)));
      const ifEmpty = (p.ifEmpty as string[] | undefined) ?? [];
      if (ifEmpty.length) {
        const k = await readContact(id);
        if (!k) throw gone(id);
        for (const f of ifEmpty) if (f in set && !blank(currentValue(k, f))) delete set[f];
      }
      await putContact(c, id, contactBody(set, (p.clear as string[] | undefined) ?? []));
    },

    async addTags(c, id, tags) {
      for (const tag of tags) await echo(c, "contact", id, { tag_added: tag });
      await contactWrite(id, { method: "POST", path: `/contacts/${encodeURIComponent(id)}/tags`, body: { tags } });
    },
    async removeTags(c, id, tags) {
      for (const tag of tags) await echo(c, "contact", id, { tag_removed: tag });
      await contactWrite(id, { method: "DELETE", path: `/contacts/${encodeURIComponent(id)}/tags`, body: { tags } });
    },
    async markDnd(c, id, channel) {
      await echo(c, "contact", id, { dnd_on: channel });
      const body = channel === "all" ? { dnd: true } : { dndSettings: { [channel === "sms" ? "SMS" : "Email"]: { status: "active", message: "Opted out", code: "" } } };
      await contactWrite(id, { method: "PUT", path: `/contacts/${encodeURIComponent(id)}`, body });
    },

    // ---- deals (opportunities) -----------------------------------------------------------------------------------
    async moveDeal(c, contactId, p) {
      const pipeline = String(p.pipeline), stage = String(p.stage);
      const card = await pickCard(contactId, pipeline, (p.pick as string | undefined) ?? "open");
      const fields = map.write("opportunity", (p.fields ?? {}) as J).map((f) => ({ id: f.id, field_value: f.value }));
      const extra: J = { ...(str(p.owner) ? { assignedTo: str(p.owner) } : {}), ...(p.value !== undefined && p.value !== "" ? { monetaryValue: Number(p.value) } : {}), ...(fields.length ? { customFields: fields } : {}) };
      if (card) {
        const from = p.fromStages as string[] | undefined;
        if (from && !from.includes(String(card.pipelineStageId))) return { id: card.id };
        await echo(c, "opportunity", card.id, { stage });
        await api.call(t, { method: "PUT", path: `/opportunities/${encodeURIComponent(card.id)}`, body: { pipelineId: pipeline, pipelineStageId: stage, ...(p.name && !p.keepName ? { name: String(p.name) } : {}), ...extra } });
        return { id: card.id };
      }
      if (p.ifMissing === "skip") return null;
      const confirm = async () => { const k = await pickCard(contactId, pipeline, "latest"); if (k && k.pipelineStageId === stage) return { opportunity: k }; throw lost("opportunity create"); };
      const r = await api.json<{ opportunity?: { id: string } }>(t, { method: "POST", path: "/opportunities/", write: true, confirm, body: { locationId: loc, contactId, pipelineId: pipeline, pipelineStageId: stage, name: str(p.name) ?? "Deal", status: "open", ...extra } });
      const id = r.opportunity?.id;
      if (!id) throw new PortError("ambiguous", "GHL answered the opportunity create without an id");
      remember(`card:${contactId}:${pipeline}`, id);
      await echo(c, "opportunity", id, { stage });
      return { id };
    },
    async setDealStatus(c, contactId, p) {
      const card = await pickCard(contactId, String(p.pipeline), "latest");
      if (!card) throw new PortError("permanent", `the contact has no card on pipeline ${String(p.pipeline)}`);
      const from = p.from as string[] | undefined;
      if (from && !from.includes(String(card.status))) return;
      await echo(c, "opportunity", card.id, { status: String(p.status) });
      await api.call(t, { method: "PUT", path: `/opportunities/${encodeURIComponent(card.id)}`, body: { status: String(p.status) } });
    },
    async updateDeal(c, contactId, p) {
      const card = await pickCard(contactId, String(p.pipeline), "latest");
      if (!card) throw new PortError("permanent", `the contact has no card on pipeline ${String(p.pipeline)}`);
      const fields = map.write("opportunity", (p.fields ?? {}) as J).map((f) => ({ id: f.id, field_value: f.value }));
      for (const k of (p.clear as string[] | undefined) ?? []) fields.push({ id: map.idOf("opportunity", k), field_value: "" });
      const body: J = { ...(p.value !== undefined && p.value !== "" ? { monetaryValue: Number(p.value) } : {}), ...(fields.length ? { customFields: fields } : {}) };
      if (!Object.keys(body).length) return;
      await echo(c, "opportunity", card.id, body.monetaryValue !== undefined ? { value: body.monetaryValue } : {});
      await api.call(t, { method: "PUT", path: `/opportunities/${encodeURIComponent(card.id)}`, body });
    },

    async createTask(_c, contactId, p) {
      const due = new Date(hub.now().getTime() + toMs(String(p.due ?? "1d")));
      const body = { title: String(p.title ?? ""), body: String(p.body ?? ""), dueDate: due.toISOString(), completed: false, ...(str(p.assignTo) ? { assignedTo: str(p.assignTo) } : {}) };
      const out = await contactWrite(contactId, { method: "POST", path: `/contacts/${encodeURIComponent(contactId)}/tasks`, body, write: true });
      const r = ("confirmed" in out ? out.confirmed : out.body) as { task?: { id?: string }; id?: string };
      return { id: r.task?.id ?? r.id ?? "" };
    },
    async addNote(_c, contactId, body) {
      await contactWrite(contactId, { method: "POST", path: `/contacts/${encodeURIComponent(contactId)}/notes`, body: { body }, write: true });
    },

    // ---- custom objects ------------------------------------------------------------------------------------------
    async upsertRecord(_c, p) {
      const object = String(p.object);
      if (!/^custom_objects\.[a-z0-9_]+$/.test(object)) throw new PortError("permanent", `"${object}" is not a GHL custom object key (custom_objects.<name>)`);
      const properties = recordProperties(object, (p.properties ?? {}) as J);
      for (const k of (p.clear as string[] | undefined) ?? []) properties[propertyKey(object, k)] = null;   // null empties a property ("" is ignored for some types)
      const key = str(p.key);
      let id = str(p.recordId) ?? (key ? (await findRecord(object, key))?.id : undefined);
      if (id) {
        await api.call(t, { method: "PUT", path: `/objects/${object}/records/${encodeURIComponent(id)}`, query: { locationId: loc }, body: { properties, ...(str(p.owner) ? { owners: { add: [str(p.owner)] } } : {}) } });
        return { id };
      }
      if (p.ifMissing === "skip") throw new PortError("permanent", `no ${object} record for ${key ?? "that id"}, and this step only updates`);
      if (key && map.has(object, "external_id")) properties[map.idOf(object, "external_id")] = key;
      else if (key) properties.external_id = key;
      const confirm = async () => { const hit = key ? await findRecord(object, key) : null; if (hit) return { record: hit }; throw lost("record create"); };
      const r = await api.json<{ record?: { id: string }; id?: string }>(t, { method: "POST", path: `/objects/${object}/records`, write: true, confirm, body: { locationId: loc, properties, ...(str(p.owner) ? { owners: [str(p.owner)] } : {}) } });
      id = r.record?.id ?? r.id;
      if (!id) throw new PortError("ambiguous", "GHL answered the record create without an id");
      return { id };
    },
    async relateRecords(_c, p) {
      // 400 and 409 are GHL's answer for two records already related (v1): done, not a failure
      await api.call(t, { method: "POST", path: "/associations/relations", body: { locationId: loc, associationId: String(p.association), firstRecordId: String(p.first), secondRecordId: String(p.second) }, accept: [400, 409] });
    },
  };

  /** A record's properties: through the field map when the map knows the object, else as named (the object the platform made). */
  const propertyKey = (object: string, k: string) => (map.has(object, k) ? map.idOf(object, k) : k);
  const recordProperties = (object: string, props: J): J => {
    const out: J = {};
    for (const [k, v] of Object.entries(props)) {
      if (blank(v)) continue;
      out[propertyKey(object, k)] = map.has(object, k) ? map.write(object, { [k]: v })[0]!.value : v;
    }
    return out;
  };
  const findRecord = async (object: string, key: string): Promise<{ id: string } | null> => {
    const r = await api.json<{ records?: { id: string; properties?: J }[] }>(t, { method: "POST", path: `/objects/${object}/records/search`, body: { locationId: loc, page: 1, pageLimit: 20, query: key } });
    const prop = map.has(object, "external_id") ? map.idOf(object, "external_id") : "external_id";
    const hit = (r.records ?? []).find((x) => String((x.properties ?? {})[prop] ?? "") === key);
    return hit ? { id: hit.id } : null;
  };

  /** The contact's card on a pipeline: the open one (else none), or the latest; one this process just made is known before GHL's search shows it. */
  const pickCard = async (contactId: string, pipeline: string, pick: string): Promise<RawOpportunity | null> => {
    const r = await api.json<{ opportunities?: RawOpportunity[] }>(t, { method: "GET", path: "/opportunities/search", query: { location_id: loc, contact_id: contactId, pipeline_id: pipeline, limit: 100 } });
    const cards = (r.opportunities ?? []).filter((o) => !o.pipelineId || o.pipelineId === pipeline);
    const mine = recalled(`card:${contactId}:${pipeline}`);
    if (mine && !cards.some((x) => x.id === mine)) {
      // made by this process moments ago, not in the search yet: read by id, which is right at once
      const r1 = await api.call(t, { method: "GET", path: `/opportunities/${encodeURIComponent(mine)}`, accept: [404] });
      const card = !("confirmed" in r1) && r1.status < 400 ? ((r1.body as J).opportunity as RawOpportunity | undefined) : undefined;
      if (card) cards.push({ ...card, updatedAt: card.updatedAt ?? hub.now().toISOString() });
    }
    const byTime = cards.sort((a, b) => String(b.updatedAt ?? b.dateUpdated ?? "").localeCompare(String(a.updatedAt ?? a.dateUpdated ?? "")));
    return (pick === "open" ? byTime.find((x) => (x.status ?? "open") === "open") : byTime[0]) ?? null;
  };

  // ---- messaging --------------------------------------------------------------------------------------------------

  const send = async (contactId: string, body: J, what: string) => {
    const startedAt = hub.now();
    // a send that may have gone is looked for in the thread; not found, it is unknown, never sent twice
    const confirm = async () => {
      const found = await sentMessage(contactId, body, startedAt);
      if (found) return { messageId: found };
      throw new PortError("ambiguous", `GHL did not answer the ${what} and it is not in the thread yet; it may still go out, so it is not sent again`);
    };
    const r = await api.json<{ messageId?: string; emailMessageId?: string; conversationId?: string }>(t, { method: "POST", path: "/conversations/messages", body: { ...body, contactId }, write: true, confirm });
    const id = r.emailMessageId ?? r.messageId;
    if (!id) throw new PortError("ambiguous", `GHL answered the ${what} without a message id`);
    return { id };
  };
  const sentMessage = async (contactId: string, body: J, since: Date): Promise<string | undefined> => {
    const convs = await api.json<{ conversations?: { id: string }[] }>(t, { method: "GET", path: "/conversations/search", query: { locationId: loc, contactId, limit: 5 } });
    for (const conv of convs.conversations ?? []) {
      const m = await api.json<{ messages?: { messages?: J[] } }>(t, { method: "GET", path: `/conversations/${encodeURIComponent(conv.id)}/messages`, query: { limit: 20 } });
      const hit = (m.messages?.messages ?? []).find((x) => x.direction === "outbound" && Date.parse(String(x.dateAdded ?? 0)) >= since.getTime() - 5_000
        && (body.type === "SMS" ? x.body === body.message : x.subject === body.subject));
      if (hit) return String(hit.id);
    }
    return undefined;
  };

  const messaging: MessagingPort = {
    async sendSms(_c, m) {
      if (!m.to) throw new PortError("permanent", "the contact has no phone in GHL");
      return send(m.contactId, { type: "SMS", message: m.body }, "text");
    },
    async sendEmail(_c, m) {
      if (!m.to) throw new PortError("permanent", "the contact has no email in GHL");
      const from = str(conn.config.email_from);
      return send(m.contactId, { type: "Email", subject: m.subject, html: m.body, ...(from ? { emailFrom: from } : {}) }, "email");
    },
  };

  // ---- scheduling -------------------------------------------------------------------------------------------------

  /** Read, then write every field back: a PUT without appointmentStatus resets it to confirmed. */
  const putAppointment = async (c: CallContext, id: string, status: string) => {
    const r = await api.json<{ appointment?: RawAppointment; event?: RawAppointment }>(t, { method: "GET", path: `/calendars/events/appointments/${encodeURIComponent(id)}` });
    const a = r.appointment ?? r.event;
    if (!a) throw new PortError("permanent", `GHL has no appointment ${id}`);
    const to = ghlApptStatus(status);
    await echo(c, "appointment", id, { status: to });
    await api.call(t, {
      method: "PUT", path: `/calendars/events/appointments/${encodeURIComponent(id)}`,
      body: { calendarId: a.calendarId, startTime: a.startTime, endTime: a.endTime, title: a.title, assignedUserId: a.assignedUserId, ...(a.address ? { address: a.address } : {}), appointmentStatus: to, ignoreFreeSlotValidation: true },
    });
  };
  const scheduling: SchedulingPort = {
    cancel: (c, p) => putAppointment(c, p.appointmentId, "cancelled"),
    setStatus: (c, p) => putAppointment(c, p.appointmentId, p.status),
  };

  // ---- e-sign -----------------------------------------------------------------------------------------------------

  const esign: EsignPort = {
    async send(_c, p) {
      // UNVERIFIED body (v1 never had the send scope): POST /proposals/templates/send { locationId, templateId, contactId, userId, medium }
      const r = await api.json<J>(t, { method: "POST", path: "/proposals/templates/send", write: true, body: { locationId: loc, templateId: p.template, contactId: p.contactId, ...(p.sender ? { userId: p.sender } : {}), medium: "email" } });
      const doc = isObj(r.document) ? r.document : r;
      const id = str(doc._id) ?? str(doc.id);
      if (!id) throw new PortError("ambiguous", "GHL answered the agreement send without a document id");
      const now = hub.now();
      await hub.state.addAgreementCheck({ offerId: conn.offerId, connectionId: conn.id, locationId: loc, agreementId: id, contactId: p.contactId, name: p.name ?? null, sentAt: now, nextCheckAt: firstCheckAt(now) });
      await hub.enqueue("ghl_agreements", { locationId: loc }, { runAt: firstCheckAt(now), jobKey: `ghl_agreements:${loc}` });
      return { id };
    },
    async void(_c, p) {
      // UNVERIFIED: the void call (GHL documents no void endpoint on the v2 API the checks have seen)
      await api.call(t, { method: "POST", path: `/proposals/document/${encodeURIComponent(p.agreementId)}/void`, body: { locationId: loc } });
    },
  };

  return { crm, messaging, scheduling, esign };
}
