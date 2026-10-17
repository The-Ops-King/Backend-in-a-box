import { asOperator, one, many } from "@/db/client";
import { encrypt, decrypt } from "./crypto";
import { vendorOfBinding, wakePausedOnAuth } from "./failures";
import { randomBytes } from "node:crypto";
import { extractManifest, parseDefinition, indexDefinition } from "./definition";
import { templates } from "@/templates";
import { bookingFor, type Adapters, type BookingConfig, type Company } from "@/adapters/types";
import { calendlyUserByEmail, calendlyWhoAmI } from "@/adapters/calendly/read";
import { loadCompany } from "./context";
import { defaultPrompts } from "@/prompts";
import { fathomCreateWebhook } from "@/adapters/fathom/client";
import { whopCreateWebhook } from "@/adapters/whop/client";
import { goLive, type Cleared } from "./golive";
import { BOOKING_CARD_KEY, backfillBookingCard, intakeProblem, type IntakeLine } from "./booking-card";
import { OBJECTIONS_KEY, CLOSER_OPTIONS_KEY } from "./sales-call";
import { DEPOSIT_PRODUCTS_KEY } from "./payments";
import { chartLayoutOf, notDrawable } from "@/api/chart-verdict";
import { checkMapAgainstForms, mapProblems, registerTypeform, TF_FORMS_KEY, TF_TOKEN_KEY, type TypeformForms } from "./typeform";
import { liveTypeform, type TypeformApi } from "@/adapters/typeform/client";

/**
 * A calendar's mapping: the kind of call it books; optionally how setter-vs-self is decided on it (`booking`: self | setter |
 * question, or the older `selfBooked` flag), and which of its booking questions answer what (`questions`: setter, phone, and
 * any attribute name → the question text as it appears on the form). D24.
 */
