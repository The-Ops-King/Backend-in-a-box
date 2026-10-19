import type { PoolClient } from "pg";
import type { ZodIssue } from "zod";
import { many, one } from "@/db/client";
import { Definition, extractManifest, type ManifestEntry } from "./definition";
import { EDITABLE, validateCopy } from "./copy";
import { OFFSET } from "./edits";
import { KNOWN_ROOTS, referencedPaths } from "./template";
import { workflowRefs } from "./coverage";
import { canon, syncTemplateRow, syncTriggers } from "./install";
import { chartLayoutOf, notDrawable, type Layout } from "@/api/chart-verdict";
import { RETIRED_EVENTS } from "./describe";
import { templates } from "@/templates";

/**
 * D100: a company's whole copy of a workflow saved at once (steps added and removed, edges rewired), for onboarding a client
 * whose process differs from the template. The same checks a step edit and the shipped templates pass, all of them listed
 * when it is refused. Saved, it is a new version of that company's copy only, diverged (template upgrades leave it alone);
 * runs already in flight keep the version they started on.
 */
export type DefinitionDiff = {
  nodes: { added: string[]; removed: string[]; changed: string[] };
  edges: { added: string[]; removed: string[] };
  settings: string[];   // top-level keys that changed: reentry, reentry_window, reentry_key, premise
};
export type Validated =
  | { ok: true; def: Definition; manifest: { bindings: ManifestEntry[] }; missing: string[]; warnings: string[] }
  | { ok: false; problems: string[] };

const at = (raw: unknown, path: (string | number)[]) => path.reduce<unknown>((v, k) => (v && typeof v === "object" ? (v as Record<string, unknown>)[k as string] : undefined), raw);
const nodeName = (raw: unknown, path: (string | number)[]) => {
  if (path[0] !== "nodes" || typeof path[1] !== "number") return path.join(".") || "definition";
  const id = (at(raw, ["nodes", path[1]]) as { id?: unknown } | undefined)?.id;
  return `node ${typeof id === "string" ? id : `#${path[1]}`}${path.length > 2 ? ` ${path.slice(2).join(".")}` : ""}`;
};
const describeIssue = (raw: unknown, i: ZodIssue) => {
  if (i.code === "invalid_union_discriminator" && i.path.at(-1) === "type") return `${nodeName(raw, i.path.slice(0, -1))}: "${String(at(raw, i.path))}" is not a step type the engine runs`;
  return `${nodeName(raw, i.path)}: ${i.message}`;
};

