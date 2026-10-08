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
import { workflowRefs, VERIFIES } from "./coverage";
import { parseDefinition } from "./definition";

/**
 * D33. The hourly sweep: a read-only look at every connection a company runs on. Its own automation, with its own
 * clock, channel, face and list of checks. It says nothing while everything works; a check that fails becomes an alert
 * (source `health`) and clears itself when the next sweep finds it fine.
 */
export type Finding = { check: string; item?: string; ok: boolean; level: Level; text: string; detail?: Record<string, unknown>; fix?: { label: string; action: "reregister_whop" | "reregister_fathom" }; href?: string; hrefLabel?: string; thread?: string };

/** The next days at a glance: "Thu Oct 9 · 2 (10:00am, 2:00pm)" per day, "none" where the calendar is closed or full. Posted in the alert's thread. */
export function availabilityBreakdown(times: string[], from: DateTime, days: number, tz: string): string {
  const byDay = new Map<string, string[]>();
  for (let i = 0; i < days; i++) byDay.set(from.setZone(tz).plus({ days: i }).toISODate()!, []);
  for (const t of times) { const d = DateTime.fromISO(t).setZone(tz); const k = d.toISODate()!; if (byDay.has(k)) byDay.get(k)!.push(d.toFormat("h:mma").toLowerCase()); }
  return [...byDay.entries()].map(([k, list]) => `${DateTime.fromISO(k, { zone: tz }).toFormat("ccc LLL d")} · ${list.length ? `${list.length} (${list.slice(0, 8).join(", ")}${list.length > 8 ? ", …" : ""})` : "none"}`).join("\n");
}
export type HealthRow = { company_id: string; enabled: boolean; every_minutes: number; channel: string | null; as_name: string | null; as_icon: string | null; checks: Record<string, boolean>; min_slots: number; slots_days: number; last_run_at: Date | null; last_result: Finding[] };

export const CHECKS: { id: string; label: string; about: string }[] = [
  { id: "ghl_token", label: "GoHighLevel token", about: "the private integration token still opens the location" },
  { id: "ghl_calendars", label: "GHL calendars bookable", about: "every mapped calendar returns free slots over the next days; a closer's calendar sync dropping shows up here as no slots" },
  { id: "availability", label: "Low availability", about: "a calendar with fewer bookable slots than the threshold over the next days is an alert, before leads find a full calendar" },
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
  { id: "steps", label: "Every step can fire", about: "each enabled workflow's steps are walked and everything they depend on outside the engine is checked: bindings exist in the CRM, channels have the bot, prompts and keys are set, custom objects and events exist, hand-off targets are on; kinds that cannot be verified are listed as such" },
  { id: "urls", label: "Links in copy", about: "every fixed http(s) link a message sends (booking pages, forms) still answers; a link that moved is an alert" },
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
  urlOk: (url: string) => Promise<{ ok: boolean; status?: number; error?: string }>;
};
/** Does a link a person will click still answer? HEAD first, GET when HEAD is refused; anything under 400 after redirects is fine. */
export async function urlOk(url: string): Promise<{ ok: boolean; status?: number; error?: string }> {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 8000);
  try {
    let res = await fetch(url, { method: "HEAD", redirect: "follow", signal: ctl.signal });
    if (res.status === 405 || res.status === 403 || res.status === 501) res = await fetch(url, { method: "GET", redirect: "follow", signal: ctl.signal });
    return { ok: res.status < 400, status: res.status };
  } catch (e) { return { ok: false, error: String((e as Error).message).slice(0, 120) }; }
  finally { clearTimeout(t); }
}
export const liveProbes: HealthProbes = { ghlLocationOk, ghlFreeSlots, ghlCatalog, calendlyWhoAmI, calendlyAvailableTimes, whopPing, whopGetWebhook, fathomPing, fathomListWebhooks, anthropicPing, urlOk };

