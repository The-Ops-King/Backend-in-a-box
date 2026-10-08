"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { asOperator } from "@/db/client";
import { loadCompany } from "@/engine/context";
import { setBinding, clearBinding, type BindingKind } from "@/engine/settings";
import { encrypt } from "@/engine/crypto";
import { liveAdapters } from "@/adapters";
import { bookingFor } from "@/adapters/types";
import { calendlyUserByEmail, calendlyWhoAmI } from "@/adapters/calendly/read";
import { fathomCreateWebhook } from "@/adapters/fathom/client";
import { whopCreateWebhook } from "@/adapters/whop/client";
import { proposeConfig, applyProposal, storeProposal, loadProposal, clearProposal, termsFor, type ConfigFacts } from "@/engine/describe-config";
import { ghlCatalog } from "@/adapters/ghl/catalog";
import { many } from "@/db/client";
import { ensureSchedules, generateReport, periodFor, REPORT_KINDS, type ReportKind } from "@/engine/reports";
import { CHECKS, ensureHealth, sweepCompany } from "@/engine/health";
import { announceDue } from "@/engine/alerts";
import { DateTime } from "luxon";

const back = (slug: string, q: Record<string, string>, hash = "") => { revalidatePath(`/c/${slug}/settings`); revalidatePath(`/c/${slug}`); redirect(`/c/${slug}/settings?${new URLSearchParams(q).toString()}${hash}`); };
const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
const audit = (c: Parameters<Parameters<typeof asOperator>[0]>[0], companyId: string, action: string, after: Record<string, unknown>) => c.query("insert into audit_log (company_id, action, target_type, target_id, after) values ($1,$2,'company',$1,$3)", [companyId, action, after]);

export async function saveCompanyAction(f: FormData) {
  const slug = str(f, "slug"), companyId = str(f, "companyId");
  const price = str(f, "contract_value_default");
  await asOperator(async (c) => {
    await c.query(`update companies set eod_enabled=$2, eod_at=$3 where id=$1`, [companyId, f.get("eod_enabled") === "on", /^\d{2}:\d{2}$/.test(str(f, "eod_at")) ? str(f, "eod_at") : "18:00"]);
    await c.query(`update companies set name=$2, timezone=$3, sms_enabled=$4, send_window_start=$5, send_window_end=$6, quiet_allow_transactional=$7, contract_value_default=$8, reached_seconds=$9 where id=$1`,
      [companyId, str(f, "name"), str(f, "timezone"), f.get("sms_enabled") === "on", str(f, "send_window_start") || "08:00", str(f, "send_window_end") || "20:00", f.get("quiet_allow_transactional") === "on", price ? Number(price) : null, Math.max(1, Number(str(f, "reached_seconds")) || 60)]);
    await audit(c, companyId, "company.settings", { name: str(f, "name"), timezone: str(f, "timezone"), sms: f.get("sms_enabled") === "on", window: [str(f, "send_window_start"), str(f, "send_window_end")], transactional_in_dark: f.get("quiet_allow_transactional") === "on", price });
  });
  back(slug, { note: "Company saved" }, "#company");
}

