import type { PoolClient } from "pg";
import { many, one } from "@/db/client";
import { parseDefinition } from "./definition";
import { MODE_WORDS, runMode, SLACK_LIVE_KEY, slackLiveSet, TEST_CHANNEL_KEY, TEST_DOMAINS_KEY, testDomains, type Mode } from "./mode";
const bindingsOf = (rows: { key: string; value: Buffer }[]) => Object.fromEntries(rows.map((r) => [r.key, r.value.toString("utf8")]));

/**
 * "Is this ready to be live?" answered from facts, not memory: company mode, Slack connection, every enabled or
 * installed workflow's required bindings, and the gaps the engine itself knows it still has for a template.
 * Shown on the company page and on each workflow page so nobody flips a switch on something half-wired.
 */
export type Issue = { level: "blocker" | "warning"; text: string; href?: string };
/** `mode`: the workflow's own rung, null when it follows the company; `runsIn`: the rung its runs stand on (D92). */
/** `needs`: a source the workflow starts from that the company has not connected (its triggers can never fire), by name; unlike `missing`, it does not stop the workflow being turned on, so it can still be tested with staged facts (D128). */
export type WorkflowReadiness = { id: string; name: string; slug: string | null; enabled: boolean; mode: Mode | null; runsIn: Mode; postsToSlack: boolean; missing: string[]; optionalUnbound: string[]; gaps: string[]; needs: string[]; placeholders: number; parseError?: string; ready: boolean };
/** The steps that need Slack to do their job: a post, a DM, a wait for a tap on a post. */
const SLACK_STEPS = new Set(["slack_post", "notify_owner", "wait_for_reaction"]);
/** D128: where a trigger's events come from, when that is a vendor the company connects: payments only arrive from Whop (its webhook, made from the API key). */
const SOURCES: { name: string; about: string; starts: (event: string) => boolean; connected: (bound: Set<string>) => boolean }[] = [
  { name: "Whop", about: "a payment comes in", starts: (e) => e.startsWith("payment."), connected: (b) => b.has("secret.whop_api_key") || b.has("secret.whop_webhook") },
];
/** The sources a workflow starts from that the company has not connected: its triggers can never fire (D128; the health check says so hourly, D141). */
export const missingSources = (events: string[], bound: Set<string>) => SOURCES.filter((s) => events.some(s.starts) && !s.connected(bound)).map(({ name, about }) => ({ name, about }));
const SLACK_BLOCKER = "Slack is not connected: every Slack post (team alerts, booking cards, call reviews, unlinked payments) is recorded but never posted.";
/** A message body nobody has written yet; the marker the templates ship with, not a reading of the words. */
export const isPlaceholderCopy = (body: string | undefined) => /\[placeholder\b/i.test(body ?? "");
export type Readiness = { ready: boolean; issues: Issue[]; workflows: WorkflowReadiness[] };

/** What a template cannot do yet, by slug. Remove the entry when the piece ships; the UI stops warning on its own. */
export const KNOWN_GAPS: Record<string, string[]> = {};   // nothing is known to be missing today

export async function companyReadiness(c: PoolClient, companyId: string, slugPrefix: string): Promise<Readiness> {
  const co = (await one<{ mode: Mode; sms_enabled: boolean }>(c, "select mode, sms_enabled from companies where id=$1", [companyId]))!;
  const bound = new Set((await many<{ key: string }>(c, "select key from bindings where company_id=$1", [companyId])).map((b) => b.key));
  const slack = await one(c, "select 1 from slack_connections where company_id=$1", [companyId]);
  const rows = await many<{ id: string; name: string; enabled: boolean; mode: Mode | null; slug: string | null; manifest: { bindings: { key: string; required: boolean; fallback?: string }[] }; definition: unknown }>(c, `
    select w.id, w.name, w.enabled, w.mode, t.slug, v.manifest, v.definition from workflows w join workflow_versions v on v.workflow_id=w.id and v.version=w.current_version left join workflow_templates t on t.id=w.template_id
    where w.company_id=$1 order by w.name`, [companyId]);
  const workflows: WorkflowReadiness[] = rows.map((w) => {
    const missing = w.manifest.bindings.filter((b) => b.required && !bound.has(b.key)).map((b) => b.key);
    const optionalUnbound = w.manifest.bindings.filter((b) => !b.required && !bound.has(b.key) && !(b.fallback && bound.has(b.fallback))).map((b) => b.key);   // a channel with a bound fallback is not a gap: its posts land there
    const gaps = w.slug ? KNOWN_GAPS[w.slug] ?? [] : [];
    let parseError: string | undefined, placeholders = 0, postsToSlack = false, needs: string[] = [];
    try { const def = parseDefinition(w.definition); const events = def.nodes.flatMap((n) => (n.type === "trigger" ? [n.event] : [])); needs = SOURCES.filter((s) => events.some(s.starts) && !s.connected(bound)).map((s) => s.name); placeholders = def.nodes.filter((n) => (n.type === "send_sms" || n.type === "send_email") && isPlaceholderCopy(n.template)).length; postsToSlack = def.nodes.some((n) => SLACK_STEPS.has(n.type)); } catch (e) { parseError = String((e as Error).message).split("\n").find((l) => /message/.test(l))?.replace(/.*"message":\s*"?/, "").replace(/"?,?\s*$/, "") ?? "does not parse"; }
    return { id: w.id, name: w.name, slug: w.slug, enabled: w.enabled, mode: w.mode, runsIn: runMode(co.mode, w.mode), postsToSlack, missing, optionalUnbound, gaps, needs, placeholders, parseError, ready: !missing.length && !gaps.length && !needs.length && !parseError };
  });
  const issues: Issue[] = [];
  if (co.mode !== "live") issues.push({ level: "warning", text: `Company is in ${co.mode}: ${MODE_WORDS[co.mode].about}.` });
  const slackLive = slackLiveSet(bindingsOf(await many<{ key: string; value: Buffer }>(c, "select key, value from bindings where company_id=$1 and key=$2", [companyId, SLACK_LIVE_KEY])));
  if (slackLive && co.mode !== "live") issues.push({ level: "warning", text: `Slack is live (slack.live) while the company is in ${co.mode}: every post and DM goes where its step points, unmarked; what reaches a contact is still held.` });
  else if (slack && workflows.some((w) => w.enabled && w.runsIn !== "live" && w.postsToSlack) && !bound.has(TEST_CHANNEL_KEY))
    issues.push({ level: "warning", text: "No test Slack channel (test.slack_channel): before live, posts go to their own channels marked 🧪, and DMs to the ops channel. Set one and every pre-live post goes there instead.", href: `${slugPrefix}/setup` });
  if ((co.mode === "test" || co.mode === "quiet") && !testDomains(bindingsOf(await many<{ key: string; value: Buffer }>(c, "select key, value from bindings where company_id=$1 and key=$2", [companyId, TEST_DOMAINS_KEY]))).length)
    issues.push({ level: "warning", text: `No test email domain (test.domains): in ${co.mode} only contacts tagged sys-test get everything.`, href: `${slugPrefix}/setup` });
  if (!slack) issues.push({ level: "blocker", text: SLACK_BLOCKER, href: `${slugPrefix}/setup#slack` });
  if (!co.sms_enabled) issues.push({ level: "warning", text: "SMS is off for this company: text steps are skipped and the run continues." });
  // D88: the engine no longer posts alerts itself; a company whose Health check copy predates that (edited, so not upgraded) says nothing
  if (!(await one(c, "select 1 from workflow_triggers t join workflows w on w.id=t.workflow_id where t.company_id=$1 and t.event_type='alert.raised' and t.enabled and w.enabled", [companyId])))
    issues.push({ level: "warning", text: "No workflow says the alerts: none that is on starts on alert.raised. Re-make Health check from the template (an edited copy from before D88 has no alert steps), or add them.", href: `${slugPrefix}/health` });
  for (const w of workflows) {
    if (w.parseError) issues.push(unparseable(w, slugPrefix));
    if (w.missing.length) issues.push({ level: w.enabled ? "blocker" : "warning", text: `${w.name}${w.enabled ? " is ON but" : ""} is missing ${w.missing.join(", ")}.`, href: `${slugPrefix}/w/${w.id}` });
    if (w.needs.length) issues.push({ level: "warning", text: `${w.name}${w.enabled ? " is on but" : ""} never starts until ${w.needs.join(" and ")} is connected: what starts it comes from there.`, href: `${slugPrefix}/w/${w.id}` });
    for (const g of w.gaps) issues.push({ level: "warning", text: `${w.name}: ${g}`, href: `${slugPrefix}/w/${w.id}` });
    if (w.enabled && w.placeholders) issues.push({ level: "warning", text: `${w.name}: ${w.placeholders} message${w.placeholders === 1 ? " is" : "s are"} still placeholder copy.`, href: `${slugPrefix}/w/${w.id}` });
    if (w.enabled && w.optionalUnbound.some((k) => k.startsWith("slack.channel."))) issues.push({ level: "warning", text: `${w.name}: no Slack channel bound (${w.optionalUnbound.filter((k) => k.startsWith("slack.channel.")).join(", ")}); its posts are skipped.`, href: `${slugPrefix}/w/${w.id}` });
  }
  return { ready: !issues.some((i) => i.level === "blocker"), issues, workflows };
}

const unparseable = (w: WorkflowReadiness, slugPrefix: string): Issue => ({ level: "blocker", text: `${w.name}: its stored definition no longer runs on this engine (${w.parseError!.slice(0, 120)}). Re-run install to upgrade it to the current template.`, href: `${slugPrefix}/w/${w.id}` });

/**
 * D92: the company's go-live gate narrowed to one workflow going live on its own: its definition runs, its required
 * settings are bound (on or off: it is about to act for real), and Slack is connected when it posts, DMs or waits on a tap.
 */
export async function workflowLiveBlockers(c: PoolClient, companyId: string, workflowId: string, slugPrefix: string): Promise<Issue[]> {
  const w = (await companyReadiness(c, companyId, slugPrefix)).workflows.find((x) => x.id === workflowId);
  if (!w) return [{ level: "blocker", text: "No such workflow for this company." }];
  const out: Issue[] = [];
  if (w.parseError) out.push(unparseable(w, slugPrefix));
  if (w.missing.length) out.push({ level: "blocker", text: `${w.name} is missing ${w.missing.join(", ")}.`, href: `${slugPrefix}/w/${w.id}` });
  if (w.postsToSlack && !(await one(c, "select 1 from slack_connections where company_id=$1", [companyId]))) out.push({ level: "blocker", text: `Slack is not connected, and ${w.name} posts there: its posts would be recorded but never posted.`, href: `${slugPrefix}/setup#slack` });
  return out;
}
