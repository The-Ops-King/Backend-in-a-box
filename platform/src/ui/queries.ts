import { asOperator, many, one } from "@/db/client";
import { parseDefinition, type Definition } from "@/engine/definition";

export const listCompanies = () => asOperator((c) => many<{ id: string; name: string; slug: string; status: string; mode: string; timezone: string; contacts: number; workflows: number; active_runs: number; last_poll: Date | null }>(c, `
  select co.id, co.name, co.slug, co.status, co.mode, co.timezone,
    (select count(*) from contacts where company_id=co.id) as contacts,
    (select count(*) from workflows where company_id=co.id) as workflows,
    (select count(*) from runs where company_id=co.id and status in ('active','waiting')) as active_runs,
    (select max(last_success_at) from poll_cursors where company_id=co.id) as last_poll
  from companies co order by co.created_at`));

export const globalStats = () => asOperator((c) => one<{ companies: number; runs_24h: number; sends_24h: number; shadow_24h: number; failed_24h: number; events_24h: number }>(c, `
  select (select count(*) from companies where status in ('active','hosted')) as companies,
         (select count(*) from runs where started_at > now()-interval '24h') as runs_24h,
         (select count(*) from sends where status='sent' and sent_at > now()-interval '24h') as sends_24h,
         (select count(*) from sends where status='shadow' and sent_at > now()-interval '24h') as shadow_24h,
         (select count(*) from runs where status='failed' and started_at > now()-interval '24h') as failed_24h,
         (select count(*) from events where occurred_at > now()-interval '24h') as events_24h`));

export const engineState = () => asOperator((c) => one<{ value: { last_tick?: string; recovery?: boolean } }>(c, "select value from engine_state where key='scheduler'"));

export const recentRuns = (companyId?: string, limit = 25) => asOperator((c) => many<{ id: string; company_slug: string; workflow: string; workflow_id: string; contact: string; contact_id: string; status: string; current_node: string | null; exit_reason: string | null; next_run_at: Date | null; started_at: Date }>(c, `
  select r.id, co.slug as company_slug, w.name as workflow, w.id as workflow_id, coalesce(ct.first_name,'')||' '||coalesce(ct.last_name,'') as contact, ct.id as contact_id,
         r.status, r.current_node, r.exit_reason, r.next_run_at, r.started_at
  from runs r join workflows w on w.id=r.workflow_id join contacts ct on ct.id=r.contact_id join companies co on co.id=r.company_id
  ${companyId ? "where r.company_id=$1" : ""} order by r.started_at desc limit ${limit}`, companyId ? [companyId] : []));

export const company = (slug: string) => asOperator((c) => one<{ id: string; name: string; slug: string; status: string; timezone: string; send_window_start: string; send_window_end: string; mode: "shadow" | "live"; sms_enabled: boolean }>(c, "select * from companies where slug=$1", [slug]));

export const companyWorkflows = (companyId: string) => asOperator((c) => many<{ id: string; name: string; enabled: boolean; reentry_policy: string; current_version: number; diverged: boolean; triggers: string[]; runs_total: number; runs_active: number }>(c, `
  select w.id, w.name, w.enabled, w.reentry_policy, w.current_version, w.diverged,
    array(select event_type from workflow_triggers t where t.workflow_id=w.id) as triggers,
    (select count(*) from runs where workflow_id=w.id) as runs_total,
    (select count(*) from runs where workflow_id=w.id and status in ('active','waiting')) as runs_active
  from workflows w where w.company_id=$1 order by w.name`, [companyId]));

export const companyContacts = (companyId: string, limit = 50) => asOperator((c) => many<{ id: string; first_name: string | null; last_name: string | null; tags: string[]; updated_at: Date; events: number; stage: string | null }>(c, `
  select ct.id, ct.first_name, ct.last_name, ct.tags, ct.updated_at,
    (select count(*) from events e where e.contact_id=ct.id) as events,
    (select event_type from events e where e.contact_id=ct.id order by occurred_at desc limit 1) as stage
  from contacts ct where ct.company_id=$1 and ct.merged_into is null order by ct.updated_at desc limit ${limit}`, [companyId]));