/** Every field named b:<key> (with kind in k:<key>) is a binding. Empty leaves it as is; clear:<key> removes it. */
export async function saveBindingsAction(f: FormData) {
  const slug = str(f, "slug"), companyId = str(f, "companyId"), section = str(f, "section");
  let set = 0, cleared = 0; const notes: string[] = []; let error = "";
  await asOperator(async (c) => {
    const touched = new Set<string>();
    for (const [name, raw] of f.entries()) {
      if (name.startsWith("clear:") && raw === "on") { await clearBinding(c, companyId, name.slice(6)); cleared++; continue; }
      if (!name.startsWith("b:")) continue;
      const key = name.slice(2), value = String(raw).trim(); if (!value) continue;
      const kind = (str(f, `k:${key}`) || (key.startsWith("secret.") ? "secret" : key.startsWith("prompt.") || key.startsWith("calendly.") || key.startsWith("booking.") ? "text" : key.startsWith("slack.channel.") ? "channel" : "id")) as BindingKind;
      await setBinding(c, companyId, key, kind, value); set++; touched.add(key);
    }
    // a provider key is enough: the engine registers its own webhook the moment it has one (no button, no secret to paste)
    const base = (process.env.PUBLIC_URL ?? process.env.TICK_URL ?? "").replace(/\/$/, "");
    if (touched.size && base) {
      const { bindings } = await loadCompany(c, companyId);
      if (touched.has("secret.fathom_api_key") && !bindings["secret.fathom_webhook"]) {
        try { const hook = await fathomCreateWebhook(bindings["secret.fathom_api_key"], `${base}/api/webhooks/fathom/${companyId}`); await setBinding(c, companyId, "secret.fathom_webhook", "secret", hook.secret); await setBinding(c, companyId, "fathom.webhook_id", "id", hook.id); notes.push(`Fathom webhook registered (${hook.id})`); }
        catch (e) { error = `Fathom key saved, but registering the webhook failed: ${String((e as Error).message).slice(0, 140)}`; }
      }
      if (touched.has("secret.whop_api_key") && !bindings["secret.whop_webhook"]) {
        try { const hook = await whopCreateWebhook(bindings["secret.whop_api_key"], `${base}/api/webhooks/whop/${companyId}`); await setBinding(c, companyId, "secret.whop_webhook", "secret", hook.webhook_secret); await setBinding(c, companyId, "whop.webhook_id", "id", hook.id); notes.push(`Whop webhook created (${hook.id})`); }
        catch (e) { error = `Whop key saved, but creating the webhook failed: ${String((e as Error).message).slice(0, 140)}`; }
      }
    }
  });
  const note = `${section || "Settings"}: ${set} saved${cleared ? `, ${cleared} cleared` : ""}${notes.length ? ` · ${notes.join(" · ")}` : ""}`;
  back(slug, error ? { error: `${note}. ${error}` } : { note }, section ? `#${section}` : "");
}

/** Prove the CRM connection and refresh the roster from it. */
export async function testGhlAction(f: FormData) {
  const slug = str(f, "slug"), companyId = str(f, "companyId");
  let note = "", error = "";
  await asOperator(async (c) => {
    const { adapterCompany } = await loadCompany(c, companyId);
    if (!adapterCompany.pit || !adapterCompany.locationId) { error = "Location id and PIT must both be set first."; return; }
    try {
      const users = await liveAdapters.read.listUsers(adapterCompany);
      for (const u of users) await c.query(`insert into users (company_id, email, name, role, ghl_user_id) values ($1,$2,$3,'closer',$4) on conflict (company_id, ghl_user_id) do update set name=excluded.name`, [companyId, u.email ?? `${u.id}@unclaimed.local`, u.name || u.id, u.id]);
      note = `GHL connected: ${users.length} users on the roster`;
    } catch (e) { error = `GHL refused: ${String((e as Error).message).slice(0, 160)}`; }
  });
  back(slug, error ? { error } : { note }, "#connections");
}

/** Switch or configure the booking source. Calendly needs a read token; the host email narrows event types to one person. */
export async function setBookingSourceAction(f: FormData) {
  const slug = str(f, "slug"), companyId = str(f, "companyId"), source = str(f, "source");
  let error = "", note = "";
  await asOperator(async (c) => {
    const { bindings } = await loadCompany(c, companyId);
    if (source === "ghl") {
      await c.query("delete from bindings where company_id=$1 and key in ('secret.calendly_token','calendly.organization','calendly.user','calendly.phone_question','calendly.setter_question')", [companyId]);
      await c.query("update calendars set active=false where company_id=$1 and source<>'ghl'", [companyId]);
      note = "Booking source: GHL calendars"; return;
    }
    const token = str(f, "token") || bindings["secret.calendly_token"];
    if (!token) { error = "Paste the Calendly token."; return; }
    try {
      const me = await calendlyWhoAmI(token);
      const email = str(f, "userEmail"); const user = email ? await calendlyUserByEmail(token, me.organization, email) : undefined;
      if (email && !user) { error = `No Calendly member has the email ${email}`; return; }
      await setBinding(c, companyId, "secret.calendly_token", "secret", token); await setBinding(c, companyId, "calendly.organization", "id", me.organization);
      await setBinding(c, companyId, "calendly.user", "id", user ?? ""); await setBinding(c, companyId, "calendly.phone_question", "text", str(f, "phoneQuestion")); await setBinding(c, companyId, "calendly.setter_question", "text", str(f, "setterQuestion"));
      await c.query("update calendars set active=false where company_id=$1 and source<>'calendly'", [companyId]);
      note = `Calendly connected as ${me.name} (${me.email})${user ? `, scoped to ${email}` : ""}`;
    } catch (e) { error = `Calendly refused: ${String((e as Error).message).slice(0, 160)}`; }
  });
  back(slug, error ? { error } : { note }, "#booking");
}