/** `name`: the company's own call type for this calendar ("Demo call"), counted under `term`'s core category; made once, kept by name (D101). Without it the calendar takes the category's default type. */
export type CalendarMapping = string | { term: string; name?: string; selfBooked?: boolean; booking?: "self" | "setter" | "question"; questions?: Record<string, string> };
export type InstallInput = {
  name: string; slug: string; timezone: string; locationId: string;
  /** The CRM private integration token. Required the first time; a re-install may omit it and keeps the one already stored (tokens rotate; template upgrades should not need the secret again). */
  pit?: string;
  /** Where appointments live. Default: the CRM's own calendars. Calendly: a read token (its user's organization is bound as calendly.organization); `userEmail` must be a member of that organization and is bound as calendly.user (the Setup page's "Calendly host"), but narrows nothing: every member's event types are listed and only the mapped ones are polled (D26). */
  booking?: { source: "ghl" } | { source: "calendly"; token: string; userEmail?: string; phoneQuestion?: string; setterQuestion?: string };
  calendars?: Record<string, CalendarMapping>;   // calendar / event type external id → closing | first_call | qualifying | follow_up
  /** How setter-booked vs self-booked is decided (D24): by the calendar (default), by the setter question on the booking, or either. */
  setterRule?: "calendar" | "question" | "either";
  closerCall?: string;                   // external id bound as calendar.closer_call
  bookingCalendar?: string;              // external id bound as calendar.booking (first-call / self-book link used by lead and reactivation templates)
  crm?: Record<string, string>;          // extra crm.* bindings a template needs: pipeline and stage ids, custom field ids (key without the crm. prefix)
  whop?: { webhookSecret?: string; apiKey?: string };
  slack?: Record<string, string>;        // slack.channel.<name> → channel id (bookings, deals, alerts, ops: where DMs to the team go until live (D76), …)   // Whop → /api/webhooks/whop/<companyId>; a ws_ signing secret, or an API key and the engine creates the webhook itself (and can backfill payments)
  /** Call recordings. `apiKey` registers Fathom's webhook at install (needs PUBLIC_URL); `webhookSecret` binds one made by hand. Either way the Zapier door is open too. */
  recording?: { source: "fathom"; apiKey?: string; webhookSecret?: string };
  anthropicKey?: string;                 // bound as secret.anthropic_key; the analyze node reads it (env ANTHROPIC_API_KEY is the fallback)
  /** D73: financial qualification from the CRM's work-situation field (bound through `crm` as field_contact_work_situation): the answers that make an MQL and a DQ (qualify.mql_answers, qualify.dq_answers), matched exactly; a blank answer is an MQL only with unansweredIsMql (qualify.unanswered_is_mql). */
  qualify?: { mqlAnswers?: string[]; dqAnswers?: string[]; unansweredIsMql?: boolean };
  /** D73: the Sales Call custom object the show rate reads (crm.object_sales_call), what each of its `outcome` values means (sales_call.outcomes; also what the engine writes there, inverted: a new booking's `scheduled`, a no-show, a late cancel), and which `disposition` values are a sales DQ (sales_call.dq_dispositions). */
  salesCall?: { object?: string; outcomes?: Record<string, "showed" | "noshow" | "cancelled" | "rescheduled" | "scheduled">; dqDispositions?: string[]; dispositions?: Record<string, "closed" | "deposit" | "pending" | "follow_up" | "lost" | "unqualified" | { meaning: "closed" | "deposit" | "pending" | "follow_up" | "lost" | "unqualified"; reason?: string }>; bookingSources?: { setter?: string; self?: string };
    /** D118: the Primary Objection options the company's Sales Call takes (sales_call.objections); unset, the templates' own list. */
    objections?: string[];
    /** D118: the option key each closer has on the Sales Call's Closer field, by email, CRM user id or roster name (sales_call.closer_options); unset, the closer is written by name. */
    closerOptions?: Record<string, string> };
  /** D79: the Discovery Call record's `call_result` option keys, {key: set | follow_up | dq | not_interested} (discovery_call.results; unbound, the keys are those four), and whether Jev's read of a setter call acts (setter_result.act, default off: it only says what it would do). */
  discoveryCall?: { results?: Record<string, "set" | "follow_up" | "dq" | "not_interested">; act?: boolean };
  /** D104: the booking card's intake lines, the company's own (booking_card.intake): each a label and a bound contact field or a booking answer by name, optionally a second value after it. Omitted: left as it is; [] shows none. */
  bookingCard?: { intake: IntakeLine[] };
  /** D117: the company is one offer inside a location another business shares: only contacts carrying this tag in the CRM, or booked on its mapped calendars, are its (bound as scope.tag, lowercase). Omitted: left as it is; "" removes it (the whole location is the company's again). */
  scopeTag?: string;
  testDomains?: string[];                // bound as test.domains: email domains whose contacts pass in test (D52), e.g. ["jtylerray.com"]
  jevKey?: string;                       // bound as secret.jev_key; the classify node reads replies with it (env JEV_API_KEY is the fallback)
  /** Where the Health check workflow says what broke (D33, D88: Slack only): the channel, the face, how often an open alert is said again (minutes, 60), how many failed polls in a row make an alert (2). */
  alerts?: { slackChannel?: string; asName?: string; asIcon?: string; repeatMinutes?: number; pollFailures?: number };
  prompts?: Record<string, string>;      // prompt.<name> overrides; defaults from src/prompts fill the rest
  slackToken?: string;                   // the Slack app's bot token (xoxb-…); verified with Slack, stored encrypted; "disconnect" removes it
  slackSigningSecret?: string;           // the Slack app's signing secret, so the reactions door can trust what Slack sends (D45)
  /** The Slack bot (D70): who it pings when it cannot answer — a Slack user id, or an email resolved to one through Slack (needs users:read.email). */
  bot?: { escalateTo?: string };
  contractValueDefault?: number;         // the program price; new opportunities get it as contract_value until a closer sets one
  /** D119: the payment processor's products that are a deposit, not a sale: Whop product ids (`prod_…`) or plan ids (`plan_…`), or a Zap's plan as it sends it. A payment for one is kind `deposit`. Declared, the list is the whole truth; undeclared, a payment whose Whop product or plan is named with the word "deposit" is one (D119 addendum). Bound as payments.deposit_products. Omitted: left as it is; [] removes them. */
  depositProducts?: string[];
  /** Who takes calls: emails (or CRM user ids) from the roster. Only closers get the end-of-day link and DM (D34); everyone else on the roster is staff. Omitted: roles stay as they are. */
  closers?: string[];
  /** Everyone else's job, by email (or CRM user id): setter (makes setting calls), manager, owner, staff. Closers come from `closers`. Omitted: roles stay as they are. */
  roles?: Record<string, "setter" | "manager" | "owner" | "staff">;
  templates?: string[];                  // slugs; default all
  enable?: boolean;                      // default false — Tyler's rule: build off, enable deliberately
  smsEnabled?: boolean;                  // default true; false when the sub-account has no number
  mode?: import("./mode").Mode;          // default shadow; the ladder is shadow → test → live (D52)
  /**
   * D122: Typeform, straight into the engine. `token`: a personal access token (bound as secret.typeform_token; it reads the
   * forms and their responses and manages their webhooks). `forms`: each form's map by question ref (typeform.forms, see
   * `TypeformFormMap`). Given, the engine checks the map against the form and registers its own signed webhook on each form
   * whose fields are all bound. Omitted: left as it is.
   */
  typeform?: { token?: string; forms?: TypeformForms };
  /** Dark hours. Sends wait for the window; `allowTransactional` lets automated receipts ("you're booked") through at any hour. */
  quietHours?: { start?: string; end?: string; allowTransactional?: boolean };
};

