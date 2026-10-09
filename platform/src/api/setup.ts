import { loadSettings } from "./setup-data";
import { groupOf, type SettingRow } from "@/engine/settings";
import type { CompanyHead } from "./data";

/**
 * The Setup page: everything the company's workflows need, read-only (D42). Secrets never leave the server: a secret
 * row says whether it is set and its last characters. Ids are shown with the name the CRM gives them when the CRM
 * is reachable. Changing any of it is still the CLI's and the install API's job.
 */
const LABELS: Record<string, string> = {
  "secret.ghl_pit": "GoHighLevel private integration token", "crm.location_id": "GoHighLevel location", "secret.anthropic_key": "Anthropic API key", "secret.whop_api_key": "Whop API key", "secret.whop_webhook": "Whop webhook secret",
  "secret.fathom_api_key": "Fathom API key", "secret.fathom_webhook": "Fathom webhook secret", "secret.calendly_token": "Calendly token", "secret.slack_signing": "Slack signing secret (reactions door)", "secret.resend_key": "Resend API key (alert email)", "secret.zapier_inbound": "Zapier door secret",
  "alerts.slack_channel": "Alerts to Slack", "alerts.email": "Alerts by email", "alerts.email_from": "Alert email from", "alerts.webhook": "Alerts to a webhook", "alerts.as_name": "Alerts post as", "alerts.as_icon": "Alert icon",
  "booking.setter_rule": "Setter rule", "crm.default_closer": "Default closer", "calendly.phone_question": "Calendly phone question", "calendly.setter_question": "Calendly setter question", "calendly.user": "Calendly host", "calendly.organization": "Calendly organization",
  "calendar.closer_call": "The closer call", "calendar.booking": "The booking link we send",
};
const humanKey = (k: string) => LABELS[k] ?? k.replace(/^(crm\.|slack\.channel\.|prompt\.|calendar\.|alerts\.|calendly\.|booking\.)/, "").replace(/_/g, " ");

