import { NextResponse } from "next/server";
import { asOperator, one } from "@/db/client";
import { liveAdapters } from "@/adapters";
import { operatorAuthorized } from "@/engine/admin-auth";
import { loadCompany } from "@/engine/context";
import { simulate, simulateForm, SIM_ACTIONS, type SimAction } from "@/engine/simulate";
export const dynamic = "force-dynamic"; export const maxDuration = 60;

/**
 * Stage a synthetic step for a test contact, behind the scenes (D23). Nothing reaches Calendly, Typeform or any Zap; the CRM only
 * as the step's own workflows (and, for `form`, the Typeform door) write it in the company's mode.
 * POST { company: <slug>, contact: <email | our id | GHL id>, action: form|create|book|book-self|reschedule|cancel|pay|record|outcome|call|agreement|sign|reset,
 *   force?: boolean, daysOut?: number, closer?: name|email, startsAt?: ISO (book; reschedule's new start),
 *   calendar?: external id | call type name (book, book-self, reschedule, cancel, record, outcome; D125), amount?: number (pay, outcome; default the program price, a deposit 100),
 *   outcome?: an end-of-day answer's value or label (outcome; D126),
 *   deposit?: boolean (pay), form?: form id | name, answers?: { <ref | target | hidden name>: value }, responseId?: string (form; D125) }
 * `form` takes an email the ledger need not know: the door finds or makes the person, as for a real applicant.
 * Authorization: Bearer $CRON_SECRET. Refused for a live company unless force=true.
 */
type Body = { company?: string; contact?: string; action?: string; force?: boolean; daysOut?: number; closer?: string; startsAt?: string; amount?: number; calendar?: string; deposit?: boolean; form?: string; answers?: Record<string, string | number | boolean>; responseId?: string; outcome?: string };
export async function POST(req: Request) {
  if (!operatorAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = (await req.json().catch(() => null)) as Body | null;
  if (!body?.company || !body.contact || !body.action) return NextResponse.json({ error: "company, contact and action are required" }, { status: 400 });
  const who = body.contact.trim(), slug = body.company;
  if (!(SIM_ACTIONS as readonly string[]).includes(body.action)) return NextResponse.json({ error: `action must be one of ${SIM_ACTIONS.join(", ")}` }, { status: 400 });
  if (body.answers !== undefined && (!body.answers || typeof body.answers !== "object" || Array.isArray(body.answers) || Object.values(body.answers).some((v) => !["string", "number", "boolean"].includes(typeof v))))
    return NextResponse.json({ error: "answers is { <ref | target | hidden name>: text | number | yes/no }" }, { status: 400 });
  return asOperator(async (c) => {
    const co = await one<{ id: string }>(c, "select id from companies where slug=$1", [slug]);
    if (!co) return NextResponse.json({ error: "no such company" }, { status: 404 });
    const { row: company } = await loadCompany(c, co.id);
    const ct = await one<{ id: string }>(c, `select ct.id from contacts ct where ct.company_id=$1 and ct.merged_into is null and (ct.id::text=$2 or ct.ghl_contact_id=$2 or exists (select 1 from contact_identifiers i where i.contact_id=ct.id and i.kind='email' and i.value=lower($2))) limit 1`, [co.id, who]);
    const formOpts = { force: body.force, form: body.form, answers: body.answers, responseId: body.responseId };
    // D125: an application is how a person arrives, so `form` with an email needs no one the poll has seen
    const r = body.action === "form" && who.includes("@") ? await simulateForm({ c, company, adapters: liveAdapters, email: who, ...formOpts })
      : !ct ? null
      : await simulate({ c, company, contactId: ct.id, daysOut: body.daysOut, closer: body.closer, startsAt: body.startsAt, amount: typeof body.amount === "number" && body.amount > 0 ? body.amount : undefined,
        calendar: body.calendar, deposit: body.deposit === true, outcome: typeof body.outcome === "string" ? body.outcome : undefined, adapters: liveAdapters, ...formOpts }, body.action as SimAction);
    if (!r) return NextResponse.json({ error: `no contact matches ${who} (the poll must have seen them first)` }, { status: 404 });
    if (!r.ok) return NextResponse.json({ error: r.why }, { status: 409 });
    const contact = (typeof r.detail.contact === "string" ? r.detail.contact : null) ?? ct?.id ?? null;
    await c.query("insert into audit_log (company_id, action, target_type, target_id, after) values ($1,$2,'contact',$3,$4)", [co.id, `simulate.${r.action}`, contact, { ...r.detail, runs_started: r.runsStarted, via: "api" }]);
    return NextResponse.json({ ok: true, contact, action: r.action, detail: r.detail, runs_started: r.runsStarted, dashboard: contact ? `/app/c/${slug}/contacts/${contact}` : null });
  });
}