/** Map one calendar from the booking source: call type, how setter-vs-self is decided, which questions mean what. */
export async function saveCalendarAction(f: FormData) {
  const slug = str(f, "slug"), companyId = str(f, "companyId"), externalId = str(f, "externalId");
  const questions: Record<string, string> = {};
  // the calendar's own questions, each with the name it should be known by ("use as"); blank = ignored
  for (const [k, v] of f.entries()) { const m = /^use:(\d+)$/.exec(k); if (!m) continue; const name = String(v).trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, ""); const q = str(f, `q:${m[1]}`); if (name && q) questions[name] = q; }
  for (const line of str(f, "questions").split(/\r?\n/)) { const m = /^\s*([a-zA-Z0-9_]+)\s*=\s*(.+?)\s*$/.exec(line); if (m) questions[m[1]] = m[2]; }
  const booking = str(f, "booking"); const term = str(f, "term");
  let error = "";
  await asOperator(async (c) => {
    const { adapterCompany } = await loadCompany(c, companyId);
    if (!term) { error = "Pick a call type."; return; }
    const config = { ...(booking && booking !== "company" ? { booking } : {}), ...(Object.keys(questions).length ? { questions } : {}) };
    const selfBooked = booking === "self" ? true : booking === "setter" ? false : null;
    await c.query(`insert into calendars (company_id, source, external_id, name, appointment_term, self_booked, booking_url, config, active) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      on conflict (company_id, source, external_id) do update set name=excluded.name, appointment_term=excluded.appointment_term, self_booked=excluded.self_booked, booking_url=coalesce(excluded.booking_url, calendars.booking_url), config=excluded.config, active=excluded.active`,
      [companyId, adapterCompany.booking.source, externalId, str(f, "name") || externalId, term, selfBooked, str(f, "bookingUrl") || null, JSON.stringify(config), f.get("active") !== "off"]);
    if (f.get("active") === "off") await c.query("delete from poll_cursors where company_id=$1 and entity=$2", [companyId, `appointments:${externalId}`]);
    if (str(f, "role") === "closer_call") await setBinding(c, companyId, "calendar.closer_call", "id", externalId);
    if (str(f, "role") === "booking") await setBinding(c, companyId, "calendar.booking", "id", externalId);
    await audit(c, companyId, "calendar.mapped", { externalId, term, booking, questions: Object.keys(questions), active: f.get("active") !== "off" });
  });
  back(slug, error ? { error } : { note: `Calendar saved` }, "#calendars");
}

export async function registerFathomAction(f: FormData) {
  const slug = str(f, "slug"), companyId = str(f, "companyId");
  let error = "", note = "";
  await asOperator(async (c) => {
    const { bindings } = await loadCompany(c, companyId);
    const key = str(f, "apiKey") || bindings["secret.fathom_api_key"];
    if (!key) { error = "Paste the Fathom API key first."; return; }
    const base = (process.env.PUBLIC_URL ?? process.env.TICK_URL ?? "").replace(/\/$/, "");
    if (!base) { error = "PUBLIC_URL is not set on the server."; return; }
    try {
      if (str(f, "apiKey")) await setBinding(c, companyId, "secret.fathom_api_key", "secret", key);
      const hook = await fathomCreateWebhook(key, `${base}/api/webhooks/fathom/${companyId}`);
      await setBinding(c, companyId, "secret.fathom_webhook", "secret", hook.secret); await setBinding(c, companyId, "fathom.webhook_id", "id", hook.id);
      note = `Fathom webhook registered (${hook.id}). Recordings now arrive directly.`;
    } catch (e) { error = `Fathom refused: ${String((e as Error).message).slice(0, 160)}`; }
  });
  back(slug, error ? { error } : { note }, "#connections");
}