const DAYS_AHEAD = 7;
type SlotRead = { name: string; id: string; slots: number; href?: string; times: string[] };

/** Runs every enabled check for one company. Read-only against every vendor. */
export async function sweep(c: PoolClient, company: CompanyRow, adapters: Adapters, probes: HealthProbes, row: HealthRow, now = DateTime.now()): Promise<Finding[]> {
  const { adapterCompany: ac, bindings } = await loadCompany(c, company.id);
  const on = (id: string) => row.checks[id] !== false;
  const out: Finding[] = [];
  const ok = (check: string, text: string, item?: string, detail?: Record<string, unknown>) => out.push({ check, item, ok: true, level: "warning", text, detail });
  const bad = (check: string, level: Level, text: string, item?: string, detail?: Record<string, unknown>, fix?: Finding["fix"]) => out.push({ check, item, ok: false, level, text, detail, fix });
  const channelCache = new Map<string, { ok: boolean; name?: string; member?: boolean; error?: string }>();
  const channelInfo = async (token: string, id: string) => { if (!channelCache.has(id)) channelCache.set(id, await adapters.notifier.channelInfo(token, id).catch((e) => ({ ok: false, error: String((e as Error).message) }))); return channelCache.get(id)!; };
  const connected = !!ac.pit && !!ac.locationId;

  // GoHighLevel
  let catalog: Catalog | null = null;
  if (on("ghl_token")) {
    if (!connected) bad("ghl_token", "error", "No GoHighLevel token or location bound.");
    else { const r = await probes.ghlLocationOk(ac.pit, ac.locationId); if (r.ok) ok("ghl_token", `Token opens ${r.name ?? "the location"}.`); else bad("ghl_token", "error", `GoHighLevel token rejected: ${r.error}`); }
  }
  if (connected && (on("ghl_pipelines") || on("ghl_fields") || on("ghl_users"))) catalog = await probes.ghlCatalog(ac.pit, ac.locationId).catch(() => null);
  out.push(...(await readCalendars(c, company, adapters, probes, row, now)));
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
    // event types and their availability: readCalendars (shared with the booking-time re-check)
  }

  // Whop
  if (on("whop_key") && bindings["secret.whop_api_key"]) { if (await probes.whopPing(bindings["secret.whop_api_key"])) ok("whop_key", "Key reads payments."); else bad("whop_key", "error", "Whop API key rejected (or lost payment:basic:read)."); }
  if (on("whop_webhook") && bindings["secret.whop_api_key"] && bindings["whop.webhook_id"]) {
    const r = await probes.whopGetWebhook(bindings["secret.whop_api_key"], bindings["whop.webhook_id"]);
    if (!r.ok) bad("whop_webhook", "warning", `Cannot read the Whop webhook: ${r.error}`);
    else if (!r.found) bad("whop_webhook", "error", `The Whop payment webhook (${bindings["whop.webhook_id"]}) no longer exists. Payments will stop arriving.`, undefined, undefined, { label: "Re-register the Whop webhook", action: "reregister_whop" });
    else if (r.enabled === false) bad("whop_webhook", "error", `The Whop payment webhook is disabled.`, undefined, undefined, { label: "Re-register the Whop webhook", action: "reregister_whop" });
    else ok("whop_webhook", `Webhook ${bindings["whop.webhook_id"]} is registered and enabled.`);
  }

  // Fathom
  if (on("fathom_key") && bindings["secret.fathom_api_key"]) { if (await probes.fathomPing(bindings["secret.fathom_api_key"])) ok("fathom_key", "Key lists meetings."); else bad("fathom_key", "error", "Fathom API key rejected."); }
  if (on("fathom_webhook") && bindings["secret.fathom_api_key"] && bindings["fathom.webhook_id"]) {
    let list: Awaited<ReturnType<typeof fathomListWebhooks>> = null, err: string | null = null;
    try { list = await probes.fathomListWebhooks(bindings["secret.fathom_api_key"]); } catch (e) { err = String((e as Error).message).slice(0, 160); }
    if (err) bad("fathom_webhook", "warning", `Cannot list Fathom webhooks: ${err}`);
    else if (list) { if (list.some((w) => w.id === bindings["fathom.webhook_id"])) ok("fathom_webhook", `Webhook ${bindings["fathom.webhook_id"]} is registered.`); else bad("fathom_webhook", "error", `The Fathom recording webhook (${bindings["fathom.webhook_id"]}) is gone. Recordings will stop arriving.`, undefined, undefined, { label: "Re-register the Fathom webhook", action: "reregister_fathom" }); }
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
          const info = await channelInfo(token, id);
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

  // Every step of every enabled workflow: what it depends on outside the engine, verified (coverage.ts lists it from the definition)
  if (on("steps")) {
    const wfs = await many<{ id: string; name: string; slug: string | null; definition: unknown }>(c, "select w.id, w.name, t.slug, v.definition from workflows w join workflow_versions v on v.workflow_id=w.id and v.version=w.current_version left join workflow_templates t on t.id=w.template_id where w.company_id=$1 and w.enabled order by w.name", [company.id]);
    const allWfs = await many<{ name: string; slug: string | null; enabled: boolean }>(c, "select w.name, t.slug, w.enabled from workflows w left join workflow_templates t on t.id=w.template_id where w.company_id=$1", [company.id]);
    const events = new Set((await many<{ name: string }>(c, "select name from event_types")).map((e) => e.name));
    const domains = new Set((await many<{ domain: string }>(c, "select distinct domain from core_categories")).map((d) => d.domain));
    const cals = new Set((await many<{ external_id: string }>(c, "select external_id from calendars where company_id=$1 and active", [company.id])).map((x) => x.external_id));
    const conn = await one<{ bot_token: Buffer }>(c, "select bot_token from slack_connections where company_id=$1", [company.id]);
    const token = conn ? (await import("./crypto")).decrypt(conn.bot_token) : null;
    const stages = new Set(catalog?.pipelines.flatMap((p) => p.stages.map((s) => s.id)) ?? []), pipes = new Set(catalog?.pipelines.map((p) => p.id) ?? []), cf = new Set(catalog?.contactFields.map((f) => f.id) ?? []), of = new Set(catalog?.opportunityFields.map((f) => f.id) ?? []), assocs = new Set(catalog?.associations.map((a) => a.id) ?? []), objects = new Set(catalog?.objects.flatMap((o) => [o.key, o.key.replace(/^custom_objects\./, "")]) ?? []), users = new Set(catalog?.users.map((u) => u.id) ?? []);
    const unverifiable: string[] = [];
    for (const wf of wfs) {
      let def; try { def = parseDefinition(wf.definition); } catch (e) { bad("steps", "error", `"${wf.name}" no longer parses on this engine and is skipped: ${String((e as Error).message).slice(0, 120)}. Re-install upgrades it.`, wf.id); continue; }
      const before = out.length; let verified = 0;
      const miss = (text: string, level: Level = "error") => bad("steps", level, `"${wf.name}": ${text}`, wf.id);
      for (const r of workflowRefs(def)) {
        if (VERIFIES[r.kind] === "unverifiable") { unverifiable.push(`${wf.name}: ${r.what} (${r.value})`); continue; }
        switch (r.kind) {
          case "binding": {
            const v = bindings[r.value];
            if (!v) { if (r.value.startsWith("slack.channel.")) miss(`step ${r.node} posts to ${r.value}, which is not bound; those posts are skipped.`, "warning"); else miss(`step ${r.node} needs ${r.value}, which is not bound.`); break; }
            if (r.value === "crm.agreement_template") { unverifiable.push(`${wf.name}: the agreement template (${v})`); break; }
            if (!catalog && r.value.startsWith("crm.") && r.value !== "crm.location_id") break;   // ghl_token already said the CRM cannot be read
            if (r.value.startsWith("crm.pipeline_") && !pipes.has(v)) miss(`step ${r.node}: pipeline ${r.value} (${v}) no longer exists in the CRM.`);
            else if (r.value.startsWith("crm.stage_") && !stages.has(v)) miss(`step ${r.node}: stage ${r.value} (${v}) no longer exists in the CRM.`);
            else if (r.value.startsWith("crm.field_contact_") && !cf.has(v)) miss(`step ${r.node}: contact field ${r.value} (${v}) no longer exists in the CRM.`);
            else if (r.value.startsWith("crm.field_opportunity_") && !of.has(v)) miss(`step ${r.node}: opportunity field ${r.value} (${v}) no longer exists in the CRM.`);
            else if (r.value.startsWith("crm.assoc_") && !assocs.has(v)) miss(`step ${r.node}: association ${r.value} (${v}) no longer exists in the CRM.`);
            else if ((r.value === "crm.default_closer" || r.value === "crm.agreement_sender") && !users.has(v)) miss(`step ${r.node}: ${r.value} (${v}) is no longer a user in the location.`);
            else if (r.value.startsWith("calendar.") && !cals.has(v)) miss(`step ${r.node}: ${r.value} points at a calendar (${v}) that is not active for this company.`);
            else if (r.value.startsWith("slack.channel.") && token) { const info = await channelInfo(token, v); if (!info.ok) miss(`step ${r.node}: channel ${r.value} (${v}) cannot be read: ${info.error ?? "unknown"}.`); else verified++; break; }   // membership is the slack check's finding, once per channel
            else verified++;
            break;
          }
          case "custom_object": if (catalog && !objects.has(r.value)) miss(`step ${r.node} writes ${r.value}, which no longer exists in the CRM.`); else verified++; break;
          case "workflow": { const target = allWfs.find((w) => w.slug === r.value || w.name.toLowerCase() === r.value.toLowerCase()); if (!target) miss(`step ${r.node} hands off to "${r.value}", which is not installed.`); else if (!target.enabled) miss(`step ${r.node} hands off to "${r.value}", which is off.`, "warning"); else verified++; break; }
          case "classify_domain": if (!domains.has(r.value)) miss(`step ${r.node} classifies into "${r.value}", which has no options.`); else verified++; break;
          case "event": if (!events.has(r.value)) miss(`trigger ${r.node} listens for "${r.value}", which the engine never emits.`); else verified++; break;
          case "anthropic": if (!(bindings["secret.anthropic_key"] || process.env.ANTHROPIC_API_KEY)) miss(`step ${r.node} needs an Anthropic key and none is set.`); else verified++; break;
          case "slack": if (!conn) miss(`step ${r.node} posts to Slack, which is not connected; those posts are skipped.`, "warning"); else verified++; break;
          case "url": verified++; break;   // checked once per unique link under "urls"
        }
      }
      if (out.length === before) ok("steps", `"${wf.name}": ${verified} dependencies verified.`, wf.id);
    }
    if (!wfs.length) ok("steps", "No workflows on.");
    if (unverifiable.length) ok("steps", `Not verifiable from here: ${[...new Set(unverifiable)].join("; ")}.`, "unverifiable");
  }

  // Links in copy: a page that moved is found the hour it moves, not when a lead clicks it
  if (on("urls")) {
    const wfs = await many<{ name: string; definition: unknown }>(c, "select w.name, v.definition from workflows w join workflow_versions v on v.workflow_id=w.id and v.version=w.current_version where w.company_id=$1 and w.enabled", [company.id]);
    const links = new Map<string, string[]>();
    for (const wf of wfs) { let def; try { def = parseDefinition(wf.definition); } catch { continue; } for (const r of workflowRefs(def)) if (r.kind === "url") links.set(r.value, [...(links.get(r.value) ?? []), wf.name]); }
    for (const [k, v] of Object.entries(bindings)) if (k.startsWith("calendar.") && k.endsWith(".url") && /^https?:/.test(v)) links.set(v, [...(links.get(v) ?? []), k]);
    const skip = (u: string) => /gohighlevel\.com\/v2\/location|slack\.com|fathom\.video\/calls/.test(u);   // app links behind a login answer with a redirect to sign in, not a 404
    let fine = 0;
    for (const [url, where] of links) {
      if (skip(url)) continue;
      const r = await probes.urlOk(url);
      if (r.ok) fine++; else bad("urls", "error", `${url} (used by ${[...new Set(where)].join(", ")}) no longer answers: ${r.error ?? `HTTP ${r.status}`}.`, url);
    }
    if (!links.size) ok("urls", "No fixed links in copy.");
    else if (fine === [...links.keys()].filter((u) => !skip(u)).length) ok("urls", `${fine} link${fine === 1 ? "" : "s"} answer.`);
  }
  return out;
}

