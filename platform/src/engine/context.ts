import { DateTime } from "luxon";
import type { PoolClient } from "pg";
import { many, one } from "@/db/client";
import { decrypt } from "./crypto";
import type { BookingConfig, Company } from "@/adapters/types";
import { transcriptText, type RecordingRow } from "./recordings";
import { latestAgreement, facts as agreementFacts, type AgreementRow } from "./agreements";
import { eodFacts } from "./eod";
import type { ContactTruth } from "./contact-truth";
import { salesCallValues } from "./sales-call";

export type RunRow = { id: string; company_id: string; workflow_id: string; workflow_version: number; contact_id: string | null; user_id?: string | null; opportunity_id: string | null; appointment_id: string | null; status: string; current_node: string | null; next_run_at: Date | null; context: Record<string, unknown>; reentry_key: string; started_at?: Date; resume_node?: string | null; resume_at?: Date | null; step_attempt?: number; step_error?: string | null };
export type CompanyRow = { id: string; name: string; slug: string; timezone: string; send_window_start: string; send_window_end: string; quiet_allow_transactional: boolean; status: string; sms_enabled: boolean; mode: import("./mode").Mode; contract_value_default: string | null };

export async function loadCompany(c: PoolClient, companyId: string): Promise<{ row: CompanyRow; adapterCompany: Company; bindings: Record<string, string> }> {
  const row = await one<CompanyRow>(c, "select * from companies where id=$1", [companyId]);
  if (!row) throw new Error(`company ${companyId} not found`);
  const rows = await many<{ key: string; kind: string; value: Buffer }>(c, "select key, kind, value from bindings where company_id=$1", [companyId]);
  const bindings: Record<string, string> = {};
  for (const b of rows) bindings[b.key] = b.kind === "secret" ? decrypt(b.value) : b.value.toString("utf8");
  // per-calendar rules (D24) ride along with the booking config so the adapter can read answers by the right question text
  const calRows = await many<{ external_id: string; config: Record<string, unknown> }>(c, "select external_id, config from calendars where company_id=$1 and active and config <> '{}'::jsonb", [companyId]);
  const calendars = calRows.length ? Object.fromEntries(calRows.map((r) => [r.external_id, r.config])) : undefined;
  const booking: BookingConfig = bindings["secret.calendly_token"]
    ? { source: "calendly", token: bindings["secret.calendly_token"], organization: bindings["calendly.organization"] ?? "", user: bindings["calendly.user"] || undefined, phoneQuestion: bindings["calendly.phone_question"] || undefined, setterQuestion: bindings["calendly.setter_question"] || undefined, calendars }
    : { source: "ghl", calendars };
  const adapterCompany: Company = { id: row.id, locationId: bindings["crm.location_id"] ?? "", pit: bindings["secret.ghl_pit"] ?? "", timezone: row.timezone, booking };
  return { row, adapterCompany, bindings };
}

