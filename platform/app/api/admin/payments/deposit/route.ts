import { NextResponse } from "next/server";
import { asOperator, one } from "@/db/client";
import { operatorAuthorized } from "@/engine/admin-auth";
import { markDeposit } from "@/engine/payments";
export const dynamic = "force-dynamic";

/**
 * D229. POST { company, payment (its id or Whop's pay_ id), dryRun = true } with Authorization: Bearer $CRON_SECRET: the payment is
 * marked a deposit. A dry run lists the kinds that would change (it, and any after it on the same pursuit); nothing is started. Audited.
 */
export async function POST(req: Request) {
  if (!operatorAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = (await req.json()) as { company?: string; payment?: string; dryRun?: boolean };
  if (!body.company || !body.payment) return NextResponse.json({ error: "company and payment are required" }, { status: 400 });
  const dryRun = body.dryRun !== false;
  try {
    const r = await asOperator(async (c) => {
      const co = await one<{ id: string }>(c, "select id from companies where slug=$1", [body.company]); if (!co) throw new Error("company not found");
      return markDeposit(c, co.id, body.payment!, { dryRun });
    });
    return NextResponse.json({ ok: true, dryRun, ...r });
  } catch (e) { return NextResponse.json({ ok: false, error: String((e as Error).message) }, { status: 500 }); }
}
