/**
 * D155: a playbook's template business. Tyler (2026-10-19): "create a business with no API keys called template, and we'll have
 * all the options there; if we want to make adjustments to all future ones we change the templates" — one per playbook, edited
 * there and published.
 *
 * A template business is a company with status `template`: the engine never polls or ticks it (only active and hosted run), it
 * has no keys, and it holds its playbook installed as a client would have it (every shipped template, the playbook's copies),
 * every workflow off, in ghost. Tyler edits its words (D154) and its playbook's params there. **Publish** checks it and keeps a
 * release: its words, its params and its offer settings (the same allowlist duplicating uses, OFFER_KEYS). A new client on that
 * playbook starts from the latest release: the wizard's params (made the offer's), and at install its words and settings, where
 * the client has none of its own. Existing clients are not touched (Tyler: future ones).
 *
 * Steps are not published: a workflow's structure lives in code (src/templates, src/playbooks), where it is tested and reviewed and
 * where every deploy takes it from. A template business whose workflow was changed beyond words is refused at publish, naming it:
 * that change goes through the code (the build-workflow skill).
 */
import type { PoolClient } from "pg";
import { many, one } from "@/db/client";
import { templates } from "@/templates";
import { defaultPrompts } from "@/prompts";
import { canon, installTemplates } from "@/engine/install";
import { parseDefinition, type Node } from "@/engine/definition";
import { EDITABLE, validateCopy, type CopyField } from "@/engine/copy";
import { loadWords, WORDS_KEY, type Words } from "@/engine/words";
import { chartLayoutOf } from "@/api/chart-verdict";
import { foreignWords } from "@/onboarding/messages";
import { applyPlaybook, OFFER_KEYS, PLAYBOOK_KEY } from "./apply";
import { playbookOf } from "./index";
import { OBJECTIONS } from "./ghl-setup";
import { fitReport, type Intake } from "@/onboarding/intake";
import { scenariosFor, testedFingerprint, testsTodo, type Tests } from "@/onboarding/tests";

export const templateSlug = (playbook: string) => `template-${playbook}`;

/**
 * D159: the offer a template business tests: its playbook at its fullest (setters where it has them, an application where it has
 * one, deposits, plans, an agreement), on software that needs no key beyond GHL and Slack: payments and recordings come through
 * the doors a Zap would use (the harness stages them), bookings are GHL calendars, the agreement a GHL document.
 */
export function templateIntake(playbook: string): Intake {
  const pb = playbookOf(playbook), t = pb.traits;
  return {
    business: `Template – ${pb.name}`, price: "5000", deposits: true, payment_plans: true,
    lead_paths: t.application ? ["ads_vsl_application"] : ["ads_direct_book"], application: t.application ? "ghl_form" : "none",
    setters: t.booking.includes("setter"), triage: t.triage, boards: t.boards,
    journey: `The ${pb.name} playbook as shipped, tested in the sandbox before a release.`,
    crm: "ghl", booking: "ghl", payments: "other", recording: "other", agreement: "ghl_documents",
  };
}

/**
 * D159/D160: the template business's record of its setup and tests (the same record a client's wizard keeps, so the same steps
 * and passes serve both), driven by Claude in the sandbox (sandbox.ts), never shown as a wizard. The offer is its playbook's
 * (templateIntake) and its messages need no approval: they are the template's own words, checked at publish. Made once.
 */
export async function ensureTemplateOnboarding(c: PoolClient, playbook: string, companyId: string, by = "dashboard") {
  if (await one(c, "select 1 from onboarding where company_id=$1", [companyId])) return;
  const intake = templateIntake(playbook), kept = await one<{ value: Buffer }>(c, "select value from bindings where company_id=$1 and key=$2", [companyId, PLAYBOOK_KEY]);
  const params = kept ? (JSON.parse(kept.value.toString("utf8")) as { params: unknown }).params ?? null : null;
  const done = { done_at: new Date().toISOString(), by: "template" };
  await c.query("insert into onboarding (company_id, kind, intake, playbook, params, fit, steps, started_by) values ($1,'new',$2,$3,$4,$5,$6,$7)",
    [companyId, intake, playbook, params === null ? null : JSON.stringify(params), fitReport(intake, "new", playbook), { offer: done, messages: done }, by]);
}
export type Release = { playbook: string; version: number; words: Words; params: unknown; settings: Record<string, string>; notes: string[]; published_at: string; published_by: string | null };