/**
 * D16/D96: put the shipped templates on a company: a new one installs (off unless `enable`, or on when it carries what the engine
 * did before, or as the copy it takes over stood), an untouched copy upgrades, an edited copy is left alone, and a copy taken
 * over goes off in the same transaction. Touches nothing else of the company: a template upgrade never needs the install file.
 */
export async function installTemplates(c: import("pg").PoolClient, companyId: string, wanted: string[], opts: { enable?: boolean; existed: boolean }): Promise<string[]> {
  const installed: string[] = [];
  const replaced = new Map<string, { name: string; by: string[] }>();
  await backfillBookingCard(c, companyId);   // D104: before Call booked can upgrade to the card that reads it
  // D123: a template one of the company's own workflows does the job of is never put back on it
  const takenOver = new Map<string, string[]>();
  for (const r of await many<{ takes_over: string; name: string }>(c, "select takes_over, name from workflows where company_id=$1 and takes_over is not null order by name", [companyId])) takenOver.set(r.takes_over, [...(takenOver.get(r.takes_over) ?? []), r.name]);
  for (const t of templates.filter((t) => wanted.includes(t.slug))) {
    const by = takenOver.get(t.slug);
    if (by) { installed.push(`${t.slug} → not installed: the company's own ${by.map((n) => `“${n}”`).join(" and ")} ${by.length > 1 ? "do" : "does"} its job (D123)`); continue; }
    const def = parseDefinition(t.definition); const manifest = extractManifest(def);
    // D111: a template whose chart no layout draws exactly is not put on a company (chart-layout.test holds every shipped one to it)
    const chart = await chartLayoutOf(def);
    if (chart.layout === "list") { installed.push(`${t.slug} → refused: ${notDrawable(chart.problems)}: ${chart.problems.join("; ")}`); continue; }
    // the template row follows the code: a changed definition is a new template version
    let tpl = await one<{ id: string; version: number; definition: unknown }>(c, "select id, version, definition from workflow_templates where slug=$1", [t.slug]);
    if (!tpl) tpl = await one<{ id: string; version: number; definition: unknown }>(c, "insert into workflow_templates (slug, name, description, category, stage, sort, origin, definition, manifest, published_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,now()) returning id, version, definition", [t.slug, t.name, t.description, t.category, t.stage, t.sort, t.origin, t.definition, manifest]);
    else if (canon(tpl.definition) !== canon(t.definition)) tpl = await one<{ id: string; version: number; definition: unknown }>(c, "update workflow_templates set definition=$2, manifest=$3, name=$4, description=$5, stage=$6, sort=$7, origin=$8, version=version+1, published_at=now() where id=$1 returning id, version, definition", [tpl.id, t.definition, manifest, t.name, t.description, t.stage, t.sort, t.origin]);
    const bound = new Set((await many<{ key: string }>(c, "select key from bindings where company_id=$1", [companyId])).map((b) => b.key));
    const missing = manifest.bindings.filter((b) => b.required && !bound.has(b.key)).map((b) => b.key);
    const missingNote = missing.length ? `; missing: ${missing.join(", ")}` : "";
    const existing = await one<{ id: string; current_version: number; template_version: number | null; diverged: boolean }>(c, "select id, current_version, template_version, diverged from workflows where company_id=$1 and template_id=$2", [companyId, tpl!.id]);
    if (existing) {
      // the words follow the template on every install, even when the steps did not change: a rename is not a new version; an
      // edited copy too (D108: nothing renames a company's copy, so a frozen name only strands an old one)
      await c.query("update workflows set stage=$2, sort=$3, origin=$4, name=$5 where id=$1", [existing.id, t.stage, t.sort, t.origin, t.name]);
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
    const carried = opts.existed && "engine_default" in t && t.engine_default === true;
    // D96: a template that takes over an older one (the three wrap-ups out of the one) starts the way the old copy stood: on or off, its mode.
    // An old copy the company edited is theirs: it stays as it is and the new one installs off, so nothing is posted twice.
    const old = "replaces" in t ? await one<{ id: string; enabled: boolean; mode: string | null; diverged: boolean; name: string }>(c, `select w.id, w.enabled, w.mode, w.diverged, w.name from workflows w join workflow_templates wt on wt.id=w.template_id
      where w.company_id=$1 and wt.slug = any($2::text[]) order by w.enabled desc limit 1`, [companyId, t.replaces]) : null;
    if (old && !old.diverged) {
      await c.query("update workflows set enabled=$2, mode=$3 where id=$1", [wf!.id, old.enabled && !missing.length, old.mode]);
      replaced.set(old.id, { name: old.name, by: [...(replaced.get(old.id)?.by ?? []), t.name] });
      installed.push(`${t.slug} → ${missing.length ? `OFF, missing: ${missing.join(", ")}` : old.enabled ? "enabled" : "installed OFF"} (takes over "${old.name}"${old.mode ? `, ${old.mode}` : ""})`);
      continue;
    }
    if (old?.diverged) { installed.push(`${t.slug} → installed OFF ("${old.name}" was edited and stays as it is; turn it off before turning this on)`); continue; }
    if ((opts.enable || carried) && !missing.length) await c.query("update workflows set enabled=true where id=$1", [wf!.id]);
    installed.push(`${t.slug} → ${missing.length ? `OFF, missing: ${missing.join(", ")}` : opts.enable ? "enabled" : carried ? "enabled (it carries what the engine did before, D88)" : "installed OFF"}`);
  }
  // D96: the copies taken over go off in the same install that turns their successors on: no gap, no double post
  for (const [id, r] of replaced) {
    const was = await one<{ enabled: boolean }>(c, "update workflows set enabled=false where id=$1 and enabled returning true as enabled", [id]);
    if (was) await c.query("insert into audit_log (company_id, action, target_type, target_id, before, after) values ($1,'workflow.replaced','workflow',$2,$3,$4)", [companyId, id, { enabled: true }, { enabled: false, replaced_by: r.by }]);
    installed.push(`"${r.name}" → ${was ? "turned off" : "already off"}, replaced by ${r.by.join(", ")}`);
  }
  return installed;
}

/** Trigger rows follow the definition in place: a node that is still there keeps its row (runs point at it), a new node gets one, a gone node loses its (runs keep their history via on delete set null). */
export async function syncTriggers(c: import("pg").PoolClient, companyId: string, workflowId: string, def: ReturnType<typeof parseDefinition>): Promise<void> {
  const triggers = indexDefinition(def).triggers;
  for (const trig of triggers)
    await c.query(`insert into workflow_triggers (company_id, workflow_id, node_id, event_type, match) values ($1,$2,$3,$4,$5)
      on conflict (workflow_id, node_id) do update set event_type=excluded.event_type, match=excluded.match`, [companyId, workflowId, trig.id, trig.event, trig.match ?? {}]);
  await c.query("delete from workflow_triggers where workflow_id=$1 and not (node_id = any($2::text[]))", [workflowId, triggers.map((t) => t.id)]);
}

/** Key-order-independent JSON, so a template that merely round-tripped through jsonb is not "changed". */
export const canon = (v: unknown): string => JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))) : x));

