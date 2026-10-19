/**
 * D154: a company's own words, kept apart from the steps. A message's words (an SMS, an email's subject and body, a Slack
 * post, a note, a task) are the company's; the steps around them are the template's or the playbook's. The words are kept as
 * one setting (`copy.words`: workflow → step → field → text) and laid over the workflow every time it is built: when install
 * puts a template on or upgrades it, when a playbook's copies are built (D147), and when a word is changed. So a word edit no
 * longer freezes a copy (it stays "untouched" and keeps getting its template's fixes, D141 is why that matters), and a rebuild
 * never loses the words. A copy edited beyond words (a step changed, D-edits) is still the company's own and left alone.
 * A workflow is named by its template's slug, or `own:<name>` for a company's own workflow (D123).
 */
import type { PoolClient } from "pg";
import { many, one } from "@/db/client";
import { parseDefinition, type Definition, type Node } from "./definition";
import { EDITABLE, validateCopy, type CopyField } from "./copy";
import { chartLayoutOf, notDrawable, type Layout } from "@/api/chart-verdict";

export const WORDS_KEY = "copy.words";
export type Words = Record<string, Record<string, Partial<Record<CopyField, string>>>>;

export const wordsKeyOf = (w: { slug?: string | null; name: string }) => (w.slug ? w.slug : `own:${w.name}`);

export async function loadWords(c: PoolClient, companyId: string): Promise<Words> {
  const b = await one<{ value: Buffer }>(c, "select value from bindings where company_id=$1 and key=$2", [companyId, WORDS_KEY]);
  if (!b) return {};
  try { return JSON.parse(b.value.toString("utf8")) as Words; } catch { return {}; }
}
async function storeWords(c: PoolClient, companyId: string, w: Words) {
  await c.query("insert into bindings (company_id, key, kind, value) values ($1,$2,'text',$3) on conflict (company_id, key) do update set value=excluded.value, updated_at=now()", [companyId, WORDS_KEY, Buffer.from(JSON.stringify(w))]);
}

/**
 * The definition with the company's words laid over it. A word whose step or field is gone from the workflow (a template that
 * dropped the step) is not applied and is named in `unused`, so nothing is silently lost.
 */
export function applyWords<D extends { nodes: unknown[] }>(def: D, words: Words[string] | undefined): { def: D; unused: string[] } {
  if (!words || !Object.keys(words).length) return { def, unused: [] };
  const out = JSON.parse(JSON.stringify(def)) as D, unused: string[] = [];
  for (const [nodeId, fields] of Object.entries(words)) {
    const node = (out.nodes as (Node & Record<string, unknown>)[]).find((n) => n.id === nodeId);
    for (const [field, text] of Object.entries(fields ?? {})) {
      if (!node || !EDITABLE[node.type]?.includes(field as CopyField)) { unused.push(`${nodeId}.${field}`); continue; }
      node[field] = text;
    }
  }
  return { def: out, unused };
}

export type SetWordResult = { ok: true; version: number; layout?: Layout } | { ok: false; why: string };

/**
 * One message's words changed: kept in the company's words and laid on the workflow as a new version. The workflow stays
 * untouched (not diverged), so template upgrades keep reaching it and bring the words along.
 */
