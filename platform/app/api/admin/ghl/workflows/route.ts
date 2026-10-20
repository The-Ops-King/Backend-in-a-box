import { NextResponse } from "next/server";
import { asOperator, one } from "@/db/client";
import { operatorAuthorized } from "@/engine/admin-auth";
import { confirmCheck, filtersState, markWorkflow, readTheirWorkflows, saveList } from "@/onboarding/filters";
export const dynamic = "force-dynamic"; export const maxDuration = 60;

/**
 * D151: an offer's own GHL workflows and their check (D180), for any offer, from the operator's side. D192: no move up waits for it.
 * GET  ?company=<slug> → the list as last read, each one's mark, what is left, whether a fresh check is in hand
 * POST { company, read: true } → read live and kept with the marks made
 * POST { company, id, mark: replaced|filtered|harmless|off, note?, by } → one marked (Tyler's call, in the chat)
 * POST { company, check: true, by } → read again live; says anything new or unmarked
 * Authorization: Bearer $CRON_SECRET.
 */
const companyId = (slug: string) => asOperator((c) => one<{ id: string }>(c, "select id from companies where slug=$1", [slug]));
export async function GET(req: Request) {
  if (!operatorAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const slug = new URL(req.url).searchParams.get("company"); if (!slug) return NextResponse.json({ error: "company is required" }, { status: 400 });
  const co = await companyId(slug); if (!co) return NextResponse.json({ error: "no such company" }, { status: 404 });
  return NextResponse.json({ ok: true, ...(await asOperator((c) => filtersState(c, co.id))) });
}
export async function POST(req: Request) {
  if (!operatorAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = (await req.json().catch(() => null)) as { company?: string; read?: boolean; check?: boolean; id?: string; mark?: string; note?: string; by?: string } | null;
  if (!body?.company) return NextResponse.json({ error: "company is required" }, { status: 400 });
  const co = await companyId(body.company); if (!co) return NextResponse.json({ error: "no such company" }, { status: 404 });
  if (body.read === true || body.check === true) {
    const r = await readTheirWorkflows(asOperator, co.id);
    if (!r.ok) return NextResponse.json({ error: r.why }, { status: r.status });
    if (body.read === true) { await asOperator((c) => saveList(c, co.id, r.list)); return NextResponse.json({ ok: true, count: r.list.length }); }
    const chk = await asOperator((c) => confirmCheck(c, co.id, r.list, body.by || "operator"));
    return chk.ok ? NextResponse.json(chk) : NextResponse.json({ error: chk.why, problems: chk.problems }, { status: chk.status });
  }
  if (!body.by?.trim()) return NextResponse.json({ error: "by is required (who marked it)" }, { status: 400 });
  const r = await asOperator((c) => markWorkflow(c, co.id, { id: body.id, mark: body.mark, note: body.note, by: body.by }));
  return r.ok ? NextResponse.json({ ok: true }) : NextResponse.json({ error: r.why }, { status: r.status });
}
