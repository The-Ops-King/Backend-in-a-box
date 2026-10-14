import { NextResponse } from "next/server";
import { asOperator } from "@/db/client";
import { operatorAuthorized } from "@/engine/admin-auth";
import { setPlainBinding } from "@/engine/binding-set";
export const dynamic = "force-dynamic";

/**
 * D109: set one plain company setting, as the Settings page would.
 * POST { company: <slug>, key, value, by? } → { ok, key, kind, was, value }; a secret, an unknown key or an empty value is refused (400).
 * Authorization: Bearer $CRON_SECRET.
 */
export async function POST(req: Request) {
  if (!operatorAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = (await req.json().catch(() => null)) as { company?: string; key?: unknown; value?: unknown; by?: string } | null;
  if (!body?.company) return NextResponse.json({ error: "company, key and value are required" }, { status: 400 });
  const r = await asOperator((c) => setPlainBinding(c, { company: body.company!, key: body.key, value: body.value, by: body.by || "operator" }));
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status });
  return NextResponse.json(r);
}
