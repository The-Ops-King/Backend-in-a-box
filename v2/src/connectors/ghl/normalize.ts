import type { FieldMap } from "../framework/field-map";
import type { Hub } from "../framework/hub";
import type { Version } from "../framework/state";
import { scheduleTranscript } from "../framework/transcripts";
import type { CanonicalFact, Connection, J, Normalized } from "../framework/types";
import {
  type RawAppointment, type RawContact, type RawOpportunity, appointmentSnapshot, apptStatus, callStatus, contactSnapshot, customFieldsOf, dndOf, isObj, iso,
  messageOf, num, oppContact, oppUpdated, str,
} from "./shapes";

/**
 * GHL's webhook events (and the same events as a poll or the nightly reconcile builds them) as canonical facts.
 *
 * | GHL event | Canonical fact |
 * | --- | --- |
 * | ContactCreate | contact.created, and tag.added for each tag it was made with |
 * | ContactUpdate, ContactTagUpdate, ContactDndUpdate | contact.updated; tag.added / tag.removed and contact.opted_out / opted_in from the difference with the last state seen |
 * | ContactDelete | contact.deleted |
 * | AppointmentCreate | appointment.booked |
 * | AppointmentUpdate | appointment.rescheduled (start moved), appointment.cancelled, appointment.status_changed |
 * | AppointmentDelete | appointment.cancelled |
 * | Opportunity* | card.moved (made, stage or status changed: won, lost), card.updated (value, owner), card.deleted |
 * | InboundMessage SMS / Email | message.received |
 * | Inbound / OutboundMessage of type call | call.logged |
 * | RecordCreate / Update / Delete | record.created / record.updated / record.deleted |
 * | NoteCreate | note.added |
 * | UserCreate / Update / Delete | person.changed (Tyler maps them; never a team member by itself) |
 * | INSTALL / UNINSTALL | connection.installed / connection.uninstalled |
 *
 * The spec's deal.opened / deal.stage_changed / deal.won / deal.lost are card.* here: deal.* is the ledger's own deal in
 * the projections, and a CRM card must never count as a close.
 *
 * Every fact's dedupe key is built from the entity and the vendor's own time, never the delivery, so a webhook, the
 * poll and the reconcile that see the same change are one fact. An update older than the last state seen is stale and
 * dropped. A fact that echoes the platform's own write (its outbox recorded the expected change) says `by: platform`;
 * every other says `by: crm`.
 */

export type GhlEvent = J & { type?: string; locationId?: string };
export type GhlSource = "ghl" | "ghl_poll" | "reconcile";

const CONTACT = ["ContactCreate", "ContactUpdate", "ContactTagUpdate", "ContactDndUpdate", "ContactDelete"];
const APPOINTMENT = ["AppointmentCreate", "AppointmentUpdate", "AppointmentDelete"];
const OPPORTUNITY = ["OpportunityCreate", "OpportunityUpdate", "OpportunityStageUpdate", "OpportunityStatusUpdate", "OpportunityMonetaryValueUpdate", "OpportunityAssignedToUpdate", "OpportunityDelete"];
const MESSAGE = ["InboundMessage", "OutboundMessage"];
const RECORD = ["RecordCreate", "RecordUpdate", "RecordDelete"];
const USER = ["UserCreate", "UserUpdate", "UserDelete"];
const INSTALL = ["INSTALL", "AppInstall"];
const UNINSTALL = ["UNINSTALL", "AppUninstall"];

