import type { PoolClient } from "pg";
import { Scrubber } from "./scrub";
import { slugify } from "./render";

/**
 * Golden traces: what the engine actually did, per offer and workflow, as the reference a rebuild must reproduce. Up to
 * `perPath` recent runs for each distinct way a run ended (status and exit reason), each with the event that started it, its
 * steps in order (seconds from the run's start), what it sent, what it posted to Slack and the CRM writes it claimed. Every
 * person is a pseudonym (scrub.ts). Read-only.
 */
export const RETENTION_NOTE = "Retention limits what can be shown: sends (with their words) are kept 30 days and inbound messages 7 days (companies.sends_retention_days, reply_retention_days); older runs keep their steps but may have no send rows.";

export type TraceRun = {
  run: string; status: string; exit_reason: string | null; mode_at_start: string; workflow_version: number; started: string; took_sec: number | null;
  trigger: { type: string; source: string; data: unknown } | null;
  steps: { node: string; type: string; status: string; at_sec: number; result_keys: string[]; result: unknown; error: string | null }[];
  sends: { channel: string; status: string; reason: string | null; at_sec: number | null; body: string }[];
  slack_posts: { tag: string; channel: string; at_sec: number }[];
  crm_effects: { node: string; kind: string; done: boolean }[];
};
export type TraceFile = { offer: string; workflow: string; slug: string; note: string; paths: { status: string; exit_reason: string | null; runs: number }[]; runs: TraceRun[] };

const secs = (a: Date | null, from: Date) => (a ? Math.round((a.getTime() - from.getTime()) / 1000) : null);

export async function exportTraces(c: PoolClient, opts: { perPath?: number; offers?: string[] } = {}): Promise<{ offer: string; files: TraceFile[] }[]> {
  const perPath = opts.perPath ?? 5;
  const companies = (await c.query<{ id: string; slug: string }>("select id, slug from companies order by slug")).rows.filter((co) => !opts.offers?.length || opts.offers.includes(co.slug));
  const out: { offer: string; files: TraceFile[] }[] = [];
  for (const co of companies) {
    const scrub = new Scrubber();
    // staff first, so a closer's name in a contact's message reads as staff, not as a contact
    for (const u of (await c.query<{ name: string; email: string; slack_user_id: string | null; ghl_user_id: string | null }>("select name, email, slack_user_id, ghl_user_id from users where company_id = $1 or company_id is null", [co.id])).rows) {
      scrub.learn("staff", u.name); for (const part of u.name.split(/\s+/)) if (part.length >= 4) scrub.learn("staff", part);
      scrub.learn("email", u.email); scrub.learn("slack-user", u.slack_user_id); scrub.learn("crm-id", u.ghl_user_id);
    }
    const wfs = (await c.query<{ id: string; name: string }>("select id, name from workflows where company_id = $1 order by stage nulls last, sort, name", [co.id])).rows;
    const used = new Set<string>();
    const files: TraceFile[] = [];
    for (const wf of wfs) {
      let slug = slugify(wf.name); while (used.has(slug)) slug += "-2"; used.add(slug);
      const runs = (await c.query<{ id: string; status: string; exit_reason: string | null; born_in: string; workflow_version: number; started_at: Date; finished_at: Date | null; contact_id: string | null; triggered_by_event: string | null; n: string }>(
        `select * from (select r.id, r.status, r.exit_reason, r.born_in, r.workflow_version, r.started_at, r.finished_at, r.contact_id, r.triggered_by_event,
                count(*) over (partition by r.status, coalesce(r.exit_reason, '')) as n,
                row_number() over (partition by r.status, coalesce(r.exit_reason, '') order by r.started_at desc) as k
           from runs r where r.workflow_id = $1) x where k <= $2 order by status, exit_reason nulls first, started_at desc`, [wf.id, perPath])).rows;
      if (!runs.length) continue;
      const paths = new Map<string, { status: string; exit_reason: string | null; runs: number }>();
      const traced: TraceRun[] = [];
      for (const r of runs) {
        paths.set(`${r.status}|${r.exit_reason ?? ""}`, { status: r.status, exit_reason: r.exit_reason ? scrub.text(r.exit_reason) : null, runs: Number(r.n) });
        if (r.contact_id) {
          const ct = (await c.query<{ first_name: string | null; last_name: string | null; ghl_contact_id: string | null }>("select first_name, last_name, ghl_contact_id from contacts where id = $1", [r.contact_id])).rows[0];
          if (ct) { scrub.learn("contact", [ct.first_name, ct.last_name].filter(Boolean).join(" ")); scrub.learn("contact", ct.first_name); scrub.learn("contact", ct.last_name); scrub.learn("crm-id", ct.ghl_contact_id); }
          for (const i of (await c.query<{ kind: string; value: string }>("select kind, value from contact_identifiers where contact_id = $1", [r.contact_id])).rows)
            scrub.learn(i.kind === "email" ? "email" : i.kind === "phone" ? "phone" : "crm-id", i.value);
        }
        const ev = r.triggered_by_event ? (await c.query<{ event_type: string; source: string; data: unknown }>("select event_type, source, data from events where id = $1", [r.triggered_by_event])).rows[0] : undefined;
        const steps = (await c.query<{ node_id: string; node_type: string; status: string; started_at: Date; result: Record<string, unknown>; error: string | null }>(
          "select node_id, node_type, status, started_at, result, error from run_steps where run_id = $1 order by started_at, id", [r.id])).rows;
        const sends = (await c.query<{ channel: string; status: string; suppressed_reason: string | null; sent_at: Date | null; rendered_body: string }>(
          "select channel, status, suppressed_reason, sent_at, rendered_body from sends where run_id = $1 order by coalesce(sent_at, scheduled_for), id", [r.id])).rows;
        const posts = (await c.query<{ tag: string; channel: string; posted_at: Date }>("select tag, channel, posted_at from slack_posts where run_id = $1 order by posted_at, id", [r.id])).rows;
        const effects = (await c.query<{ node_id: string; kind: string; done_at: Date | null }>("select node_id, kind, done_at from step_effects where run_id = $1 order by created_at, id", [r.id])).rows;
        traced.push({
          run: scrub.token("id", r.id), status: r.status, exit_reason: r.exit_reason ? scrub.text(r.exit_reason) : null, mode_at_start: r.born_in, workflow_version: r.workflow_version,
          started: r.started_at.toISOString().slice(0, 10), took_sec: secs(r.finished_at, r.started_at),
          trigger: ev ? { type: ev.event_type, source: ev.source, data: scrub.value(ev.data) } : null,
          steps: steps.map((s) => ({ node: s.node_id, type: s.node_type, status: s.status, at_sec: secs(s.started_at, r.started_at)!, result_keys: Object.keys(s.result ?? {}).sort(), result: scrub.value(s.result), error: s.error ? scrub.text(s.error) : null })),
          sends: sends.map((s) => ({ channel: s.channel, status: s.status, reason: s.suppressed_reason ? scrub.text(s.suppressed_reason) : null, at_sec: secs(s.sent_at, r.started_at), body: scrub.text(s.rendered_body) })),
          slack_posts: posts.map((p) => ({ tag: scrub.text(p.tag), channel: p.channel, at_sec: secs(p.posted_at, r.started_at)! })),
          crm_effects: effects.map((e) => ({ node: e.node_id, kind: e.kind, done: !!e.done_at })),
        });
      }
      files.push({ offer: co.slug, workflow: wf.name, slug, note: RETENTION_NOTE, paths: [...paths.values()], runs: traced });
    }
    out.push({ offer: co.slug, files });
  }
  return out;
}
