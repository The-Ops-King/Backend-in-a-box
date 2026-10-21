import type { CrmContact } from "@/engine/ports";
import type { FieldMap } from "../framework/field-map";
import type { J } from "../framework/types";

/**
 * GHL's objects as GHL sends them (in webhooks and API answers), read once here. The shapes are modelled on v1's
 * verified reads (platform/src/adapters/ghl/read.ts, ghl/02-api-facts.md) and GHL's webhook docs; what the Phase 0
 * checks have not yet confirmed against a real delivery is marked UNVERIFIED where it is read.
 */

export const isObj = (v: unknown): v is J => typeof v === "object" && v !== null && !Array.isArray(v);
export const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : typeof v === "number" ? String(v) : undefined);
export const num = (v: unknown): number | undefined => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? undefined : Number(v));
export const iso = (v: unknown): string | undefined => {
  if (typeof v === "number") return new Date(v > 1e12 ? v : v * 1000).toISOString();
  const s = str(v);
  if (!s) return undefined;
  const t = Date.parse(s);
  return Number.isNaN(t) ? undefined : new Date(t).toISOString();
};

export type RawContact = J & {
  id: string; firstName?: string; lastName?: string; name?: string; contactName?: string; email?: string; phone?: string; timezone?: string; tags?: string[];
  assignedTo?: string | null; source?: string; customFields?: { id: string; value?: unknown; field_value?: unknown }[]; dnd?: boolean;
  dndSettings?: Record<string, { status?: string } | null> | null; dateUpdated?: string; dateAdded?: string;
};

/** Do not disturb, per channel: on for everything (`dnd`), or per channel (`dndSettings.SMS.status` active, or permanent after a STOP). */
export function dndOf(c: Pick<RawContact, "dnd" | "dndSettings">): { all?: boolean; sms?: boolean; email?: boolean } {
  const on = (ch: string) => { const s = c.dndSettings?.[ch]?.status; return s === "active" || s === "permanent"; };
  return { ...(c.dnd !== undefined ? { all: c.dnd === true } : {}), ...(c.dndSettings ? { sms: on("SMS"), email: on("Email") } : {}) };
}

export function crmContact(c: RawContact): CrmContact {
  return { id: c.id, phone: str(c.phone) ?? null, email: str(c.email)?.toLowerCase() ?? null, timezone: str(c.timezone) ?? null, dnd: dndOf(c) };
}

/** A contact's custom fields by GHL field id. */
export const customFieldsOf = (c: RawContact): J =>
  Object.fromEntries((c.customFields ?? []).filter((f) => f && f.id).map((f) => [f.id, f.value ?? f.field_value]));

/** The contact as a fact carries it: canonical names, custom fields through the field map. */
export function contactSnapshot(c: RawContact, map: FieldMap): J {
  const first = str(c.firstName), last = str(c.lastName);
  const name = str(c.name) ?? str(c.contactName) ?? ([first, last].filter(Boolean).join(" ") || undefined);
  const out: J = {
    ghl_contact_id: c.id, crm_id: c.id, first_name: first, last_name: last, name, email: str(c.email)?.toLowerCase(), phone: str(c.phone), timezone: str(c.timezone),
    tags: Array.isArray(c.tags) ? c.tags : undefined, source: str(c.source), assigned_user_id: str(c.assignedTo), fields: map.read("contact", customFieldsOf(c)),
  };
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined));
}

export type RawAppointment = J & {
  id: string; calendarId?: string; contactId?: string; assignedUserId?: string; startTime?: string; endTime?: string; title?: string; address?: string;
  appointmentStatus?: string; appoinmentStatus?: string; dateAdded?: string; dateUpdated?: string; source?: string;
};

/** GHL sends the status twice, once misspelt (`appoinmentStatus`, sic); the correct spelling wins. */
export const apptStatus = (a: RawAppointment): string | undefined => str(a.appointmentStatus) ?? str(a.appoinmentStatus);

/** GHL's appointment status as the platform says it: new and confirmed are booked. */
export function canonicalApptStatus(s: string | undefined): string | undefined {
  if (!s) return undefined;
  return s === "new" || s === "confirmed" ? "booked" : s === "completed" ? "showed" : s;
}

