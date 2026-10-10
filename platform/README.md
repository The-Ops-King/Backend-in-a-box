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

**GHL is the truth; the engine's copy is a cache (D68).** The `contacts` table and its identifiers are a replica the
poll keeps warm, not the record. Before a run acts, the engine reads the person live from the CRM (one GET per claimed
run per wake, the same price cards already pay under D41) and folds the answer into the replica by the poll's own path,
so a name, number, email, custom field, time zone, owner or CRM id changed since the last poll is what the step sees.
A deleted contact (404) is marked gone and the run exits moot before anything is sent; a CRM that does not answer
leaves the run on the copy and the run page says so. A refresh never starts a workflow: new leads and tag changes
stay the poll's job.

Live proof: a real appointment booked in GHL was detected, both workflows started, the
confirmation email went out through GHL into the contact's thread, the reminder is waiting for
8am the morning of. 47 tests pass (`pnpm test`), including the end-to-end suite against Postgres.

## The workflows (templates, all install OFF)

Every template carries a `stage` on the customer's journey (`src/engine/stages.ts`: lead, booking, pre_call, call, post_call, closing, payments, reactivation, team, engine) and a `sort` inside it; the company page lists workflows in that order, scheduled ones last. A custom workflow sets its own. Every template also carries an `origin`: `spec` (built from Tyler's own description, Zap or CRM workflow) or `default` (a starting point the engine shipped, to review or replace); the company page shows it as a badge.