/** `only`: one offer's facts (its own poll or reconcile), not every offer's on the location. */
export async function normalizeGhl(hub: Hub, ev: GhlEvent, o: { source: GhlSource; receivedAt: Date; only?: string }): Promise<Normalized> {
  const type = String(ev.type ?? "");
  const loc = str(ev.locationId);
  if (!loc) return { facts: [], outcome: "no location" };
  if (UNINSTALL.includes(type)) return uninstalled(hub, loc, o.receivedAt);
  const conns = (await offersAt(hub, loc)).filter((c) => !o.only || c.offerId === o.only);
  if (INSTALL.includes(type)) return installed(hub, loc, conns, o.receivedAt);
  if (!conns.length) {
    await hub.alert({ offerId: null, key: `ghl-unknown-location:${loc}`, kind: "ghl_unknown_location", message: `GHL sent ${type || "an event"} for location ${loc}, which no offer is connected to. The delivery is kept in the inbox (marked: unknown location) and made into no facts; link the location to an offer to use the ones that follow.`, detail: { location: loc } });
    return { facts: [], outcome: "unknown location" };
  }
  const facts: CanonicalFact[] = [];
  const commits: (() => Promise<void>)[] = [];
  const outcomes: string[] = [];
  for (const conn of conns) {
    const map = await hub.fieldMap(conn.offerId, "ghl");
    const w = new Work(hub, conn, map, o.source, o.receivedAt);
    if (!(await w.inScope(ev, type))) { outcomes.push("out of scope"); continue; }
    const outcome = await w.run(ev, type);
    outcomes.push(outcome);
    facts.push(...w.facts);
    commits.push(() => w.commit());
  }
  return { facts, outcome: facts.length ? "facts" : outcomes[0] ?? "nothing", commit: async () => { for (const c of commits) await c(); } };
}

/** One connection per offer at the location (the CRM's, else any GHL one): the offers its events belong to. */
async function offersAt(hub: Hub, loc: string): Promise<Connection[]> {
  const all = (await hub.state.connectionsOf("ghl", loc)).filter((c) => c.status !== "uninstalled");
  const byOffer = new Map<string, Connection>();
  for (const c of all.sort((a, b) => (a.port === "crm" ? -1 : b.port === "crm" ? 1 : 0))) if (!byOffer.has(c.offerId)) byOffer.set(c.offerId, c);
  return [...byOffer.values()];
}

async function installed(hub: Hub, loc: string, conns: Connection[], at: Date): Promise<Normalized> {
  if (!(await hub.state.ghlToken(loc))) {
    await hub.alert({ offerId: null, key: `ghl-install-unknown:${loc}`, kind: "ghl_install_unknown", message: `The GHL app was installed on location ${loc}, but the platform did not start that install. It is recorded and not linked to any offer.`, detail: { location: loc } });
    return { facts: [], outcome: "install the platform did not start" };
  }
  return { facts: conns.map((c) => ({ offerId: c.offerId, type: "connection.installed", occurredAt: at, source: "ghl", dedupeKey: `ghl:install:${loc}:${at.toISOString()}`, payload: { provider: "ghl", location_id: loc } })), outcome: "installed" };
}

async function uninstalled(hub: Hub, loc: string, at: Date): Promise<Normalized> {
  const conns = await offersAt(hub, loc);
  await hub.state.lockGhlToken(loc, async (row) => ({ ...(row ? { set: { status: "uninstalled" as const } } : {}), result: undefined }));
  await hub.pause({ provider: "ghl", externalId: loc }, "uninstalled", `the GHL app was uninstalled from location ${loc}; its work waits until it is installed again`);
  return { facts: conns.map((c) => ({ offerId: c.offerId, type: "connection.uninstalled", occurredAt: at, source: "ghl", dedupeKey: `ghl:uninstall:${loc}:${at.toISOString()}`, payload: { provider: "ghl", location_id: loc } })), outcome: "uninstalled" };
}

class Work {
  facts: CanonicalFact[] = [];
  private versions: Version[] = [];
  private echoes: number[] = [];
  private afterCommit: (() => Promise<void>)[] = [];

  constructor(private hub: Hub, private conn: Connection, private map: FieldMap, private source: GhlSource, private receivedAt: Date) {}

  private get offerId() { return this.conn.offerId; }

  async commit() {
    for (const v of this.versions) await this.hub.state.putVersion(v);
    for (const id of this.echoes) await this.hub.state.markEcho(id, this.receivedAt);
    for (const f of this.afterCommit) await f();
  }

  private fact(type: string, at: Date, key: string, x: { contactId?: string | null; appointmentId?: string | null; payload: J }) {
    this.facts.push({ offerId: this.offerId, type, occurredAt: at, source: this.source, dedupeKey: key, contactId: x.contactId ?? null, appointmentId: x.appointmentId ?? null, payload: x.payload });
  }