export type SetupRow = { key: string; label: string; set: boolean; value: string | null; name?: string | null; required: boolean; used_by: string[] };
export async function setupPage(co: CompanyHead) {
  const d = await loadSettings(co.slug);
  if (!d) return null;
  const cat = d.catalog;
  const nameOf = (r: SettingRow): string | null => {
    if (!r.value) return null;
    const g = groupOf(r.key);
    if (g === "pipelines") return cat?.pipelines.find((p) => p.id === r.value)?.name ?? null;
    if (g === "stages") { for (const p of cat?.pipelines ?? []) { const s = p.stages.find((x) => x.id === r.value); if (s) return `${p.name} › ${s.name}`; } return null; }
    if (g === "contact_fields") return cat?.contactFields.find((f) => f.id === r.value)?.name ?? null;
    if (g === "opportunity_fields") return cat?.opportunityFields.find((f) => f.id === r.value)?.name ?? null;
    if (g === "associations") return cat?.associations.find((a) => a.id === r.value)?.label ?? null;
    if (g === "calendars") return d.calendars.find((c) => c.external_id === r.value)?.name ?? d.liveCalendars.find((c) => c.id === r.value)?.name ?? null;
    if (g === "slack") return d.slackChannels?.find((ch) => ch.id === r.value)?.name ? `#${d.slackChannels.find((ch) => ch.id === r.value)!.name}` : null;
    if (r.key === "crm.default_closer" || r.key === "calendly.user") return d.users.find((u) => u.ghl_user_id === r.value)?.name ?? cat?.users.find((u) => u.id === r.value)?.name ?? null;
    return null;
  };
  const row = (r: SettingRow): SetupRow => ({ key: r.key, label: humanKey(r.key), set: r.set, value: r.kind === "secret" ? r.masked : r.value, name: nameOf(r), required: r.required, used_by: r.usedBy });
  const rows = d.rows.map(row);
  const by = (g: ReturnType<typeof groupOf>) => d.rows.filter((r) => groupOf(r.key) === g).map(row);
  const one = (k: string) => rows.find((r) => r.key === k);
  const crmGroups = (["pipelines", "stages", "contact_fields", "opportunity_fields", "associations"] as const).map((g) => ({ group: g.replace(/_/g, " "), rows: by(g) })).filter((g) => g.rows.length);
  const calendars = d.calendars.map((c) => { const l = d.liveCalendars.find((x) => x.id === c.external_id); return {
    id: c.external_id, name: c.name, call_type: c.term_name, active: c.active, url: c.booking_url, hosts: (l?.hosts ?? []).map((h) => h.name || h.email),
    booking: c.config.booking ?? (c.self_booked === true ? "self" : c.self_booked === false ? "setter" : "company"),
    role: one("calendar.closer_call")?.value === c.external_id ? "the closer call" : one("calendar.booking")?.value === c.external_id ? "the booking link we send" : null,
    questions: Object.entries(c.config.questions ?? {}).map(([use, text]) => ({ use, text })) }; });
  const unmapped = d.liveCalendars.filter((l) => !d.calendars.some((c) => c.external_id === l.id)).map((l) => ({ id: l.id, name: l.name, hosts: (l.hosts ?? []).map((h) => h.name || h.email) }));
  return {
    company: co,
    readiness: { ready: d.readiness.ready, issues: d.readiness.issues.map((i) => ({ level: i.level, text: i.text, href: i.href ?? null })) },
    settings: { name: d.company.name, timezone: d.company.timezone, mode: d.company.mode, sms_enabled: d.company.sms_enabled, send_window: `${d.company.send_window_start.slice(0, 5)}–${d.company.send_window_end.slice(0, 5)}`, quiet_allow_transactional: d.company.quiet_allow_transactional, contract_value_default: d.company.contract_value_default, reached_seconds: d.company.reached_seconds },
    team: d.users.map((u) => ({ id: u.id, name: u.name, email: u.email, role: u.role, calls: u.calls, in_crm: !!u.ghl_user_id })),
    eod_form: d.eodForm.map((f) => ({ key: f.key, label: f.label, type: f.type, required: !!f.required, scope: f.scope ?? "call", when: f.when ?? null, builtin: !!f.builtin, options: f.options ?? null })),
    connections: ["crm.location_id", "secret.ghl_pit", "secret.anthropic_key", "secret.whop_api_key", "secret.whop_webhook", "secret.fathom_api_key", "secret.fathom_webhook", "secret.calendly_token", "secret.slack_signing", "secret.resend_key"].map((k) => one(k) ?? { key: k, label: humanKey(k), set: false, value: null, name: null, required: false, used_by: [] }),
    catalog_errors: cat?.errors ?? [],
    booking: { source: d.bookingSource, setter_rule: one("booking.setter_rule")?.value ?? null, default_closer: one("crm.default_closer")?.name ?? one("crm.default_closer")?.value ?? null, phone_question: one("calendly.phone_question")?.value ?? null, setter_question: one("calendly.setter_question")?.value ?? null },
    call_types: d.terms.map((t) => ({ name: t.name, category: t.category, active: t.active, in_use: t.in_use })),
    calendars, unmapped_calendars: unmapped, calendars_error: d.liveCalendarsError,
    crm: crmGroups,
    slack: { connected: !!d.slack, team_id: d.slack?.team_id ?? null, channels: by("slack") },
    alerts: ["alerts.slack_channel", "alerts.email", "alerts.email_from", "alerts.webhook", "alerts.as_name", "alerts.as_icon"].map((k) => one(k)).filter((r): r is SetupRow => !!r),
    prompts: by("prompts").map((r) => ({ key: r.key, label: humanKey(r.key), used_by: r.used_by, text: r.value ?? "" })),
    scheduled: d.scheduled,
    inbound: { whop: d.inbound.whop, fathom: d.inbound.fathom, zapier_payment: d.inbound.zapierPayment, zapier_recording: d.inbound.zapierRecording, zapier_secret: d.inbound.secret ? `set · ends with ${d.inbound.secret.slice(-4)}` : null, fathom_webhook_id: d.inbound.fathomWebhookId },
  };
}
export type SetupPage = NonNullable<Awaited<ReturnType<typeof setupPage>>>;