export async function latestRelease(c: PoolClient, playbook: string): Promise<Release | null> {
  const r = await one<Release & { published_at: Date }>(c, "select playbook, version, words, params, settings, notes, published_at, published_by from playbook_releases where playbook=$1 order by version desc limit 1", [playbook]);
  return r ? { ...r, published_at: new Date(r.published_at).toISOString() } : null;
}

/** The playbook's template business, made when it is not there yet: its playbook installed, every workflow off, the latest release's words on. */
export async function ensureTemplateBusiness(c: PoolClient, playbook: string, by = "dashboard"): Promise<{ ok: true; id: string; slug: string; created: boolean } | { ok: false; status: number; why: string }> {
  let pb; try { pb = playbookOf(playbook); } catch (e) { return { ok: false, status: 404, why: (e as Error).message }; }
  const slug = templateSlug(playbook);
  const had = await one<{ id: string }>(c, "select id from companies where slug=$1", [slug]);
  if (had) { await ensureTemplateOnboarding(c, playbook, had.id, by); return { ok: true, id: had.id, slug, created: false }; }
  const co = (await one<{ id: string }>(c, "insert into companies (name, slug, timezone, mode, status, sms_enabled) values ($1,$2,'America/New_York','ghost','template',false) returning id", [`Template – ${pb.name}`, slug]))!;
  await c.query("insert into company_terms (company_id, domain, name, category, is_default, sort) select $1, domain, label, value, true, sort from core_categories on conflict (company_id, domain, name) do nothing", [co.id]);
  const release = await latestRelease(c, playbook);
  if (release) {
    await c.query("insert into bindings (company_id, key, kind, value) values ($1,$2,'text',$3)", [co.id, WORDS_KEY, Buffer.from(JSON.stringify(release.words))]);
    for (const [k, v] of Object.entries(release.settings)) await c.query("insert into bindings (company_id, key, kind, value) values ($1,$2,'text',$3) on conflict (company_id, key) do nothing", [co.id, k, Buffer.from(v)]);
  }
  // what a client's CRM build gives it (D152): the Sales Call's objections, which a playbook's call prompts read
  await c.query("insert into bindings (company_id, key, kind, value) values ($1,'sales_call.objections','text',$2) on conflict (company_id, key) do nothing", [co.id, Buffer.from(JSON.stringify(OBJECTIONS))]);
  // the call prompts every client gets at install (defaultPrompts), here to be edited and published with the rest
  for (const [k, v] of Object.entries(defaultPrompts)) await c.query("insert into bindings (company_id, key, kind, value) values ($1,$2,'text',$3) on conflict (company_id, key) do nothing", [co.id, `prompt.${k}`, Buffer.from(v)]);
  const params = release?.params ?? pb.defaults("Template") ?? undefined;
  const built = pb.build(slug, params, { calendars: {}, salesCall: { objections: ["price"] } });
  const takenOver = new Set(built.copies.flatMap((x) => (x.create?.takesOver ? [x.create.takesOver] : [])));
  await installTemplates(c, co.id, templates.map((t) => t.slug).filter((s) => !takenOver.has(s)), { existed: false });
  const r = await applyPlaybook(c, { company: slug, playbook, params, by });
  if (!r.ok) throw new Error(`the ${pb.name} template business could not take its playbook: ${r.why}`);
  await ensureTemplateOnboarding(c, playbook, co.id, by);
  await c.query("insert into audit_log (company_id, action, target_type, target_id, after) values ($1,'template.created','company',$2,$3)", [co.id, co.id, { playbook, from_release: release?.version ?? null, by }]);
  return { ok: true, id: co.id, slug, created: true };
}

