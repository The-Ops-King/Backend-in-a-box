import { z } from "zod";
import { normEmail } from "@/engine/gate";
import type { AppointmentRow, ContactRow } from "@/projections/tables";
import type { Hub } from "./hub";
import type { J } from "./types";

/**
 * Which contact (and which booking) a meeting recording is: v1's ladder, most reliable first, one unambiguous hit or
 * nothing. A miss is `recording.unlinked`, which the team links by hand.
 *
 * 1. **email**: an invitee email that is a known contact (the team's own emails, the recorder's and invitees Fathom marks
 *    internal taken out). The booking is that contact's one live booking with the recording's meeting link, else their
 *    live booking nearest the recording; either within `recordings.match.appointment_window_hours`.
 * 2. **meeting link**: exactly one live booking of the offer has the recording's meeting link (one key per meeting:
 *    a Zoom id, a Meet code, else the link without its query), starting within `recordings.match.appointment_window_hours`.
 *    A link several bookings share (a personal meeting room) says nothing.
 * 3. **name**: an invitee's name is exactly one contact's name, after normalising case, spaces and punctuation.
 * 4. **the closer's calendar**: the recorder is a team member, with exactly one live booking of theirs starting within
 *    `recordings.match.calendar_window_min` of the recording; or several, the nearest within `recordings.match.on_time_min`
 *    and every other at least `recordings.match.clear_gap_min` away (back-to-back calls).
 *
 * The thresholds are the offer's typed settings, never written in: while one is unset (or not of its type) the rung that
 * reads it is not tried, and the fact says so (`rungs_off`). Email and name need no setting; without the window, a contact
 * they find is linked without a booking.
 */

export const RECORDING_MATCH_SETTINGS = {
  "recordings.match.appointment_window_hours": { type: z.number().positive(), what: "How far (hours) a booking's start may be from a recording's start and still be the call recorded: the meeting-link rung, and which booking a contact matched by email or name is on.", v1: "24 (APPOINTMENT_WINDOW_H), written in code" },
  "recordings.match.calendar_window_min": { type: z.number().positive(), what: "The closer's-calendar rung: how far (minutes) from the recording's start the recorder's bookings are looked at.", v1: "120 (CALENDAR_WINDOW_MIN), written in code" },
  "recordings.match.on_time_min": { type: z.number().min(0), what: "The closer's-calendar rung, back-to-back calls: the nearest booking is the one recorded when it starts within this many minutes of the recording...", v1: "15 (ON_TIME_MIN), written in code" },
  "recordings.match.clear_gap_min": { type: z.number().min(0), what: "...and every other booking of the recorder's starts at least this many minutes from the recording.", v1: "40 (CLEAR_GAP_MIN), written in code" },
} as const;
export type RecordingMatchSetting = keyof typeof RECORDING_MATCH_SETTINGS;

/** The rungs that read a setting, and what each reads. */
export const RUNG_SETTINGS = {
  meeting: ["recordings.match.appointment_window_hours"],
  calendar: ["recordings.match.calendar_window_min", "recordings.match.on_time_min", "recordings.match.clear_gap_min"],
  booking: ["recordings.match.appointment_window_hours"],
} as const satisfies Record<string, readonly RecordingMatchSetting[]>;

export type Rung = "email" | "meeting" | "name" | "calendar";
export type RecordingMatch = { contactId: string; by: Rung; appointmentId: string | null };
export type RecordingSeen = {
  startedAt: Date;
  /** The call's own join link (Zoom, Meet...), as the recorder reports it. */
  meetingUrl?: string;
  recorder?: { email?: string; name?: string };
  invitees: { name?: string; email?: string; external?: boolean }[];
};
export type MatchResult = {
  match: RecordingMatch | null;
  reason?: string;
  /** The rungs not tried (and the booking not looked for) because a setting they read is unset: "calendar (recordings.match.calendar_window_min)". */
  rungsOff: string[];
  /** The prospects' emails and names, as seen. */
  attendees: string;
};

/**
 * One key per meeting, whichever side reports the link: a Zoom meeting id (`/j/<digits>`), a Google Meet code, otherwise
 * the link without its query (a password or a tracking parameter differs between the booking's copy and the recorder's).
 * Anything that is not an http(s) link (a street address, a phone number) is no key.
 */
