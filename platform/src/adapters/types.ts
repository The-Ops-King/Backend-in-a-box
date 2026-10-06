export type Company = { id: string; locationId: string; pit: string; timezone: string };

export type ContactSnapshot = { id: string; firstName?: string; lastName?: string; email?: string; phone?: string; timezone?: string; tags: string[]; customFields: Record<string, unknown>; dateUpdated: string; dateAdded: string };
export type AppointmentSnapshot = { id: string; calendarId: string; contactId: string; assignedUserId?: string; startTime: string; endTime: string; status: string; title?: string; dateUpdated?: string; dateAdded?: string; raw: Record<string, unknown> };
export type MessageSnapshot = { id: string; conversationId: string; contactId: string; channel: "sms" | "email"; direction: "inbound" | "outbound"; body?: string; subject?: string; status?: string; dateAdded: string };
export type OppSnapshot = { id: string; contactId: string; pipelineId: string; stageId: string; status: string; monetaryValue?: number; updatedAt: string };
export type CalendarSnapshot = { id: string; name: string; teamMemberIds: string[] };
export type UserSnapshot = { id: string; email?: string; name: string };

export interface CrmRead {
  contactsChangedSince(c: Company, sinceIso: string): Promise<ContactSnapshot[]>;
  appointmentsInWindow(c: Company, calendarId: string, from: Date, to: Date): Promise<AppointmentSnapshot[]>;
  inboundSince(c: Company, sinceIso: string): Promise<MessageSnapshot[]>;
  opportunitiesSince(c: Company, since: Date): Promise<OppSnapshot[]>;
  getAppointment(c: Company, id: string): Promise<AppointmentSnapshot | null>;
  getContact(c: Company, id: string): Promise<ContactSnapshot | null>;
  listCalendars(c: Company): Promise<CalendarSnapshot[]>;
  listUsers(c: Company): Promise<UserSnapshot[]>;
}
export interface CrmWrite {
  createContact(c: Company, input: { firstName?: string; lastName?: string; email?: string; phone?: string }): Promise<{ id: string }>;
  addTag(c: Company, contactId: string, tag: string): Promise<void>;
  removeTag(c: Company, contactId: string, tag: string): Promise<void>;
  addNote(c: Company, contactId: string, body: string): Promise<void>;
  updateAppointment(c: Company, id: string, patch: Partial<Pick<AppointmentSnapshot, "status" | "assignedUserId" | "startTime" | "endTime" | "title">>): Promise<void>;
}
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
export type Adapters = { read: CrmRead; write: CrmWrite; sender: Sender; classifier: Classifier; notifier: Notifier };
