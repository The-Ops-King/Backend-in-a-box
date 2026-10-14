import { NextResponse } from "next/server";
import { asOperator, one } from "@/db/client";
import { operatorAuthorized } from "@/engine/admin-auth";
import { findCompanyWorkflow, saveDefinition } from "@/engine/definitions";
export const dynamic = "force-dynamic";

/**
 * D100: a company's whole copy of a workflow, fetched and saved (onboarding a client whose process differs from the template).
 * GET  ?company=<slug>&workflow=<id | template slug | exact name> → { ok, company, workflow: { id, name, slug, enabled, diverged, version, template_version, note }, definition }
 * POST { company, workflow, definition, note, by?, dryRun? } → { ok, saved, dryRun, from, version, diff, missing, warnings, layout }
 *      layout: how its page draws it (D111: "tidy", or "graph" when its shape is beyond the tidy chart); refused 422 with every
 *      `problems`, among them a chart no layout draws exactly; 409 when the workflow is ON and the definition needs a binding the company lacks.
 *      dryRun validates and returns the diff without saving. A save is a new version of this company's copy only, diverged.
 * Authorization: Bearer $CRON_SECRET.
 */
export async function GET(req: Request) {
  if (!operatorAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const q = new URL(req.url).searchParams, slug = q.get("company"), ref = q.get("workflow");
  if (!slug || !ref) return NextResponse.json({ error: "company and workflow are required" }, { status: 400 });
  return asOperator(async (c) => {
    const co = await one<{ id: string }>(c, "select id from companies where slug=$1", [slug]);
    if (!co) return NextResponse.json({ error: "no such company" }, { status: 404 });
    const w = await findCompanyWorkflow(c, co.id, ref);
    if (!w.ok) return NextResponse.json({ error: w.why }, { status: 404 });
    const row = (await one<{ enabled: boolean; diverged: boolean; current_version: number; template_version: number | null; definition: unknown; note: string | null }>(c, `select w.enabled, w.diverged, w.current_version, w.template_version, v.definition, v.note
      from workflows w join workflow_versions v on v.workflow_id=w.id and v.version=w.current_version where w.id=$1`, [w.id]))!;
    return NextResponse.json({ ok: true, company: slug, workflow: { id: w.id, name: w.name, slug: w.slug, enabled: row.enabled, diverged: row.diverged, version: row.current_version, template_version: row.template_version, note: row.note }, definition: row.definition });
  });
}

export async function POST(req: Request) {
  if (!operatorAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = (await req.json().catch(() => null)) as { company?: string; workflow?: string; definition?: unknown; note?: string; by?: string; dryRun?: boolean } | null;
  if (!body?.company || !body.workflow || !body.definition || typeof body.definition !== "object") return NextResponse.json({ error: "company, workflow and definition are required" }, { status: 400 });
  if (typeof body.note !== "string" || !body.note.trim()) return NextResponse.json({ error: "note is required: say what changed and why" }, { status: 400 });
  return asOperator(async (c) => {
    const co = await one<{ id: string }>(c, "select id from companies where slug=$1", [body.company]);
    if (!co) return NextResponse.json({ error: "no such company" }, { status: 404 });
    const w = await findCompanyWorkflow(c, co.id, body.workflow!);
    if (!w.ok) return NextResponse.json({ error: w.why }, { status: 404 });
    const r = await saveDefinition(c, { workflowId: w.id, definition: body.definition, note: body.note!, by: body.by || "operator", dryRun: body.dryRun === true });
    if (!r.ok) return NextResponse.json({ error: r.why, ...(r.problems ? { problems: r.problems } : {}), ...(r.missing ? { missing: r.missing } : {}) }, { status: r.status });
    return NextResponse.json({ workflow: { id: w.id, name: w.name, slug: w.slug }, ...r });
  });
}
