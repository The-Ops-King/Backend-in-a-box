import { NextResponse } from "next/server";
import { asOperator, many, one } from "@/db/client";
import { operatorAuthorized } from "@/engine/admin-auth";
import { setSendLock } from "@/engine/send-lock";
export const dynamic = "force-dynamic";

/**
 * D145: the send lock, one workflow at a time, only on Tyler's word in the chat (CLAUDE.md).
 * GET ?company=<slug> → every workflow with whether its sends are unlocked, when and on whose word
 * POST { company, workflow: <template slug | name>, unlock: boolean, confirm: "<company>/<workflow name>", by } → audited.
 * Authorization: Bearer $CRON_SECRET.
 */
export async function GET(req: Request) {
  if (!operatorAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const slug = new URL(req.url).searchParams.get("company");
  if (!slug) return NextResponse.json({ error: "company is required" }, { status: 400 });
  return asOperator(async (c) => {
    const co = await one<{ id: string }>(c, "select id from companies where slug=$1", [slug]);
    if (!co) return NextResponse.json({ error: "no such company" }, { status: 404 });
    const workflows = await many(c, "select name, enabled, sends_unlocked_at is not null as unlocked, sends_unlocked_at as unlocked_at, sends_unlocked_by as unlocked_by from workflows where company_id=$1 order by name", [co.id]);
    return NextResponse.json({ ok: true, company: slug, workflows });
  });
}
export async function POST(req: Request) {
  if (!operatorAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = (await req.json().catch(() => null)) as { company?: string; workflow?: string; unlock?: boolean; confirm?: string; by?: string } | null;
  if (!body?.company || !body.workflow || typeof body.unlock !== "boolean" || !body.confirm || !body.by) return NextResponse.json({ error: "company, workflow, unlock, confirm and by are required" }, { status: 400 });
  const r = await asOperator((c) => setSendLock(c, { company: body.company!, workflow: body.workflow!, unlock: body.unlock!, confirm: body.confirm!, by: body.by! }));
  return r.ok ? NextResponse.json(r) : NextResponse.json({ error: r.error }, { status: r.status });
}