/** Builds what `{{…}}` resolves against. Secrets are never placed in the context. */
/** `truth`: what the live read before this run acted found (D68): when the CRM was read, or why the engine's copy stood in. */
export async function buildContext(c: PoolClient, run: RunRow, company: CompanyRow, bindings: Record<string, string>, truth?: ContactTruth): Promise<Record<string, unknown>> {
  // first_name is the CRM's own field as typed; when the CRM left it blank, the first word of whatever name there is; a wholly nameless person is null and the template's `default:` speaks
  const contact = await one<Record<string, unknown>>(c, `select ct.id, ct.ghl_contact_id, ct.last_name, nullif(trim(coalesce(ct.first_name,'')||' '||coalesce(ct.last_name,'')),'') as name,
      coalesce(nullif(trim(ct.first_name),''), split_part(nullif(trim(coalesce(ct.first_name,'')||' '||coalesce(ct.last_name,'')),''), ' ', 1)) as first_name,
      ct.timezone, ct.tags, ct.attributes, ct.ghl_fields, ct.assigned_ghl_user_id,
      (select value from contact_identifiers i where i.contact_id=ct.id and i.kind='phone' and i.retired_at is null order by i.created_at limit 1) as phone,
      (select value from contact_identifiers i where i.contact_id=ct.id and i.kind='email' and i.retired_at is null order by i.created_at limit 1) as email
    from contacts ct where ct.id=$1`, [run.contact_id]);
  const contactZone = typeof contact?.timezone === "string" && DateTime.now().setZone(contact.timezone).isValid ? contact.timezone : undefined;   // G20: a zone Luxon cannot use never reaches the window math
  // D13: the reply the run is reacting to is whatever the contact last sent after this run started; what we last sent is the classifier's state.
  const lastIn = await one<{ body: string | null; occurred_at: Date }>(c, "select body, occurred_at from messages where company_id=$1 and contact_id=$2 and direction='inbound' and occurred_at >= $3 order by occurred_at desc limit 1", [company.id, run.contact_id, run.started_at ?? new Date(0)]);
  // what we last said to THEM: a text or an email; a Slack post about them (the question to the team) is not a message they saw
  const lastOut = await one<{ rendered_body: string; sent_at: Date }>(c, "select rendered_body, sent_at from sends where company_id=$1 and contact_id=$2 and channel in ('sms','email') and status='sent' order by sent_at desc limit 1", [company.id, run.contact_id]);
  const sinceSend = await many<{ body: string | null }>(c, "select body from messages where company_id=$1 and contact_id=$2 and direction='inbound' and occurred_at > $3 order by occurred_at", [company.id, run.contact_id, lastOut?.sent_at ?? run.started_at ?? new Date(0)]);
  const derivedReply: Record<string, unknown> = {
    last_inbound: lastIn ? { body: lastIn.body, at: lastIn.occurred_at.toISOString() } : undefined,
    last_outbound: lastOut ? { body: lastOut.rendered_body, at: lastOut.sent_at?.toISOString() } : undefined,
    inbound_since_send: sinceSend.map((m) => m.body ?? "").filter(Boolean).join("\n") || undefined, count: sinceSend.length,   // D47: everything they sent since we last did, in order
  };
  // CRM custom fields by the name the company bound them under: crm.field_contact_hair_loss = <id> → contact.fields.hair_loss
  const fields: Record<string, unknown> = {};
  const raw = (contact?.ghl_fields ?? {}) as Record<string, unknown>;
  for (const [k, id] of Object.entries(bindings)) if (k.startsWith("crm.field_contact_")) { const v = raw[id]; fields[k.slice("crm.field_contact_".length)] = Array.isArray(v) ? v.join(", ") : v ?? undefined; }
  const ctx: Record<string, unknown> = {
    company: { id: company.id, name: company.name, timezone: company.timezone, operator_slack_id: bindings["bot.escalate_to"] || undefined },
    contact: contact ? { ...contact, ghl_fields: undefined, fields, timezone: contactZone ?? company.timezone } : undefined,
    vars: (run.context.vars as Record<string, unknown>) ?? {},
    reply: { ...((run.context.reply as Record<string, unknown>) ?? {}), ...derivedReply },   // last_inbound/last_outbound are re-derived every tick; intent/confidence from classify persist
    event: run.context.event ?? {},
    reaction: run.context.reaction,   // what a wait_for_reaction stored (D53); carried so the steps after it can say who decided even across a park
    calendar: {}, slack: { channel: {} }, crm: {}, prompt: {},
    // the company's own option keys for what the engine writes on a picklist (a Sales Call's outcome)
    picklist: { sales_call_outcome: salesCallValues(bindings) },
  };
  // the recording a run was started by (recording.received) — read from the ledger every tick, never copied into the run's context
  const recId = (run.context.event as { recording_id?: string } | undefined)?.recording_id;
  if (recId) {
    const r = await one<RecordingRow & { closer_name: string | null; closer_ghl: string | null }>(c, "select r.*, u.name as closer_name, u.ghl_user_id as closer_ghl from recordings r left join users u on u.company_id=r.company_id and lower(u.email)=r.recorded_by_email where r.id=$1", [recId]);
    if (r) ctx.recording = { id: r.id, provider: r.provider, external_id: r.external_id, title: r.title, started_at: r.started_at.toISOString(), ended_at: r.ended_at?.toISOString(), duration_min: r.duration_min, url: r.url, share_url: r.share_url,
      recorded_by: { name: r.recorded_by_name, email: r.recorded_by_email }, closer: r.closer_name ? { name: r.closer_name, first_name: r.closer_name.split(" ")[0], ghl_user_id: r.closer_ghl } : undefined,
      invitees: r.invitees, invitee_names: r.invitees.map((i) => i.name).filter(Boolean).join(", "), transcript_text: transcriptText(r.transcript), has_transcript: !!r.transcript?.length, summary: r.summary, matched_by: r.linked_by, analysis: r.analysis,
      // phone calls (D28): the dialer's facts, who dialed, and whether a booking followed — read live, so a 15-minute wait sees the booking the setter made after hanging up
      kind: r.raw.kind === "phone" ? "phone" : "meeting", direction: r.raw.direction, status: r.raw.call_status, connected: r.raw.call_status === "connected", duration_sec: r.raw.duration_sec ?? (r.duration_min != null ? r.duration_min * 60 : undefined),
      caller: r.closer_name ? { name: r.closer_name, first_name: r.closer_name.split(" ")[0], ghl_user_id: r.closer_ghl } : undefined,
      led_to_booking: r.contact_id ? !!(await one(c, "select 1 from appointments where company_id=$1 and contact_id=$2 and status<>'cancelled' and booked_at >= $3 limit 1", [r.company_id, r.contact_id, r.started_at])) : false };
  }
  if (run.appointment_id) {
    const a = await one<Record<string, unknown>>(c, `
      select a.id, a.source, a.external_id, coalesce(a.slot_key, a.external_id) as slot_key, a.starts_at, a.ends_at, a.status, a.self_booked, a.set_by, a.answers, a.reschedule_url, a.cancel_url, a.tracking, a.cancelled_by, a.cancel_reason, a.pending_read,
             json_build_object('name', t.name, 'category', t.category) as term,
             json_build_object('id', u.id, 'first_name', split_part(u.name,' ',1), 'name', u.name, 'email', u.email, 'ghl_user_id', u.ghl_user_id, 'slack_user_id', u.slack_user_id, 'mention', coalesce('<@' || u.slack_user_id || '>', u.name)) as closer,
             ot.category as outcome, cot.category as call_outcome
      from appointments a left join company_terms t on t.id=a.appointment_term left join users u on u.id=a.assigned_user_id
           left join company_terms ot on ot.id=a.outcome_term left join company_terms cot on cot.id=a.call_outcome_term
      where a.id=$1`, [run.appointment_id]);
    if (a) ctx.appointment = { ...a, starts_at: (a.starts_at as Date).toISOString(), ends_at: (a.ends_at as Date).toISOString() };
  }
  if (run.opportunity_id) ctx.opportunity = await one(c, "select id, status, contract_value, opened_at from opportunities where id=$1", [run.opportunity_id]);
  // the contact's open card on each bound board: crm.pipeline_closer = <id> → cards.closer = { id (CRM), stage, name }
  const cards: Record<string, unknown> = {};
  for (const [k, pid] of Object.entries(bindings)) if (k.startsWith("crm.pipeline_")) {
    const card = await one<{ ghl_opportunity_id: string | null; ghl_stage_id: string; name: string; owner_name: string | null; owner_ghl: string | null }>(c, "select p.ghl_opportunity_id, p.ghl_stage_id, p.name, u.name as owner_name, u.ghl_user_id as owner_ghl from pipeline_cards p left join users u on u.id=p.assigned_user_id where p.company_id=$1 and p.contact_id=$2 and p.ghl_pipeline_id=$3 and p.status='open' order by p.created_at desc limit 1", [company.id, run.contact_id, pid]);
    cards[k.slice("crm.pipeline_".length)] = card ? { id: card.ghl_opportunity_id ?? "", stage: card.ghl_stage_id, name: card.name, owner: card.owner_name ? { name: card.owner_name, first_name: card.owner_name.split(" ")[0], ghl_user_id: card.owner_ghl } : undefined } : undefined;
  }
  ctx.cards = cards;
  if (run.contact_id) {
    // D30 facts the agreement and close flows check: has this person paid, have they signed, who owns them in the CRM, and the latest CRM record of each object we wrote for them
    // cash collected is net of refund lines (D57), as the running total Payment recorded writes to the contact is
    const pay = await one<{ n: number; total: string; first_at: Date | null }>(c, "select count(*) filter (where status='succeeded')::int as n, coalesce(sum(amount) filter (where status in ('succeeded','refunded')),0)::text as total, min(paid_at) filter (where status='succeeded') as first_at from payments where company_id=$1 and contact_id=$2", [company.id, run.contact_id]);
    const agr: AgreementRow | null = (await latestAgreement(c, company.id, run.contact_id)) ?? null;
    const ownerGhl = (contact?.assigned_ghl_user_id as string | null) ?? bindings["crm.default_closer"] ?? null;
    const owner = ownerGhl ? await one<{ id: string; name: string; email: string; ghl_user_id: string; slack_user_id: string | null }>(c, "select id, name, email, ghl_user_id, slack_user_id from users where company_id=$1 and ghl_user_id=$2", [company.id, ownerGhl]) : null;
    const recs = await many<{ object_key: string; record_key: string; ghl_record_id: string | null }>(c, "select distinct on (object_key) object_key, record_key, ghl_record_id from crm_records where company_id=$1 and contact_id=$2 order by object_key, updated_at desc", [company.id, run.contact_id]);
    // who the closer is, one answer for every post: the open closer card's owner, else whoever owns the contact in the CRM
    const closerCard = bindings["crm.pipeline_closer"] ? await one<{ id: string; name: string; email: string; ghl_user_id: string; slack_user_id: string | null }>(c, "select u.id, u.name, u.email, u.ghl_user_id, u.slack_user_id from pipeline_cards p join users u on u.id=p.assigned_user_id where p.company_id=$1 and p.contact_id=$2 and p.ghl_pipeline_id=$3 and p.status in ('open','won') order by (p.status='open') desc, p.created_at desc limit 1", [company.id, run.contact_id, bindings["crm.pipeline_closer"]]) : null;
    const closer = closerCard ?? owner;
    // the setter is a name the team typed on the contact (crm.field_contact_setter); a team member of exactly that name can be @mentioned
    const setterName = typeof fields.setter === "string" ? fields.setter.trim() : "";
    const setterUser = setterName ? await one<{ name: string; email: string; ghl_user_id: string; slack_user_id: string | null }>(c, "select name, email, ghl_user_id, slack_user_id from users where company_id=$1 and lower(name)=lower($2) limit 1", [company.id, setterName]) : null;
    const firstBooking = await one<{ at: Date | null }>(c, "select min(starts_at) as at from appointments where company_id=$1 and contact_id=$2 and status<>'cancelled'", [company.id, run.contact_id]);
    const firstBookedAt = firstBooking?.at ?? null, firstPaidAt = pay?.first_at ?? null;
    // D44: a payment or a no-show lands as a reaction on the person's booking post and call review; these name which
    const latestAppt = await one<{ id: string }>(c, "select id from appointments where company_id=$1 and contact_id=$2 and status<>'cancelled' order by starts_at desc limit 1", [company.id, run.contact_id]);
    const latestRec = await one<{ id: string }>(c, "select id from recordings where company_id=$1 and contact_id=$2 order by started_at desc limit 1", [company.id, run.contact_id]);
    // a live closing call still ahead of them, other than the one this run is about: what a nudge to book (or rebook) checks before it goes
    const upcoming = await one(c, `select 1 from appointments a join company_terms t on t.id=a.appointment_term where a.company_id=$1 and a.contact_id=$2 and t.category='closing'
      and a.status not in ('cancelled','noshow') and a.starts_at > now() and ($3::uuid is null or a.id <> $3) limit 1`, [company.id, run.contact_id, run.appointment_id ?? null]);
    const daysToClose = firstBookedAt && firstPaidAt ? Math.max(0, Math.round((firstPaidAt.getTime() - firstBookedAt.getTime()) / 86_400_000)) : undefined;
    // what the deal is worth: the contact's opportunity (open first, else won), falling back to the program price
    const opp = await one<{ v: string | null }>(c, "select coalesce(o.contract_value, co.contract_value_default)::text as v from opportunities o join companies co on co.id=o.company_id where o.company_id=$1 and o.contact_id=$2 and o.status in ('open','won') order by (o.status='open') desc, o.opened_at desc limit 1", [company.id, run.contact_id]);
    const revenue = opp?.v != null ? Number(opp.v) : undefined;
    const person = (u: { name: string; email: string; ghl_user_id: string; slack_user_id: string | null }) => ({ name: u.name, first_name: u.name.split(" ")[0], email: u.email, ghl_user_id: u.ghl_user_id, slack_user_id: u.slack_user_id, mention: u.slack_user_id ? `<@${u.slack_user_id}>` : u.name });
    ctx.contact = { ...(ctx.contact as Record<string, unknown> ?? {}), paid: (pay?.n ?? 0) > 0, payments_count: pay?.n ?? 0, cash_collected: Number(pay?.total ?? 0), first_paid_at: firstPaidAt?.toISOString() ?? null,
      agreement_signed: !!agr?.signed_at, agreement_sent: !!agr, owner: owner ? { ...person(owner), inherited: !contact?.assigned_ghl_user_id } : undefined,
      closer: closer ? { ...person(closer), from: closerCard ? "closer card" : "contact owner" } : undefined,
      setter: setterName ? (setterUser ? person(setterUser) : { name: setterName, first_name: setterName.split(" ")[0], mention: setterName }) : undefined,
      first_booked_at: firstBookedAt?.toISOString() ?? undefined, days_to_close: daysToClose, revenue, latest_appointment_id: latestAppt?.id, latest_recording_id: latestRec?.id, has_upcoming_call: !!upcoming,
      source: typeof fields.lead_source === "string" && fields.lead_source ? fields.lead_source : undefined,
      // D68: the CRM's copy as of this read; `stale` says why the engine's copy stood in instead (the CRM did not answer)
      fetched_at: truth?.ok && truth.fresh ? truth.fetched_at : undefined, stale: truth?.ok && !truth.fresh ? truth.why : undefined };
    ctx.agreement = agr ? agreementFacts(agr) : {};
    ctx.records = Object.fromEntries(recs.map((r) => [r.object_key.replace(/^custom_objects\./, ""), { key: r.record_key, id: r.ghl_record_id ?? "" }]));
  }
  // a run about a person on the team (a closer's end-of-day, a report filed): who they are, their standing link, and their end-of-day facts
  if (run.user_id) {
    const u = await one<{ id: string; name: string; email: string; role: string; ghl_user_id: string | null; slack_user_id: string | null; report_token: string | null }>(c, "select id, name, email, role, ghl_user_id, slack_user_id, report_token from users where id=$1 and company_id=$2", [run.user_id, company.id]);
    if (u) {
      const base = (process.env.PUBLIC_URL ?? process.env.TICK_URL ?? "").replace(/\/$/, "");
      ctx.user = { id: u.id, name: u.name, first_name: u.name.split(" ")[0], email: u.email, role: u.role, ghl_user_id: u.ghl_user_id, slack_user_id: u.slack_user_id, mention: u.slack_user_id ? `<@${u.slack_user_id}>` : u.name,
        report_url: u.report_token ? `${base}/eod/${u.report_token}` : undefined, eod: await eodFacts(c, company, u.id, base) };
    }
  }
  for (const [k, v] of Object.entries(bindings)) {
    if (k.startsWith("secret.")) continue;
    if (k.startsWith("calendar.")) {
      const key = k.slice("calendar.".length);
      const cal = await one<{ name: string; booking_url: string | null }>(c, "select name, booking_url from calendars where company_id=$1 and external_id=$2", [company.id, v]);
      (ctx.calendar as Record<string, unknown>)[key] = { id: v, name: cal?.name, url: bindings[`${k}.url`] ?? cal?.booking_url ?? `https://api.leadconnectorhq.com/widget/booking/${v}` };
    } else if (k.startsWith("slack.channel.")) ((ctx.slack as { channel: Record<string, string> }).channel)[k.slice("slack.channel.".length)] = v;
    else if (k.startsWith("crm.")) (ctx.crm as Record<string, string>)[k.slice(4)] = v;
    else if (k.startsWith("prompt.")) (ctx.prompt as Record<string, string>)[k.slice(7)] = v;
  }
  return ctx;
}