/** The platform's appointment status as GHL takes it (GHL refuses no_show and rescheduled; `completed` would store as showed). */
export function ghlApptStatus(s: string): string {
  const m: Record<string, string> = { booked: "confirmed", confirmed: "confirmed", showed: "showed", noshow: "noshow", cancelled: "cancelled", invalid: "invalid", new: "new" };
  const out = m[s];
  if (!out) throw new Error(`GHL has no appointment status for "${s}"`);
  return out;
}

export function appointmentSnapshot(a: RawAppointment, map: FieldMap): J {
  const kind = map.calendarKind(a.calendarId);
  const out: J = {
    starts_at: iso(a.startTime), ends_at: iso(a.endTime), status: canonicalApptStatus(apptStatus(a)), vendor_status: apptStatus(a), calendar_id: str(a.calendarId),
    ...(kind ? { kind, term: { category: kind } } : {}), closer: str(a.assignedUserId) ? { ghl_user_id: str(a.assignedUserId) } : undefined,
    title: str(a.title), meeting_url: str(a.address)?.startsWith("http") ? str(a.address) : undefined, booked_at: iso(a.dateAdded), source: str(a.source),
  };
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined));
}

export type RawOpportunity = J & {
  id: string; contactId?: string; contact?: { id?: string }; pipelineId?: string; pipelineStageId?: string; status?: string; monetaryValue?: number;
  assignedTo?: string | null; name?: string; dateUpdated?: string; updatedAt?: string; lastStageChangeAt?: string; lastStatusChangeAt?: string;
};
export const oppContact = (o: RawOpportunity) => str(o.contactId) ?? str(o.contact?.id);
export const oppUpdated = (o: RawOpportunity) => iso(o.dateUpdated) ?? iso(o.updatedAt) ?? iso(o.lastStatusChangeAt) ?? iso(o.lastStageChangeAt);

/** A message, from a webhook (InboundMessage / OutboundMessage) or a thread read (`TYPE_SMS`, `TYPE_CALL`, ...): one shape. */
export type GhlMessage = { id: string; contactId?: string; conversationId?: string; direction: "inbound" | "outbound"; channel: "sms" | "email" | "call" | "other"; body?: string; subject?: string; at?: string; userId?: string; callStatus?: string; durationSec?: number };

export function messageOf(m: J): GhlMessage | undefined {
  const id = str(m.messageId) ?? str(m.id);
  if (!id) return undefined;
  const type = String(m.messageType ?? m.type ?? "").toUpperCase().replace(/^TYPE_/, "");
  const channel = type === "SMS" ? "sms" : type === "EMAIL" ? "email" : type === "CALL" || type === "PHONE" ? "call" : "other";
  const meta = isObj(m.meta) && isObj(m.meta.call) ? m.meta.call : {};
  return {
    id, contactId: str(m.contactId), conversationId: str(m.conversationId), direction: m.direction === "outbound" ? "outbound" : "inbound", channel,
    body: typeof m.body === "string" ? m.body : undefined, subject: str(m.subject), at: iso(m.dateAdded), userId: str(m.userId),
    callStatus: str(m.callStatus) ?? str(meta.status) ?? str(m.status), durationSec: num(m.callDuration) ?? num(meta.duration),
  };
}

/** A dialer call's outcome in the words the projections read: connected, no_answer, voicemail, busy, failed. */
export function callStatus(m: GhlMessage): string {
  const s = (m.callStatus ?? "").toLowerCase().replace(/[\s_]+/g, "-");
  if ((s === "completed" || s === "answered" || s === "connected") && (m.durationSec ?? 0) > 0) return "connected";
  if (s === "no-answer" || s === "noanswer" || s === "missed") return "no_answer";
  if (s === "voicemail") return "voicemail";
  if (s === "busy") return "busy";
  if (s === "completed") return "no_answer";
  return "failed";
}

/** A sent document's status: GHL's sent | viewed | completed (signed) | voided / declined. */
export function documentStatus(d: J): "sent" | "viewed" | "signed" | "voided" | undefined {
  const s = String(d.status ?? "").toLowerCase();
  const recipients = Array.isArray(d.recipients) ? (d.recipients as J[]) : [];
  if (s === "completed" || s === "signed" || recipients.some((r) => r.hasCompleted === true && (r.entityName === "contacts" || r.role === "signer"))) return "signed";
  if (s === "voided" || s === "void" || s === "declined" || s === "cancelled") return "voided";
  if (s === "viewed") return "viewed";
  if (s === "sent" || s === "draft" || s === "waiting") return "sent";
  return undefined;
}
