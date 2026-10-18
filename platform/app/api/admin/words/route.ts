import { NextResponse } from "next/server";
import { asOperator, one } from "@/db/client";
import { operatorAuthorized } from "@/engine/admin-auth";
import { wordsFromEdits } from "@/engine/words";
export const dynamic = "force-dynamic";

/**
 * D149, with Authorization: Bearer $CRON_SECRET. POST { company, apply? } → the company's earlier word edits (copies frozen by
 * a pre-D149 copy edit) that differ from their template only in words: moved into the company's words, the copy untouched again so
 * it follows its template from then on. A copy edited beyond words, or behind its template, stays as it is and is named. A dry run
 * unless `apply: true`; nothing a run sends changes either way (the words are the same words).
 */
export async function POST(req: Request) {
  if (!operatorAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = (await req.json().catch(() => null)) as { company?: string; apply?: boolean } | null;
  if (!body?.company) return NextResponse.json({ error: "company is required" }, { status: 400 });
  return asOperator(async (c) => {
    const co = await one<{ id: string }>(c, "select id from companies where slug=$1", [body.company]);
    if (!co) return NextResponse.json({ error: "no such company" }, { status: 404 });
    return NextResponse.json({ ok: true, dryRun: body.apply !== true, ...(await wordsFromEdits(c, co.id, body.apply !== true)) });
  });
}
