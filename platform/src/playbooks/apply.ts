/**
 * D148: a playbook put on a company, and an offer's settings copied onto a new one ("duplicate PMU").
 *
 * `applyPlaybook` builds the company's copies from its playbook and params against today's templates and saves them: a copy of a
 * template the company has is saved over it (a new version; one already the same is left), a workflow of its own (D123) is
 * made OFF or saved over. All or nothing: every copy is checked first and nothing is written unless all of them pass. It never
 * removes anything: a template copy a playbook workflow takes over must be removed by hand first (DELETE /api/admin/workflows),
 * and says so. The playbook and its params are kept on the company (`playbook`), so it can be rebuilt after a template changes,
 * and `playbookState` says which copies fell behind.
 *
 * `copyOfferSettings`: the settings that are how an offer sells, not whose accounts it runs on, copied from one company to
 * another where the other has none of its own. Never a secret, an id, a channel, a person or a form (see OFFER_KEYS).
 */
import type { PoolClient } from "pg";
import { many, one } from "@/db/client";
import { defaultPrompts } from "@/prompts";
import { canon } from "@/engine/install";
import { parseDefinition } from "@/engine/definition";
import { createCompanyWorkflow, findCompanyWorkflow, saveDefinition } from "@/engine/definitions";
import { startRung, type StartRung } from "@/engine/rung";
import { applyWords, loadWords, type Words } from "@/engine/words";
import { playbookOf, type Copy, type InstallBits } from "./index";

export const PLAYBOOK_KEY = "playbook";

export type CopyOutcome = { workflow: string; name: string; did: "saved" | "created" | "current" | "refused"; why?: string; problems?: string[]; missing?: string[] };
export type RungPlan = { workflow: string; name: string; enabled: boolean; rung: StartRung; why: string };
export type ApplyResult =
  | { ok: true; dryRun: boolean; playbook: string; copies: CopyOutcome[]; prompts: string[]; rungs: RungPlan[] }
  | { ok: false; status: number; why: string; copies?: CopyOutcome[] };

/** What a playbook reads from the company, as its install file says it, from what the company has now. */
export async function installBitsOf(c: PoolClient, companyId: string): Promise<InstallBits> {
  const b = Object.fromEntries((await many<{ key: string; value: Buffer }>(c, "select key, value from bindings where company_id=$1 and kind<>'secret'", [companyId])).map((r) => [r.key, r.value.toString("utf8")]));
  const cals = await many<{ external_id: string; name: string; category: string; is_default: boolean }>(c, `select k.external_id, t.name, t.category, t.is_default from calendars k join company_terms t on t.id=k.appointment_term
    where k.company_id=$1 and k.active order by k.external_id`, [companyId]);
  const objections = b["sales_call.objections"] ? JSON.parse(b["sales_call.objections"]) as string[] : undefined;
  return {
    ...(b["scope.tag"] ? { scopeTag: b["scope.tag"] } : {}),
    calendars: Object.fromEntries(cals.map((k) => [k.external_id, k.is_default ? { term: k.category } : { term: k.category, name: k.name }])),
    ...(objections ? { salesCall: { objections } } : {}),
    prompts: Object.fromEntries(Object.entries(b).filter(([k]) => k.startsWith("prompt.")).map(([k, v]) => [k.slice("prompt.".length), v])),
  };
}

export async function applyPlaybook(c: PoolClient, args: { company: string; playbook: string; params?: unknown; dryRun?: boolean; by?: string }): Promise<ApplyResult> {
  const co = await one<{ id: string }>(c, "select id from companies where slug=$1", [args.company]);
  if (!co) return { ok: false, status: 404, why: `no such company: ${args.company} (install it first)` };
  let pb; try { pb = playbookOf(args.playbook); } catch (e) { return { ok: false, status: 400, why: (e as Error).message }; }
  const bits = await installBitsOf(c, co.id);
  let built; try { built = pb.build(args.company, args.params, bits); } catch (e) { return { ok: false, status: 422, why: (e as Error).message }; }
  const by = args.by ?? "operator";
  // first every copy as a dry run: nothing is written unless all of them pass
  // one connection, one query at a time
  const checked: CopyOutcome[] = [];
  for (const copy of built.copies) checked.push(await putCopy(c, co.id, copy, by, true));
  if (checked.some((o) => o.did === "refused")) return { ok: false, status: 422, why: `${checked.filter((o) => o.did === "refused").length} of the playbook's copies cannot be saved: nothing was`, copies: checked };
  // what the build writes into the install file: the call prompts (D118), bound where they differ from the company's
  const prompts = Object.entries((built.install?.prompts ?? {}) as Record<string, string>).filter(([k, v]) => bits.prompts?.[k] !== v).map(([k]) => k).sort();
  if (args.dryRun) return { ok: true, dryRun: true, playbook: pb.slug, copies: checked, prompts, rungs: await rungPlan(c, co.id, built.copies) };
  const copies: CopyOutcome[] = [];
  for (const copy of built.copies) copies.push(await putCopy(c, co.id, copy, by, false));
  for (const k of prompts) await bindText(c, co.id, `prompt.${k}`, (built.install!.prompts as Record<string, string>)[k]);
  await bindText(c, co.id, PLAYBOOK_KEY, JSON.stringify({ slug: pb.slug, params: args.params ?? null }));
  await c.query("insert into audit_log (company_id, action, target_type, target_id, after) values ($1,'playbook.applied','company',$2,$3)", [co.id, co.id, { playbook: pb.slug, by, copies: copies.map((o) => `${o.workflow}: ${o.did}`) }]);
  return { ok: true, dryRun: false, playbook: pb.slug, copies, prompts, rungs: await rungPlan(c, co.id) };
}

