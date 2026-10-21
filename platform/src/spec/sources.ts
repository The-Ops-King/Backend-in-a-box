import fs from "node:fs";
import path from "node:path";
import type { PoolClient } from "pg";
import { templates } from "@/templates";
import { parseDefinition } from "@/engine/definition";
import { slugify, type IndexRow, type OfferInfo, type WorkflowInfo } from "./render";

export const INSTALLS = path.resolve(__dirname, "../../installs");

type Tpl = { slug: string; name: string; stage?: string; definition: unknown; description?: string };
type CopyFile = { workflow: string; name?: string; create?: { stage?: string; takesOver?: string }; definition: unknown; note?: string };

/** The offers the repo has an install for: installs/<slug>.json plus a folder of its copies. */
export function repoOffers(): string[] {
  return fs.readdirSync(INSTALLS).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, ""))
    .filter((s) => fs.existsSync(path.join(INSTALLS, s)) && fs.statSync(path.join(INSTALLS, s)).isDirectory()).sort();
}

/**
 * An offer as the repo describes it: every shipped template (a new company gets all of them, install.ts), with the offer's
 * playbook copies saved over the ones they replace, its own workflows added, and the templates they take over marked removed.
 * The offer's words (D177) and any edit made since are in the live database only.
 */
export function loadRepoOffer(slug: string): { offer: OfferInfo; rows: IndexRow[] } {
  const install = JSON.parse(fs.readFileSync(path.join(INSTALLS, `${slug}.json`), "utf8")) as { name: string; slug: string; timezone?: string; mode?: string; smsEnabled?: boolean };
  const dir = path.join(INSTALLS, slug);
  const playbook = fs.existsSync(path.join(dir, "playbook.json")) ? (JSON.parse(fs.readFileSync(path.join(dir, "playbook.json"), "utf8")) as { playbook?: string }).playbook : undefined;
  const copies = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort()
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as Partial<CopyFile>)
    .filter((c): c is CopyFile => typeof c.workflow === "string" && !!c.definition);
  const offer: OfferInfo = { slug, name: install.name, source: "repo", timezone: install.timezone, mode: install.mode, smsEnabled: install.smsEnabled, playbook };
  const takenOver = new Map(copies.filter((c) => c.create?.takesOver).map((c) => [c.create!.takesOver!, c.name ?? c.workflow]));
  const rows: IndexRow[] = [];
  for (const t of templates as unknown as Tpl[]) {
    const copy = copies.find((c) => !c.create && c.workflow === t.slug);
    const w: WorkflowInfo = {
      slug: t.slug, name: t.name, stage: t.stage ?? null, template: { slug: t.slug }, origin: copy ? `playbook copy: platform/installs/${slug}/${t.slug}.json` : `shipped template: platform/src/templates/${t.slug}.json (the offer's words, if any, are applied at install)`,
      note: copy?.note ?? null, definition: parseDefinition(copy?.definition ?? t.definition),
    };
    rows.push(takenOver.has(t.slug) ? { w, removed: `taken over by ${takenOver.get(t.slug)}` } : { w });
  }
  for (const c of copies.filter((c) => c.create)) {
    rows.push({ w: { slug: slugify(c.name ?? c.workflow), name: c.name ?? c.workflow, stage: c.create?.stage ?? null, template: null, takesOver: c.create?.takesOver ?? null,
      origin: `the offer's own workflow: platform/installs/${slug}/${c.workflow}.json`, note: c.note ?? null, definition: parseDefinition(c.definition) } });
  }
  return { offer, rows };
}

const hhmm = (t: string) => t.slice(0, 5);

/** Every offer and each workflow's current saved version, read-only. Secrets are never read: only that one is set. */
export async function loadDbOffers(c: PoolClient): Promise<{ offer: OfferInfo; rows: IndexRow[] }[]> {
  const companies = (await c.query<{ id: string; slug: string; name: string; timezone: string; mode: string; status: string; sms_enabled: boolean; send_window_start: string; send_window_end: string; quiet_allow_transactional: boolean }>(
    `select id, slug, name, timezone, mode, status, sms_enabled, send_window_start::text, send_window_end::text, quiet_allow_transactional from companies order by slug`)).rows;
  const result: { offer: OfferInfo; rows: IndexRow[] }[] = [];
  for (const co of companies) {
    const binds = (await c.query<{ key: string; kind: string; value: Buffer | null }>(
      `select key, kind, case when kind = 'secret' then null else value end as value from bindings where company_id = $1 order by key`, [co.id])).rows;
    const bindings: Record<string, string | { secret: true }> = Object.fromEntries(binds.map((b) => [b.key, b.kind === "secret" ? { secret: true as const } : (b.value as Buffer).toString("utf8")]));
    const playbook = typeof bindings.playbook === "string" ? (() => { try { return (JSON.parse(bindings.playbook as string) as { slug?: string }).slug; } catch { return undefined; } })() : undefined;
    const offer: OfferInfo = { slug: co.slug, name: co.name, source: "db", timezone: co.timezone, mode: co.mode, status: co.status, smsEnabled: co.sms_enabled, playbook,
      sendWindow: { start: hhmm(co.send_window_start), end: hhmm(co.send_window_end), transactionalAnyHour: co.quiet_allow_transactional } };
    const wfs = (await c.query<{ id: string; name: string; stage: string | null; enabled: boolean; mode: string | null; diverged: boolean; sends_unlocked_at: Date | null; sends_unlocked_by: string | null; current_version: number; reentry_window: string | null; template_slug: string | null; template_version: number | null; takes_over: string | null; definition: unknown; note: string | null; saved_at: Date }>(
      `select w.id, w.name, w.stage, w.enabled, w.mode, w.diverged, w.sends_unlocked_at, w.sends_unlocked_by, w.current_version, w.reentry_window::text, wt.slug as template_slug, w.template_version, w.takes_over,
              v.definition, v.note, v.saved_at
         from workflows w
         join workflow_versions v on v.workflow_id = w.id and v.version = w.current_version
         left join workflow_templates wt on wt.id = w.template_id
        where w.company_id = $1 order by w.stage nulls last, w.sort, w.name`, [co.id])).rows;
    const used = new Set<string>();
    const rows: IndexRow[] = wfs.map((r) => {
      let slug = slugify(r.name); while (used.has(slug)) slug += "-2"; used.add(slug);
      return { w: {
        slug, name: r.name, stage: r.stage, template: r.template_slug ? { slug: r.template_slug, version: r.template_version } : null, diverged: r.diverged, enabled: r.enabled, mode: r.mode,
        sendsUnlockedAt: r.sends_unlocked_at ? r.sends_unlocked_at.toISOString() : null, sendsUnlockedBy: r.sends_unlocked_by, version: r.current_version, reentryWindow: r.reentry_window, takesOver: r.takes_over,
        origin: `live: version ${r.current_version}, saved ${r.saved_at.toISOString()}${r.note ? ` (${r.note})` : ""}`, note: null, definition: parseDefinition(r.definition), bindings,
      } };
    });
    result.push({ offer, rows });
  }
  return result;
}

/** One read-only session over SPEC_DATABASE_URL that sees every offer (the tenant policy lets the operator role through). */
export async function readOnlySession(c: PoolClient): Promise<void> {
  await c.query("set default_transaction_read_only = on");
  await c.query("select set_config('app.role', 'operator', false)");
}
