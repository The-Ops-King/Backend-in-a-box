import type { PoolClient } from "pg";
import { many, one } from "@/db/client";
import { decrypt, encrypt } from "./crypto";
import type { ManifestEntry } from "./definition";
import { parseRubric, rubricFields } from "./score-call";
import { vendorOfBinding, wakePausedOnAuth } from "./failures";

/**
 * The settings screen is driven by what the company's installed workflows need: the union of their manifests, grouped
 * by what kind of thing each key is, with the current value (secrets masked) and whether it is still missing.
 */
export type BindingKind = "secret" | "id" | "text" | "channel" | "number";
export type SettingRow = { key: string; kind: BindingKind; required: boolean; usedBy: string[]; value: string | null; masked: string | null; set: boolean };
export type SettingsGroup = "connections" | "pipelines" | "stages" | "contact_fields" | "opportunity_fields" | "associations" | "calendars" | "slack" | "prompts" | "booking" | "alerts" | "other";

export const groupOf = (key: string): SettingsGroup =>
  key.startsWith("secret.") ? "connections" : key.startsWith("crm.pipeline_") ? "pipelines" : key.startsWith("crm.stage_") ? "stages" : key.startsWith("crm.field_contact_") ? "contact_fields" : key.startsWith("crm.field_opportunity_") ? "opportunity_fields"
  : key.startsWith("crm.assoc_") ? "associations" : key.startsWith("calendar.") ? "calendars" : key.startsWith("slack.channel.") ? "slack" : key.startsWith("prompt.") ? "prompts" : key.startsWith("calendly.") || key.startsWith("booking.") ? "booking" : key.startsWith("alerts.") ? "alerts" : "other";

export const mask = (kind: BindingKind, value: string) => (kind === "secret" ? (value.length > 6 ? `set · ends with ${value.slice(-4)}` : "set") : value);

/** Every binding the installed workflows reference, plus a few the engine itself uses, merged with what is bound. */
export async function settingsRows(c: PoolClient, companyId: string): Promise<SettingRow[]> {
  const wfs = await many<{ name: string; manifest: { bindings: ManifestEntry[] } }>(c, "select w.name, v.manifest from workflows w join workflow_versions v on v.workflow_id=w.id and v.version=w.current_version where w.company_id=$1", [companyId]);
  const need = new Map<string, { kind: BindingKind; required: boolean; usedBy: Set<string> }>();
  const add = (key: string, kind: BindingKind, required: boolean, by?: string) => { const cur = need.get(key) ?? { kind, required: false, usedBy: new Set<string>() }; cur.required = cur.required || required; if (by) cur.usedBy.add(by); need.set(key, cur); };
  for (const w of wfs) for (const b of w.manifest.bindings) add(b.key, b.kind, b.required, w.name);
  // engine-level keys the screen always offers
  for (const [k, kind] of [["agreements.list", "text"], ["crm.location_id", "id"], ["secret.ghl_pit", "secret"], ["test.domains", "text"], ["secret.calendly_token", "secret"], ["calendly.user", "id"], ["calendly.phone_question", "text"], ["calendly.setter_question", "text"], ["booking.setter_rule", "text"], ["crm.default_closer", "id"], ["secret.fathom_api_key", "secret"], ["secret.fathom_webhook", "secret"], ["secret.whop_webhook", "secret"], ["secret.whop_api_key", "secret"], ["whop.webhook_id", "id"], ["slack.name", "text"], ["slack.icon", "text"], ["alerts.slack_channel", "channel"], ["test.slack_channel", "channel"], ["alerts.as_name", "text"], ["alerts.as_icon", "text"], ["alerts.repeat_minutes", "number"], ["alerts.repeat_hours", "text"], ["alerts.repeat_timezone", "text"], ["alerts.poll_failures", "number"], ["secret.anthropic_key", "secret"], ["secret.zapier_inbound", "secret"], ["discovery_call.results", "text"], ["setter_result.act", "text"], ["setter_result.set_within_min", "number"], ["calls.transcript_wait_min", "number"], ["calls.conversation_gap_min", "number"], ["calls.transcript_hold_hours", "number"], ["booking_card.intake", "text"], ["sales_call.objections", "text"], ["sales_call.closer_options", "text"], ["reports.quiet_when_empty", "text"], ["slack.live", "text"], ["crm.tasks", "text"], ["eod.setter_calls", "text"], ["eod.dq_reasons", "text"], ["contacts.match", "text"], ["eod.triage_overdue", "text"], ["bot.escalate_to", "id"], ["brand.name", "text"], ["brand.logo_url", "text"], ["brand.accent", "text"], ["payments.unmatched_failures", "text"], ["payments.full_prices", "text"], ["payments.price_slack", "number"], ["payments.deposit_under", "number"], ["payments.deposit_words", "text"], ["payments.full_reasons", "text"]] as const) add(k, kind, k === "crm.location_id" || k === "secret.ghl_pit");
  const bound = await many<{ key: string; kind: BindingKind; value: Buffer }>(c, "select key, kind, value from bindings where company_id=$1", [companyId]);
  const have = new Map(bound.map((b) => [b.key, b]));
  // D272: a call rubric names the contact fields it reads (the form's answers); each is a setting the offer binds to its GHL field
  for (const b of bound) {
    if (!b.key.startsWith("prompt.") || b.kind === "secret") continue;
    const r = parseRubric(b.value.toString("utf8")); if (!r.ok) continue;
    const used = [...need.entries()].filter(([k]) => k === b.key).flatMap(([, n]) => [...n.usedBy]);
    for (const f of rubricFields(r.rubric)) add(`crm.field_contact_${f}`, "id", true, used[0] ?? b.key);
  }
  for (const b of bound) if (!need.has(b.key)) add(b.key, b.kind, false);   // bound but unused: still shown, so nothing is hidden
  return [...need.entries()].map(([key, n]) => { const b = have.get(key); const value = b ? (b.kind === "secret" ? decrypt(b.value) : b.value.toString("utf8")) : null; return { key, kind: n.kind, required: n.required, usedBy: [...n.usedBy].sort(), value: b && b.kind !== "secret" ? value : null, masked: value ? mask(b!.kind, value) : null, set: !!value }; }).sort((a, b) => a.key.localeCompare(b.key));
}

export async function setBinding(c: PoolClient, companyId: string, key: string, kind: BindingKind, value: string, by = "settings"): Promise<void> {
  const prior = await one<{ kind: string; value: Buffer }>(c, "select kind, value from bindings where company_id=$1 and key=$2", [companyId, key]);
  await c.query(`insert into bindings (company_id, key, kind, value) values ($1,$2,$3,$4) on conflict (company_id, key) do update set kind=excluded.kind, value=excluded.value, updated_at=now()`, [companyId, key, kind, kind === "secret" ? encrypt(value) : Buffer.from(value)]);
  await c.query("insert into audit_log (company_id, action, target_type, target_id, before, after) values ($1,'binding.set','binding',$2,$3,$4)", [companyId, key, { set: !!prior }, { kind, value: kind === "secret" ? mask("secret", value) : value, by }]);
  // D66: a NEW token gives every run paused on that vendor's auth one more try of its step; the same value again wakes nothing
  const vendor = vendorOfBinding(key);
  if (vendor && prior && (prior.kind === "secret" ? decrypt(prior.value) : prior.value.toString("utf8")) !== value) await wakePausedOnAuth(c, companyId, vendor);
}
