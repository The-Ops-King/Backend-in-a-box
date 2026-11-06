import { NextResponse } from "next/server";
import { asOperator, one } from "@/db/client";
import { operatorAuthorized } from "@/engine/admin-auth";
import { loadCompany } from "@/engine/context";
import { connectCommas, importCommasHistory } from "@/engine/commas";
import { liveAdapters } from "@/adapters";
export const dynamic = "force-dynamic"; export const maxDuration = 300;

/**
 * D319: POST { company, action: "connect" | "import", from? (import: ISO date), dryRun = true }. `connect` checks the offer's Commas
 * key and makes its webhook subscription (the secret bound); `import` brings Commas payments since `from` into the ledger as rows
 * only (nothing starts). Both dry run first. Audited. Authorization: Bearer $CRON_SECRET.
 */
export async function POST(req: Request) {
  if (!operatorAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const b = (await req.json().catch(() => null)) as { company?: string; action?: string; from?: string; dryRun?: boolean } | null;
  if (!b?.company || (b.action !== "connect" && b.action !== "import")) return NextResponse.json({ error: "company and action (connect | import) are required" }, { status: 400 });
  const dryRun = b.dryRun !== false;
  try {
    const r = await asOperator(async (c) => {
      const co = await one<{ id: string }>(c, "select id from companies where slug=$1", [b.company]); if (!co) throw new Error("no such company");
      const l = await loadCompany(c, co.id), loaded = { row: l.row, adapterCompany: l.adapterCompany, bindings: l.bindings };
      if (b.action === "connect") {
        const base = (process.env.PUBLIC_URL ?? process.env.TICK_URL ?? "").replace(/\/$/, "");
        if (!base) throw new Error("PUBLIC_URL is not set: cannot tell Commas where to deliver");
        return connectCommas(c, loaded, base, dryRun);
      }
      const from = new Date(b.from ?? ""); if (Number.isNaN(from.getTime())) throw new Error("from: an ISO date");
      return importCommasHistory(c, loaded, from, dryRun, undefined, liveAdapters);
    });
    return NextResponse.json({ ok: true, ...r });
  } catch (e) { return NextResponse.json({ ok: false, error: String((e as Error).message).slice(0, 300) }, { status: 400 }); }
}
