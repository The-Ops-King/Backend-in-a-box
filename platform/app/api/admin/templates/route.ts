import { NextResponse } from "next/server";
import { asOperator, many, one } from "@/db/client";
import { installTemplates } from "@/engine/install";
import { templates } from "@/templates";
import { operatorAuthorized } from "@/engine/admin-auth";
export const dynamic = "force-dynamic"; export const maxDuration = 120;

/**
 * POST { company: slug, templates?: string[] } with Authorization: Bearer $CRON_SECRET (D96): put the shipped templates on an
 * existing company and nothing else (no bindings, calendars, Slack or secrets), in one transaction. Without `templates`: the
 * ones it already has (upgraded when untouched) and any that take one of them over. A new template installs off.
 */
export async function POST(req: Request) {
  if (!operatorAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as { company?: string; templates?: string[] };
  if (!body.company) return NextResponse.json({ error: "company is required" }, { status: 400 });
  const known = new Set(templates.map((t) => t.slug));
  const unknown = (body.templates ?? []).filter((s) => !known.has(s));
  if (unknown.length) return NextResponse.json({ error: `no shipped template: ${unknown.join(", ")}` }, { status: 400 });
  try {
    const out = await asOperator(async (c) => {
      const co = await one<{ id: string }>(c, "select id from companies where slug=$1", [body.company]);
      if (!co) return null;
      const has = new Set((await many<{ slug: string }>(c, "select wt.slug from workflows w join workflow_templates wt on wt.id=w.template_id where w.company_id=$1", [co.id])).map((r) => r.slug));
      const wanted = body.templates?.length ? body.templates
        : templates.filter((t) => has.has(t.slug) || ("replaces" in t && (t.replaces as readonly string[]).some((s) => has.has(s)))).map((t) => t.slug);
      return { companyId: co.id, installed: await installTemplates(c, co.id, wanted, { existed: true }) };
    });
    return out ? NextResponse.json({ ok: true, ...out }) : NextResponse.json({ error: "company not found" }, { status: 404 });
  } catch (e) { return NextResponse.json({ ok: false, error: String((e as Error).message) }, { status: 500 }); }
}
