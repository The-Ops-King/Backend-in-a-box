import { asOperator, one, many } from "@/db/client";
import { encrypt, decrypt } from "./crypto";
import { randomBytes } from "node:crypto";
import { extractManifest, parseDefinition, indexDefinition } from "./definition";
import { templates } from "@/templates";
import { bookingFor, type Adapters, type BookingConfig, type Company } from "@/adapters/types";
import { calendlyUserByEmail, calendlyWhoAmI } from "@/adapters/calendly/read";
import { loadCompany } from "./context";
import { defaultPrompts } from "@/prompts";
import { fathomCreateWebhook } from "@/adapters/fathom/client";
import { whopCreateWebhook } from "@/adapters/whop/client";

/**
 * A calendar's mapping: the kind of call it books; optionally how setter-vs-self is decided on it (`booking`: self | setter |
 * question, or the older `selfBooked` flag), and which of its booking questions answer what (`questions`: setter, phone, and
 * any attribute name → the question text as it appears on the form). D24.
 */
export type CalendarMapping = string | { term: string; selfBooked?: boolean; booking?: "self" | "setter" | "question"; questions?: Record<string, string> };
export type InstallInput = {
  name: string; slug: string; timezone: string; locationId: string;
  /** The CRM private integration token. Required the first time; a re-install may omit it and keeps the one already stored (tokens rotate; template upgrades should not need the secret again). */
  pit?: string;
  /** Where appointments live. Default: the CRM's own calendars. Calendly: a read token; `userEmail` narrows event types and events to one host. */
  booking?: { source: "ghl" } | { source: "calendly"; token: string; userEmail?: string; phoneQuestion?: string; setterQuestion?: string };
  calendars?: Record<string, CalendarMapping>;   // calendar / event type external id → closing | first_call | qualifying | follow_up
  /** How setter-booked vs self-booked is decided (D24): by the calendar (default), by the setter question on the booking, or either. */
  setterRule?: "calendar" | "question" | "either";
  closerCall?: string;                   // external id bound as calendar.closer_call
  bookingCalendar?: string;              // external id bound as calendar.booking (first-call / self-book link used by lead and reactivation templates)
  crm?: Record<string, string>;          // extra crm.* bindings a template needs: pipeline and stage ids, custom field ids (key without the crm. prefix)
  whop?: { webhookSecret?: string; apiKey?: string };
  slack?: Record<string, string>;        // slack.channel.<name> → channel id (bookings, deals, alerts, …)   // Whop → /api/webhooks/whop/<companyId>; a ws_ signing secret, or an API key and the engine creates the webhook itself (and can backfill payments)
  /** Call recordings. `apiKey` registers Fathom's webhook at install (needs PUBLIC_URL); `webhookSecret` binds one made by hand. Either way the Zapier door is open too. */
  recording?: { source: "fathom"; apiKey?: string; webhookSecret?: string };
  anthropicKey?: string;                 // bound as secret.anthropic_key; the analyze node reads it (env ANTHROPIC_API_KEY is the fallback)
  testDomains?: string[];                // bound as test.domains: email domains whose contacts pass in test (D52), e.g. ["jtylerray.com"]
  jevKey?: string;                       // bound as secret.jev_key; the classify node reads replies with it (env JEV_API_KEY is the fallback)
  /** Where the engine says what broke (D33): a Slack channel id, email addresses (needs resendKey + emailFrom), a webhook (a Zap). */
  alerts?: { slackChannel?: string; email?: string; emailFrom?: string; webhook?: string; resendKey?: string; asName?: string; asIcon?: string };
  prompts?: Record<string, string>;      // prompt.<name> overrides; defaults from src/prompts fill the rest
  slackToken?: string;                   // the Slack app's bot token (xoxb-…); verified with Slack, stored encrypted; "disconnect" removes it
  slackSigningSecret?: string;           // the Slack app's signing secret, so the reactions door can trust what Slack sends (D45)
  contractValueDefault?: number;         // the program price; new opportunities get it as contract_value until a closer sets one
  /** Who takes calls: emails (or CRM user ids) from the roster. Only closers get the end-of-day link and DM (D34); everyone else on the roster is staff. Omitted: roles stay as they are. */
  closers?: string[];
  templates?: string[];                  // slugs; default all
  enable?: boolean;                      // default false — Tyler's rule: build off, enable deliberately
  smsEnabled?: boolean;                  // default true; false when the sub-account has no number
  mode?: import("./mode").Mode;          // default shadow; the ladder is shadow → test → live (D52)
  /** Dark hours. Sends wait for the window; `allowTransactional` lets automated receipts ("you're booked") through at any hour. */
  quietHours?: { start?: string; end?: string; allowTransactional?: boolean };
};