| Template | Starts on | Does |
|---|---|---|
| pre-call-sequence | appointment booked (closing calls) | everything the prospect hears before the call (D36): the booking email and text — receipts (`kind: transactional`), so with `quiet_allow_transactional` on the company they go the minute the booking lands, even at midnight (D62) — (reply with an emoji to lock in; no reply in 4h — or by an hour before the call, whichever comes first (D58, G7) — → tagged `stat-unconfirmed`, the closers' channel told; a clear yes confirms on its own; a reply Jev reads as a cancel or a reschedule, or cannot read, is put to the closer in the attention channel (`slack.attention`, else bookings) with Jev's confidence ("Jev is 95% sure they want to cancel.") and ✅ ❌ 🔁 to tap, the contact tagged `stat-needs-attention` and the read noted on the appointment (`pending_read`) — nothing touches the appointment or texts the prospect until a person taps (D55); the reminders do NOT wait: the run goes on and listens (`wait_for_reaction` `blocking: false`, D58); a tap, whenever it comes, pulls the run to the confirmed, cancelled or reschedule path (who decided noted, Jev scored with its confidence in `intent.reviewed`, the outcome reacted on the question, the tag off) and `resume` returns a kept call to the reminder it was on; nobody by the call → the listener disarms, the tag comes off, `intent.unanswered` is recorded and the pending read stays so a no-show after it is a possible cancel (Call outcome filed: `stat-possible-cancel`, `intent.unanswered_no_show`); the Health page shows the month's score), then texts 3 days, 2 days and 24 hours out (with an email), the morning of for calls at 11am or later, 1 hour and 10 minutes before. Each reminder lands between 8am and 9pm their time (the 1-hour text from 7am; the 10-minute text always) and is skipped when the call is already closer than it (`validity.min_lead`). Copy is placeholders until Tyler pastes the real texts. |
| speed-to-lead | lead created | email + SMS now, 2h for a reply, one more email if silent |
| no-show-recovery | GHL marks no-show, or the disposition form does | 10 min, SMS + email with the rebook link, 24h for a reply, one more email |
| cancellation-rebook | GHL marks cancelled | SMS + email with the rebook link |
| post-call-follow-up | disposition says follow-up | next morning SMS |
| call-outcome | a closer filed how a call went (end-of-day or disposition form), or the CRM marked a no-show | on the contact's own booking post: no-show → 👻 in the thread + `stat-no-show`, the setter card → No-Show / Cancel / Reschedule, **lost** (the setter pipeline is won on a show, lost on a no-show; the next booking makes a fresh setter card) and the closer card → No Show / Cancelled, still open (a rebook reuses it); showed → ✅ (Sales call recorded already put one when the recording landed; a repeat is a no-op) + `stat-showed` + the setter card → Showed, won (a no-op when the recording moved it), then the confirmed call outcome's tag and closer-card move: closed/deposit → `stat-closed-won` (the closer card waits for Deal closed / Payment recorded), follow-up → `stat-follow-up` + Follow Up, lost → `stat-lost` + Lost (lost), disqualified → `stat-disqualified` + Disqualified (lost); rescheduled → nothing (Call booked reacted 🔁). Every card step moves a card that exists and never makes one (D61). The engine's own showed (from a recording) does not start it; Jev's read only pre-fills the form (D50, D54). No workflow presumes a no-show any more: the end-of-day form opens with no-show for a call whose time has passed with no recording, no outcome and no money, and nothing is marked until the closer answers. Needs `crm.pipeline_setter`, `crm.pipeline_closer`, `crm.stage_setter_showed`, `crm.stage_setter_cancelled`, `crm.stage_closer_cancelled`, `crm.stage_closer_follow_up`, `crm.stage_closer_lost`, `crm.stage_closer_disqualified`; `slack.channel.bookings` optional |
| payment-failed | Whop failure | one post in `slack.channel.payments` tagging the closer; the client is not messaged |
| reactivation | tag `reactivate` added | email, 3 days, SMS, 4 days, last email; once per 90 days |
| call-booked | closing call booked or moved | contact gets appointment date + closer as owner; setter card → Direct Booked Call ("-- Direct") or Appointment Set ("-- Set", setter stamped); closer card created/moved to Scheduled ("-- Direct" / "-- Setter Booked"); tags `stat-booked` + `stat-self-booked`/`stat-set`, nurture tags off, and `stat-no-show` / `stat-cancelled` / `stat-possible-cancel` / `stat-needs-attention` off too (a fresh booking resets them so a filter on them never catches someone who rebooked, D62); Slack card with intake answers, reschedule link, UTM source. Needs the setter/closer pipeline + stage ids and the custom field ids as `crm.*`; `slack.channel.bookings` optional |
| call-cancelled | closing call cancelled (a reschedule never fires this) | setter and closer cards → their cancelled stage (move only); appointment date cleared on the contact; rebook task for the closer due in a day with who cancelled and why; `stat-cancelled` on, booked tags off; Slack note. Needs `crm.stage_setter_cancelled`, `crm.stage_closer_cancelled` |
| payment-recorded | payment linked to a contact | cash collected on the contact = running total; revenue generated stamped once with the program price; `pay-paid-full` (and `pay-plan-active` off) when cleared, else `pay-plan-active`; Payment custom-object record written and linked to the contact and the closer card; Slack line. A refund (`payment.refunded`, D57) is a new line in the same tracker with a minus sign: cash collected = the lower running total, a Payment record with the negative amount (`type` refund, `status` refunded), `pay-refunded` added, `pay-paid-full` / `pay-plan-active` left as the last payment set them, Slack `*Refund:* −$X`, 💸 on the booking and review threads; nothing re-stamped, no agreement sent. Needs `crm.field_contact_cash_collected`, `crm.field_contact_revenue_generated`, `crm.assoc_payment_contact`, `crm.assoc_payment_opportunity`, `crm.pipeline_closer`; `slack.channel.payments` optional |
| call-recorded | a call recording matched to a contact | AI decides whether it is a sales call (else stop), pulls the notes and scores the call against the rubric (`analyze` nodes on `prompt.call_classify` / `prompt.call_notes` / `prompt.call_rubric`); when an appointment matched: appointment recorded as showed (`call.held` fires), `stat-showed`, setter card → Showed and won; Sales Call record written and linked; notes on the contact; Slack review. Needs `secret.anthropic_key`, `crm.stage_setter_showed`, `crm.assoc_sales_call_contact`, `crm.assoc_sales_call_opportunity`; `slack.channel.calls` optional | Slack goes out first, so a CRM hiccup never hides that the call happened; the Sales Call record is created at booking by call-booked and updated here (a reschedule is the same appointment, the same record); `disposition` and `objection_primary` pass through the `oneof:` filter so a value the CRM would silently drop is never written.
| setter-call-logged | the dialer logged a connected phone call (`call.logged`) | under the minimum length (a `set_var` knob, 60s, editable on the step) or no recording → stop; 15 minutes after the call the AI says setting / confirmation / other (`prompt.setter_call_classify`; other → stop), writes the digest with pains, goals, triage and a fit score (`prompt.setter_call_notes`); whether a booking followed is read from our appointments; Discovery Call record written and linked to the contact (`led_to_booking` checkbox as `["yes"]`), digest as a note, Slack post. Needs `secret.anthropic_key`, `crm.assoc_discovery_call_contact`; `slack.channel.setter_calls` optional |
| agreement-send-manually | tag `sys-send-agreement-manually` added | unless already signed: `send_document` (the Documents & Contracts template `crm.agreement_template`, from `crm.agreement_sender`), tag `stat-agreement-sent`, trigger tag removed, note |
| agreement-signed | the signer completed the agreement (`agreement.signed`, from the documents poll) | tag `stat-agreement-signed` (and `stat-agreement-unsigned` off, D62), dated note, Slack (`slack.channel.deals`) |
| deal-closed | first payment OR agreement signed, either order, once per contact | gate: paid AND signed AND not tagged `stat-customer` (else stop, and the stop does not use up the "once"); then `stat-customer`, closer card → Closed - Won (won), setter card won, Sales Call record `closed_won` / `showed` with cash collected, welcome email + text (CRM templates by id when set on the step, else the copy on the step), Slack. Needs `crm.stage_closer_closed_won`; `slack.channel.deals` optional |
| agreement-chase | first payment | 24h → unsigned? → nudge the owner (Slack DM, else `slack.channel.alerts` with an @mention; CRM task on the contact) → 24h → … three nudges at most; a signature ends it; after the third: tag `stat-agreement-unsigned`, one alerts post |
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

**Whop by API key.** Install with `whop: { apiKey }` (it shows under Setup › Connections) and the
engine creates its own Whop webhook (api v1; payment.succeeded, payment.failed, refund.created) at
`/api/webhooks/whop/<companyId>`, binding the signing secret it is shown once (`secret.whop_webhook`,
`whop.webhook_id`), the same way it registers with Fathom. The key also powers the payment history
backfill. Needs `payment:basic:read` and `developer:manage_webhook` on the key.

Whop posts to `/api/webhooks/whop/<companyId>` (signature verified, Standard Webhooks). Each
payment is a ledger row linked by member id, email or phone, or left **unlinked** with a team
alert; a linked payment shows under the person's History on their contact page. Linking (by the engine's matching, or `POST /api/admin/...`) settles
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
team alert; a linked recording shows under the person's History on their contact page. A linked recording
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

