import type { PoolClient } from "pg";
import { DateTime } from "luxon";
import { many, one } from "@/db/client";
import type { Adapters, Company } from "@/adapters/types";
import { loadCompany, type CompanyRow } from "./context";
import { reconcile, type AlertInput, type Level } from "./alerts";
import { companyReadiness } from "./readiness";
import { ghlCatalog, type Catalog } from "@/adapters/ghl/catalog";
import { ghlCalendarTeam, ghlFreeSlots, ghlLocationOk } from "@/adapters/ghl/health";
import { calendlyWhoAmI } from "@/adapters/calendly/read";
import { calendlyAvailableTimes, calendlyBusyTimes, calendlyEventTypeHosts, calendlyEventTypeSchedules, type CalendlyHost, type CalendlySchedule } from "@/adapters/calendly/health";
import { formatAvailability } from "./bot-format";
import { whopGetWebhook, whopPing } from "@/adapters/whop/client";
import { fathomListWebhooks, fathomPing } from "@/adapters/fathom/client";
import { anthropicPing } from "@/adapters/anthropic/health";
import { jevPing } from "@/adapters/jev/classifier";
import { workflowRefs, VERIFIES } from "./coverage";
import { parseDefinition } from "./definition";
import { liveGhlReads, type GhlReads } from "@/adapters/ghl/metrics";
import { crmPresence, ledgerDrift } from "./ledger-drift";

/**
 * D33. The hourly sweep: a read-only look at every connection a company runs on. Its own automation, with its own
 * clock, channel, face and list of checks. It says nothing while everything works; a check that fails becomes an alert
 * (source `health`) and clears itself when the next sweep finds it fine.
 */
export type Finding = { check: string; item?: string; ok: boolean; level: Level; text: string; detail?: Record<string, unknown>; fix?: { label: string; action: "reregister_whop" | "reregister_fathom" }; href?: string; hrefLabel?: string; thread?: string;
  /** The alert's key when it is not `health:<check>:<item>` (duplicates are `duplicate:<contact_id>`, D63), and the engine page its Open link goes to when it is not the health page. */
  key?: string; page?: string };

export type HealthRow = { company_id: string; channel: string | null; as_name: string | null; as_icon: string | null; last_run_at: Date | null; last_result: Finding[] };
/** What a sweep is told by the step that runs it: which checks, the availability threshold, the channel its alerts announce in, and its run (the ledger_drift repair records its CRM writes against it, D66). */
export type HealthConfig = { checks: Record<string, boolean>; min_slots: number; slots_days: number; channel?: string | null; run_id?: string };

export const CHECKS: { id: string; label: string; about: string }[] = [
  { id: "ghl_token", label: "GoHighLevel token", about: "the private integration token still opens the location" },
  { id: "ghl_calendars", label: "GHL calendars bookable", about: "every mapped calendar returns free slots over the next days; a closer's calendar sync dropping shows up here as no slots" },
  { id: "availability", label: "Low availability", about: "a calendar with fewer bookable slots than the threshold over the next days is an alert, before leads find a full calendar" },
  { id: "ghl_pipelines", label: "Pipelines and stages", about: "every bound pipeline and stage still exists in the CRM" },
  { id: "ghl_fields", label: "Custom fields", about: "every bound contact and opportunity field still exists" },
  { id: "ghl_users", label: "Team", about: "closers on calendars and cards are still users in the location" },
  { id: "duplicates", label: "Duplicate contacts", about: "no person is held twice by the CRM: two records the engine already folded into one person (same phone or email, spelled two ways), or two engine persons whose phone or email differ only in spelling. The engine never merges — GoHighLevel is the source of truth, so a person merges the records there; the finding and its alert clear once the dropped record is gone from the CRM" },
  { id: "ledger_drift", label: "Ledger matches GHL (repaired)", about: "the last 7 days (except the last half hour) compared with GHL and repaired: a contact GHL added that the ledger lacks is pulled in (New lead fires once); one GHL no longer has is marked gone; a Sales Call the booking source cancelled before the call is set to cancelled in GHL (mode rules apply) and in the ledger; otherwise GHL's filed outcome replaces the ledger's. Every repair is logged; what cannot be repaired (an unmatched record, a cancel at an unknown time, a write the mode holds back) is an alert (D73)" },
  { id: "calendly_token", label: "Calendly token", about: "the token still answers (companies that book through Calendly)" },
  { id: "calendly_calendars", label: "Calendly event types bookable", about: "every mapped event type is active and has available times over the next 7 days; a host's calendar disconnecting shows up here" },
  { id: "whop_key", label: "Whop key", about: "the API key still reads payments" },
  { id: "whop_webhook", label: "Whop webhook", about: "the payment webhook the engine registered still exists and is enabled" },
  { id: "fathom_key", label: "Fathom key", about: "the API key still lists meetings" },
  { id: "fathom_webhook", label: "Fathom webhook", about: "the recording webhook is still registered (or, when Fathom cannot list webhooks, that deliveries keep arriving)" },
  { id: "slack", label: "Slack", about: "the bot token is alive and the bot is in every channel the workflows post to" },
  { id: "anthropic", label: "Anthropic key", about: "the AI key still answers (the company's, else the server's)" },
  { id: "jev", label: "Jev (reply reading)", about: "the TypeSafe AI key still answers; without it every reply goes to a person" },
  { id: "steps", label: "Every step can fire", about: "each enabled workflow's steps are walked and everything they depend on outside the engine is checked: bindings exist in the CRM, channels have the bot, prompts and keys are set, custom objects and events exist, hand-off targets are on; kinds that cannot be verified are listed as such" },
  { id: "urls", label: "Links in copy", about: "every fixed http(s) link a message sends (booking pages, forms) still answers; a link that moved is an alert" },
];

