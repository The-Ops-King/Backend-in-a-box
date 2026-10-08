import type { PoolClient } from "pg";
import { DateTime } from "luxon";
import { many, one } from "@/db/client";
import type { Adapters } from "@/adapters/types";
import { loadCompany, type CompanyRow } from "./context";
import { reconcile, type AlertInput, type Level } from "./alerts";
import { companyReadiness } from "./readiness";
import { ghlCatalog, type Catalog } from "@/adapters/ghl/catalog";
import { ghlFreeSlots, ghlLocationOk } from "@/adapters/ghl/health";
import { calendlyWhoAmI } from "@/adapters/calendly/read";
import { calendlyAvailableTimes } from "@/adapters/calendly/health";
import { whopGetWebhook, whopPing } from "@/adapters/whop/client";
import { fathomListWebhooks, fathomPing } from "@/adapters/fathom/client";
import { anthropicPing } from "@/adapters/anthropic/health";

/**
 * D33. The hourly sweep: a read-only look at every connection a company runs on. Its own automation, with its own
 * clock, channel, face and list of checks. It says nothing while everything works; a check that fails becomes an alert
 * (source `health`) and clears itself when the next sweep finds it fine.
 */
export type Finding = { check: string; item?: string; ok: boolean; level: Level; text: string; detail?: Record<string, unknown> };
export type HealthRow = { company_id: string; enabled: boolean; every_minutes: number; channel: string | null; as_name: string | null; as_icon: string | null; checks: Record<string, boolean>; last_run_at: Date | null; last_result: Finding[] };

export const CHECKS: { id: string; label: string; about: string }[] = [
  { id: "ghl_token", label: "GoHighLevel token", about: "the private integration token still opens the location" },
  { id: "ghl_calendars", label: "GHL calendars bookable", about: "every mapped calendar returns free slots over the next 7 days; a closer's calendar sync dropping shows up here as no slots" },
  { id: "ghl_pipelines", label: "Pipelines and stages", about: "every bound pipeline and stage still exists in the CRM" },
  { id: "ghl_fields", label: "Custom fields", about: "every bound contact and opportunity field still exists" },
  { id: "ghl_users", label: "Team", about: "closers on calendars and cards are still users in the location" },
  { id: "calendly_token", label: "Calendly token", about: "the token still answers (companies that book through Calendly)" },
  { id: "calendly_calendars", label: "Calendly event types bookable", about: "every mapped event type is active and has available times over the next 7 days; a host's calendar disconnecting shows up here" },
  { id: "whop_key", label: "Whop key", about: "the API key still reads payments" },
  { id: "whop_webhook", label: "Whop webhook", about: "the payment webhook the engine registered still exists and is enabled" },
  { id: "fathom_key", label: "Fathom key", about: "the API key still lists meetings" },
  { id: "fathom_webhook", label: "Fathom webhook", about: "the recording webhook is still registered (or, when Fathom cannot list webhooks, that deliveries keep arriving)" },
  { id: "slack", label: "Slack", about: "the bot token is alive and the bot is in every channel the workflows post to" },
  { id: "anthropic", label: "Anthropic key", about: "the AI key still answers (the company's, else the server's)" },
  { id: "workflows", label: "Workflows ready", about: "no enabled workflow is missing a binding or carries a copy the engine cannot run" },
];

export async function ensureHealth(c: PoolClient, companyId: string): Promise<HealthRow> {
  await c.query("insert into health_checks (company_id) values ($1) on conflict (company_id) do nothing", [companyId]);
  return (await one<HealthRow>(c, "select * from health_checks where company_id=$1", [companyId]))!;
}

/** The outside calls the sweep makes, injectable so the engine's logic is tested without the vendors. */
export type HealthProbes = {
  ghlLocationOk: typeof ghlLocationOk; ghlFreeSlots: typeof ghlFreeSlots; ghlCatalog: typeof ghlCatalog;
  calendlyWhoAmI: typeof calendlyWhoAmI; calendlyAvailableTimes: typeof calendlyAvailableTimes;
  whopPing: typeof whopPing; whopGetWebhook: typeof whopGetWebhook; fathomPing: typeof fathomPing; fathomListWebhooks: typeof fathomListWebhooks; anthropicPing: typeof anthropicPing;
};
export const liveProbes: HealthProbes = { ghlLocationOk, ghlFreeSlots, ghlCatalog, calendlyWhoAmI, calendlyAvailableTimes, whopPing, whopGetWebhook, fathomPing, fathomListWebhooks, anthropicPing };

