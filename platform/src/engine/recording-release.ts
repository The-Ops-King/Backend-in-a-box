import type { PoolClient } from "pg";
import { many, one } from "@/db/client";
import { emitEvent } from "./dispatch";
import { eventData, type RecordingRow } from "./recordings";

/**
 * D338: a recording the history pass brought in silently (D115: `raw.backfill`, no event, no run) is given the event a live
 * delivery would have made: `recording.received` when it is linked (to its person and booking), `recording.unlinked` when not.
 * Only the event: nothing is dispatched here; /api/admin/events/replay runs it through the one workflow named, dry run first, as
 * any event that started nothing. A recording that already has a recording event, or was not brought in by the history pass, is
 * refused with why. Audited.
 */
export async function releaseBackfilled(c: PoolClient, companyId: string, ids: string[], opts: { dryRun?: boolean; why: string }) {
  const rows = await many<RecordingRow>(c, "select * from recordings where company_id=$1 and id = any($2::uuid[])", [companyId, ids]);
  const out: Record<string, unknown>[] = [];
  for (const id of ids) {
    const r = rows.find((x) => x.id === id);
    if (!r) { out.push({ recording: id, refused: "no such recording on this offer" }); continue; }
    if ((r.raw as Record<string, unknown> | null)?.backfill !== true) { out.push({ recording: id, refused: "not brought in by the history pass: it had its own event when it arrived" }); continue; }
    const had = await one<{ id: string; event_type: string }>(c, "select id::text, event_type from events where company_id=$1 and event_type like 'recording.%' and data->>'recording_id'=$2 limit 1", [companyId, id]);
    if (had) { out.push({ recording: id, refused: `already has ${had.event_type} (event ${had.id})` }); continue; }
    const linked = r.link_status === "linked" && !!r.contact_id;
    const type = linked ? "recording.received" : "recording.unlinked";
    const plan = { recording: id, title: r.title, started_at: r.started_at, event: type, contact_id: r.contact_id, appointment_id: r.appointment_id };
    if (opts.dryRun !== false) { out.push({ ...plan, would: `emit ${type}` }); continue; }
    const appt = r.appointment_id ? await one<{ opportunity_id: string | null }>(c, "select opportunity_id from appointments where id=$1", [r.appointment_id]) : null;
    const invitees = (r.invitees ?? []) as { name?: string; email?: string }[];
    const ev = await emitEvent(c, linked
      ? { company_id: companyId, contact_id: r.contact_id, opportunity_id: appt?.opportunity_id ?? null, appointment_id: r.appointment_id, event_type: type, source: r.provider === "fathom" ? "fathom" : "zapier", occurred_at: r.started_at, data: eventData(r, { matched_by: r.linked_by, appointment_matched: !!r.appointment_id, released: true }) }
      : { company_id: companyId, contact_id: null, opportunity_id: null, appointment_id: null, event_type: type, source: r.provider === "fathom" ? "fathom" : "zapier", occurred_at: r.started_at, data: eventData(r, { reason: r.unlinked_reason, invitees, attendees: invitees.map((i) => i.email ?? i.name).filter(Boolean).join(", "), released: true }) });
    await c.query("insert into audit_log (company_id, action, target_type, target_id, after) values ($1,'recording.released','recording',$2,$3)", [companyId, id, { event: ev.id, event_type: type, why: opts.why }]);
    out.push({ ...plan, event_id: ev.id });
  }
  return { dryRun: opts.dryRun !== false, recordings: out };
}