  /** Who made this change: the platform when an echo of its own write matches, else the CRM (a person, or GHL itself). */
  private async by(entity: string, entityId: string, change: J): Promise<"platform" | "crm"> {
    const id = await this.hub.state.findEcho({ offerId: this.offerId, provider: "ghl", entity, entityId, change, at: this.receivedAt });
    if (id === undefined || this.echoes.includes(id)) return "crm";
    this.echoes.push(id);
    return "platform";
  }

  private async prior(kind: string, id: string) { return this.hub.state.version(this.offerId, "ghl", kind, id); }
  private learn(kind: string, id: string, at: Date, state: J) { this.versions.push({ offerId: this.offerId, provider: "ghl", kind, entityId: id, versionAt: at, state, updatedAt: this.receivedAt }); }
  private stale(prev: Version | undefined, at: Date) { return !!prev?.versionAt && at.getTime() < prev.versionAt.getTime(); }

  /**
   * An offer that shares its location with another business (v1's scope tag) takes only its own people's events: a
   * contact without the offer's tag is someone else's.
   */
  async inScope(ev: GhlEvent, type: string): Promise<boolean> {
    const tag = str(this.conn.config.scope_tag);
    if (!tag) return true;
    if (CONTACT.includes(type)) return Array.isArray(ev.tags) && ev.tags.includes(tag) || (await this.prior("contact", String(ev.id ?? "")))?.state.in_scope === true;
    const contactId = APPOINTMENT.includes(type) ? str((ev.appointment as J | undefined)?.contactId) : OPPORTUNITY.includes(type) ? oppContact(ev as RawOpportunity) : str(ev.contactId);
    if (!contactId) return false;
    return (await this.prior("contact", contactId))?.state.in_scope === true;
  }

  async run(ev: GhlEvent, type: string): Promise<string> {
    if (CONTACT.includes(type)) return this.contact(ev as RawContact & GhlEvent, type);
    if (APPOINTMENT.includes(type)) return this.appointment(ev, type);
    if (OPPORTUNITY.includes(type)) return this.opportunity(ev as RawOpportunity & GhlEvent, type);
    if (MESSAGE.includes(type)) return this.message(ev);
    if (RECORD.includes(type)) return this.record(ev, type);
    if (USER.includes(type)) return this.user(ev, type);
    if (type === "NoteCreate") return this.note(ev);
    return `ignored ${type || "an event without a type"}`;
  }

  // ---- contacts ------------------------------------------------------------------------------------------------------