export const pollHealth = (companyId: string) => asOperator((c) => many<{ entity: string; last_success_at: Date | null; consecutive_failures: number }>(c, "select entity, last_success_at, consecutive_failures from poll_cursors where company_id=$1 order by entity", [companyId]));

export const workflow = (id: string) => asOperator(async (c) => {
  const w = await one<{ id: string; company_id: string; name: string; enabled: boolean; reentry_policy: string; current_version: number; template_version: number | null; diverged: boolean }>(c, "select * from workflows where id=$1", [id]);
  if (!w) return null;
  const v = await one<{ definition: Definition; manifest: { bindings: { key: string; required: boolean }[] } }>(c, "select definition, manifest from workflow_versions where workflow_id=$1 and version=$2", [id, w.current_version]);
  const versions = await many<{ version: number; saved_at: Date; note: string | null }>(c, "select version, saved_at, note from workflow_versions where workflow_id=$1 order by version desc", [id]);
  const bound = (await many<{ key: string }>(c, "select key from bindings where company_id=$1", [w.company_id])).map((b) => b.key);
  const stats = await one<{ total: number; completed: number; waiting: number; exited: number; failed: number }>(c, `select count(*) as total, count(*) filter (where status='completed') as completed, count(*) filter (where status in ('active','waiting')) as waiting, count(*) filter (where status='exited') as exited, count(*) filter (where status='failed') as failed from runs where workflow_id=$1`, [id]);
  return { ...w, definition: parseDefinition(v!.definition), manifest: v!.manifest, versions, bound, stats: stats! };
});

export const run = (id: string) => asOperator(async (c) => {
  const r = await one<{ id: string; company_id: string; workflow_id: string; workflow_version: number; contact_id: string; appointment_id: string | null; status: string; current_node: string | null; exit_reason: string | null; next_run_at: Date | null; started_at: Date; finished_at: Date | null; context: Record<string, unknown>; reentry_key: string; workflow: string; contact: string }>(c,
    "select r.*, w.name as workflow, coalesce(ct.first_name,'')||' '||coalesce(ct.last_name,'') as contact from runs r join workflows w on w.id=r.workflow_id join contacts ct on ct.id=r.contact_id where r.id=$1", [id]);
  if (!r) return null;
  const def = parseDefinition((await one<{ definition: Definition }>(c, "select definition from workflow_versions where workflow_id=$1 and version=$2", [r.workflow_id, r.workflow_version]))!.definition);
  const steps = await many<{ node_id: string; node_type: string; status: string; started_at: Date; finished_at: Date | null; result: Record<string, unknown>; error: string | null }>(c, "select node_id, node_type, status, started_at, finished_at, result, error from run_steps where run_id=$1 order by started_at", [id]);
  const sends = await many<{ channel: string; status: string; rendered_body: string; sent_at: Date | null; external_id: string | null; suppressed_reason: string | null; error: string | null }>(c, "select channel, status, rendered_body, sent_at, external_id, suppressed_reason, error from sends where run_id=$1 order by scheduled_for", [id]);
  const appt = r.appointment_id ? await one<{ starts_at: Date; status: string; term: string }>(c, "select a.starts_at, a.status, t.name as term from appointments a join company_terms t on t.id=a.appointment_term where a.id=$1", [r.appointment_id]) : null;
  return { ...r, definition: def, steps, sends, appt };
});

export const contact = (id: string) => asOperator(async (c) => {
  const ct = await one<{ id: string; company_id: string; ghl_contact_id: string | null; first_name: string | null; last_name: string | null; timezone: string | null; tags: string[]; attributes: Record<string, unknown>; created_at: Date }>(c, "select * from contacts where id=$1", [id]);
  if (!ct) return null;
  const journey = await many<{ id: number; event_type: string; source: string; occurred_at: Date; data: Record<string, unknown>; run_id: string | null }>(c, "select id, event_type, source, occurred_at, data, run_id from events where contact_id=$1 order by occurred_at, id", [id]);
  const runs = await many<{ id: string; workflow: string; status: string; exit_reason: string | null; started_at: Date }>(c, "select r.id, w.name as workflow, r.status, r.exit_reason, r.started_at from runs r join workflows w on w.id=r.workflow_id where r.contact_id=$1 order by r.started_at desc", [id]);
  const msgs = await many<{ channel: string; direction: string; body: string | null; subject: string | null; occurred_at: Date }>(c, "select channel, direction, body, subject, occurred_at from messages where contact_id=$1 order by occurred_at desc limit 20", [id]);
  const idents = await many<{ kind: string; value: string }>(c, "select kind, value from contact_identifiers where contact_id=$1 order by kind", [id]);
  return { ...ct, journey, runs, msgs, idents };
});

