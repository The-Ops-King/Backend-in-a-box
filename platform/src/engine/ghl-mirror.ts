/**
 * D350: a booking made in Calendly is put on the matching GHL calendar as a confirmed appointment, so GHL's own automations see it
 * (Tyler, 2026-11-19: PMU's pre-call workflows trigger on a confirmed appointment on "The Beauty Moguls Consultation RR (Calendly)";
 * GHL's Calendly integration stopped making those around Oct 27, and nobody got a pre-call message for three weeks).
 *
 * `booking.ghl_mirror` maps a booking calendar (the Calendly event type's id, `calendars.external_id`) to a GHL calendar id.
 * `booking.ghl_mirror_from` (an ISO time) is the first booking it covers. Each minute, for the offer's mapped calendars:
 *   - a booking still to come (new or confirmed, booked since `ghl_mirror_from`) whose person is in GHL and that has no GHL
 *     appointment yet gets one: confirmed, at its time, with its meeting link, assigned to the booking's closer when they are on the
 *     GHL calendar's team, otherwise the team's first member (GHL requires a team member). One GHL already has for that person at
 *     that time (the integration, if it comes back) is adopted, never doubled.
 *   - a booking cancelled at the source has its GHL appointment cancelled; one moved has its GHL appointment moved.
 * Shows and no-shows are not copied (GHL automations on them are the offer's own call). A GHL refusal raises one alert per GHL
 * calendar, retried each minute, cleared by the next success. An offer without `booking.ghl_mirror` is untouched.
 */
import type { PoolClient } from "pg";
import { many } from "@/db/client";
import type { Adapters, Company } from "@/adapters/types";
import { raise, resolve } from "./alerts";

export type MirrorMap = Record<string, string>;

/** `booking.ghl_mirror`: {"<Calendly event type id>": "<GHL calendar id>"}; unset or unreadable → {}. */
export function mirrorMap(bindings: Record<string, string>): MirrorMap {
  try {
    const m = JSON.parse(bindings["booking.ghl_mirror"] || "{}") as unknown;
    if (!m || typeof m !== "object" || Array.isArray(m)) return {};
    return Object.fromEntries(Object.entries(m as Record<string, unknown>).filter(([k, v]) => k && typeof v === "string" && v)) as MirrorMap;
  } catch { return {}; }
}

/** Who the GHL appointment is assigned to: the booking's closer when GHL has them on the calendar's team, else the team's first. */
export function pickAssignee(closerGhlId: string | null | undefined, team: string[]): string | null {
  if (closerGhlId && team.includes(closerGhlId)) return closerGhlId;
  return team[0] ?? null;
}

type Deps = { companyId: string; ac: Company; adapters: Adapters; bindings: Record<string, string> };
type Row = { id: string; starts_at: Date; ends_at: Date; status: string; meeting_url: string | null; cal_ext: string; cal_name: string;
  ghl_contact_id: string; who: string; closer_ghl: string | null; crm_appointment_id: string | null; crm_status: string | null; crm_starts_at: Date | null };
export type MirrorAction = { appointment: string; who: string; calendar: string; ghl_calendar: string; action: "create" | "adopt" | "cancel" | "move"; at: string; ghl_id?: string; assignee?: string | null; error?: string };
export type MirrorReport = { dryRun: boolean; actions: MirrorAction[]; errors: number };

const COLS = `a.id, a.starts_at, a.ends_at, a.status, a.meeting_url, k.external_id as cal_ext, k.name as cal_name, ct.ghl_contact_id,
  coalesce(nullif(trim(concat_ws(' ', ct.first_name, ct.last_name)), ''), 'them') as who, u.ghl_user_id as closer_ghl, a.crm_appointment_id, a.crm_status, a.crm_starts_at`;
const FROM = `from appointments a join calendars k on k.id=a.calendar_id join contacts ct on ct.id=a.contact_id left join users u on u.id=a.assigned_user_id
  where a.company_id=$1 and k.external_id = any($2::text[]) and ct.ghl_contact_id is not null`;

