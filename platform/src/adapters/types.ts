export type BookingSource = "ghl" | "calendly";
/** Where a company's appointments live. The CRM (GHL calendars) or a separate scheduler (Calendly event types). */
/** Per-calendar booking rules (D24): how setter-vs-self is decided on this calendar, and which booking question answers what. */
export type CalendarConfig = { booking?: "self" | "setter" | "question"; questions?: Record<string, string> };
export type BookingConfig =
  | { source: "ghl"; calendars?: Record<string, CalendarConfig> }
  | { source: "calendly"; token: string; organization: string; user?: string; phoneQuestion?: string; setterQuestion?: string; calendars?: Record<string, CalendarConfig> };
export type Company = { id: string; locationId: string; pit: string; timezone: string; booking: BookingConfig };

export type ContactSnapshot = { id: string; firstName?: string; lastName?: string; email?: string; phone?: string; timezone?: string; assignedTo?: string; tags: string[]; customFields: Record<string, unknown>; dateUpdated: string; dateAdded: string };
/** A Documents & Contracts document as the CRM lists it (D30). `contactId` is the primary signer. */
export type DocumentSnapshot = { id: string; name?: string; status: string; contactId?: string; createdAt: string; updatedAt?: string; signedAt?: string; raw?: Record<string, unknown> };
/** One booking as the source reports it. `contactId` when the source is the CRM; `invitee` identity when it is not. */
export type AppointmentSnapshot = {
  id: string; calendarId: string;
  contactId?: string;
  invitee?: { email?: string; phone?: string; firstName?: string; lastName?: string; timezone?: string };
  assignedUserId?: string; assignedUserEmail?: string;
  startTime: string; endTime: string; status: string; title?: string; dateUpdated?: string; dateAdded?: string;
  setBy?: string;             // the setter's name when the source carries it (Calendly question on the setter event type)
  answers?: Record<string, string>;   // booking-form answers keyed by the name the calendar config gave them
  rescheduleUrl?: string; cancelUrl?: string;   // per-booking self-service links when the source has them (Calendly)
  cancellation?: { by?: string; reason?: string; byType?: string };   // who cancelled and why, when the source says
  tracking?: Record<string, string>;            // utm_* and the like, as the source reports them
  rescheduledFrom?: string;   // this booking replaces that external id (same appointment, new time)
  rescheduledTo?: string;     // this cancelled booking was replaced by that external id; the replacement carries the change
  raw: Record<string, unknown>;
};
/** `channel: "call"` is a phone call the CRM logged in the thread: no body, `call` carries what the dialer knew (status, seconds, who dialed). */
export type MessageSnapshot = { id: string; conversationId: string; contactId: string; channel: "sms" | "email" | "call"; direction: "inbound" | "outbound"; body?: string; subject?: string; status?: string; dateAdded: string; call?: { status: string; durationSec?: number; userId?: string } };
/** What the CRM holds for a logged call beyond the thread entry. `transcript` is null when the call was not recorded (or not yet transcribed). */
export type CallMedia = { recordingUrl?: string; transcript: { speaker: string; text: string; timestamp?: string }[] | null };
export type WonOpportunity = { id: string; contactId: string; pipelineId: string; stageId: string; wonAt: string; createdAt: string; monetaryValue?: number; customFields: Record<string, unknown> };
export type ObjectRecord = { id: string; createdAt: string; properties: Record<string, unknown> };
export type OppSnapshot = { id: string; contactId: string; pipelineId: string; stageId: string; status: string; monetaryValue?: number; updatedAt: string };
/** `questions`: the booking form as the source defines it (name, type, position, choices), so settings can offer "this question means …" instead of asking for the text. `hosts`: who the calendar belongs to. */
export type CalendarSnapshot = { id: string; name: string; teamMemberIds: string[]; bookingUrl?: string; note?: string; active?: boolean; questions?: { name: string; type?: string; position?: number; required?: boolean; choices?: string[] }[]; hosts?: { name: string; email: string }[]; pooling?: string };
export type UserSnapshot = { id: string; email?: string; name: string };

