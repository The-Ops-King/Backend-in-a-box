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

const back = (slug: string, q: Record<string, string>, hash = "") => { revalidatePath(`/c/${slug}/settings`); revalidatePath(`/c/${slug}`); redirect(`/c/${slug}/settings?${new URLSearchParams(q).toString()}${hash}`); };
const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
const audit = (c: Parameters<Parameters<typeof asOperator>[0]>[0], companyId: string, action: string, after: Record<string, unknown>) => c.query("insert into audit_log (company_id, action, target_type, target_id, after) values ($1,$2,'company',$1,$3)", [companyId, action, after]);

export async function saveCompanyAction(f: FormData) {
  const slug = str(f, "slug"), companyId = str(f, "companyId");
  const price = str(f, "contract_value_default");
  await asOperator(async (c) => {
    await c.query(`update companies set name=$2, timezone=$3, sms_enabled=$4, send_window_start=$5, send_window_end=$6, quiet_allow_transactional=$7, contract_value_default=$8 where id=$1`,
      [companyId, str(f, "name"), str(f, "timezone"), f.get("sms_enabled") === "on", str(f, "send_window_start") || "08:00", str(f, "send_window_end") || "20:00", f.get("quiet_allow_transactional") === "on", price ? Number(price) : null]);
    await audit(c, companyId, "company.settings", { name: str(f, "name"), timezone: str(f, "timezone"), sms: f.get("sms_enabled") === "on", window: [str(f, "send_window_start"), str(f, "send_window_end")], transactional_in_dark: f.get("quiet_allow_transactional") === "on", price });
  });
  back(slug, { note: "Company saved" }, "#company");
}

/** Every field named b:<key> (with kind in k:<key>) is a binding. Empty leaves it as is; clear:<key> removes it. */
export async function saveBindingsAction(f: FormData) {
  const slug = str(f, "slug"), companyId = str(f, "companyId"), section = str(f, "section");
  let set = 0, cleared = 0;
  await asOperator(async (c) => {
    for (const [name, raw] of f.entries()) {
      if (name.startsWith("clear:") && raw === "on") { await clearBinding(c, companyId, name.slice(6)); cleared++; continue; }
      if (!name.startsWith("b:")) continue;
      const key = name.slice(2), value = String(raw).trim(); if (!value) continue;
      const kind = (str(f, `k:${key}`) || (key.startsWith("secret.") ? "secret" : key.startsWith("prompt.") || key.startsWith("calendly.") || key.startsWith("booking.") ? "text" : key.startsWith("slack.channel.") ? "channel" : "id")) as BindingKind;
      await setBinding(c, companyId, key, kind, value); set++;
    }
  });
  back(slug, { note: `${section || "Settings"}: ${set} saved${cleared ? `, ${cleared} cleared` : ""}` }, section ? `#${section}` : "");
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