/** Every reason a definition cannot be saved on this company, or what it would need there (missing bindings) and what looks off (warnings). */
export async function validateDefinition(c: PoolClient, companyId: string, raw: unknown): Promise<Validated> {
  const problems: string[] = [];
  // {{placeholders}}: every root must be one the engine knows (what templates.test asserts of the shipped ones); read off the raw input so a definition that does not parse still gets these listed
  const nodes = Array.isArray((raw as { nodes?: unknown })?.nodes) ? ((raw as { nodes: unknown[] }).nodes) : [];
  const walk = (v: unknown): string[] => typeof v === "string" ? referencedPaths(v) : Array.isArray(v) ? v.flatMap(walk) : v && typeof v === "object" ? Object.values(v).flatMap(walk) : [];
  nodes.forEach((n, i) => { for (const p of new Set(walk(n))) if (!KNOWN_ROOTS.includes(p.split(".")[0])) problems.push(`${nodeName(raw, ["nodes", i])}: {{${p}}} is not a path the engine knows (it starts with ${p.split(".")[0]})`); });
  for (const p of new Set(walk((raw as { edges?: unknown })?.edges))) if (!KNOWN_ROOTS.includes(p.split(".")[0])) problems.push(`edges: {{${p}}} is not a path the engine knows (it starts with ${p.split(".")[0]})`);

  const parsed = Definition.safeParse(raw);
  if (!parsed.success) {
    // zod skips the definition's own cross-checks when a node fails: the edges are checked here so they are listed too
    const nodeIds = new Set(nodes.map((n) => (n as { id?: unknown })?.id).filter((id): id is string => typeof id === "string"));
    const edges = Array.isArray((raw as { edges?: unknown })?.edges) ? (raw as { edges: unknown[] }).edges : [];
    const cross: string[] = [];
    const zodOwn = parsed.error.issues.some((i) => i.code === "custom");
    if (!zodOwn) for (const e of edges) for (const k of ["from", "to"] as const) { const v = (e as Record<string, unknown>)?.[k]; if (typeof v === "string" && !nodeIds.has(v)) cross.push(`edge ${k} ${v} is not a node`); }
    return { ok: false, problems: [...parsed.error.issues.map((i) => describeIssue(raw, i)), ...cross, ...problems] };
  }
  const def = parsed.data;

  // the words of every message, as a copy edit checks them
  for (const n of def.nodes) for (const f of EDITABLE[n.type] ?? []) {
    const text = (n as Record<string, unknown>)[f];
    if (typeof text !== "string") continue;
    const v = validateCopy(text);
    if (!v.ok && !problems.some((p) => p.startsWith(`node ${n.id}: {{`))) problems.push(`node ${n.id} ${f}: ${v.why}`);
  }
  // every wait offset, as a step edit checks one
  const offsets = (v: unknown, path: string, out: [string, string][]) => {
    if (Array.isArray(v)) v.forEach((x, i) => offsets(x, `${path}.${i}`, out));
    else if (v && typeof v === "object") { const o = v as Record<string, unknown>; if (typeof o.anchor === "string" && typeof o.offset === "string") out.push([path, o.offset]); for (const [k, x] of Object.entries(o)) offsets(x, path ? `${path}.${k}` : k, out); }
    return out;
  };
  for (const n of def.nodes) for (const [path, off] of offsets(n, "", [])) if (!OFFSET.test(off.replace(/\s+/g, ""))) problems.push(`node ${n.id} ${path}: "${off}" is not a wait: use +15m, +2h, -1d, or day_of@08:00`);
  // reentry
  if (def.reentry === "once_per_contact_per_window" && !def.reentry_window) problems.push("reentry once_per_contact_per_window needs a reentry_window");
  if (def.reentry_window) {
    await c.query("savepoint def_window");
    try { await c.query("select $1::interval", [def.reentry_window]); await c.query("release savepoint def_window"); }
    catch { await c.query("rollback to savepoint def_window"); problems.push(`reentry_window "${def.reentry_window}" is not a length of time (90d, 12h)`); }
  }
  // what the steps depend on inside the engine: events it knows, options the classifier has
  const events = new Set((await many<{ name: string }>(c, "select name from event_types")).map((e) => e.name).filter((e) => !RETIRED_EVENTS.has(e)));
  const domains = new Set((await many<{ domain: string }>(c, "select distinct domain from core_categories")).map((d) => d.domain));
  const warnings: string[] = [];
  for (const n of def.nodes) if (n.type === "trigger" && n.event === "schedule" && !n.schedule) problems.push(`node ${n.id}: a schedule trigger needs a schedule (every, or at)`);
  for (const r of workflowRefs(def)) {
    if (r.kind === "event" && !events.has(r.value)) problems.push(`node ${r.node}: "${r.value}" is not an event the engine knows (${r.what})`);
    if (r.kind === "classify_domain" && !domains.has(r.value)) problems.push(`node ${r.node}: classifies into "${r.value}", which has no options`);
    if (r.kind === "workflow" && !(await one(c, "select 1 from workflows where company_id=$1 and name=$2", [companyId, r.value]))) warnings.push(`node ${r.node} hands off to "${r.value}", which this company does not have`);
  }
  if (problems.length) return { ok: false, problems };
  const manifest = extractManifest(def);
  const bound = new Set((await many<{ key: string }>(c, "select key from bindings where company_id=$1", [companyId])).map((b) => b.key));
  const missing = manifest.bindings.filter((b) => b.required && !bound.has(b.key)).map((b) => b.key);
  return { ok: true, def, manifest, missing, warnings };
}

