/**
 * D365 (Tyler, 2026-11-24: "if the recording doesn't exist we should assume it's a no-show ... but we really want to make sure
 * we're not falsely inputting them"): Zoom says whether the prospect was on the call; the recording is only what was said.
 * Every join and leave of an offer's Zoom meetings is kept; when a meeting ends, the booking it was for (the appointment's Zoom
 * meeting id, nearest in time) gets a verdict and `zoom.meeting_ended` is fired:
 *   held     — a prospect was there 5 minutes or more
 *   no_show  — only the team or note-taker bots joined
 *   unclear  — a prospect joined briefly (to say they must rebook): Zoom says nothing either way
 * The same rule as the TRC dashboard's Sales tracker (HELD_MINUTES 5, the team and bots are not prospects).
 */
import type { PoolClient } from "pg";
import { many, one } from "@/db/client";
import { emitEvent, dispatchEvent } from "./dispatch";
import { ZOOM_BOT, type ZoomEvent } from "./webhooks/zoom";

export const HELD_MINUTES = 5;
/** How far a meeting's start may be from its booking's and still be that booking's call (late starts, early joins, the PMR). */
const NEAR_MS = 3 * 3600_000;

export async function recordZoomEvent(c: PoolClient, companyId: string, e: ZoomEvent): Promise<boolean> {
  const row = e.kind === "participant"
    ? [companyId, e.meetingId, e.uuid, e.event, e.key, e.email, e.name, e.at, e.topic, e.meetingStart]
    : [companyId, e.meetingId, e.uuid, "ended", "", null, null, e.endedAt, e.topic, e.meetingStart];
  const r = await one(c, `insert into zoom_events (company_id, meeting_id, instance_uuid, kind, participant_key, email, name, at, topic, meeting_start)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) on conflict do nothing returning id`, row);
  return !!r;
}

type Person = { key: string; name: string | null; email: string | null; minutes: number; team: boolean; bot: boolean };

/** Who was in one meeting and for how long (rejoins added up; a join with no leave runs to the end). */
export async function attendance(c: PoolClient, companyId: string, uuid: string, endedAt: Date): Promise<Person[]> {
  const rows = await many<{ kind: string; participant_key: string; email: string | null; name: string | null; at: Date }>(c,
    "select kind, participant_key, email, name, at from zoom_events where company_id=$1 and instance_uuid=$2 and kind in ('joined','left') order by at", [companyId, uuid]);
  const team = await many<{ email: string | null; name: string | null }>(c, "select lower(email) as email, lower(name) as name from users where company_id=$1", [companyId]);
  const emails = new Set(team.map((t) => t.email).filter(Boolean)), names = new Set(team.map((t) => t.name).filter(Boolean));
  const people = new Map<string, Person & { since: number | null }>();
  for (const r of rows) {
    const p = people.get(r.participant_key) ?? { key: r.participant_key, name: r.name, email: r.email, minutes: 0, since: null, team: false, bot: false };
    p.name ??= r.name; p.email ??= r.email;
    const t = r.at.getTime();
    if (r.kind === "joined") p.since ??= t;
    else if (p.since !== null) { p.minutes += (t - p.since) / 60_000; p.since = null; }
    people.set(r.participant_key, p);
  }
  return [...people.values()].map(({ since, ...p }) => {
    const minutes = p.minutes + (since !== null ? Math.max(0, endedAt.getTime() - since) / 60_000 : 0);
    const team = (!!p.email && emails.has(p.email)) || (!!p.name && names.has(p.name.toLowerCase()));
    return { ...p, minutes: Math.round(minutes * 10) / 10, team, bot: !team && ZOOM_BOT.test(`${p.name ?? ""} ${p.email ?? ""}`) };
  });
}

export type Verdict = "held" | "no_show" | "unclear";
export const verdictOf = (people: Person[]): { verdict: Verdict; prospects: Person[] } => {
  const prospects = people.filter((p) => !p.team && !p.bot);
  const verdict: Verdict = prospects.some((p) => p.minutes >= HELD_MINUTES) ? "held" : prospects.length ? "unclear" : "no_show";
  return { verdict, prospects };
};

/** The booking a meeting was for: the same Zoom meeting id, the nearest start within 3 hours. */
export const bookingFor = (c: PoolClient, companyId: string, meetingId: string, at: Date) =>
  one<{ id: string; contact_id: string | null; opportunity_id: string | null; starts_at: Date; status: string; category: string | null }>(c,
    `select a.id, a.contact_id, a.opportunity_id, a.starts_at, a.status, t.category from appointments a left join company_terms t on t.id=a.appointment_term
     where a.company_id=$1 and a.meeting_key=$2 and a.starts_at between $3::timestamptz - make_interval(secs => $4) and $3::timestamptz + make_interval(secs => $4)
     order by abs(extract(epoch from a.starts_at - $3::timestamptz)) limit 1`, [companyId, meetingId, at, NEAR_MS / 1000]);

/** A meeting ended: its verdict on the booking it was for, as `zoom.meeting_ended`. Nothing for a meeting no booking has. */
export async function meetingEnded(c: PoolClient, companyId: string, e: Extract<ZoomEvent, { kind: "ended" }>): Promise<{ booking: string | null; verdict?: Verdict; started?: number }> {
  const firstJoin = await one<{ at: Date }>(c, "select min(at) as at from zoom_events where company_id=$1 and instance_uuid=$2 and kind='joined'", [companyId, e.uuid]);
  const appt = await bookingFor(c, companyId, e.meetingId, e.meetingStart ?? firstJoin?.at ?? e.endedAt);
  if (!appt) return { booking: null };
  const people = await attendance(c, companyId, e.uuid, e.endedAt);
  const { verdict, prospects } = verdictOf(people);
  const data = { meeting_id: e.meetingId, instance_uuid: e.uuid, topic: e.topic, verdict, prospect_joined: verdict === "held",
    prospect_minutes: Math.max(0, ...prospects.map((p) => p.minutes)), prospects: prospects.map((p) => p.name ?? p.email), team: people.filter((p) => p.team).map((p) => p.name ?? p.email),
    ended_at: e.endedAt.toISOString() };
  const event = await emitEvent(c, { company_id: companyId, contact_id: appt.contact_id, opportunity_id: appt.opportunity_id, appointment_id: appt.id, event_type: "zoom.meeting_ended", source: "engine", occurred_at: e.endedAt, data });
  const started = await dispatchEvent(c, event, { ...(appt.contact_id ? { contact: { id: appt.contact_id } } : {}),
    appointment: { id: appt.id, starts_at: appt.starts_at.toISOString(), status: appt.status, term: { category: appt.category } } });
  return { booking: appt.id, verdict, started: started.length };
}
