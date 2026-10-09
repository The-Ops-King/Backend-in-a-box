import { NextResponse } from "next/server";
import { asOperator, many, one } from "@/db/client";
import { operatorAuthorized } from "@/engine/admin-auth";
import { companyReadiness } from "@/engine/readiness";
export const dynamic = "force-dynamic";

/**
 * Turn a company's workflows on or off from outside the dashboard (a Zap, a script, a go-live checklist).
 * GET  ?company=<slug>                              → every workflow with its readiness
 * POST { company: <slug>, workflow: <template slug | name>, enabled: boolean }
 * DELETE { company: <slug>, workflow: <template slug | name> } removes a workflow a company no longer wants, with its versions,
 *        triggers, runs and their ledger rows; the events it emitted stay (the journal is history). Refused while it is on.
 * Turning ON a workflow with a missing required binding is refused: the dashboard would show it as blocking.
 * Authorization: Bearer $CRON_SECRET.
 */
export async function GET(req: Request) {
  if (!operatorAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const slug = new URL(req.url).searchParams.get("company");
  if (!slug) return NextResponse.json({ error: "company is required" }, { status: 400 });
  return asOperator(async (c) => {
    const co = await one<{ id: string; mode: string }>(c, "select id, mode from companies where slug=$1", [slug]);
    if (!co) return NextResponse.json({ error: "no such company" }, { status: 404 });
    const r = await companyReadiness(c, co.id, `/app/c/${slug}`);
    return NextResponse.json({ ok: true, company: slug, mode: co.mode, ready: r.ready, issues: r.issues, workflows: r.workflows });
  });
}
export async function POST(req: Request) {
  if (!operatorAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = (await req.json().catch(() => null)) as { company?: string; workflow?: string; enabled?: boolean } | null;
  if (!body?.company || !body.workflow || typeof body.enabled !== "boolean") return NextResponse.json({ error: "company, workflow and enabled are required" }, { status: 400 });
  return asOperator(async (c) => {
    const co = await one<{ id: string }>(c, "select id from companies where slug=$1", [body.company]);
    if (!co) return NextResponse.json({ error: "no such company" }, { status: 404 });
    const wfs = await many<{ id: string; name: string; enabled: boolean; slug: string | null }>(c, "select w.id, w.name, w.enabled, t.slug from workflows w left join workflow_templates t on t.id=w.template_id where w.company_id=$1 and (t.slug=$2 or lower(w.name)=lower($2))", [co.id, body.workflow]);
    if (wfs.length !== 1) return NextResponse.json({ error: wfs.length ? "ambiguous workflow name" : "no such workflow for this company" }, { status: 404 });
    const w = wfs[0];
    if (body.enabled) {
      const r = await companyReadiness(c, co.id, `/app/c/${body.company}`); const mine = r.workflows.find((x) => x.id === w.id)!;
      if (mine.missing.length) return NextResponse.json({ error: `cannot turn on: missing ${mine.missing.join(", ")}`, missing: mine.missing }, { status: 409 });
    }
    if (w.enabled !== body.enabled) {
      await c.query("update workflows set enabled=$2 where id=$1", [w.id, body.enabled]);
      await c.query("insert into audit_log (company_id, action, target_type, target_id, before, after) values ($1,$2,'workflow',$3,$4,$5)", [co.id, body.enabled ? "workflow.enabled" : "workflow.disabled", w.id, { enabled: w.enabled }, { enabled: body.enabled, via: "api" }]);
    }
    return NextResponse.json({ ok: true, workflow: w.name, slug: w.slug, enabled: body.enabled, changed: w.enabled !== body.enabled });
  });
}

export async function DELETE(req: Request) {
  if (!operatorAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = (await req.json().catch(() => null)) as { company?: string; workflow?: string } | null;
  if (!body?.company || !body.workflow) return NextResponse.json({ error: "company and workflow are required" }, { status: 400 });
  return asOperator(async (c) => {
    const co = await one<{ id: string }>(c, "select id from companies where slug=$1", [body.company]);
    if (!co) return NextResponse.json({ error: "no such company" }, { status: 404 });
    const wfs = await many<{ id: string; name: string; enabled: boolean; slug: string | null }>(c, "select w.id, w.name, w.enabled, t.slug from workflows w left join workflow_templates t on t.id=w.template_id where w.company_id=$1 and (t.slug=$2 or lower(w.name)=lower($2))", [co.id, body.workflow]);
    if (wfs.length !== 1) return NextResponse.json({ error: wfs.length ? "ambiguous workflow name" : "no such workflow for this company" }, { status: 404 });
    const w = wfs[0];
    if (w.enabled) return NextResponse.json({ error: "turn it off first" }, { status: 409 });
    await c.query("begin");
    try {
      const runs = await one<{ n: string }>(c, "select count(*)::text as n from runs where workflow_id=$1", [w.id]);
      await c.query("delete from sends where run_id in (select id from runs where workflow_id=$1)", [w.id]);
      await c.query("delete from run_steps where run_id in (select id from runs where workflow_id=$1)", [w.id]);
      await c.query("delete from runs where workflow_id=$1", [w.id]);
      await c.query("delete from workflow_triggers where workflow_id=$1", [w.id]);
      await c.query("delete from workflow_versions where workflow_id=$1", [w.id]);
      await c.query("delete from workflows where id=$1", [w.id]);
      await c.query("insert into audit_log (company_id, action, target_type, target_id, before, after) values ($1,'workflow.deleted','workflow',$2,$3,$4)", [co.id, w.id, { name: w.name, slug: w.slug, runs: Number(runs?.n ?? 0) }, { via: "api" }]);
      await c.query("commit");
      return NextResponse.json({ ok: true, workflow: w.name, slug: w.slug, runs_removed: Number(runs?.n ?? 0) });
    } catch (e) { await c.query("rollback"); throw e; }
  });
}
