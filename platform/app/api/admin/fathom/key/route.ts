import { NextResponse } from "next/server";
import { asOperator, one } from "@/db/client";
import { operatorAuthorized } from "@/engine/admin-auth";
import { loadCompany } from "@/engine/context";
import { replaceFathomKey } from "@/engine/fathom-key";
export const dynamic = "force-dynamic"; export const maxDuration = 60;

/**
 * D336: POST { company, key, dryRun = true }: one offer's new Fathom API key, tested, with its own webhook made and the old one
 * removed. Audited; the key never comes back. Authorization: Bearer $CRON_SECRET.
 */
export async function POST(req: Request) {
  if (!operatorAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const b = (await req.json().catch(() => null)) as { company?: string; key?: string; dryRun?: boolean } | null;
  if (!b?.company || typeof b.key !== "string") return NextResponse.json({ error: "company and key are required" }, { status: 400 });
  const base = (process.env.PUBLIC_URL ?? process.env.TICK_URL ?? "").replace(/\/$/, "");
  if (!base) return NextResponse.json({ error: "PUBLIC_URL is not set: cannot tell Fathom where to deliver" }, { status: 500 });
  try {
    const r = await asOperator(async (c) => {
      const co = await one<{ id: string }>(c, "select id from companies where slug=$1", [b.company]); if (!co) throw new Error("no such company");
      const { bindings } = await loadCompany(c, co.id);
      return replaceFathomKey(c, co.id, bindings, b.key!, base, { dryRun: b.dryRun !== false, by: "operator" });
    });
    return NextResponse.json({ ok: true, ...r });
  } catch (e) { return NextResponse.json({ ok: false, error: String((e as Error).message).slice(0, 300) }, { status: 400 }); }
}
