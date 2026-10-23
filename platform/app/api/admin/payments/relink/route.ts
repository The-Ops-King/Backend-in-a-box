import { NextResponse } from "next/server";
import { asOperator, one } from "@/db/client";
import { operatorAuthorized } from "@/engine/admin-auth";
import { loadCompany } from "@/engine/context";
import { relinkWhopBuyers } from "@/engine/whop-relink";
export const dynamic = "force-dynamic"; export const maxDuration = 300;

/**
 * D229. POST { company, payments?: [payment ids], dryRun = true } with Authorization: Bearer $CRON_SECRET: the company's unlinked
 * Whop payments that came with no buyer are read back from Whop's API and linked by the ledger's ladder. A dry run says who each
 * would link to; the write keeps the buyer on each row and links it, starting no workflow. `pick: { pay_…: contact id }` links one the
 * ladder cannot place to the person named (and only the named payments are read then). Audited.
 */
export async function POST(req: Request) {
  if (!operatorAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = (await req.json()) as { company?: string; payments?: string[]; pick?: Record<string, string>; dryRun?: boolean };
  if (!body.company) return NextResponse.json({ error: "company is required" }, { status: 400 });
  const dryRun = body.dryRun !== false;
  try {
    const rows = await asOperator(async (c) => {
      const co = await one<{ id: string }>(c, "select id from companies where slug=$1", [body.company]); if (!co) throw new Error("company not found");
      const { bindings } = await loadCompany(c, co.id);
      const key = bindings["secret.whop_api_key"]; if (!key) throw new Error("no Whop API key bound for this company");
      return relinkWhopBuyers(c, co.id, key, { dryRun, ids: body.payments, pick: body.pick });
    });
    return NextResponse.json({ ok: true, dryRun, rows });
  } catch (e) { return NextResponse.json({ ok: false, error: String((e as Error).message) }, { status: 500 }); }
}
