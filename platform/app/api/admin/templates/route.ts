import { NextResponse } from "next/server";
import { asOperator, one } from "@/db/client";
import { installTemplates } from "@/engine/install";
import { templates } from "@/templates";
import { operatorAuthorized } from "@/engine/admin-auth";
export const dynamic = "force-dynamic"; export const maxDuration = 120;

/**
 * POST { company: slug, templates: string[] } with Authorization: Bearer $CRON_SECRET (D96, D147): put the named shipped templates
 * on an existing company and nothing else (no bindings, calendars, Slack or secrets), in one transaction. A new template installs
 * off; one the company already has is left exactly as it is (bring a newer template to it with the definition route's fromTemplate).
 */
export async function POST(req: Request) {
  if (!operatorAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as { company?: string; templates?: string[] };
  if (!body.company || !Array.isArray(body.templates) || !body.templates.length) return NextResponse.json({ error: "company and templates (the slugs to add, by name) are required" }, { status: 400 });
  const known = new Set(templates.map((t) => t.slug));
  const unknown = (body.templates ?? []).filter((s) => !known.has(s));
  if (unknown.length) return NextResponse.json({ error: `no shipped template: ${unknown.join(", ")}` }, { status: 400 });
  try {
    const out = await asOperator(async (c) => {
      const co = await one<{ id: string }>(c, "select id from companies where slug=$1", [body.company]);
      if (!co) return null;
      return { companyId: co.id, installed: await installTemplates(c, co.id, body.templates!, { existed: true }) };
    });
    return out ? NextResponse.json({ ok: true, ...out }) : NextResponse.json({ error: "company not found" }, { status: 404 });
  } catch (e) { return NextResponse.json({ ok: false, error: String((e as Error).message) }, { status: 500 }); }
}