/** D16: upload info, pick templates, done. Idempotent. Workflows install OFF unless enable=true. A re-run upgrades untouched copies to the current template; edited copies are left alone. */
export type Inbound = { secret: string; zapierPaymentUrl: string; zapierRecordingUrl: string; whopWebhookUrl: string; fathomWebhookUrl: string; fathomWebhook?: string };
/** `wentLive`: what the go-live cleared, when `mode: "live"` moved the company there (D56). */
export async function installCompany(input: InstallInput, adapters: Adapters, typeformApi: TypeformApi = liveTypeform): Promise<{ companyId: string; calendars: string[]; installed: string[]; inbound: Inbound; wentLive?: Cleared; typeform?: string[] }> {
  const wanted = input.templates?.length ? input.templates : templates.map((t) => t.slug);
  const calMap: Record<string, { term: string; name?: string; selfBooked?: boolean; booking?: "self" | "setter" | "question"; questions?: Record<string, string> }> = Object.fromEntries(Object.entries(input.calendars ?? {}).map(([k, v]) => [k, typeof v === "string" ? { term: v } : v]));
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
  // D70: the bot's escalation person, resolved to a Slack id outside the transaction (it asks Slack)
  let escalate: { id: string; email?: string } | null = null;
  if (input.bot?.escalateTo) {
    const want = input.bot.escalateTo.trim();
    if (!want.includes("@")) escalate = { id: want };
    else {
      const token = input.slackToken && input.slackToken !== "disconnect" ? input.slackToken : await asOperator(async (c) => {
        const conn = await one<{ bot_token: Buffer }>(c, "select sc.bot_token from slack_connections sc join companies co on co.id=sc.company_id where co.slug=$1", [input.slug]);
        return conn ? decrypt(conn.bot_token) : null;
      });
      if (!token) throw new Error("bot.escalateTo is an email but no Slack token is connected to look it up");
      const id = await adapters.notifier.lookupUserByEmail(token, want);
      if (!id) throw new Error(`no one in the Slack workspace has the email ${want}`);
      escalate = { id, email: want.toLowerCase() };
    }
  }
  const sc = input.salesCall;
  if (sc?.objections !== undefined && (!Array.isArray(sc.objections) || !sc.objections.length || sc.objections.some((x) => typeof x !== "string" || !x.trim()))) throw new Error("salesCall.objections: a list of option keys");
  if (sc?.closerOptions !== undefined && (!sc.closerOptions || typeof sc.closerOptions !== "object" || Array.isArray(sc.closerOptions) || Object.entries(sc.closerOptions).some(([k, v]) => !k.trim() || typeof v !== "string" || !v.trim()))) throw new Error("salesCall.closerOptions: { <email, CRM user id or roster name>: <option key> }");
  if (input.depositProducts !== undefined && (!Array.isArray(input.depositProducts) || input.depositProducts.some((x) => typeof x !== "string" || !x.trim()))) throw new Error("depositProducts: a list of product or plan ids, e.g. [\"prod_…\", \"plan_…\"]");
  if (input.typeform?.forms !== undefined) { const bad = mapProblems(input.typeform.forms); if (bad.length) throw new Error(`typeform.forms: ${bad.join("; ")}`); }
  // D122: the map is checked against the forms themselves (outside the transaction: it talks to Typeform) whenever a token is given
  if (input.typeform?.token) {
    const forms = input.typeform.forms ?? await asOperator(async (c) => {
      const b = await one<{ value: Buffer }>(c, "select b.value from bindings b join companies co on co.id=b.company_id where co.slug=$1 and b.key=$2", [input.slug, TF_FORMS_KEY]);
      return b ? JSON.parse(b.value.toString("utf8")) as TypeformForms : {};
    });
    const bad = await checkMapAgainstForms(input.typeform.token, forms, typeformApi);
    if (bad.length) throw new Error(`typeform: ${bad.join("; ")}`);
  }
  const cardProblems = (input.bookingCard?.intake ?? []).map(intakeProblem).filter(Boolean);
  if (input.bookingCard && (!Array.isArray(input.bookingCard.intake) || cardProblems.length)) throw new Error(`bookingCard.intake: ${cardProblems.join("; ") || "a list of lines"}`);
  // D56: live is never set by install itself; `mode: "live"` is a go-live after the install, with its readiness refusal and clean slate (D51)
  const modeFlag = input.mode === "live" ? null : input.mode ?? null;
  const out = await asOperator(async (c) => {
    // D88: a company that already existed gets a template that carries what the engine used to do by itself ON, so an upgrade never lets that go quiet
    const existed = !!(await one(c, "select 1 from companies where slug=$1", [input.slug]));
    const storedPit = input.pit ? null : await one<{ value: Buffer }>(c, "select b.value from bindings b join companies co on co.id=b.company_id where co.slug=$1 and b.key='secret.ghl_pit'", [input.slug]);
    const pit = input.pit ?? (storedPit ? decrypt(storedPit.value) : null);
    if (!pit) throw new Error("pit is required: this company has no CRM token stored yet");
    // re-running install never silently flips a live company back to shadow or re-enables SMS: only explicitly passed values change
    const co = await one<{ id: string }>(c, `insert into companies (name, slug, timezone, sms_enabled, mode) values ($1,$2,$3,coalesce($4,true),coalesce($5,'shadow'))
      on conflict (slug) do update set name=excluded.name, timezone=excluded.timezone,
        sms_enabled=case when $4::boolean is null then companies.sms_enabled else excluded.sms_enabled end,
        mode=case when $5::text is null then companies.mode else excluded.mode end returning id`, [input.name, input.slug, input.timezone, input.smsEnabled ?? null, modeFlag]);
    const companyId = co!.id;
    await c.query(`insert into company_terms (company_id, domain, name, category, is_default, sort) select $1, domain, label, value, true, sort from core_categories on conflict (company_id, domain, name) do nothing`, [companyId]);
    const bind = async (key: string, kind: string, value: string) => {
      const vendor = vendorOfBinding(key);
      const prior = vendor ? await one<{ kind: string; value: Buffer }>(c, "select kind, value from bindings where company_id=$1 and key=$2", [companyId, key]) : null;
      await c.query(`insert into bindings (company_id, key, kind, value) values ($1,$2,$3,$4) on conflict (company_id, key) do update set value=excluded.value, updated_at=now()`, [companyId, key, kind, kind === "secret" ? encrypt(value) : Buffer.from(value)]);
      // D66: a re-install with a NEW token wakes the runs paused on that vendor's auth; the same token again wakes nothing
      if (vendor && prior && (prior.kind === "secret" ? decrypt(prior.value) : prior.value.toString("utf8")) !== value) await wakePausedOnAuth(c, companyId, vendor);
    };
    await bind("crm.location_id", "id", input.locationId); await bind("secret.ghl_pit", "secret", pit);
    if (input.scopeTag?.trim()) await bind("scope.tag", "text", input.scopeTag.trim().toLowerCase());
    else if (input.scopeTag === "") await c.query("delete from bindings where company_id=$1 and key='scope.tag'", [companyId]);
    if (input.testDomains) await bind("test.domains", "text", input.testDomains.map((d) => d.trim().toLowerCase().replace(/^@/, "")).filter(Boolean).join(","));
    if (booking.source === "calendly") {
      await bind("secret.calendly_token", "secret", booking.token); await bind("calendly.organization", "id", booking.organization);
      await bind("calendly.user", "id", booking.user ?? ""); await bind("calendly.phone_question", "text", booking.phoneQuestion ?? ""); await bind("calendly.setter_question", "text", booking.setterQuestion ?? "");
    } else if (input.booking) {   // explicitly back to the CRM: drop the Calendly bindings so loadCompany stops choosing it
      await c.query("delete from bindings where company_id=$1 and key in ('secret.calendly_token','calendly.organization','calendly.user','calendly.phone_question','calendly.setter_question')", [companyId]);
    }
    for (const [k, v] of Object.entries(input.crm ?? {})) await bind(`crm.${k}`, "id", v);
    if (input.setterRule) await bind("booking.setter_rule", "text", input.setterRule);
    const answers = (xs: string[]) => JSON.stringify(xs.map((x) => x.trim()).filter(Boolean));
    if (input.qualify?.mqlAnswers) await bind("qualify.mql_answers", "text", answers(input.qualify.mqlAnswers));
    if (input.qualify?.dqAnswers) await bind("qualify.dq_answers", "text", answers(input.qualify.dqAnswers));
    if (input.qualify?.unansweredIsMql !== undefined) await bind("qualify.unanswered_is_mql", "text", String(input.qualify.unansweredIsMql));
    if (input.salesCall?.object) await bind("crm.object_sales_call", "id", input.salesCall.object);
    if (input.salesCall?.outcomes) await bind("sales_call.outcomes", "text", JSON.stringify(input.salesCall.outcomes));
    if (input.salesCall?.bookingSources) await bind("sales_call.booking_sources", "text", JSON.stringify(input.salesCall.bookingSources));
    if (input.salesCall?.dispositions) {
      await bind("sales_call.dispositions", "text", JSON.stringify(input.salesCall.dispositions));
      // a reason is the company's own term under its meaning: made here so the hourly sweep can file it
      for (const v of Object.values(input.salesCall.dispositions)) if (typeof v === "object" && v.reason?.trim())
        await c.query("insert into company_terms (company_id, domain, name, category, is_default, sort) values ($1,'call_outcome',$2,$3,false,50) on conflict (company_id, domain, name) do nothing", [companyId, v.reason.trim(), v.meaning]);
    }
    if (input.salesCall?.dqDispositions) await bind("sales_call.dq_dispositions", "text", answers(input.salesCall.dqDispositions));
    if (input.salesCall?.objections) await bind(OBJECTIONS_KEY, "text", answers(input.salesCall.objections));
    if (input.salesCall?.closerOptions) await bind(CLOSER_OPTIONS_KEY, "text", JSON.stringify(Object.fromEntries(Object.entries(input.salesCall.closerOptions).map(([k, v]) => [k.trim(), v.trim()]))));
    if (input.bookingCard) await bind(BOOKING_CARD_KEY, "text", JSON.stringify(input.bookingCard.intake.map((l) => ({ label: l.label.trim(), ...(l.field !== undefined ? { field: l.field.trim() } : l.answer !== undefined ? { answer: l.answer.trim() } : { tags: Object.fromEntries(Object.entries(l.tags!).map(([t, w]) => [t.trim(), w.trim()])) }), ...(l.plus !== undefined ? { plus: l.plus.trim() } : {}) }))));
    if (input.discoveryCall?.results) await bind("discovery_call.results", "text", JSON.stringify(input.discoveryCall.results));
    if (input.discoveryCall?.act !== undefined) await bind("setter_result.act", "text", String(input.discoveryCall.act));
    if (input.whop?.webhookSecret) await bind("secret.whop_webhook", "secret", input.whop.webhookSecret);
    if (input.whop?.apiKey) await bind("secret.whop_api_key", "secret", input.whop.apiKey);
    for (const [name, id] of Object.entries(input.slack ?? {})) await bind(`slack.channel.${name}`, "channel", id);
    if (input.slackToken === "disconnect") await c.query("delete from slack_connections where company_id=$1", [companyId]);
    else if (slackTeam) await c.query("insert into slack_connections (company_id, team_id, bot_token, bot_user_id) values ($1,$2,$3,$4) on conflict (company_id) do update set team_id=excluded.team_id, bot_token=excluded.bot_token, bot_user_id=excluded.bot_user_id, connected_at=now()", [companyId, slackTeam.team_id, encrypt(input.slackToken!), slackTeam.bot_user_id]);
    if (input.slackSigningSecret) await bind("secret.slack_signing", "secret", input.slackSigningSecret);
    if (escalate) {
      await bind("bot.escalate_to", "id", escalate.id);
    }
    if (input.recording?.webhookSecret) await bind("secret.fathom_webhook", "secret", input.recording.webhookSecret);
    if (input.recording?.apiKey) await bind("secret.fathom_api_key", "secret", input.recording.apiKey);
    if (input.anthropicKey) await bind("secret.anthropic_key", "secret", input.anthropicKey);
    if (input.jevKey) await bind("secret.jev_key", "secret", input.jevKey);
    if (input.alerts?.slackChannel) await bind("alerts.slack_channel", "channel", input.alerts.slackChannel);
    if (input.alerts?.repeatMinutes !== undefined) await bind("alerts.repeat_minutes", "number", String(input.alerts.repeatMinutes));
    if (input.alerts?.pollFailures !== undefined) await bind("alerts.poll_failures", "number", String(input.alerts.pollFailures));
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
    if (input.depositProducts?.length) await bind(DEPOSIT_PRODUCTS_KEY, "text", JSON.stringify([...new Set(input.depositProducts.map((x) => x.trim()))]));
    else if (input.depositProducts) await c.query("delete from bindings where company_id=$1 and key=$2", [companyId, DEPOSIT_PRODUCTS_KEY]);
    if (input.contractValueDefault !== undefined) await c.query("update companies set contract_value_default=$2 where id=$1", [companyId, input.contractValueDefault]);
    if (input.quietHours) await c.query("update companies set send_window_start=coalesce($2, send_window_start), send_window_end=coalesce($3, send_window_end), quiet_allow_transactional=coalesce($4, quiet_allow_transactional) where id=$1", [companyId, input.quietHours.start ?? null, input.quietHours.end ?? null, input.quietHours.allowTransactional ?? null]);
    const ac: Company = { id: companyId, locationId: input.locationId, pit, timezone: input.timezone, booking };
    for (const u of await adapters.read.listUsers(ac))
      await c.query(`insert into users (company_id, email, name, role, ghl_user_id) values ($1,$2,$3,'staff',$4) on conflict (company_id, ghl_user_id) do update set name=excluded.name`, [companyId, u.email ?? `${u.id}@unclaimed.local`, u.name || u.id, u.id]);
    // the bot names whoever it pings ("Let me ping Tyler"): their roster row learns their Slack id
    if (escalate?.email) await c.query("update users set slack_user_id=$3 where company_id=$1 and lower(email)=$2", [companyId, escalate.email, escalate.id]);
    if (input.closers) {
      const who = input.closers.map((x) => x.toLowerCase());
      await c.query("update users set role='staff' where company_id=$1 and role='closer' and not (lower(email)=any($2) or ghl_user_id=any($2))", [companyId, who]);
      await c.query("update users set role='closer' where company_id=$1 and role in ('staff','closer') and (lower(email)=any($2) or ghl_user_id=any($2))", [companyId, who]);
    }
    for (const [who, role] of Object.entries(input.roles ?? {}))
      if (["setter", "manager", "owner", "staff"].includes(role)) await c.query("update users set role=$3 where company_id=$1 and (lower(email)=lower($2) or ghl_user_id=$2) and role<>'operator'", [companyId, who, role]);
    const terms = await many<{ id: string; category: string }>(c, "select id, category from company_terms where company_id=$1 and domain='appointment_type' and is_default", [companyId]);
    const calendarsOut: string[] = [];
    const listed = await bookingFor(adapters, ac).listCalendars(ac);
    for (const k of listed) {
      const m = calMap[k.id]; if (!m) { calendarsOut.push(`skip "${k.name}" (${k.id}) — no mapping${k.note ? ` [${k.note}]` : ""}`); continue; }
      if (!terms.some((t) => t.category === m.term)) { calendarsOut.push(`unknown category ${m.term} for ${k.id}`); continue; }
      const term = m.name?.trim()
        ? (await one<{ id: string }>(c, `insert into company_terms (company_id, domain, name, category, is_default, sort) values ($1,'appointment_type',$2,$3,false,50)
            on conflict (company_id, domain, name) do update set category=excluded.category, active=true returning id`, [companyId, m.name.trim(), m.term]))!.id
        : terms.find((t) => t.category === m.term)!.id;
      const du = k.teamMemberIds[0] ? await one<{ id: string }>(c, "select id from users where company_id=$1 and ghl_user_id=$2", [companyId, k.teamMemberIds[0]]) : undefined;
      const selfBooked = m.selfBooked ?? (m.booking === "self" ? true : m.booking === "setter" ? false : null);
      const config = { ...(m.booking ? { booking: m.booking } : {}), ...(m.questions ? { questions: m.questions } : {}) };
      await c.query(`insert into calendars (company_id, source, external_id, name, appointment_term, default_user_id, self_booked, booking_url, config) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
        on conflict (company_id, source, external_id) do update set name=excluded.name, appointment_term=excluded.appointment_term, self_booked=excluded.self_booked, booking_url=coalesce(excluded.booking_url, calendars.booking_url), config=case when excluded.config='{}'::jsonb then calendars.config else excluded.config end, active=true`,
        [companyId, booking.source, k.id, k.name, term, du?.id ?? null, selfBooked, k.bookingUrl ?? null, JSON.stringify(config)]);
      const how = m.booking === "question" ? " (setter decided by the booking question)" : selfBooked === null ? "" : selfBooked ? " (self-booked)" : " (setter-booked)";
      calendarsOut.push(`"${k.name}" → ${m.name?.trim() ? `${m.name.trim()} (${m.term})` : m.term}${how}${m.questions ? `; questions: ${Object.keys(m.questions).join(", ")}` : ""}`);
    }
    for (const unknownId of Object.keys(calMap).filter((id) => !listed.some((k) => k.id === id))) calendarsOut.push(`mapping for ${unknownId} matches no calendar at the booking source`);
    // calendars of the other source go quiet rather than being deleted: their appointments and history stay
    await c.query("update calendars set active=false where company_id=$1 and source<>$2", [companyId, booking.source]);
    await c.query("delete from poll_cursors where company_id=$1 and entity like 'appointments:%' and split_part(entity, ':', 2) in (select external_id from calendars where company_id=$1 and not active)", [companyId]);
    const closerCal = input.closerCall ?? Object.entries(calMap).find(([, m]) => m.term === "closing")?.[0];
    if (closerCal) await bind("calendar.closer_call", "id", closerCal);
    const bookingCal = input.bookingCalendar ?? Object.entries(calMap).find(([, m]) => m.term === "first_call")?.[0] ?? closerCal;
    if (bookingCal) await bind("calendar.booking", "id", bookingCal);
    const installed = await installTemplates(c, companyId, wanted, { enable: input.enable, existed });
    // Fathom's webhook is registered once per company and remembered; a re-install never makes a second one
    let fathomWebhook = (await one<{ value: Buffer }>(c, "select value from bindings where company_id=$1 and key='fathom.webhook_id'", [companyId]))?.value.toString("utf8");
    const publicUrl = (process.env.PUBLIC_URL ?? process.env.TICK_URL ?? "").replace(/\/$/, "");
    if (input.recording?.apiKey && !fathomWebhook) {
      if (!publicUrl) throw new Error("recording.apiKey given but PUBLIC_URL is not set: cannot tell Fathom where to deliver");
      const hook = await fathomCreateWebhook(input.recording.apiKey, `${publicUrl}/api/webhooks/fathom/${companyId}`);
      await bind("secret.fathom_webhook", "secret", hook.secret); await bind("fathom.webhook_id", "id", hook.id);
      fathomWebhook = hook.id;
    }
    // D122: Typeform's token and map; the engine's own webhook on each mapped form (one tag and secret per company, kept)
    if (input.typeform?.token) await bind(TF_TOKEN_KEY, "secret", input.typeform.token);
    if (input.typeform?.forms) await bind(TF_FORMS_KEY, "text", JSON.stringify(input.typeform.forms));
    let typeformOut: string[] | undefined;
    if (input.typeform) {
      const { bindings: now } = await loadCompany(c, companyId);
      typeformOut = now[TF_TOKEN_KEY] ? await registerTypeform(companyId, input.slug, now, bind, typeformApi, publicUrl) : ["no Typeform token bound: the webhook is not registered"];
    }
    // Whop: with an API key and no signing secret yet, the engine creates its own webhook (api v1, payment + refund events) and keeps the secret it is shown once
    if (input.whop?.apiKey && !input.whop.webhookSecret && !boundKeys.has("secret.whop_webhook")) {
      if (!publicUrl) throw new Error("whop.apiKey given but PUBLIC_URL is not set: cannot tell Whop where to deliver");
      const hook = await whopCreateWebhook(input.whop.apiKey, `${publicUrl}/api/webhooks/whop/${companyId}`);
      await bind("secret.whop_webhook", "secret", hook.webhook_secret); await bind("whop.webhook_id", "id", hook.id);
    }
    return { companyId, calendars: calendarsOut, installed, ...(typeformOut ? { typeform: typeformOut } : {}), inbound: { secret: inboundPlain, zapierPaymentUrl: `/api/webhooks/zapier/${companyId}/payment`, zapierRecordingUrl: `/api/webhooks/zapier/${companyId}/recording`, whopWebhookUrl: `/api/webhooks/whop/${companyId}`, fathomWebhookUrl: `/api/webhooks/fathom/${companyId}`, fathomWebhook } };
  });
  if (input.mode === "live") {
    const r = await asOperator(async (c) => {
      const co = (await one<{ mode: string }>(c, "select mode from companies where id=$1", [out.companyId]))!;
      return co.mode === "live" ? null : goLive(c, out.companyId, `/app/c/${input.slug}`, "install");
    });
    if (r && !r.ok) throw new Error(`Installed, but not ready to go live (the company stays in its current mode): ${r.blockers.map((b) => b.text).join(" ")}`);
    if (r?.ok) return { ...out, wentLive: r.cleared };
  }
  return out;
}
