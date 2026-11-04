import { NextResponse } from "next/server";
import { asOperator, many, one } from "@/db/client";
import { liveAdapters } from "@/adapters";
import { operatorAuthorized } from "@/engine/admin-auth";
import { loadCompany } from "@/engine/context";
import { transcriptFor } from "@/engine/transcripts";
import type { RecordingRow } from "@/engine/recordings";
export const dynamic = "force-dynamic"; export const maxDuration = 300;

/**
 * D310: POST { company, recordings: [ids], why, dryRun = true, model? }: the offer's own call review (prompt.call_review) run on
 * recordings no workflow ever read (calls held while Sales call recorded ran in rehearsal, a recorder connected later), the read kept
 * on the recording as the analyze step keeps it (`analysis.notes`, `analysis.rubric`). Nothing is posted and nothing is written to the
 * CRM: what the read says is the caller's to use (e.g. Pitched on a Sales Call, by its own dry run). The dry run says which recordings
 * would be read and how long each transcript is, and asks the AI nothing. Audited. Authorization: Bearer $CRON_SECRET.
 */
export async function POST(req: Request) {
  if (!operatorAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const b = (await req.json().catch(() => null)) as { company?: string; recordings?: string[]; why?: string; dryRun?: boolean; model?: string } | null;
  if (!b?.company || !b.recordings?.length || !b.why?.trim()) return NextResponse.json({ error: "company, recordings and why are required" }, { status: 400 });
  if (b.recordings.length > 5) return NextResponse.json({ error: "at most 5 recordings a call (each is a long AI read)" }, { status: 400 });
  return asOperator(async (c) => {
    const co = await one<{ id: string }>(c, "select id from companies where slug=$1", [b.company]); if (!co) return NextResponse.json({ error: "no such company" }, { status: 404 });
    const { adapterCompany, bindings } = await loadCompany(c, co.id);
    const prompt = (bindings["prompt.call_review"] ?? "").trim();
    if (!prompt) return NextResponse.json({ error: "this offer has no prompt.call_review" }, { status: 400 });
    const apiKey = bindings["secret.anthropic_key"] || process.env.ANTHROPIC_API_KEY;
    if (!apiKey && b.dryRun === false) return NextResponse.json({ error: "no Anthropic key for this offer" }, { status: 400 });
    const rows = await many<RecordingRow>(c, "select * from recordings where company_id=$1 and id = any($2::uuid[])", [co.id, b.recordings]);
    const out: Record<string, unknown>[] = [];
    for (const r of rows) {
      const text = await transcriptFor({ adapters: liveAdapters, adapterCompany, bindings }, r).catch(() => "");
      const head = { recording: r.id, started_at: r.started_at, minutes: r.duration_min, transcript_chars: text.length };
      if (!text) { out.push({ ...head, skipped: "no transcript at its source" }); continue; }
      if (b.dryRun !== false) { out.push(head); continue; }
      try {
        const res = await liveAdapters.analyst.analyze(apiKey!, { system: prompt, input: text, format: "json", maxTokens: 16000, model: b.model ?? "claude-sonnet-5-5" });
        const parsed = (res.parsed ?? null) as { notes?: Record<string, unknown>; rubric?: Record<string, unknown> } | null;
        if (!parsed) { out.push({ ...head, error: `the read did not parse${res.refused ? ` (declined: ${res.refused})` : ""}` }); continue; }
        const stored = { notes: parsed.notes ?? {}, rubric: parsed.rubric ?? {} };
        await c.query("update recordings set analysis = analysis || $2::jsonb where id=$1", [r.id, JSON.stringify(stored)]);
        await c.query("insert into audit_log (company_id, action, target_type, target_id, after) values ($1,'recording.reviewed','recording',$2,$3)", [co.id, r.id, { why: b.why!.trim(), model: res.model, pitched: stored.notes.pitched ?? null }]);
        out.push({ ...head, pitched: stored.notes.pitched ?? null, disposition: stored.notes.disposition ?? null, summary: String(stored.notes.summary ?? "").slice(0, 240) });
      } catch (e) { out.push({ ...head, error: String((e as Error).message).slice(0, 200) }); }
    }
    for (const id of b.recordings!) if (!rows.some((r) => r.id === id)) out.push({ recording: id, skipped: "not this offer's recording" });
    return NextResponse.json({ ok: true, dryRun: b.dryRun !== false, reviewed: out });
  });
}
