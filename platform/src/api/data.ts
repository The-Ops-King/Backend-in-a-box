import type { PoolClient } from "pg";
import { many, one } from "@/db/client";
import { parseDefinition, type Definition } from "@/engine/definition";
import { buildContext, loadCompany, type RunRow } from "@/engine/context";
import { projectRun, type Projected } from "@/engine/project";
import { companyReadiness, type Readiness } from "@/engine/readiness";
import { openAlerts, recentAlerts, currentProblems } from "@/engine/alerts";
import { CHECKS, ensureHealth, type Finding } from "@/engine/health";
import { scheduleWords } from "@/engine/when";
import { workflowWithStep } from "@/engine/clock";
import { STAGES, stageIndex } from "@/engine/stages";
import { chartOf, pathOf, runState, type PathItem } from "./words";

/** The company header every page under a company carries. */
export type CompanyHead = { id: string; name: string; slug: string; mode: "shadow" | "live"; timezone: string; status: string };
export const companyBySlug = (c: PoolClient, slug: string) => one<CompanyHead & { sms_enabled: boolean; send_window_start: string; send_window_end: string }>(c, "select id, name, slug, mode, timezone, status, sms_enabled, send_window_start::text, send_window_end::text from companies where slug=$1", [slug]);
export const companyById = (c: PoolClient, id: string) => one<CompanyHead>(c, "select id, name, slug, mode, timezone, status from companies where id=$1", [id]);

/** The companies page: every company with its counts, and the engine's own state. */
export async function companiesPage(c: PoolClient) {
  const companies = await many<{ id: string; name: string; slug: string; status: string; mode: string; timezone: string; contacts: number; workflows: number; on: number; in_flight: number; failed_24h: number; last_poll: Date | null; alerts: number }>(c, `
    select co.id, co.name, co.slug, co.status, co.mode, co.timezone,
      (select count(*)::int from contacts where company_id=co.id and merged_into is null) as contacts,
      (select count(*)::int from workflows where company_id=co.id) as workflows,
      (select count(*)::int from workflows where company_id=co.id and enabled) as "on",
      (select count(*)::int from runs where company_id=co.id and status in ('active','waiting')) as in_flight,
      (select count(*)::int from runs where company_id=co.id and status='failed' and started_at > now()-interval '24h') as failed_24h,
      (select max(last_success_at) from poll_cursors where company_id=co.id) as last_poll,
      (select count(*)::int from alerts where company_id=co.id and resolved_at is null) as alerts
    from companies co order by co.created_at`);
  const state = await one<{ value: { last_tick?: string; recovery?: boolean } }>(c, "select value from engine_state where key='scheduler'");
  const probs = await currentProblems(c);
  return { engine: { last_tick: state?.value.last_tick ?? null, recovery: !!state?.value.recovery, problems: probs.value.problems }, companies };
}

export type WorkflowRow = { id: string; name: string; enabled: boolean; stage: string | null; sort: number; origin: string | null; description: string | null; people: number; in_flight: number; failed: number; last_ran: Date | null; schedule: string | null; ready: boolean; missing: string[]; gaps: string[]; parse_error?: string };

/** The company page: the workflows on the rail with their counts and readiness. */
export async function companyPage(c: PoolClient, co: CompanyHead) {
  const rows = await many<{ id: string; name: string; enabled: boolean; stage: string | null; sort: number; origin: string | null; description: string | null; definition: unknown; people: number; in_flight: number; failed: number; last_ran: Date | null }>(c, `
    select w.id, w.name, w.enabled, w.stage, w.sort, w.origin, t.description, v.definition,
      (select count(*)::int from runs where workflow_id=w.id) as people,
      (select count(*)::int from runs where workflow_id=w.id and status in ('active','waiting')) as in_flight,
      (select count(*)::int from runs where workflow_id=w.id and status='failed') as failed,
      (select max(started_at) from runs where workflow_id=w.id) as last_ran
    from workflows w join workflow_versions v on v.workflow_id=w.id and v.version=w.current_version left join workflow_templates t on t.id=w.template_id
    where w.company_id=$1`, [co.id]);
  const ready = await companyReadiness(c, co.id, `/app/c/${co.slug}`);
  const readyOf = new Map(ready.workflows.map((w) => [w.id, w]));
  const workflows: WorkflowRow[] = rows.map((w) => {
    let schedule: string | null = null;
    try { const def = parseDefinition(w.definition); const trigs = def.nodes.filter((n) => n.type === "trigger" && n.schedule); if (trigs.length) schedule = trigs.map((t) => (t.type === "trigger" && t.schedule ? scheduleWords(t.schedule) : "")).join("; "); } catch { /* readiness says so */ }
    const r = readyOf.get(w.id);
    return { id: w.id, name: w.name, enabled: w.enabled, stage: w.stage, sort: w.sort, origin: w.origin, description: w.description, people: w.people, in_flight: w.in_flight, failed: w.failed, last_ran: w.last_ran, schedule, ready: !!r?.ready, missing: r?.missing ?? [], gaps: r?.gaps ?? [], parse_error: r?.parseError };
  }).sort((a, b) => stageIndex(a.stage) - stageIndex(b.stage) || a.sort - b.sort || a.name.localeCompare(b.name));
  const alerts = await one<{ n: number }>(c, "select count(*)::int as n from alerts where company_id=$1 and resolved_at is null", [co.id]);
  return { company: co, stages: STAGES, workflows, issues: ready.issues, alerts_open: alerts?.n ?? 0 };
}

