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

/** Does this contact pass the company's mode? Always in shadow and live; in test by the sys-test tag or a test-domain email. */
export async function contactPasses(c: PoolClient, companyId: string, contactId: string, mode: Mode, bindings: Record<string, string>): Promise<{ ok: true } | { ok: false; why: string }> {
  if (mode === "shadow" || mode === "live") return { ok: true };
  const domains = testDomains(bindings);
  const emails = (await many<{ value: string }>(c, "select value from contact_identifiers where company_id=$1 and contact_id=$2 and kind='email'", [companyId, contactId])).map((r) => r.value.toLowerCase());
  const onDomain = emails.some((e) => domains.includes(e.split("@")[1] ?? ""));
  if (onDomain) return { ok: true };
  const tagged = await many<{ tags: string[] }>(c, "select tags from contacts where id=$1 and $2 = any(tags)", [contactId, TEST_TAG]);
  if (tagged.length) return { ok: true };
  return { ok: false, why: `test mode: not tagged ${TEST_TAG} and no email on a test domain` };
}

/** What a run does, decided once per claim (D52 addendum 2): shadow when the company is in shadow, or in test and the contact does not pass; real otherwise. A run with no contact (end of day, wrap-ups, health) is team-facing: real outside shadow. */
export type Effective = "shadow" | "real";
export async function effectiveMode(c: PoolClient, companyId: string, contactId: string | null, mode: Mode, bindings: Record<string, string>): Promise<Effective> {
  if (mode === "shadow") return "shadow";
  if (mode === "live" || !contactId) return "real";
  return (await contactPasses(c, companyId, contactId, mode, bindings)).ok ? "real" : "shadow";
}