const DAYS_AHEAD = 7;

/** Runs every enabled check for one company. Read-only against every vendor. */
export async function sweep(c: PoolClient, company: CompanyRow, adapters: Adapters, probes: HealthProbes, row: HealthRow, now = DateTime.now()): Promise<Finding[]> {
  const { adapterCompany: ac, bindings } = await loadCompany(c, company.id);
  const on = (id: string) => row.checks[id] !== false;
  const out: Finding[] = [];
  const ok = (check: string, text: string, item?: string, detail?: Record<string, unknown>) => out.push({ check, item, ok: true, level: "warning", text, detail });
  const bad = (check: string, level: Level, text: string, item?: string, detail?: Record<string, unknown>) => out.push({ check, item, ok: false, level, text, detail });
  const from = now.toJSDate(), to = now.plus({ days: DAYS_AHEAD }).toJSDate();
  const connected = !!ac.pit && !!ac.locationId;

  // GoHighLevel
  let catalog: Catalog | null = null;
  if (on("ghl_token")) {
    if (!connected) bad("ghl_token", "error", "No GoHighLevel token or location bound.");
    else { const r = await probes.ghlLocationOk(ac.pit, ac.locationId); if (r.ok) ok("ghl_token", `Token opens ${r.name ?? "the location"}.`); else bad("ghl_token", "error", `GoHighLevel token rejected: ${r.error}`); }
  }
  if (connected && (on("ghl_pipelines") || on("ghl_fields") || on("ghl_users"))) catalog = await probes.ghlCatalog(ac.pit, ac.locationId).catch(() => null);
  if (on("ghl_calendars") && ac.booking.source === "ghl" && connected) {
    const cals = await many<{ external_id: string; name: string }>(c, "select external_id, name from calendars where company_id=$1 and active and source='ghl'", [company.id]);
    for (const cal of cals) {
      const r = await probes.ghlFreeSlots(ac.pit, cal.external_id, from, to, company.timezone);
      if (!r.ok) bad("ghl_calendars", "error", `Calendar "${cal.name}" cannot be read: ${r.error}`, cal.external_id);
      else if (r.slots === 0) bad("ghl_calendars", "warning", `Calendar "${cal.name}" has no bookable slot in the next ${DAYS_AHEAD} days. A closer's connected calendar may have dropped, or availability is off.`, cal.external_id);
      else ok("ghl_calendars", `"${cal.name}": ${r.slots} bookable slots in the next ${DAYS_AHEAD} days.`, cal.external_id, { slots: r.slots });
    }
    if (!cals.length) ok("ghl_calendars", "No GHL calendars mapped.");
  }
  if (on("ghl_pipelines") && connected) {
    if (!catalog || catalog.errors.some((e) => e.startsWith("pipelines"))) bad("ghl_pipelines", "error", `Could not list pipelines: ${catalog?.errors.find((e) => e.startsWith("pipelines")) ?? "catalog unavailable"}`);
    else {
      const stages = new Map(catalog.pipelines.flatMap((p) => p.stages.map((s) => [s.id, `${p.name} › ${s.name}`] as const)));
      const pipes = new Map(catalog.pipelines.map((p) => [p.id, p.name]));
      let n = 0;
      for (const [k, v] of Object.entries(bindings)) {
        if (k.startsWith("crm.pipeline_")) { n++; if (!pipes.has(v)) bad("ghl_pipelines", "error", `Pipeline binding ${k} points at a pipeline that no longer exists (${v}).`, k); }
        if (k.startsWith("crm.stage_")) { n++; if (!stages.has(v)) bad("ghl_pipelines", "error", `Stage binding ${k} points at a stage that no longer exists (${v}).`, k); }
      }
      if (!out.some((f) => f.check === "ghl_pipelines" && !f.ok)) ok("ghl_pipelines", `${n} pipeline and stage bindings all exist.`);
    }
  }
  if (on("ghl_fields") && connected) {
    if (!catalog || catalog.errors.some((e) => /fields/.test(e))) bad("ghl_fields", "error", `Could not list custom fields: ${catalog?.errors.find((e) => /fields/.test(e)) ?? "catalog unavailable"}`);
    else {
      const cf = new Set(catalog.contactFields.map((f) => f.id)), of = new Set(catalog.opportunityFields.map((f) => f.id));
      let n = 0;
      for (const [k, v] of Object.entries(bindings)) {
        if (k.startsWith("crm.field_contact_")) { n++; if (!cf.has(v)) bad("ghl_fields", "error", `Contact field binding ${k} points at a field that no longer exists (${v}).`, k); }
        if (k.startsWith("crm.field_opportunity_")) { n++; if (!of.has(v)) bad("ghl_fields", "error", `Opportunity field binding ${k} points at a field that no longer exists (${v}).`, k); }
      }
      if (!out.some((f) => f.check === "ghl_fields" && !f.ok)) ok("ghl_fields", `${n} field bindings all exist.`);
    }
  }
  if (on("ghl_users") && connected && catalog && !catalog.errors.some((e) => e.startsWith("users"))) {
    const live = new Set(catalog.users.map((u) => u.id));
    const used = await many<{ ghl_user_id: string; name: string; where: string }>(c, `select distinct u.ghl_user_id, u.name, 'calendar' as where from calendars cal join users u on u.id=cal.default_user_id where cal.company_id=$1 and cal.active and u.ghl_user_id is not null
      union select distinct u.ghl_user_id, u.name, 'open cards' from pipeline_cards p join users u on u.id=p.assigned_user_id where p.company_id=$1 and p.status='open' and u.ghl_user_id is not null`, [company.id]);
    const gone = used.filter((u) => !live.has(u.ghl_user_id));
    for (const g of gone) bad("ghl_users", "warning", `${g.name} is on ${g.where} but is no longer a user in the location.`, g.ghl_user_id);
    const dc = bindings["crm.default_closer"]; if (dc && !live.has(dc)) bad("ghl_users", "error", `The default closer (${dc}) is no longer a user in the location.`, "default_closer");
    if (!gone.length && (!dc || live.has(dc))) ok("ghl_users", `${catalog.users.length} users in the location; everyone the engine relies on is still there.`);
  }

  // Calendly
  if (ac.booking.source === "calendly") {
    const token = bindings["secret.calendly_token"];
    if (on("calendly_token")) {
      try { const me = await probes.calendlyWhoAmI(token); ok("calendly_token", `Token is ${me.email}.`); }
      catch (e) { bad("calendly_token", "error", `Calendly token rejected: ${String((e as Error).message).slice(0, 160)}`); }
    }
    if (on("calendly_calendars")) {
      const mapped = await many<{ external_id: string; name: string }>(c, "select external_id, name from calendars where company_id=$1 and active and source='calendly'", [company.id]);
      let live: Awaited<ReturnType<typeof adapters.booking.calendly.listCalendars>> | null = null;
      try { live = await adapters.booking.calendly.listCalendars(ac); } catch (e) { bad("calendly_calendars", "error", `Could not list Calendly event types: ${String((e as Error).message).slice(0, 160)}`); }
      if (live) for (const cal of mapped) {
        const t = live.find((x) => x.id === cal.external_id);
        if (!t) { bad("calendly_calendars", "error", `Event type "${cal.name}" is gone from Calendly.`, cal.external_id); continue; }
        if (t.active === false) { bad("calendly_calendars", "warning", `Event type "${cal.name}" is turned off in Calendly.`, cal.external_id); continue; }
        const r = await probes.calendlyAvailableTimes(token, `https://api.calendly.com/event_types/${cal.external_id}`, from, to);
        if (!r.ok) bad("calendly_calendars", "error", `Event type "${cal.name}": availability cannot be read: ${r.error}`, cal.external_id);
        else if (r.slots === 0) bad("calendly_calendars", "warning", `Event type "${cal.name}" has no available time in the next ${DAYS_AHEAD} days. A host's connected calendar may have dropped, or availability is off.`, cal.external_id);
        else ok("calendly_calendars", `"${cal.name}": ${r.slots} available times in the next ${DAYS_AHEAD} days.`, cal.external_id, { slots: r.slots });
      }
      if (live && !mapped.length) ok("calendly_calendars", "No Calendly event types mapped.");
    }
  }

  // Whop
  if (on("whop_key") && bindings["secret.whop_api_key"]) { if (await probes.whopPing(bindings["secret.whop_api_key"])) ok("whop_key", "Key reads payments."); else bad("whop_key", "error", "Whop API key rejected (or lost payment:basic:read)."); }
  if (on("whop_webhook") && bindings["secret.whop_api_key"] && bindings["whop.webhook_id"]) {
    const r = await probes.whopGetWebhook(bindings["secret.whop_api_key"], bindings["whop.webhook_id"]);
    if (!r.ok) bad("whop_webhook", "warning", `Cannot read the Whop webhook: ${r.error}`);
    else if (!r.found) bad("whop_webhook", "error", `The Whop payment webhook (${bindings["whop.webhook_id"]}) no longer exists. Payments will stop arriving; re-save the Whop key to register a new one.`);
    else if (r.enabled === false) bad("whop_webhook", "error", `The Whop payment webhook is disabled.`);
    else ok("whop_webhook", `Webhook ${bindings["whop.webhook_id"]} is registered and enabled.`);
  }

  // Fathom
  if (on("fathom_key") && bindings["secret.fathom_api_key"]) { if (await probes.fathomPing(bindings["secret.fathom_api_key"])) ok("fathom_key", "Key lists meetings."); else bad("fathom_key", "error", "Fathom API key rejected."); }
  if (on("fathom_webhook") && bindings["secret.fathom_api_key"] && bindings["fathom.webhook_id"]) {
    let list: Awaited<ReturnType<typeof fathomListWebhooks>> = null, err: string | null = null;
    try { list = await probes.fathomListWebhooks(bindings["secret.fathom_api_key"]); } catch (e) { err = String((e as Error).message).slice(0, 160); }
    if (err) bad("fathom_webhook", "warning", `Cannot list Fathom webhooks: ${err}`);
    else if (list) { if (list.some((w) => w.id === bindings["fathom.webhook_id"])) ok("fathom_webhook", `Webhook ${bindings["fathom.webhook_id"]} is registered.`); else bad("fathom_webhook", "error", `The Fathom recording webhook (${bindings["fathom.webhook_id"]}) is gone. Recordings will stop arriving; re-save the Fathom key to register a new one.`); }
    else {
      // no listing: the best read-only signal is whether deliveries keep coming
      const last = await one<{ at: Date | null }>(c, "select max(received_at) as at from webhook_deliveries where company_id=$1 and provider='fathom'", [company.id]);
      const days = last?.at ? Math.round((now.toMillis() - last.at.getTime()) / 864e5) : null;
      if (days === null) ok("fathom_webhook", "Registered; no delivery yet (Fathom does not list webhooks, so this is as far as the sweep can see).");
      else if (days > 14) bad("fathom_webhook", "warning", `No Fathom delivery in ${days} days (Fathom does not list webhooks, so this is the only signal).`);
      else ok("fathom_webhook", `Last Fathom delivery ${days} day${days === 1 ? "" : "s"} ago.`);
    }
  }

  // Slack
  if (on("slack")) {
    const conn = await one<{ bot_token: Buffer }>(c, "select bot_token from slack_connections where company_id=$1", [company.id]);
    if (conn) {
      const { decrypt } = await import("./crypto"); const token = decrypt(conn.bot_token);
      const auth: { ok: boolean; error?: string } = await adapters.notifier.authTest(token).catch((e) => ({ ok: false, error: String((e as Error).message) }));
      if (!auth.ok) bad("slack", "error", `Slack bot token rejected: ${auth.error ?? "unknown"}.`, "token");
      else {
        const channels = Object.entries(bindings).filter(([k]) => k.startsWith("slack.channel.") || k === "alerts.slack_channel").map(([k, v]) => [k, v] as const);
        if (row.channel) channels.push(["health.channel", row.channel]);
        const seen = new Set<string>(); let fine = 0;
        for (const [k, id] of channels) {
          if (!id || seen.has(id)) continue; seen.add(id);
          const info: { ok: boolean; name?: string; member?: boolean; error?: string } = await adapters.notifier.channelInfo(token, id).catch((e) => ({ ok: false, error: String((e as Error).message) }));
          if (!info.ok) bad("slack", "error", `Channel for ${k} (${id}) cannot be read: ${info.error ?? "unknown"}.`, id);
          else if (info.member === false) bad("slack", "warning", `The bot is not in #${info.name ?? id} (${k}); posts there will fail. Invite it.`, id);
          else fine++;
        }
        if (fine === seen.size) ok("slack", `Bot is alive and in all ${fine} channels it posts to.`);
      }
    }
  }

  // Anthropic
  if (on("anthropic")) {
    const key = bindings["secret.anthropic_key"] || process.env.ANTHROPIC_API_KEY;
    if (key) { const r = await probes.anthropicPing(key); if (r.ok) ok("anthropic", `${bindings["secret.anthropic_key"] ? "Company" : "Server"} key answers.`); else bad("anthropic", "error", `Anthropic key rejected: ${r.error}`); }
  }

  // Workflows
  if (on("workflows")) {
    const r = await companyReadiness(c, company.id, `/c/${company.slug}`);
    const blockers = r.issues.filter((i) => i.level === "blocker");
    for (const b of blockers) bad("workflows", "error", b.text, b.href ?? undefined);
    const offMissing = r.workflows.filter((w) => w.enabled && w.missing.length);
    for (const w of offMissing) if (!blockers.some((b) => b.href?.endsWith(w.id))) bad("workflows", "error", `"${w.name}" is on but missing ${w.missing.join(", ")}.`, w.id);
    if (!blockers.length && !offMissing.length) ok("workflows", `${r.workflows.filter((w) => w.enabled).length} workflows on, nothing missing.`);
  }
  return out;
}