  private async contact(c: RawContact & GhlEvent, type: string): Promise<string> {
    const id = str(c.id);
    if (!id) return "contact without an id";
    const at = new Date(iso(c.dateUpdated) ?? iso(c.dateAdded) ?? this.receivedAt.toISOString());
    const prev = await this.prior("contact", id);
    if (type === "ContactDelete") {
      this.fact("contact.deleted", at, `ghl:contact:${id}:deleted`, { contactId: id, payload: { contact: { ghl_contact_id: id }, by: "crm" } });
      this.learn("contact", id, at, { ...(prev?.state ?? {}), deleted: true });
      return "facts";
    }
    if (this.stale(prev, at)) return "stale";
    const tags = Array.isArray(c.tags) ? c.tags.map(String) : undefined;
    const dnd = dndOf(c);
    // the same version seen again (a poll's overlap, a reconcile), its tags and DND as they were: nothing has changed
    const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
    if (prev?.versionAt && prev.versionAt.getTime() === at.getTime() && type !== "ContactCreate" && (!tags || same([...tags].sort(), [...((prev.state.tags as string[] | undefined) ?? [])].sort()))
      && Object.entries(dnd).every(([ch, on]) => ((prev.state.dnd as Record<string, boolean> | undefined)?.[ch] ?? false) === on)) return "already seen";
    const snap = contactSnapshot(c, this.map);
    const stamp = at.toISOString();
    const scopeTag = str(this.conn.config.scope_tag);
    const created = type === "ContactCreate";
    const own: ("platform" | "crm")[] = [];
    if (created) this.fact("contact.created", at, `ghl:contact:${id}:created`, { contactId: id, payload: { contact: snap, by: await this.by("contact", id, { created: true }) } });
    // a tag difference is only said against a state seen before (or a contact just made): GHL's update does not say which tag changed
    if (tags && (prev || created)) {
      const before: string[] = (prev?.state.tags as string[] | undefined) ?? [];
      for (const tag of tags.filter((x) => !before.includes(x))) { const by = await this.by("contact", id, { tag_added: tag }); own.push(by); this.fact("tag.added", at, `ghl:contact:${id}:tag+:${tag}:${stamp}`, { contactId: id, payload: { tag, contact: snap, by } }); }
      for (const tag of before.filter((x) => !tags.includes(x))) { const by = await this.by("contact", id, { tag_removed: tag }); own.push(by); this.fact("tag.removed", at, `ghl:contact:${id}:tag-:${tag}:${stamp}`, { contactId: id, payload: { tag, contact: snap, by } }); }
    }
    if (prev || created) {
      const was = (prev?.state.dnd ?? {}) as Record<string, boolean>;
      for (const ch of ["all", "sms", "email"] as const) {
        const now = dnd[ch];
        if (now === undefined || now === (was[ch] ?? false)) continue;
        const by = now ? await this.by("contact", id, { dnd_on: ch }) : "crm";
        own.push(by);
        this.fact(now ? "contact.opted_out" : "contact.opted_in", at, `ghl:contact:${id}:dnd:${ch}:${now}:${stamp}`, { contactId: id, payload: { channel: ch, contact: snap, by } });
      }
    }
    if (!created) {
      const observed = { fields: { ...Object.fromEntries(Object.entries(c).filter(([, v]) => typeof v !== "object")), ...customFieldsOf(c) } };
      const fieldsBy = await this.by("contact", id, observed);
      const by = fieldsBy === "platform" || (own.length > 0 && own.every((x) => x === "platform")) ? "platform" : "crm";
      this.fact("contact.updated", at, `ghl:contact:${id}:updated:${stamp}`, { contactId: id, payload: { contact: snap, by } });
    }
    this.learn("contact", id, at, { tags: tags ?? prev?.state.tags ?? [], dnd: { ...((prev?.state.dnd ?? {}) as J), ...dnd }, in_scope: scopeTag ? !!tags?.includes(scopeTag) : true });
    return "facts";
  }

  // ---- appointments --------------------------------------------------------------------------------------------------

  private async appointment(ev: GhlEvent, type: string): Promise<string> {
    const a = (isObj(ev.appointment) ? ev.appointment : ev) as RawAppointment;
    const id = str(a.id);
    if (!id) return "appointment without an id";
    const at = new Date(iso(a.dateUpdated) ?? iso(a.dateAdded) ?? this.receivedAt.toISOString());
    const prev = await this.prior("appointment", id);
    const contactId = str(a.contactId) ?? (prev?.state.contact_id as string | undefined) ?? null;
    if (type === "AppointmentDelete") {
      if (prev?.state.status !== "cancelled") this.fact("appointment.cancelled", at, `ghl:appt:${id}:deleted`, { contactId, appointmentId: id, payload: { appointment: { status: "cancelled" }, status: { from: prev?.state.status ?? null, to: "cancelled" }, deleted: true, by: "crm" } });
      this.learn("appointment", id, at, { ...(prev?.state ?? {}), status: "cancelled" });
      return "facts";
    }
    if (this.stale(prev, at)) return "stale";
    const snap = appointmentSnapshot(a, this.map);
    const status = apptStatus(a), start = iso(a.startTime);
    const stamp = at.toISOString();
    const contact = contactId ? { ghl_contact_id: contactId } : undefined;
    if (!prev) {
      this.fact("appointment.booked", at, `ghl:appt:${id}:booked`, { contactId, appointmentId: id, payload: { appointment: snap, ...(contact ? { contact } : {}), by: await this.by("appointment", id, { created: true }) } });
    } else {
      if (start && prev.state.start && start !== prev.state.start) {
        this.fact("appointment.rescheduled", at, `ghl:appt:${id}:moved:${start}`, { contactId, appointmentId: id, payload: { appointment: snap, from: { starts_at: prev.state.start }, ...(contact ? { contact } : {}), by: await this.by("appointment", id, { start }) } });
      }
      if (status && prev.state.status && status !== prev.state.status) {
        const by = await this.by("appointment", id, { status });
        const from = String(prev.state.status), to = snap.status as string;
        if (status === "cancelled") this.fact("appointment.cancelled", at, `ghl:appt:${id}:status:cancelled:${stamp}`, { contactId, appointmentId: id, payload: { appointment: snap, status: { from, to }, by } });
        else this.fact("appointment.status_changed", at, `ghl:appt:${id}:status:${status}:${stamp}`, { contactId, appointmentId: id, payload: { appointment: snap, status: { from, to }, by } });
      }
    }
    this.learn("appointment", id, at, { status: status ?? prev?.state.status ?? null, start: start ?? prev?.state.start ?? null, contact_id: contactId });
    return "facts";
  }