/** New params for the template business: checked by its playbook, its copies rebuilt with them (its words kept). */
export async function setTemplateParams(c: PoolClient, playbook: string, params: unknown, by = "dashboard") {
  const r = await applyPlaybook(c, { company: templateSlug(playbook), playbook, params, by });
  // D159: its wizard record follows, so an install from the wizard builds the same copies
  if (r.ok && !("dryRun" in r && r.dryRun)) await c.query("update onboarding set params=$2 where company_id=(select id from companies where slug=$1)", [templateSlug(playbook), params === undefined ? null : JSON.stringify(params)]);
  return r;
}

export type PublishResult = { ok: true; release: Release } | { ok: false; status: number; why: string; problems?: string[] };

/**
 * The template business checked and published. Refused, naming each: a workflow changed beyond words (a code change), a word
 * that is not valid copy, another client's words, a workflow the engine cannot read or draw exactly. Placeholders left in are
 * allowed and noted: each client writes those in its own Messages step. D159: refused too until it is tested: every journey
 * passed on the test rung in the sandbox, on exactly the workflow versions and words being published (`untested`).
 */
export async function publish(c: PoolClient, playbook: string, by = "dashboard"): Promise<PublishResult> {
  const slug = templateSlug(playbook);
  const co = await one<{ id: string }>(c, "select id from companies where slug=$1 and status='template'", [slug]);
  if (!co) return { ok: false, status: 404, why: `there is no ${playbook} template business yet` };
  const pb = playbookOf(playbook);
  const kept = await one<{ value: Buffer }>(c, "select value from bindings where company_id=$1 and key=$2", [co.id, PLAYBOOK_KEY]);
  const params = kept ? (JSON.parse(kept.value.toString("utf8")) as { params: unknown }).params : undefined;
  const words = await loadWords(c, co.id);
  // what the steps should be: each shipped template, and each playbook copy as its params build it
  const copies = pb.build(slug, params ?? undefined, { calendars: {}, salesCall: { objections: ["price"] } }).copies;
  const expected = new Map<string, unknown>([...templates.map((t) => [t.slug, t.definition] as [string, unknown]), ...copies.map((x) => [x.create ? `own:${x.name}` : x.workflow, x.definition] as [string, unknown])]);
  const rows = await many<{ name: string; slug: string | null; definition: unknown }>(c, `select w.name, t.slug, v.definition from workflows w left join workflow_templates t on t.id=w.template_id
    join workflow_versions v on v.workflow_id=w.id and v.version=w.current_version where w.company_id=$1 order by w.name`, [co.id]);
  const problems: string[] = [...(await untested(c, co.id))], notes: string[] = [];
  const bare = (d: unknown) => canon({ ...(d as object), nodes: ((d as { nodes: (Node & Record<string, unknown>)[] }).nodes).map((n) => Object.fromEntries(Object.entries(n).filter(([k]) => !(EDITABLE[n.type] ?? []).includes(k as CopyField)))) });
  for (const r of rows) {
    const key = r.slug ?? `own:${r.name}`, want = expected.get(key);
    let def; try { def = parseDefinition(r.definition); } catch { problems.push(`${r.name}: the engine cannot read it`); continue; }
    // both read as the engine reads them (a saved copy carries the parser's defaults filled in), words set aside
    if (want !== undefined && bare(def) !== bare(parseDefinition(want))) problems.push(`${r.name}: changed beyond its words; a change to its steps goes through the code (the build-workflow skill), so every client's upgrades keep working`);
    if ((await chartLayoutOf(def)).layout === "list") problems.push(`${r.name}: its chart cannot be drawn exactly`);
    for (const n of def.nodes as (Node & Record<string, unknown>)[]) for (const f of EDITABLE[n.type] ?? []) {
      const text = n[f]; if (typeof text !== "string") continue;
      const foreign = foreignWords(slug, text); if (foreign.length) problems.push(`${r.name}, "${String(n.title ?? n.id)}": another client's words (${foreign.join(", ")})`);
      if ((n.type === "send_sms" || n.type === "send_email") && /\[placeholder\b/i.test(text)) notes.push(`${r.name}, "${String(n.title ?? n.id)}": a placeholder, written per client`);
    }
  }
  for (const [wf, steps] of Object.entries(words)) for (const [id, fields] of Object.entries(steps)) for (const [f, text] of Object.entries(fields ?? {})) { const v = validateCopy(String(text)); if (!v.ok) problems.push(`${wf} ${id}.${f}: ${v.why}`); }
  if (problems.length) return { ok: false, status: 422, why: `${problems.length} thing${problems.length === 1 ? "" : "s"} to fix before it can be published`, problems };
  const settings = Object.fromEntries((await many<{ key: string; value: Buffer }>(c, "select key, value from bindings where company_id=$1 and kind in ('text','number') order by key", [co.id]))
    .filter((b) => OFFER_KEYS.includes(b.key) || b.key.startsWith("prompt.")).map((b) => [b.key, b.value.toString("utf8")]));
  const version = ((await one<{ v: number }>(c, "select coalesce(max(version),0)::int as v from playbook_releases where playbook=$1", [playbook]))!.v) + 1;
  await c.query("insert into playbook_releases (playbook, version, words, params, settings, notes, published_by) values ($1,$2,$3,$4,$5,$6,$7)", [playbook, version, JSON.stringify(words), params === undefined ? null : JSON.stringify(params), JSON.stringify(settings), JSON.stringify(notes), by]);
  await c.query("insert into audit_log (company_id, action, target_type, target_id, after) values ($1,'template.published','company',$2,$3)", [co.id, co.id, { playbook, version, by, notes }]);
  return { ok: true, release: (await latestRelease(c, playbook))! };
}

/**
 * D159: what stands between the template business's test passes and a publish: every journey run on the test rung in the
 * sandbox (real writes to the test contact), on exactly what is being published (the same workflow versions and words), nothing
 * left to do. One line each; none means tested.
 */
export async function untested(c: PoolClient, companyId: string): Promise<string[]> {
  const o = await one<{ tests: Tests; intake: Intake }>(c, "select tests, intake from onboarding where company_id=$1", [companyId]);
  if (!o?.tests.prepared) return ["not tested: set it up in the sandbox (its onboarding page) and run the test passes on the test rung"];
  const fp = await testedFingerprint(c, companyId), out: string[] = [];
  for (const [id, r] of Object.entries(o.tests.results ?? {})) {
    if (r.rung !== "test") out.push(`test pass "${id}" ran in ${r.rung}: run it again on the test rung, where its writes are real`);
    else if (r.fp !== fp) out.push(`test pass "${id}" tested an earlier version (a word or a step changed since): run it again`);
  }
  return [...testsTodo(o.tests, await scenariosFor(c, companyId, o.intake)).map((t) => `test passes: ${t}`), ...out];
}

/**
 * D155: a new client starts from its playbook's latest release: its words and settings, where the client has none of its own
 * (before install, so install and the playbook lay them on). Returns the release's version, or null when there is none.
 */
export async function seedFromRelease(c: PoolClient, companyId: string, playbook: string): Promise<number | null> {
  const r = await latestRelease(c, playbook);
  if (!r) return null;
  const mine = await loadWords(c, companyId), merged: Words = { ...r.words };
  for (const [wf, steps] of Object.entries(mine)) merged[wf] = { ...(merged[wf] ?? {}), ...Object.fromEntries(Object.entries(steps).map(([id, f]) => [id, { ...(merged[wf]?.[id] ?? {}), ...f }])) };
  await c.query("insert into bindings (company_id, key, kind, value) values ($1,$2,'text',$3) on conflict (company_id, key) do update set value=excluded.value, updated_at=now()", [companyId, WORDS_KEY, Buffer.from(JSON.stringify(merged))]);
  for (const [k, v] of Object.entries(r.settings)) await c.query("insert into bindings (company_id, key, kind, value) values ($1,$2,'text',$3) on conflict (company_id, key) do nothing", [companyId, k, Buffer.from(v)]);
  await c.query("insert into audit_log (company_id, action, target_type, target_id, after) values ($1,'template.seeded','company',$2,$3)", [companyId, companyId, { playbook, version: r.version }]);
  return r.version;
}
