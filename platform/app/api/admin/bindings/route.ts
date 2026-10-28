import { NextResponse } from "next/server";
import { asOperator, one } from "@/db/client";
import { operatorAuthorized } from "@/engine/admin-auth";
import { setBinding, settingsRows, type BindingKind } from "@/engine/settings";
import { TF_TOKEN_KEY } from "@/engine/typeform";
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

/** Keys a setting can be set to from here beyond those the Settings page lists: a connection whose door is not open yet (D250: the Typeform token, before its forms are mapped). */
const EXTRA: Record<string, BindingKind> = { [TF_TOKEN_KEY]: "secret" };

/** D250: POST { company, key, value, why }: one setting the Settings page lists (or EXTRA), set as its kind. A secret is stored encrypted and never answered back. Audited. Authorization: Bearer $CRON_SECRET. */
export async function POST(req: Request) {
  if (!operatorAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const b = (await req.json().catch(() => null)) as { company?: string; key?: string; value?: string; why?: string } | null;
  if (!b?.company || !b.key || typeof b.value !== "string" || !b.value.trim() || !b.why?.trim()) return NextResponse.json({ error: "company, key, value and why are required" }, { status: 400 });
  const r = await asOperator(async (c) => {
    const co = await one<{ id: string }>(c, "select id from companies where slug=$1", [b.company]); if (!co) return { status: 404, error: "company not found" };
    const kind = (await settingsRows(c, co.id)).find((x) => x.key === b.key)?.kind ?? EXTRA[b.key!];
    if (!kind) return { status: 400, error: `${b.key} is not a setting this offer has` };
    await setBinding(c, co.id, b.key!, kind, b.value!.trim(), `admin: ${b.why!.trim()}`);
    return { status: 200, key: b.key, kind };
  });
  return r.status === 200 ? NextResponse.json({ ok: true, key: r.key, kind: r.kind }) : NextResponse.json({ error: r.error }, { status: r.status });
}
