/**
 * D366 (Tyler, 2026-11-24: "Setter call logged ... should have been fucking live since the beginning"): TRC's dialer logged 62 of
 * Nick's connected calls in a week while the workflow that reviews them was off, and nothing said so. This finds every workflow
 * of an offer that is OFF while the events it starts on keep happening: the events of its trigger types in the last 7 days that
 * its triggers would take (their match included, as the replay's dry run reads them). A workflow left off on purpose is named in
 * the offer's `health.off_on_purpose` setting (slugs or names, one per line or comma) and never flagged.
 * An opt-in health check (`workflows_off`): it reaches an offer only when that offer's Health check turns it on.
 */
import type { PoolClient } from "pg";
import { many } from "@/db/client";
import { eventMatchContext, workflowTakes, type EventRow } from "./dispatch";

export const OFF_ON_PURPOSE_KEY = "health.off_on_purpose";
export const offOnPurpose = (raw: string | undefined) => new Set((raw ?? "").split(/[,\n]/).map((s) => s.trim().toLowerCase()).filter(Boolean));
/** Clock and operator events say nothing about work arriving. */
const NOT_WORK = new Set(["schedule", "operator.enrolled", "run.started", "run.exited", "alert.raised", "alert.repeated", "alert.resolved"]);
const PER_TYPE = 200;

export type OffWithWork = { id: string; slug: string | null; name: string; events: number; latest: Date; types: string[] };

export async function workflowsOffWithWork(c: PoolClient, companyId: string, bindings: Record<string, string>, now: Date, days = 7): Promise<OffWithWork[]> {
  const skip = offOnPurpose(bindings[OFF_ON_PURPOSE_KEY]);
  const off = await many<{ id: string; slug: string | null; name: string; types: string[] }>(c, `select w.id, t.slug, w.name, array_agg(distinct wt.event_type) as types
    from workflows w left join workflow_templates t on t.id=w.template_id join workflow_triggers wt on wt.workflow_id=w.id and wt.enabled
    where w.company_id=$1 and not w.enabled group by w.id, t.slug, w.name order by w.name`, [companyId]);
  const since = new Date(now.getTime() - days * 86_400_000);
  const out: OffWithWork[] = [];
  for (const w of off) {
    if (skip.has(w.name.toLowerCase()) || (w.slug && skip.has(w.slug.toLowerCase()))) continue;
    let events = 0, latest: Date | null = null; const seen: string[] = [];
    for (const type of w.types.filter((t) => !NOT_WORK.has(t))) {
      const rows = await many<EventRow>(c, "select * from events where company_id=$1 and event_type=$2 and occurred_at >= $3 and occurred_at <= $4 order by occurred_at desc limit $5", [companyId, type, since, now, PER_TYPE]);
      let n = 0;
      for (const e of rows) if (await workflowTakes(c, e, await eventMatchContext(c, e), w.id)) { n++; if (!latest || e.occurred_at > latest) latest = e.occurred_at; }
      if (n) { events += n; seen.push(type); }
    }
    if (events && latest) out.push({ id: w.id, slug: w.slug, name: w.name, events, latest, types: seen });
  }
  return out;
}
