import { NextResponse } from "next/server";
import { asOperator, one } from "@/db/client";
import { liveAdapters } from "@/adapters";
import { operatorAuthorized } from "@/engine/admin-auth";
import { closeTicket } from "@/engine/tickets";
export const dynamic = "force-dynamic";

/** D152: POST { company, number, note, by } → the ticket closed: the note in its Slack thread, a ✅ on its post, the GitHub issue closed. */
export async function POST(req: Request) {
  if (!operatorAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = (await req.json().catch(() => null)) as { company?: string; number?: number; note?: string; by?: string } | null;
  if (!body?.company || !Number.isInteger(body.number) || !body.by?.trim()) return NextResponse.json({ error: "company, number and by are required" }, { status: 400 });
  const co = await asOperator((c) => one<{ id: string }>(c, "select id from companies where slug=$1", [body.company]));
  if (!co) return NextResponse.json({ error: "no such company" }, { status: 404 });
  const r = await closeTicket(liveAdapters, co.id, body.number!, (body.note ?? "").trim(), body.by.trim());
  return r.ok ? NextResponse.json(r) : NextResponse.json({ error: r.why }, { status: r.status });
}
