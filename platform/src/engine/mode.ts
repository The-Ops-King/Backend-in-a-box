import type { PoolClient } from "pg";
import { many, one } from "@/db/client";

/**
 * The ladder a company climbs before anyone real hears from it (D52, renamed and widened by D132):
 * - ghost: everyone runs, nothing is written to the CRM or sent to anyone; the record says what would have happened.
 * - test: the team's own test contacts (tagged sys-test, or an email on a test domain) get everything for real; everyone else
 *   runs as in ghost.
 * - quiet: everyone's CRM work is real (tags, cards, fields, records, notes, tasks), but nothing reaches a contact (no text,
 *   email, agreement or outbound webhook); test contacts get everything.
 * Before live, every Slack post goes to the company's test channel when one is set (D133).
 * - live: everyone, everything.
 * One rule carries the ladder, `effectiveMode`: what a run about a contact does (ghost, quiet or real).
 * D92: a workflow may stand on its own rung (`workflows.mode`); null follows the company. `runMode` is that rule, and
 * every decision about what a run may do starts from it, never from `companies.mode` alone.
 */
export const MODES = ["ghost", "test", "quiet", "live"] as const;
export type Mode = (typeof MODES)[number];
export const isMode = (v: unknown): v is Mode => typeof v === "string" && (MODES as readonly string[]).includes(v);
/** D132: the rung's old name, refused with the new one named, so a stale install file or API call says what to change. */
export const modeProblem = (v: unknown): string | null => isMode(v) ? null : v === "shadow" ? 'mode "shadow" is now "ghost" (D132)' : `mode must be one of ${MODES.join(", ")}`;
export const MODE_WORDS: Record<Mode, { label: string; about: string }> = {
  ghost: { label: "ghost", about: "everyone runs; nothing is written to the CRM or sent to anyone, the record says what would have happened" },
  test: { label: "test", about: "test contacts get everything for real; everyone else runs as in ghost" },
  quiet: { label: "quiet", about: "the CRM is written for everyone, but nothing reaches a contact; test contacts get everything" },
  live: { label: "live", about: "sends go out and the CRM is written, for everyone" },
};
export const TEST_TAG = "sys-test";
export const TEST_DOMAINS_KEY = "test.domains";
/** D133: the one Slack channel every post goes to before its run is live (the steps keep their live channels; going live is the switch). */
export const TEST_CHANNEL_KEY = "test.slack_channel";
export const testDomains = (bindings: Record<string, string>) => (bindings[TEST_DOMAINS_KEY] ?? "").split(",").map((d) => d.trim().toLowerCase().replace(/^@/, "")).filter(Boolean);

/** The one rule for "the team's own test contact" (D52): tagged sys-test, or an email on one of the company's test domains. Test mode lets them through; every metric leaves them out (D73). */
export const isTestContact = (p: { tags?: string[] | null; emails?: (string | null | undefined)[] }, domains: string[]): boolean =>
  (p.tags ?? []).includes(TEST_TAG) || (p.emails ?? []).some((e) => !!e && domains.includes(e.toLowerCase().split("@")[1] ?? ""));
/** The same rule in SQL over a contacts row aliased `ct` (no row is not a test contact); `domains` is a text[] parameter. */
export const testContactSql = (ct: string, domains: string) =>
  `coalesce('${TEST_TAG}' = any(${ct}.tags) or exists (select 1 from contact_identifiers ti where ti.contact_id=${ct}.id and ti.kind='email' and split_part(lower(ti.value),'@',2) = any(${domains}::text[])), false)`;

/** Does this contact pass the company's mode? Always in ghost and live; in test and quiet by the sys-test tag or a test-domain email (in quiet, one who does not still has their CRM work done, quietly). */
export async function contactPasses(c: PoolClient, companyId: string, contactId: string, mode: Mode, bindings: Record<string, string>): Promise<{ ok: true } | { ok: false; why: string }> {
  if (mode === "ghost" || mode === "live") return { ok: true };
  const emails = (await many<{ value: string }>(c, "select value from contact_identifiers where company_id=$1 and contact_id=$2 and kind='email'", [companyId, contactId])).map((r) => r.value);
  const tags = (await many<{ tags: string[] }>(c, "select tags from contacts where id=$1", [contactId]))[0]?.tags ?? [];
  if (isTestContact({ tags, emails }, testDomains(bindings))) return { ok: true };
  return { ok: false, why: `${mode} mode: not tagged ${TEST_TAG} and no email on a test domain` };
}

/** D92: the rung a workflow's runs stand on: its own when set, else the company's. */
export const runMode = (company: Mode, workflow: Mode | null | undefined): Mode => workflow ?? company;
/** The same rule in SQL over a workflows row `w` joined to its companies row `co`. */
export const runModeSql = (w = "w", co = "co") => `coalesce(${w}.mode, ${co}.mode)`;
export type WorkflowMode = { mode: Mode; own: Mode | null; company: Mode };
export async function workflowMode(c: PoolClient, workflowId: string): Promise<WorkflowMode | null> {
  const r = await one<{ own: Mode | null; company: Mode }>(c, "select w.mode as own, co.mode as company from workflows w join companies co on co.id=w.company_id where w.id=$1", [workflowId]);
  return r ? { mode: runMode(r.company, r.own), own: r.own, company: r.company } : null;
}
/** The rung of the workflows an event starts, for the engine handing work to them (D88: a drift repair is as real as the run that makes it). Several: the least real; none: the company's. */
export async function handlerMode(c: PoolClient, companyId: string, eventType: string): Promise<Mode> {
  const rows = await many<{ mode: Mode }>(c, `select ${runModeSql()} as mode from workflow_triggers t join workflows w on w.id=t.workflow_id join companies co on co.id=w.company_id
    where t.company_id=$1 and t.event_type=$2 and t.enabled and w.enabled`, [companyId, eventType]);
  if (!rows.length) return (await one<{ mode: Mode }>(c, "select mode from companies where id=$1", [companyId]))!.mode;
  return rows.map((r) => r.mode).sort((a, b) => MODES.indexOf(a) - MODES.indexOf(b))[0];
}

/** What a run does, decided once per claim (D52 addendum 2, D132): ghost when its mode (`runMode`) is ghost, or test and the contact does
 *  not pass; quiet in quiet for anyone but a test contact; real otherwise.
 *  D76: a run with no contact (end of day, wrap-ups, health) is ghost in test and quiet in quiet: nothing outward reaches a person; the
 *  engine's own alerts still go. */
export type Effective = "ghost" | "quiet" | "real";
export async function effectiveMode(c: PoolClient, companyId: string, contactId: string | null, mode: Mode, bindings: Record<string, string>): Promise<Effective> {
  if (mode === "ghost") return "ghost";
  if (mode === "live") return "real";
  const held = mode === "quiet" ? "quiet" : "ghost";
  if (!contactId) return held;
  return (await contactPasses(c, companyId, contactId, mode, bindings)).ok ? "real" : held;
}
