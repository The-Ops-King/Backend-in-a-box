import type { PoolClient } from "pg";
import { many, one } from "@/db/client";
import { resolve } from "./alerts";

/**
 * D298 (Tyler: "Hair is paused as I've said"). A paused offer is not run at all: no polls, no schedules, no runs, no checks, no alerts
 * (running.ts runs only active and hosted offers). Pausing clears its open alerts quietly (nobody needs telling about an offer that is
 * off). Unpausing clears where its polls had read to, so the first read back is a silent baseline: nothing booked or changed while it was
 * paused starts a workflow or sends a text late; the 10-minute sync then brings the engine into line with GHL (D297).
 */
export type PauseResult = { ok: true; dryRun: boolean; company: string; was: string; now: string; alerts_closed?: number; cursors_cleared?: number } | { ok: false; status: number; error: string };

export async function setPaused(c: PoolClient, a: { company: string; paused: boolean; why: string; dryRun?: boolean }): Promise<PauseResult> {
  if (!a.why?.trim()) return { ok: false, status: 400, error: "why is required" };
  const co = await one<{ id: string; slug: string; status: string }>(c, "select id, slug, status from companies where slug=$1", [a.company]);
  if (!co) return { ok: false, status: 404, error: "no such company" };
  if (a.paused && !["active", "hosted"].includes(co.status)) return { ok: false, status: 400, error: `${co.slug} is ${co.status}: only an active or hosted offer is paused` };
  if (!a.paused && co.status !== "paused") return { ok: false, status: 400, error: `${co.slug} is ${co.status}, not paused` };
  const to = a.paused ? "paused" : "active";
  if (a.dryRun !== false) return { ok: true, dryRun: true, company: co.slug, was: co.status, now: to };
  await c.query("update companies set status=$2 where id=$1", [co.id, to]);
  let closed = 0, cleared = 0;
  if (a.paused) { for (const r of await many<{ key: string }>(c, "select key from alerts where company_id=$1 and resolved_at is null", [co.id])) if (await resolve(c, co.id, r.key, new Date(), true)) closed++; }
  else cleared = (await c.query("delete from poll_cursors where company_id=$1", [co.id])).rowCount ?? 0;
  await c.query("insert into audit_log (company_id, action, target_type, target_id, before, after) values ($1,$2,'company',$5,$3,$4)", [co.id, a.paused ? "company.paused" : "company.unpaused", { status: co.status }, { status: to, why: a.why, ...(a.paused ? { alerts_closed: closed } : { cursors_cleared: cleared }) }, co.id]);
  return { ok: true, dryRun: false, company: co.slug, was: co.status, now: to, ...(a.paused ? { alerts_closed: closed } : { cursors_cleared: cleared }) };
}