export function meetingKey(url?: string | null): string | undefined {
  const s = url?.trim();
  if (!s || !/^https?:\/\//i.test(s)) return undefined;
  let u: URL;
  try { u = new URL(s); } catch { return undefined; }
  const host = u.hostname.toLowerCase().replace(/^www\./, ""), path = u.pathname.replace(/\/+$/, "");
  if (/(^|\.)zoom(gov)?\.(us|com)$/.test(host)) { const id = /^\/(?:j|s|w|wc(?:\/join)?)\/(\d{9,12})(?:\/|$)/.exec(path)?.[1]; if (id) return id; }
  if (host === "meet.google.com") { const code = /^\/([a-z]{3}-[a-z]{4}-[a-z]{3})$/i.exec(path)?.[1]; if (code) return code.toLowerCase(); }
  return `${host}${path}`;
}

export const normName = (n?: string | null): string | undefined => (n ?? "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim() || undefined;

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const isObj = (v: unknown): v is J => !!v && typeof v === "object" && !Array.isArray(v);

/** A setting's value when set and of its type; else undefined (and the rungs that read it are off). */
function matchSetting(settings: J, key: RecordingMatchSetting): number | undefined {
  const v = settings[key];
  if (v === undefined || v === null || v === "") return undefined;
  const r = RECORDING_MATCH_SETTINGS[key].type.safeParse(v);
  return r.success ? r.data : undefined;
}

const contactName = (c: ContactRow): string | undefined => {
  const a = c.attrs as J;
  const parts = [str(a.first_name), str(a.last_name)].filter(Boolean).join(" ");
  return normName(parts || str(a.name));
};
const live = (a: AppointmentRow) => a.status !== "cancelled" && !!a.startsAt;
const offMs = (a: AppointmentRow, at: Date) => Math.abs(a.startsAt!.getTime() - at.getTime());

export async function matchRecording(hub: Hub, offerId: string, r: RecordingSeen): Promise<MatchResult> {
  const settings = await hub.store.tx((tx) => tx.settings(offerId)) as J;
  const s = Object.fromEntries((Object.keys(RECORDING_MATCH_SETTINGS) as RecordingMatchSetting[]).map((k) => [k, matchSetting(settings, k)])) as Record<RecordingMatchSetting, number | undefined>;
  const missing = (rung: keyof typeof RUNG_SETTINGS) => RUNG_SETTINGS[rung].filter((k) => s[k] === undefined);
  const rungsOff = (Object.keys(RUNG_SETTINGS) as (keyof typeof RUNG_SETTINGS)[]).filter((x) => missing(x).length).map((x) => `${x} (${missing(x).join(", ")})`);
  const windowMs = s["recordings.match.appointment_window_hours"] !== undefined ? s["recordings.match.appointment_window_hours"] * 3_600_000 : undefined;

  // the prospects: the people on the call who are not the team
  const staff = await hub.staffEmails(offerId);
  const recorder = normEmail(r.recorder?.email);
  if (recorder) staff.add(recorder);
  const emails: string[] = [], names: string[] = [], staffDropped: string[] = [];
  for (const i of r.invitees) {
    const e = normEmail(i.email) || undefined;
    if (e && (staff.has(e) || i.external === false)) { staffDropped.push(e); continue; }
    if (e && !emails.includes(e)) emails.push(e);
    if (i.name && i.external !== false && !names.includes(i.name)) names.push(i.name);
  }
  const attendees = [...emails, ...names].join(", ");
  const result = (match: RecordingMatch | null, reason?: string): MatchResult => ({ match, ...(reason ? { reason } : {}), rungsOff, attendees });

  const [appts, contacts, people] = await hub.store.tx(async (tx) => [await tx.projFind("appointments", offerId), await tx.projFind("contacts_index", offerId), await tx.projFind("people", offerId)] as const);
  const key = meetingKey(r.meetingUrl);
  const keyed = key ? appts.filter((a) => live(a) && meetingKey(str((a.attrs as J).meeting_url)) === key) : [];
  /** The booking a contact found by email or name is on: their one booking with the meeting link, else their nearest; within the window. */
  const bookingOf = (contactId: string): string | null => {
    if (windowMs === undefined) return null;
    const mine = keyed.filter((a) => a.contactId === contactId);
    if (mine.length === 1 && offMs(mine[0]!, r.startedAt) <= windowMs) return mine[0]!.id;
    const near = appts.filter((a) => a.contactId === contactId && live(a) && offMs(a, r.startedAt) <= windowMs).sort((a, b) => offMs(a, r.startedAt) - offMs(b, r.startedAt))[0];
    return near?.id ?? null;
  };

  // 1. email: a contact's email is theirs alone, so a hit is exact
  const byEmail = new Set<string>();
  for (const e of emails) { const h = await hub.matchContact(offerId, { email: e }); if (h) byEmail.add(h.id); }
  if (byEmail.size === 1) { const contactId = [...byEmail][0]!; return result({ contactId, by: "email", appointmentId: bookingOf(contactId) }); }
  if (byEmail.size > 1) return result(null, `attendees match ${byEmail.size} different contacts (${emails.join(", ")})`);

  // 2. the meeting link: exact when only one booking has it, and it starts near the recording
  let shared = "";
  if (key && windowMs !== undefined) {
    const hit = keyed.length === 1 && keyed[0]!.contactId && offMs(keyed[0]!, r.startedAt) <= windowMs ? keyed[0]! : undefined;
    if (hit) return result({ contactId: hit.contactId!, by: "meeting", appointmentId: hit.id });
    if (keyed.length > 1) shared = `; its meeting link is on ${keyed.length} bookings`;
  }

  // 3. name: exact after normalising, exactly one contact
  const byName = new Set<string>();
  const liveContacts = contacts.filter((c) => !c.mergedInto);
  for (const n of names.map(normName).filter((x): x is string => !!x)) {
    const rows = liveContacts.filter((c) => contactName(c) === n);
    if (rows.length === 1) byName.add(rows[0]!.id);
    else if (rows.length > 1) return result(null, `"${n}" is the name of ${rows.length} contacts${shared}`);
  }
  if (byName.size === 1) { const contactId = [...byName][0]!; return result({ contactId, by: "name", appointmentId: bookingOf(contactId) }); }
  if (byName.size > 1) return result(null, `attendee names match ${byName.size} different contacts${shared}`);

  // 4. the closer's calendar: the recorder is a team member, with one booking near the recording's start
  const closer = recorder ? people.find((p) => p.active && normEmail(p.email) === recorder) : undefined;
  const calWin = s["recordings.match.calendar_window_min"], onTime = s["recordings.match.on_time_min"], clearGap = s["recordings.match.clear_gap_min"];
  if (closer && calWin !== undefined && onTime !== undefined && clearGap !== undefined) {
    const theirs = (a: AppointmentRow) => {
      const c = (a.attrs as J).closer;
      if (closer.crmUserId && (a.closerKey === `crm:${closer.crmUserId}` || (isObj(c) && (str(c.ghl_user_id) ?? str(c.crm_user_id)) === closer.crmUserId))) return true;
      return isObj(c) && normEmail(str(c.email)) === recorder;
    };
    const near = appts.filter((a) => live(a) && a.contactId && theirs(a) && offMs(a, r.startedAt) <= calWin * 60_000).sort((a, b) => offMs(a, r.startedAt) - offMs(b, r.startedAt));
    if (near.length === 1) return result({ contactId: near[0]!.contactId!, by: "calendar", appointmentId: near[0]!.id });
    // back-to-back calls are normal: the call the recording started on is the one beginning right then, when the next nearest is clearly another slot
    if (near.length > 1 && offMs(near[0]!, r.startedAt) <= onTime * 60_000 && offMs(near[1]!, r.startedAt) >= clearGap * 60_000) return result({ contactId: near[0]!.contactId!, by: "calendar", appointmentId: near[0]!.id });
    if (near.length > 1) return result(null, `the closer had ${near.length} bookings within ${calWin} minutes of this recording, none clearly the one it started on${shared}`);
  }
  const why = emails.length || names.length
    ? `nobody in the CRM matches ${attendees}${closer && calWin !== undefined ? "; no booking on the closer's calendar near the start" : ""}`
    : staffDropped.length ? `every attendee is staff (${staffDropped.join(", ")})` : "no attendees on the recording";
  return result(null, why + shared);
}