type RunFull = RunRow & { workflow: string; who: string; exit_reason: string | null; finished_at: Date | null; started_at: Date };
const runSelect = `select r.*, w.name as workflow, coalesce(nullif(trim(coalesce(ct.first_name,'')||' '||coalesce(ct.last_name,'')),''), u.name, 'the company') as who
  from runs r join workflows w on w.id=r.workflow_id left join contacts ct on ct.id=r.contact_id left join users u on u.id=r.user_id`;

/** The plan for every live run in a set, computed once per definition. */
async function plansFor(c: PoolClient, co: { id: string }, runs: RunFull[], defs: Map<string, Definition | null>): Promise<Map<string, Projected[]>> {
  const out = new Map<string, Projected[]>();
  const live = runs.filter((r) => r.status === "active" || r.status === "waiting");
  if (!live.length) return out;
  const { row: company, bindings } = await loadCompany(c, co.id);
  for (const r of live) {
    const def = defs.get(`${r.workflow_id}:${r.workflow_version}`);
    if (!def) { out.set(r.id, []); continue; }
    try { out.set(r.id, projectRun(def, r, company, await buildContext(c, r, company, bindings))); } catch { out.set(r.id, []); }
  }
  return out;
}
async function defsFor(c: PoolClient, runs: { workflow_id: string; workflow_version: number }[]): Promise<Map<string, Definition | null>> {
  const defs = new Map<string, Definition | null>();
  for (const r of runs) {
    const key = `${r.workflow_id}:${r.workflow_version}`; if (defs.has(key)) continue;
    const v = await one<{ definition: unknown }>(c, "select definition from workflow_versions where workflow_id=$1 and version=$2", [r.workflow_id, r.workflow_version]);
    let d: Definition | null = null; try { d = v ? parseDefinition(v.definition) : null; } catch { d = null; }
    defs.set(key, d);
  }
  return defs;
}

export type RunListRow = { id: string; who: string; contact_id: string | null; workflow: string; workflow_id: string; state: "ok" | "here" | "warn" | "stop"; at: string; started_at: Date; finished_at: Date | null; next_run_at: Date | null; path: { node_id: string; state: PathItem["state"] }[] };

/** Rows for "who went through it" and a contact's workflows: each with its strip. */
async function runRows(c: PoolClient, co: CompanyHead, runs: RunFull[]): Promise<RunListRow[]> {
  const defs = await defsFor(c, runs);
  const plans = await plansFor(c, co, runs, defs);
  const out: RunListRow[] = [];
  for (const r of runs) {
    const def = defs.get(`${r.workflow_id}:${r.workflow_version}`);
    const steps = await many<Parameters<typeof pathOf>[2][number]>(c, "select node_id, node_type, status, started_at, finished_at, result, error from run_steps where run_id=$1 order by started_at, id", [r.id]);
    const path = def ? pathOf(def, r, steps, [], plans.get(r.id) ?? [], co.timezone) : [];
    const st = runState(r, path, co.timezone);
    out.push({ id: r.id, who: r.who, contact_id: r.contact_id, workflow: r.workflow, workflow_id: r.workflow_id, state: st.state, at: st.at, started_at: r.started_at!, finished_at: r.finished_at ?? null, next_run_at: r.next_run_at ?? null, path: path.map((p) => ({ node_id: p.node_id, state: p.state })) });
  }
  return out;
}

