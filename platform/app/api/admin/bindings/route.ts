import { NextResponse } from "next/server";
import { asOperator, one } from "@/db/client";
import { operatorAuthorized } from "@/engine/admin-auth";
import { settingsRows } from "@/engine/settings";
export const dynamic = "force-dynamic";

/** D233: read only. GET ?company=<slug>&q=<text in the key>: the company's settings as its Settings page shows them (a secret only masked, never its value). Authorization: Bearer $CRON_SECRET. */
export async function GET(req: Request) {
  if (!operatorAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const u = new URL(req.url), company = u.searchParams.get("company"), q = (u.searchParams.get("q") ?? "").toLowerCase();
  if (!company) return NextResponse.json({ error: "company is required" }, { status: 400 });
  const rows = await asOperator(async (c) => {
    const co = await one<{ id: string }>(c, "select id from companies where slug=$1", [company]); if (!co) return null;
    return (await settingsRows(c, co.id)).filter((r) => !q || r.key.toLowerCase().includes(q)).map((r) => ({ key: r.key, kind: r.kind, set: r.set, value: r.kind === "secret" ? null : r.value, masked: r.masked, usedBy: r.usedBy }));
  });
  return rows ? NextResponse.json({ ok: true, settings: rows }) : NextResponse.json({ error: "company not found" }, { status: 404 });
}
