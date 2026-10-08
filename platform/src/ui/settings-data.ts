import { asOperator, many, one } from "@/db/client";
import { loadCompany } from "@/engine/context";
import { settingsRows, type SettingRow } from "@/engine/settings";
import { companyReadiness, type Readiness } from "@/engine/readiness";
import { liveAdapters } from "@/adapters";
import { bookingFor, type CalendarSnapshot } from "@/adapters/types";
import { ghlCatalog, type Catalog } from "@/adapters/ghl/catalog";
import { loadProposal, type Proposal } from "@/engine/describe-config";
import { decrypt } from "@/engine/crypto";

/** Channels the bot can see, for picking by name; null when the token lacks the scope. */
export async function listSlackChannels(token: string): Promise<{ id: string; name: string }[] | null> {
  try {
    const out: { id: string; name: string }[] = []; let cursor = "";
    for (let i = 0; i < 10; i++) {
      const r = await fetch(`https://slack.com/api/conversations.list?types=public_channel,private_channel&exclude_archived=true&limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, { headers: { Authorization: `Bearer ${token}` } });
      const d = (await r.json()) as { ok: boolean; channels?: { id: string; name: string }[]; response_metadata?: { next_cursor?: string } };
      if (!d.ok) return null;
      out.push(...(d.channels ?? []).map((ch) => ({ id: ch.id, name: ch.name })));
      cursor = d.response_metadata?.next_cursor ?? ""; if (!cursor) break;
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  } catch { return null; }
}

export type CalendarRow = { external_id: string; name: string; appointment_term: string; term_name: string; self_booked: boolean | null; config: { booking?: string; questions?: Record<string, string> }; active: boolean; booking_url: string | null; source: string };
export type SettingsData = {
  company: { id: string; name: string; slug: string; timezone: string; mode: string; sms_enabled: boolean; send_window_start: string; send_window_end: string; quiet_allow_transactional: boolean; contract_value_default: string | null; reached_seconds: number; eod_enabled: boolean; eod_at: string };
  rows: SettingRow[]; byKey: Map<string, SettingRow>;
  bookingSource: "ghl" | "calendly";
  calendars: CalendarRow[]; liveCalendars: CalendarSnapshot[]; liveCalendarsError: string | null;
  terms: { id: string; name: string; category: string; active: boolean; is_default: boolean; in_use: number }[];
  slackChannels: { id: string; name: string }[] | null;
  users: { id: string; name: string; email: string; ghl_user_id: string | null }[];
  catalog: Catalog | null;
  slack: { team_id: string; connected_at: Date } | null;
  readiness: Readiness;
  proposal: { text: string; proposal: Proposal; at: string } | null;
  inbound: { secret: string | null; whop: string; fathom: string; zapierPayment: string; zapierRecording: string; fathomWebhookId: string | null };
};

export async function loadSettings(slug: string): Promise<SettingsData | null> {
  return asOperator(async (c) => {
    const co = await one<SettingsData["company"]>(c, "select id, name, slug, timezone, mode, sms_enabled, send_window_start, send_window_end, quiet_allow_transactional, contract_value_default, reached_seconds, eod_enabled, eod_at::text as eod_at from companies where slug=$1", [slug]);
    if (!co) return null;
    const { adapterCompany, bindings } = await loadCompany(c, co.id);
    const rows = await settingsRows(c, co.id);
    const calendars = await many<CalendarRow>(c, "select cal.external_id, cal.name, cal.appointment_term, t.name as term_name, cal.self_booked, cal.config, cal.active, cal.booking_url, cal.source from calendars cal join company_terms t on t.id=cal.appointment_term where cal.company_id=$1 order by cal.active desc, cal.name", [co.id]);
    const terms = await many<{ id: string; name: string; category: string; active: boolean; is_default: boolean; in_use: number }>(c, "select t.id, t.name, t.category, t.active, t.is_default, (select count(*) from calendars cal where cal.appointment_term=t.id)::int as in_use from company_terms t where t.company_id=$1 and t.domain='appointment_type' order by t.sort, t.name", [co.id]);
    const users = await many<{ id: string; name: string; email: string; ghl_user_id: string | null }>(c, "select id, name, email, ghl_user_id from users where company_id=$1 and active order by name", [co.id]);
    const slack = (await one<{ team_id: string; connected_at: Date }>(c, "select team_id, connected_at from slack_connections where company_id=$1", [co.id])) ?? null;
    let slackChannels: { id: string; name: string }[] | null = null;
    if (slack) { const tok = await one<{ bot_token: Buffer }>(c, "select bot_token from slack_connections where company_id=$1", [co.id]); slackChannels = await listSlackChannels(decrypt(tok!.bot_token)); }
    const readiness = await companyReadiness(c, co.id, `/c/${slug}`);
    const proposal = (await loadProposal(c, co.id))?.value ?? null;
    let liveCalendars: CalendarSnapshot[] = [], liveCalendarsError: string | null = null, catalog: Catalog | null = null;
    const connected = !!adapterCompany.pit && !!adapterCompany.locationId;
    const canListCalendars = adapterCompany.booking.source === "calendly" ? !!bindings["secret.calendly_token"] : connected;
    if (canListCalendars) { try { liveCalendars = await bookingFor(liveAdapters, adapterCompany).listCalendars(adapterCompany); } catch (e) { liveCalendarsError = String((e as Error).message).slice(0, 200); } }
    if (connected) catalog = await ghlCatalog(adapterCompany.pit, adapterCompany.locationId);
    const base = (process.env.PUBLIC_URL ?? process.env.TICK_URL ?? "").replace(/\/$/, "");
    return { company: co, rows, byKey: new Map(rows.map((r) => [r.key, r])), bookingSource: adapterCompany.booking.source, calendars, liveCalendars, liveCalendarsError, terms, users, catalog, slack, slackChannels, readiness, proposal,
      inbound: { secret: bindings["secret.zapier_inbound"] ?? null, whop: `${base}/api/webhooks/whop/${co.id}`, fathom: `${base}/api/webhooks/fathom/${co.id}`, zapierPayment: `${base}/api/webhooks/zapier/${co.id}/payment`, zapierRecording: `${base}/api/webhooks/zapier/${co.id}/recording`, fathomWebhookId: bindings["fathom.webhook_id"] ?? null } };
  });
}

/** What the step pickers on a workflow page need: names for ids, lists to pick from. Cheap when GHL is not connected. */
export type PickerCalendar = { external_id: string; name: string; category: string; term_name: string; self_booked: boolean | null; booking_url: string | null; active: boolean };
export type Pickers = { catalog: Catalog | null; users: { ghl_user_id: string; name: string }[]; slackChannels: { id: string; name: string }[] | null; bindings: Record<string, string>; calendars: PickerCalendar[]; pipelineName: (id: string) => string; stageName: (id: string) => string; userName: (id: string) => string; channelName: (id: string) => string; resolve: (v: string | undefined) => string };
export async function loadPickers(companyId: string): Promise<Pickers> {
  return asOperator(async (c) => {
    const { adapterCompany, bindings } = await loadCompany(c, companyId);
    const users = await many<{ ghl_user_id: string; name: string }>(c, "select ghl_user_id, name from users where company_id=$1 and active and ghl_user_id is not null order by name", [companyId]);
    const calendars = await many<PickerCalendar>(c, "select cal.external_id, cal.name, t.category, t.name as term_name, cal.self_booked, cal.booking_url, cal.active from calendars cal join company_terms t on t.id=cal.appointment_term where cal.company_id=$1 and cal.source=$2 order by cal.name", [companyId, adapterCompany.booking.source]);
    const catalog = adapterCompany.pit && adapterCompany.locationId ? await ghlCatalog(adapterCompany.pit, adapterCompany.locationId) : null;
    const tok = await one<{ bot_token: Buffer }>(c, "select bot_token from slack_connections where company_id=$1", [companyId]);
    const slackChannels = tok ? await listSlackChannels(decrypt(tok.bot_token)) : null;
    const safe = Object.fromEntries(Object.entries(bindings).filter(([k]) => !k.startsWith("secret.")));
    const resolve = (v: string | undefined) => { if (!v) return ""; const m = /^\{\{\s*([a-zA-Z0-9_.]+)/.exec(v); return m ? safe[m[1]] ?? "" : v; };
    const pipelineName = (id: string) => catalog?.pipelines.find((p) => p.id === id)?.name ?? id;
    const stageName = (id: string) => { for (const p of catalog?.pipelines ?? []) { const st = p.stages.find((x) => x.id === id); if (st) return `${p.name} › ${st.name}`; } return id; };
    const userName = (id: string) => users.find((u) => u.ghl_user_id === id)?.name ?? catalog?.users.find((u) => u.id === id)?.name ?? id;
    const channelName = (id: string) => slackChannels?.find((ch) => ch.id === id)?.name ?? id;
    return { catalog, users, slackChannels, bindings: safe, calendars, pipelineName, stageName, userName, channelName, resolve };
  });
}
