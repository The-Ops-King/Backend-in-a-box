import { NextResponse } from "next/server";
import { asOperator } from "@/db/client";
import { operatorAuthorized } from "@/engine/admin-auth";
import { operatorAddresses, setOperatorAddresses } from "@/engine/send-lock";
export const dynamic = "force-dynamic";

/**
 * D145: the operator's own addresses, the only ones a locked workflow's sends reach.
 * GET → { emails, phones }
 * POST { name?, add?: { emails?, phones? }, remove?: { emails?, phones? } } → the addresses after. Audited.
 * Authorization: Bearer $CRON_SECRET.
 */
export async function GET(req: Request) {
  if (!operatorAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  return asOperator(async (c) => { const a = await operatorAddresses(c); return NextResponse.json({ ok: true, emails: [...a.emails].sort(), phones: [...a.phones].sort() }); });
}
export async function POST(req: Request) {
  if (!operatorAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = (await req.json().catch(() => null)) as Parameters<typeof setOperatorAddresses>[1] | null;
  if (!body || (!body.add && !body.remove)) return NextResponse.json({ error: "add or remove is required" }, { status: 400 });
  try { return NextResponse.json({ ok: true, ...(await asOperator((c) => setOperatorAddresses(c, body))) }); }
  catch (e) { return NextResponse.json({ ok: false, error: String((e as Error).message) }, { status: 400 }); }
}