/** The workflow page: header, tiles, the chart, who went through it. */
export async function workflowPage(c: PoolClient, co: CompanyHead, id: string) {
  const w = await one<{ id: string; company_id: string; name: string; enabled: boolean; stage: string | null; origin: string | null; current_version: number; template_version: number | null; diverged: boolean; description: string | null; definition: unknown }>(c, "select w.*, t.description, v.definition from workflows w join workflow_versions v on v.workflow_id=w.id and v.version=w.current_version left join workflow_templates t on t.id=w.template_id where w.id=$1", [id]);
  if (!w || w.company_id !== co.id) return null;
  const stats = await one<{ people: number; in_flight: number; finished: number; failed: number; last_ran: Date | null }>(c, "select count(*)::int as people, count(*) filter (where status in ('active','waiting'))::int as in_flight, count(*) filter (where status in ('completed','exited'))::int as finished, count(*) filter (where status='failed')::int as failed, max(started_at) as last_ran from runs where workflow_id=$1", [id]);
  let def: Definition | null = null, parse_error: string | null = null;
  try { def = parseDefinition(w.definition); } catch (e) { parse_error = String((e as Error).message).slice(0, 300); }
  const { bindings } = await loadCompany(c, co.id);
  const safe = Object.fromEntries(Object.entries(bindings).filter(([k]) => !k.startsWith("secret.")));
  const chart = def ? chartOf(def, { name: co.name, timezone: co.timezone }, safe) : null;
  const ready = await companyReadiness(c, co.id, `/app/c/${co.slug}`); const mine = ready.workflows.find((x) => x.id === id);
  const runs = await many<RunFull>(c, `${runSelect} where r.workflow_id=$1 order by (r.status in ('active','waiting')) desc, r.started_at desc limit 100`, [id]);
  const rows = await runRows(c, co, runs);
  const schedule = def ? def.nodes.filter((n) => n.type === "trigger" && n.schedule).map((t) => (t.type === "trigger" && t.schedule ? scheduleWords(t.schedule) : "")).join("; ") : "";
  return { company: co, workflow: { id: w.id, name: w.name, enabled: w.enabled, stage: w.stage, origin: w.origin, description: w.description, version: w.current_version, diverged: w.diverged, last_ran: stats?.last_ran ?? null, schedule: schedule || null, parse_error },
    tiles: { people: stats?.people ?? 0, in_flight: stats?.in_flight ?? 0, finished: stats?.finished ?? 0, failed: stats?.failed ?? 0 }, chart, runs: rows,
    ready: { ready: !!mine?.ready, missing: mine?.missing ?? [], gaps: mine?.gaps ?? [], issues: ready.issues.filter((i) => !i.href || i.href.endsWith(`/w/${id}`)) } };
}

/** The run page: the feed, what happens next, the chart with this run's states. */
export async function runPage(c: PoolClient, id: string) {
  const r = await one<RunFull>(c, `${runSelect} where r.id=$1`, [id]);
  if (!r) return null;
  const co = (await companyById(c, r.company_id))!;
  const v = await one<{ definition: unknown }>(c, "select definition from workflow_versions where workflow_id=$1 and version=$2", [r.workflow_id, r.workflow_version]);
  let def: Definition | null = null; try { def = v ? parseDefinition(v.definition) : null; } catch { def = null; }
  const steps = await many<Parameters<typeof pathOf>[2][number]>(c, "select node_id, node_type, status, started_at, finished_at, result, error from run_steps where run_id=$1 order by started_at, id", [id]);
  const sends = await many<Parameters<typeof pathOf>[3][number]>(c, "select idempotency_key, channel, status, rendered_body, sent_at, suppressed_reason, error from sends where run_id=$1 order by scheduled_for", [id]);
  const plan = (await plansFor(c, co, [r], new Map([[`${r.workflow_id}:${r.workflow_version}`, def]]))).get(r.id) ?? [];
  const path = def ? pathOf(def, r, steps, sends, plan, co.timezone) : [];
  const st = runState(r, path, co.timezone);
  const appt = r.appointment_id ? await one<{ starts_at: Date; status: string; term: string; closer: string | null }>(c, "select a.starts_at, a.status, t.name as term, u.name as closer from appointments a join company_terms t on t.id=a.appointment_term left join users u on u.id=a.assigned_user_id where a.id=$1", [r.appointment_id]) : null;
  const { bindings } = await loadCompany(c, co.id);
  const safe = Object.fromEntries(Object.entries(bindings).filter(([k]) => !k.startsWith("secret.")));
  const chart = def ? chartOf(def, { name: co.name, timezone: co.timezone }, safe) : null;
  const states: Record<string, PathItem["state"]> = {}; for (const p of path) if (!(p.node_id in states) || p.state !== "next") states[p.node_id] = p.state;
  return { company: co, workflow: { id: r.workflow_id, name: r.workflow },
    run: { id: r.id, who: r.who, contact_id: r.contact_id, user_id: r.user_id, status: r.status, state: st.state, at: st.at, exit_reason: r.exit_reason, started_at: r.started_at, finished_at: r.finished_at, next_run_at: r.next_run_at, appointment: appt, shadow: co.mode === "shadow" },
    feed: path.filter((p) => p.state !== "next"), next: path.filter((p) => p.state === "next"), chart, states,
    raw: { steps: steps.map((s) => ({ node_id: s.node_id, node_type: s.node_type, status: s.status, started_at: s.started_at, result: s.result, error: s.error })), context: r.context } };
}