  // ---- opportunities (cards) -----------------------------------------------------------------------------------------

  private async opportunity(o: RawOpportunity & GhlEvent, type: string): Promise<string> {
    const id = str(o.id);
    if (!id) return "opportunity without an id";
    const prev = await this.prior("opportunity", id);
    const at = new Date(oppUpdated(o) ?? this.receivedAt.toISOString());
    const contactId = oppContact(o) ?? (prev?.state.contact_id as string | undefined) ?? null;
    const stamp = at.toISOString();
    if (type === "OpportunityDelete") {
      this.fact("card.deleted", at, `ghl:opp:${id}:deleted`, { contactId, payload: { deal_id: id, pipeline_id: prev?.state.pipeline ?? str(o.pipelineId) ?? null, by: "crm" } });
      this.learn("opportunity", id, at, { ...(prev?.state ?? {}), deleted: true });
      return "facts";
    }
    if (this.stale(prev, at)) return "stale";
    const p = (prev?.state ?? {}) as J;
    const now = {
      pipeline: str(o.pipelineId) ?? (p.pipeline as string | undefined) ?? null, stage: str(o.pipelineStageId) ?? (p.stage as string | undefined) ?? null,
      status: str(o.status) ?? (p.status as string | undefined) ?? "open", value: num(o.monetaryValue) ?? (p.value as number | undefined) ?? null,
      owner: o.assignedTo === null ? null : str(o.assignedTo) ?? (p.owner as string | undefined) ?? null, name: str(o.name) ?? (p.name as string | undefined) ?? null, contact_id: contactId,
    };
    const base = { deal_id: id, pipeline_id: now.pipeline, pipeline: now.pipeline, name: now.name, owner: now.owner, value: now.value };
    if (!prev || now.stage !== p.stage || now.status !== p.status) {
      const change: J = now.stage !== p.stage ? { stage: now.stage } : { status: now.status };
      const by = await this.by("opportunity", id, change);
      this.fact("card.moved", at, `ghl:opp:${id}:${now.stage}:${now.status}:${stamp}`, { contactId, payload: { ...base, from_stage: p.stage ?? null, to_stage: now.stage, from_status: p.status ?? null, to_status: now.status, made: !prev, by } });
    } else if (now.value !== p.value || now.owner !== p.owner || now.name !== p.name) {
      const by = await this.by("opportunity", id, now.value !== p.value ? { value: now.value } : { owner: now.owner });
      this.fact("card.updated", at, `ghl:opp:${id}:updated:${stamp}`, { contactId, payload: { ...base, from: { value: p.value ?? null, owner: p.owner ?? null, name: p.name ?? null }, by } });
    }
    this.learn("opportunity", id, at, now);
    return "facts";
  }

  // ---- messages and dialer calls -------------------------------------------------------------------------------------