/** Trigger rows follow the definition in place: a node that is still there keeps its row (runs point at it), a new node gets one, a gone node loses its (runs keep their history via on delete set null). */
export async function syncTriggers(c: import("pg").PoolClient, companyId: string, workflowId: string, def: ReturnType<typeof parseDefinition>): Promise<void> {
  const triggers = indexDefinition(def).triggers;
  for (const trig of triggers)
    await c.query(`insert into workflow_triggers (company_id, workflow_id, node_id, event_type, match) values ($1,$2,$3,$4,$5)
      on conflict (workflow_id, node_id) do update set event_type=excluded.event_type, match=excluded.match`, [companyId, workflowId, trig.id, trig.event, trig.match ?? {}]);
  await c.query("delete from workflow_triggers where workflow_id=$1 and not (node_id = any($2::text[]))", [workflowId, triggers.map((t) => t.id)]);
}

/** Key-order-independent JSON, so a template that merely round-tripped through jsonb is not "changed". */
const canon = (v: unknown): string => JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))) : x));

/** D16: upload info, pick templates, done. Idempotent. Workflows install OFF unless enable=true. A re-run upgrades untouched copies to the current template; edited copies are left alone. */
export type Inbound = { secret: string; zapierPaymentUrl: string; zapierRecordingUrl: string; whopWebhookUrl: string; fathomWebhookUrl: string; fathomWebhook?: string };
export async function installCompany(input: InstallInput, adapters: Adapters): Promise<{ companyId: string; calendars: string[]; installed: string[]; inbound: Inbound }> {
  const wanted = input.templates?.length ? input.templates : templates.map((t) => t.slug);
  const calMap: Record<string, { term: string; selfBooked?: boolean; booking?: "self" | "setter" | "question"; questions?: Record<string, string> }> = Object.fromEntries(Object.entries(input.calendars ?? {}).map(([k, v]) => [k, typeof v === "string" ? { term: v } : v]));
  // resolve the booking source outside the transaction: it talks to Calendly.
  // Omitting `booking` on a re-install keeps whatever the company already uses; it never silently flips it back to GHL.
  let booking: BookingConfig = { source: "ghl" };
  if (!input.booking) {
    const prior = await asOperator(async (c) => {
      const co = await one<{ id: string }>(c, "select id from companies where slug=$1", [input.slug]);
      return co ? (await loadCompany(c, co.id).catch(() => null))?.adapterCompany.booking ?? null : null;
    });
    if (prior) booking = prior;
  }
  if (input.booking?.source === "calendly") {
    const me = await calendlyWhoAmI(input.booking.token);
    const user = input.booking.userEmail ? await calendlyUserByEmail(input.booking.token, me.organization, input.booking.userEmail) : undefined;
    if (input.booking.userEmail && !user) throw new Error(`no Calendly organization member has the email ${input.booking.userEmail}`);
    booking = { source: "calendly", token: input.booking.token, organization: me.organization, user, phoneQuestion: input.booking.phoneQuestion, setterQuestion: input.booking.setterQuestion };
  }
  // the Slack token is checked with Slack outside the transaction, like the booking source
  let slackTeam: { team_id: string; bot_user_id: string | null } | null = null;
  if (input.slackToken && input.slackToken !== "disconnect") {
    const r = await fetch("https://slack.com/api/auth.test", { method: "POST", headers: { Authorization: `Bearer ${input.slackToken}` } });
    const d = (await r.json()) as { ok: boolean; team_id?: string; user_id?: string; error?: string };
    if (!d.ok || !d.team_id) throw new Error(`Slack refused the token: ${d.error ?? "no team"}`);
    slackTeam = { team_id: d.team_id, bot_user_id: d.user_id ?? null };
  }
  return asOperator(async (c) => {
    const storedPit = input.pit ? null : await one<{ value: Buffer }>(c, "select b.value from bindings b join companies co on co.id=b.company_id where co.slug=$1 and b.key='secret.ghl_pit'", [input.slug]);
    const pit = input.pit ?? (storedPit ? decrypt(storedPit.value) : null);
    if (!pit) throw new Error("pit is required: this company has no CRM token stored yet");
    // re-running install never silently flips a live company back to shadow or re-enables SMS: only explicitly passed values change
    const co = await one<{ id: string }>(c, `insert into companies (name, slug, timezone, sms_enabled, mode) values ($1,$2,$3,coalesce($4,true),coalesce($5,'shadow'))
      on conflict (slug) do update set name=excluded.name, timezone=excluded.timezone,
        sms_enabled=case when $4::boolean is null then companies.sms_enabled else excluded.sms_enabled end,
        mode=case when $5::text is null then companies.mode else excluded.mode end returning id`, [input.name, input.slug, input.timezone, input.smsEnabled ?? null, input.mode ?? null]);
    const companyId = co!.id;
    await c.query(`insert into company_terms (company_id, domain, name, category, is_default, sort) select $1, domain, label, value, true, sort from core_categories on conflict (company_id, domain, name) do nothing`, [companyId]);
    const bind = (key: string, kind: string, value: string) =>
      c.query(`insert into bindings (company_id, key, kind, value) values ($1,$2,$3,$4) on conflict (company_id, key) do update set value=excluded.value, updated_at=now()`, [companyId, key, kind, kind === "secret" ? encrypt(value) : Buffer.from(value)]);
    await bind("crm.location_id", "id", input.locationId); await bind("secret.ghl_pit", "secret", pit);
    if (input.testDomains) await bind("test.domains", "text", input.testDomains.map((d) => d.trim().toLowerCase().replace(/^@/, "")).filter(Boolean).join(","));
    if (booking.source === "calendly") {
      await bind("secret.calendly_token", "secret", booking.token); await bind("calendly.organization", "id", booking.organization);
      await bind("calendly.user", "id", booking.user ?? ""); await bind("calendly.phone_question", "text", booking.phoneQuestion ?? ""); await bind("calendly.setter_question", "text", booking.setterQuestion ?? "");
    } else if (input.booking) {   // explicitly back to the CRM: drop the Calendly bindings so loadCompany stops choosing it
      await c.query("delete from bindings where company_id=$1 and key in ('secret.calendly_token','calendly.organization','calendly.user','calendly.phone_question','calendly.setter_question')", [companyId]);
    }
    for (const [k, v] of Object.entries(input.crm ?? {})) await bind(`crm.${k}`, "id", v);
    if (input.setterRule) await bind("booking.setter_rule", "text", input.setterRule);
    if (input.whop?.webhookSecret) await bind("secret.whop_webhook", "secret", input.whop.webhookSecret);
    if (input.whop?.apiKey) await bind("secret.whop_api_key", "secret", input.whop.apiKey);
    for (const [name, id] of Object.entries(input.slack ?? {})) await bind(`slack.channel.${name}`, "channel", id);
    if (input.slackToken === "disconnect") await c.query("delete from slack_connections where company_id=$1", [companyId]);
    else if (slackTeam) await c.query("insert into slack_connections (company_id, team_id, bot_token, bot_user_id) values ($1,$2,$3,$4) on conflict (company_id) do update set team_id=excluded.team_id, bot_token=excluded.bot_token, bot_user_id=excluded.bot_user_id, connected_at=now()", [companyId, slackTeam.team_id, encrypt(input.slackToken!), slackTeam.bot_user_id]);
    if (input.slackSigningSecret) await bind("secret.slack_signing", "secret", input.slackSigningSecret);
    if (input.recording?.webhookSecret) await bind("secret.fathom_webhook", "secret", input.recording.webhookSecret);
    if (input.recording?.apiKey) await bind("secret.fathom_api_key", "secret", input.recording.apiKey);
    if (input.anthropicKey) await bind("secret.anthropic_key", "secret", input.anthropicKey);
    if (input.jevKey) await bind("secret.jev_key", "secret", input.jevKey);
    if (input.alerts?.slackChannel) await bind("alerts.slack_channel", "channel", input.alerts.slackChannel);
    if (input.alerts?.email) await bind("alerts.email", "text", input.alerts.email);
    if (input.alerts?.emailFrom) await bind("alerts.email_from", "text", input.alerts.emailFrom);
    if (input.alerts?.webhook) await bind("alerts.webhook", "text", input.alerts.webhook);
    if (input.alerts?.resendKey) await bind("secret.resend_key", "secret", input.alerts.resendKey);
    if (input.alerts?.asName) await bind("alerts.as_name", "text", input.alerts.asName);
    if (input.alerts?.asIcon) await bind("alerts.as_icon", "text", input.alerts.asIcon);
    // prompts: the company's own text wins; a default fills any prompt a template needs that nobody wrote yet
    const boundKeys = new Set((await many<{ key: string }>(c, "select key from bindings where company_id=$1", [companyId])).map((b) => b.key));
    for (const [k, v] of Object.entries(input.prompts ?? {})) await bind(`prompt.${k}`, "text", v);
    for (const [k, v] of Object.entries(defaultPrompts)) if (!boundKeys.has(`prompt.${k}`) && !(input.prompts ?? {})[k]) await bind(`prompt.${k}`, "text", v);
    // the secret a Zap uses to post into this company; made once, shown on every install so it can be copied again
    let inboundSecret = (await one<{ value: Buffer }>(c, "select value from bindings where company_id=$1 and key='secret.zapier_inbound'", [companyId]))?.value;
    const inboundPlain = inboundSecret ? (await import("./crypto")).decrypt(inboundSecret) : `zi_${randomBytes(24).toString("base64url")}`;
    if (!inboundSecret) await bind("secret.zapier_inbound", "secret", inboundPlain);
    if (input.contractValueDefault !== undefined) await c.query("update companies set contract_value_default=$2 where id=$1", [companyId, input.contractValueDefault]);
    if (input.quietHours) await c.query("update companies set send_window_start=coalesce($2, send_window_start), send_window_end=coalesce($3, send_window_end), quiet_allow_transactional=coalesce($4, quiet_allow_transactional) where id=$1", [companyId, input.quietHours.start ?? null, input.quietHours.end ?? null, input.quietHours.allowTransactional ?? null]);
    const ac: Company = { id: companyId, locationId: input.locationId, pit, timezone: input.timezone, booking };
    for (const u of await adapters.read.listUsers(ac))
      await c.query(`insert into users (company_id, email, name, role, ghl_user_id) values ($1,$2,$3,'staff',$4) on conflict (company_id, ghl_user_id) do update set name=excluded.name`, [companyId, u.email ?? `${u.id}@unclaimed.local`, u.name || u.id, u.id]);
    if (input.closers) {
      const who = input.closers.map((x) => x.toLowerCase());
      await c.query("update users set role='staff' where company_id=$1 and role='closer' and not (lower(email)=any($2) or ghl_user_id=any($2))", [companyId, who]);
      await c.query("update users set role='closer' where company_id=$1 and role in ('staff','closer') and (lower(email)=any($2) or ghl_user_id=any($2))", [companyId, who]);
    }
    const terms = await many<{ id: string; category: string }>(c, "select id, category from company_terms where company_id=$1 and domain='appointment_type' and is_default", [companyId]);
    const calendarsOut: string[] = [];
    const listed = await bookingFor(adapters, ac).listCalendars(ac);
    for (const k of listed) {
      const m = calMap[k.id]; if (!m) { calendarsOut.push(`skip "${k.name}" (${k.id}) — no mapping${k.note ? ` [${k.note}]` : ""}`); continue; }
      const term = terms.find((t) => t.category === m.term)?.id; if (!term) { calendarsOut.push(`unknown category ${m.term} for ${k.id}`); continue; }
      const du = k.teamMemberIds[0] ? await one<{ id: string }>(c, "select id from users where company_id=$1 and ghl_user_id=$2", [companyId, k.teamMemberIds[0]]) : undefined;
      const selfBooked = m.selfBooked ?? (m.booking === "self" ? true : m.booking === "setter" ? false : null);
      const config = { ...(m.booking ? { booking: m.booking } : {}), ...(m.questions ? { questions: m.questions } : {}) };
      await c.query(`insert into calendars (company_id, source, external_id, name, appointment_term, default_user_id, self_booked, booking_url, config) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
        on conflict (company_id, source, external_id) do update set name=excluded.name, appointment_term=excluded.appointment_term, self_booked=excluded.self_booked, booking_url=coalesce(excluded.booking_url, calendars.booking_url), config=case when excluded.config='{}'::jsonb then calendars.config else excluded.config end, active=true`,
        [companyId, booking.source, k.id, k.name, term, du?.id ?? null, selfBooked, k.bookingUrl ?? null, JSON.stringify(config)]);
      const how = m.booking === "question" ? " (setter decided by the booking question)" : selfBooked === null ? "" : selfBooked ? " (self-booked)" : " (setter-booked)";
      calendarsOut.push(`"${k.name}" → ${m.term}${how}${m.questions ? `; questions: ${Object.keys(m.questions).join(", ")}` : ""}`);
    }
    for (const unknownId of Object.keys(calMap).filter((id) => !listed.some((k) => k.id === id))) calendarsOut.push(`mapping for ${unknownId} matches no calendar at the booking source`);
    // calendars of the other source go quiet rather than being deleted: their appointments and history stay
    await c.query("update calendars set active=false where company_id=$1 and source<>$2", [companyId, booking.source]);
    await c.query("delete from poll_cursors where company_id=$1 and entity like 'appointments:%' and split_part(entity, ':', 2) in (select external_id from calendars where company_id=$1 and not active)", [companyId]);
    const closerCal = input.closerCall ?? Object.entries(calMap).find(([, m]) => m.term === "closing")?.[0];
    if (closerCal) await bind("calendar.closer_call", "id", closerCal);
    const bookingCal = input.bookingCalendar ?? Object.entries(calMap).find(([, m]) => m.term === "first_call")?.[0] ?? closerCal;
    if (bookingCal) await bind("calendar.booking", "id", bookingCal);
    const installed: string[] = [];
    for (const t of templates.filter((t) => wanted.includes(t.slug))) {
      const def = parseDefinition(t.definition); const manifest = extractManifest(def);
      // the template row follows the code: a changed definition is a new template version
      let tpl = await one<{ id: string; version: number; definition: unknown }>(c, "select id, version, definition from workflow_templates where slug=$1", [t.slug]);
      if (!tpl) tpl = await one<{ id: string; version: number; definition: unknown }>(c, "insert into workflow_templates (slug, name, description, category, stage, sort, origin, definition, manifest, published_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,now()) returning id, version, definition", [t.slug, t.name, t.description, t.category, t.stage, t.sort, t.origin, t.definition, manifest]);
      else if (canon(tpl.definition) !== canon(t.definition)) tpl = await one<{ id: string; version: number; definition: unknown }>(c, "update workflow_templates set definition=$2, manifest=$3, name=$4, description=$5, stage=$6, sort=$7, origin=$8, version=version+1, published_at=now() where id=$1 returning id, version, definition", [tpl.id, t.definition, manifest, t.name, t.description, t.stage, t.sort, t.origin]);
      const bound = new Set((await many<{ key: string }>(c, "select key from bindings where company_id=$1", [companyId])).map((b) => b.key));
      const missing = manifest.bindings.filter((b) => b.required && !bound.has(b.key)).map((b) => b.key);
      const missingNote = missing.length ? `; missing: ${missing.join(", ")}` : "";
      const existing = await one<{ id: string; current_version: number; template_version: number | null; diverged: boolean }>(c, "select id, current_version, template_version, diverged from workflows where company_id=$1 and template_id=$2", [companyId, tpl!.id]);
      if (existing) {
        // the words follow the template on every install, even when the steps did not change: a rename is not a new version
        await c.query("update workflows set stage=$2, sort=$3, origin=$4, name=case when diverged then name else $5 end where id=$1", [existing.id, t.stage, t.sort, t.origin, t.name]);
        await c.query("update workflow_templates set name=$2, description=$3 where id=$1 and (name<>$2 or description is distinct from $3)", [tpl!.id, t.name, t.description]);
        // a company's untouched copy follows the template; an edited copy is theirs and is left alone
        if (existing.diverged) { installed.push(`${t.slug} (edited since install, left alone; template v${tpl!.version} available)`); continue; }
        if (existing.template_version === tpl!.version) { installed.push(`${t.slug} (already installed, current)`); continue; }
        const next = existing.current_version + 1;
        await c.query("insert into workflow_versions (workflow_id, version, definition, manifest, note) values ($1,$2,$3,$4,$5)", [existing.id, next, t.definition, manifest, `upgraded to template v${tpl!.version}`]);
        await c.query("update workflows set current_version=$2, template_version=$3, name=$4, reentry_policy=$5, reentry_window=$6 where id=$1", [existing.id, next, tpl!.version, t.name, def.reentry, def.reentry_window ?? null]);
        await syncTriggers(c, companyId, existing.id, def);
        await c.query("insert into audit_log (company_id, action, target_type, target_id, before, after) values ($1,'workflow.upgraded','workflow',$2,$3,$4)", [companyId, existing.id, { version: existing.current_version, template_version: existing.template_version }, { version: next, template_version: tpl!.version }]);
        installed.push(`${t.slug} → upgraded v${existing.current_version}→v${next} (template v${tpl!.version})${missingNote}`);
        continue;
      }
      const wf = await one<{ id: string }>(c, `insert into workflows (company_id, template_id, template_version, name, reentry_policy, reentry_window, stage, sort, origin) values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id`, [companyId, tpl!.id, tpl!.version, t.name, def.reentry, def.reentry_window ?? null, t.stage, t.sort, t.origin]);
      await c.query("insert into workflow_versions (workflow_id, version, definition, manifest, note) values ($1,1,$2,$3,'installed from template')", [wf!.id, t.definition, manifest]);
      await syncTriggers(c, companyId, wf!.id, def);
      if (input.enable && !missing.length) await c.query("update workflows set enabled=true where id=$1", [wf!.id]);
      installed.push(`${t.slug} → ${missing.length ? `OFF, missing: ${missing.join(", ")}` : input.enable ? "enabled" : "installed OFF"}`);
    }
    // Fathom's webhook is registered once per company and remembered; a re-install never makes a second one
    let fathomWebhook = (await one<{ value: Buffer }>(c, "select value from bindings where company_id=$1 and key='fathom.webhook_id'", [companyId]))?.value.toString("utf8");
    const publicUrl = (process.env.PUBLIC_URL ?? process.env.TICK_URL ?? "").replace(/\/$/, "");
    if (input.recording?.apiKey && !fathomWebhook) {
      if (!publicUrl) throw new Error("recording.apiKey given but PUBLIC_URL is not set: cannot tell Fathom where to deliver");
      const hook = await fathomCreateWebhook(input.recording.apiKey, `${publicUrl}/api/webhooks/fathom/${companyId}`);
      await bind("secret.fathom_webhook", "secret", hook.secret); await bind("fathom.webhook_id", "id", hook.id);
      fathomWebhook = hook.id;
    }
    // Whop: with an API key and no signing secret yet, the engine creates its own webhook (api v1, payment + refund events) and keeps the secret it is shown once
    if (input.whop?.apiKey && !input.whop.webhookSecret && !boundKeys.has("secret.whop_webhook")) {
      if (!publicUrl) throw new Error("whop.apiKey given but PUBLIC_URL is not set: cannot tell Whop where to deliver");
      const hook = await whopCreateWebhook(input.whop.apiKey, `${publicUrl}/api/webhooks/whop/${companyId}`);
      await bind("secret.whop_webhook", "secret", hook.webhook_secret); await bind("whop.webhook_id", "id", hook.id);
    }
    return { companyId, calendars: calendarsOut, installed, inbound: { secret: inboundPlain, zapierPaymentUrl: `/api/webhooks/zapier/${companyId}/payment`, zapierRecordingUrl: `/api/webhooks/zapier/${companyId}/recording`, whopWebhookUrl: `/api/webhooks/whop/${companyId}`, fathomWebhookUrl: `/api/webhooks/fathom/${companyId}`, fathomWebhook } };
  });
}