export async function setWord(c: PoolClient, args: { workflowId: string; nodeId: string; field: CopyField; text: string; by?: string }): Promise<SetWordResult> {
  const v = validateCopy(args.text); if (!v.ok) return v;
  const w = await one<{ id: string; company_id: string; current_version: number; name: string; slug: string | null }>(c,
    "select w.id, w.company_id, w.current_version, w.name, t.slug from workflows w left join workflow_templates t on t.id=w.template_id where w.id=$1", [args.workflowId]);
  if (!w) return { ok: false, why: "workflow not found" };
  const cur = await one<{ definition: Definition; manifest: unknown }>(c, "select definition, manifest from workflow_versions where workflow_id=$1 and version=$2", [w.id, w.current_version]);
  if (!cur) return { ok: false, why: "current version missing" };
  const node = (cur.definition.nodes as (Node & Record<string, unknown>)[]).find((n) => n.id === args.nodeId);
  if (!node) return { ok: false, why: "step not found" };
  if (!EDITABLE[node.type]?.includes(args.field)) return { ok: false, why: `${args.field} is not editable on a ${node.type} step` };
  const key = wordsKeyOf(w), words = await loadWords(c, w.company_id);
  const before = node[args.field];
  words[key] = { ...(words[key] ?? {}), [args.nodeId]: { ...(words[key]?.[args.nodeId] ?? {}), [args.field]: args.text } };
  if (before === args.text) { await storeWords(c, w.company_id, words); return { ok: true, version: w.current_version }; }
  const def = applyWords(cur.definition, { [args.nodeId]: { [args.field]: args.text } }).def;
  let parsed; try { parsed = parseDefinition(def); } catch (e) { return { ok: false, why: `the change does not validate: ${String((e as Error).message).slice(0, 200)}` }; }
  const chart = await chartLayoutOf(parsed); if (chart.layout === "list") return { ok: false, why: `${notDrawable(chart.problems)}: ${chart.problems.join("; ")}` };
  await storeWords(c, w.company_id, words);
  const next = w.current_version + 1;
  await c.query("insert into workflow_versions (workflow_id, version, definition, manifest, note) values ($1,$2,$3,$4,$5)", [w.id, next, def, cur.manifest, `words: ${args.nodeId}.${args.field}`]);
  await c.query("update workflows set current_version=$2 where id=$1", [w.id, next]);
  await c.query("insert into audit_log (company_id, action, target_type, target_id, before, after) values ($1,'workflow.copy_edited','workflow',$2,$3,$4)", [w.company_id, w.id, { node: args.nodeId, field: args.field, text: before }, { node: args.nodeId, field: args.field, text: args.text, version: next, by: args.by ?? "dashboard", kept: "words" }]);
  return { ok: true, version: next, layout: chart.layout };
}

/**
 * D154: a company's earlier word edits moved into its words. A copy edited by `saveCopy` before D154 was marked edited
 * (diverged) and left behind by every template fix since. Where such a copy differs from its template only in words, those words
 * go into the company's words and the copy is untouched again (it then follows its template, words and all). A copy edited
 * beyond words, or behind its template, stays as it is and is named. `dryRun` writes nothing.
 */
export async function wordsFromEdits(c: PoolClient, companyId: string, dryRun: boolean): Promise<{ moved: { workflow: string; words: string[] }[]; kept: { workflow: string; why: string }[] }> {
  const rows = await many<{ id: string; name: string; slug: string; template_version: number | null; tversion: number; tdef: Definition; def: Definition }>(c,
    `select w.id, w.name, t.slug, w.template_version, t.version as tversion, t.definition as tdef, v.definition as def from workflows w join workflow_templates t on t.id=w.template_id
     join workflow_versions v on v.workflow_id=w.id and v.version=w.current_version where w.company_id=$1 and w.diverged order by w.name`, [companyId]);
  const words = await loadWords(c, companyId), moved: { workflow: string; words: string[] }[] = [], kept: { workflow: string; why: string }[] = [];
  for (const r of rows) {
    if (r.template_version !== r.tversion) { kept.push({ workflow: r.name, why: `behind its template (v${r.template_version ?? "?"} of v${r.tversion}): words cannot be told from changes` }); continue; }
    const strip = (d: Definition) => JSON.stringify({ ...d, nodes: (d.nodes as (Node & Record<string, unknown>)[]).map((n) => Object.fromEntries(Object.entries(n).filter(([k]) => !(EDITABLE[n.type] ?? []).includes(k as CopyField)))) });
    if (strip(r.def) !== strip(r.tdef)) { kept.push({ workflow: r.name, why: "edited beyond words (a step, a wait, a channel): it stays the company's own" }); continue; }
    const mine: Words[string] = {};
    for (const n of r.def.nodes as (Node & Record<string, unknown>)[]) {
      const t = (r.tdef.nodes as (Node & Record<string, unknown>)[]).find((x) => x.id === n.id)!;
      for (const f of EDITABLE[n.type] ?? []) if (n[f] !== undefined && n[f] !== t[f]) mine[n.id] = { ...(mine[n.id] ?? {}), [f]: n[f] as string };
    }
    moved.push({ workflow: r.name, words: Object.entries(mine).flatMap(([id, fs]) => Object.keys(fs).map((f) => `${id}.${f}`)) });
    if (dryRun) continue;
    words[r.slug] = { ...(words[r.slug] ?? {}), ...mine };
    await c.query("update workflows set diverged=false, diverged_at=null where id=$1", [r.id]);
  }
  if (!dryRun && moved.length) {
    await storeWords(c, companyId, words);
    await c.query("insert into audit_log (company_id, action, target_type, target_id, after) values ($1,'words.moved','company',$2,$3)", [companyId, companyId, { moved, kept }]);
  }
  return { moved, kept };
}
