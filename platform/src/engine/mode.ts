import type { PoolClient } from "pg";
import { many } from "@/db/client";

/**
 * The ladder a company climbs before anyone real hears from it (D52): shadow (nothing is written anywhere), test
 * (only the team's own test contacts: tagged sys-test, or an email on a test domain), rehearsal (only a test-domain
 * email: contacts that came in through the real funnel with nothing special on them), live (everyone). Two gates
 * carry the ladder: a run about a contact does not start unless the contact passes, and a send to a contact that
 * does not pass is suppressed even if a run reached it.
 */
export const MODES = ["shadow", "test", "rehearsal", "live"] as const;
export type Mode = (typeof MODES)[number];
export const isMode = (v: unknown): v is Mode => typeof v === "string" && (MODES as readonly string[]).includes(v);
export const MODE_WORDS: Record<Mode, { label: string; about: string }> = {
  shadow: { label: "shadow", about: "sends are written down, not delivered; nothing is written to the CRM" },
  test: { label: "test", about: "only contacts tagged sys-test or on a test email domain; the CRM is written for them" },
  rehearsal: { label: "rehearsal", about: "only contacts on a test email domain, however they came in; the CRM is written for them" },
  live: { label: "live", about: "sends go out and the CRM is written, for everyone" },
};
export const TEST_TAG = "sys-test";
export const TEST_DOMAINS_KEY = "test.domains";
export const testDomains = (bindings: Record<string, string>) => (bindings[TEST_DOMAINS_KEY] ?? "").split(",").map((d) => d.trim().toLowerCase().replace(/^@/, "")).filter(Boolean);

/** Does this contact pass the company's mode? Always in shadow and live; in test by tag or domain; in rehearsal by domain alone. */
export async function contactPasses(c: PoolClient, companyId: string, contactId: string, mode: Mode, bindings: Record<string, string>): Promise<{ ok: true } | { ok: false; why: string }> {
  if (mode === "shadow" || mode === "live") return { ok: true };
  const domains = testDomains(bindings);
  const emails = (await many<{ value: string }>(c, "select value from contact_identifiers where company_id=$1 and contact_id=$2 and kind='email'", [companyId, contactId])).map((r) => r.value.toLowerCase());
  const onDomain = emails.some((e) => domains.includes(e.split("@")[1] ?? ""));
  if (onDomain) return { ok: true };
  if (mode === "test") {
    const tagged = await many<{ tags: string[] }>(c, "select tags from contacts where id=$1 and $2 = any(tags)", [contactId, TEST_TAG]);
    if (tagged.length) return { ok: true };
    return { ok: false, why: `${mode} mode: not tagged ${TEST_TAG} and no email on a test domain` };
  }
  return { ok: false, why: `${mode} mode: no email on a test domain` };
}

/** The mode and test domains of a company, in one read (dispatch asks for every event). */
export async function modeOf(c: PoolClient, companyId: string): Promise<{ mode: Mode; bindings: Record<string, string> }> {
  const rows = await many<{ mode: string; value: Buffer | null }>(c, "select co.mode, b.value from companies co left join bindings b on b.company_id=co.id and b.key=$2 where co.id=$1", [companyId, TEST_DOMAINS_KEY]);
  const mode = isMode(rows[0]?.mode) ? rows[0].mode : "shadow";
  return { mode, bindings: rows[0]?.value ? { [TEST_DOMAINS_KEY]: rows[0].value.toString("utf8") } : {} };
}