  private async message(ev: GhlEvent): Promise<string> {
    const m = messageOf(ev);
    if (!m) return "message without an id";
    const at = new Date(m.at ?? this.receivedAt.toISOString());
    if (m.channel === "call") {
      const status = callStatus(m);
      const started = m.durationSec ? new Date(at.getTime() - m.durationSec * 1000) : at;
      const recordingId = `ghl:${m.id}`;
      this.fact("call.logged", started, `ghl:call:${m.id}`, {
        contactId: m.contactId ?? null,
        payload: {
          recording_id: recordingId, duration_sec: m.durationSec ?? 0,
          recording: { id: recordingId, provider: "ghl", external_id: m.id, kind: "phone", status, direction: m.direction, started_at: started.toISOString(), ended_at: at.toISOString(), ...(m.userId ? { caller: { ghl_user_id: m.userId } } : {}), conversation_id: m.conversationId ?? null },
          ...(m.contactId ? { contact: { ghl_contact_id: m.contactId } } : {}), by: "crm",
        },
      });
      // a connected call's transcript comes after the call: looked for 1, 3 and 10 minutes on (not by the reconcile)
      if (status === "connected" && this.source !== "reconcile") this.afterCommit.push(() => waitForTranscript(this.hub, this.conn, "ghl", m.id, { contactId: m.contactId ?? null, recording_id: recordingId }));
      return "facts";
    }
    if (m.direction !== "inbound") return "outbound message (a send, not a reply)";
    if (m.channel === "other") return "ignored a message of another kind";
    this.fact("message.received", at, `ghl:msg:${m.id}`, {
      contactId: m.contactId ?? null,
      payload: { channel: m.channel, message_id: m.id, conversation_id: m.conversationId ?? null, ...(m.channel === "sms" && m.body !== undefined ? { body: m.body } : {}), ...(m.subject ? { subject: m.subject } : {}), by: "crm" },
    });
    return "facts";
  }
  // ---- custom object records, notes, users -----------------------------------------------------------------------------

  private async record(ev: GhlEvent, type: string): Promise<string> {
    const id = str(ev.id);
    if (!id) return "record without an id";
    const object = str(ev.objectKey) ?? str(ev.schemaKey) ?? str(ev.object) ?? null;
    const at = new Date(iso(ev.dateUpdated) ?? iso(ev.updatedAt) ?? iso(ev.dateAdded) ?? this.receivedAt.toISOString());
    const prev = await this.prior("record", id);
    if (type !== "RecordDelete" && this.stale(prev, at)) return "stale";
    // UNVERIFIED shape: properties as [{ key, valueString | valueNumber | value }] (GHL's RecordCreate docs) or as an object
    const props: J = Array.isArray(ev.properties)
      ? Object.fromEntries((ev.properties as J[]).map((p) => [String(p.key ?? "").split(".").pop(), p.valueString ?? p.valueNumber ?? p.valueArray ?? p.value ?? null]))
      : isObj(ev.properties) ? ev.properties : {};
    const kind = type === "RecordCreate" ? "created" : type === "RecordDelete" ? "deleted" : "updated";
    this.fact(`record.${kind}`, at, `ghl:record:${id}:${kind}:${at.toISOString()}`, { payload: { object, record_id: id, properties: props, by: await this.by("record", id, kind === "created" ? { created: true } : {}) } });
    this.learn("record", id, at, { object });
    return "facts";
  }

  private async note(ev: GhlEvent): Promise<string> {
    const id = str(ev.id);
    if (!id) return "note without an id";
    const at = new Date(iso(ev.dateAdded) ?? this.receivedAt.toISOString());
    this.fact("note.added", at, `ghl:note:${id}`, { contactId: str(ev.contactId) ?? null, payload: { note_id: id, body: typeof ev.body === "string" ? ev.body : null, by: await this.by("contact", str(ev.contactId) ?? "", { note: true }) } });
    return "facts";
  }

  private async user(ev: GhlEvent, type: string): Promise<string> {
    const id = str(ev.id);
    if (!id) return "user without an id";
    const change = type === "UserCreate" ? "created" : type === "UserDelete" ? "deleted" : "updated";
    const name = str(ev.name) ?? ([str(ev.firstName), str(ev.lastName)].filter(Boolean).join(" ") || undefined);
    this.fact("person.changed", this.receivedAt, `ghl:user:${id}:${change}:${this.receivedAt.toISOString()}`, { payload: { change, crm_user_id: id, name: name ?? null, email: str(ev.email)?.toLowerCase() ?? null, by: "crm" } });
    return "facts";
  }
}

/** Looks again for a recording's transcript later (framework/transcripts.ts). */
async function waitForTranscript(hub: Hub, conn: Connection, provider: "ghl", externalId: string, x: { contactId: string | null; recording_id: string }) {
  await scheduleTranscript(hub, { offerId: conn.offerId, connectionId: conn.id, provider, recordingId: externalId, fact: x });
}
