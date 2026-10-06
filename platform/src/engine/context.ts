import type { PoolClient } from "pg";
import { many, one } from "@/db/client";
import { decrypt } from "./crypto";
import type { Company } from "@/adapters/types";

export type RunRow = { id: string; company_id: string; workflow_id: string; workflow_version: number; contact_id: string; opportunity_id: string | null; appointment_id: string | null; status: string; current_node: string | null; next_run_at: Date | null; context: Record<string, unknown>; reentry_key: string; started_at?: Date };
export type CompanyRow = { id: string; name: string; slug: string; timezone: string; send_window_start: string; send_window_end: string; status: string; sms_enabled: boolean; mode: "shadow" | "live" };

export async function loadCompany(c: PoolClient, companyId: string): Promise<{ row: CompanyRow; adapterCompany: Company; bindings: Record<string, string> }> {
  const row = await one<CompanyRow>(c, "select * from companies where id=$1", [companyId]);
  if (!row) throw new Error(`company ${companyId} not found`);
  const rows = await many<{ key: string; kind: string; value: Buffer }>(c, "select key, kind, value from bindings where company_id=$1", [companyId]);
  const bindings: Record<string, string> = {};
  for (const b of rows) bindings[b.key] = b.kind === "secret" ? decrypt(b.value) : b.value.toString("utf8");
  const adapterCompany: Company = { id: row.id, locationId: bindings["crm.location_id"] ?? "", pit: bindings["secret.ghl_pit"] ?? "", timezone: row.timezone };
  return { row, adapterCompany, bindings };
}

/** Builds what `{{…}}` resolves against. Secrets are never placed in the context. */
export async function buildContext(c: PoolClient, run: RunRow, company: CompanyRow, bindings: Record<string, string>): Promise<Record<string, unknown>> {
  const contact = await one<Record<string, unknown>>(c, "select id, ghl_contact_id, first_name, last_name, timezone, tags, attributes from contacts where id=$1", [run.contact_id]);
  // D13: the reply the run is reacting to is whatever the contact last sent after this run started; what we last sent is the classifier's state.
  const lastIn = await one<{ body: string | null; occurred_at: Date }>(c, "select body, occurred_at from messages where company_id=$1 and contact_id=$2 and direction='inbound' and occurred_at >= $3 order by occurred_at desc limit 1", [company.id, run.contact_id, run.started_at ?? new Date(0)]);
  const lastOut = await one<{ rendered_body: string; sent_at: Date }>(c, "select rendered_body, sent_at from sends where company_id=$1 and contact_id=$2 and status='sent' order by sent_at desc limit 1", [company.id, run.contact_id]);
  const derivedReply: Record<string, unknown> = {
    last_inbound: lastIn ? { body: lastIn.body, at: lastIn.occurred_at.toISOString() } : undefined,
    last_outbound: lastOut ? { body: lastOut.rendered_body, at: lastOut.sent_at?.toISOString() } : undefined,
  };
  const ctx: Record<string, unknown> = {
    company: { id: company.id, name: company.name, timezone: company.timezone },
    contact: contact ? { ...contact, timezone: contact.timezone ?? company.timezone } : undefined,
    vars: (run.context.vars as Record<string, unknown>) ?? {},
    reply: { ...derivedReply, ...((run.context.reply as Record<string, unknown>) ?? {}) },
    event: run.context.event ?? {},
    calendar: {}, slack: { channel: {} }, crm: {},
  };
  if (run.appointment_id) {
    const a = await one<Record<string, unknown>>(c, `
      select a.id, a.ghl_appointment_id, a.starts_at, a.ends_at, a.ghl_status, a.self_booked,
             json_build_object('name', t.name, 'category', t.category) as term,
             json_build_object('id', u.id, 'first_name', split_part(u.name,' ',1), 'name', u.name, 'ghl_user_id', u.ghl_user_id) as closer
      from appointments a left join company_terms t on t.id=a.appointment_term left join users u on u.id=a.assigned_user_id
      where a.id=$1`, [run.appointment_id]);
    if (a) ctx.appointment = { ...a, starts_at: (a.starts_at as Date).toISOString(), ends_at: (a.ends_at as Date).toISOString() };
  }
  if (run.opportunity_id) ctx.opportunity = await one(c, "select id, status, contract_value, opened_at from opportunities where id=$1", [run.opportunity_id]);
  for (const [k, v] of Object.entries(bindings)) {
    if (k.startsWith("secret.")) continue;
    if (k.startsWith("calendar.")) {
      const key = k.slice("calendar.".length);
      const cal = await one<{ ghl_calendar_id: string; name: string }>(c, "select ghl_calendar_id, name from calendars where company_id=$1 and ghl_calendar_id=$2", [company.id, v]);
      (ctx.calendar as Record<string, unknown>)[key] = { id: v, name: cal?.name, url: bindings[`${k}.url`] ?? `https://api.leadconnectorhq.com/widget/booking/${v}` };
    } else if (k.startsWith("slack.channel.")) ((ctx.slack as { channel: Record<string, string> }).channel)[k.slice("slack.channel.".length)] = v;
    else if (k.startsWith("crm.")) (ctx.crm as Record<string, string>)[k.slice(4)] = v;
  }
  return ctx;
}
