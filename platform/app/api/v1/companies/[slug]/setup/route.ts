import { asOperator } from "@/db/client";
import { companyBySlug } from "@/api/data";
import { setupPage } from "@/api/setup";
import { fail, ok } from "@/api/http";
import { ENTERABLE_KEYS } from "@/api/setup-keys";
import { setBinding } from "@/engine/settings";
export const dynamic = "force-dynamic";
export async function GET(_: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const co = await asOperator((c) => companyBySlug(c, slug)); if (!co) return fail(404, "no such company");
  const page = await setupPage(co); if (!page) return fail(404, "no such company");
  return ok(page);
}

/** D319: POST { key, value }: one of ENTERABLE_KEYS, tested live and kept encrypted only when the service takes it. Audited; the key never comes back. */
export async function POST(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const b = (await req.json().catch(() => null)) as { key?: string; value?: string } | null;
  const spec = b?.key ? ENTERABLE_KEYS[b.key] : undefined, value = b?.value?.trim() ?? "";
  if (!spec || !b?.key) return fail(400, "that key can't be added here");
  if (value.length < 8) return fail(400, `paste the whole ${spec.label}`);
  const t = await spec.test(value); if (!t.ok) return fail(400, `${spec.label} didn't work: ${t.error}`);
  return asOperator(async (c) => {
    const co = await companyBySlug(c, slug); if (!co) return fail(404, "no such company");
    await setBinding(c, co.id, b.key!, "secret", value, "dashboard");
    await c.query("insert into audit_log (company_id, action, target_type, target_id, after) values ($1,'setting.key_added','binding',$2,$3)", [co.id, b.key, { key: b.key, ends_with: value.slice(-4), by: "dashboard" }]);
    return ok({ ok: true, key: b.key, label: spec.label });
  });
}
