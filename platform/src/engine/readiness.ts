import type { PoolClient } from "pg";
import { many, one } from "@/db/client";
import { parseDefinition } from "./definition";
import { MODE_WORDS, TEST_DOMAINS_KEY, testDomains, type Mode } from "./mode";
const bindingsOf = (rows: { key: string; value: Buffer }[]) => Object.fromEntries(rows.map((r) => [r.key, r.value.toString("utf8")]));

/**
 * "Is this ready to be live?" answered from facts, not memory: company mode, Slack connection, every enabled or
 * installed workflow's required bindings, and the gaps the engine itself knows it still has for a template.
 * Shown on the company page and on each workflow page so nobody flips a switch on something half-wired.
 */
export type Issue = { level: "blocker" | "warning"; text: string; href?: string };
export type WorkflowReadiness = { id: string; name: string; slug: string | null; enabled: boolean; missing: string[]; optionalUnbound: string[]; gaps: string[]; placeholders: number; parseError?: string; ready: boolean };
/** A message body nobody has written yet; the marker the templates ship with, not a reading of the words. */
export const isPlaceholderCopy = (body: string | undefined) => /\[placeholder\b/i.test(body ?? "");
export type Readiness = { ready: boolean; issues: Issue[]; workflows: WorkflowReadiness[] };

/** What a template cannot do yet, by slug. Remove the entry when the piece ships; the UI stops warning on its own. */
export const KNOWN_GAPS: Record<string, string[]> = {};   // the no-show half shipped as no-recording-no-show (D36 addendum); nothing is known to be missing today

export async function companyReadiness(c: PoolClient, companyId: string, slugPrefix: string): Promise<Readiness> {
  const co = (await one<{ mode: Mode; sms_enabled: boolean }>(c, "select mode, sms_enabled from companies where id=$1", [companyId]))!;
  const bound = new Set((await many<{ key: string }>(c, "select key from bindings where company_id=$1", [companyId])).map((b) => b.key));
  const slack = await one(c, "select 1 from slack_connections where company_id=$1", [companyId]);
  const rows = await many<{ id: string; name: string; enabled: boolean; slug: string | null; manifest: { bindings: { key: string; required: boolean }[] }; definition: unknown }>(c, `
    select w.id, w.name, w.enabled, t.slug, v.manifest, v.definition from workflows w join workflow_versions v on v.workflow_id=w.id and v.version=w.current_version left join workflow_templates t on t.id=w.template_id
    where w.company_id=$1 order by w.name`, [companyId]);
  const workflows: WorkflowReadiness[] = rows.map((w) => {
    const missing = w.manifest.bindings.filter((b) => b.required && !bound.has(b.key)).map((b) => b.key);
    const optionalUnbound = w.manifest.bindings.filter((b) => !b.required && !bound.has(b.key)).map((b) => b.key);
    const gaps = w.slug ? KNOWN_GAPS[w.slug] ?? [] : [];
    let parseError: string | undefined, placeholders = 0;
    try { const def = parseDefinition(w.definition); placeholders = def.nodes.filter((n) => (n.type === "send_sms" || n.type === "send_email") && isPlaceholderCopy(n.template)).length; } catch (e) { parseError = String((e as Error).message).split("\n").find((l) => /message/.test(l))?.replace(/.*"message":\s*"?/, "").replace(/"?,?\s*$/, "") ?? "does not parse"; }
    return { id: w.id, name: w.name, slug: w.slug, enabled: w.enabled, missing, optionalUnbound, gaps, placeholders, parseError, ready: !missing.length && !gaps.length && !parseError };
  });
  const issues: Issue[] = [];
  if (co.mode !== "live") issues.push({ level: "warning", text: `Company is in ${co.mode}: ${MODE_WORDS[co.mode].about}.` });
  if (co.mode === "test" && !testDomains(bindingsOf(await many<{ key: string; value: Buffer }>(c, "select key, value from bindings where company_id=$1 and key=$2", [companyId, TEST_DOMAINS_KEY]))).length)
    issues.push({ level: "warning", text: "No test email domain (test.domains): in test only contacts tagged sys-test pass.", href: `${slugPrefix}/setup` });
  if (!slack) issues.push({ level: "blocker", text: "Slack is not connected: every Slack post (team alerts, booking cards, call reviews, unlinked payments) is recorded but never posted.", href: `${slugPrefix}/setup#slack` });
  if (!co.sms_enabled) issues.push({ level: "warning", text: "SMS is off for this company: text steps are skipped and the run continues." });
  for (const w of workflows) {
    if (w.parseError) issues.push({ level: "blocker", text: `${w.name}: its stored definition no longer runs on this engine (${w.parseError.slice(0, 120)}). Re-run install to upgrade it to the current template.`, href: `${slugPrefix}/w/${w.id}` });
    if (w.missing.length) issues.push({ level: w.enabled ? "blocker" : "warning", text: `${w.name}${w.enabled ? " is ON but" : ""} is missing ${w.missing.join(", ")}.`, href: `${slugPrefix}/w/${w.id}` });
    for (const g of w.gaps) issues.push({ level: "warning", text: `${w.name}: ${g}`, href: `${slugPrefix}/w/${w.id}` });
    if (w.enabled && w.placeholders) issues.push({ level: "warning", text: `${w.name}: ${w.placeholders} message${w.placeholders === 1 ? " is" : "s are"} still placeholder copy.`, href: `${slugPrefix}/w/${w.id}` });
    if (w.enabled && w.optionalUnbound.some((k) => k.startsWith("slack.channel."))) issues.push({ level: "warning", text: `${w.name}: no Slack channel bound (${w.optionalUnbound.filter((k) => k.startsWith("slack.channel.")).join(", ")}); its posts are skipped.`, href: `${slugPrefix}/w/${w.id}` });
  }
  return { ready: !issues.some((i) => i.level === "blocker"), issues, workflows };
}
