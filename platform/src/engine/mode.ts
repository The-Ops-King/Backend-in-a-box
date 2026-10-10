import type { PoolClient } from "pg";
import { many } from "@/db/client";

/**
 * The ladder a company climbs before anyone real hears from it (D52): shadow (everyone runs, nothing is written or
 * sent, the record says what would have happened), test (the team's own test contacts, tagged sys-test or with an
 * email on a test domain, get everything for real: CRM writes, emails, texts; everyone else runs exactly as in
 * shadow, so the team still sees what would have happened), live (everyone). One rule carries the ladder,
 * `contactPasses`; `effectiveMode` turns it into what a run about a contact does: shadow or real.
 */
export const MODES = ["shadow", "test", "live"] as const;
export type Mode = (typeof MODES)[number];
export const isMode = (v: unknown): v is Mode => typeof v === "string" && (MODES as readonly string[]).includes(v);
export const MODE_WORDS: Record<Mode, { label: string; about: string }> = {
  shadow: { label: "shadow", about: "sends are written down, not delivered; nothing is written to the CRM" },
  test: { label: "test", about: "test contacts get everything for real; everyone else runs as in shadow, nothing written or sent" },
  live: { label: "live", about: "sends go out and the CRM is written, for everyone" },
};
export const TEST_TAG = "sys-test";
export const TEST_DOMAINS_KEY = "test.domains";
export const testDomains = (bindings: Record<string, string>) => (bindings[TEST_DOMAINS_KEY] ?? "").split(",").map((d) => d.trim().toLowerCase().replace(/^@/, "")).filter(Boolean);

/** The one rule for "the team's own test contact" (D52): tagged sys-test, or an email on one of the company's test domains. Test mode lets them through; every metric leaves them out (D73). */
export const isTestContact = (p: { tags?: string[] | null; emails?: (string | null | undefined)[] }, domains: string[]): boolean =>
  (p.tags ?? []).includes(TEST_TAG) || (p.emails ?? []).some((e) => !!e && domains.includes(e.toLowerCase().split("@")[1] ?? ""));
/** The same rule in SQL over a contacts row aliased `ct` (no row is not a test contact); `domains` is a text[] parameter. */
export const testContactSql = (ct: string, domains: string) =>
  `coalesce('${TEST_TAG}' = any(${ct}.tags) or exists (select 1 from contact_identifiers ti where ti.contact_id=${ct}.id and ti.kind='email' and split_part(lower(ti.value),'@',2) = any(${domains}::text[])), false)`;

/** Does this contact pass the company's mode? Always in shadow and live; in test by the sys-test tag or a test-domain email. */
export async function contactPasses(c: PoolClient, companyId: string, contactId: string, mode: Mode, bindings: Record<string, string>): Promise<{ ok: true } | { ok: false; why: string }> {
  if (mode === "shadow" || mode === "live") return { ok: true };
  const emails = (await many<{ value: string }>(c, "select value from contact_identifiers where company_id=$1 and contact_id=$2 and kind='email'", [companyId, contactId])).map((r) => r.value);
  const tags = (await many<{ tags: string[] }>(c, "select tags from contacts where id=$1", [contactId]))[0]?.tags ?? [];
  if (isTestContact({ tags, emails }, testDomains(bindings))) return { ok: true };
  return { ok: false, why: `test mode: not tagged ${TEST_TAG} and no email on a test domain` };
}

/** What a run does, decided once per claim (D52 addendum 2): shadow when the company is in shadow, or in test and the contact does not pass; real otherwise.
 *  D76: a run with no contact (end of day, wrap-ups, health) is shadow too until live: nothing outward reaches a person; the operator's alerts are not runs and still go. */
export type Effective = "shadow" | "real";
export async function effectiveMode(c: PoolClient, companyId: string, contactId: string | null, mode: Mode, bindings: Record<string, string>): Promise<Effective> {
  if (mode === "shadow") return "shadow";
  if (mode === "live") return "real";
  if (!contactId) return "shadow";
  return (await contactPasses(c, companyId, contactId, mode, bindings)).ok ? "real" : "shadow";
}
