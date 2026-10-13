import { NextResponse } from "next/server";
import { asOperator } from "@/db/client";
import { operatorAuthorized } from "@/engine/admin-auth";
import { copySecretBindings } from "@/engine/binding-copy";
export const dynamic = "force-dynamic";

/**
 * D100: share keys between companies without the value leaving the engine.
 * POST { from: <slug>, to: <slug>, keys: ["secret.…"], by? } → { ok, from, to, copied: [{ key, was: new | same | replaced }] }
 * Only the AI keys (secret.anthropic_key, secret.jev_key; a client's own accounts are set by install); a key `from` does not have refuses the whole call. Values are never
 * returned; the target company's audit_log gets `binding.copied` with the keys and the source slug.
 * Authorization: Bearer $CRON_SECRET.
 */
export async function POST(req: Request) {
  if (!operatorAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = (await req.json().catch(() => null)) as { from?: string; to?: string; keys?: unknown; by?: string } | null;
  if (!body?.from || !body.to || !Array.isArray(body.keys)) return NextResponse.json({ error: "from, to and keys are required" }, { status: 400 });
  const r = await asOperator(async (c) => copySecretBindings(c, { from: body.from!, to: body.to!, keys: body.keys, by: body.by || "operator" }));
  if (!r.ok) return NextResponse.json({ error: r.error, ...(r.keys ? { keys: r.keys } : {}) }, { status: r.status });
  return NextResponse.json(r);
}
