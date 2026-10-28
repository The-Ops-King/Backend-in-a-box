import { NextResponse } from "next/server";
import { asOperator, one } from "@/db/client";
import { liveAdapters } from "@/adapters";
import { operatorAuthorized } from "@/engine/admin-auth";
import { loadCompany } from "@/engine/context";
export const dynamic = "force-dynamic"; export const maxDuration = 120;

/**
 * D248: read only. GET ?company=<slug>&days=<n, default 14>: what the offer's Fathom key can see, by who recorded it: how many
 * meetings, the latest, and whether each is in the engine. Answers "can the engine see Jose's calls" from Fathom's side (a key sees
 * its own user's recordings and what is shared with that user or their team). No titles beyond the latest, no transcripts.
 * Authorization: Bearer $CRON_SECRET.
 */
export async function GET(req: Request) {
  if (!operatorAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const u = new URL(req.url), company = u.searchParams.get("company"), days = Math.min(60, Math.max(1, Number(u.searchParams.get("days") ?? 14)));
  if (!company) return NextResponse.json({ error: "company is required" }, { status: 400 });
  try {
    return NextResponse.json(await asOperator(async (c) => {
      const co = await one<{ id: string }>(c, "select id from companies where slug=$1", [company]); if (!co) throw new Error("company not found");
      const { bindings } = await loadCompany(c, co.id);
      const key = bindings["secret.fathom_api_key"]; if (!key) throw new Error("no Fathom API key bound for this offer");
      if (!liveAdapters.recorder?.meetings) throw new Error("the recorder adapter cannot list meetings");
      const to = new Date(), from = new Date(to.getTime() - days * 864e5);
      const ms = await liveAdapters.recorder.meetings(key, from, to);
      const by = new Map<string, { recorded_by: string; meetings: number; in_engine: number; latest: string | null; latest_title: string | null }>();
      for (const m of ms) {
        const rb = (m.recorded_by as { email?: string; name?: string } | undefined) ?? {};
        const who = (rb.email || rb.name || "unknown").toLowerCase();
        const id = String(m.recording_id ?? m.id ?? "");
        const known = id ? !!(await one(c, "select 1 from recordings where company_id=$1 and provider='fathom' and external_id=$2", [co.id, id])) : false;
        const at = String(m.recording_start_time ?? m.created_at ?? m.scheduled_start_time ?? "");
        const row = by.get(who) ?? { recorded_by: who, meetings: 0, in_engine: 0, latest: null, latest_title: null };
        row.meetings++; if (known) row.in_engine++;
        if (at && (!row.latest || at > row.latest)) { row.latest = at; row.latest_title = String(m.title ?? m.meeting_title ?? "").slice(0, 80) || null; }
        by.set(who, row);
      }
      return { ok: true, days, total: ms.length, by_recorder: [...by.values()].sort((a, b) => b.meetings - a.meetings) };
    }));
  } catch (e) { return NextResponse.json({ ok: false, error: String((e as Error).message).slice(0, 300) }, { status: 500 }); }
}