/** D155: a copy is saved with the company's words laid over it, so a rebuild never loses them. */
const withWords = (copy: Copy, words: Words): Copy => ({ ...copy, definition: applyWords(copy.definition as { nodes: unknown[] }, words[copy.create ? `own:${copy.name}` : copy.workflow]).def as Record<string, unknown> });

async function putCopy(c: PoolClient, companyId: string, bare: Copy, by: string, dryRun: boolean): Promise<CopyOutcome> {
  const copy = withWords(bare, await loadWords(c, companyId));
  const ref = copy.create ? copy.name! : copy.workflow;
  const found = await findCompanyWorkflow(c, companyId, ref);
  const name = copy.name ?? (found.ok ? found.name : copy.workflow);
  const note = `${copy.note} (playbook, D148)`;
  if (!found.ok) {
    if (!copy.create) return { workflow: copy.workflow, name, did: "refused", why: `the company does not have ${copy.workflow}: install its template first` };
    const r = await createCompanyWorkflow(c, { companyId, name: copy.name!, definition: copy.definition, note, by, stage: copy.create.stage, sort: copy.create.sort, takesOver: copy.create.takesOver, dryRun });
    return r.ok ? { workflow: copy.workflow, name, did: dryRun ? "created" : r.created ? "created" : "current", missing: r.missing } : { workflow: copy.workflow, name, did: "refused", why: r.why, problems: r.problems };
  }
  const r = await saveDefinition(c, { workflowId: found.id, definition: copy.definition, note, by, dryRun });
  if (!r.ok) return { workflow: copy.workflow, name, did: "refused", why: r.why, problems: r.problems, missing: r.missing };
  return { workflow: copy.workflow, name, did: !r.saved && r.version === r.from ? "current" : "saved", missing: r.missing };
}

const bindText = (c: PoolClient, companyId: string, key: string, value: string) =>
  c.query("insert into bindings (company_id, key, kind, value) values ($1,$2,'text',$3) on conflict (company_id, key) do update set kind='text', value=excluded.value, updated_at=now()", [companyId, key, Buffer.from(value)]);

/** #48: every workflow of the company and the rung it starts on by what it does; `pending` copies (a dry run) stand in for what they replace. */
export async function rungPlan(c: PoolClient, companyId: string, pending: Copy[] = []): Promise<RungPlan[]> {
  const rows = await many<{ name: string; slug: string | null; enabled: boolean; definition: unknown }>(c, `select w.name, t.slug, w.enabled, v.definition from workflows w
    join workflow_versions v on v.workflow_id=w.id and v.version=w.current_version left join workflow_templates t on t.id=w.template_id where w.company_id=$1 order by w.stage nulls last, w.sort, w.name`, [companyId]);
  const out: RungPlan[] = rows.map((r) => {
    const p = pending.find((x) => (x.create ? x.name === r.name : x.workflow === r.slug));
    const s = startRung(parseDefinition(p?.definition ?? r.definition));
    return { workflow: r.slug ?? r.name, name: r.name, enabled: r.enabled, ...s };
  });
  for (const p of pending.filter((x) => x.create && !rows.some((r) => r.name === x.name))) out.push({ workflow: p.workflow, name: p.name!, enabled: false, ...startRung(parseDefinition(p.definition)) });
  return out;
}

/** The company's playbook as last applied, and which of its copies are no longer what the playbook builds from today's templates. */
export async function playbookState(c: PoolClient, companyId: string, slug: string): Promise<{ playbook: string | null; stale: string[]; why?: string }> {
  const b = await one<{ value: Buffer }>(c, "select value from bindings where company_id=$1 and key=$2", [companyId, PLAYBOOK_KEY]);
  if (!b) return { playbook: null, stale: [] };
  const kept = JSON.parse(b.value.toString("utf8")) as { slug: string; params: unknown };
  let built; try { built = playbookOf(kept.slug).build(slug, kept.params ?? undefined, await installBitsOf(c, companyId)); } catch (e) { return { playbook: kept.slug, stale: [], why: (e as Error).message }; }
  const stale: string[] = [], words = await loadWords(c, companyId);
  for (const bare of built.copies) {
    const copy = withWords(bare, words);
    const found = await findCompanyWorkflow(c, companyId, copy.create ? copy.name! : copy.workflow);
    if (!found.ok) { stale.push(copy.workflow); continue; }
    const cur = await one<{ definition: unknown }>(c, "select v.definition from workflows w join workflow_versions v on v.workflow_id=w.id and v.version=w.current_version where w.id=$1", [found.id]);
    if (canon(parseDefinition(cur!.definition)) !== canon(parseDefinition(copy.definition))) stale.push(copy.workflow);
  }
  return { playbook: kept.slug, stale };
}

