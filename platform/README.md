# platform/ — the engine

Next.js 15 (API routes only, no dashboard yet), Postgres 16, deployed on Vercel with a one-minute
cron. Design is in `../engine/`; this is what runs.

## What works today (verified live against GHL location RHOfV4fFknN54YQobyWp, 2026-10-06)

- **Install** a company from the CLI: terms from the core vocabulary, encrypted bindings, closers
  from the GHL roster, calendars mapped to appointment types, templates copied and enabled only
  when every required binding exists.
- **Poll** GHL every tick: contacts by `dateUpdated`, appointments per calendar, inbound
  conversations. First poll is a silent baseline; only deltas become events.
- **Dispatch** events to workflow triggers with reentry policies (no double runs).
- **Execute** runs: wait rules (morning-of, evening-before fallback, in the contact's timezone),
  send window (defer forward, never at 2am), live premise check (a cancelled appointment exits
  the run instead of sending), send-time rendering, idempotent sends ledger, Jev classify →
  branch, tags, notes, read-then-write appointment updates, pause on human takeover.
- **Recovery mode** after a scheduler gap: dead runs exit first, sends drip instead of burst.
- **Lifecycle**: first booking opens an opportunity; payment (Whop webhook) wins it; paid-in-full
  is detected from the payments sum.

Live proof: a real appointment booked in GHL was detected, both workflows started, the
confirmation email went out through GHL into the contact's thread, the reminder is waiting for
8am the morning of. 47 tests pass (`pnpm test`), including the end-to-end suite against Postgres.

## The workflows (templates, all install OFF)

| Template | Starts on | Does |
|---|---|---|
| booking-confirmation | appointment booked | confirmation email |
| appointment-reminder | appointment booked (closing calls) | morning-of SMS (evening-before fallback for early calls), waits for a reply, classifies it, branches: confirmed / cancelled / reschedule / needs a human |
| speed-to-lead | lead created | email + SMS now, 2h for a reply, one more email if silent |
| no-show-recovery | GHL marks no-show, or the disposition form does | 10 min, SMS + email with the rebook link, 24h for a reply, one more email |
| cancellation-rebook | GHL marks cancelled | SMS + email with the rebook link |
| post-call-follow-up | disposition says follow-up | next morning SMS |
| payment-received | Whop payment | thank-you email, tag `client` |
| payment-failed | Whop failure | SMS + email, 2 days, Slack the owner if connected |
| reactivation | tag `reactivate` added | email, 3 days, SMS, 4 days, last email; once per 90 days |
| call-booked | closing call booked or moved | contact gets appointment date + closer as owner; setter card → Direct Booked Call ("-- Direct") or Appointment Set ("-- Set", setter stamped); closer card created/moved to Scheduled ("-- Direct" / "-- Setter Booked"); tags `stat-booked` + `stat-self-booked`/`stat-set`, nurture tags off; Slack card with intake answers, reschedule link, UTM source. Needs the setter/closer pipeline + stage ids and the custom field ids as `crm.*`; `slack.channel.bookings` optional |
| call-cancelled | closing call cancelled (a reschedule never fires this) | setter and closer cards → their cancelled stage (move only); appointment date cleared on the contact; rebook task for the closer due in a day with who cancelled and why; `stat-cancelled` on, booked tags off; Slack note. Needs `crm.stage_setter_cancelled`, `crm.stage_closer_cancelled` |
| payment-recorded | payment linked to a contact | cash collected on the contact = running total; revenue generated stamped once with the program price; `pay-paid-full` (and `pay-plan-active` off) when cleared, else `pay-plan-active`; Payment custom-object record written and linked to the contact and the closer card; Slack line. Needs `crm.field_contact_cash_collected`, `crm.field_contact_revenue_generated`, `crm.assoc_payment_contact`, `crm.assoc_payment_opportunity`, `crm.pipeline_closer`; `slack.channel.payments` optional |
| call-recorded | a call recording matched to a contact | AI decides whether it is a sales call (else stop), pulls the notes and scores the call against the rubric (`analyze` nodes on `prompt.call_classify` / `prompt.call_notes` / `prompt.call_rubric`); when an appointment matched: appointment recorded as showed (`call.held` fires), `stat-showed`, setter card → Showed and won; Sales Call record written and linked; notes on the contact; Slack review. Needs `secret.anthropic_key`, `crm.stage_setter_showed`, `crm.assoc_sales_call_contact`, `crm.assoc_sales_call_opportunity`; `slack.channel.calls` optional |
| setter-call-logged | the dialer logged a connected phone call (`call.logged`) | under the minimum length (a `set_var` knob, 60s, editable on the step) or no recording → stop; 15 minutes after the call the AI says setting / confirmation / other (`prompt.setter_call_classify`; other → stop), writes the digest with pains, goals, triage and a fit score (`prompt.setter_call_notes`); whether a booking followed is read from our appointments; Discovery Call record written and linked to the contact (`led_to_booking` checkbox as `["yes"]`), digest as a note, Slack post. Needs `secret.anthropic_key`, `crm.assoc_discovery_call_contact`; `slack.channel.setter_calls` optional |
| agreement-send-manually | tag `sys-send-agreement-manually` added | unless already signed: `send_document` (the Documents & Contracts template `crm.agreement_template`, from `crm.agreement_sender`), tag `stat-agreement-sent`, trigger tag removed, note |
| agreement-signed | the signer completed the agreement (`agreement.signed`, from the documents poll) | tag `stat-agreement-signed`, dated note, Slack (`slack.channel.deals`) |
| deal-closed | first payment OR agreement signed, either order, once per contact | gate: paid AND signed AND not tagged `stat-customer` (else stop, and the stop does not use up the "once"); then `stat-customer`, closer card → Closed - Won (won), setter card won, Sales Call record `closed_won` / `showed` with cash collected, welcome email + text (CRM templates by id when set on the step, else the copy on the step), Slack. Needs `crm.stage_closer_closed_won`; `slack.channel.deals` optional |
| agreement-chase | first payment | 24h → unsigned? → nudge the owner (Slack DM, else `slack.channel.alerts` with an @mention; CRM task on the contact) → 24h → … three nudges at most; a signature ends it; after the third: tag `agreement-unsigned`, one alerts post |
| payment-recorded (extended) | payment linked | as before, plus on the first payment with no signature: send the agreement, `stat-agreement-sent`, closer card → Agreement Sent (`crm.stage_closer_agreement_sent`); dated note; Sales Call record cash collected updated when there is one |
| new-lead | lead created | with a phone: setter-pipeline card "Name -- New" (stage New Lead, stage-entered date today) + tag `stat-new`; without a phone: exit `no_phone`. Needs `crm.pipeline_setter`, `crm.stage_setter_new_lead`, `crm.field_opportunity_stage_entered` (install `crm: {...}`) |

Every message is a template on the workflow, editable per company once the editor exists; until
then, edit the company's copy in `workflow_versions`. SMS nodes skip cleanly for a company with
`sms_enabled=false` (`--no-sms` on install).

## Database connection (Supabase)

The engine connects through Supabase's **transaction-mode** pooler (port 6543). A session-mode pooler URL
(port 5432 on `pooler.supabase.com`) in `SUPABASE_DB_URL` is normalised to 6543 at startup, because
session mode is capped at 15 clients for the whole Supabase project, shared with every other app in
it, and each warm Vercel instance holds its own pool; the symptom was `EMAXCONNSESSION max clients
reached` in production. Direct connections and non-Supabase URLs pass through. `DB_POOLER_MODE=session`
opts out. The engine is transaction-pooler safe: every query runs inside `begin … commit` with
transaction-local `set_config`, no session advisory locks, no named prepared statements. Pool: 3 per
instance, 5 second idle timeout.

## Payments (D21)

**Whop by API key.** Install with `whop: { apiKey }` (or paste it in settings › Connections) and the
engine creates its own Whop webhook (api v1; payment.succeeded, payment.failed, refund.created) at
`/api/webhooks/whop/<companyId>`, binding the signing secret it is shown once (`secret.whop_webhook`,
`whop.webhook_id`), the same way it registers with Fathom. The key also powers the payment history
backfill. Needs `payment:basic:read` and `developer:manage_webhook` on the key.

Whop posts to `/api/webhooks/whop/<companyId>` (signature verified, Standard Webhooks). Each
payment is a ledger row linked by member id, email or phone, or left **unlinked** with a team
alert and a row on `/c/<slug>/payments` where an operator links it to a contact. Linking settles
it: pursuit, derived kind, running total, `cleared`, and the `payment.received` event that starts
workflows. Set the program price with `contractValueDefault` at install and the Whop signing
secret with `whop: { webhookSecret }`. Facts about Whop's payload are in `whop/01-api-facts.md`.

### Payments through Zapier instead

When the processor's own webhooks are out of reach, a Zap forwards them: trigger on the payment in
Zapier, then **Webhooks by Zapier → POST** to `/api/webhooks/zapier/<companyId>/payment` with header
`x-engine-secret: <secret>` (install returns the secret under `inbound`) and a JSON body of the
mapped fields: `transaction_id`, `amount`, `email`, `phone`, `member_id`, `paid_at`, `status`
(`succeeded` default, or `failed` / `refunded`). Same ledger, same linking, same idempotency on
the transaction id, so a replayed Zap changes nothing.

## Recordings (D22)

A call recording reaches the engine through either door: Fathom's own webhook at
`/api/webhooks/fathom/<companyId>` (Standard Webhooks, secret `secret.fathom_webhook`; install
registers it for you with `recording: { source: "fathom", apiKey }` when `PUBLIC_URL` is set), or a
Zap posting to `/api/webhooks/zapier/<companyId>/recording` with the same `x-engine-secret` as the
payment door (body: `recording_id`, `title`, `started_at`, `duration_seconds` or `duration_minutes`,
`share_url`, `recorded_by_email`, `invitees` as "Name <email>, …" or an array, `transcript` as text or
an array, `summary`). Either way it is a `recordings` row, matched by invitee email → invitee name →
the recorder's calendar (one appointment within two hours), or left **unmatched** with the reason, a
team alert, and a row on `/c/<slug>/recordings` where an operator links it. A linked recording
emits `recording.received` (with the contact's appointment nearest the start, within a day) and
templates take it from there. Facts about Fathom's API are in `fathom/01-api-facts.md`.

### Phone calls the dialer logs (D28)

A call placed or taken in GHL is a `TYPE_CALL` entry in the contact's conversation, and the
conversations poll turns every one of them (answered or not) into a `recordings` row: provider `ghl`,
the entry's id as `external_id`, linked straight to the contact (the thread names them, no ladder),
`raw` carrying the dialer's facts (`direction`, `call_status` normalised to connected / voicemail /
no_answer / busy / failed, `duration_sec`, `caller_ghl_user_id`), `recorded_by_*` = the user who
dialed. GHL writes the entry when the call ends and the transcript minutes later, so a connected call
sits `raw.transcript_status = pending` and the `calls` poll re-reads it each tick, settling it when the
transcript lands (stored as `transcript`, recording link as `url`) or after 30 minutes without one.
`call.logged` fires once per call, at settle, with `recording.kind = phone`, `connected`,
`duration_sec`, `has_transcript`, `direction`, `status`, `caller` available to trigger matches and
to the run (`recording.caller.name`, `recording.led_to_booking` = an appointment booked after the
call started, read live). A call is never a reply: it does not wake `wait_for_reply`, and `TYPE_ACTIVITY`
entries are skipped too. Every call stays in the ledger for connection-rate and speed-to-lead
reporting later. Recording is not on for every call in GHL (verified on Hair: 2 of 4 long calls had
one), so a connected call with no transcript is a normal case, not an error.

### Reading a call with AI

The `analyze` node sends the transcript (`{{recording.transcript_text}}` by default) to Claude with a
prompt bound per company as `prompt.<name>` (kind `text`, defaults shipped in `src/prompts`,
override with `prompts: { call_notes: "…" }` at install). The answer is parsed as JSON and stored
under `vars.<into>`, so later steps address its fields (`{{vars.notes.disposition}}`) or render the
whole thing as Slack/note text with the `lines` filter (`{{vars.notes | lines}}`). The key is
`secret.anthropic_key` per company (`anthropicKey` at install; env `ANTHROPIC_API_KEY` is the
fallback); without one the node fails loudly. Analysis runs in shadow too: it writes nothing to the
CRM, and seeing what the AI would say is the point. Model: Claude Opus 5.5, prompt cached, server-side
fallback on a safety decline. Each read is a `call.analyzed` event and is kept on the recording row.

`record_outcome` writes an outcome (showed / noshow) onto our appointment row, the same path the
closer's disposition form takes, so `appointment.outcome` and `call.held` fire for a company whose
booking source has no outcome (Calendly). `pipeline_card` takes `status: won|lost` to close a card.

## Wrap-ups and the rollup layer (D29)

What the engine stores, and why, in three layers:

1. **Ledger** — the facts the workflows run on: events, appointments, opportunities, payments,
   recordings (meetings and dialer calls), a thin contact replica (name, phone, email, tags and ONLY
   the custom fields a `crm.field_contact_*` binding names; a sub-account can carry hundreds).
   Form answers live as one JSON on the booking (`appointments.answers`) or the contact
   (`intake`), never as a copy of every field.
2. **Daily rollups** — `rollups_daily`: one row per company, local day, dimension (total / a setter /
   a closer) and metric, counts and sums only (the table never stores a rate; rates are computed when
   read from numerator and denominator). Recomputed from the ledger per day, so it is a cache, not a
   second truth. Harness rows (`source='test'`, `raw.simulated`) never count.
3. **Pointers** for content the CRM owns and the engine only acts on: fetch the record live when
   someone wants the detail. The bot (later) answers aggregates from layer 2, what only we hold
   (calls, timings, transcripts) from layer 1, and a specific contact or deal from GHL live.

Metrics today: new leads (by the CRM's own arrival time, `contacts.ghl_added_at`), booked the same
day, called (a dial happened after arrival; sum of seconds to the first dial → average), reached (a
connected dial at least `companies.reached_seconds` long, default 60, set per company in settings), dials,
connected, talk seconds, set from a call, setting / confirmation calls read by the AI, calls booked
(setter- vs self-booked), on the calendar / showed / no-show / cancelled, payments, cash, refunds,
deals won, revenue. Per setter: dials, connects, talk, sets, bookings they set. Per closer:
bookings, calendar outcomes, deals, revenue.

**Wrap-ups** are rendered from the rollups and posted to Slack on the company's own clock:
`wrapup_schedules` has a daily (default 19:00), weekly (Monday 08:00, covering last Mon–Sun) and
monthly (1st at 08:00, covering last month) row per company — time, day, channel (a Slack id, else
`slack.channel.reports`, else `slack.channel.bookings`), breakdowns (per setter / per closer) and
sections (what they said = booking-form answers tallied per question) all live there, edited in
settings › Wrap-ups. Each fires once per period (`last_period_start`), on the first tick after the
time; a missed day sends late, never twice. Every generated wrap-up is a `wrapups` row shown on
`/c/<slug>/reports` exactly as sent (shadow: recorded, not posted). **Generate now** in settings and
`POST /api/admin/reports { company, kind, period_start?, period_end? }` make one on demand for the
period in progress (today so far / this week so far / this month so far).

### History (backfill)

`POST /api/admin/backfill { company, days? | from?, to?, steps? }` (Bearer `$CRON_SECRET`, default 30 days; keep a window to about two weeks per call, the request has 300 s; `steps` narrows to e.g. `["payments"]`)
reads the window back the way the poll reads forward and writes rows only — no events, no runs:
contacts with their arrival time (and only the bound custom fields), every dialer call with its
transcript, bookings from the booking source, outcomes the old Zaps left on GHL's Sales Call object
(matched by the booking id, else contact + call date; never overwriting an outcome the engine already
has), won opportunities (contract value from `crm.field_opportunity_contract_value`, else the
opportunity's value), and payments from Whop's own API when `secret.whop_api_key` is bound (through the
same ledger path as a webhook: linked by email / phone / member id, else unlinked for the dashboard to
fix), then rolls every day up. Keyed on source ids, so re-running is safe.

## Agreements (D30)

GHL's Documents & Contracts is read by the poll (`GET /proposals/document`, 21 per page): every document the
location sent is a row in `agreements` (document id, signer contact, status sent / viewed / completed,
`signed_at`). A new row is `agreement.sent`; the first time the signer has completed it is
`agreement.signed`, once, whatever order the poll sees things in. The first pass is a silent baseline.
`send_document` sends a template to the contact from a CRM user (needs the token's documents send
scope; the request body is unverified until that scope exists) and records the row first so the poll
does not announce it twice. In shadow it is skipped like every CRM write. Facts every run can check:
`contact.paid`, `contact.payments_count`, `contact.cash_collected`, `contact.first_paid_at`,
`contact.agreement_signed`, `contact.agreement_sent`, `contact.owner` (the CRM assignee, else
`crm.default_closer`; name, email, Slack id when known), `agreement.*` (the latest agreement), and
`records.<object>.key` (the latest CRM record of each object the engine wrote for them). Predicates gain
`has` (a list contains a value): `{"has": ["{{contact.tags}}", "stat-customer"]}`.

**Gate exits.** A run that stops at a `check` before doing anything releases its once-per key, so a
`once_per_contact` workflow with two triggers (payment, signature) can stop on the first and run on the
second. A trigger that arrives while a run still holds the key is remembered on it (`pending_events`)
and replayed if that run stops at a gate, so two triggers in the same minute cannot lose one. **notify_owner** DMs the contact's owner in Slack (looked up by email, cached as
`users.slack_user_id`; the app needs `im:write`, `users:read`, `users:read.email`), else posts to the
fallback channel with an @mention, and optionally creates a CRM task on the contact. **CRM templates:**
Every Slack post carries its own display name and icon (`as: { name, icon }` on `slack_post` and
`notify_owner`; `icon` may be a list, one picked at random per post, so each kind of post has its own faces: a phone or
a calendar for a booking, money bags for a payment, a party for a close, pen and paper for an agreement; company
defaults as bindings `slack.name` / `slack.icon`; needs the app scope `chat:write.customize`). A post with
`thread_of: <step id>` replies in the thread of that earlier post (the call scorecard under the call post).
Context facts for posts: `contact.closer` (the open closer card's owner, else the contact's owner), `contact.setter`
(the setter field, matched to a team member of that exact name), each with `.mention` (`<@U…>` once looked up in
Slack by email, else the name), `contact.first_booked_at`, `contact.days_to_close` (first booking → first payment),
`contact.revenue` (the opportunity's value, else the program price), `contact.source` (`crm.field_contact_lead_source`).
Template filters: `prefix:` and `line:` render a labelled value only when it exists (`line:` on its own line),
`link:Label` makes a Slack link only when there is a URL, `money` adds separators, `bullets` lists an array; the
date filters pass an absent value through to `default:`. An `analyze` step marked `optional` is skipped, not
failed, when the AI cannot run (the one-line congratulations on a close). `send_sms` / `send_email` take `ghl_template` (an SMS snippet id or an email builder template id,
editable on the step), and the CRM's copy wins when it exists. Harness actions `agreement` (a sent,
unsigned document) and `sign` (completed) stage the document side.

## Pipeline cards (D19)

Templates create and move cards on the CRM's pipeline boards (`pipeline_card` node). Pipeline,
stage and custom-field ids are `crm.*` bindings set at install (`crm: { pipeline_setter: "...", ... }`),
so a template is portable across companies. One open card per contact per board: a re-fire moves
and renames it instead of duplicating; `if_missing: skip` makes a step move-only. Cards live in
`pipeline_cards`, each hanging off the contact's one open opportunity (the pursuit), so a setter
card and a closer card for the same sale share one opportunity, and the booking attaches to that
same pursuit. In shadow the card exists only in our table.

Custom-object records (`crm_record` node) are upserted by our own key (the Whop payment id, the
Calendly event uuid) through `crm_records`, so the CRM's lagging search is never consulted;
`relate` links the new record to others by association id, and the record's CRM id is `{{record.id}}`
for the rest of the run. The contact's open card on each bound board is `{{cards.<name>}}`
(`id`, `stage`, `name`, `owner`), so a payment record can point at the closer card and its owner.

Contact custom fields are readable in templates by the name they were bound under:
`crm.field_contact_hair_loss = <id>` → `{{contact.fields.hair_loss}}`. `update_contact` writes
native fields and custom fields by id; empty values are never written.

## Booking sources (D18)

A company's appointments come from GHL calendars (default) or from Calendly event types. Install
decides: pass `booking: { source: "calendly", token, userEmail }` (API) or `--calendly-token` (CLI)
and the calendar mapping keys become event type uuids. Contacts and messaging stay on GHL either
way; a Calendly invitee is matched to the GHL contact by email/phone. Calendly is read-only to the
engine: a reschedule is one appointment moved, a cancellation is a status change, and
`update_appointment` is skipped with a note. Facts about the Calendly API are in `calendly/01-api-facts.md`.

## Asking for things (D27)

Until the in-tool agent exists, the chat is the agent. Three shapes cover almost everything:

- **New offer**: the client's name, the booking source (GHL or Calendly) and its token, the GHL location
  and PIT, which calendars are which kind of call and how setter vs self is decided on each, which
  workflows to turn on. → install, then the settings page shows what is still missing.
- **New workflow**: which client, what starts it (see the Triggers page) and any condition, the steps in
  order (text / email / wait until… / move to pipeline X stage Y / tag / task / note / Slack), what the
  team should see. → a template, installed on that client, chart to check, copy editable on the page.
- **Copy a workflow to another offer**: "copy X from A to B". → installed on B; the manifest says which
  copy, channel, stage or field B has not got, and those are the only questions asked.

## Settings screen (`/c/<slug>/settings`)

Everything a company's installed workflows need, driven by their manifests: connections (GHL location
and PIT, Anthropic, Whop, Fathom — pasted, stored encrypted, shown only as "set · ends with …"),
booking source (GHL calendars or Calendly with token and host email), each calendar's call type,
setter-vs-self rule and question map, every `crm.*` id as a drop-down from the live GHL lists
(pipelines, stages, contact and opportunity fields, associations, users), Slack bot token and
channel ids, prompts, dark hours and program price, and the inbound door URLs with the Zapier
secret. Keys a workflow requires and nobody has set are marked missing; the readiness card at the top
is the same one the company page shows. Test GHL refreshes the roster; Register Fathom webhook
creates the webhook from here. Install JSON still works for scripting; the screen writes the same
bindings.

Every host's calendars are pulled (Calendly: all organization members, round-robin types once with all
their hosts) with their real booking questions; each question gets a "use as" name (`setter`,
`phone`, or an attribute readable as `appointment.answers.<name>`). Call types are the company's own
words over the four categories. **Tell it how things work** (top of the page) turns a paragraph plus
the live facts into a proposal — calendars mapped, setter rule, default closer, roles, call types —
with the questions it still has; apply or discard. Needs an Anthropic key (company or server).

