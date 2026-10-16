import { NextResponse } from "next/server";
import { operatorAuthorized } from "@/engine/admin-auth";
import { liveAdapters } from "@/adapters";
import { applyImport, companyTypeform, dryRunImport, formatDryRun, writtenKeys } from "@/engine/typeform-import";
export const dynamic = "force-dynamic"; export const maxDuration = 300;

/**
 * POST { company: <slug>, form: <Typeform form id>, apply?: true, limit?: 50 } with Authorization: Bearer $CRON_SECRET (D122).
 * Without `apply` it is the dry run: reads Typeform and GHL, writes nothing, answers the report. With `apply: true` it writes
 * up to `limit` not-yet-written responses to GHL for real, whatever the company's mode; call again until `remaining` is 0.
 */
export async function POST(req: Request) {
  if (!operatorAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as { company?: string; form?: string; apply?: boolean; limit?: number };
  if (!body.company || !body.form) return NextResponse.json({ error: "company and form are required" }, { status: 400 });
  try {
    const t = await companyTypeform(body.company);
    const form = t.forms[body.form]; if (!form) return NextResponse.json({ error: `form ${body.form} is not mapped for ${body.company}` }, { status: 400 });
    if (!t.token) return NextResponse.json({ error: "no Typeform token bound" }, { status: 400 });
    if (body.apply === true) return NextResponse.json({ ok: true, apply: true, mode: t.company.mode, ...(await applyImport({ companyId: t.company.id, formId: body.form, adapters: liveAdapters, limit: body.limit })) });
    const d = await dryRunImport({ token: t.token, formId: body.form, form, bindings: t.bindings, ac: t.ac, adapters: liveAdapters, written: await writtenKeys(t.company.id) });
    return NextResponse.json({ ok: true, apply: false, report: formatDryRun(d, `${t.company.name}, ${t.company.mode}`), dry_run: d });
  } catch (e) { return NextResponse.json({ ok: false, error: String((e as Error).message) }, { status: 500 }); }
}