/**
 * The settings that are how an offer sells: its call prompts, how it qualifies, what its Sales Call's answers mean, how setter
 * calls are read, call timing, alert manners, report manners. Not copied: secrets, ids, channels, the scope tag, Calendly's
 * questions, the booking card (it names the company's own fields), closers' options (people), test scripts, deposit products,
 * forms, the playbook (chosen per company), the price (asked per offer).
 */
export const OFFER_KEYS = [
  "qualify.mql_answers", "qualify.dq_answers", "qualify.unanswered_is_mql",
  "sales_call.outcomes", "sales_call.dispositions", "sales_call.dq_dispositions", "sales_call.objections", "sales_call.booking_sources",
  "discovery_call.results", "setter_result.act", "setter_result.set_within_min",
  "calls.transcript_wait_min", "calls.conversation_gap_min", "calls.transcript_hold_hours",
  "booking.setter_rule", "test.domains", "crm.tasks", "reports.quiet_when_empty", "slack.name", "slack.icon",
  "alerts.as_name", "alerts.as_icon", "alerts.repeat_minutes", "alerts.repeat_hours", "alerts.repeat_timezone", "alerts.poll_failures",
];
const isOfferKey = (k: string) => OFFER_KEYS.includes(k) || k.startsWith("prompt.");

export type CopySettingsResult =
  | { ok: true; dryRun: boolean; from: string; to: string; copied: string[]; kept: string[]; terms: string[] }
  | { ok: false; status: number; why: string };

export async function copyOfferSettings(c: PoolClient, args: { from: string; to: string; dryRun?: boolean; by?: string }): Promise<CopySettingsResult> {
  if (args.from === args.to) return { ok: false, status: 400, why: "from and to are the same company" };
  const src = await one<{ id: string }>(c, "select id from companies where slug=$1", [args.from]);
  if (!src) return { ok: false, status: 404, why: `no such company: ${args.from}` };
  const dst = await one<{ id: string }>(c, "select id from companies where slug=$1", [args.to]);
  if (!dst) return { ok: false, status: 404, why: `no such company: ${args.to} (install it first)` };
  const rows = await many<{ key: string; kind: string; value: Buffer }>(c, "select key, kind, value from bindings where company_id=$1 and kind in ('text','number') order by key", [src.id]);
  const have = new Map((await many<{ key: string; value: Buffer }>(c, "select key, value from bindings where company_id=$1", [dst.id])).map((r) => [r.key, r.value.toString("utf8")]));
  const copied: string[] = [], kept: string[] = [];
  for (const r of rows.filter((x) => isOfferKey(x.key))) {
    const mine = have.get(r.key), theirs = r.value.toString("utf8");
    // the target's own value stays; an untouched default prompt is not its own
    const own = mine !== undefined && !(r.key.startsWith("prompt.") && mine === defaultPrompts[r.key.slice("prompt.".length)]);
    if (own) { if (mine !== theirs) kept.push(r.key); continue; }
    if (mine === theirs) continue;
    copied.push(r.key);
    if (!args.dryRun) await c.query("insert into bindings (company_id, key, kind, value) values ($1,$2,$3,$4) on conflict (company_id, key) do update set kind=excluded.kind, value=excluded.value, updated_at=now()", [dst.id, r.key, r.kind, r.value]);
  }
  // the offer's own words for its calls and outcomes (D101: kept by name), made where the target has none of that name
  const terms = await many<{ domain: string; name: string; category: string; sort: number }>(c, `select s.domain, s.name, s.category, s.sort from company_terms s
    where s.company_id=$1 and not s.is_default and s.active and not exists (select 1 from company_terms t where t.company_id=$2 and t.domain=s.domain and t.name=s.name) order by s.domain, s.name`, [src.id, dst.id]);
  if (!args.dryRun) {
    for (const t of terms) await c.query("insert into company_terms (company_id, domain, name, category, is_default, sort) values ($1,$2,$3,$4,false,$5) on conflict (company_id, domain, name) do nothing", [dst.id, t.domain, t.name, t.category, t.sort]);
    await c.query("insert into audit_log (company_id, action, target_type, target_id, after) values ($1,'settings.copied','company',$2,$3)", [dst.id, dst.id, { from: args.from, by: args.by ?? "operator", copied, kept, terms: terms.map((t) => `${t.domain}: ${t.name}`) }]);
  }
  return { ok: true, dryRun: !!args.dryRun, from: args.from, to: args.to, copied, kept, terms: terms.map((t) => `${t.domain}: ${t.name}`) };
}