/** A Slack bot token (xoxb-…): verified with auth.test, stored encrypted; channel ids are bindings. */
export async function saveSlackAction(f: FormData) {
  const slug = str(f, "slug"), companyId = str(f, "companyId"), token = str(f, "botToken");
  let error = "", note = "";
  if (token === "disconnect") { await asOperator((c) => c.query("delete from slack_connections where company_id=$1", [companyId])); back(slug, { note: "Slack disconnected" }, "#slack"); }
  if (!token) back(slug, { error: "Paste the bot token." }, "#slack");
  try {
    const r = await fetch("https://slack.com/api/auth.test", { method: "POST", headers: { Authorization: `Bearer ${token}` } });
    const d = (await r.json()) as { ok: boolean; team_id?: string; team?: string; user?: string; error?: string };
    if (!d.ok) error = `Slack refused the token: ${d.error}`;
    else { await asOperator((c) => c.query(`insert into slack_connections (company_id, team_id, bot_token) values ($1,$2,$3) on conflict (company_id) do update set team_id=excluded.team_id, bot_token=excluded.bot_token, connected_at=now()`, [companyId, d.team_id, encrypt(token)])); note = `Slack connected to ${d.team} as ${d.user}`; }
  } catch (e) { error = String((e as Error).message); }
  back(slug, error ? { error } : { note }, "#slack");
}


/** Call types: the company's own words for the four core categories, plus extra named types. */
export async function saveCallTypesAction(f: FormData) {
  const slug = str(f, "slug"), companyId = str(f, "companyId");
  await asOperator(async (c) => {
    for (const [k, v] of f.entries()) {
      const m = /^term:([0-9a-f-]{36}):(name|category|active)$/.exec(k); if (!m) continue;
      const [, id, field] = m; const val = String(v).trim();
      if (field === "name" && val) await c.query("update company_terms set name=$3 where id=$1 and company_id=$2", [id, companyId, val]);
      if (field === "category" && val) await c.query("update company_terms set category=$3 where id=$1 and company_id=$2 and domain='appointment_type'", [id, companyId, val]);
      if (field === "active") await c.query("update company_terms set active=$3 where id=$1 and company_id=$2", [id, companyId, val === "on"]);
    }
    const name = str(f, "new_name"), category = str(f, "new_category");
    if (name && category) await c.query("insert into company_terms (company_id, domain, name, category, sort) values ($1,'appointment_type',$2,$3,(select coalesce(max(sort),0)+1 from company_terms where company_id=$1 and domain='appointment_type')) on conflict (company_id, domain, name) do update set category=excluded.category, active=true", [companyId, name, category]);
    await audit(c, companyId, "call_types.saved", { added: name || null });
  });
  back(slug, { note: "Call types saved" }, "#calltypes");
}

async function facts(c: Parameters<Parameters<typeof asOperator>[0]>[0], companyId: string): Promise<{ facts: ConfigFacts; source: string }> {
  const { adapterCompany, bindings } = await loadCompany(c, companyId);
  let calendars: ConfigFacts["calendars"] = [];
  try { calendars = await bookingFor(liveAdapters, adapterCompany).listCalendars(adapterCompany); } catch { /* listed as none; the model will ask */ }
  const mapped = await many<{ external_id: string; term_category: string; config: { booking?: string; questions?: Record<string, string> } }>(c, "select cal.external_id, t.category as term_category, cal.config from calendars cal join company_terms t on t.id=cal.appointment_term where cal.company_id=$1 and cal.active", [companyId]);
  const users = await many<{ id: string; name: string; email: string }>(c, "select ghl_user_id as id, name, email from users where company_id=$1 and active and ghl_user_id is not null order by name", [companyId]);
  const catalog = adapterCompany.pit && adapterCompany.locationId ? await ghlCatalog(adapterCompany.pit, adapterCompany.locationId) : null;
  return { source: adapterCompany.booking.source, facts: { calendars, mapped: mapped.map((m) => ({ external_id: m.external_id, term_category: m.term_category, booking: m.config?.booking, questions: m.config?.questions })), users, catalog, terms: await termsFor(c, companyId), setterRule: bindings["booking.setter_rule"], defaultCloser: bindings["crm.default_closer"] } };
}