/** The calendar link a person opens to see availability: the public scheduling page (what a lead sees), else the provider's booking widget. */
export function calendarLink(cal: { external_id: string; source: string; booking_url: string | null }, locationId?: string): string {
  if (cal.booking_url) return cal.booking_url;
  return cal.source === "calendly" ? `https://calendly.com/event_types/${cal.external_id}` : `https://api.leadconnectorhq.com/widget/booking/${cal.external_id}${locationId ? "" : ""}`;
}

/**
 * Every mapped calendar (or just `only`): can it be read, does it have bookable slots over the window (none = the provider
 * calendar dropped or availability is off), and is it below the company's low-availability threshold. Run by the hourly
 * sweep for all calendars and again the minute a booking lands on one (D33, continued).
 */
export async function readCalendars(c: PoolClient, company: CompanyRow, adapters: Adapters, probes: HealthProbes, row: HealthRow, now = DateTime.now(), only?: string[]): Promise<Finding[]> {
  const { adapterCompany: ac, bindings } = await loadCompany(c, company.id);
  const on = (id: string) => row.checks[id] !== false;
  const out: Finding[] = [];
  const days = Math.min(DAYS_AHEAD, Math.max(1, row.slots_days || DAYS_AHEAD));
  const from = now.toJSDate(), to = now.plus({ days }).toJSDate();
  const connected = !!ac.pit && !!ac.locationId;
  const slotReads: SlotRead[] = [];
  const cals = (await many<{ external_id: string; name: string; source: string; booking_url: string | null }>(c, "select external_id, name, source, booking_url from calendars where company_id=$1 and active and source=$2", [company.id, ac.booking.source])).filter((k) => !only || only.includes(k.external_id));
  const link = (k: { external_id: string; source: string; booking_url: string | null }) => calendarLink(k, ac.locationId);
  const ok = (check: string, text: string, item?: string, detail?: Record<string, unknown>, href?: string) => out.push({ check, item, ok: true, level: "warning", text, detail, href, hrefLabel: href ? "Open the calendar" : undefined });
  const bad = (check: string, level: Level, text: string, item?: string, detail?: Record<string, unknown>, href?: string) => out.push({ check, item, ok: false, level, text, detail, href, hrefLabel: href ? "Open the calendar" : undefined });
  if (ac.booking.source === "ghl" && on("ghl_calendars") && connected) {
    for (const cal of cals) {
      const r = await probes.ghlFreeSlots(ac.pit, cal.external_id, from, to, company.timezone);
      if (!r.ok) bad("ghl_calendars", "error", `Calendar "${cal.name}" cannot be read: ${r.error}`, cal.external_id, undefined, link(cal));
      else if (r.slots === 0) bad("ghl_calendars", "warning", `Calendar "${cal.name}" has no bookable slot in the next ${days} days. A closer's connected calendar may have dropped, or availability is off.`, cal.external_id, undefined, link(cal));
      else { ok("ghl_calendars", `"${cal.name}": ${r.slots} bookable slots in the next ${days} days.`, cal.external_id, { slots: r.slots }, link(cal)); slotReads.push({ name: cal.name, id: cal.external_id, slots: r.slots, href: link(cal), times: r.times }); }
    }
    if (!cals.length && !only) ok("ghl_calendars", "No GHL calendars mapped.");
  }
  if (ac.booking.source === "calendly" && on("calendly_calendars")) {
    const token = bindings["secret.calendly_token"];
    let live: Awaited<ReturnType<typeof adapters.booking.calendly.listCalendars>> | null = null;
    try { live = await adapters.booking.calendly.listCalendars(ac); } catch (e) { bad("calendly_calendars", "error", `Could not list Calendly event types: ${String((e as Error).message).slice(0, 160)}`); }
    if (live) for (const cal of cals) {
      const t = live.find((x) => x.id === cal.external_id);
      if (!t) { bad("calendly_calendars", "error", `Event type "${cal.name}" is gone from Calendly.`, cal.external_id, undefined, link(cal)); continue; }
      if (t.active === false) { bad("calendly_calendars", "warning", `Event type "${cal.name}" is turned off in Calendly.`, cal.external_id, undefined, link(cal)); continue; }
      // the API wants a start in the future and a window of at most 7 days: a minute from now, (days - 1) days and 23 hours long
      const r = await probes.calendlyAvailableTimes(token, `https://api.calendly.com/event_types/${cal.external_id}`, now.plus({ minutes: 1 }).toJSDate(), now.plus({ days: days - 1, hours: 23 }).toJSDate());
      if (!r.ok) bad("calendly_calendars", "error", `Event type "${cal.name}": availability cannot be read: ${r.error}`, cal.external_id, undefined, link(cal));
      else if (r.slots === 0) bad("calendly_calendars", "warning", `Event type "${cal.name}" has no available time in the next ${days} days. A host's connected calendar may have dropped, or availability is off.`, cal.external_id, undefined, link(cal));
      else { ok("calendly_calendars", `"${cal.name}": ${r.slots} available times in the next ${days} days.`, cal.external_id, { slots: r.slots }, link(cal)); slotReads.push({ name: cal.name, id: cal.external_id, slots: r.slots, href: link(cal), times: r.times }); }
    }
    if (live && !cals.length && !only) ok("calendly_calendars", "No Calendly event types mapped.");
  }
  // Low availability: the calendar is alive but nearly full (or nearly closed); the threshold is the company's own
  if (on("availability") && slotReads.length) {
    const low = slotReads.filter((s) => s.slots < row.min_slots);
    for (const s of low) { bad("availability", "warning", `"${s.name}" has only ${s.slots} bookable ${s.slots === 1 ? "slot" : "slots"} in the next ${days} days (alert below ${row.min_slots}).`, s.id, { slots: s.slots, min: row.min_slots }, s.href); out[out.length - 1].thread = `*${s.name} · next ${days} days*\n${availabilityBreakdown(s.times, now, days, company.timezone)}`; }
    if (!low.length && !only) ok("availability", `${slotReads.length} calendar${slotReads.length === 1 ? "" : "s"} at or above ${row.min_slots} bookable slots over ${days} days.`);
    for (const s of slotReads) if (s.slots >= row.min_slots && only) ok("availability", `"${s.name}": ${s.slots} bookable slots, at or above ${row.min_slots}.`, s.id, { slots: s.slots }, s.href);
    for (const s of slotReads) { const f = out.find((x) => x.check === "availability" && x.item === s.id); if (f && !f.thread) f.thread = `*${s.name} · next ${days} days*\n${availabilityBreakdown(s.times, now, days, company.timezone)}`; }
  }
  return out;
}

