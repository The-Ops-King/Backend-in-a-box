import { NextResponse } from "next/server";
import { DateTime } from "luxon";
import { asOperator, one } from "@/db/client";
import { operatorAuthorized } from "@/engine/admin-auth";
import { loadCompany } from "@/engine/context";
import { formFor, reportFor, todayFor, DAY_FMT } from "@/engine/eod";

/**
 * D358: GET ?company=<slug>&closer=<email>&day=<yyyy-MM-dd, default today>: the closer's end-of-day form for that day as their own
 * link shows it (today's form carries earlier unfinished calls), with what they filed that day. Read only; nothing is filed, sent or
 * stamped. For checking what a closer is asked for without their private link. Authorization: Bearer $CRON_SECRET.
 */
export async function GET(req: Request) {
  if (!operatorAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const u = new URL(req.url), slug = u.searchParams.get("company"), email = (u.searchParams.get("closer") ?? "").trim().toLowerCase();
  if (!slug || !email) return NextResponse.json({ error: "company and closer (email) are required" }, { status: 400 });
  return asOperator(async (c) => {
    const co = await one<{ id: string }>(c, "select id from companies where slug=$1", [slug]); if (!co) return NextResponse.json({ error: "no such company" }, { status: 404 });
    const { row: company } = await loadCompany(c, co.id);
    const closer = await one<{ id: string; name: string; email: string }>(c, "select id, name, email from users where company_id=$1 and lower(email)=$2", [co.id, email]);
    if (!closer) return NextResponse.json({ error: "no such closer" }, { status: 404 });
    const q = u.searchParams.get("day"), day = q && DateTime.fromFormat(q, DAY_FMT).isValid ? q : todayFor(company.timezone);
    const form = await formFor(c, company, closer, day, DateTime.now());
    const filed = await reportFor(c, co.id, closer.id, day);
    return NextResponse.json({ ok: true, day, closer: closer.name, filed_at: filed?.submitted_at ?? null,
      calls: form.calls.map((x) => ({ contact: x.contact, starts_at: x.starts_at, kind: x.kind ?? "closing", outcome: x.outcome, carried_from: x.carried_from ?? null, missing: x.missing ?? null, hint: x.hint ?? null, appointment_id: x.appointment_id })) });
  });
}
