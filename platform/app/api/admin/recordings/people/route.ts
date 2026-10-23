import { NextResponse } from "next/server";
import { asOperator, many, one } from "@/db/client";
import { liveAdapters } from "@/adapters";
import { operatorAuthorized } from "@/engine/admin-auth";
import { loadCompany } from "@/engine/context";
import { normName, type RecordingRow } from "@/engine/recordings";
export const dynamic = "force-dynamic"; export const maxDuration = 60;

/**
 * D225: GET ?company=<slug>&recording=<recording id>: who was on one recorded call, read only. The invite as the recorder sent it, and
 * the people who actually spoke (from the transcript: held on the row, else read again from Fathom; D87: no words are returned or
 * kept, only each speaker's name, email when the recorder gives one, how many lines, and when they first and last spoke), each with
 * the contacts and team members that name or email is. Authorization: Bearer $CRON_SECRET.
 */
export async function GET(req: Request) {
  if (!operatorAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const q = new URL(req.url).searchParams, slug = q.get("company"), id = q.get("recording");
  if (!slug || !id || !/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: "company and recording (its id) are required" }, { status: 400 });
  return asOperator(async (c) => {
    const co = await one<{ id: string }>(c, "select id from companies where slug=$1", [slug]); if (!co) return NextResponse.json({ error: "no such company" }, { status: 404 });
    const r = await one<RecordingRow>(c, "select * from recordings where company_id=$1 and id=$2", [co.id, id]); if (!r) return NextResponse.json({ error: "no such recording" }, { status: 404 });
    const { bindings } = await loadCompany(c, co.id);
    let lines = r.transcript, source = "held";
    if (!lines?.length) {
      const key = bindings["secret.fathom_api_key"];
      if (r.provider !== "fathom" || !key || !liveAdapters.recorder) return NextResponse.json({ error: "no transcript held, and none can be read again for this recording" }, { status: 409 });
      try { lines = await liveAdapters.recorder.transcript(key, r.external_id); source = "fathom"; } catch (e) { return NextResponse.json({ error: `Fathom: ${String((e as Error).message).slice(0, 200)}` }, { status: 502 }); }
    }
    const by = new Map<string, { name: string; email: string | null; lines: number; first: string | null; last: string | null }>();
    for (const l of lines ?? []) {
      const k = `${l.speaker}|${l.email ?? ""}`, s = by.get(k) ?? { name: l.speaker, email: l.email ?? null, lines: 0, first: l.timestamp ?? null, last: null };
      s.lines++; s.last = l.timestamp ?? s.last; by.set(k, s);
    }
    const speakers = [];
    for (const s of by.values()) {
      const n = normName(s.name), e = s.email?.trim().toLowerCase();
      const contacts = await many<{ id: string; name: string }>(c, `select ct.id, trim(coalesce(ct.first_name,'')||' '||coalesce(ct.last_name,'')) as name from contacts ct where ct.company_id=$1 and ct.merged_into is null and (
        ($2::text is not null and lower(regexp_replace(trim(coalesce(ct.first_name,'')||' '||coalesce(ct.last_name,'')), '[^[:alnum:]]+', ' ', 'g'))=$2)
        or ($3::text is not null and exists (select 1 from contact_identifiers i where i.contact_id=ct.id and i.kind='email' and i.value=$3))) limit 5`, [co.id, n ?? null, e ?? null]);
      const staff = await many<{ name: string }>(c, "select name from users where (company_id=$1 or company_id is null) and (lower(email)=$2 or lower(regexp_replace(trim(name), '[^[:alnum:]]+', ' ', 'g'))=$3)", [co.id, e ?? "", n ?? ""]);
      speakers.push({ ...s, contacts, staff: staff.map((x) => x.name) });
    }
    return NextResponse.json({ ok: true, recording: { id: r.id, title: r.title, started_at: r.started_at, ended_at: r.ended_at, recorded_by: r.recorded_by_email, invitees: r.invitees, contact_id: r.contact_id, appointment_id: r.appointment_id, linked_by: r.linked_by }, transcript_from: source, speakers });
  });
}
