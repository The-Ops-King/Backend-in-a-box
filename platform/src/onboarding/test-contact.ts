/**
 * D158: the test contact, made by the wizard. Tyler (2026-10-19): one button makes it in the company's GHL, on his own email
 * (jt@jtylerray.com), so every business gets one the same way. The email is plus-addressed per business (jt+test-pmu@jtylerray.com):
 * one inbox, a distinct person in each GHL. It is created tagged `sys-test`, so a GHL workflow filtered on that tag never sees it,
 * even its Contact Created trigger; its domain joins the company's test domains (anyone on it is a test contact). One that is
 * there already (the same email) is tagged instead of made twice. It is read back from GHL into the engine at once, so the test
 * passes can use it without waiting for the poll.
 *
 * Creating a contact fires their own "Contact Created" workflows, so a company onboarded through the wizard needs its GHL
 * workflows marked first (D157, step 8); a template business, in Tyler's own sandbox, does not (D160). The email typed is kept per company and offered to the next one.
 */
import type { PoolClient } from "pg";
import { one } from "@/db/client";
import type { Adapters } from "@/adapters/types";
import { loadCompany } from "@/engine/context";
import { upsertContact } from "@/engine/poll";
import { TEST_DOMAINS_KEY, TEST_TAG } from "@/engine/mode";

export const TEST_EMAIL_KEY = "test.contact_email";
const EMAIL = /^[^\s@+]+(\+[^\s@]+)?@[a-z0-9.-]+\.[a-z]{2,}$/i;

/** The base email made this business's own: `jt@jtylerray.com` → `jt+test-<slug>@jtylerray.com`; an address already plus-addressed is kept. */
export function plusAddress(base: string, slug: string): string {
  const [local, domain] = base.trim().toLowerCase().split("@");
  return local.includes("+") ? `${local}@${domain}` : `${local}+test-${slug}@${domain}`;
}

/** The email offered: this company's own, else the last one used on any company. */
export async function suggestedEmail(c: PoolClient, companyId: string): Promise<string | null> {
  const r = await one<{ value: Buffer }>(c, "select value from bindings where key=$2 order by (company_id=$1) desc, updated_at desc limit 1", [companyId, TEST_EMAIL_KEY]);
  return r ? r.value.toString("utf8") : null;
}

export type MadeContact = { ok: true; id: string; email: string; created: boolean } | { ok: false; status: number; why: string };

export async function createTestContact(op: <T>(fn: (c: PoolClient) => Promise<T>) => Promise<T>, adapters: Adapters, companyId: string, args: { email?: unknown; phone?: unknown; by?: string }): Promise<MadeContact> {
  const base = typeof args.email === "string" ? args.email.trim().toLowerCase() : "";
  if (!EMAIL.test(base)) return { ok: false, status: 400, why: "an email is needed: yours (jt@jtylerray.com), plus-addressed per business" };
  const phone = typeof args.phone === "string" && args.phone.trim() ? args.phone.trim() : undefined;
  const pre = await op(async (c) => {
    const o = await one<{ steps: Record<string, unknown>; template: boolean }>(c, "select o.steps, co.status='template' as template from onboarding o join companies co on co.id=o.company_id where o.company_id=$1", [companyId]);
    if (o && !o.template && !o.steps.filters) return { ok: false as const, status: 409, why: "mark their GHL workflows first (step 8): making a contact fires their Contact Created workflows" };
    const co = await loadCompany(c, companyId).catch(() => null);
    if (!co?.adapterCompany.pit || !co.adapterCompany.locationId) return { ok: false as const, status: 409, why: "connect their GHL first" };
    return { ok: true as const, co };
  });
  if (!pre.ok) return pre;
  const { row, adapterCompany: ac, bindings } = pre.co;
  const email = plusAddress(base, row.slug);
  let ghlId: string, created = false;
  try {
    const had = (await adapters.read.contactsByEmail?.(ac, email)) ?? [];
    if (had[0]) { ghlId = had[0].id; await adapters.write.addTag(ac, ghlId, TEST_TAG); }
    else { ghlId = (await adapters.write.createContact(ac, { firstName: "Test", lastName: row.name, email, ...(phone ? { phone } : {}), tags: [TEST_TAG], source: "engine test contact" })).id; created = true; }
  } catch (e) { return { ok: false, status: 502, why: `GHL refused: ${String((e as Error).message).slice(0, 200)}` }; }
  const snap = await adapters.read.getContact(ac, ghlId).catch(() => null);
  return op(async (c) => {
    const id = snap
      ? (await upsertContact(c, companyId, row.timezone, { ...snap, tags: [...new Set([...(snap.tags ?? []), TEST_TAG])] })).id
      : (await one<{ id: string }>(c, "select id from contacts where company_id=$1 and ghl_contact_id=$2", [companyId, ghlId]))?.id;
    if (!id) return { ok: false as const, status: 502, why: "made in GHL, but it could not be read back yet: it arrives with the next poll" };
    const domain = email.split("@")[1];
    const domains = (bindings[TEST_DOMAINS_KEY] ?? "").split(",").map((d) => d.trim().toLowerCase()).filter(Boolean);
    if (!domains.includes(domain)) await c.query("insert into bindings (company_id, key, kind, value) values ($1,$2,'text',$3) on conflict (company_id, key) do update set value=excluded.value, updated_at=now()", [companyId, TEST_DOMAINS_KEY, Buffer.from([...domains, domain].join(","))]);
    await c.query("insert into bindings (company_id, key, kind, value) values ($1,$2,'text',$3) on conflict (company_id, key) do update set value=excluded.value, updated_at=now()", [companyId, TEST_EMAIL_KEY, Buffer.from(base)]);
    await c.query("insert into audit_log (company_id, action, target_type, target_id, after) values ($1,'test_contact.made','contact',$2,$3)", [companyId, id, { email, ghl_contact_id: ghlId, created, by: args.by ?? "dashboard" }]);
    return { ok: true as const, id, email, created };
  });
}