const edgeName = (e: { from: string; to: string; label?: string }) => `${e.from}→${e.to}${e.label ? ` (${e.label})` : ""}`;
export function diffDefinitions(before: Definition, after: Definition): DefinitionDiff {
  const b = new Map(before.nodes.map((n) => [n.id, canon(n)])), a = new Map(after.nodes.map((n) => [n.id, canon(n)]));
  const be = new Map(before.edges.map((e) => [canon(e), e])), ae = new Map(after.edges.map((e) => [canon(e), e]));
  const settings = (["reentry", "reentry_window", "reentry_key", "premise"] as const).filter((k) => canon(before[k] ?? null) !== canon(after[k] ?? null));
  return {
    nodes: { added: [...a.keys()].filter((id) => !b.has(id)), removed: [...b.keys()].filter((id) => !a.has(id)), changed: [...a.keys()].filter((id) => b.has(id) && b.get(id) !== a.get(id)) },
    edges: { added: [...ae].filter(([k]) => !be.has(k)).map(([, e]) => edgeName(e)), removed: [...be].filter(([k]) => !ae.has(k)).map(([, e]) => edgeName(e)) },
    settings,
  };
}
const isEmpty = (d: DefinitionDiff) => !d.nodes.added.length && !d.nodes.removed.length && !d.nodes.changed.length && !d.edges.added.length && !d.edges.removed.length && !d.settings.length;

export type SaveDefinitionResult =
  | { ok: true; saved: boolean; dryRun: boolean; from: number; version: number; diff: DefinitionDiff; missing: string[]; warnings: string[]; layout: Layout }
  | { ok: false; status: number; why: string; problems?: string[]; missing?: string[] };

/**
 * D111: refused when no layout draws the workflow exactly (it never happens: the plain graph draws any graph, and says so
 * in `layout`); a workflow Tyler cannot see exactly is one he cannot update.
 * Missing required bindings are a warning while the workflow is off (it can be saved; readiness refuses turning it on), and a
 * refusal while it is on: saving would leave a workflow that is running without what its steps read.
 */