/** The calendar checks the minute a booking (or cancellation, or reschedule) lands: availability moved, so look now instead of waiting for the hour. */
export async function checkCalendarsAfterBookings(c: PoolClient, adapters: Adapters, probes: HealthProbes = liveProbes, now = DateTime.now()): Promise<{ checked: { company: string; calendar: string; raised: number; resolved: number }[] }> {
  const cursor = (await one<{ value: { since?: string } }>(c, "select value from engine_state where key='health_booking_cursor'"))?.value.since;
  const since = cursor ? new Date(cursor) : new Date(now.toMillis() - 10 * 60e3);
  const moved = await many<{ company_id: string; slug: string; external_id: string; name: string }>(c, `
    select distinct co.id as company_id, co.slug, cal.external_id, cal.name from events e join appointments a on a.id=e.appointment_id join calendars cal on cal.id=a.calendar_id join companies co on co.id=e.company_id
    where e.event_type in ('appointment.booked','appointment.rescheduled','appointment.status_changed') and e.occurred_at > $1 and e.occurred_at <= $2 and cal.active`, [since, now.toJSDate()]);
  await c.query("insert into engine_state (key, value, updated_at) values ('health_booking_cursor', $1, now()) on conflict (key) do update set value=$1, updated_at=now()", [{ since: now.toISO() }]);
  const out = { checked: [] as { company: string; calendar: string; raised: number; resolved: number }[] };
  for (const m of moved) {
    const row = await ensureHealth(c, m.company_id); if (!row.enabled) continue;
    const { row: company } = await loadCompany(c, m.company_id);
    const findings = await readCalendars(c, company, adapters, probes, row, now, [m.external_id]);
    // the stored sweep result shows what was just seen for this calendar
    const kept = (row.last_result as Finding[]).filter((f) => f.item !== m.external_id || !["ghl_calendars", "calendly_calendars", "availability"].includes(f.check));
    await c.query("update health_checks set last_result=$2 where company_id=$1", [m.company_id, JSON.stringify([...kept, ...findings])]);
    const present: AlertInput[] = findings.filter((f) => !f.ok).map((f) => ({ companyId: m.company_id, key: `health:${f.check}:${f.item}`, level: f.level, source: "health", text: f.text, detail: { ...(f.detail ?? {}), link: f.href, link_label: f.hrefLabel, ...(f.thread ? { thread: f.thread } : {}) }, href: `/c/${m.slug}/health` }));
    let raised = 0, resolved = 0;
    for (const check of ["ghl_calendars", "calendly_calendars", "availability"]) { const r = await reconcile(c, m.company_id, "health", present.filter((p) => p.key.startsWith(`health:${check}:`)), now.toJSDate(), `health:${check}:${m.external_id}`); raised += r.raised; resolved += r.resolved; }
    out.checked.push({ company: m.slug, calendar: m.name, raised, resolved });
  }
  return out;
}

/** Sweep one company now: run the checks, remember the result, turn failures into alerts and clear the ones that passed. */
export async function sweepCompany(c: PoolClient, companyId: string, adapters: Adapters, probes: HealthProbes = liveProbes, now = DateTime.now()): Promise<{ findings: Finding[]; raised: number; resolved: number }> {
  const row = await ensureHealth(c, companyId);
  const { row: company } = await loadCompany(c, companyId);
  const findings = await sweep(c, company, adapters, probes, row, now);
  await c.query("update health_checks set last_run_at=$2, last_result=$3 where company_id=$1", [companyId, now.toJSDate(), JSON.stringify(findings)]);
  const present: AlertInput[] = findings.filter((f) => !f.ok).map((f) => ({ companyId, key: `health:${f.check}${f.item ? `:${f.item}` : ""}`, level: f.level, source: "health", text: f.text, detail: { ...(f.detail ?? {}), ...(f.fix ? { fix: f.fix } : {}), ...(f.href ? { link: f.href, link_label: f.hrefLabel } : {}), ...(f.thread ? { thread: f.thread } : {}) }, href: `/c/${company.slug}/health` }));
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
