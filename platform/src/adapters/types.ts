export type BookingSource = "ghl" | "calendly";
/** Where a company's appointments live. The CRM (GHL calendars) or a separate scheduler (Calendly event types). */
/** Per-calendar booking rules (D24): how setter-vs-self is decided on this calendar, and which booking question answers what. */
/** How a calendar's bookings say setter or self (D24); `utm` (D153): a setter's link, utm_medium=setter and utm_content naming them */
export type BookingMode = "self" | "setter" | "question" | "utm";
export type CalendarConfig = { booking?: BookingMode; questions?: Record<string, string> };
export type BookingConfig =
  | { source: "ghl"; calendars?: Record<string, CalendarConfig> }
  | { source: "calendly"; token: string; organization: string; user?: string; phoneQuestion?: string; setterQuestion?: string; calendars?: Record<string, CalendarConfig> };
export type Company = { id: string; locationId: string; pit: string; timezone: string; booking: BookingConfig };

/** One touch as the CRM attributed it (GHL's attributionSource): the ad click or form visit that brought the person, as GHL keeps the values. */
export type Touch = { utmSource?: string; utmMedium?: string; utmCampaign?: string; utmContent?: string; utmTerm?: string; fbclid?: string; medium?: string; sessionSource?: string; url?: string; referrer?: string };
/** The CRM's first and latest touch for a contact. */
export type Attribution = { first?: Touch; last?: Touch };
export type ContactSnapshot = { id: string; firstName?: string; lastName?: string; email?: string; phone?: string; timezone?: string; assignedTo?: string; tags: string[]; source?: string; customFields: Record<string, unknown>; dateUpdated: string; dateAdded: string; attribution?: Attribution;
  /** D188: the CRM will not text them (Do Not Disturb on texts, or on everything); undefined when the CRM did not say */
  smsDnd?: boolean };
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
  /** D242: the conferencing the source was asked to make and could not (Calendly location.status "failed"): its kind, e.g. "zoom" */
  meetingFailed?: string;
  meetingUrl?: string;        // the call's join link when the source carries one (Calendly location.join_url, GHL address): its meeting key (D102) and the link itself (D144)
  cancellation?: { by?: string; reason?: string; byType?: string; at?: string };   // who cancelled, why and when, when the source says
  tracking?: Record<string, string>;            // utm_* and the like, as the source reports them
  rescheduledFrom?: string;   // this booking replaces that external id (same appointment, new time)
  rescheduledTo?: string;     // this cancelled booking was replaced by that external id; the replacement carries the change
  raw: Record<string, unknown>;
};
/** `channel: "call"` is a phone call the CRM logged in the thread: no body, `call` carries what the dialer knew (status, seconds, who dialed). */
/**
 * Audit risk 11: one tick's read of the threads touched since a cursor, oldest first. `more` is set when the tick stopped before the end:
 * the position (a thread's last-message time, ms) the next tick starts after, while the cursor stays where it was.
 */
export type InboundPage = MessageSnapshot[] & { more?: number };
export type MessageSnapshot = { id: string; conversationId: string; contactId: string; channel: "sms" | "email" | "call"; direction: "inbound" | "outbound"; body?: string; subject?: string; status?: string; dateAdded: string; call?: { status: string; durationSec?: number; userId?: string } };
/** An inbound message's words as the CRM holds them (D89): read by id when a step needs them, never stored. An email's body is not read (its subject is), as the poll never read it. */
export type MessageText = { body: string; subject?: string };
/** What the CRM holds for a logged call beyond the thread entry. `transcript` is null when the call was not recorded (or not yet transcribed). */
export type CallMedia = { recordingUrl?: string; transcript: { speaker: string; text: string; timestamp?: string }[] | null };
export type WonOpportunity = { id: string; contactId: string; pipelineId: string; stageId: string; wonAt: string; createdAt: string; monetaryValue?: number; customFields: Record<string, unknown> };
export type ObjectRecord = { id: string; createdAt: string; properties: Record<string, unknown> };
/** A custom object's property: its short key and the CRM's data type (GHL: TEXT, NUMERICAL, MONETORY, SINGLE_OPTIONS, MULTIPLE_OPTIONS, CHECKBOX, DATE, …) when it says. */
export type ObjectField = { key: string; type?: string; options?: { key: string; label?: string }[] };
/** A note on a contact as the CRM keeps it: read when something needs its words, never stored (D89). */
export type ContactNote = { id: string; body: string; dateAdded: string; userId?: string };
/** A contact's card as the CRM shows it right now (D41: the CRM is the truth about cards). */
export type LiveCard = { id: string; pipelineId: string; stageId: string; status: string; name: string; assignedUserId?: string; updatedAt: string; contactId?: string; /** who last touched it, when the CRM says (it usually does not) */ updatedBy?: string; /** when it last changed stage, and its value, when the CRM says */ stageChangedAt?: string; monetaryValue?: number };
export type OppSnapshot = { id: string; contactId: string; pipelineId: string; stageId: string; status: string; monetaryValue?: number; updatedAt: string };
/** `questions`: the booking form as the source defines it (name, type, position, choices), so settings can offer "this question means …" instead of asking for the text. `hosts`: who the calendar belongs to. */
export type CalendarSnapshot = { id: string; name: string; teamMemberIds: string[]; bookingUrl?: string; note?: string; active?: boolean; questions?: { name: string; type?: string; position?: number; required?: boolean; choices?: string[] }[]; hosts?: { name: string; email: string }[]; pooling?: string };
export type UserSnapshot = { id: string; email?: string; name: string };

