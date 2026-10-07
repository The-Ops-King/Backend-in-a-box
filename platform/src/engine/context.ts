import type { PoolClient } from "pg";
import { many, one } from "@/db/client";
import { decrypt } from "./crypto";
import type { BookingConfig, Company } from "@/adapters/types";
import { transcriptText, type RecordingRow } from "./recordings";

export type RunRow = { id: string; company_id: string; workflow_id: string; workflow_version: number; contact_id: string; opportunity_id: string | null; appointment_id: string | null; status: string; current_node: string | null; next_run_at: Date | null; context: Record<string, unknown>; reentry_key: string; started_at?: Date };
export type CompanyRow = { id: string; name: string; slug: string; timezone: string; send_window_start: string; send_window_end: string; status: string; sms_enabled: boolean; mode: "shadow" | "live" };

export async function loadCompany(c: PoolClient, companyId: string): Promise<{ row: CompanyRow; adapterCompany: Company; bindings: Record<string, string> }> {
  const row = await one<CompanyRow>(c, "select * from companies where id=$1", [companyId]);
  if (!row) throw new Error(`company ${companyId} not found`);
  const rows = await many<{ key: string; kind: string; value: Buffer }>(c, "select key, kind, value from bindings where company_id=$1", [companyId]);
  const bindings: Record<string, string> = {};
  for (const b of rows) bindings[b.key] = b.kind === "secret" ? decrypt(b.value) : b.value.toString("utf8");
  const booking: BookingConfig = bindings["secret.calendly_token"]
    ? { source: "calendly", token: bindings["secret.calendly_token"], organization: bindings["calendly.organization"] ?? "", user: bindings["calendly.user"] || undefined, phoneQuestion: bindings["calendly.phone_question"] || undefined, setterQuestion: bindings["calendly.setter_question"] || undefined }
    : { source: "ghl" };
  const adapterCompany: Company = { id: row.id, locationId: bindings["crm.location_id"] ?? "", pit: bindings["secret.ghl_pit"] ?? "", timezone: row.timezone, booking };
  return { row, adapterCompany, bindings };
}

/** Builds what `{{…}}` resolves against. Secrets are never placed in the context. */
export async function buildContext(c: PoolClient, run: RunRow, company: CompanyRow, bindings: Record<string, string>): Promise<Record<string, unknown>> {
  const contact = await one<Record<string, unknown>>(c, `select ct.id, ct.ghl_contact_id, ct.first_name, ct.last_name, nullif(trim(coalesce(ct.first_name,'')||' '||coalesce(ct.last_name,'')),'') as name, ct.timezone, ct.tags, ct.attributes, ct.ghl_fields,
      (select value from contact_identifiers i where i.contact_id=ct.id and i.kind='phone' limit 1) as phone,
      (select value from contact_identifiers i where i.contact_id=ct.id and i.kind='email' limit 1) as email
    from contacts ct where ct.id=$1`, [run.contact_id]);
  // D13: the reply the run is reacting to is whatever the contact last sent after this run started; what we last sent is the classifier's state.
  const lastIn = await one<{ body: string | null; occurred_at: Date }>(c, "select body, occurred_at from messages where company_id=$1 and contact_id=$2 and direction='inbound' and occurred_at >= $3 order by occurred_at desc limit 1", [company.id, run.contact_id, run.started_at ?? new Date(0)]);
  const lastOut = await one<{ rendered_body: string; sent_at: Date }>(c, "select rendered_body, sent_at from sends where company_id=$1 and contact_id=$2 and status='sent' order by sent_at desc limit 1", [company.id, run.contact_id]);
  const derivedReply: Record<string, unknown> = {
    last_inbound: lastIn ? { body: lastIn.body, at: lastIn.occurred_at.toISOString() } : undefined,
    last_outbound: lastOut ? { body: lastOut.rendered_body, at: lastOut.sent_at?.toISOString() } : undefined,
  };
  // CRM custom fields by the name the company bound them under: crm.field_contact_hair_loss = <id> → contact.fields.hair_loss
  const fields: Record<string, unknown> = {};
  const raw = (contact?.ghl_fields ?? {}) as Record<string, unknown>;
  for (const [k, id] of Object.entries(bindings)) if (k.startsWith("crm.field_contact_")) { const v = raw[id]; fields[k.slice("crm.field_contact_".length)] = Array.isArray(v) ? v.join(", ") : v ?? undefined; }
  const ctx: Record<string, unknown> = {
    company: { id: company.id, name: company.name, timezone: company.timezone },
    contact: contact ? { ...contact, ghl_fields: undefined, fields, timezone: contact.timezone ?? company.timezone } : undefined,
    vars: (run.context.vars as Record<string, unknown>) ?? {},
    reply: { ...((run.context.reply as Record<string, unknown>) ?? {}), ...derivedReply },   // last_inbound/last_outbound are re-derived every tick; intent/confidence from classify persist
    event: run.context.event ?? {},
    calendar: {}, slack: { channel: {} }, crm: {}, prompt: {},
  };
  // the recording a run was started by (recording.received) — read from the ledger every tick, never copied into the run's context
  const recId = (run.context.event as { recording_id?: string } | undefined)?.recording_id;
  if (recId) {
    const r = await one<RecordingRow & { closer_name: string | null; closer_ghl: string | null }>(c, "select r.*, u.name as closer_name, u.ghl_user_id as closer_ghl from recordings r left join users u on u.company_id=r.company_id and lower(u.email)=r.recorded_by_email where r.id=$1", [recId]);
    if (r) ctx.recording = { id: r.id, provider: r.provider, external_id: r.external_id, title: r.title, started_at: r.started_at.toISOString(), ended_at: r.ended_at?.toISOString(), duration_min: r.duration_min, url: r.url, share_url: r.share_url,
      recorded_by: { name: r.recorded_by_name, email: r.recorded_by_email }, closer: r.closer_name ? { name: r.closer_name, first_name: r.closer_name.split(" ")[0], ghl_user_id: r.closer_ghl } : undefined,
      invitees: r.invitees, invitee_names: r.invitees.map((i) => i.name).filter(Boolean).join(", "), transcript_text: transcriptText(r.transcript), has_transcript: !!r.transcript?.length, summary: r.summary, matched_by: r.linked_by, analysis: r.analysis };
  }
  if (run.appointment_id) {
    const a = await one<Record<string, unknown>>(c, `
      select a.id, a.source, a.external_id, a.starts_at, a.ends_at, a.status, a.self_booked, a.set_by, a.reschedule_url, a.cancel_url, a.tracking, a.cancelled_by, a.cancel_reason,
             json_build_object('name', t.name, 'category', t.category) as term,
             json_build_object('id', u.id, 'first_name', split_part(u.name,' ',1), 'name', u.name, 'ghl_user_id', u.ghl_user_id) as closer
      from appointments a left join company_terms t on t.id=a.appointment_term left join users u on u.id=a.assigned_user_id
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