export const companyAppointments = (companyId: string) => asOperator((c) => many<{ id: string; starts_at: Date; status: string; contact: string; contact_id: string; closer: string | null; term: string; outcome: string | null; call_outcome: string | null; dispositioned_at: Date | null }>(c, `
  select a.id, a.starts_at, a.status, coalesce(ct.first_name,'')||' '||coalesce(ct.last_name,'') as contact, ct.id as contact_id, u.name as closer, t.name as term,
         o.name as outcome, co.name as call_outcome, a.dispositioned_at
  from appointments a join contacts ct on ct.id=a.contact_id left join users u on u.id=a.assigned_user_id join company_terms t on t.id=a.appointment_term
  left join company_terms o on o.id=a.outcome_term left join company_terms co on co.id=a.call_outcome_term
  where a.company_id=$1 and a.starts_at > now()-interval '7 days' and a.starts_at < now()+interval '14 days' order by a.starts_at desc`, [companyId]));

export const appointment = (id: string) => asOperator((c) => one<{ id: string; company_id: string; starts_at: Date; ends_at: Date; status: string; contact: string; contact_id: string; closer: string | null; term: string; term_id: string; outcome: string | null; call_outcome: string | null; dispositioned_at: Date | null; notes: string | null }>(c, `
  select a.id, a.company_id, a.starts_at, a.ends_at, a.status, coalesce(ct.first_name,'')||' '||coalesce(ct.last_name,'') as contact, ct.id as contact_id, u.name as closer, t.name as term, t.id as term_id,
         o.name as outcome, co.name as call_outcome, a.dispositioned_at, fs.answers->>'notes' as notes
  from appointments a join contacts ct on ct.id=a.contact_id left join users u on u.id=a.assigned_user_id join company_terms t on t.id=a.appointment_term
  left join company_terms o on o.id=a.outcome_term left join company_terms co on co.id=a.call_outcome_term left join form_submissions fs on fs.id=a.disposition_id
  where a.id=$1`, [id]));

export const terms = (companyId: string, domain: string) => asOperator((c) => many<{ id: string; name: string; category: string }>(c, "select id, name, category from company_terms where company_id=$1 and domain=$2 and active order by sort, name", [companyId, domain]));

export const companyEvents = (companyId: string, limit = 40) => asOperator((c) => many<{ id: number; event_type: string; source: string; occurred_at: Date; contact: string; contact_id: string | null; data: Record<string, unknown> }>(c, `
  select e.id, e.event_type, e.source, e.occurred_at, coalesce(ct.first_name,'')||' '||coalesce(ct.last_name,'') as contact, e.contact_id, e.data
  from events e left join contacts ct on ct.id=e.contact_id where e.company_id=$1 order by e.occurred_at desc, e.id desc limit ${limit}`, [companyId]));

export const companySends = (companyId: string, limit = 100) => asOperator((c) => many<{ id: string; channel: string; status: string; suppressed_reason: string | null; rendered_body: string; sent_at: Date | null; scheduled_for: Date | null; run_id: string | null; workflow: string | null; contact: string; contact_id: string }>(c, `
  select s.id, s.channel, s.status, s.suppressed_reason, s.rendered_body, s.sent_at, s.scheduled_for, s.run_id, w.name as workflow, coalesce(ct.first_name,'')||' '||coalesce(ct.last_name,'') as contact, ct.id as contact_id
  from sends s join contacts ct on ct.id=s.contact_id left join runs r on r.id=s.run_id left join workflows w on w.id=r.workflow_id
  where s.company_id=$1 order by coalesce(s.sent_at, s.scheduled_for) desc limit ${limit}`, [companyId]));