export async function saveDefinition(c: PoolClient, args: { workflowId: string; definition: unknown; note: string; by?: string; dryRun?: boolean; /** D147: the copy saved is this template version, not an edit */ asTemplate?: number }): Promise<SaveDefinitionResult> {
  if (!args.note?.trim()) return { ok: false, status: 400, why: "a note is required: say what changed and why" };
  const w = await one<{ id: string; company_id: string; current_version: number; enabled: boolean }>(c, "select id, company_id, current_version, enabled from workflows where id=$1 for update", [args.workflowId]);
  if (!w) return { ok: false, status: 404, why: "workflow not found" };
  const cur = await one<{ definition: unknown }>(c, "select definition from workflow_versions where workflow_id=$1 and version=$2", [w.id, w.current_version]);
  if (!cur) return { ok: false, status: 409, why: "current version missing" };
  const v = await validateDefinition(c, w.company_id, args.definition);
  if (!v.ok) return { ok: false, status: 422, why: `the definition does not validate (${v.problems.length} problem${v.problems.length === 1 ? "" : "s"})`, problems: v.problems };
  const chart = await chartLayoutOf(v.def);
  if (chart.layout === "list") return { ok: false, status: 422, why: notDrawable(chart.problems), problems: chart.problems };
  const before = Definition.safeParse(cur.definition);
  // a stored copy on an older vocabulary does not parse: everything in the new one counts as changed
  const diff = before.success ? diffDefinitions(before.data, v.def) : diffDefinitions({ ...v.def, nodes: [], edges: [] }, v.def);
  const base = { from: w.current_version, diff, missing: v.missing, warnings: v.warnings, layout: chart.layout };
  if (before.success && isEmpty(diff)) {
    if (args.asTemplate !== undefined && !args.dryRun) await c.query("update workflows set template_version=$2, diverged=false, diverged_at=null where id=$1 and template_version is distinct from $2", [w.id, args.asTemplate]);
    return { ok: true, saved: false, dryRun: !!args.dryRun, version: w.current_version, ...base };
  }
  if (w.enabled && v.missing.length) return { ok: false, status: 409, why: `it is ON and would be missing ${v.missing.join(", ")}: bind them first, or turn it off and save`, missing: v.missing };
  if (args.dryRun) return { ok: true, saved: false, dryRun: true, version: w.current_version + 1, ...base };
  const next = w.current_version + 1;
  await c.query("insert into workflow_versions (workflow_id, version, definition, manifest, note) values ($1,$2,$3,$4,$5)", [w.id, next, v.def, v.manifest, args.note.trim()]);
  if (args.asTemplate !== undefined) await c.query("update workflows set current_version=$2, template_version=$5, diverged=false, diverged_at=null, reentry_policy=$3, reentry_window=$4 where id=$1", [w.id, next, v.def.reentry, v.def.reentry_window ?? null, args.asTemplate]);
  else await c.query("update workflows set current_version=$2, diverged=true, diverged_at=coalesce(diverged_at, now()), reentry_policy=$3, reentry_window=$4 where id=$1", [w.id, next, v.def.reentry, v.def.reentry_window ?? null]);
  await syncTriggers(c, w.company_id, w.id, v.def);
  await c.query("insert into audit_log (company_id, action, target_type, target_id, before, after) values ($1,'workflow.definition_saved','workflow',$2,$3,$4)",
    [w.company_id, w.id, { version: w.current_version }, { version: next, note: args.note.trim(), by: args.by ?? "operator", diff, ...(args.asTemplate !== undefined ? { template_version: args.asTemplate } : {}), ...(v.missing.length ? { missing: v.missing } : {}) }]);
  return { ok: true, saved: true, dryRun: false, version: next, ...base };
}

/**
 * D147: bring the shipped template to one workflow of one offer, the only way a template change reaches an offer that already
 * has the workflow. Asked for by name (dry run first); a new version of that copy, which is then the template's version again.
 */
export async function saveFromTemplate(c: PoolClient, args: { workflowId: string; note: string; by?: string; dryRun?: boolean }): Promise<SaveDefinitionResult & { template?: { slug: string; version: number } }> {
  const w = await one<{ slug: string | null }>(c, "select t.slug from workflows w left join workflow_templates t on t.id=w.template_id where w.id=$1", [args.workflowId]);
  if (!w) return { ok: false, status: 404, why: "workflow not found" };
  const t = templates.find((x) => x.slug === w.slug);
  if (!t) return { ok: false, status: 409, why: "this workflow is the company's own, not a copy of a shipped template" };
  const tpl = await syncTemplateRow(c, t);
  const r = await saveDefinition(c, { workflowId: args.workflowId, definition: t.definition, note: args.note, by: args.by, dryRun: args.dryRun, asTemplate: tpl.version });
  return r.ok ? { ...r, template: { slug: t.slug, version: tpl.version } } : r;
}

export type CreateWorkflowResult =
  | { ok: true; created: boolean; dryRun: boolean; id?: string; name: string; takesOver: string | null; missing: string[]; warnings: string[]; layout: Layout }
  | { ok: false; status: number; why: string; problems?: string[] };

/**
 * D123: a company's own workflow, made from a whole definition (no template behind it: template upgrades never touch it). It is
 * made OFF, version 1, its triggers synced, audited. `takesOver`: the shipped template whose job it does for this company (Call
 * booked, split in two by calendar for Dating (Nelly)); install never puts that template on the company again, and the company
 * must not still have the template's copy (removed first with DELETE /api/admin/workflows), so one booking can never run both.
 */