/** Sweep one company now: run the checks, remember the result, turn failures into alerts and clear the ones that passed. */
export async function sweepCompany(c: PoolClient, companyId: string, adapters: Adapters, probes: HealthProbes = liveProbes, now = DateTime.now()): Promise<{ findings: Finding[]; raised: number; resolved: number }> {
  const row = await ensureHealth(c, companyId);
  const { row: company } = await loadCompany(c, companyId);
  const findings = await sweep(c, company, adapters, probes, row, now);
  await c.query("update health_checks set last_run_at=$2, last_result=$3 where company_id=$1", [companyId, now.toJSDate(), JSON.stringify(findings)]);
  const present: AlertInput[] = findings.filter((f) => !f.ok).map((f) => ({ companyId, key: `health:${f.check}${f.item ? `:${f.item}` : ""}`, level: f.level, source: "health", text: f.text, detail: f.detail, href: `/c/${company.slug}/health` }));
  const r = await reconcile(c, companyId, "health", present, now.toJSDate());
  return { findings, ...r };
}

/** Every company whose sweep is due. Called by the tick. */
export async function runDueHealth(c: PoolClient, adapters: Adapters, probes: HealthProbes = liveProbes, now = DateTime.now(), onlyCompanyId?: string): Promise<{ swept: { company: string; raised: number; resolved: number; failing: number }[]; errors: { company: string; error: string }[] }> {
  const out = { swept: [] as { company: string; raised: number; resolved: number; failing: number }[], errors: [] as { company: string; error: string }[] };
  const due = await many<{ id: string; slug: string }>(c, `select co.id, co.slug from companies co left join health_checks h on h.company_id=co.id
    where co.status in ('active','hosted') and coalesce(h.enabled, true) and (h.last_run_at is null or h.last_run_at < $1 - make_interval(mins => coalesce(h.every_minutes, 60))) and ($2::uuid is null or co.id=$2)`, [now.toJSDate(), onlyCompanyId ?? null]);
  for (const co of due) {
    try { const r = await sweepCompany(c, co.id, adapters, probes, now); out.swept.push({ company: co.slug, raised: r.raised, resolved: r.resolved, failing: r.findings.filter((f) => !f.ok).length }); }
    catch (e) { out.errors.push({ company: co.slug, error: String((e as Error).message).slice(0, 200) }); await c.query("update health_checks set last_run_at=$2 where company_id=$1", [co.id, now.toJSDate()]).catch(() => null); }
  }
  return out;
}