/** "This is how we do things here": the description plus the live facts go to the model; the proposal waits for approval. */
export async function describeConfigAction(f: FormData) {
  const slug = str(f, "slug"), companyId = str(f, "companyId"), text = str(f, "text");
  if (!text) back(slug, { error: "Write how things work first." }, "#describe");
  let error = "";
  await asOperator(async (c) => {
    const { bindings } = await loadCompany(c, companyId);
    const key = bindings["secret.anthropic_key"] || process.env.ANTHROPIC_API_KEY;
    if (!key) { error = "No Anthropic key: set one in Connections (or on the server) first."; return; }
    try { const { facts: fx } = await facts(c, companyId); const proposal = await proposeConfig(key, fx, text); await storeProposal(c, companyId, text, proposal); }
    catch (e) { error = `Could not read that: ${String((e as Error).message).slice(0, 200)}`; }
  });
  back(slug, error ? { error } : { note: "Read it. Check the proposal below, then apply or discard." }, "#describe");
}
export async function applyProposalAction(f: FormData) {
  const slug = str(f, "slug"), companyId = str(f, "companyId");
  let note = "", error = "";
  await asOperator(async (c) => {
    const p = await loadProposal(c, companyId); if (!p) { error = "No proposal waiting."; return; }
    const { facts: fx, source } = await facts(c, companyId);
    const done = await applyProposal(c, companyId, source, p.value.proposal.operations, fx.calendars);
    await clearProposal(c, companyId); note = done.length ? `Applied: ${done.join("; ")}` : "Nothing to apply.";
  });
  back(slug, error ? { error } : { note }, "#calendars");
}
export async function discardProposalAction(f: FormData) {
  const slug = str(f, "slug"), companyId = str(f, "companyId");
  await asOperator((c) => clearProposal(c, companyId));
  back(slug, { note: "Proposal discarded" }, "#describe");
}

/** One form per wrap-up kind: on/off, local time, day, channel, breakdowns, sections. */
export async function saveReportScheduleAction(f: FormData) {
  const slug = str(f, "slug"), companyId = str(f, "companyId"), kind = str(f, "kind") as ReportKind;
  if (!REPORT_KINDS.includes(kind)) return;
  const breakdowns = ["setter", "closer"].filter((b) => f.get(`breakdown:${b}`) === "on");
  const at = /^\d{2}:\d{2}$/.test(str(f, "at_time")) ? str(f, "at_time") : "19:00";
  await asOperator(async (c) => {
    await ensureSchedules(c, companyId);
    await c.query(`update wrapup_schedules set enabled=$3, at_time=$4, weekday=$5, day_of_month=$6, channel=nullif($7,''), breakdowns=$8, sections=$9 where company_id=$1 and kind=$2`,
      [companyId, kind, f.get("enabled") === "on", at, Math.min(7, Math.max(1, Number(str(f, "weekday")) || 1)), Math.min(28, Math.max(1, Number(str(f, "day_of_month")) || 1)), str(f, "channel"), breakdowns, { what_they_said: f.get("section:what_they_said") === "on" }]);
    await audit(c, companyId, "report.schedule", { kind, enabled: f.get("enabled") === "on", at, breakdowns });
  });
  back(slug, { note: `${kind} wrap-up saved` }, "#reports");
}

/** Generates the period in progress right now (today so far, this week so far, this month so far) and posts it like a scheduled one would. */
export async function runReportNowAction(f: FormData) {
  const slug = str(f, "slug"), companyId = str(f, "companyId"), kind = str(f, "kind") as ReportKind;
  if (!REPORT_KINDS.includes(kind)) return;
  const r = await asOperator(async (c) => {
    const { row, bindings } = await loadCompany(c, companyId);
    const s = (await ensureSchedules(c, companyId)).find((x) => x.kind === kind)!;
    return generateReport(c, row, bindings, s, periodFor(kind, DateTime.now().setZone(row.timezone), true), { onDemand: true, toDate: true });
  });
  revalidatePath(`/c/${slug}/reports`);
  redirect(`/c/${slug}/reports?note=${encodeURIComponent(r.posted ? `${kind} wrap-up posted to Slack` : `${kind} wrap-up generated (${r.why === "shadow" ? "shadow: not posted" : r.why ?? "not posted"})`)}#${r.id}`);
}