/** The contact page: the CRM's facts, their workflows, what is next. No messages (D38). */
export async function contactPage(c: PoolClient, id: string) {
  const ct = await one<{ id: string; company_id: string; ghl_contact_id: string | null; first_name: string | null; last_name: string | null; timezone: string | null; tags: string[]; attributes: Record<string, unknown>; ghl_fields: Record<string, unknown>; created_at: Date }>(c, "select * from contacts where id=$1", [id]);
  if (!ct) return null;
  const co = (await companyById(c, ct.company_id))!;
  const idents = await many<{ kind: string; value: string }>(c, "select kind, value from contact_identifiers where contact_id=$1 order by kind", [id]);
  const runs = await many<RunFull>(c, `${runSelect} where r.contact_id=$1 order by (r.status in ('active','waiting')) desc, r.started_at desc limit 50`, [id]);
  const rows = await runRows(c, co, runs);
  const defs = await defsFor(c, runs); const plans = await plansFor(c, co, runs, defs);
  const next: { workflow: string; run_id: string; title: string; at: string | null; note?: string }[] = [];
  for (const r of runs) for (const p of (plans.get(r.id) ?? []).filter((p) => p.kind === "send" || p.kind === "wait")) next.push({ workflow: r.workflow, run_id: r.id, title: p.title, at: p.at, note: p.note });
  next.sort((a, b) => (a.at ?? "9").localeCompare(b.at ?? "9"));
  const loc = (await one<{ v: Buffer }>(c, "select value as v from bindings where company_id=$1 and key='crm.location_id'", [co.id]))?.v?.toString("utf8");
  const phone = idents.find((i) => i.kind === "phone")?.value ?? null, email = idents.find((i) => i.kind === "email")?.value ?? null;
  const facts = Object.entries(ct.attributes ?? {}).filter(([, v]) => v !== null && v !== "" && typeof v !== "object").map(([k, v]) => [k.replace(/_/g, " "), String(v)] as [string, string]);
  return { company: co, contact: { id: ct.id, name: `${ct.first_name ?? ""} ${ct.last_name ?? ""}`.trim() || "Contact", phone, email, timezone: ct.timezone ?? co.timezone, tags: ct.tags, since: ct.created_at, crm_url: loc && ct.ghl_contact_id ? `https://app.gohighlevel.com/v2/location/${loc}/contacts/detail/${ct.ghl_contact_id}` : null },
    facts, identifiers: idents.map((i) => [i.kind, i.value] as [string, string]), runs: rows, next, harness: { allowed: co.mode === "shadow" } };
}

/** The health page: what is open, the last sweep check by check, what cleared. */
export async function healthPage(c: PoolClient, co: CompanyHead) {
  const [open, recent, h, wf] = await Promise.all([openAlerts(c, co.id), recentAlerts(c, co.id), ensureHealth(c, co.id), workflowWithStep(c, co.id, "health_check")]);
  const checksOff = ((wf?.node?.checks as Record<string, boolean> | undefined) ?? {});
  const results = (h.last_result ?? []) as Finding[];
  const byCheck = new Map<string, Finding[]>(); for (const f of results) byCheck.set(f.check, [...(byCheck.get(f.check) ?? []), f]);
  const checks = CHECKS.map((ck) => { const fs = byCheck.get(ck.id); const failing = (fs ?? []).filter((f) => !f.ok);
    const state = checksOff[ck.id] === false ? "off" : !fs ? "na" : failing.length ? (failing.some((f) => f.level === "error") ? "error" : "warn") : "ok";
    return { id: ck.id, label: ck.label, about: ck.about, state, findings: (failing.length ? failing : fs ?? []).map((f) => ({ ok: f.ok, level: f.level, text: f.text, href: f.href ?? null, href_label: f.hrefLabel ?? null, fix: f.fix ?? null, thread: f.thread ?? null })) }; });
  return { company: co, open: open.map((a) => ({ id: a.id, level: a.level, text: a.text, source: a.source, first_seen: a.first_seen, announce_count: a.announce_count, link: (a.detail as { link?: string }).link ?? null, link_label: (a.detail as { link_label?: string }).link_label ?? null })),
    checks, resolved: recent.filter((a) => a.resolved_at).slice(0, 20).map((a) => ({ id: a.id, text: a.text, first_seen: a.first_seen, resolved_at: a.resolved_at })),
    sweep: wf ? { workflow_id: wf.id, name: wf.name, enabled: wf.enabled, when: wf.enabled && wf.schedule ? scheduleWords(wf.schedule) : null, last_run_at: h.last_run_at } : null };
}

export type { Readiness };