Nothing on a workflow page is editable (D32): the page shows what the workflow does and what it would
produce; changes to copy, steps, channels, pipelines or icons go through the chat, which edits the
template or the company's copy and re-installs. (`src/engine/edits.ts` and `copy.ts` are the engine
side of those edits and stay; the dashboard no longer exposes them.)

## Alerts and the health sweep (D33)

The engine says what broke the minute it breaks, and nothing while it works. Every tick, a run that failed
becomes an alert with the workflow, the step in words, the contact and the error; a poll cursor that has
failed twice in a row becomes one; a workflow copy the engine cannot parse becomes one. One open alert per
(company, key): the first time it is posted to the company's destinations (`alerts.slack_channel`,
`alerts.email` via Resend with `secret.resend_key` and `alerts.email_from`, `alerts.webhook` for a Zap), and
remembered with its Slack ts. Still open an hour later → a line in that thread, never a new post. Cleared
(the next run got past the step, the poll succeeded, the sweep found it fine) → "Resolved" in the thread and
a ✅ reaction on the first post (the Slack app needs `reactions:write`; without it the thread still says
resolved and says what scope is missing). The dashboard home and each company page show what is open;
`/c/<slug>/health` shows open alerts, the last sweep check by check, and what cleared recently.

The **health check** is its own automation, per company, with its own clock (default every 60 minutes),
channel, name and icon, and list of checks, all on the settings page (`health_checks`). It is read-only
against every vendor. Checks: the GHL token opens the location; every mapped GHL calendar returns free slots
over the next 7 days (a closer's Google/Outlook sync dropping shows up as no slots: GHL has no flag for it);
every bound pipeline, stage, contact field and opportunity field still exists; closers on calendars and open
cards are still users; the Calendly token answers and every mapped event type is active with available
times over 7 days (same idea: a host's calendar disconnecting empties availability); the Whop key reads
payments and the engine's Whop webhook still exists and is enabled; the Fathom key lists meetings and the
Fathom webhook is still registered (Fathom's listing endpoint is unverified: when there is none, the sweep
falls back to delivery age); the Slack bot token is alive and the bot is in every channel the workflows post
to; the Anthropic key answers; no enabled workflow is missing a binding. A failed check is an alert like any
other and clears itself on the next clean sweep. `Sweep now` on the health page runs it on demand.
Probes live in `src/adapters/*/health.ts` and are injectable (`HealthProbes`), so `src/engine/health.ts`
is tested without the vendors (`alerts.test.ts`).

**Every step is covered by construction.** `src/engine/coverage.ts` lists what each workflow depends on
outside the engine from the definition itself: every `{{crm.*}}`, `{{calendar.*}}`, `{{slack.channel.*}}`,
`{{prompt.*}}`, `{{secret.*}}` a step reads, plus what each node type needs (`NODE_NEEDS`: the trigger's
event, a custom object, a hand-off target, a classifier domain, the AI key, Slack, a CRM template, the
documents scope) and every fixed http(s) link in copy. The sweep's "Every step can fire" check walks every
enabled workflow and verifies each of those (bound, exists in the CRM, channel readable, event emitted,
target installed and on), and lists the kinds it cannot verify (`VERIFIES`). "Links in copy" fetches every
fixed link once per sweep. `coverage.test.ts` fails when a node type is added without a `NODE_NEEDS` entry
or a shipped template needs a kind nobody decided how to verify, so a new step cannot ship unchecked.
A finding that the engine can repair carries a fix (`Re-register the Whop webhook`): a button on the health
page and a link in the Slack alert.

## Readiness (is it safe to go live?)

The company page and every workflow page carry a readiness card built from facts
(`src/engine/readiness.ts`): shadow vs live, Slack connected or not, each workflow's required bindings
present or missing, Slack channels unbound, and the gaps the engine knows it still has for a template
(`KNOWN_GAPS` — delete the entry when the piece ships). A workflow that is ON with a missing binding is a
blocker; the same gap on a workflow that is OFF is a note. Nothing here is typed by hand.

### Turning workflows on and off from outside

`GET /api/admin/workflows?company=<slug>` lists a company's workflows with their readiness;
`POST /api/admin/workflows` with `{ "company": "<slug>", "workflow": "<template slug or name>", "enabled": true|false }`
flips one. Both take `Authorization: Bearer $CRON_SECRET`. Turning on a workflow that is missing a
required binding is refused (409) — the same thing the readiness card calls blocking. Every flip is
in `audit_log`.

## Test harness: a real contact, behind the scenes (D23)

To see what the engine would do for a real person without firing a single Zap or GHL workflow, stage
the step instead of performing it. Three ways, same code:

- In GHL, add a tag `sys-test-<action>` to the contact. The next poll runs the action and drops the
  tag from the engine's view (it never becomes a `tag.added` event). Remove the tag in GHL afterwards
  so it can be used again.
- On the contact page in the dashboard, the **Test harness** buttons.
- `POST /api/admin/simulate` `{ "company": "<slug>", "contact": "<email | GHL id | our id>", "action": "<action>" }`
  with `Authorization: Bearer $CRON_SECRET`.

Actions: `create` (a lead comes in), `book` (a setter books the closing call, 3 days out, 2pm in the
contact's zone), `book-self`, `reschedule` (+2 days), `cancel`, `pay` (the program price), `agreement`
(an agreement sent and unsigned), `sign` (the agreement completed), `record`
(a Fathom-shaped recording with a short transcript, through the match ladder), `call` (a connected
3-minute dialer call 20 minutes ago with a setting-call transcript, dialed by the roster's setter),
`reset` (the engine
forgets every run, send, card, pursuit and synthetic appointment for that person; the contact stays).
Synthetic appointments have `source = 'test'` and never exist at a booking source; the premise check
trusts our row for them. The closer on a staged booking is the calendar's host when known, else the
user bound as `crm.default_closer` (a GHL user id), else the first closer on the roster. Refused while the company is live (`force: true` on the API overrides).

## Triggers

`/c/<slug>/triggers` lists every event a workflow can start from, in plain words, where each comes
from, which of the company's workflows use it, and how often it has been seen. The list is the
`event_types` table: teaching the engine a new fact (a new door, a new node) adds an event there and
every company sees it.

## Seeing what will happen (and when)

Every live run shows its plan: the contact page ("What happens next"), the run page, and the workflow
page ("In this workflow right now") list, step by step, what the engine will do and the time it will
release the contact to each step — computed with the same wait, dark-hours and guard rules the runner
uses (`src/engine/project.ts`). The plan stops at a decision or a reply-wait, because the engine
cannot know the answer yet. The workflow page also shows the flow as a table (step, kind, what it
does, where it goes) for checking a flow without reading the chart.

## The engine watching itself

After every tick the engine lists its own problems (poll failures, cursors failing repeatedly, runs
failed in the last ten minutes, workflow copies that no longer parse, a recovery catch-up), shows them
on the dashboard home, and POSTs new ones to `OPERATOR_WEBHOOK_URL` (a Zap catch hook or a Slack
incoming webhook) — once, then hourly while they persist. For the one failure it cannot see (the
scheduler itself dead), a second pg_cron job inside the database (`bb-watchdog`, every five minutes)
POSTs to the same webhook when the last tick is older than five minutes — installed by
`POST /api/admin/schedule` once `OPERATOR_WEBHOOK_URL` (or `alertUrl`) is set. No outside monitor is
needed; `GET /api/health?assert=fresh` (503 when stale) remains for anyone who wants one. Recovery after a gap drips at most 20 sends per company per
tick, in due order; messages that lost their window are skipped by the validity rules, not sent late.
`pnpm build` runs the migration first, so a deploy cannot serve code against an older schema.

### Setter attribution and booking questions (D24)

Company default: `setterRule` at install (`booking.setter_rule`): `calendar` (a separate setter
calendar or event type), `question` (one calendar; a setter named in the booking question means
setter-booked), `either`. Per calendar, which wins: `calendars: { "<id>": { term: "closing", booking:
"question", questions: { setter: "Who set this call for you", phone: "Best number", noticing_for: "How
long have you been noticing" } } }`. Question texts are matched case-insensitively on a prefix. Mapped
answers are on the appointment as `{{appointment.answers.<name>}}`. Templates only read
`appointment.self_booked`, `appointment.set_by` and `appointment.answers.*`.

### The copy

Hover any line of a workflow's outline to see the message it produces, rendered as an example
against a made-up contact (`src/engine/example.ts`: Jane Doe, Allan P, Luis, $1,500, tomorrow 2pm).
It is an example, not a preview: the point is to read the copy the way the team will, not the template.

## Dark hours

Every company has a send window (`send_window_start` / `send_window_end`, default 08:00–20:00 in the
contact's zone). A `send_sms` / `send_email` node is `kind: "human"` by default and always waits for
the window. Mark a node `kind: "transactional"` for an automated receipt ("you're booked") and set
`quiet_allow_transactional` on the company (install `quietHours: { start, end, allowTransactional }`)
to let those through at any hour. Nothing human-sounding ever goes out in the dark.

## Smoke journey

`pnpm smoke` (optionally `--template <slug>` repeated to mirror a real company's set) runs "a client
comes in, then books a call" through the real engine against `DATABASE_URL` with fake adapters, in a
throwaway company `smoke` in shadow, and prints the whole story: events in order, each run step by
step in words, every message or Slack post that would have gone out, the pipeline cards and tags
afterwards, what is parked for later, and the readiness list. Nothing external is called.

## Shadow mode (how a client gets migrated)

Shadow posts to Slack ARE posted, with a "🧪 shadow —" prefix, when Slack is connected (D31): the team is not
the CRM or the contact, and seeing the posts is the point of the run. The send is recorded as `shadow`.

Every company is in **shadow** until someone presses **Go live**. In shadow the engine polls,
dispatches, runs and branches exactly as live, renders every message, and writes nothing to GHL:
sends are recorded as "would send" with the exact text, tags and notes are logged, appointment
updates are logged. A read-only Private Integration Token is enough. Verified on a real
location with all nine workflows on: zero messages, zero tags reached GHL.

So: install with a read-only token → let it run → read `/c/<slug>/sends` ("Would have sent") →
fix copy or timing → **Go live** on the company page, then turn workflows on one at a time.

## Reading a workflow

A workflow is shown as a short numbered list (`src/ui/Outline.tsx`), read top to bottom the way it
runs: `When: Agreement signed` · `Add tag: stat-agreement-signed` · `Add internal note: "Agreement
signed…"` · `Post to Slack: #deals` · `Complete.` Names come from the company's own lists (pipeline and
stage names, #channel names, team names), never ids. A branch reads as "Depending on: a → #4, b → #7".
Hover a line to see what it produces as an example. On a run page the same list carries a colored
edge per step: green ran, blue waiting here, red failed, amber skipped. The words come from
`src/engine/describe.ts`, so the outline and the engine's own descriptions never disagree.

## The dashboard

Read-only except one button. `/` engine health and companies · `/c/<slug>` workflows, poll
health, runs, latest events, contacts · `/c/<slug>/w/<id>` a workflow as an outline with
examples on hover, bindings, versions, definition (audit), **Turn on / Turn off** · `/c/<slug>/r/<id>` a run
on the same outline with every step colored · `/c/<slug>/appointments` last 7 and next 14 days, flags calls needing a
disposition · `/c/<slug>/appointments/<id>` the **disposition form** (did they show, how it
went, notes) · `/c/<slug>/contacts/<id>` the journey · `/c/<slug>/sends` every message sent, suppressed, failed, or (in shadow) would-have-sent · **Go live / Switch to shadow** on the company page.

## Bring-up from a session that has the secrets

The Claude Code environment holds `SUPABASE_DB_URL`, `GHL_PRIVATE_TOKEN`, `GHL_LOCATION_ID` (plus
`BINDINGS_KEY`). From a fresh session:

```bash
cd platform && pnpm install
pnpm bootstrap --name "J. Tyler Ray" --slug jtr --tz America/Phoenix \
  --calendar GLWzPNAZPoxkROdFJbPH=closing --calendar RzQgbmwwCIJeHv8YLXO8=closing --calendar kbEwrOhdlzxAHIpNLqF7=first_call
```

Migrates the Supabase database, installs the location in shadow with SMS off and every workflow
off. Then put the same connection string into Vercel as `DATABASE_URL` (or `SUPABASE_DB_URL`;
the app reads either) and redeploy, and `backend-in-a-box.vercel.app` is live.

## Run it locally

```bash
cd platform && pnpm install
cp .env.example .env            # fill DATABASE_URL, BINDINGS_KEY (openssl rand -base64 32)
pnpm db:migrate                 # applies ../engine/schema.sql + forces RLS on every tenant table
pnpm install:company --name "Save Your Hair" --slug syh --tz America/Phoenix \
  --location <ghl_location_id> --pit <private_integration_token> \
  --calendar <id>=closing --calendar <id>=first_call \
  [--booking <id>] [--no-sms] [--enable] [--live]   # booking link; no number; turn workflows on; live instead of shadow
# appointments in Calendly instead of GHL calendars (ids are event type uuids; :self / :setter stamps every booking):
#   --calendly-token <read token> --calendly-user james@company.com --calendar <uuid>=closing:self --calendar <uuid>=closing:setter
pnpm tick                       # one poll + one scheduler pass; this is what the cron does
# Workflows install OFF. Add --enable to the install command (or flip `workflows.enabled`) when you mean it.
# Re-running install upgrades untouched template copies; --pit may be omitted then (the stored token is kept).
pnpm test
```

## Deploy (Vercel)

Project `backend-in-a-box` exists in team `jtylerray` (root directory `platform`). The route
`/api/tick` checks `Authorization: Bearer $CRON_SECRET`. Only one tick runs at a time: it takes a
6-minute lease in `engine_state` (`tick_lock`), and any tick that arrives while the lease is held
answers `200 { busy: true }` and does nothing. A tick killed mid-flight frees the lease by expiry.
The first tick after installing a company is the baseline and can take a few minutes for a large
location; a client that times out waiting for it has not stopped it.

Scheduler install (once per database, idempotent — re-running replaces the job):

```
curl -X POST -H "Authorization: Bearer $CRON_SECRET" https://backend-in-a-box.vercel.app/api/admin/schedule
curl -H "Authorization: Bearer $CRON_SECRET" https://backend-in-a-box.vercel.app/api/admin/schedule   # status + last 5 runs/responses
```

`/api/health` reports `last_tick`; if it is more than two minutes old the scheduler is not running.

**Scheduling depends on the Vercel plan.** The team is on Hobby today, which allows daily crons only
— a deploy with `* * * * *` is rejected outright (`cron_jobs_limits_reached`). So:

| Plan | Minute scheduler | `vercel.json` cron |
|---|---|---|
| Hobby (now) | **pg_cron inside Supabase** every minute → `/api/tick` (installed once with `POST /api/admin/schedule`; `GET` shows the last runs; `DELETE` removes it). `.github/workflows/tick.yml` stays as a backup and is harmless when it fires. | daily `0 9 * * *` = the reconciliation sweep |
| Pro | `vercel.json` set to `* * * * *` | the Actions workflow stays on as the backup scheduler |

Five-minute latency is fine for testing and wrong for production reminders; Pro is the real fix.

Env already set: `CRON_SECRET`, `BINDINGS_KEY`, `OPERATOR_EMAIL`.

### What Tyler has to do (I can't from here)

| Need | Why | How |
|---|---|---|
| **Connect the GitHub repo in Vercel** | The project was created with the git link but no deployment fired — the Vercel GitHub app isn't authorized on `The-Ops-King/backend-in-a-box`. | Vercel → project → Settings → Git → Connect. After that every push to `main` deploys. |
| **`DATABASE_URL`** | No database in production yet. | Vercel → Storage → create Postgres (Neon). It injects `DATABASE_URL` automatically. Then run `pnpm db:migrate` once against it (locally with the URL, or from a one-off script). |
| **`JEV_API_KEY`** (optional for MVP) | Without it every reply classifies as `unclear` → the human path. Safe, just not smart. | TypeSafe AI account → key → Vercel env. The request shape in `src/adapters/jev/classifier.ts` is unverified against their docs — one function to fix. |
| **A GHL phone number per sub-account** | SMS sends return `No numbers available in the account`. Email works without it. | Buy a number in each sub-account once A2P is approved. |
| **Slack** (later) | `slack_post` nodes skip with a warning until a workspace is connected. | OAuth flow isn't built; `slack_connections` table is ready for it. |

Once the repo is connected and `DATABASE_URL` exists: push → deploy → migrate → install a company
→ the cron takes it from there. `/api/health` should return `{ok:true, companies:N}`.

## Not built yet (deliberately)

- The no-show half of D22: an appointment with no recording after it ended is not marked `noshow` yet (needs a timed sweep).

Visual editor · app-level login · hosted intake and EOD forms (disposition exists) · signed
disposition links for Slack · Slack OAuth · opportunity polling from GHL (ours are rule-driven) ·
command center · template drift tooling · attribute reclassification. All designed in
`../engine/`, none blocking a test.

## Known gaps worth knowing

- Email bodies in `sends.rendered_body` are stored (they're ours); GHL email *replies* store
  metadata only.
- `relative:auto` rounding and the formatter are tested; cross-DST edge cases aren't yet.
- Vercel Auth (SSO protection) is on for deployment URLs; the cron is internal so it's fine, but
  hitting `/api/health` from a browser needs a bypass token or a custom domain.
- The reminder template's closer name is `split_part(users.name, ' ', 1)` — a user literally
  named "Closer One" renders as "Closer".