export interface CrmRead {
  /** `tag` (D117): only contacts carrying it, filtered by the CRM's own search. */
  contactsChangedSince(c: Company, sinceIso: string, tag?: string): Promise<ContactSnapshot[]>;
  inboundSince(c: Company, sinceIso: string, after?: number): Promise<InboundPage>;
  callMedia(c: Company, messageId: string): Promise<CallMedia | null>;
  /** D89: the words of these messages, by message id, read at the moment a step needs them. A thread named for a message is read once for all of
   *  its messages; the rest one by one. A message the CRM no longer has is left out of the map; a CRM that does not answer throws. */
  messageBodies(c: Company, messages: { id: string; conversationId?: string | null }[]): Promise<Map<string, MessageText>>;
  // history (D29 backfill): the same facts the poll sees going forward, read back over a window, once
  contactsAddedBetween(c: Company, from: Date, to: Date): Promise<ContactSnapshot[]>;
  callsBetween(c: Company, from: Date, to: Date): Promise<MessageSnapshot[]>;
  /** D204: every phone call in one contact's conversations, newest first (their whole history, not a window). Optional. */
  contactCalls?(c: Company, contactId: string): Promise<MessageSnapshot[]>;
  wonOpportunities(c: Company, from: Date, to: Date): Promise<WonOpportunity[]>;
  objectRecords(c: Company, objectKey: string): Promise<ObjectRecord[]>;
  /** D205: one record as GHL holds it now, with its owners (to check an owner change took). Optional; null when it is gone. */
  objectRecord?(c: Company, objectKey: string, recordId: string): Promise<(ObjectRecord & { owners: string[] }) | null>;
  /** The properties a custom object has: each key (the last segment of its field key) and the vendor's data type for it; absent where the vendor has no schema read. */
  objectFields?(c: Company, objectKey: string): Promise<ObjectField[]>;
  documents(c: Company): Promise<DocumentSnapshot[]>;
  opportunitiesSince(c: Company, since: Date): Promise<OppSnapshot[]>;
  /** History (D115): the notes on one contact, newest first. */
  contactNotes?(c: Company, contactId: string): Promise<ContactNote[]>;
  /** History (D115): the CRM's contacts carrying this email (a booking whose person the poll never brought in). */
  contactsByEmail?(c: Company, email: string): Promise<ContactSnapshot[]>;
  /** D122: the one contact GHL holds for this email, or this phone (`GET /contacts/search/duplicate`, one of the two per call; verified read-only on RapidCloser 2026-10-16: an email in any case, a phone with or without +1). */
  findDuplicate?(c: Company, by: { email: string } | { phone: string }): Promise<ContactSnapshot | null>;
  /** Every card the CRM holds for one contact, any status. */
  openCards(c: Company, ghlContactId: string): Promise<LiveCard[]>;
  /** Every card on one board, any status, each with its contact (D61: the poll diffs them against the replica to see a hand on a card). */
  pipelineCards(c: Company, pipelineId: string): Promise<LiveCard[]>;
  getContact(c: Company, id: string): Promise<ContactSnapshot | null>;
  listUsers(c: Company): Promise<UserSnapshot[]>;
}
/** Appointments. Implemented by the CRM (GHL calendars) and by Calendly; a company uses exactly one. */
export interface BookingRead {
  listCalendars(c: Company): Promise<CalendarSnapshot[]>;
  /**
   * The calendar's bookings in the window. D234: `delta.known` (event id → the source's own last-changed stamp, as `delta.seen`
   * gave it last time) lets a source that stamps its events skip the ones unchanged since, and the work of reading each one's
   * details; the source fills `delta.seen` with every event in the window. A source that does not stamp leaves `seen` empty.
   */
  appointmentsInWindow(c: Company, calendarId: string, from: Date, to: Date, delta?: { known?: Record<string, string>; seen: Record<string, string> }): Promise<AppointmentSnapshot[]>;
  getAppointment(c: Company, id: string): Promise<AppointmentSnapshot | null>;
  /** D196: cancel the booking at the source (Calendly: the invitee is told by Calendly). Absent: the source's bookings are not ours to cancel. */
  cancel?(c: Company, id: string, reason: string): Promise<void>;
}
export interface CrmWrite {
  createContact(c: Company, input: { firstName?: string; lastName?: string; email?: string; phone?: string; tags?: string[]; customFields?: { id: string; field_value: string }[]; source?: string }): Promise<{ id: string }>;
  addTag(c: Company, contactId: string, tag: string): Promise<void>;
  removeTag(c: Company, contactId: string, tag: string): Promise<void>;
  /** The new note's id, when the CRM gives it (a keyed note step updates it later, D271). */
  addNote(c: Company, contactId: string, body: string): Promise<{ id?: string } | void>;
  /** D271: a note the engine wrote, rewritten in place. Absent: a keyed note is written anew. */
  updateNote?(c: Company, contactId: string, noteId: string, body: string): Promise<void>;
  /** D227: one note off a contact (a call summary written on the wrong person). */
  deleteNote?(c: Company, contactId: string, noteId: string): Promise<void>;
  updateAppointment(c: Company, id: string, patch: Partial<Pick<AppointmentSnapshot, "status" | "assignedUserId" | "startTime" | "endTime" | "title">>): Promise<void>;
  updateContact(c: Company, contactId: string, patch: ContactWrite): Promise<void>;
  /** D266: team members (CRM user ids) added as followers of a contact or a card; ones already following stay. Absent: the CRM has no followers. */
  addFollowers?(c: Company, on: "contact" | "opportunity", id: string, userIds: string[]): Promise<void>;
  createTask(c: Company, contactId: string, task: { title: string; body?: string; dueAt: Date; assignedUserId?: string }): Promise<{ id: string }>;
  createRecord(c: Company, objectKey: string, properties: Record<string, unknown>, ownerUserId?: string): Promise<{ id: string }>;
  updateRecord(c: Company, objectKey: string, recordId: string, properties: Record<string, unknown>, ownerUserId?: string, removeOwnerIds?: string[]): Promise<void>;
  /** D137: the operator's repair route only, and only for a record the engine made. */
  deleteRecord?(c: Company, objectKey: string, recordId: string): Promise<void>;
  /** D142: the operator's undo of what a run made (app/api/admin/runs/undo) */
  deleteOpportunity?(c: Company, opportunityId: string): Promise<void>;
  deleteTask?(c: Company, contactId: string, taskId: string): Promise<void>;
  /** D142: a test contact removed (app/api/admin/contact/remove-test); GHL takes its cards, tasks and notes with it */
  deleteContact?(c: Company, contactId: string): Promise<void>;
  relateRecords(c: Company, associationId: string, firstRecordId: string, secondRecordId: string): Promise<void>;
  createOpportunity(c: Company, input: OpportunityWrite & { contactId: string }): Promise<{ id: string }>;
  updateOpportunity(c: Company, id: string, patch: Partial<OpportunityWrite>): Promise<void>;
  /** Documents & Contracts: create a document from a template and send it to the contact, from `userId`. Needs the token's documents send scope. */
  sendDocumentTemplate(c: Company, input: { templateId: string; contactId: string; userId?: string }): Promise<{ id: string }>;
}
export type ContactWrite = { firstName?: string; lastName?: string; email?: string; phone?: string; timezone?: string; assignedUserId?: string; customFields?: { id: string; field_value: string }[] };
/** A pipeline card as the CRM sees it. `customFields` are CRM field ids with already-rendered values. */
export type OpportunityWrite = { pipelineId: string; stageId: string; name: string; status: "open" | "won" | "lost" | "abandoned"; assignedUserId?: string; customFields?: { id: string; field_value: string }[]; monetaryValue?: number };
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
export type Classification = { value: string; confidence: number; distribution: Record<string, number>; unclear: boolean; ambiguity?: number };
/** What a classify step hands the classifier besides the question: the company's key, what each option means, and how much doubt is too much (D47). */
export type ChoiceOptions = { apiKey?: string; criteria?: Record<string, string>; ambiguityMax?: number; model?: string; question?: string };
export interface Classifier {
  choice(state: string | undefined, input: string, options: string[], threshold: number, opts?: ChoiceOptions): Promise<Classification>;
  /** D272: typed questions (choice | noul | score) against a state, each answer as Jev gives it; a failure is said, never thrown */
  ask?(apiKey: string, state: Record<string, unknown>, questions: Record<string, Record<string, unknown>>): Promise<{ answers: Record<string, Record<string, unknown>> } | { error: string }>;
}
/** Who the post appears to come from (Slack `chat:write.customize`): a display name and an emoji (":calendar:") or an image URL. Blank = the app itself. */
/** Who a post appears from. `icon` is an emoji (`:tada:`), an image URL, or a list of either: one is picked at random per post. */
export type SlackPersona = { name?: string; icon?: string | string[] };
/** One Slack Block Kit block, as Slack takes it (D93: a section of text, the actions row of buttons, a context line). */
export type SlackBlock = Record<string, unknown> & { type: string };
export interface Notifier {
  /** `threadTs` replies in that message's thread instead of posting to the channel. `blocks` (D93): Block Kit layout; `text` stays the notification and fallback. */
  post(token: string, channelId: string, text: string, as?: SlackPersona, threadTs?: string, blocks?: SlackBlock[]): Promise<{ ts: string; channel?: string }>;
  /** views.open (D200): a form for the person who pressed, with the press's trigger_id (good for three seconds). Optional. */
  openView?(token: string, triggerId: string, view: Record<string, unknown>): Promise<void>;
  /** chat.update: rewrite a message the bot posted (needs chat:write). Optional: a notifier without it posts anew. `blocks` replaces the message's blocks (an empty list takes them off). */
  update?(token: string, channelId: string, ts: string, text: string, blocks?: SlackBlock[]): Promise<void>;
  /** Slack user id for an email (users.lookupByEmail; needs users:read.email), null when unknown. A DM is a post to that id. */
  lookupUserByEmail(token: string, email: string): Promise<string | null>;
  /** reactions.add on a message (needs reactions:write). Resolves false, never throws, when the scope is missing. */
  react(token: string, channelId: string, ts: string, emoji: string): Promise<boolean>;
  /** reactions.remove: takes back one of the bot's own reactions. Resolves false, never throws. */
  unreact(token: string, channelId: string, ts: string, emoji: string): Promise<boolean>;
  /** auth.test: is the token alive, and who is it. */
  authTest(token: string): Promise<{ ok: boolean; team?: string; user?: string; error?: string }>;
  /** conversations.info: does the channel exist and is the bot in it. */
  channelInfo(token: string, channelId: string): Promise<{ ok: boolean; name?: string; member?: boolean; error?: string; needed?: string }>;
  /** users.info: a Slack user's email (needs users:read.email), null when Slack does not say. Optional: the bot falls back to asking who they are. */
  userEmail?(token: string, userId: string): Promise<string | null>;
  /** conversations.members (channels:read / groups:read): who is in a channel, null when Slack will not say (a private channel the bot is not in). */
  channelMembers?(token: string, channelId: string): Promise<string[] | null>;
}
/** A long-form read of a document (a call transcript) against an instruction, answered as text or as JSON. */
export type AnalysisRequest = { system: string; input: string; format: "json" | "text"; maxTokens?: number; model?: string };
export type AnalysisResult = { text: string; parsed?: unknown; parseError?: string; repaired?: boolean; refused?: string; model: string; usage: { input: number; output: number; cacheRead: number } };
export interface Analyst {
  analyze(apiKey: string, req: AnalysisRequest): Promise<AnalysisResult>;
}
/** The Slack bot's model (D70): one turn of a tool-use conversation. `content` goes back verbatim as the assistant turn; tool results go back as a user turn. */
export type BotToolCall = { id: string; name: string; input: Record<string, unknown> };
export type BotTurn = { text: string; calls: BotToolCall[]; stop: string; content: unknown[] };
export type BotMessage = { role: "user" | "assistant"; content: string | unknown[] };
export type BotToolDef = { name: string; description: string; input_schema: Record<string, unknown> };
export interface BotModel {
  next(apiKey: string, req: { system: string; tools: BotToolDef[]; messages: BotMessage[] }): Promise<BotTurn>;
}
/** D87: a meeting recorder a transcript is read back from when a step needs it (Fathom); the engine never keeps one. Null when it has none. */
export interface Recorder {
  transcript(apiKey: string, recordingId: string): Promise<{ speaker: string; email?: string; text: string; timestamp?: string }[] | null>;
  /** History (D115): the meetings recorded between two times, as the provider's own objects (Fathom's Meeting), without transcripts. */
  meetings?(apiKey: string, from: Date, to: Date): Promise<Record<string, unknown>[]>;
}
export type Adapters = { read: CrmRead; booking: Record<BookingSource, BookingRead>; write: CrmWrite; sender: Sender; classifier: Classifier; notifier: Notifier; analyst: Analyst; bot?: BotModel; recorder?: Recorder };
export const bookingFor = (a: Adapters, c: Company): BookingRead => a.booking[c.booking.source];
