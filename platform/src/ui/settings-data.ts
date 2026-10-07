import { asOperator, many, one } from "@/db/client";
import { loadCompany } from "@/engine/context";
import { settingsRows, type SettingRow } from "@/engine/settings";
import { companyReadiness, type Readiness } from "@/engine/readiness";
import { liveAdapters } from "@/adapters";
import { bookingFor, type CalendarSnapshot } from "@/adapters/types";
import { ghlCatalog, type Catalog } from "@/adapters/ghl/catalog";

export type CalendarRow = { external_id: string; name: string; appointment_term: string; term_name: string; self_booked: boolean | null; config: { booking?: string; questions?: Record<string, string> }; active: boolean; booking_url: string | null; source: string };
export type SettingsData = {
  company: { id: string; name: string; slug: string; timezone: string; mode: string; sms_enabled: boolean; send_window_start: string; send_window_end: string; quiet_allow_transactional: boolean; contract_value_default: string | null };
  rows: SettingRow[]; byKey: Map<string, SettingRow>;
  bookingSource: "ghl" | "calendly";
  calendars: CalendarRow[]; liveCalendars: CalendarSnapshot[]; liveCalendarsError: string | null;
  terms: { id: string; name: string; category: string }[];
  users: { id: string; name: string; email: string; ghl_user_id: string | null }[];
  catalog: Catalog | null;
  slack: { team_id: string; connected_at: Date } | null;
  readiness: Readiness;
  inbound: { secret: string | null; whop: string; fathom: string; zapierPayment: string; zapierRecording: string; fathomWebhookId: string | null };
};

export async function loadSettings(slug: string): Promise<SettingsData | null> {
  return asOperator(async (c) => {
    const co = await one<SettingsData["company"]>(c, "select id, name, slug, timezone, mode, sms_enabled, send_window_start, send_window_end, quiet_allow_transactional, contract_value_default from companies where slug=$1", [slug]);
    if (!co) return null;
    const { adapterCompany, bindings } = await loadCompany(c, co.id);
    const rows = await settingsRows(c, co.id);
    const calendars = await many<CalendarRow>(c, "select cal.external_id, cal.name, cal.appointment_term, t.name as term_name, cal.self_booked, cal.config, cal.active, cal.booking_url, cal.source from calendars cal join company_terms t on t.id=cal.appointment_term where cal.company_id=$1 order by cal.active desc, cal.name", [co.id]);
    const terms = await many<{ id: string; name: string; category: string }>(c, "select id, name, category from company_terms where company_id=$1 and domain='appointment_type' and active order by sort", [co.id]);
    const users = await many<{ id: string; name: string; email: string; ghl_user_id: string | null }>(c, "select id, name, email, ghl_user_id from users where company_id=$1 and active order by name", [co.id]);
    const slack = (await one<{ team_id: string; connected_at: Date }>(c, "select team_id, connected_at from slack_connections where company_id=$1", [co.id])) ?? null;
    const readiness = await companyReadiness(c, co.id, `/c/${slug}`);
    let liveCalendars: CalendarSnapshot[] = [], liveCalendarsError: string | null = null, catalog: Catalog | null = null;
    const connected = !!adapterCompany.pit && !!adapterCompany.locationId;
    const canListCalendars = adapterCompany.booking.source === "calendly" ? !!bindings["secret.calendly_token"] : connected;
    if (canListCalendars) { try { liveCalendars = await bookingFor(liveAdapters, adapterCompany).listCalendars(adapterCompany); } catch (e) { liveCalendarsError = String((e as Error).message).slice(0, 200); } }
    if (connected) catalog = await ghlCatalog(adapterCompany.pit, adapterCompany.locationId);
    const base = (process.env.PUBLIC_URL ?? process.env.TICK_URL ?? "").replace(/\/$/, "");
    return { company: co, rows, byKey: new Map(rows.map((r) => [r.key, r])), bookingSource: adapterCompany.booking.source, calendars, liveCalendars, liveCalendarsError, terms, users, catalog, slack, readiness,
      inbound: { secret: bindings["secret.zapier_inbound"] ?? null, whop: `${base}/api/webhooks/whop/${co.id}`, fathom: `${base}/api/webhooks/fathom/${co.id}`, zapierPayment: `${base}/api/webhooks/zapier/${co.id}/payment`, zapierRecording: `${base}/api/webhooks/zapier/${co.id}/recording`, fathomWebhookId: bindings["fathom.webhook_id"] ?? null } };
  });
}
