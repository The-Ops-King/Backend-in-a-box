import { asOperator, one } from "@/db/client";
import { fail, ok, readJson } from "@/api/http";
import { playbooks } from "@/playbooks";
import { PLAYBOOK_KEY } from "@/playbooks/apply";
import { ensureTemplateBusiness, latestRelease, publish, setTemplateParams, templateSlug } from "@/playbooks/template-business";
export const dynamic = "force-dynamic";

/** D155: each playbook, its template business (when made) with its params, and its latest release. */
export async function GET() {
  // one connection, one query at a time
  return ok(await asOperator(async (c) => {
    const templates = [];
    for (const p of playbooks) {
      const co = await one<{ id: string; slug: string }>(c, "select id, slug from companies where slug=$1 and status='template'", [templateSlug(p.slug)]);
      const kept = co ? await one<{ value: Buffer }>(c, "select value from bindings where company_id=$1 and key=$2", [co.id, PLAYBOOK_KEY]) : undefined;
      templates.push({ playbook: p.slug, name: p.name, about: p.about, business: co?.slug ?? null, params: kept ? (JSON.parse(kept.value.toString("utf8")) as { params: unknown }).params : null, release: await latestRelease(c, p.slug) });
    }
    return { templates };
  }));
}

/** { playbook, action: "create" | "publish" | "params", params? } → the template business made, published, or its params changed (checked by its playbook). */
export async function POST(req: Request) {
  const b = await readJson<{ playbook?: string; action?: string; params?: unknown }>(req);
  if (!b?.playbook || !playbooks.some((p) => p.slug === b.playbook)) return fail(400, "playbook: one of " + playbooks.map((p) => p.slug).join(", "));
  return asOperator(async (c) => {
    if (b.action === "create") { const r = await ensureTemplateBusiness(c, b.playbook!, "dashboard"); return r.ok ? ok(r) : fail(r.status, r.why); }
    if (b.action === "publish") { const r = await publish(c, b.playbook!, "dashboard"); return r.ok ? ok(r) : fail(r.status, r.why, r.problems ? { problems: r.problems } : {}); }
    if (b.action === "params") { const r = await setTemplateParams(c, b.playbook!, b.params, "dashboard"); return r.ok ? ok({ ok: true }) : fail(r.status, r.why, r.copies ? { problems: r.copies.filter((x) => x.did === "refused").map((x) => `${x.name}: ${x.why}`) } : {}); }
    return fail(400, "action: create, publish or params");
  });
}
