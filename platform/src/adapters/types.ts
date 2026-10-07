export type BookingSource = "ghl" | "calendly";
/** Where a company's appointments live. The CRM (GHL calendars) or a separate scheduler (Calendly event types). */
/** Per-calendar booking rules (D24): how setter-vs-self is decided on this calendar, and which booking question answers what. */
export type CalendarConfig = { booking?: "self" | "setter" | "question"; questions?: Record<string, string> };
export type BookingConfig =
  | { source: "ghl"; calendars?: Record<string, CalendarConfig> }
  | { source: "calendly"; token: string; organization: string; user?: string; phoneQuestion?: string; setterQuestion?: string; calendars?: Record<string, CalendarConfig> };
export type Company = { id: string; locationId: string; pit: string; timezone: string; booking: BookingConfig };

export type ContactSnapshot = { id: string; firstName?: string; lastName?: string; email?: string; phone?: string; timezone?: string; tags: string[]; customFields: Record<string, unknown>; dateUpdated: string; dateAdded: string };
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
export type MessageSnapshot = { id: string; conversationId: string; contactId: string; channel: "sms" | "email"; direction: "inbound" | "outbound"; body?: string; subject?: string; status?: string; dateAdded: string };
export type OppSnapshot = { id: string; contactId: string; pipelineId: string; stageId: string; status: string; monetaryValue?: number; updatedAt: string };
/** `questions`: the booking form as the source defines it (name, type, position, choices), so settings can offer "this question means …" instead of asking for the text. `hosts`: who the calendar belongs to. */
export type CalendarSnapshot = { id: string; name: string; teamMemberIds: string[]; bookingUrl?: string; note?: string; active?: boolean; questions?: { name: string; type?: string; position?: number; required?: boolean; choices?: string[] }[]; hosts?: { name: string; email: string }[]; pooling?: string };
export type UserSnapshot = { id: string; email?: string; name: string };

export interface CrmRead {
  contactsChangedSince(c: Company, sinceIso: string): Promise<ContactSnapshot[]>;
  inboundSince(c: Company, sinceIso: string): Promise<MessageSnapshot[]>;
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
}
export type ContactWrite = { firstName?: string; lastName?: string; phone?: string; timezone?: string; assignedUserId?: string; customFields?: { id: string; field_value: string }[] };
/** A pipeline card as the CRM sees it. `customFields` are CRM field ids with already-rendered values. */
export type OpportunityWrite = { pipelineId: string; stageId: string; name: string; status: "open" | "won" | "lost" | "abandoned"; assignedUserId?: string; customFields?: { id: string; field_value: string }[] };
export type SendResult = { externalId: string; accepted: boolean; error?: string };
export interface Sender {
  sendSms(c: Company, contactId: string, body: string): Promise<SendResult>;
  sendEmail(c: Company, contactId: string, subject: string, html: string): Promise<SendResult>;
  deliveryStatus(c: Company, externalId: string): Promise<{ status: string; error?: string }>;
}
export type Classification = { value: string; confidence: number; distribution: Record<string, number>; unclear: boolean };
export interface Classifier {
  choice(state: string | undefined, input: string, options: string[], threshold: number): Promise<Classification>;
}
export interface Notifier {
  post(token: string, channelId: string, text: string): Promise<{ ts: string }>;
}
/** A long-form read of a document (a call transcript) against an instruction, answered as text or as JSON. */
export type AnalysisRequest = { system: string; input: string; format: "json" | "text"; maxTokens?: number; model?: string };
export type AnalysisResult = { text: string; parsed?: unknown; parseError?: string; repaired?: boolean; refused?: string; model: string; usage: { input: number; output: number; cacheRead: number } };
export interface Analyst {
  analyze(apiKey: string, req: AnalysisRequest): Promise<AnalysisResult>;
}
export type Adapters = { read: CrmRead; booking: Record<BookingSource, BookingRead>; write: CrmWrite; sender: Sender; classifier: Classifier; notifier: Notifier; analyst: Analyst };
export const bookingFor = (a: Adapters, c: Company): BookingRead => a.booking[c.booking.source];