export async function createCompanyWorkflow(c: PoolClient, args: { companyId: string; name: string; definition: unknown; note: string; by?: string; stage?: string; sort?: number; takesOver?: string; dryRun?: boolean }): Promise<CreateWorkflowResult> {
  const name = args.name?.trim();
  if (!name) return { ok: false, status: 400, why: "a name is required" };
  if (!args.note?.trim()) return { ok: false, status: 400, why: "a note is required: say what it does and why" };
  if (await one(c, "select 1 from workflows where company_id=$1 and lower(name)=lower($2)", [args.companyId, name])) return { ok: false, status: 409, why: `this company already has a workflow named "${name}"` };
  const takesOver = args.takesOver?.trim() || null;
  if (takesOver) {
    if (!templates.some((t) => t.slug === takesOver)) return { ok: false, status: 400, why: `takesOver: no shipped template "${takesOver}"` };
    const copy = await one<{ name: string; enabled: boolean }>(c, "select w.name, w.enabled from workflows w join workflow_templates t on t.id=w.template_id where w.company_id=$1 and t.slug=$2", [args.companyId, takesOver]);
    if (copy) return { ok: false, status: 409, why: `the company still has "${copy.name}"${copy.enabled ? " and it is ON" : ""}: turn it off and remove it first (DELETE /api/admin/workflows { company, workflow: "${takesOver}" }), so no event runs both` };
  }
  const v = await validateDefinition(c, args.companyId, args.definition);
  if (!v.ok) return { ok: false, status: 422, why: `the definition does not validate (${v.problems.length} problem${v.problems.length === 1 ? "" : "s"})`, problems: v.problems };
  const chart = await chartLayoutOf(v.def);
  if (chart.layout === "list") return { ok: false, status: 422, why: notDrawable(chart.problems), problems: chart.problems };
  const base = { name, takesOver, missing: v.missing, warnings: v.warnings, layout: chart.layout };
  if (args.dryRun) return { ok: true, created: false, dryRun: true, ...base };
  const wf = (await one<{ id: string }>(c, `insert into workflows (company_id, name, reentry_policy, reentry_window, stage, sort, origin, takes_over) values ($1,$2,$3,$4,$5,$6,'company',$7) returning id`,
    [args.companyId, name, v.def.reentry, v.def.reentry_window ?? null, args.stage ?? null, args.sort ?? 0, takesOver]))!;
  await c.query("insert into workflow_versions (workflow_id, version, definition, manifest, note) values ($1,1,$2,$3,$4)", [wf.id, v.def, v.manifest, args.note.trim()]);
  await syncTriggers(c, args.companyId, wf.id, v.def);
  await c.query("insert into audit_log (company_id, action, target_type, target_id, after) values ($1,'workflow.created','workflow',$2,$3)",
    [args.companyId, wf.id, { name, note: args.note.trim(), by: args.by ?? "operator", ...(takesOver ? { takes_over: takesOver } : {}), ...(v.missing.length ? { missing: v.missing } : {}) }]);
  return { ok: true, created: true, dryRun: false, id: wf.id, ...base };
}

/** A company's workflow by its id, its template's slug, or its exact name. */
export async function findCompanyWorkflow(c: PoolClient, companyId: string, ref: string): Promise<{ ok: true; id: string; name: string; slug: string | null } | { ok: false; why: string }> {
  const rows = await many<{ id: string; name: string; slug: string | null }>(c, "select w.id, w.name, t.slug from workflows w left join workflow_templates t on t.id=w.template_id where w.company_id=$1 and (w.id::text=$2 or t.slug=$2 or w.name=$2)", [companyId, ref]);
  if (rows.length !== 1) return { ok: false, why: rows.length ? "ambiguous workflow name" : "no such workflow for this company" };
  return { ok: true, ...rows[0] };
}