### Setter metrics (D64)

"What is Luis's speed to lead, and how many calls has he actually connected?" is answered from the ledger
itself, not the rollups (a median needs every lead's own number). `setterMetrics(c, companyId, { from, to })`
in `src/engine/metrics.ts`, over inclusive local dates, per setter (the user whose GHL id the dialer stamped
on the call; `unassigned` for calls with no caller) plus a company-wide `totals` line:

| field | meaning |
|---|---|
| `leads_assigned` | contacts the CRM assigned to them (`assigned_ghl_user_id`) that arrived (`ghl_added_at`) in the period; totals: every lead that arrived |
| `never_dialled` | of those, with no outbound dial by anyone since they arrived |
| `dials` | outbound dialer calls they made in the period (`recordings`, provider `ghl`, `raw.direction = outbound`; harness rows never count) |
| `answered` | dials the CRM marked connected, any length |
| `connected` | answered and at least `companies.reached_seconds` long (default 60) |
| `talk_sec` | seconds on connected calls |
| `contacts_reached` | distinct people behind the connected calls |
| `leads_dialled_first` | period leads whose first outbound dial was theirs; speed to lead is measured on these |
| `stl_median_min` / `stl_avg_min` | minutes from `contacts.ghl_added_at` to that first dial, median and mean (null when none) |
| `bookings` | appointments booked in the period that the booking source stamped `set_by` with their name, or that the person made within a day after one of their dials |

Read it with `GET /api/v1/companies/<slug>/metrics?from=YYYY-MM-DD&to=YYYY-MM-DD` (dashboard session; both
default to this week so far in the company's zone) → `{ company, from, to, timezone, reached_seconds, totals,
setters[] }`. The wrap-ups page (`/app/c/<slug>/wrap-ups`) shows it as the **Setters** section with a date
range (this week / today / 30 days or any two dates). The weekly Slack post is unchanged: the `wrap-ups`
template has no setter section to add a line to (`sections: {}`, `breakdowns: []`), and the per-setter
breakdown it can already render comes from the rollups.

### Asking the ledger a question (read-only query door, D64)

`POST /api/admin/query` with `{ "company": "<slug>", "sql": "<one SELECT>", "limit": 200 }` and
`Authorization: Bearer $CRON_SECRET` returns `{ columns, rows, row_count, ms, truncated }`. The statement runs
inside the company's row scope as the `query_door` role (NOLOGIN, NOBYPASSRLS, SELECT on our tables only; created
on first use, so the tenant policy applies even where the login user is a superuser or bypasses RLS, as it does
locally), in a read-only transaction with a 5 s statement timeout, wrapped as a subquery with the row cap bound
as a parameter (default 200, max 2000; `truncated` says a row was left behind). Refused outright: anything whose first
keyword (comments stripped) is not `SELECT` or `WITH`, any semicolon, and the names `bindings`,
`slack_connections`, `set_config`, `pg_read_file` and a few other file / scope / connection functions
(`QUERY_DENY` in `src/engine/query.ts`); `bindings` and `slack_connections` are also not granted to the role, so
the database refuses them on its own. Secrets stay encrypted either way (`bindings.value` is ciphertext),
and the columns `report_token`, `bot_token`, `token_jti` are dropped from every result. `audit_log` is readable.
Tables without `company_id` (`companies`, `core_categories`, templates) are global and show every row. Every
run is an `audit_log` row: `query.ran` with the SQL, limit, row count and time, `query.failed` with the error.

```bash
curl -s -X POST -H "Authorization: Bearer $CRON_SECRET" -H 'content-type: application/json' \
  https://backend-in-a-box.vercel.app/api/admin/query -d @- <<'JSON'
{ "company": "acme", "sql": "
  with lead as (
    select ct.id, ct.first_name, ct.ghl_added_at, d.started_at as first_dial, d.caller
    from contacts ct
    join lateral (select r.started_at, r.raw->>'caller_ghl_user_id' as caller from recordings r
                  where r.contact_id=ct.id and r.provider='ghl' and r.raw->>'direction'='outbound' and r.started_at>=ct.ghl_added_at
                  order by r.started_at limit 1) d on true
    where ct.ghl_added_at >= now() - interval '7 days')
  select u.name as setter, count(*) as leads_dialled,
         round(percentile_cont(0.5) within group (order by extract(epoch from (first_dial-ghl_added_at))/60)) as median_min,
         (select count(*) from recordings r where r.raw->>'caller_ghl_user_id'=u.ghl_user_id and r.raw->>'call_status'='connected'
            and (r.raw->>'duration_sec')::int >= 60 and r.started_at >= now() - interval '7 days') as connected
  from lead join users u on u.ghl_user_id=lead.caller where u.name='Luis' group by u.name, u.ghl_user_id" }
JSON
```

**Wrap-ups** are a workflow (`wrap-ups` template, D35): three schedule triggers (daily 19:00, weekly Monday
08:00 covering last Mon–Sun, monthly the 1st at 08:00 covering last month), a `report` step that renders the
period from the rollups into `vars.report` and keeps it as a `wrapups` row, and a `slack_post` to
`{{slack.channel.reports}}`. Time, day, channel, breakdowns (per setter / per closer) and sections (what they
said = booking-form answers tallied per question) are the steps' settings, edited like any other workflow.
Each trigger fires once per period (the clock's reentry key); a missed day sends late, never twice. Every
wrap-up is shown on `/app/c/<slug>/wrap-ups` exactly as sent (shadow: posted with the shadow label).
`POST /api/admin/reports { company, kind }` starts the workflow now for that kind (the trigger node `t_<kind>`)
with the period in progress (today so far / this week so far / this month so far).

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

## Cards moved by hand (D61)

The CRM is the truth about cards (D41), and a closer dragging one between runs used to be invisible until a run
happened to read that contact. The poll now has a `cards` entity: each tick it reads the two bound boards whole
(`GET /opportunities/search?pipeline_id=…`, 100 a page, ten pages at most; the search has no updated-since filter)
and folds every card of a contact it knows into `pipeline_cards`. A known card whose stage or status differs from
the replica, with a CRM stamp newer than our last write to it, was moved by a hand (or a CRM workflow): a
`card.moved` event goes on the contact ({pipeline, from_stage, to_stage, from_name, to_name, from_status,
to_status, by: crm, mover}), the replica follows, and the booking post's thread gets "🗂️ <who> moved the closer
card to Follow Up" (the mover when the CRM says who, else "someone"). A move into the closer board's No Show /
Cancelled, Lost or Disqualified, or the setter board's No-Show / Cancel / Reschedule, for a call whose time has
passed files that outcome on the appointment through `recordDisposition`, exactly as the end-of-day form does, so
Call outcome filed tags it and the Sales Call record says so; Follow Up and Financing Pending are the closer's own
stages and file nothing. The handler never writes a card's status: the replica keeps the status the CRM returned, and
the owner's rule (setter lost on a no-show) is Call outcome filed's step, which only ever marks an open card. The same detection runs
inside every run's read of a contact's cards (`syncCards`), so whichever sees the move first records it, once. The
first pass is a silent baseline. A card step that finds the card already where it would put it is a no-op
(`already there`): no CRM write, no second line. Stage names in the line come from the binding keys
(`crm.stage_closer_follow_up` → Follow Up), never from a CRM call. The contact page lists the moves under History.

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

## Setup page (`/app/c/<slug>/setup`, read-only — D42)

Everything a company's installed workflows need, driven by their manifests, shown and never edited here:
connections (GHL location and PIT, Anthropic, Whop, Fathom, Calendly, Resend — a secret reads "set · ends
with …" or "missing"), booking source and setter rule, each calendar's call type, setter-vs-self rule and
question map, every `crm.*` id with the name the live CRM gives it, Slack channels, alert destinations,
prompts, the schedule workflows, the end-of-day form and the inbound door URLs. Blockers sit at the top;
warnings fold. Changing any of it is the install API's and the CLI's job (`POST /api/admin/install`,
`pnpm install:company`); the page shows what they produced. The describe-config proposal flow
(`src/engine/describe-config.ts`) stays in the engine for the chat to drive.

Nothing on a workflow page is editable (D32): the page shows what the workflow does and what it would
produce; changes to copy, steps, channels, pipelines or icons go through the chat, which edits the
template or the company's copy and re-installs. (`src/engine/edits.ts` and `copy.ts` are the engine
side of those edits and stay; the dashboard no longer exposes them.)

## Slack as an input (D45)

Reactions are decisions. A post may offer ✅ ❌ (or any emoji) for a person to tap; the tap reaches the engine
through `/api/webhooks/slack/<companyId>` as a `slack.reaction` event (the tag the post was remembered under, who
tapped, the run's contact and appointment), and a workflow starts from it like from any other fact. Slack app
setup, once per app: scopes `reactions:write` and `reactions:read`; Event Subscriptions on, request URL
`<PUBLIC_URL>/api/webhooks/slack/<companyId>` (the URL check is answered), bot event `reaction_added`; the signing
secret from Basic Information goes to the install API as `slackSigningSecret`, the bot token as `slackToken`.

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
`/app/c/<slug>/health` shows open alerts, the last sweep check by check, what cleared recently, and (folded) every event a workflow can start from with the workflows that use it.

The **health check** is a workflow (`health-check` template, D35): a schedule trigger (every 60 minutes) and a
`health_check` step whose settings are the list of checks (`checks: {"<id>": false}` turns one off), the
channel its alerts announce in and the face they post as. Edit the company's copy to change any of it. It is
read-only against every vendor. Checks: the GHL token opens the location; every mapped GHL calendar returns
free slots over the next 7 days (a closer's Google/Outlook sync dropping shows up as no slots: GHL has no flag
for it); every bound pipeline, stage, contact field and opportunity field still exists; closers on calendars
and open cards are still users; the Calendly token answers and every mapped event type is active with
available times over 7 days (same idea: a host's calendar disconnecting empties availability); the Whop key
reads payments and the engine's Whop webhook still exists and is enabled; the Fathom key lists meetings and
the Fathom webhook is still registered (Fathom's listing endpoint is unverified: when there is none, the sweep
falls back to delivery age); the Slack bot token is alive and the bot is in every channel the workflows post
to; the Anthropic key answers; no enabled workflow is missing a binding; no person is held twice by the CRM
(D63: two records the poll folded into one person by phone or email, or two persons whose phone or email differ
only in spelling — one finding and one alert per person, `duplicate:<contact_id>`, with the CRM contact to merge
at; the engine never merges, and the finding clears when the CRM no longer has the dropped record). A failed
check is an alert like any other and clears itself on the next clean sweep. `Sweep now` on the health page
starts the workflow now (`fireNow`), as does `POST /api/admin/health { company }`.
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

**Low availability** is its own workflow (`calendar-availability` template): a schedule trigger every hour
plus triggers on `appointment.booked`, `appointment.rescheduled` and `appointment.status_changed`, and one
`availability_check` step with the thresholds (`min_slots`, `days`). A calendar that is alive but has fewer
bookable slots than the threshold over the window is a warning, so a full (or quietly closed) calendar is
known before leads find it. In a run started by a booking only that booking's calendar is read, the minute
it lands, so the hour is the backstop, not the latency. Every calendar finding and alert carries a link to
the calendar's public scheduling page (`calendarLink`) and the day-by-day in its thread.

**A skipped step says why.** Every skip carries a kind: `noop` (nothing to do, by design: no card to move,
SMS off for the company, already sent) or `blocked` (something is missing: Slack not connected, a channel not
bound, no AI key). The timeline shows "nothing to do" or "blocked" instead of a bare "skipped", a shadow
write shows "shadow", and a blocked step raises a warning alert the minute it happens, cleared when a later
run gets past that step. "Remember" steps (`set_var`, copy plumbing) are not shown in the outline or the
timeline; the definition under Advanced has them.

## The closer's end-of-day report (D34)

One standing link per closer (`/eod/<token>`, no login), today by default, arrows to other days. The page stands
alone: no nav, no link to the dashboard (its own layout; the dashboard pages live under `app/(dash)`). It opens
prefilled from the engine's own ledger: calls on their calendar that day; for each, what happened (no-show or
rescheduled from the appointment's status; closed, deposit, follow up, lost or DQ from a recorded outcome, else from
money that day, else from Jev's read of the transcript), contract value and cash, next step and date, "about this
prospect" (Jev's summary with the pains, goals and objections), notes, links to the CRM contact and the recording;
at the top, calls, closes, deposits, cash collected and revenue. Every value is editable.

Each call asks one thing first, what happened, and the questions that follow appear once it is picked: closed or
deposit show contract value and cash; follow up shows the next date and steps; DQ shows a reason (a select) and a
note; the held outcomes show "about this prospect"; notes follow any outcome. A deposit is a payment short of the
contract value (prefilled when what was paid that day is less than the contract or the program price); it is counted
on its own, not as a close, and its cash and contract value are in the totals. Attendance is implied by the outcome:
no-show and rescheduled record the appointment outcome, everything else records showed plus the call outcome
(`call_outcome` terms: closed, deposit, follow_up, lost, unqualified for DQ).

The form is the company's (`forms`, purpose `eod`; `src/engine/eod-form.ts` holds the defaults and the merge):
labels, what is required, the option lists (DQ reasons) and their own questions, per call (after chosen outcomes,
or any) or once for the day ("What did I do well?"), edited in settings § End-of-day form. The engine keeps the
built-in keys it reads. Required answers are checked in the browser and again on submit; a day with a blank
required answer is not filed and says what is still needed.

Submitting files `eod_reports` (prefill, answers, what changed), records each call's outcome through the disposition
path (`recordDisposition`: the appointment's outcome, `call.held`, the no-show sequence and CRM records follow; the
disposition note carries about, notes, DQ reason, next step, money and the company's own answers), posts a summary
to the company's alerts channel with the corrections ("Leo Ortiz: outcome Deposit → Closed") and the day's answers,
because a wrong prefill is a data gap to fix at the source, and puts a ✅ and a "Got it" reply on the reminder DM.
Submitting again replaces the day.

Who is a closer is a role on the roster (settings § Team; install input `closers`: emails or CRM user ids). The CRM
roster comes in as `staff`; only `closer` rows get a link and the DM.

The reminder and what happens after filing are workflows (D35). `eod-reminder`: two schedule triggers, one run per
closer each: at 18:00 company time (today's link plus any earlier unfiled day in the last week, one line each) and at
09:00 (earlier unfiled days only), a `check` that there is something to file, a `slack_post` DM to the closer
(`{{user.slack_user_id}}`, looked up by email) remembered under the tag `eod-reminder:<user>:<day>`. Change the
times, the copy or the face on the company's copy. `eod-filed`: filing emits `eod.filed` with the whole report
(totals, every call with its answers, corrections, the day questions) and a run about that closer starts: the
summary to `{{slack.channel.eod}}` with the corrections and the day's answers, then "✅ Got it" threaded under the
reminder DM with a ✅ reaction (`thread_of: "tag:…"`, `react`). A `webhook` step after it sends the report to
Airtable, a Zap, Apps Script, anything with a URL. Filed reports and every closer's link: `/c/<slug>/eod`.
Tested in `eod.test.ts`.

## Readiness (is it safe to go live?)

The company page and every workflow page carry a readiness card built from facts
(`src/engine/readiness.ts`): shadow vs live, Slack connected or not, each workflow's required bindings
present or missing, Slack channels unbound, and the gaps the engine knows it still has for a template
(`KNOWN_GAPS` — delete the entry when the piece ships). A workflow that is ON with a missing binding is a
blocker; the same gap on a workflow that is OFF is a note. Nothing here is typed by hand.

### Turning workflows on and off from outside

`GET /api/admin/workflows?company=<slug>` lists a company's workflows with their readiness;
`POST /api/admin/workflows` with `{ "company": "<slug>", "workflow": "<template slug or name>", "enabled": true|false }`
flips one; `DELETE /api/admin/workflows` with `{ "company", "workflow" }` removes one the company no
longer wants (off first; its runs and their sends go with it, the events it emitted stay). All take
`Authorization: Bearer $CRON_SECRET`. Turning on a workflow that is missing a required binding is
refused (409) — the same thing the readiness card calls blocking. Every flip and delete is in `audit_log`.

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

**The clock is a trigger (D35).** A trigger node with `event: "schedule"` carries `schedule: { every: "60m" |
at: "18:00", days?: [1..7], day_of_month?, for: "company" | "closer" }`. Every tick, before the runs advance,
`dispatchSchedules` (`src/engine/clock.ts`) starts a run for each due schedule, once per period per subject
(`every` buckets the clock; `at` is the date once the time has passed, company time zone), through the same
`startRun` and reentry key as any event. `for: "closer"` is one run per user with role `closer`, about that
person: the context carries `user` (name, first name, email, Slack id and `mention`, `report_url`, and
`user.eod`: today's calls and whether today is filed, earlier unfiled days with links, ready-made lines).
A run about the company or a person has no contact; the dashboard shows the person's name or "the company".
`fireNow` starts a schedule trigger outside its period (Sweep now, `POST /api/admin/health`, `/reports`).
Nothing on a timer lives outside a workflow: the end-of-day reminders, the health sweep, the availability
watch and the wrap-ups are templates like any other, installed and edited like any other.

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
to let those through at any hour. Nothing human-sounding ever goes out in the dark. The pre-call sequence's
booking email and text (`e1`, `s1`) are the transactional nodes today (D62): a company whose booking receipts
should go at midnight sets the flag; without it they wait for 08:00 with everything else.

## Smoke journey

`pnpm smoke` (optionally `--template <slug>` repeated to mirror a real company's set) runs "a client
comes in, then books a call" through the real engine against `DATABASE_URL` with fake adapters, in a
throwaway company `smoke` in shadow, and prints the whole story: events in order, each run step by
step in words, every message or Slack post that would have gone out, the pipeline cards and tags
afterwards, what is parked for later, and the readiness list. Nothing external is called.

## Shadow mode (how a client gets migrated)

Shadow posts to Slack ARE posted, with a "🧪 shadow —" prefix, when Slack is connected (D31): the team is not
the CRM or the contact, and seeing the posts is the point of the run. The send is recorded as `shadow`.

Every company climbs a ladder (D52): **shadow** → **test** → **live**, the control at the top of its page.
Shadow is below: everyone runs, nothing is written or sent, the record says what would have happened (which
card, which stage, which tag). **Test** is the dress rehearsal: the team's own test contacts, tagged
`sys-test` in the CRM or with an email on a test domain (`test.domains`, set at install as `testDomains`),
get everything for real: CRM writes, emails, texts (when SMS is on). Everyone else runs as in shadow, nothing
written or sent: their runs start and go all the way through, every write and send recorded as would-have, so
the team still sees what the engine would do for real leads. Posts to Slack before live carry a 🧪 *mode*
prefix (🧪 *shadow* for a run shadowed in test). Live is then taken in sections with the workflows' own switches: the simple ones first,
then the ones that only note things, then one system at a time.

Every company is in **shadow** until someone presses **Go live**. In shadow the engine polls,
dispatches, runs and branches exactly as live, renders every message, and writes nothing to GHL:
sends are recorded as "would send" with the exact text, tags and notes are logged, appointment
updates are logged. A read-only Private Integration Token is enough. Verified on a real
location with all nine workflows on: zero messages, zero tags reached GHL.

So: install with a read-only token → let it run → read `/c/<slug>/sends` ("Would have sent") →
fix copy or timing → **Go live** on the company page, then turn workflows on one at a time.
Go live is refused while readiness has a blocker (the response lists them), and it clears every
run born in shadow with its steps, would-sends and events: shadow was rehearsal, none of it is
history (D51). Each run carries `born_in`; back to shadow is only the flag.

## Reading a workflow

A workflow is shown as a short numbered list (`src/ui/Outline.tsx`), read top to bottom the way it
runs: `When: Agreement signed` · `Tags “+stat-agreement-signed” “−stat-agreement-unsigned”` · `Add internal note: "Agreement
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
| **`JEV_API_KEY`** (server fallback; per company it is `secret.jev_key`, install `jevKey`) | TypeSafe AI reads every reply to a text: confirmed, cancelled, reschedule, question, unclear, with an ambiguity gate so a 👎 or a "maybe" goes to a person (D47). Without a key every reply goes to a person. | TypeSafe AI console → key → install API `jevKey`. Shape verified live 2026-10-09 against `POST /v1/systemone`. |
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

## The dashboard (React, under `dashboard/`)

The operator's pages are a Vite React app (`platform/dashboard/`), built into `public/app` and served by Next at `/app`
(and the closer's end-of-day link at `/eod/<token>`). It reads the JSON API under `/api/v1` and follows
`design/GUIDE.md`. One operator password (`DASHBOARD_PASSWORD`) and a signed cookie (`SESSION_SECRET`) guard the
dashboard, its API and the Next pages not yet rebuilt (settings, the utility lists); the cron tick, the admin
endpoints, the webhooks and the closer's link keep their own keys.

- `pnpm dashboard:build` builds it (the Vercel build runs it before `next build`); `pnpm dashboard:dev` runs Vite on
  5177 proxying `/api` to the Next dev server on 3077.
- `pnpm typecheck` checks both the Next side and the dashboard.