export async function ensureHealth(c: PoolClient, companyId: string): Promise<HealthRow> {
  await c.query("insert into health_checks (company_id) values ($1) on conflict (company_id) do nothing", [companyId]);
  return (await one<HealthRow>(c, "select * from health_checks where company_id=$1", [companyId]))!;
}

/** The outside calls the sweep makes, injectable so the engine's logic is tested without the vendors. */
export type HealthProbes = {
  ghlLocationOk: typeof ghlLocationOk; ghlFreeSlots: typeof ghlFreeSlots; ghlCatalog: typeof ghlCatalog; ghlCalendarTeam: typeof ghlCalendarTeam;
  calendlyWhoAmI: typeof calendlyWhoAmI; calendlyAvailableTimes: typeof calendlyAvailableTimes;
  calendlyEventTypeHosts: typeof calendlyEventTypeHosts; calendlyEventTypeSchedules: typeof calendlyEventTypeSchedules; calendlyBusyTimes: typeof calendlyBusyTimes;
  whopPing: typeof whopPing; whopGetWebhook: typeof whopGetWebhook; fathomPing: typeof fathomPing; fathomListWebhooks: typeof fathomListWebhooks; anthropicPing: typeof anthropicPing; jevPing?: typeof jevPing;
  urlOk: (url: string) => Promise<{ ok: boolean; status?: number; error?: string }>;
  /** the CRM reads the drift check compares with (D73); without them the check does not run */
  ghl?: GhlReads;
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
/** Wait between re-asks of a vendor that did not answer; 0 in tests. */
export let PROBE_RETRY_MS = 3000;
export const setProbeRetryMs = (ms: number) => { PROBE_RETRY_MS = ms; };
export const liveProbes: HealthProbes = { ghlLocationOk, ghlFreeSlots, ghlCatalog, ghlCalendarTeam, calendlyWhoAmI, calendlyAvailableTimes, calendlyEventTypeHosts, calendlyEventTypeSchedules, calendlyBusyTimes, whopPing, whopGetWebhook, fathomPing, fathomListWebhooks, anthropicPing, jevPing, urlOk, ghl: liveGhlReads };

const DAYS_AHEAD = 7;
type SlotRead = { name: string; id: string; slots: number; href?: string; times: string[] };

/** Runs every enabled check for one company. Read-only against every vendor. */
export async function sweep(c: PoolClient, company: CompanyRow, adapters: Adapters, probes: HealthProbes, row: HealthConfig, now = DateTime.now()): Promise<Finding[]> {
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

  // Duplicates: one person the CRM holds twice (D63). Replica reads plus one CRM read per suspect record; nothing is merged here
  if (on("duplicates")) out.push(...(await findDuplicates(c, company, ac, adapters, connected)));
  if (on("ledger_drift") && connected && probes.ghl) out.push(...(await ledgerDrift(c, company, ac, bindings, probes.ghl, adapters, row.run_id, now)));

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
  if (on("fathom_key") && bindings["secret.fathom_api_key"]) {
    // a vendor hiccup is not news: ask up to three times, a few seconds apart, before saying anything (D69: no alert on nothing)
    let r = await probes.fathomPing(bindings["secret.fathom_api_key"]);
    for (let i = 0; i < 2 && r !== true && !(r && typeof r === "object" && (r.status === 401 || r.status === 403)); i++) { await new Promise((ok) => setTimeout(ok, PROBE_RETRY_MS)); r = await probes.fathomPing(bindings["secret.fathom_api_key"]); }
    if (r === true) ok("fathom_key", "Key lists meetings.");
    // only a 401/403 means the key is wrong; anything else is Fathom not answering, and says so with its status (D69: no alert on a guess)
    else if (r && typeof r === "object" && (r.status === 401 || r.status === 403)) bad("fathom_key", "error", `Fathom API key rejected (${r.status}): ${r.detail || "no detail"}. Replace it in Setup.`);
    else bad("fathom_key", "warning", `Fathom did not answer the key check (${r && typeof r === "object" ? (r.status ?? "network error") : "no answer"}${r && typeof r === "object" && r.detail ? `: ${r.detail}` : ""}). The key may be fine; checked again next sweep.`);
  }
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
  if (on("jev") && probes.jevPing) {
    const key = bindings["secret.jev_key"] || process.env.JEV_API_KEY;
    if (!key) bad("jev", "warning", "No Jev key: every reply to a text goes to a person to read.");
    else { const r = await probes.jevPing(key); if (r.ok) ok("jev", `${bindings["secret.jev_key"] ? "Company" : "Server"} key answers.`); else bad("jev", "error", `Jev key rejected: ${r.error}`); }
  }
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
            if (!v) {
              const post = def.nodes.find((n) => n.id === r.node); const fb = post?.type === "slack_post" && post.fallback_channel ? post.fallback_channel.replace(/[{}\s]/g, "") : undefined;
              if (fb && bindings[fb]) break;   // D58: the post falls back to a bound channel
              if (r.value.startsWith("slack.channel.")) miss(`step ${r.node} posts to ${r.value}, which is not bound; those posts are skipped.`, "warning"); else miss(`step ${r.node} needs ${r.value}, which is not bound.`); break; }
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
          case "event": if (!events.has(r.value)) miss(r.what === "the event it records" ? `step ${r.node} records "${r.value}", which is not an event type the ledger accepts.` : `trigger ${r.node} listens for "${r.value}", which the engine never emits.`); else verified++; break;
          case "anthropic": if (!(bindings["secret.anthropic_key"] || process.env.ANTHROPIC_API_KEY)) miss(`step ${r.node} needs an Anthropic key and none is set.`); else verified++; break;
          case "slack": if (!conn) miss(`step ${r.node} posts to Slack, which is not connected; those posts are skipped.`, "warning"); else verified++; break;
          case "url": verified++; break;   // checked once per unique link under "urls"
          case "webhook": break;           // not probed (VERIFIES says why)
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

/**
 * D63. "The 2 phone numbers should register as the same person ideally and we should be alerted if there are 2 contacts
 * with phone numbers in different formats." D60 folds the two CRM records into one engine person; this says so, once per
 * person, until the CRM merge lands. Two shapes: one engine person with two current `ghl_contact` identifiers (the poll
 * matched them by phone or email), and two engine persons whose current phones or emails differ only in spelling (a
 * non-US number with and without its plus, an email in two cases). GHL is the source of truth: nobody merges here. When
 * the CRM no longer has one of the records (the merge happened), that id is retired on the replica (or the lone person
 * stamped `gone_at`, as G21 does), so the finding clears and its alert resolves on this sweep.
 */
async function findDuplicates(c: PoolClient, company: CompanyRow, ac: Company, adapters: Adapters, connected: boolean): Promise<Finding[]> {
  const out: Finding[] = [];
  const crmUrl = (ghlId: string | null) => (ac.locationId && ghlId ? `https://app.gohighlevel.com/v2/location/${ac.locationId}/contacts/detail/${ghlId}` : undefined);
  const page = (id: string) => `/app/c/${company.slug}/contacts/${id}`;
  const nameOf = (r: { first_name: string | null; last_name: string | null; email?: string | null; phone?: string | null }) => `${r.first_name ?? ""} ${r.last_name ?? ""}`.trim() || r.email || r.phone || "a contact";
  // the CRM is asked about every suspect record before anything is said: a record it no longer has (404, or a "not found" body on any
  // status) is the one the merge dropped; a CRM that cannot be read is "unknown", and an unconfirmed pair is never alerted (D69)
  const presence = async (ghlId: string): Promise<"present" | "gone" | "unknown"> => {
    if (!connected) return "unknown";
    return crmPresence((id) => adapters.read.getContact(ac, id), ghlId);
  };
  const push = (item: string, text: string, ghlId: string | null, contactId: string, detail: Record<string, unknown>) =>
    out.push({ check: "duplicates", item, key: `duplicate:${item}`, ok: false, level: "warning", text, detail, href: crmUrl(ghlId) ?? page(contactId), hrefLabel: crmUrl(ghlId) ? "Open in the CRM" : "Open the contact", page: page(contactId) });

  // 1. one engine person, two current CRM ids
  type Folded = { id: string; first_name: string | null; last_name: string | null; ghl_contact_id: string | null; ids: string[]; phones: string[]; emails: string[] };
  const folded = await many<Folded>(c, `
    select ct.id, ct.first_name, ct.last_name, ct.ghl_contact_id,
      array(select value from contact_identifiers where contact_id=ct.id and kind='ghl_contact' and retired_at is null order by created_at, value) as ids,
      array(select value from contact_identifiers where contact_id=ct.id and kind='phone' and retired_at is null order by created_at) as phones,
      array(select value from contact_identifiers where contact_id=ct.id and kind='email' and retired_at is null order by created_at) as emails
    from contacts ct where ct.company_id=$1 and ct.gone_at is null
      and (select count(*) from contact_identifiers where contact_id=ct.id and kind='ghl_contact' and retired_at is null) > 1
    order by ct.created_at`, [company.id]);
  for (const f of folded) {
    let ids = f.ids, confirmed = true;
    for (const id of f.ids) {
      const p = await presence(id);
      if (p === "unknown") confirmed = false;
      if (p !== "gone") continue;
      await c.query("update contact_identifiers set retired_at=now() where company_id=$1 and contact_id=$2 and kind='ghl_contact' and value=$3 and retired_at is null", [company.id, f.id, id]);
      ids = ids.filter((x) => x !== id);
      if (f.ghl_contact_id === id && ids.length) { await c.query("update contacts set ghl_contact_id=$2, updated_at=now() where id=$1", [f.id, ids[0]]); f.ghl_contact_id = ids[0]; }   // sends follow the survivor
    }
    if (ids.length < 2 || !confirmed) continue;   // unconfirmed by the CRM: say nothing this sweep rather than alert on the engine's copy
    const shared = [...(f.phones.length === 1 ? [`phone ${f.phones[0]}`] : []), ...(f.emails.length === 1 ? [`email ${f.emails[0]}`] : [])];
    const primary = f.ghl_contact_id && ids.includes(f.ghl_contact_id) ? f.ghl_contact_id : ids[0];
    push(f.id, `${ids.length === 2 ? "Two" : ids.length} CRM records for one person: ${nameOf({ ...f, phone: f.phones[0], email: f.emails[0] })} — ${ids.join(", ")}${shared.length ? ` (same ${shared.join(", ")})` : ""}`, primary, f.id, { contact_id: f.id, ghl_contact_ids: ids, phones: f.phones, emails: f.emails });
  }

  // 2. two engine persons whose current phone or email differ only in spelling (should not happen after D60; proven here)
  type Pair = { kind: string; a_id: string; a_value: string; a_ghl: string | null; a_first: string | null; a_last: string | null; b_id: string; b_value: string; b_ghl: string | null; b_first: string | null; b_last: string | null };
  const pairs = await many<Pair>(c, `
    with cur as (
      select i.contact_id, i.kind, i.value, ct.ghl_contact_id, ct.first_name, ct.last_name, ct.created_at,
        case when i.kind='phone' then regexp_replace(regexp_replace(i.value, '\\D', '', 'g'), '^1(\\d{10})$', '\\1') else lower(regexp_replace(i.value, '\\s', '', 'g')) end as canon
      from contact_identifiers i join contacts ct on ct.id=i.contact_id
      where i.company_id=$1 and i.retired_at is null and i.kind in ('phone','email') and ct.gone_at is null)
    select a.kind, a.contact_id as a_id, a.value as a_value, a.ghl_contact_id as a_ghl, a.first_name as a_first, a.last_name as a_last,
           b.contact_id as b_id, b.value as b_value, b.ghl_contact_id as b_ghl, b.first_name as b_first, b.last_name as b_last
    from cur a join cur b on b.kind=a.kind and b.canon=a.canon and b.contact_id<>a.contact_id and (b.created_at, coalesce(b.ghl_contact_id,''), b.contact_id) > (a.created_at, coalesce(a.ghl_contact_id,''), a.contact_id)
    where a.canon<>'' order by a.created_at, a.ghl_contact_id, a.contact_id, b.created_at, b.ghl_contact_id, b.contact_id`, [company.id]);
  const gone = new Set<string>();
  for (const p of pairs) {
    let confirmed = true;
    for (const [id, ghl] of [[p.a_id, p.a_ghl], [p.b_id, p.b_ghl]] as const) {
      if (gone.has(id)) continue;
      const pr = ghl ? await presence(ghl) : "unknown";
      if (pr === "unknown") { confirmed = false; continue; }
      if (pr !== "gone") continue;
      await c.query("update contacts set gone_at=now(), updated_at=now() where id=$1 and gone_at is null", [id]); gone.add(id);
    }
    if (gone.has(p.a_id) || gone.has(p.b_id) || !confirmed) continue;
    const a = nameOf({ first_name: p.a_first, last_name: p.a_last }), b = nameOf({ first_name: p.b_first, last_name: p.b_last });
    push(`${p.a_id}:${p.b_id}`, `Two CRM records for one person: ${a}${b !== a ? ` / ${b}` : ""} — ${p.a_ghl ?? p.a_id}, ${p.b_ghl ?? p.b_id} (same ${p.kind} ${p.a_value} / ${p.b_value})`, p.a_ghl, p.a_id, { contact_ids: [p.a_id, p.b_id], ghl_contact_ids: [p.a_ghl, p.b_ghl], kind: p.kind, values: [p.a_value, p.b_value] });
  }
  if (!out.length) { const n = (await one<{ n: number }>(c, "select count(*)::int as n from contacts where company_id=$1 and gone_at is null", [company.id]))!.n; out.push({ check: "duplicates", ok: true, level: "warning", text: `${n} contact${n === 1 ? "" : "s"}, none held twice by the CRM.` }); }
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
export async function readCalendars(c: PoolClient, company: CompanyRow, adapters: Adapters, probes: HealthProbes, row: HealthConfig, now = DateTime.now(), only?: string[]): Promise<Finding[]> {
  const { adapterCompany: ac, bindings } = await loadCompany(c, company.id);
  const on = (id: string) => row.checks[id] !== false;
  const out: Finding[] = [];
  const days = Math.min(DAYS_AHEAD, Math.max(1, row.slots_days || DAYS_AHEAD));
  const from = now.toJSDate(), to = now.plus({ days }).toJSDate();
  const connected = !!ac.pit && !!ac.locationId;
  const slotReads: SlotRead[] = [];
  const known = new Map<string, string[]>();   // pooled reads made here, so the per-closer table does not ask again
  const cals = (await many<{ external_id: string; name: string; source: string; booking_url: string | null }>(c, "select external_id, name, source, booking_url from calendars where company_id=$1 and active and source=$2", [company.id, ac.booking.source])).filter((k) => !only || only.includes(k.external_id));
  const link = (k: { external_id: string; source: string; booking_url: string | null }) => calendarLink(k, ac.locationId);
  const ok = (check: string, text: string, item?: string, detail?: Record<string, unknown>, href?: string) => out.push({ check, item, ok: true, level: "warning", text, detail, href, hrefLabel: href ? "Open the calendar" : undefined });
  const bad = (check: string, level: Level, text: string, item?: string, detail?: Record<string, unknown>, href?: string) => out.push({ check, item, ok: false, level, text, detail, href, hrefLabel: href ? "Open the calendar" : undefined });
  if (ac.booking.source === "ghl" && on("ghl_calendars") && connected) {
    for (const cal of cals) {
      const r = await probes.ghlFreeSlots(ac.pit, cal.external_id, from, to, company.timezone);
      if (r.ok) known.set(cal.external_id, r.times);
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
      if (r.ok) known.set(cal.external_id, r.times);
      if (!r.ok) bad("calendly_calendars", "error", `Event type "${cal.name}": availability cannot be read: ${r.error}`, cal.external_id, undefined, link(cal));
      else if (r.slots === 0) bad("calendly_calendars", "warning", `Event type "${cal.name}" has no available time in the next ${days} days. A host's connected calendar may have dropped, or availability is off.`, cal.external_id, undefined, link(cal));
      else { ok("calendly_calendars", `"${cal.name}": ${r.slots} available times in the next ${days} days.`, cal.external_id, { slots: r.slots }, link(cal)); slotReads.push({ name: cal.name, id: cal.external_id, slots: r.slots, href: link(cal), times: r.times }); }
    }
    if (live && !cals.length && !only) ok("calendly_calendars", "No Calendly event types mapped.");
  }
  // Low availability: the calendar is alive but nearly full (or nearly closed); the threshold is the company's own.
  // The thread under it is the same per-closer table /availability answers with (D72), so the two never disagree.
  if (on("availability") && slotReads.length) {
    const low = slotReads.filter((s) => s.slots < row.min_slots);
    for (const s of low) bad("availability", "warning", `"${s.name}" has only ${s.slots} bookable ${s.slots === 1 ? "slot" : "slots"} in the next ${days} days (alert below ${row.min_slots}).`, s.id, { slots: s.slots, min: row.min_slots }, s.href);
    if (!low.length && !only) ok("availability", `${slotReads.length} calendar${slotReads.length === 1 ? "" : "s"} at or above ${row.min_slots} bookable slots over ${days} days.`);
    for (const s of slotReads) if (s.slots >= row.min_slots && only) ok("availability", `"${s.name}": ${s.slots} bookable slots, at or above ${row.min_slots}.`, s.id, { slots: s.slots }, s.href);
    const items = out.filter((x) => x.check === "availability" && x.item);
    if (items.length) {
      const thread = await readAvailability(c, company.id, probes, days, now, known).then(formatAvailability, (e) => `_Open slots by closer could not be read: ${String((e as Error).message).slice(0, 200)}_`);
      for (const f of items) f.thread = thread;
    }
  }
  return out;
}

/**
 * D72. Open slots per closer per day over the next `days` (at most 7), read live: what /availability, the bot's
 * get_availability and the low-availability thread all show. Each offered time comes from the booking source's pooled
 * read (Calendly available times, GHL free slots), which already applies buffers, notice, increments and limits; then it
 * is given to every host free for the whole call then. A time offered by two calendars counts once per closer.
 * Self-check: an offered time no host is free for means the split cannot be trusted, so the per-closer columns are
 * dropped and the day totals are the distinct offered times (`split_error` says so). Nothing is counted that the source
 * does not offer.
 */
export type Availability = {
  metric: "availability"; label: string; definition: string; timezone: string; source: string; read_at: string;
  days: { date: string; label: string; total: number }[];
  /** `short`: the column header, the first name when it is unique on the roster. Empty when the split failed its self-check. */
  closers: { name: string; short: string; per_day: number[]; total: number }[];
  total: number; unreadable: { calendar: string; error: string }[]; split_error?: string;
};
export class AvailabilityUnreadable extends Error {}

/** Is the host free for the whole call from `start`: inside the schedule the event type uses for them (date overrides first), clear of every busy time. */
export function hostFree(start: number, minutes: number, schedule: CalendlySchedule | undefined, busy: { start: number; end: number }[]): boolean {
  if (!schedule) return false;
  const end = start + minutes * 60_000, zone = schedule.timezone;
  const spans: [number, number][] = [];
  for (let d = DateTime.fromMillis(start, { zone }).startOf("day").minus({ days: 1 }); d.toMillis() < end; d = d.plus({ days: 1 })) {
    const date = d.toISODate()!, wday = d.setLocale("en-US").toFormat("cccc").toLowerCase();
    const rule = schedule.rules.find((r) => r.type === "date" && r.date && DateTime.fromFormat(r.date, "yyyy-M-d").toISODate() === date) ?? schedule.rules.find((r) => r.type === "wday" && r.wday === wday);
    for (const iv of rule?.intervals ?? []) spans.push([clock(d, iv.from), clock(d, iv.to)]);
  }
  spans.sort((x, y) => x[0] - y[0]);
  const merged: [number, number][] = [];   // 09:00–12:00 and 12:00–17:00 are one stretch
  for (const sp of spans) { const last = merged[merged.length - 1]; if (last && sp[0] <= last[1]) last[1] = Math.max(last[1], sp[1]); else merged.push([sp[0], sp[1]]); }
  return merged.some(([x, y]) => x <= start && end <= y) && !busy.some((b) => b.start < end && b.end > start);
}
const clock = (d: DateTime, hhmm: string) => { const [h, m] = hhmm.split(":").map(Number); return h >= 24 ? d.plus({ days: 1 }).startOf("day").toMillis() : d.set({ hour: h, minute: m || 0 }).toMillis(); };
const ms = (iso: string) => DateTime.fromISO(iso).toMillis();

export async function readAvailability(c: PoolClient, companyId: string, probes: HealthProbes, days: number, now: DateTime = DateTime.now(), known?: Map<string, string[]>): Promise<Availability> {
  const { row, adapterCompany: ac, bindings } = await loadCompany(c, companyId);
  const n = Math.min(DAYS_AHEAD, Math.max(1, Math.round(days) || DAYS_AHEAD)), tz = row.timezone, ghl = ac.booking.source === "ghl";
  const vendor = ghl ? "GHL" : "Calendly";
  const cals = await many<{ external_id: string; name: string; default_user_id: string | null }>(c, `select cal.external_id, cal.name, cal.default_user_id::text from calendars cal join company_terms t on t.id=cal.appointment_term
    where cal.company_id=$1 and cal.active and cal.source=$2 and t.category='closing' order by cal.name`, [companyId, ac.booking.source]);
  if (!cals.length) throw new AvailabilityUnreadable("no active closing calendars are mapped for this company");
  const roster = await many<{ id: string; name: string; email: string; ghl_user_id: string | null; active: boolean }>(c, "select id::text, name, email, ghl_user_id, active from users where company_id=$1", [companyId]);
  // the API wants a start in the future and a window of at most 7 days (as readCalendars)
  const wFrom = ghl ? now.toJSDate() : now.plus({ minutes: 1 }).toJSDate(), wTo = ghl ? now.plus({ days: n }).toJSDate() : now.plus({ days: n - 1, hours: 23 }).toJSDate();
  const token = bindings["secret.calendly_token"];

  const reads: { cal: (typeof cals)[number]; times: string[] }[] = [], unreadable: { calendar: string; error: string }[] = [];
  for (const k of cals) {
    const hit = known?.get(k.external_id);
    const r = hit ? { ok: true as const, times: hit }
      : ghl ? (ac.pit ? await probes.ghlFreeSlots(ac.pit, k.external_id, wFrom, wTo, tz) : { ok: false as const, error: "no CRM token bound" })
      : await probes.calendlyAvailableTimes(token, `https://api.calendly.com/event_types/${k.external_id}`, wFrom, wTo);
    if (r.ok) reads.push({ cal: k, times: r.times }); else unreadable.push({ calendar: k.name, error: r.error });
  }
  // a live read that failed everywhere is not "zero slots": say the source failed rather than fill the gap
  if (!reads.length) throw new AvailabilityUnreadable(`${vendor} did not answer for any calendar: ${unreadable.map((u) => `${u.calendar}: ${u.error}`).join("; ")}`);

  const people = new Map<string, { name: string; times: Set<number> }>();
  const person = (key: string, name: string) => { if (!people.has(key)) people.set(key, { name, times: new Set() }); return people.get(key)!; };
  let unmatched = 0, why: string | undefined;
  if (ghl) {
    let names: Map<string, string> | undefined;
    const ghlPerson = async (gid: string) => {
      const u = roster.find((x) => x.ghl_user_id === gid);
      if (u) return person(u.id, u.name);
      names ??= new Map((await probes.ghlCatalog(ac.pit, ac.locationId)).users.map((x) => [x.id, x.name]));
      return person(`ghl:${gid}`, names.get(gid) ?? gid);
    };
    for (const { cal, times } of reads) {
      const team = await probes.ghlCalendarTeam(ac.pit, cal.external_id);
      if (!team.ok) { why ??= `the team on "${cal.name}" could not be read (${team.error})`; continue; }
      const owner = !team.userIds.length && cal.default_user_id ? roster.find((x) => x.id === cal.default_user_id) : undefined;
      if (owner || team.userIds.length === 1) { const p = owner ? person(owner.id, owner.name) : await ghlPerson(team.userIds[0]); for (const t of times) p.times.add(ms(t)); continue; }
      const hit = new Set<number>();
      for (const gid of team.userIds) {
        const p = await ghlPerson(gid);
        if (!times.length) continue;
        const r = await probes.ghlFreeSlots(ac.pit, cal.external_id, wFrom, wTo, tz, gid);
        if (!r.ok) { why ??= `${p.name}'s slots on "${cal.name}" could not be read (${r.error})`; continue; }
        const mine = new Set(r.times.map(ms));
        for (const t of times.map(ms)) if (mine.has(t)) { p.times.add(t); hit.add(t); }
      }
      unmatched += new Set(times.map(ms)).size - hit.size;
    }
  } else {
    const busyOf = new Map<string, Awaited<ReturnType<HealthProbes["calendlyBusyTimes"]>>>();   // one read per host, shared by every event type they host
    const busyTo = DateTime.fromJSDate(wFrom).plus({ days: 7 }).minus({ minutes: 1 }).toJSDate();
    const calendlyPerson = (h: CalendlyHost) => { const u = roster.find((x) => x.email.toLowerCase() === h.email.trim().toLowerCase()); return u ? person(u.id, u.name) : person(`calendly:${h.email.toLowerCase()}`, h.name); };
    for (const { cal, times } of reads) {
      const uri = `https://api.calendly.com/event_types/${cal.external_id}`;
      const h = await probes.calendlyEventTypeHosts(token, uri, ac.booking.source === "calendly" ? ac.booking.organization || undefined : undefined);
      if (!h.ok) { why ??= `the hosts of "${cal.name}" could not be read (${h.error})`; continue; }
      const hosts = h.hosts.map((x) => ({ host: x, p: calendlyPerson(x) }));
      if (hosts.length === 1) { for (const t of times) hosts[0].p.times.add(ms(t)); continue; }
      if (!times.length) continue;
      const sch = await probes.calendlyEventTypeSchedules(token, uri);
      if (!sch.ok) { why ??= `the schedule of "${cal.name}" could not be read (${sch.error})`; continue; }
      const shared = sch.schedules.find((x) => !x.user);
      const ready: { p: { times: Set<number> }; schedule?: CalendlySchedule; busy: { start: number; end: number }[] }[] = [];
      for (const { host, p } of hosts) {
        if (!busyOf.has(host.uri)) busyOf.set(host.uri, await probes.calendlyBusyTimes(token, host.uri, wFrom, busyTo));
        const b = busyOf.get(host.uri)!;
        if (!b.ok) { why ??= `${p.name}'s busy times could not be read (${b.error})`; continue; }
        ready.push({ p, schedule: sch.schedules.find((x) => x.user === host.uri) ?? shared, busy: b.busy.map((x) => ({ start: ms(x.start), end: ms(x.end) })) });
      }
      for (const t of new Set(times.map(ms))) {
        let any = false;
        for (const r of ready) if (hostFree(t, h.duration, r.schedule, r.busy)) { r.p.times.add(t); any = true; }
        if (!any) unmatched++;
      }
    }
  }
  if (!why && unmatched) why = `${unmatched} offered ${unmatched === 1 ? "time" : "times"} matched no host's schedule`;

  const start = now.setZone(tz).startOf("day");
  const dates = Array.from({ length: n }, (_, i) => start.plus({ days: i })), keys = dates.map((d) => d.toISODate()!);
  const perDay = (set: Iterable<number>) => { const r = keys.map(() => 0); for (const t of set) { const i = keys.indexOf(DateTime.fromMillis(t, { zone: tz }).toISODate()!); if (i >= 0) r[i]++; } return r; };
  const first = (name: string) => name.trim().split(/\s+/)[0].toLowerCase();
  const everyone = [...roster.filter((u) => u.active).map((u) => u.name), ...[...people.entries()].filter(([k]) => !roster.some((u) => u.active && u.id === k)).map(([, p]) => p.name)];
  const closers = why ? [] : [...people.values()].map((p) => {
    const per_day = perDay(p.times);
    return { name: p.name, short: everyone.filter((x) => first(x) === first(p.name)).length === 1 ? p.name.trim().split(/\s+/)[0] : p.name, per_day, total: per_day.reduce((a, b) => a + b, 0) };
  }).sort((a, b) => a.name.localeCompare(b.name));
  const totals = why ? perDay(new Set(reads.flatMap((r) => r.times.map(ms)))) : keys.map((_, i) => closers.reduce((sum, x) => sum + x.per_day[i], 0));
  return {
    metric: "availability", label: "Calendar availability", timezone: tz, source: `${vendor}, read just now`, read_at: now.toISO()!,
    definition: "open bookable start times on the active closing calendars, read live from the booking source, per closer: a time the calendar offers counts once for each closer free for the whole call then (two closers free at 2pm = 2 open), and once per closer however many calendars offer it",
    days: dates.map((d, i) => ({ date: keys[i], label: d.toFormat("ccc LLL d"), total: totals[i] })), closers, total: totals.reduce((a, b) => a + b, 0), unreadable,
    ...(why ? { split_error: `Could not split by closer: ${why}` } : {}),
  };
}

/** The health_check step: run the checks (availability is its own step), remember the result, turn failures into alerts and clear the ones that passed. */
export async function runHealthStep(c: PoolClient, company: CompanyRow, adapters: Adapters, probes: HealthProbes, cfg: HealthConfig & { as_name?: string | null; as_icon?: string | null }, now = DateTime.now()): Promise<{ findings: Finding[]; raised: number; resolved: number }> {
  await ensureHealth(c, company.id);
  const findings = (await sweep(c, company, adapters, probes, { ...cfg, checks: { ...cfg.checks, availability: false } }, now)).filter((f) => f.check !== "availability");
  const prev = (await one<{ last_result: Finding[] }>(c, "select last_result from health_checks where company_id=$1", [company.id]))?.last_result ?? [];
  await c.query("update health_checks set last_run_at=$2, last_result=$3, channel=$4, as_name=$5, as_icon=$6 where company_id=$1", [company.id, now.toJSDate(), JSON.stringify([...findings, ...prev.filter((f) => f.check === "availability")]), cfg.channel ?? null, cfg.as_name ?? null, cfg.as_icon ?? null]);
  const present = findings.filter((f) => !f.ok).map((f) => toAlert(company, f));
  const r = await reconcile(c, company.id, "health", present, now.toJSDate(), undefined, "health:availability");
  return { findings, ...r };
}

/** The availability_check step: bookable slots on every active calendar, or on one (the run's booking). Low ones are alerts with the day-by-day in the thread. */
export async function runAvailabilityStep(c: PoolClient, company: CompanyRow, adapters: Adapters, probes: HealthProbes, cfg: { min_slots: number; days: number }, now = DateTime.now(), only?: string[]): Promise<{ findings: Finding[]; raised: number; resolved: number }> {
  await ensureHealth(c, company.id);
  const findings = (await readCalendars(c, company, adapters, probes, { checks: { ghl_calendars: true, calendly_calendars: true, availability: true }, min_slots: cfg.min_slots, slots_days: cfg.days }, now, only)).filter((f) => f.check === "availability");
  const prev = (await one<{ last_result: Finding[] }>(c, "select last_result from health_checks where company_id=$1", [company.id]))?.last_result ?? [];
  const kept = prev.filter((f) => f.check !== "availability" || (only && f.item && !only.includes(f.item)));
  await c.query("update health_checks set last_result=$2 where company_id=$1", [company.id, JSON.stringify([...kept, ...findings])]);
  const present = findings.filter((f) => !f.ok).map((f) => toAlert(company, f));
  let raised = 0, resolved = 0;
  for (const prefix of only?.length ? only.map((id) => `health:availability:${id}`) : ["health:availability"]) { const r = await reconcile(c, company.id, "health", present.filter((p) => p.key.startsWith(prefix)), now.toJSDate(), prefix); raised += r.raised; resolved += r.resolved; }
  return { findings, raised, resolved };
}
const toAlert = (company: CompanyRow, f: Finding): AlertInput => ({ companyId: company.id, key: f.key ?? `health:${f.check}${f.item ? `:${f.item}` : ""}`, level: f.level, source: "health", text: f.text, detail: { ...(f.detail ?? {}), ...(f.fix ? { fix: f.fix } : {}), ...(f.href ? { link: f.href, link_label: f.hrefLabel } : {}), ...(f.thread ? { thread: f.thread } : {}) }, href: f.page ?? `/app/c/${company.slug}/health` });