/** The hourly sweep's own settings (D33): on/off, how often, where it posts, who it posts as, which checks run. */
export async function saveHealthAction(f: FormData) {
  const slug = str(f, "slug"), companyId = str(f, "companyId");
  const every = Math.min(1440, Math.max(5, Number(str(f, "every_minutes")) || 60));
  const checks = Object.fromEntries(CHECKS.map((c) => [c.id, f.get(`check:${c.id}`) === "on"]));
  await asOperator(async (c) => {
    await ensureHealth(c, companyId);
    const minSlots = Math.max(0, Number(str(f, "min_slots")) || 0), slotsDays = Math.min(7, Math.max(1, Number(str(f, "slots_days")) || 7));
    await c.query("update health_checks set enabled=$2, every_minutes=$3, channel=nullif($4,''), as_name=nullif($5,''), as_icon=nullif($6,''), checks=$7, min_slots=$8, slots_days=$9 where company_id=$1", [companyId, f.get("enabled") === "on", every, str(f, "channel"), str(f, "as_name"), str(f, "as_icon"), checks, minSlots, slotsDays]);
    await audit(c, companyId, "health.settings", { enabled: f.get("enabled") === "on", every, checks });
  });
  back(slug, { note: "Health check saved" }, "#health");
}

/** Sweep this company now and say what it found, the way the hourly run would. */
export async function runHealthNowAction(f: FormData) {
  const slug = str(f, "slug"), companyId = str(f, "companyId");
  const r = await asOperator(async (c) => { const s = await sweepCompany(c, companyId, liveAdapters); const a = await announceDue(c, liveAdapters); return { ...s, ...a }; });
  const failing = r.findings.filter((x) => !x.ok).length;
  revalidatePath(`/c/${slug}/health`);
  redirect(`/c/${slug}/health?note=${encodeURIComponent(`Swept ${r.findings.length} checks: ${failing ? `${failing} failing` : "all fine"}${r.raised ? `, ${r.raised} new alert${r.raised > 1 ? "s" : ""} posted` : ""}${r.resolved ? `, ${r.resolved} resolved` : ""}`)}`);
}

/** "Click to fix" (D33): make the webhook again, bind the new secret and id, and say so on the health page. */
export async function reregisterWebhookAction(f: FormData) {
  const slug = str(f, "slug"), companyId = str(f, "companyId"), provider = str(f, "provider");
  const base = (process.env.PUBLIC_URL ?? process.env.TICK_URL ?? "").replace(/\/$/, "");
  let note = "";
  await asOperator(async (c) => {
    const { bindings } = await loadCompany(c, companyId);
    try {
      if (provider === "whop") { if (!bindings["secret.whop_api_key"]) throw new Error("no Whop API key"); const hook = await whopCreateWebhook(bindings["secret.whop_api_key"], `${base}/api/webhooks/whop/${companyId}`); await setBinding(c, companyId, "secret.whop_webhook", "secret", hook.webhook_secret); await setBinding(c, companyId, "whop.webhook_id", "id", hook.id); note = `Whop webhook re-registered (${hook.id}).`; }
      else if (provider === "fathom") { if (!bindings["secret.fathom_api_key"]) throw new Error("no Fathom API key"); const hook = await fathomCreateWebhook(bindings["secret.fathom_api_key"], `${base}/api/webhooks/fathom/${companyId}`); await setBinding(c, companyId, "secret.fathom_webhook", "secret", hook.secret); await setBinding(c, companyId, "fathom.webhook_id", "id", hook.id); note = `Fathom webhook re-registered (${hook.id}).`; }
      else throw new Error(`unknown provider ${provider}`);
      await audit(c, companyId, "webhook.reregistered", { provider, note });
      const s = await sweepCompany(c, companyId, liveAdapters); await announceDue(c, liveAdapters);
      note += ` Swept again: ${s.findings.filter((x) => !x.ok).length} failing.`;
    } catch (e) { note = `Could not re-register the ${provider} webhook: ${String((e as Error).message).slice(0, 160)}`; }
  });
  revalidatePath(`/c/${slug}/health`);
  redirect(`/c/${slug}/health?note=${encodeURIComponent(note)}`);
}