export interface CrmRead {
  contactsChangedSince(c: Company, sinceIso: string): Promise<ContactSnapshot[]>;
  inboundSince(c: Company, sinceIso: string): Promise<MessageSnapshot[]>;
  callMedia(c: Company, messageId: string): Promise<CallMedia | null>;
  // history (D29 backfill): the same facts the poll sees going forward, read back over a window, once
  contactsAddedBetween(c: Company, from: Date, to: Date): Promise<ContactSnapshot[]>;
  callsBetween(c: Company, from: Date, to: Date): Promise<MessageSnapshot[]>;
  wonOpportunities(c: Company, from: Date, to: Date): Promise<WonOpportunity[]>;
  objectRecords(c: Company, objectKey: string): Promise<ObjectRecord[]>;
  documents(c: Company): Promise<DocumentSnapshot[]>;
  opportunitiesSince(c: Company, since: Date): Promise<OppSnapshot[]>;
  getContact(c: Company, id: string): Promise<ContactSnapshot | null>;
  listUsers(c: Company): Promise<UserSnapshot[]>;
}
/** Appointments. Implemented by the CRM (GHL calendars) and by Calendly; a company uses exactly one. */
export interface BookingRead {
  listCalendars(c: Company): Promise<CalendarSnapshot[]>;
  appointmentsInWindow(c: Company, calendarId: string, from: Date, to: Date): Promise<AppointmentSnapshot[]>;
  getAppointment(c: Company, id: string): Promise<AppointmentSnapshot | null>;
}
export interface CrmWrite {
  createContact(c: Company, input: { firstName?: string; lastName?: string; email?: string; phone?: string }): Promise<{ id: string }>;
  addTag(c: Company, contactId: string, tag: string): Promise<void>;
  removeTag(c: Company, contactId: string, tag: string): Promise<void>;
  addNote(c: Company, contactId: string, body: string): Promise<void>;
  updateAppointment(c: Company, id: string, patch: Partial<Pick<AppointmentSnapshot, "status" | "assignedUserId" | "startTime" | "endTime" | "title">>): Promise<void>;
  updateContact(c: Company, contactId: string, patch: ContactWrite): Promise<void>;
  createTask(c: Company, contactId: string, task: { title: string; body?: string; dueAt: Date; assignedUserId?: string }): Promise<{ id: string }>;
  createRecord(c: Company, objectKey: string, properties: Record<string, unknown>, ownerUserId?: string): Promise<{ id: string }>;
  updateRecord(c: Company, objectKey: string, recordId: string, properties: Record<string, unknown>, ownerUserId?: string): Promise<void>;
  relateRecords(c: Company, associationId: string, firstRecordId: string, secondRecordId: string): Promise<void>;
  createOpportunity(c: Company, input: OpportunityWrite & { contactId: string }): Promise<{ id: string }>;
  updateOpportunity(c: Company, id: string, patch: Partial<OpportunityWrite>): Promise<void>;
  /** Documents & Contracts: create a document from a template and send it to the contact, from `userId`. Needs the token's documents send scope. */
  sendDocumentTemplate(c: Company, input: { templateId: string; contactId: string; userId?: string }): Promise<{ id: string }>;
}
export type ContactWrite = { firstName?: string; lastName?: string; phone?: string; timezone?: string; assignedUserId?: string; customFields?: { id: string; field_value: string }[] };
/** A pipeline card as the CRM sees it. `customFields` are CRM field ids with already-rendered values. */
export type OpportunityWrite = { pipelineId: string; stageId: string; name: string; status: "open" | "won" | "lost" | "abandoned"; assignedUserId?: string; customFields?: { id: string; field_value: string }[] };
export type SendResult = { externalId: string; accepted: boolean; error?: string };
export interface Sender {
  sendSms(c: Company, contactId: string, body: string): Promise<SendResult>;
  sendEmail(c: Company, contactId: string, subject: string, html: string): Promise<SendResult>;
  /** An email built from one of the CRM's own email templates, so the team edits copy in the CRM (D30). */
  sendEmailTemplate(c: Company, contactId: string, templateId: string): Promise<SendResult>;
  /** The body of one of the CRM's SMS snippets, rendered by the engine before sending. Null when it does not exist. */
  smsTemplateBody(c: Company, templateId: string): Promise<string | null>;
  deliveryStatus(c: Company, externalId: string): Promise<{ status: string; error?: string }>;
}
export type Classification = { value: string; confidence: number; distribution: Record<string, number>; unclear: boolean };
export interface Classifier {
  choice(state: string | undefined, input: string, options: string[], threshold: number): Promise<Classification>;
}
/** Who the post appears to come from (Slack `chat:write.customize`): a display name and an emoji (":calendar:") or an image URL. Blank = the app itself. */
/** Who a post appears from. `icon` is an emoji (`:tada:`), an image URL, or a list of either: one is picked at random per post. */
export type SlackPersona = { name?: string; icon?: string | string[] };
export interface Notifier {
  /** `threadTs` replies in that message's thread instead of posting to the channel. */
  post(token: string, channelId: string, text: string, as?: SlackPersona, threadTs?: string): Promise<{ ts: string }>;
  /** Slack user id for an email (users.lookupByEmail; needs users:read.email), null when unknown. A DM is a post to that id. */
  lookupUserByEmail(token: string, email: string): Promise<string | null>;
}
/** A long-form read of a document (a call transcript) against an instruction, answered as text or as JSON. */
export type AnalysisRequest = { system: string; input: string; format: "json" | "text"; maxTokens?: number; model?: string };
export type AnalysisResult = { text: string; parsed?: unknown; parseError?: string; repaired?: boolean; refused?: string; model: string; usage: { input: number; output: number; cacheRead: number } };
export interface Analyst {
  analyze(apiKey: string, req: AnalysisRequest): Promise<AnalysisResult>;
}
export type Adapters = { read: CrmRead; booking: Record<BookingSource, BookingRead>; write: CrmWrite; sender: Sender; classifier: Classifier; notifier: Notifier; analyst: Analyst };
export const bookingFor = (a: Adapters, c: Company): BookingRead => a.booking[c.booking.source];
