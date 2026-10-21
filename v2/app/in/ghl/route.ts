import { NextResponse } from "next/server";
import { verifyGhlSignature } from "@/ghl/signature";
import { recordGhlDelivery } from "@/ghl/inbox";

export const dynamic = "force-dynamic";

/**
 * POST /in/ghl: every GHL webhook. The signature is checked over the raw body; a delivery that fails it is refused (401) and
 * kept nowhere. A good one is stored as it arrived and answered 200 at once; reading it is later work, never this request's.
 */
export async function POST(req: Request) {
  const key = process.env.GHL_WEBHOOK_PUBLIC_KEY;
  if (!key) return NextResponse.json({ error: "not configured" }, { status: 503 });
  const raw = await req.text();
  if (!verifyGhlSignature(raw, req.headers.get("x-ghl-signature"), key)) return NextResponse.json({ error: "bad signature" }, { status: 401 });
  const headers = Object.fromEntries([...req.headers.entries()].filter(([k]) => k.startsWith("x-") || k === "content-type" || k === "user-agent"));
  const r = await recordGhlDelivery(raw, headers);
  return NextResponse.json({ ok: true, duplicate: !r.stored });
}