export async function mirrorToGhl(c: PoolClient, d: Deps, opts: { dryRun?: boolean; limit?: number } = {}): Promise<MirrorReport> {
  const dryRun = opts.dryRun ?? false, limit = opts.limit ?? 25;
  const map = mirrorMap(d.bindings);
  const from = Date.parse(d.bindings["booking.ghl_mirror_from"] ?? "");
  const report: MirrorReport = { dryRun, actions: [], errors: 0 };
  const cals = Object.keys(map);
  if (!cals.length || !Number.isFinite(from) || !d.adapters.write.createAppointment) return report;

  const toCreate = await many<Row>(c, `select ${COLS} ${FROM} and a.crm_appointment_id is null and a.status in ('new','confirmed') and a.starts_at > now() and a.booked_at >= $3
    order by a.starts_at limit $4`, [d.companyId, cals, new Date(from), limit]);
  const toChange = await many<Row>(c, `select ${COLS} ${FROM} and a.crm_appointment_id is not null
    and ((a.status='cancelled' and a.crm_status is distinct from 'cancelled') or (a.status in ('new','confirmed') and a.crm_starts_at is distinct from a.starts_at))
    order by a.starts_at limit $3`, [d.companyId, cals, limit]);

  const teams = new Map<string, string[]>();
  const team = async (ghlCal: string) => {
    if (!teams.size) for (const k of await d.adapters.booking.ghl.listCalendars(d.ac)) teams.set(k.id, k.teamMemberIds ?? []);
    // the list leaves some calendars out (a Calendly integration's): read that one by its id
    if (!teams.has(ghlCal) && d.adapters.booking.ghl.calendarTeam) teams.set(ghlCal, await d.adapters.booking.ghl.calendarTeam(d.ac, ghlCal));
    return teams.get(ghlCal) ?? [];
  };
  const failed = new Map<string, string>(), worked = new Set<string>();

  for (const r of toCreate) {
    const ghlCal = map[r.cal_ext];
    const act: MirrorAction = { appointment: r.id, who: r.who, calendar: r.cal_name, ghl_calendar: ghlCal, action: "create", at: r.starts_at.toISOString() };
    try {
      // one GHL already holds for this person at this time (the integration, or an earlier pass that lost its answer) is adopted
      const there = (await d.adapters.booking.ghl.appointmentsInWindow(d.ac, ghlCal, new Date(r.starts_at.getTime() - 120e3), new Date(r.starts_at.getTime() + 120e3)))
        .find((x) => x.contactId === r.ghl_contact_id && !/cancel/i.test(x.status));
      if (there) {
        Object.assign(act, { action: "adopt", ghl_id: there.id });
        if (!dryRun) await c.query("update appointments set crm_appointment_id=$2, crm_status='confirmed', crm_starts_at=starts_at where id=$1", [r.id, there.id]);
      } else {
        act.assignee = pickAssignee(r.closer_ghl, await team(ghlCal));
        if (!act.assignee) throw new Error(`GHL calendar ${ghlCal} has nobody on its team to assign the appointment to`);
        if (!dryRun) {
          const { id } = await d.adapters.write.createAppointment!(d.ac, { calendarId: ghlCal, contactId: r.ghl_contact_id, assignedUserId: act.assignee,
            startTime: r.starts_at.toISOString(), endTime: r.ends_at.toISOString(), title: `${r.who}: ${r.cal_name}`, address: r.meeting_url ?? undefined });
          act.ghl_id = id;
          await c.query("update appointments set crm_appointment_id=$2, crm_status='confirmed', crm_starts_at=starts_at where id=$1", [r.id, id]);
        }
      }
      worked.add(ghlCal);
    } catch (e) { act.error = String((e as Error).message).slice(0, 200); report.errors++; failed.set(ghlCal, act.error); }
    report.actions.push(act);
  }

  for (const r of toChange) {
    const ghlCal = map[r.cal_ext];
    const cancel = r.status === "cancelled";
    const act: MirrorAction = { appointment: r.id, who: r.who, calendar: r.cal_name, ghl_calendar: ghlCal, action: cancel ? "cancel" : "move", at: r.starts_at.toISOString(), ghl_id: r.crm_appointment_id! };
    try {
      if (!dryRun) {
        // updateAppointment reads first and re-sends the status (a GHL PUT without it resets the status to confirmed)
        await d.adapters.write.updateAppointment(d.ac, r.crm_appointment_id!, cancel ? { status: "cancelled" } : { status: "confirmed", startTime: r.starts_at.toISOString(), endTime: r.ends_at.toISOString() });
        await c.query("update appointments set crm_status=$2, crm_starts_at=starts_at where id=$1", [r.id, cancel ? "cancelled" : "confirmed"]);
      }
      worked.add(ghlCal);
    } catch (e) { act.error = String((e as Error).message).slice(0, 200); report.errors++; failed.set(ghlCal, act.error); }
    report.actions.push(act);
  }

  if (!dryRun) {
    for (const [ghlCal, error] of failed)
      await raise(c, { companyId: d.companyId, key: `appointments:ghl-mirror:${ghlCal}`, level: "warning", source: "engine",
        text: `Couldn't put a booking on GHL calendar ${ghlCal}, so GHL's pre-call automations won't see it: ${error}. Retried every minute.`, detail: { ghl_calendar: ghlCal } });
    for (const ghlCal of worked) if (!failed.has(ghlCal)) await resolve(c, d.companyId, `appointments:ghl-mirror:${ghlCal}`);
    if (report.actions.length)
      await c.query("insert into audit_log (company_id, action, target_type, target_id, after) values ($1,'appointments.ghl_mirrored','company',$2,$3)",
        [d.companyId, d.companyId, { actions: report.actions.map(({ appointment, action, ghl_id, error }) => ({ appointment, action, ghl_id, error })) }]);
  }
  return report;
}
