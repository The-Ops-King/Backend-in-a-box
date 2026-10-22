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

**A run keeps its own state, not a copy of the contact (D84).** What a run saves when it parks, pauses or ends
(`runs.context`) is only what it needs to go on: `vars` (its own values, wait pins, Slack posts, an armed listener),
`reply` (never a reply's words, D89), `event` (the trigger), `reaction`, and `contact.fetched_at` / `contact.stale` for the run page. The person, the
booking and the call are read fresh at every wake and never saved on the run (`persistedContext` in
`src/engine/context.ts`); a call's transcript is not even in the context until a step reads it (D87, below). Older rows are slimmed once with `POST /api/admin/slim-runs` and
`Authorization: Bearer $CRON_SECRET`: `{}` is a dry run that reports `{ scanned, changed, bytes_before, bytes_after }`;
`{ "dryRun": false }` rewrites (optionally `company: "<slug>"`; when `done` is false, call again with `after: next`).

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
| call-outcome | a closer filed how a call went (end-of-day or disposition form), or the CRM marked a no-show | on the contact's own booking post: no-show → 👻 in the thread + `stat-no-show`, the setter card → No-Show / Cancel / Reschedule, **lost** (the setter pipeline is won on a show, lost on a no-show; the next booking makes a fresh setter card) and the closer card → No Show / Cancelled, still open (a rebook reuses it); showed → ✅ (Sales call recorded already put one when the recording landed; a repeat is a no-op) + `stat-showed` + the setter card → Showed, won (a no-op when the recording moved it), then the confirmed call outcome's tag and closer-card move: closed → `stat-closed-won` (the closer card waits for Deal closed / Payment recorded), deposit → `stat-deposit` + the closer card to Deposit, still open (D119: a deposit is not a close; skipped, saying so, when `crm.stage_closer_deposit` is unbound), follow-up → `stat-follow-up` + Follow Up, lost → `stat-lost` + Lost (lost), disqualified → `stat-disqualified` + Disqualified (lost); rescheduled or cancelled on the call → the Sales Call record says so; close pending (D83) → `stat-showed` and the disposition `close_pending`, never a close. The opportunity follows the answer (D88): a loss marks it lost (`update_opportunity`, `from: [open]`), a refiled answer that takes the loss back opens it again. A refiled answer edits the thread line in place and takes back what the earlier answer did where it differs (D76). Every card step moves a card that exists and never makes one (D61). The engine's own showed (from a recording) does not start it; Jev's read only pre-fills the form (D50, D54). No workflow presumes a no-show any more: the end-of-day form opens with no-show for a call whose time has passed with no recording, no outcome and no money, and nothing is marked until the closer answers. Needs `crm.pipeline_setter`, `crm.pipeline_closer`, `crm.stage_setter_showed`, `crm.stage_setter_cancelled`, `crm.stage_closer_cancelled`, `crm.stage_closer_follow_up`, `crm.stage_closer_lost`, `crm.stage_closer_disqualified`; `slack.channel.bookings` optional |
| payment-failed | Whop failure | one post in `slack.channel.payments` tagging the closer; the client is not messaged |
| reactivation | tag `reactivate` added | email, 3 days, SMS, 4 days, last email; once per 90 days |
| call-booked | closing call booked or moved | contact gets appointment date + closer as owner; the booking's UTMs (source, medium, campaign, content, term, fbclid) on the contact's UTM fields where GHL's is empty (read live; a first touch is never overwritten; an unbound `crm.field_contact_utm_*` / `crm.field_contact_fbclid` is skipped, D78); setter card → Direct Booked Call ("-- Direct") or Appointment Set ("-- Set", setter stamped); closer card created/moved to Scheduled ("-- Direct" / "-- Setter Booked"); tags `stat-booked` + `stat-self-booked`/`stat-set`, nurture tags off, and `stat-no-show` / `stat-cancelled` / `stat-possible-cancel` / `stat-needs-attention` off too (a fresh booking resets them so a filter on them never catches someone who rebooked, D62); Slack card with the company's own intake lines (`booking_card.intake`, D104), reschedule link, the person's lead source (D78). Needs the setter/closer pipeline + stage ids and the custom field ids as `crm.*`; `slack.channel.bookings` optional |
| call-cancelled | closing call cancelled (a reschedule never fires this) | setter and closer cards → their cancelled stage (move only); appointment date cleared on the contact; rebook task for the closer due in a day with who cancelled and why; `stat-cancelled` on, booked tags off; Slack note. Needs `crm.stage_setter_cancelled`, `crm.stage_closer_cancelled` |
| payment-recorded | payment linked to a contact | cash collected on the contact = running total (a deposit counts); revenue generated stamped once with the program price on the first payment beyond a deposit; `pay-paid-full` (and `pay-plan-active` off) when cleared, `pay-deposit` on a deposit, else `pay-plan-active`; the agreement goes out on the first payment beyond a deposit (D119), never on a deposit; Payment custom-object record written and linked to the contact and the closer card; Slack line. A refund (`payment.refunded`, D57) is a new line in the same tracker with a minus sign: cash collected = the lower running total, a Payment record with the negative amount (`type` refund, `status` refunded), `pay-refunded` added, `pay-paid-full` / `pay-plan-active` left as the last payment set them, Slack `*Refund:* −$X`, 💸 on the booking and review threads; nothing re-stamped, no agreement sent. A payment beyond a deposit on an open opportunity wins it, a deposit never (`update_opportunity` `o_won`; change its condition to win on paid in full, or move it, D88). Needs `crm.field_contact_cash_collected`, `crm.field_contact_revenue_generated`, `crm.assoc_payment_contact`, `crm.assoc_payment_opportunity`, `crm.pipeline_closer`; `slack.channel.payments` optional |
| call-recorded | a call recording matched to a contact (`recording.received`, Fathom), or a dialer call Jev read as a closing call (`call.closing`, handed over by setter-call-logged, D87) | the whole call is read (a dialer call in parts is one call: `lookup call_conversation`); Jev decides whether a meeting recording is a sales call (else stop; a dialer call Jev already read as closing skips this) and how it ended; the AI pulls the notes and scores the call against the rubric (`prompt.call_review`); when it lines up with a booking: appointment recorded as showed (`call.held` fires), `stat-showed`, setter card → Showed and won; Sales Call record written and linked; notes on the contact; Slack review (the same call again edits it in place: `edit` on the `recording:<first part>` tag). A closing call by phone that lines up with no booking is posted as unlinked and the team is asked which booking it was (attention channel, else ops, else calls; 1️⃣ 2️⃣ 3️⃣ for the first three of their closing calls two weeks either side, ❌ none, two days); a tap records `call.closing` about that booking (`record` with `appointment` and `start`) and this workflow runs again on it. Needs `secret.anthropic_key`, `crm.stage_setter_showed`, `crm.assoc_sales_call_contact`, `crm.assoc_sales_call_opportunity`; `slack.channel.calls` optional | Slack goes out first, so a CRM hiccup never hides that the call happened; the Sales Call record is created at booking by call-booked, one per call slot, and updated here (a reschedule logs the old slot's record as rescheduled and gives the new slot its own, D76); an unlinked closing call gets no record until it is linked; `disposition` and `objection_primary` pass through the `oneof:` filter so a value the CRM would silently drop is never written.
| setter-call-logged | the dialer logged a connected phone call (`call.logged`), once its transcript came in or `calls.transcript_wait_min` passed | D87. The call is read as one conversation with the same setter's calls to the person, each starting within `calls.conversation_gap_min` (15) of the last one ending (`lookup call_conversation`; 0-second connects are never a part); a conversation under the minimum length (a `set_var` knob, 60s) or with no recording → stop. Jev reads the whole conversation (each part's transcript fetched from GHL, none stored): setting / confirmation / closing / other (other → stop; closing → `record call.closing` with `start`, about the booking with the same closer starting within an hour of the call, and Sales call recorded takes it). The AI writes the digest (`prompt.setter_call_notes`). A confirmation call posts as soon as it is read. A setting call: Jev reads set / follow up / DQ / not interested, then `wait_for_event appointment.booked` (a setter-link booking made from the call's start, up to the Set window) until 15 minutes after hang-up: a booking already made during the call or landing in those 15 minutes posts at once as **Set**; otherwise the post goes out at the 15-minute mark with Jev's read (Jev's Set with no booking, or a read under 70% sure, asks the setters). A second `wait_for_event` until `recording.set_until` (hang-up + `setter_result.set_within_min`, 30): a setter-link booking that lands then edits the post and the Discovery Call record to Set the moment it lands. A later part of the conversation edits the same post (`edit` on the `setter-call:<first part>` tag) and the same record (keyed by the first part), marked "(N parts)"; a part whose later part already has a transcript leaves the whole to that part's run. Discovery Call record (`call_result` in the company's option keys from `discovery_call.results`, left out and named while the object has no such field), digest as a note, Slack post with the result. The setters' question: ✅ Set · 🔁 Follow up · ❌ DQ · 🚫 Not interested, two days; the first tap writes it and scores Jev. The actions a result implies (follow up → a callback task for the setter due the next business day; DQ → `dq-<reason>` tag + setter card lost, at `crm.stage_setter_dq` when bound; not interested → setter card lost, at `crm.stage_setter_not_interested` when bound) run only with `setter_result.act` true; off (the default) the post says what they would have done. Every read is a `setter_call.result` event; `jev_setter_accuracy` scores them. Needs `secret.anthropic_key`, `crm.assoc_discovery_call_contact`, `crm.pipeline_setter`; `slack.channel.setter_calls` optional (the question falls back to `slack.channel.ops`, then `slack.channel.bookings`) |
| agreement-send-manually | tag `sys-send-agreement-manually` added | unless already signed: `send_document` (the Documents & Contracts template `crm.agreement_template`, from `crm.agreement_sender`), tag `stat-agreement-sent`, trigger tag removed, note |
| agreement-signed | the signer completed the agreement (`agreement.signed`, from the documents poll) | tag `stat-agreement-signed` (and `stat-agreement-unsigned` off, D62), dated note, Slack (`slack.channel.deals`) |
| deal-closed | a payment OR agreement signed, either order, once per contact | gate: paid beyond a deposit (`contact.paid_non_deposit`, D119: a deposit alone, even signed, is not a close) AND signed AND not tagged `stat-customer` (else stop, and the stop does not use up the "once"); then `stat-customer`, closer card → Closed - Won (won), setter card won, Sales Call record `closed_won` / `showed` with cash collected, welcome email + text (CRM templates by id when set on the step, else the copy on the step), Slack. Needs `crm.stage_closer_closed_won`; `slack.channel.deals` optional |
| agreement-chase | first payment beyond a deposit (the one the agreement goes out on, D119) | 24h → unsigned? → nudge the owner (Slack DM, else `slack.channel.alerts` with an @mention; CRM task on the contact) → 24h → … three nudges at most; a signature ends it; after the third: tag `stat-agreement-unsigned`, one alerts post |
| payment-recorded (extended) | payment linked | as before, plus on the first payment with no signature: send the agreement, `stat-agreement-sent`, closer card → Agreement Sent (`crm.stage_closer_agreement_sent`); dated note; Sales Call record cash collected updated when there is one |
| card-moved | `card.moved` (a pipeline card dragged by hand in the CRM, any bound board, D61) | "🗂️ <who> moved the <board> card to <stage>" in the booking post's thread; into the closer's No Show / Cancelled or the setter's No-Show / Cancel / Reschedule → a no-show, into Lost → showed + lost, into Disqualified → showed + DQ, filed with `record_outcome` `source: disposition` (as the end-of-day form files it, so Call outcome filed runs) once the call has started and when the call does not already carry it; any other stage is noted. Installs ON into an existing company (D88) |
| payment-unlinked | `payment.unlinked` | the "*Unlinked payment*" post in the alerts channel (else bookings), marked only in ghost (D88) |
| recording-unlinked | `recording.unlinked` | the "*Unmatched recording*" post in the alerts channel (else bookings) with why, who was on it and the link to match it (D88) |
| ledger-drift | `drift.sales_call_cancelled`, `drift.sales_call_unlinked` (the hourly sweep, D73/D76) | sets a Sales Call the booking source cancelled before its start to cancelled, links a Sales Call to its contact and its one closer card (field and association), each by the record's id (D88). Needs `crm.object_sales_call` |
| weekly-leaderboard | schedule: Mondays 09:00 company time (D94) | a `leaderboard` step for last week (Mon–Sun): closers ranked by cash collected with closes and close rate, setters ranked by sets with the show rate of their sets, the same registry numbers the bot says; posted to `slack.channel.ops`, else `slack.channel.reports`, with the period under it. The day, time, period, channel and the line under the board are the workflow's |
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
instance, 5 second idle timeout. A tick uses one connection at a time; since D98 every company ticks in
its own request at the same minute, so the scheduler opens about one connection per active company plus
one, each held for the length of a transaction (a poll entity holds its transaction across the vendor read).

## Payments (D21)

**Whop by API key.** Install with `whop: { apiKey }` (it shows under Setup › Connections) and the
engine creates its own Whop webhook (api v1; payment.succeeded, payment.failed, refund.created) at
`/api/webhooks/whop/<companyId>`, binding the signing secret it is shown once (`secret.whop_webhook`,
`whop.webhook_id`), the same way it registers with Fathom. The key also powers the payment history
backfill. Needs `payment:basic:read` and `developer:manage_webhook` on the key.

Whop posts to `/api/webhooks/whop/<companyId>` (signature verified, Standard Webhooks). Each
payment is a ledger row linked by member id, email or phone, or left **unlinked**: `payment.unlinked`
starts the Unlinked payment workflow, which tells the team in its own words (D88); a linked payment shows under the person's History on their contact page. Linking (by the engine's matching, or `POST /api/admin/...`) settles
it: pursuit, derived kind, running total, `cleared`, and the `payment.received` event that starts
workflows. Set the program price with `contractValueDefault` at install and the Whop signing
secret with `whop: { webhookSecret }`.

**Deposits are a product, not an amount (D119).** The install declares which of the processor's products are a
deposit: `"depositProducts": ["prod_…", "plan_…"]` (Whop product ids or plan ids, or a Zap's `plan`/`product_id`/`plan_id`
as it sends them; bound as `payments.deposit_products`; omitted, left as it is; `[]` removes them). A payment whose
`product_id` or `plan_id` is one of them is kind `deposit`; the amount never says so: a first payment short of the price is
the first `installment` (with no product declared, the names tell: below). A deposit counts toward the price
(the payment that clears it after is the `balance`), shows in cash collected, and is not a close: the agreement, its
chase, the won opportunity and Deal closed wait for the first payment beyond it (`event.prior_non_deposit_total`,
`contact.paid_non_deposit`). Facts about Whop's payload are in `whop/01-api-facts.md`.

**Or by name (D119 addendum).** A company that declares no deposit products needs no ids: a payment whose Whop **product's
or plan's name has the word "deposit"** (whole, any case: "Deposit", "VIP Deposit", "Deposit - $250"; not "deposited") is a
deposit. Name the deposit product (or its plan) at Whop with the word. Whop's payload carries the names (`line_items[]`
`product_title` / `plan_title`); a payment that comes with ids only has them read from Whop with `secret.whop_api_key`
(cached an hour per company). Either way they are kept on the payment as `raw.product_name` / `raw.plan_name`. Declared
`depositProducts` win: a company that declares them is told by its list alone. When a name cannot be had (no key, Whop
down), the payment is not a deposit, is never held, is flagged `raw.deposit_check`, and raises an alert
(`payment:deposit-unchecked:<id>`) saying the agreement went out if it was the first payment. Past payments keep their kinds.

### Payments through Zapier instead

When the processor's own webhooks are out of reach, a Zap forwards them: trigger on the payment in
Zapier, then **Webhooks by Zapier → POST** to `/api/webhooks/zapier/<companyId>/payment` with header
`x-engine-secret: <secret>` (install returns the secret under `inbound`) and a JSON body of the
mapped fields: `transaction_id`, `amount`, `email`, `phone`, `member_id`, `paid_at`, `status`
(`succeeded` default, or `failed` / `refunded`), and for deposits `product_name` and `plan_name` (or `product_title` /
`plan_title`; a `product` / `plan` that is not a Whop `prod_…` / `plan_…` id is taken as the name) and `product_id` /
`plan_id`. A Zap that sends only the ids has the names read from Whop when the company's Whop key is bound. Same ledger,
same linking, same idempotency on the transaction id, so a replayed Zap changes nothing.

## Recordings (D22)

A call recording reaches the engine through either door: Fathom's own webhook at
`/api/webhooks/fathom/<companyId>` (Standard Webhooks, secret `secret.fathom_webhook`; install
registers it for you with `recording: { source: "fathom", apiKey }` when `PUBLIC_URL` is set), or a
Zap posting to `/api/webhooks/zapier/<companyId>/recording` with the same `x-engine-secret` as the
payment door (body: `recording_id`, `title`, `started_at`, `duration_seconds` or `duration_minutes`,
`share_url`, `recorded_by_email`, `invitees` as "Name <email>, …" or an array, `transcript` as text or
an array, `summary`, `meeting_url`). Either way it is a `recordings` row, matched by invitee email →
the meeting link (D102: the recording's join link against the one the booking was made with, kept on the
appointment as `meeting_key`; exact when one live booking near the call has it) → invitee name → the
recorder's calendar (one appointment within two hours), or left **unmatched** with the reason:
`recording.unlinked` starts the Unmatched recording workflow, which tells the team (D88); a linked recording shows under the person's History on their contact page. A linked recording
emits `recording.received` (with the contact's appointment nearest the start, within a day) and
templates take it from there. Facts about Fathom's API are in `fathom/01-api-facts.md`.

D215: several contacts on one invite is the booked one's: the contact whose live booking has the recording's meeting link, else
the one booked within two hours of its start; still none or several, unlinked with the reason. `POST /api/admin/recordings/rematch
{ company, from?, to? | days?, dryRun = true }` tries a window's unlinked recordings again and links the matches silently (no event, no run).

### Phone calls the dialer logs (D28)

A call placed or taken in GHL is a `TYPE_CALL` entry in the contact's conversation, and the
conversations poll turns every one of them (answered or not) into a `recordings` row: provider `ghl`,
the entry's id as `external_id`, linked straight to the contact (the thread names them, no ladder),
`raw` carrying the dialer's facts (`direction`, `call_status` normalised to connected / voicemail /
no_answer / busy / failed / zero_seconds (D87: a 0-second "completed" is no call), `duration_sec`, `caller_ghl_user_id`), `recorded_by_*` = the user who
dialed. GHL writes the entry when the call ends and the transcript minutes later, so a connected call
sits `raw.transcript_status = pending` and the `calls` poll re-reads it every tick (every minute), settling it the
minute the transcript lands (`transcript_status = ready`, recording link as `url`; the transcript itself is not stored)
or, `calls.transcript_wait_min` (120) after hang-up, without one.
`call.logged` fires once per call, at settle, with `recording.kind = phone`, `connected`,
`duration_sec`, `has_transcript`, `direction`, `status`, `caller` available to trigger matches and
to the run (`recording.caller.name`, `recording.set_until` = when the Set window closes). A call is never a reply: it does not wake `wait_for_reply`, and `TYPE_ACTIVITY`
entries are skipped too. Every call stays in the ledger for connection-rate and speed-to-lead
reporting later. Recording is not on for every call in GHL (verified on Hair: 2 of 4 long calls had
one), so a connected call with no transcript is a normal case, not an error.

### Transcripts are never stored (D87)

A transcript is read from its source the moment a step needs it and dropped when the step is done
(`src/engine/transcripts.ts`): `{{recording.transcript_text}}` is the run's call, `{{vars.<lookup>.transcript_text}}`
every call a lookup answered (a conversation's parts, each headed "Part n of N"). The executor fills them just before
the step and takes them out of the context after it, so no run, event or step row carries one (the classify event keeps
`input_chars`, not the text); a step retried after a failure reads it again. Sources: a GHL dialer call → `callMedia`;
a Fathom or Zapier recording → the webhook delivered it once, so it is held on the recording row only until the runs that
read it are done (released at their end; kept while one is paused on a failing step), then read from Fathom's API
(`secret.fathom_api_key`, `GET /recordings/<id>/transcript`, to verify live) if a step needs it again. Retention's sweep
clears anything still held `calls.transcript_hold_hours` (48) after the last run about it ended. The provider's summary
is never kept. Jev's answers (call type, result, confidence, DQ reason) and the AI notes stay on `recordings.analysis`.

### A reply is kept as "it came in" plus Jev's read, never its words (D89)

The conversations poll stores an inbound text or email as a row with no words: ids (GHL's message and thread), channel,
when, who. That is all a reply wait needs to wake, settle (D47) and count. A step whose settings read the words
(`{{reply.inbound_since_send}}`, `{{reply.last_inbound.body}}` / `.subject`: pre-call's classify `c1`, the Slack question
and the three decision lines that quote it) gets them from GHL by message id just before it runs
(`CrmRead.messageBodies`: one `GET /conversations/{id}/messages` per thread, else `GET /conversations/messages/{id}`) and
the context drops them after it (`src/engine/replies.ts`, the D87 pattern). The run keeps only `reply.message_ids` and
`reply.last_inbound.message_id`; a step's result or a var it set is scrubbed of the words before it is saved; the
`reply.classified` event keeps `input_chars`, never the input. GHL down when the words are needed: the step fails and is
retried in place (D66/D77); Jev is never asked with an empty text. Jev's read stays: `reply.intent`,
`reply.intent_confidence`, `reply.top_guesses` on the run, the same plus `ambiguity` on `reply.classified`, and
`predicted` / `predicted_confidence` on `intent.reviewed` / `intent.unanswered`. The engine's own sends (`sends.rendered_body`,
including a Slack post that quotes the reply) are its own record and keep their words as before (D38). What was stored
before is cleared once with `POST /api/admin/clear-reply-texts` and `Authorization: Bearer $CRON_SECRET`: `{}` is a dry
run that reports `{ messages, runs, events, run_steps }`; `{ "dryRun": false }` clears (optionally `company: "<slug>"`);
a rerun changes nothing.

### Reading a call with AI

The `analyze` node sends the transcript (`{{recording.transcript_text}}` by default) to Claude with a
prompt bound per company as `prompt.<name>` (kind `text`, defaults shipped in `src/prompts`,
override with `prompts: { call_notes: "…" }` at install). The answer is parsed as JSON and stored
under `vars.<into>`, so later steps address its fields (`{{vars.notes.disposition}}`) or render the
whole thing as Slack/note text with the `lines` filter (`{{vars.notes | lines}}`). The key is
`secret.anthropic_key` per company (`anthropicKey` at install; env `ANTHROPIC_API_KEY` is the
fallback); without one the node fails loudly. Analysis runs in ghost too: it writes nothing to the
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

**The wrap-up's words are the wrap-ups template's** (D88). The `report` step reads the registry numbers named in
`metrics` (default: leads, MQLs, bookings, reschedules, dials, connected, speed to lead, closes, deposits, deposit cash,
revenue, cash collected, cash gross, refunds; D119: deposits are their own line, never a close, their cash inside cash collected, never revenue) and the show-rate breakdown, and words the body with its `layout`: `heading` and
`empty` by kind (`daily`, `weekly`, `weekly_to_date`, `monthly`, `monthly_to_date`), `sections` of `lines`, and a
`failed` line for a GHL read that did not happen. Each line is a template over `report.*`: `n.<metric>` (null when zero,
so `{{report.n.leads | each:"New leads: {{item}}"}}` says nothing on a quiet day), `raw.<metric>`, `calls.*`,
`rates.show_rate` / `rates.close_rate` (whole percent, null without a denominator), `money_moved`, `said` (the first ten
booking questions with their top answers), `by.closer` / `by.setter` (when `breakdowns` asks for them), `start` /
`end`. The engine only puts it together: a line that renders blank is left out, a section with no line is left out,
nothing at all is the `empty` line. The shipped layout says exactly what the old code said. `period: in_progress` sends
this week or month so far instead of the one just ended. A copy with no layout of its own is worded by the shipped one.

**Quiet when empty (D124).** Install key `quietWhenEmpty: true` (bound as `reports.quiet_when_empty`; omitted on a
re-install it stays as it is, `false` turns it off; also settable with `POST /api/admin/bindings/set`): a scheduled
wrap-up or leaderboard with nothing in it posts nothing. The post step opts in with `quiet_when_empty: "vars.<into>.nothing"`,
the step before's own fact, from the data, never the words: `report.nothing` (every number read zero or unread, the
show-rate breakdown all zero, no booking answers, no per-person number, and GHL was read; a failed GHL read is never
nothing) and `board.nothing` (no closer cash or close, no setter set). The run log says "nothing happened, so nothing was
posted (quiet when empty)" and the send is kept suppressed with what it would have said; a run started by hand posts
anyway. With the setting on, the chart draws the post as a sometimes-step, "only if something happened"; without it,
nothing changes. The Daily, Weekly and Monthly wrap-ups and the Weekly leaderboard opt in; Calendar availability, Health
check, Ledger drift and the EOD workflows already post only when there is something.

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

**Wrap-ups** are three workflows (D35, D96): `daily-wrap-up` (19:00, today), `weekly-wrap-up` (Monday 08:00,
last Mon–Sun) and `monthly-wrap-up` (the 1st at 08:00, last month), each a schedule trigger, a `report` step that
renders the period from the rollups into `vars.report` and keeps it as a `wrapups` row, and a `slack_post` to
`{{slack.channel.reports}}`. Each has its own switch, mode, channel and words. They took over the one `wrap-ups`
workflow: an install that adds them starts each as the old copy stood (on or off, its mode) and turns the old copy
off in the same transaction; an old copy the company edited stays as it is and they install off. Time, day, channel, breakdowns (per setter / per closer) and sections (what they
said = booking-form answers tallied per question) are the steps' settings, edited like any other workflow.
Each trigger fires once per period (the clock's reentry key); a missed day sends late, never twice. Every
wrap-up is shown on `/app/c/<slug>/wrap-ups` exactly as sent (ghost: posted with the ghost label).
`POST /api/admin/reports { company, kind }` starts that kind's wrap-up now (the workflow whose trigger is `t_<kind>`)
with the period in progress (today so far / this week so far / this month so far).

`POST /api/admin/templates { company, templates }` (D96, D147) puts the named shipped templates on an existing company
and touches nothing else (no bindings, calendars, Slack or secrets): new ones install off, a template that takes one
over follows the handover above, and a workflow the company already has is left exactly as it is (no upgrade, no
rename). A re-run of `/api/admin/install` adds only the templates it names, likewise. A template change reaches an
offer only one named workflow at a time: `POST /api/admin/workflows/definition { company, workflow, fromTemplate: true,
note, dryRun: true }` shows the diff, the same without `dryRun` saves it (the copy is that template version again).

**The weekly leaderboard** (D94) is its own workflow (`weekly-leaderboard`): a schedule trigger (Monday 09:00 company
time), a `leaderboard` step (`period` in plain words, `last week` by default; `into` → `vars.<into>` with `closers`,
`setters`, `period_label`, `period_name`, `timezone`, `source` and `body`, the phone-width text) and a `slack_post` of
`{{vars.board.body}}` to `{{slack.channel.ops}}`, falling back to `{{slack.channel.reports}}`. `/leaderboard` answers the same.

D76: the wrap-up's numbers are the bot's (`metric-registry.ts`: people, calls, deals and cash from GHL; bookings and dials
from the ledger; test contacts out). Only what happened is said: a line for a number that is not zero, a section with a
line, a rate with its denominator; nothing at all is one line, "Nothing today: no leads, bookings, calls or payments."; a
GHL read that failed says "couldn't read GHL: …", never a 0.

### History (backfill)

`POST /api/admin/backfill { company, days? | from?, to?, steps? }` (Bearer `$CRON_SECRET`, default 30 days; keep a window to about two weeks per call, the request has 300 s; `steps` narrows to e.g. `["payments"]`)
reads the window back the way the poll reads forward and writes rows only — no events, no runs:
contacts with their arrival time (and only the bound custom fields), every dialer call with its
transcript, bookings from the booking source, outcomes the old Zaps left on GHL's Sales Call object
(matched by the booking id, else contact + call date; never overwriting an outcome the engine already
has), won opportunities (contract value from `crm.field_opportunity_contract_value`, else the
opportunity's value), and payments from Whop's own API when `secret.whop_api_key` is bound (through the
same ledger path as a webhook: linked by email / phone / member id, else unlinked for the dashboard to
fix), and the meeting recorder's recordings (`recordings`, Fathom's history through the same ladder, emitting nothing, D115), then rolls every day up. Keyed on source ids, so re-running is safe.

### A closer's Sales Calls from history (D115)

`POST /api/admin/backfill/sales-calls { company, from?, to? | days?, closer?, dryRun = true, eodObject? }` (Bearer `$CRON_SECRET`)
reads each closing-category call in the window (one closer's with `closer`: email or CRM user id), including each slot the booking
source says was moved, and answers one row per call: the fields that evidence fills (in the company's option keys), the evidence
for each, and for what it cannot establish `unknown: [{ field, likely, why }]`. Evidence: the booking source (cancel before the
start, a move, a no-show mark), a recording the ladder linked and Jev reads as a sales call, payments after the call and before the
next one, a won deal, the closer card's stage when it moved there after this call, the closer's end-of-day report
(`crm.object_closer_eod` or `eodObject`) and the contact's notes read by Jev, and Call recorded's call review for objection and next
step. The record is Call booked's own Sales Call step rendered for the call (same key, properties and option keys); an unknown
field stays blank. A dry run writes nothing and answers `plan_id`; `{ company, plan: "<id>" | [ids], dryRun: false }` writes exactly
that plan (records keyed by the slot, related to the contact and card, in crm_records; the ledger's outcome where it has none; no
event, no run). A pass that runs out of time says `complete: false` and `resume_from`. Run the history backfill first (`steps:
["contacts", "appointments", "recordings", "payments", "won"]`) so the ledger has the bookings, recordings and payments.
`pnpm exec tsx scripts/sales-call-report.ts out.html answer.json [more.json …]` renders the answers as a page to review.

## Cards moved by hand (D61)

The CRM is the truth about cards (D41), and a closer dragging one between runs used to be invisible until a run
happened to read that contact. The poll now has a `cards` entity: each tick it reads every bound board whole (every
`crm.pipeline_*`, D88; `GET /opportunities/search?pipeline_id=…`, 100 a page, ten pages at most; the search has no
updated-since filter) and folds every card of a contact it knows into `pipeline_cards`. A known card whose stage or
status differs from the replica, with a CRM stamp newer than our last write to it, was moved by a hand (or a CRM
workflow): the engine records a `card.moved` event on the contact, about their latest closing call ({pipeline (the
board's name from its binding), pipeline_id, from_stage, to_stage, from_name, to_name, from_status, to_status, by: crm,
mover, mover_id, crm_card}), the replica follows, and that is all the engine does. What the move means is the **Card
moved by hand** workflow's (D88, `card-moved`): the "🗂️ <who> moved the closer card to Follow Up" line in the booking
post's thread (the mover when the CRM says who, else "someone"), and a branch on `event.to_stage` against the stage
bindings: into the closer board's No Show / Cancelled, Lost or Disqualified, or the setter board's No-Show / Cancel /
Reschedule, for a call that has started (`appointment.started`) and does not already carry that answer, a
`record_outcome` with `source: disposition` files it exactly as the end-of-day form does, so Call outcome filed tags it
and the Sales Call record says so. Every other stage is noted. The end-of-day form opens with what the move filed, says
so, asks why it was lost or a DQ, and the reminder keeps the day owed until it is filed. Nothing writes a card's status
here: the replica keeps the status the CRM returned. The same detection runs inside every run's read of a contact's
cards (`syncCards`), so whichever sees the move first records it, once. The first pass is a silent baseline. Stage
names in the line come from the binding keys (`crm.stage_closer_follow_up` → Follow Up), never from a CRM call. The
contact page lists the moves under History.

## Agreements (D30)

GHL's Documents & Contracts is read by the poll (`GET /proposals/document`, 21 per page): every document the
location sent is a row in `agreements` (document id, signer contact, status sent / viewed / completed,
`signed_at`). A new row is `agreement.sent`; the first time the signer has completed it is
`agreement.signed`, once, whatever order the poll sees things in. The first pass is a silent baseline.
`send_document` sends a template to the contact from a CRM user (needs the token's documents send
scope; the request body is unverified until that scope exists) and records the row first so the poll
does not announce it twice. In ghost it is skipped like every CRM write. Facts every run can check:
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
`contact.revenue` (the opportunity's value, else the program price), `contact.source` (the person's lead source, D78; absent when unknown).
Template filters: `prefix:` and `line:` render a labelled value only when it exists (`line:` on its own line),
`link:Label` makes a Slack link only when there is a URL, `money` adds separators, `bullets` lists an array; the
date filters pass an absent value through to `default:`. An `analyze` step marked `optional` is skipped, not
failed, when the AI cannot run (the one-line congratulations on a close). `send_sms` / `send_email` take `ghl_template` (an SMS snippet id or an email builder template id,
editable on the step), and the CRM's copy wins when it exists. Harness actions `agreement` (a sent,
unsigned document) and `sign` (completed) stage the document side.

**Watching one more calendar** (D215): `POST /api/admin/calendars/watch { company, calendar, term, name?, owner?, booking?, why, dryRun = true }`
maps one booking-tool calendar as install would (call type, booking, owner), without a re-install. Its first poll is a baseline; run
the history backfill (`steps: ["appointments"]`) and the Sales Call backfill for the calls it already held.

**Who took a call** (D218): `POST /api/admin/appointments/closer { company, appointments, closer, why, dryRun = true }` sets the
closer on specific calls, past ones too, in the replica and on their Sales Calls in GHL.

## Pipeline cards (D19)

Templates create and move cards on the CRM's pipeline boards (`pipeline_card` node). Pipeline,
stage and custom-field ids are `crm.*` bindings set at install (`crm: { pipeline_setter: "...", ... }`),
so a template is portable across companies. One open card per contact per board: a re-fire moves
and renames it instead of duplicating; `if_missing: skip` makes a step move-only. Cards live in
`pipeline_cards`, each hanging off the contact's one open opportunity (the pursuit), so a setter
card and a closer card for the same sale share one opportunity, and the booking attaches to that
same pursuit. In ghost the card exists only in our table.

Custom-object records (`crm_record` node) are upserted by our own key (the Whop payment id, the
Calendly event uuid) through `crm_records`, so the CRM's lagging search is never consulted;
`relate` links the new record to others by association id, and the record's CRM id is `{{record.id}}`
for the rest of the run; `if_missing: skip` makes a step update-only (a record the engine never made with a CRM id is
left alone, never re-made bare). A Calendly reschedule moves the records keyed by the old event id to the new one. The
contact's open card on each bound board is `{{cards.<name>}}` (`id`, `stage`, `name`, `owner`), read again after every
card step, so a payment record can point at the closer card and its owner and the booking's Sales Call record at the
closer card the same run made.

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
connections (GHL location and PIT, Anthropic, Whop, Fathom, Calendly — a secret reads "set · ends
with …" or "missing"), booking source and setter rule, the booking card's intake lines (D104), each calendar's call type, setter-vs-self rule and
question map, every `crm.*` id with the name the live CRM gives it, Slack channels, alert destinations,
prompts, the schedule workflows, the end-of-day form and the inbound door URLs. Blockers sit at the top;
warnings fold. Changing any of it is the install API's and the CLI's job (`POST /api/admin/install`,
`pnpm install:company`); the page shows what they produced. The describe-config proposal flow
(`src/engine/describe-config.ts`) stays in the engine for the chat to drive.

Nothing on a workflow page is editable (D32): the page shows what the workflow does and what it would
produce; changes to copy, steps, channels, pipelines or icons go through the chat, which edits the
template or the company's copy and re-installs. (`src/engine/edits.ts` and `copy.ts` are the engine
side of those edits and stay; the dashboard no longer exposes them.)

The chart's words are made from what each step is set to do (D112, `shortTitle` in `src/api/words.ts` over
`src/engine/describe.ts`): a card move names its board and stage by the CRM's names ("Beauty Moguls → Booked Call"),
every stage it moves from, whether it needs a card, its name and owner; boards, stages and fields by the CRM's own
names (`crmNamer`: one GHL read per company, kept ten minutes; unread, the key words marked "(name not read from GHL)"); a CRM record its object and the values that
matter ("outcome = rescheduled"); a Slack post what it posts and where. A step's hand-written `title` is never the
words, only a small label above them, so a changed setting can never hide behind an old title. Each step also
carries how many runs reached it in the last 7 days, ghost runs included (`stepCounts` in `src/api/data.ts`: one
grouped query on `runs` ⋈ `run_steps` by node id, so a step kept across versions is one step; in the workflow
page's chart payload as `chart.counts`); a 0 is drawn too.

## Slack as an input (D45)

Reactions are decisions. A post may offer ✅ ❌ (or any emoji) for a person to tap; the tap reaches the engine
through `/api/webhooks/slack/<companyId>` as a `slack.reaction` event (the tag the post was remembered under, who
tapped, the run's contact and appointment), and a workflow starts from it like from any other fact. Slack app
setup, once per app: scopes `reactions:write` and `reactions:read`; Event Subscriptions on, request URL
`<PUBLIC_URL>/api/webhooks/slack/<companyId>` (the URL check is answered), bot event `reaction_added`; the signing
secret from Basic Information goes to the install API as `slackSigningSecret`, the bot token as `slackToken`.
Buttons are the other input (D93): an alert's Retry and Resolve come back through
`/api/webhooks/slack/<companyId>/interactions` (Interactivity & Shortcuts → Request URL; see the Slack bot setup below).

## Slack bot (D70, D73, D74, D75)

Anyone in the workspace can ask the ledger a question in Slack. Every number in an answer comes from a tool result, never
from the model: the metric registry (`src/engine/metric-registry.ts`, one definition per metric; people, won deals and
calls and cash read live from GHL by `src/engine/ghl-metrics.ts`, bookings made and dials from the engine's ledger), the
joined GHL records (`analyze`, `src/engine/ghl-graph.ts`, D75), the live calendar read (`get_availability`, the open times GHL free-slots / Calendly available-times offer,
split per closer, D72; the same read as the low-availability thread) or, as a last resort, the read-only query door (D64), whose answers say they come
from the engine's own records. A live read that fails is named in the answer, never filled with an estimate. The message is
rendered by our formatter (`src/engine/bot-format.ts`) for a phone (D95): the answer in one bold line (the model's
`headline`, its numbers checked against the results, else ours), then only the detail asked for (counted bullets; a table
when asked, never wider than 34 characters; names when asked who; what is off in GHL when asked), warnings only for what
someone has to fix, and one footer: the period, where it was read and when, and who asked a shortcut. Rates are whole
percents. Definitions are for `/help` and the model (D73).

**Shortcuts** (slash commands, answered from the registry with no model in the way; each takes an optional period in
plain words). A slash command leaves no message to thread under, so it posts its own visible message (`📊 *Month to
date* — asked by @who`) and anyone follows up in that message's thread; from a DM it answers in the DM; in a channel
the bot is not in, only the asker sees it, with a note to invite the bot.

| Command | Answers | Default period |
|---|---|---|
| `/mtd` | leads, MQLs, calls booked, show rate (shows ÷ calls booked), close rate (closes ÷ shows), deposits and deposit cash (GHL Payment records of type deposit, D119; never closes), cash collected (GHL Payment records; "GHL has no Payment records yet" when there are none), top source by cash, each vs the same days last month | this month so far |
| `/weekly` | the same set, vs the week before (`/weekly this week` for the week so far) | last full week (Mon–Sun) |
| `/monthly` | the same set, vs the month before (`/monthly this month`) | last full month |
| `/show-rate` | show rate overall, by closer and by source, with `Calls booked · Showed · No-show · Cancelled · Missing from EOD disposition (names)` and any call GHL and the booking source disagree on | this month |
| `/close-rate` | close rate overall, by closer and by source | this month |
| `/cash` | payments, refunds and net cash from GHL's Payment records, by the record's closer | this month |
| `/availability` | open bookable slots in one table: a row per day, a column per closer, the day's total and a total row; `/availability 3` for three days | next 7 days |
| `/leads` | leads, MQLs (with how many matched the employment standard and how many didn't answer) and marketing DQs by source | this month |
| `/closes` | every close, newest first: the person, their closer, the day won, with the count on top | this month |
| `/leaderboard` | closers ranked by cash collected (closes and close rate beside), setters ranked by sets (the show rate of their sets beside); only people with something in the period; narrow monospace blocks that fit a phone (D94) | this week |
| `/help` | every shortcut with a one-line description, and example questions (privately) | — |
| `/support` | logs something that broke or something they need, numbered per offer: posted where it was typed (add a Loom or screenshot in its thread), the operator told, a GitHub issue opened; closing it answers in the thread with a ✅ (D152) | — |

**Any GHL field, joined across a person's records** (D74, D75): a question about something no metric covers, or one that
crosses records ("show rate by hair-loss answer", "close rate by objection", "show rate for setter-booked vs direct",
"cash by source", "who said they're between jobs"), is answered by joining each person's GHL records live, in memory,
for that one answer; nothing is copied into the engine. A person's records link up: the contact (custom fields, tags,
source) → their setter card (`crm.pipeline_setter`) → their Sales Calls (`crm.object_sales_call`) → their closer card
(`crm.pipeline_closer`; won = a close) → their Payment records (`crm.object_payment`, default `custom_objects.payment`)
and Discovery Calls (`crm.object_discovery_call`, default `custom_objects.discovery_call`). Two tools:
`list_columns(unit)` names every column a row carries (`contact.<field name>`, `contact.source`, `contact.tags`,
`setter_card.stage|status|assigned`, `call.<prop>` and `call.result`, `closer_card.stage|status|assigned|value`,
`payment.total|count|first_date|types|<prop>`, `discovery.<prop>`), and `analyze(unit, period, split_by, filter, list,
rate)` counts one unit per answer of a column:

| Unit | Rows | Measures |
|---|---|---|
| `lead` | contacts GHL added in the period | booked (has a Sales Call), booked rate, calls due, showed, show rate (shows ÷ booked calls), closed (won closer card), close rate (closes ÷ shows), cash |
| `call` | Sales Calls whose time fell in the period and has passed, classified as D73 | showed, no-show, cancelled, missing from EOD, show rate, closed, close rate, cash (a person's close and cash count once, on their latest showed call) |
| `close` | people with a won Closer-pipeline card in the period | cash, card value, median days from first call to won |

Each answer gets its share of the main outcome and a permutation test on the rate (too few → it says so); multi-picks
count under each pick; a blank is "(no answer)" and the people with no answer are named. The answer also names **link
gaps** (`*Links:* 48 calls · 46 linked to a closer card · missing: X (Oct 1), Y`) and, once GHL holds Payment records,
**mismatches**: a won closer card with no payment, a payment with no won closer card, and a contact whose Total Cash
Collected (`crm.field_contact_cash_collected`, else the field keyed `contact.cash_collected`) is not the sum of their
payments. The bot picks the column by meaning and the header names it; it asks only on a real tie. Reads are memoized
per answer, five at a time; boards and objects are read whole, and a read past its page cap refuses rather than cuts
short. **Preview** any answer without posting: `POST /api/admin/bot-preview` with
`{ "company": "hair", "command": "/mtd", "text": "" }` or `{ "company": "hair", "question": "…" }` (bearer `CRON_SECRET`).

**Availability per closer (D72).** The times come only from what the booking source offers (Calendly available times,
GHL free slots) on every calendar the engine watches (D215: demo, setting and follow-up calendars too). Each calendar is
listed first with the times it offers per day, then the per-person table. A round robin's offered times are pooled, so each one is given to every
host free for the whole call then: on Calendly by the schedule the event type uses for that host
(`/event_type_availability_schedules`) and the host's busy times (`/user_busy_times`, buffered), on GHL by each team
member's own free slots. A closer's times are a union across calendars (a time two event types offer counts once for
them); the day's total is the sum of the closers (two free at 2pm = 2 open). Headers are first names when unique on the
roster. Self-check: an offered time no host is free for means the split is not trusted, so the closer columns are
dropped, the totals are the distinct offered times, and the answer says *Could not split by closer: N offered times
matched no host's schedule*.

Periods: `today`, `yesterday`, `this week`, `last week`, `this month` / `mtd`, `last month`, `last 30 days`, `this
quarter`, `September`, `Sep 1 to Sep 15`, `2026-09-01..2026-09-30`, `since Sep 15`. "This month" is the calendar month
so far in the company's zone. Words that are not a period are refused with examples, never guessed.

**Free questions**: mention the bot in a channel, or DM it. "@bot what's our close rate this month by closer?", "@bot
build me a report of the leads this month that showed, sorted by source", "@bot what does our calendar availability look
like?". 👀 goes on the question at once (and comes off when the answer is in); the answer goes in the question's thread
(in a DM, privately in the DM). A reply in a thread the bot is in continues the conversation without a new mention (the
thread's earlier questions and answers are kept in `bot_threads`); a reply that @mentions someone else is left alone.
"My", "me", "I" filter to the asker: their Slack id on the roster (`users.slack_user_id`), else the email Slack has for
them matched to a roster email (then remembered); unknown → the bot asks who they are in the CRM. No period, an unclear
person or an ambiguous term ("DQ") → the bot asks one question first. A question the tools cannot answer → "I'm not sure
how to get that information. Let me ping Tyler real quick." and then "Hey @Tyler, can you help?" in the same thread
(`audit_log` action `bot.escalated` keeps the reason); after that the thread is the team's and the bot stays out of it
unless mentioned again.

**Metrics** (`get_metric`). From GHL, read at answer time (D73): `leads` (contacts by `dateAdded`), `mqls` and
`marketing_dqs` (the answer to the work-situation field `crm.field_contact_work_situation`: an answer in
`qualify.mql_answers` is an MQL, one in `qualify.dq_answers` a marketing DQ, matched exactly; blank counts as an MQL only
with `qualify.unanswered_is_mql`; any other answer is "unrecognized" and never counted), `mql_rate`, `calls_booked_due`
(Sales Call records, `crm.object_sales_call`, whose call time fell in the period and has passed, cancellations
included), `shows`, `no_shows`, `cancellations` (outcomes mapped by `sales_call.outcomes`; a booking the source
cancelled before the call's start is cancelled whatever was filed), `show_rate` (shows ÷ calls booked), `sales_dqs` (a
`sales_call.dq_dispositions` disposition), `closes` (distinct people with a won card on `crm.pipeline_closer`, by won
time), `revenue`, `close_rate` (closes ÷ shows), `cash_collected`, `cash_gross`, `refunds` (GHL Payment records by
`occurred_at`: succeeded payments in, refunds and chargebacks out; closer and setter from the record; none at all →
"GHL has no Payment records yet", never $0, never the ledger's). From the ledger: `booked` (bookings made), `calls_due`,
`leads_booked`, `leads_showed`, `reschedules`, `speed_to_lead` (median minutes, D64), `dials`, `connected`, and
`jev_setter_accuracy` (D79: how often Jev's read of a setter call matched what happened, by Jev's read or by setter, from
the `setter_call.result` events with the Discovery Call records read live). Test contacts (`sys-test`, or an email on `test.domains`)
count in none of them. GHL that cannot be read is an error with its status, never the ledger's number. Split by
`source`, `closer`, `setter`, `day`, `week` or `month` where the metric has that side; filter by closer, setter, source
or the asker. A person's source (D78, one order everywhere) is the CRM lead-source field (`crm.field_contact_lead_source`),
else the contact's UTM Source field (`crm.field_contact_utm_source`), else GHL's own attribution (`attributionSource.utmSource`,
then the latest touch's), else the UTM source on their latest booking, else GHL's attribution `medium` (zapier, manual),
else `unknown`; as GHL has it (fb, ig), trimmed and lower-cased. A Sales Call record is tied to a ledger booking only one-to-one (same external id,
else the same GHL contact starting the same minute).

Install input for the GHL config (Hair's values):

```json
{ "crm": { "field_contact_work_situation": "8JjXmfXouYVTX3VLXjzP", "pipeline_closer": "<closer pipeline id>",
           "field_contact_utm_source": "VgT7mX7aJEUhwB5Wkbek", "field_contact_utm_medium": "VKwcQhgFpCnHWajkwj7W",
           "field_contact_utm_campaign": "WG9FD5zCk9XUyybclUPN", "field_contact_utm_content": "IXnwhT2NNpwpqSujViDr",
           "field_contact_utm_term": "BWtwm6UHjpzZmKABO2pa", "field_contact_fbclid": "WkrOCVGjKaWxnptI1PKa" },
  "qualify": { "mqlAnswers": ["Employed full-time", "Business owner or entrepreneur", "Investor"],
               "dqAnswers": ["Currently between jobs", "Employed part-time"], "unansweredIsMql": false },
  "salesCall": { "object": "custom_objects.sales_call",
                 "outcomes": { "scheduled": "scheduled", "showed": "showed", "no_show": "noshow", "noshow": "noshow", "cancelled": "cancelled", "late_cancel": "cancelled", "rescheduled": "rescheduled" },
                 "dqDispositions": ["dq"] } }
```

The same map, inverted, is what the engine writes on a Sales Call's `outcome` (`{{picklist.sales_call_outcome.*}}`), so
every write is one of the company's own option keys: `scheduled` at booking, `showed`, a no-show as the company's own
spelling (`no_show`; the engine's `noshow` is only an alias to read old writes), and "rescheduled / cancelled on the call"
as the key meaning rescheduled, else the late cancel (`late_cancel`). A meaning the map lacks is not written at all.

The objects the templates write are the company's own (D118): `crm.object_sales_call`, `crm.object_payment`,
`crm.object_discovery_call`, each `custom_objects.sales_call` / `.payment` / `.discovery_call` when unbound, and
`{{records.sales_call}}` is the person's latest record on whichever object is bound. Two more option lists on the Sales
Call: `salesCall.objections` (the Primary Objection options; unset, the list the templates always wrote) and
`salesCall.closerOptions` (`{ "<email | CRM user id | roster name>": "<option key>" }`, the closer's key on a Closer
dropdown; unset, the closer is written by name). Templates read them with `{{… | option:sales_call_objection}}` and
`{{… | option:sales_call_closer}}`; the end-of-day reminder and the numbers read an option key back as its closer.
What Call outcome filed writes on the Sales Call's `disposition` is the company's own key for the closer's answer
(D119): the inverse of `salesCall.dispositions` (`{{appointment.call_outcome | option:sales_call_disposition}}`; of two
keys with one meaning, the one with no reason), unbound the engine's own keys (`closed_won`, `deposit`, `close_pending`,
`follow_up`, `lost`, `dq`). A deposit is the company's Deposit option, never `closed_won`; a company whose map has no
deposit key gets the field emptied on a deposit until it adds the option in GHL and declares it (`"deposit": "deposit"`).
A call filed as a deposit moves the closer card to `crm.stage_closer_deposit` (the board's Deposit stage, after Follow Up);
unbound, that step skips and says the board has no Deposit stage.
A company's own words (a welcome, DQ reasons) are company copies. A company runs one playbook (D170, `src/playbooks/`):
`installs/<company>/playbook.json` names it and holds its params, and `scripts/build-copies.ts <company>` builds its copies
from the current templates (`--check` says which fell behind; `playbooks.test.ts` fails on one).

**Until live, the team hears nothing directly (D76).** In ghost and test a DM to a team member (a `slack_post` to a user
id, the owner's DM from `notify_owner`, the end-of-day reminder) goes to the company's ops channel instead, bound as
`slack.channel.ops` (install input `slack: { ops: "C…" }`; Hair's is C0C7QCTHL8L), else to the operator's DM
(`bot.escalate_to`), prefixed "Would have sent to <name>:"; neither bound, it is recorded only. A run with no contact is
ghost in test. "Until live" is the run's: a workflow live on its own (D92) DMs real people while the company is in test.

**Setup, once per Slack app** (then **reinstall the app to the workspace**: Slack asks for the new scopes; the bot token
normally stays the same, and if Slack shows a new one, re-run install with it as `slackToken`). App manifest fragment, with the
company's id in the URLs:

```yaml
features:
  app_home:
    messages_tab_enabled: true              # people can DM the bot
    messages_tab_read_only_enabled: false
  bot_user:
    display_name: Ops
    always_online: true
  slash_commands:
    - { command: /mtd, url: "https://backend-in-a-box.vercel.app/api/webhooks/slack/<companyId>/commands", description: "Month to date: leads, shows, closes, cash vs last month", should_escape: false }
    - { command: /weekly, url: "https://backend-in-a-box.vercel.app/api/webhooks/slack/<companyId>/commands", description: "Last week's numbers (or: this week)", usage_hint: "[this week]", should_escape: false }
    - { command: /monthly, url: "https://backend-in-a-box.vercel.app/api/webhooks/slack/<companyId>/commands", description: "Last month's numbers (or: this month)", usage_hint: "[this month]", should_escape: false }
    - { command: /show-rate, url: "https://backend-in-a-box.vercel.app/api/webhooks/slack/<companyId>/commands", description: "Show rate by closer and source", usage_hint: "[last month]", should_escape: false }
    - { command: /close-rate, url: "https://backend-in-a-box.vercel.app/api/webhooks/slack/<companyId>/commands", description: "Close rate by closer and source", usage_hint: "[last month]", should_escape: false }
    - { command: /cash, url: "https://backend-in-a-box.vercel.app/api/webhooks/slack/<companyId>/commands", description: "Cash collected, refunds and net by closer", usage_hint: "[last week]", should_escape: false }
    - { command: /availability, url: "https://backend-in-a-box.vercel.app/api/webhooks/slack/<companyId>/commands", description: "Open calendar slots per day and per closer", usage_hint: "[days, up to 7]", should_escape: false }
    - { command: /leads, url: "https://backend-in-a-box.vercel.app/api/webhooks/slack/<companyId>/commands", description: "Leads, MQLs and marketing DQs by source", usage_hint: "[yesterday]", should_escape: false }
    - { command: /closes, url: "https://backend-in-a-box.vercel.app/api/webhooks/slack/<companyId>/commands", description: "Every close in the period: who, closer, day won", usage_hint: "[last month]", should_escape: false }
    - { command: /leaderboard, url: "https://backend-in-a-box.vercel.app/api/webhooks/slack/<companyId>/commands", description: "Closers by cash, setters by sets", usage_hint: "[last week]", should_escape: false }
    - { command: /help, url: "https://backend-in-a-box.vercel.app/api/webhooks/slack/<companyId>/commands", description: "What the bot can answer", should_escape: false }   # no usage_hint: Slack refuses an empty one
    - { command: /support, url: "https://backend-in-a-box.vercel.app/api/webhooks/slack/<companyId>/commands", description: "Something broke, or you need something: logs it for Tyler with a number", usage_hint: "[what's wrong or what you need]", should_escape: false }
oauth_config:
  scopes:
    bot:
      - chat:write
      - chat:write.customize      # existing: posts under a step's name and icon
      - channels:read             # existing: the health sweep checks the bot is in its channels
      - groups:read               # the same check for a private channel (without it every step posting there is red: missing_scope)
      - reactions:read            # existing (D45)
      - reactions:write           # existing (D44): also the 👀
      - users:read.email          # existing: mentions; now also "my …" and the escalation person
      - users:read                # new
      - commands                  # new
      - app_mentions:read         # new
      - im:history                # new: DMs
      - channels:history          # new: replies in a thread the bot is in
      - groups:history            # new: the same in private channels
settings:
  interactivity:                # D93: the Retry and Resolve buttons on alert posts
    is_enabled: true
    request_url: "https://backend-in-a-box.vercel.app/api/webhooks/slack/<companyId>/interactions"
  event_subscriptions:
    request_url: "https://backend-in-a-box.vercel.app/api/webhooks/slack/<companyId>"
    bot_events:
      - reaction_added            # existing (D45)
      - app_mention
      - message.im
      - message.channels
      - message.groups
```

`/leaderboard` (D94) is new: until it is added to the Slack app's slash commands (the same request URL as the others,
`/api/webhooks/slack/<companyId>/commands`), Slack does not send it.

`/help` is not one of Slack's built-in commands (checked against Slack's list of built-in slash commands, 2026-10-10),
so it is registered as is. Slack lets several apps register the same command and the most recently installed one wins;
if another app in the workspace already owns `/help`, register `/ops-help` instead (the door treats `/help`,
`/ops-help` and `/bot-help` the same). Slash commands do not run inside threads (Slack's rule), which is why follow-ups
are plain replies.

**Interactivity** (D93): Slack app → Interactivity & Shortcuts → on, Request URL
`https://backend-in-a-box.vercel.app/api/webhooks/slack/<companyId>/interactions` (the `interactivity` block above). Without it the
Retry and Resolve buttons on alert posts show, but Slack says the press failed. No new scope: editing the post is `chat:write`.

The model needs `secret.anthropic_key` (bound at install; env `ANTHROPIC_API_KEY` is the fallback); without it every
free question escalates, and the shortcuts still work. The escalation person is the install's `bot: { escalateTo }`:
a Slack user id, or an email the install resolves to one through Slack (bound as `bot.escalate_to`; the roster row
with that email learns its Slack id so the bot can say their first name). The bot answers only for the company whose
Slack connection matches the event's team id. Both doors acknowledge within Slack's three seconds and do the work
after the response (`after()` from `next/server`); deliveries are deduplicated by event id as before.

## A company's GHL setup from a file (`provision-ghl`, D117–D121)

A company that lives in a GHL location the engine builds into (Dating Nelly in RapidCloser) has its pipelines, fields,
objects, associations, calendars and calendar group declared in `installs/<company>/ghl-setup.json` and built by:

```bash
pnpm exec tsx scripts/provision-ghl.ts --setup installs/dating/ghl-setup.json \
  --pit-env DATING2_GHL_PIT --location-env DATING2_GHL_LOCATION_ID --out /tmp/skeleton.json        # dry run: reads only
pnpm exec tsx scripts/provision-ghl.ts … --apply                                                   # makes what is missing
```

Additive and re-runnable: matched by name (with the setup's `prefix`) or key, it creates what is missing and adds a missing
stage, field or option to its own things; it never renames, retypes or deletes, and never writes to anything the setup does
not name. The one setting it changes on something that exists is a declared calendar's team (D121): the setup's `team`
(or a calendar's own) is set on its calendars, the dry run printing `change-on-ours … <before> → <after>`. Its calendars go
in its `calendarGroup` (made if missing; one already in someone else's group is not moved). A second run after an apply is
all `exists`. `--out` gets the install skeleton (crm ids, calendars, picks).

A contact field with `"folder": "Application"` goes in the setup's own contact-field folder ("Dating – Application"), made if
missing (D122). GHL documents contact folders nowhere; the folder is made the way this repo's first build made "Core System"
(`POST /locations/{id}/customFields` with `documentType: "folder"`) and the fields go in it by `parentId`. If GHL will not make
it, the plan says `blocked` and the fields are made without a folder: make it in GHL and move them by hand. A field made
earlier outside its folder is bound and said, never moved.

## Alerts and the health sweep (D33)

The engine says what broke the minute it breaks, and nothing while it works. A step that fails is retried in
place (never the run from the top, never a side effect twice: a transient error at 1 and 5 minutes, three tries in all, D76; a dead
token pauses at once, D66). Then (D77): a step nothing later reads (a tag, a note, a send, a post) is skipped and the run
goes on, with one alert "Couldn't <what> for <name> after 3 tries (<error>); everything else in <workflow> ran." and a
**Retry this step** link that re-runs only that step; a step the run cannot go on without holds the run on itself and is
re-checked alone (15 minutes, then hourly) until it passes, one alert, ✅ Resolved when it does; a run that pauses for a
person becomes an alert with the workflow, the step in words, the contact, the error and the link to its page, where
**Retry this step** / **Skip this step** are the two hands; a dead token is one `auth:<vendor>` alert per company that a new token in settings closes while waking the
runs it stopped; a poll cursor that has failed `alerts.poll_failures` times in a row (2) becomes one; a workflow copy the engine cannot parse
becomes one; a run the engine itself broke (`failed`) becomes one. One open alert per
(company, key). The engine collects and dedupes them and keeps the clock; **what is said is the Health check
workflow's** (D88): the first time an alert is due the engine emits `alert.raised` (its text, level, kind, links,
the thread detail, the company's alert channel and face: the sweep's own for its findings, else
`alerts.slack_channel` / `alerts.as_name` / `alerts.as_icon`), while it stays open `alert.repeated` every
`alerts.repeat_minutes` (60), and once it clears (the next run got past the step, the poll succeeded, the sweep
found it fine) `alert.resolved`. The workflow posts the alert (tagged `alert:<id>`; the headline per kind, the 🔴 / 🟡,
the Open and fix links are its set_vars and template), the still-open line in its thread, and "Resolved" in the
thread with a ✅ on the first post (the Slack app needs `reactions:write`). Slack only: there is no alert email or
webhook any more (Tyler: "We definitely don't need to alert on an email"; a webhook step on the workflow is the way out
if one is ever wanted); an alert about the engine itself (no company) still goes to `OPERATOR_WEBHOOK_URL`. A company
with no enabled workflow on `alert.raised` (an edited Health check copy from before D88 is not upgraded) hears nothing;
readiness says so. The alert's post carries a **Resolve** button, and **Retry** when the alert is a step skipped after
its tries (D93; the slack_post step's `buttons`, so the workflow decides which alerts get which). A press reaches
`/api/webhooks/slack/<companyId>/interactions` (signed like the other Slack doors, acknowledged at once, handled after the
response); only the company's owners and managers (by `slack_user_id`) and the operator (`bot.escalate_to`) may press,
anyone else is told "Only a manager can do that." privately. Resolve closes the alert (`audit_log`
`alert.resolved_by_operator`, why "resolved in Slack by <name>") and edits the post to "✅ Resolved by @who" without the
buttons; Retry re-runs only that step (D77) and, when it passes, the alert resolves and the post reads "✅ Fixed — retried
by @who"; when it fails again the buttons stay and the new error is said in the alert's thread. A second press says it is
already done and changes nothing. The dashboard home and each company page show what is open;
`/app/c/<slug>/health` shows open alerts, the last sweep check by check, what cleared recently, and (folded) every event a workflow can start from with the workflows that use it.

The **health check** is a workflow (`health-check` template, D35): a schedule trigger (every 60 minutes) and a
`health_check` step whose settings are the list of checks (`checks: {"<id>": false}` turns one off), the
channel its alerts announce in and the face they post as, and (D88) `slots_days` (7), `fathom_silent_days` (14),
`drift_days` (7) and `poll_lag_min` (30); plus the three alert triggers above. Edit the company's copy to change any of it. It is
read-only against every vendor except for the ledger repair below. Checks: the GHL token opens the location; every mapped GHL calendar returns
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
at; the engine never merges, and the finding clears when the CRM no longer has the dropped record); and the ledger
matches GHL over the last `drift_days` (D73, `ledger_drift`: a contact GHL added that the ledger lacks is pulled in
and fires New lead once; one GHL says is gone is marked gone; a Sales Call the booking source cancelled before its start
is set cancelled in the ledger and handed to the **Ledger drift** workflow to set in GHL (`drift.sales_call_cancelled`,
once ever, under the mode rules), as is a Sales Call missing its link to its contact or its one closer card
(`drift.sales_call_unlinked`); otherwise GHL's filed outcome replaces the ledger's; every repair is in `audit_log` as
`health.repaired`, each kind of finding is one `drift.found` event a sweep, and what cannot be repaired is one alert,
`health:ledger_drift`, whose questions are data the Health check workflow words, D88). A failed
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
the calendar's public scheduling page (`calendarLink`) and, in its thread, the same per-closer table `/availability`
posts.

**A skipped step says why.** Every skip carries a kind: `noop` (nothing to do, by design: no card to move,
SMS off for the company, already sent) or `blocked` (something is missing: Slack not connected, a channel not
bound, no AI key). The timeline shows "nothing to do" or "blocked" instead of a bare "skipped", a ghost
write shows "ghost", and a blocked step raises a warning alert the minute it happens, cleared when a later
run gets past that step. "Remember" steps (`set_var`, copy plumbing) are not shown in the outline or the
timeline; the definition under Advanced has them.

## The closer's end-of-day report (D34)

One standing link per closer (`/eod/<token>`, no login), today by default, arrows to other days. The page stands
alone: no nav, no link to the dashboard (its own layout; the dashboard pages live under `app/(dash)`). It opens
prefilled from the engine's own ledger: calls on their calendar that day; for each, what happened (no-show or
rescheduled from the appointment's status; closed, deposit, follow up, lost or DQ from a recorded outcome, else from
money that day, else from Jev's read of the transcript), cash collected and revenue generated, next step and date, "about this
prospect" (Jev's summary with the pains, goals and objections), notes, links to the CRM contact and the recording;
at the top, calls, closes, deposits, cash collected and revenue generated. Every value is editable.

Each call asks one thing first, what happened, and the questions that follow appear once it is picked: closed shows
cash collected, then revenue generated; deposit shows cash collected only (D119) (a call with more cash than revenue is not filed until it
is fixed); follow up shows the next date and steps; DQ shows a reason (a select) and a
note; lost shows "Why were they lost?" (a select the company edits, required; A1, D88); the held outcomes show "about
this prospect"; notes follow any outcome. A deposit is a payment for one of the company's deposit products (D119;
prefilled when everything paid that day was a deposit, never from the amount); it is counted on its own, not as a close,
its cash is in the totals and it asks no revenue (revenue contracted is a close's). Close pending (D83) is half a close (signed but
not paid, or paid but not signed): a show, never counted as a close. Attendance is implied by the outcome.

**The outcome list is the company's** (B6, D88): the outcome field on the `forms` row carries `choices`, each
`{ value, label, attendance: showed | noshow | rescheduled, call_outcome?: closed | deposit | pending | follow_up | lost |
unqualified, money? }`. Everything reads the meaning, never the key: what is filed (the attendance and the call outcome
term), the totals (closes are `closed`, deposits `deposit`, cash the `money` ones, by default closed and deposit,
revenue the money ones that are not a deposit), which questions follow (cash follows money, revenue money but never a deposit, the DQ and lost reasons their meaning, about any show),
how the ledger's outcome and Jev's read pre-fill the form. The defaults are Closed,
Deposit, Close pending, Follow up, Lost, DQ, Rescheduled / cancelled on the call, No-show.

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

The form's rows are the closer's bookings on the engine's ledger, and nothing else (D110): the engine polls bookings from
install on, ghost included, so every call a closer takes is one of them. A Sales Call in GHL with no booking behind it
is never a row, and the reminder does not count it; D77's rows for calls booked before the engine, and the workflow that
wrote them to GHL, are gone. A changed answer, on any row, empties on the Sales Call what the earlier answer set and the
new one does not (`crm_record.clear`, sent as `null`).

Who is a closer is a role on the roster (settings § Team; install input `closers`: emails or CRM user ids). The CRM
roster comes in as `staff`; only `closer` rows get a link and the DM.

The reminder and what happens after filing are workflows (D35). `eod-reminder`: two schedule triggers, one run per
closer each: at 18:00 company time (today's link plus any earlier unfiled day, one line each) and at
09:00 (earlier unfiled days only), a `check` that there is something to file, a `slack_post` DM to the closer
(`{{user.slack_user_id}}`, looked up by email) remembered under the tag `eod-reminder:<user>:<day>`. The `eod_due`
steps carry the rules (D88): `lookback_days` (7), `include_today` (evening yes, morning no), `overdue_after_days` (2:
a booking whose Sales Call is still blank in GHL that long is also told to the operator; null: never; a Sales Call with
no booking is never counted, D110); they hand the template a list (`vars.due.days`: url, label, `when`, calls,
`ghl_blank` (bookings whose Sales Call GHL still holds blank though the ledger has an answer or the day is filed),
`both`; `vars.due.overdue`: label, names) and every word of the DM and the operator's note is built from it with
`each` / `join`. Change the times, the rules, the copy or the face
on the company's copy. `eod-filed`: filing emits `eod.filed` with the whole report
(totals, every call with its answers, corrections, the day questions, why each loss or DQ went that way) and a run about
that closer starts: the summary to `{{slack.channel.eod}}` (edited in place on a refile, D76) with the corrections, the
day's answers and the lost / DQ reasons, then "✅ Got it" threaded under the
reminder DM with a ✅ reaction (`thread_of: "tag:…"`, `react`). A `webhook` step after it sends the report to
Airtable, a Zap, Apps Script, anything with a URL. Filed reports and every closer's link: `/c/<slug>/eod`.
Tested in `eod.test.ts`.

## Readiness (is it safe to go live?)

The company page and every workflow page carry a readiness card built from facts
(`src/engine/readiness.ts`): ghost vs live, Slack connected or not, each workflow's required bindings
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

The same POST sets a workflow's own mode (D92): `{ "company", "workflow", "mode": "ghost"|"test"|"quiet"|"live"|null, "by": "<who>" }`
(`enabled` optional alongside; `null` or `"company"` follows the company again). A mode that puts the workflow's runs live
is refused (409, with `blockers`) unless its definition runs, its required settings are bound and, when it posts, DMs or
waits on a tap, Slack is connected; it then clears that workflow's runs not born live. The GET lists each workflow's
`mode` (its own, null when it follows) and `runsIn`. Every change is a `workflow.mode` row in `audit_log` (by, from, to, when).

### A company's whole workflow, and a shared key (D100)

`GET /api/admin/workflows/definition?company=<slug>&workflow=<id | template slug | exact name>` returns that company's
copy: `{ ok, company, workflow: { id, name, slug, enabled, diverged, version, template_version, note }, definition }`.
`POST /api/admin/workflows/definition` with `{ "company", "workflow", "definition": {…}, "note": "<what changed and why>", "by"?, "dryRun"? }`
saves an edited definition as a new version of **that company's copy only** (steps added or removed, edges rewired),
marks it diverged (template upgrades leave it alone), re-syncs its triggers and reentry, and audits
`workflow.definition_saved`; runs already going keep the version they started on. Answer:
`{ ok, saved, dryRun, from, version, diff: { nodes: { added, removed, changed }, edges: { added, removed }, settings }, missing, warnings }`.
A definition that does not validate is refused (422) with every reason in `problems`; `dryRun: true` validates and returns
the diff without saving. Bindings the definition needs and the company lacks come back in `missing`: saved while the
workflow is off (turning it on stays refused until they are bound), refused (409) while it is on.

D123: the same `POST` with `"create": { "stage"?, "sort"?, "takesOver"? }` and a `workflow` name the company does not have makes
**the company's own workflow** (no template behind it, OFF, version 1, triggers synced, audited `workflow.created`); answer
`{ ok, created, dryRun, id, name, takesOver, missing, warnings, layout }`. `takesOver` names the shipped template whose job it does
for that company (Dating (Nelly)'s Triage call booked and Sales call booked take over `call-booked`): install never puts that
template back, and the create is refused (409) while the company still has the template's copy: remove it first with
`DELETE /api/admin/workflows { company, workflow: "<template slug>" }` (refused while on). The files `build-copies` writes for
own workflows carry `name` and `create`.

`POST /api/admin/bindings/copy` with `{ "from": "<slug>", "to": "<slug>", "keys": ["secret.anthropic_key"], "by"? }` copies
secret bindings from one company to another inside the engine: decrypted there, encrypted again, never returned. Only
the AI keys `secret.anthropic_key` and `secret.jev_key` (a client's own accounts: CRM, booking, payments, webhook secrets, are set by install); a key `from` does not have refuses the whole call (404). Answer:
`{ ok, from, to, copied: [{ key, was: "new" | "same" | "replaced" }] }`; the target company's `audit_log` gets
`binding.copied` with the keys and the source slug. Both take `Authorization: Bearer $CRON_SECRET`.

## Test harness: a real contact, behind the scenes (D23)

To see what the engine would do for a person without firing a single Zap or GHL workflow, stage
the step instead of performing it. **Only for a test contact** (tagged `sys-test` or on a test-domain email), in every
mode, forced or not (D97): a staged booking on a real person lands on their closer's end of day, the reminders and the
numbers even when every run about it is ghost. `force` only lets a test contact be staged while the company is live.
`POST /api/admin/harness-cleanup { company, dryRun? }` removes harness bookings already sitting on real people, with the
rehearsal runs they started. Three ways to stage, same code:

- In GHL, add a tag `sys-test-<action>` to the contact. The next poll runs the action and drops the
  tag from the engine's view (it never becomes a `tag.added` event). Remove the tag in GHL afterwards
  so it can be used again.
- On the contact page in the dashboard, the **Test harness** buttons.
- `POST /api/admin/simulate` `{ "company": "<slug>", "contact": "<email | GHL id | our id>", "action": "<action>" }`
  with `Authorization: Bearer $CRON_SECRET`.

Actions: `form` (a Typeform application, D125: below), `create` (a lead comes in), `book` (a setter books the closing call, 3 days out, 2pm in the
contact's zone), `book-self`, `reschedule` (+2 days, or to `startsAt`), `cancel`, `pay` (the program price; `deposit: true`
stages a deposit, D119, default $100), `agreement`
(an agreement sent and unsigned), `sign` (the agreement completed), `record`
(a Fathom-shaped recording with a short transcript, through the match ladder), `call` (a connected
3-minute dialer call 20 minutes ago with a setting-call transcript, dialed by the roster's setter, else one of the company's
own closers or managers, never the other business's staff of a shared location; GHL has no such
call to read it back from, so the transcript is held like a webhook's until the run is done),
`reset` (the engine
forgets every run, send, card, pursuit and synthetic appointment for that person, and a staged application's delivery
marks, so the same `form` is a first application again; the contact stays).

**Which calendar (D125).** A company with several mapped calendars (Dating (Nelly)'s Strategy session and Consultation) says
which with `calendar`: the calendar's external id, its call type's name (`"Strategy session"`, any case) or its own name. `book`
and `book-self` book on it (without it: the closer call's calendar, as before); `reschedule`, `cancel` and `record` take the
latest open staged booking on it (without it: the latest open one). The booked event carries the call type's name, so a
workflow held to it (Triage call booked, Sales call booked) runs exactly as for a real booking: one of them, never both.

**A staged application (`form`, D125).** `{ "company": "dating-nelly", "contact": "tyler+n1@jtylerray.com", "action": "form",
"form"?: "<form id or name>", "answers"?: { "<ref | first_name | field_contact_app_age | app_age | utm_source>": value }, "responseId"?: "n1" }`.
The person need not exist: the response goes through `takeDelivery`, the function the signed Typeform webhook calls, so
the door finds them in GHL (email, then phone) or makes them, writes the answers as the mode allows (real for a test
contact in test mode, would-have in ghost), records `form.submitted` (`simulated: true`) and New from Typeform and New lead
run as for a live applicant. Every mapped question gets a plausible answer (the email as given, a fictional 555-01xx phone
one per email, UTM source `sys-test`); `answers` overrides by ref, target or hidden name, and a key the form does not have is
refused. The response id is `sim-…`: one per form and email unless `responseId` names another, so the same request twice is
one application. Typeform itself is never called. Only an email on a test domain, or someone the ledger already has tagged
`sys-test`. From the contact page or a `sys-test-form` tag it applies with the contact's own email.
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

## Building blocks (D85)

Generic steps a template combines instead of the engine hardcoding a business rule. Each is data in the
definition, says what it does in plain words on the chart, is listed in the coverage map and has a failure role.

**`wait_for_event`: an event or a deadline, whichever comes first.** `{ event, match?, about?, since?, until?,
into?, respect_send_window? }`. Waits for an `event` (a type from `event_types`, checked by the sweep like a
trigger's) about the run's contact (`about: "contact"`, the default) or its appointment (`"appointment"`).
`match` is the trigger's predicate, read against the run's context plus the event's data under `data` and the
whole event under `vars.<into>` (`{{vars.booking.appointment.kind}}`: a booking event carries the booking's
`kind`, `booking_source` setter | self, `status`, `starts_at`, `booked_at`). `since` (a template time, with an
optional offset: `"{{recording.started_at}}"`, `"{{recording.ended_at}} -5m"`) lets an event that already
happened count at once; without it only events after the step began count. `until` is a `wait` rule on any
context time (`{ anchor: "recording.ended_at", offset: "+15m" }`), pinned when the step begins and moved into
the send window as `wait` is, unless `respect_send_window: false` (a deadline nobody hears about). The result
lands in `vars.<into>` (default `waited`): `{ matched: true, id, type, at, source, data, appointment? }` or
`{ matched: false }`. Edges: `label: "event"` and `label: "until"` (a plain edge stands in for either). Nothing
polls: parked, the run carries `runs.wake_on_event` = the type, and `emitEvent` (`dispatch.ts`) sets
`next_run_at = now()` on every waiting run of the company with that type for that contact or appointment, the
way an inbound text wakes a reply wait; the deadline is `next_run_at`. An event the step took is never taken
again when the run comes back to the step. Deadline editable on the step (`until_offset`).

```json
{ "id": "w_booked", "type": "wait_for_event", "event": "appointment.booked", "since": "{{recording.started_at}}",
  "match": { "eq": ["{{vars.booking.appointment.kind}}", "closing"] }, "into": "booking",
  "until": { "anchor": "recording.ended_at", "offset": "+30m", "tz": "company" }, "respect_send_window": false }
```

**Lists in any template.** Two filters: `each:"<template>"` renders its own template once per item of a list,
with `{{item.*}}` (nested fields too), `{{index}}` (from 0) and `{{number}}` (from 1) beside the rest of the
context; `join:"<separator>"` puts the lines together (default `, `). A filter argument in double quotes may
hold `|`, `}}` and `{{…}}` of its own, with `\"` and `\n` as escapes. An absent or empty list renders nothing,
so the existing `default:` gives the fallback. Works in Slack text, notes, task bodies, every template.

```
{{vars.days | each:"• {{item.label}}: {{item.count}} calls" | join:"\n" | default:No calls today}}
```

**`lookup`: facts into vars for the steps after it.** `{ query, params, into }`. `query` is one of the engine's
own read-only questions (`LOOKUP_QUERIES` in `definition.ts`, the SQL in `lookup.ts`; never SQL in a template),
always about the run's company and its contact (or appointment); `params` are templates, and one that renders blank is no filter.
Times take an ISO time, `now`, either with an offset (`"{{recording.ended_at}} +30m"`), or an offset from now
(`"-7d"`). A list answer is `{ count, any, items, first, last }`; `last_event` answers `{ found, count, id, type,
at, source, data }`. A later step that reads `vars.<into>` makes the lookup blocking (D77).

| query | params | each item |
|---|---|---|
| `appointments_for_contact` | `booked_since`, `booked_until`, `starts_since`, `starts_until`, `kind` (call types, e.g. `closing`; a booking with none is closing), `booking_source` (`setter` / `self`), `status`, `status_not` (comma lists), `exclude` (an appointment id), `order` (`starts_at` / `booked_at`), `closer` (D87: name, email or CRM user id) | `id, starts_at, ends_at, booked_at, status, kind, booking_source, set_by, source, closer, outcome` |
| `calls_for_contact` | `since`, `until` (call start), `provider`, `caller` (name or email), `kind` (`phone` / `meeting`), `connected` (`true` / `false`; more than 0 seconds) | `id, provider, kind, started_at, ended_at, duration_min, duration_sec, direction, status, connected, caller, caller_email, title, appointment_id` |
| `call_conversation` (D87) | `recording_id` (a call), `gap_min` (minutes) | the parts: `id, external_id, provider, kind, started_at, ended_at, duration_min, duration_sec, has_transcript, transcript_status, caller`; besides the list, `key` (the first part's id, what the conversation is filed under), `part` (this call's number), `total_sec`, `total_min`, `later_ready` (later parts that already have a transcript) |
| `last_event` | `type` (comma list), `since`, `until`, `about` (`contact` / `appointment`) | (one event) |

The context fact `contact.has_upcoming_call` is one lookup (`nodes.test.ts` proves they agree): `{ kind: closing,
status_not: "cancelled,noshow", starts_since: "{{now}}", exclude: "{{appointment.id | default:}}" }` → `.any`. D87 deleted
`recording.booked_within_30m` and `recording.led_to_booking`: there is one Set, a setter-link booking from the call's
start to `recording.set_until`, `{ booking_source: setter, booked_since: "{{recording.started_at}}", booked_until:
"{{recording.set_until}}" }` → `.any`, the same rule the metrics count (`setByBookingSql`).

```json
{ "id": "l_booked", "type": "lookup", "query": "appointments_for_contact", "into": "booked",
  "params": { "booking_source": "setter", "booked_since": "{{recording.started_at}}", "booked_until": "{{recording.set_until}}" } }
```

**`crm_record` by the CRM's id.** `record_id` (a template, e.g. `"{{vars.found.id}}"` from a lookup or a webhook)
addresses a record the engine did not make, instead of the engine's own `key`. The step only ever updates that
record (an id that renders empty is skipped, never a create); the rules are the ones a keyed update has: ghost
and a test-mode contact that does not pass write nothing (and our ledger is not told they did), properties the
object lacks are left out and named (`not_on_object`, D76), `clear` empties what this answer does not set (D77),
`relate` links it. Our ledger keeps it under the key of the row that already has that CRM id, else `key` when
given, else `ghl:<id>`. An update by id is idempotent, so a retry writes the same values once more and nothing is
ever created twice.

```json
{ "id": "r_sc", "type": "crm_record", "object": "{{crm.object_sales_call}}", "record_id": "{{vars.sales_call.id}}",
  "properties": { "disposition": "{{vars.outcome}}" }, "clear": ["cash_collected", "next_step"] }
```

**`update_opportunity`: won, lost, and the card.** `{ status?, lost_reason?, set?, card? }` on our ledger's
opportunity (the run's, else the contact's open one). `status` (templated) is `open`, `won` or `lost`; `lost_reason`
is one of the company's `lost_reason` terms by key or name (one it lacks is kept on the event and named in the
step's result); `set` keeps `contract_value` and `installments` (the older `set.status` still works). Each change to
won or lost is one `opportunity.won` / `opportunity.lost` event (`{ by: "workflow", node, from, lost_reason? }`),
dispatched to the workflows that start on it; the row and the event are one transaction, so a retry finds the status
set and emits nothing again. `card: { pipeline, stage? }` marks the contact's card on that board the same way (and
moves it when a stage is given) through the pipeline card step's own code: the CRM read first, a hand that moved it
wins, ghost writes nothing, an open card only (reopening picks the latest). Ours, so the ledger part runs in ghost.

```json
{ "id": "o_lost", "type": "update_opportunity", "status": "lost", "lost_reason": "{{vars.reason}}",
  "card": { "pipeline": "{{crm.pipeline_closer}}", "stage": "{{crm.stage_closer_lost | default:}}" } }
```

**`record` that starts workflows (D87).** `record` writes one event to the ledger and, by default, starts nothing.
`start: true` also dispatches it to the workflows with a trigger on that type, once (a retry finds the event this step
wrote and starts nothing again); `appointment` (templated, one of the person's bookings; blank is the run's own) makes the
event about that booking, so the run it starts carries it. Setter call logged hands a dialer call Jev read as closing to
Sales call recorded this way.

```json
{ "id": "rec_close", "type": "record", "event": "call.closing", "appointment": "{{vars.booking_id}}", "start": true,
  "data": { "recording_id": "{{recording.id}}", "conversation": "{{vars.convo.key}}" } }
```

### D88 additions

Business behaviour that lived in engine code now lives in workflows and settings (D88). The pieces that made it
possible, all data in the definition:

- `slack_post.label`: `mode` (the rung's mark before live, D31/D52, the default), `ghost` (only while the run is
  in ghost mode: the workflow's own, else the company's, D92) or `none` (an alert about the engine itself, never marked).
- `slack_post.buttons` (D93): Block Kit buttons under the post's words, each with its own `only_if`; Health check's
  alert post uses them for Retry (a skipped step) and Resolve, handled by the Slack interactions door.
- `record_outcome.source: disposition` (with `user` and `via`): a person's answer filed exactly as the end-of-day form
  files it, so Call outcome filed runs; `via` is kept on the submission (`card_moved`).
- `update_opportunity.from`: the statuses the change is made from (`lost` only an open one).
- `eod_due`: `lookback_days`, `include_today`, `overdue_after_days`; a list into `vars.<into>`.
- `report`: `metrics`, `layout`, `period`, and `breakdowns` (`closer`, `setter`) that now do something.
- `leaderboard` (D94): `period` (plain words, `last week`), `into`; the ranked board and its phone-width `body`.
- `health_check`: `slots_days`, `fathom_silent_days`, `drift_days`, `poll_lag_min`.
- Filters: `nonzero`, `plural:"word"` (or `"person|people"`), `then:"text"`, `suffix:"text"`, `fixed:2`, `first:10`,
  `money:0`; inside a nested `each`, `{{parent}}` is the outer item.
- Context: `company.slug`, `company.base_url`, `appointment.started`.
- An event with no contact and no person starts a run about the company (unlinked payments and recordings, alerts,
  drift findings).
- A template marked `engine_default` installs ON into a company that already existed (it carries what the engine did
  by itself), OFF into a new one.
- New events: `alert.raised`, `alert.repeated`, `alert.resolved`, `drift.found`, `drift.sales_call_cancelled`,
  `drift.sales_call_unlinked`; `payment.unlinked` and `recording.unlinked` are dispatched now. (`eod.call_filed` was one
  too, until D110.)
- Settings (bindings): `alerts.repeat_minutes` (60), `alerts.poll_failures` (2).

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
POSTs to the same webhook when the engine's last tick is older than five minutes (one company whose own
ticks stopped is the engine's `engine:company_stale` alert, D98) — installed by
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

A booking taken as setter-booked whose setter nobody named (a GHL calendar never names one; Calendly when the setter
question has no answer) is an engine error alert, one per booking, `setter:missing:<appointment id>` (D121): "Setter-booked
call with no setter: <name>, <time> on <calendar>. Say who set it". It is raised in ghost and test too (an alert is not a
run). It clears by itself, and the name goes on the booking's `set_by`, once the setter is known: a team member's connected
dial the booking came during or within the Set window after (D87), or the contact's Setter field (`crm.field_contact_setter`)
filled in after the booking (GHL is read back every 5 minutes); with no Setter field bound, a person resolves it.

### The booking card's intake lines (D104)

What Call booked's Slack card shows under *Phone* is the company's own, never another client's questions. Install key
`bookingCard: { intake: [ … ] }`, stored as `booking_card.intake` (JSON); each line is a label and one source:

```json
"bookingCard": { "intake": [
  { "label": "Monthly revenue", "answer": "monthly_revenue" },
  { "label": "Ad budget", "field": "ad_budget" },
  { "label": "Hair loss", "field": "hair_loss", "plus": "hair_loss_stage" },
  { "label": "Qualified", "tags": { "meta booked call mql": "MQL", "meta booked call dq": "DQ" } }
] }
```
`tags` says the word for each of the contact's tags it names (exact tag, any case), several joined with commas, `—` when
none: PMU's MQL / DQ comes from tags its Zap sets, not a field.

`field` is a CRM contact field by the name it is bound under (`crm: { field_contact_ad_budget: "<id>" }`), `answer` a
booking answer by the name the calendar's `questions` give it (above), `plus` a second value from the same place after
one space. Templates read the lines ready-made as `{{contact.intake_lines}}` (`*Label:* value` per line, `—` when
empty); the shipped card uses `{{contact.intake_lines | line}}` after Phone, so a company with no lines set shows none.
Omitted on a re-install, the setting stays; `[]` clears it. The Setup page lists the lines under Booking.

Hair's four lines (Hair loss + stage, Noticing for, Commit to routine, Work situation) were backfilled as its setting by
the migration for every company with `crm.field_contact_hair_loss` bound, and again in front of each template install,
so Hair's card reads byte for byte as before when its Call booked copy upgrades:

```
curl -X POST -H "Authorization: Bearer $CRON_SECRET" https://backend-in-a-box.vercel.app/api/admin/migrate      # runs on every deploy too (pnpm build)
curl -X POST -H "Authorization: Bearer $CRON_SECRET" -H 'content-type: application/json' \
  -d '{"company":"hair","templates":["call-booked"]}' https://backend-in-a-box.vercel.app/api/admin/templates
```

### The copy

Hover any line of a workflow's outline to see the message it produces, rendered as an example
against a made-up contact (`src/engine/example.ts`: Jane Doe, Allan P, Luis, $1,500, tomorrow 2pm).
It is an example, not a preview: the point is to read the copy the way the team will, not the template. The booking card's
intake lines are the company's own labels with a placeholder for each value (`*Monthly revenue:* [monthly revenue]`).

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
throwaway company `smoke` in ghost, and prints the whole story: events in order, each run step by
step in words, every message or Slack post that would have gone out, the pipeline cards and tags
afterwards, what is parked for later, and the readiness list. Nothing external is called.

## One offer in a shared location: the scope tag (D117)

A company installed into a GHL location that belongs to another business (its contacts, dialers, calendars and pipelines)
gets a scope tag at install: `"scopeTag": "dating"` in the install file, or `--scope-tag dating` (bound as `scope.tag`,
lowercase; omitted on a re-install it stays as it is; `""` removes it). Then the engine's people are the contacts GHL tags
with it, and anyone booked on the company's mapped calendars (their booking is the offer's; when the booking workflows'
mode makes writes real the engine tags them in GHL, in ghost it records the tag it would have added). Everyone else in the
location is never replicated, fetched or counted: the contacts poll asks GHL's search for the tag, dialer calls and replies of
anyone else are ignored (a stranger is never fetched), their documents are mirrored but say nothing, the drift sweep pulls in
only the tagged, leads count only the tagged and the bookers, and a payment whose email or phone names someone out of scope
stays unlinked for a person to link. A tag taken off in GHL takes the person out of scope: nothing new starts for them,
nothing is deleted, and runs already going carry on. In test mode a harness contact needs the scope tag as well as
`sys-test`. No scope tag: the whole location is the company's, as before (Hair and PMU).

## Typeform applications (D122)

A Typeform form is a door straight into the engine, no Zapier. In the install file (or the install API body):

```json
"typeform": {
  "token": "<personal access token; never in the repo>",
  "forms": { "AjY7UfXZ": {
    "name": "VIP Matchmaking Application",
    "answers": { "<question ref>": "first_name | last_name | email | phone | field_contact_<binding>", "…": "…" },
    "hidden": { "utm_source": "field_contact_utm_source", "…": "…" },
    "submittedAt": "field_contact_app_submitted_at", "responseId": "field_contact_app_response_id" } }
}
```

Answers are mapped by the question's `ref` (`GET /forms/{id}` lists them), never its words; every `field_contact_…` target is a
`crm` binding. With a token, install checks each ref against the form and registers the engine's own webhook on each form whose
fields are all bound: tag `biab-<slug>`, URL `<PUBLIC_URL>/api/webhooks/typeform/<company id>`, a secret the engine makes once
(`secret.typeform_webhook`); deliveries are checked against `Typeform-Signature`. Health check verifies the webhook each sweep
(gone, off or pointing elsewhere is an alert with **Re-register the Typeform webhook**). A submission finds the person in GHL by
email, then phone, creates or updates them with GHL's own name, email and phone (only where GHL has them blank), every answer
and the UTMs, as the mode allows (ghost records the would-be write on `form.submitted`), and records and dispatches
`form.submitted` with the person (in scope by it, tagged or not). A response is taken once, however often Typeform sends it.
D123: what an applicant then gets is a workflow on `form.submitted`, drawn on its chart: Dating's own **New from Typeform**
(built by `build-copies` from `installs/<company>/copies.json`) adds the scope tag and starts New lead once, only for someone
who is not a lead yet. Without that workflow on, a submission is recorded and nothing else happens.

The responses from before the webhook come in with the importer, through the same path:

```bash
# dry run (reads Typeform and GHL, writes nothing anywhere)
pnpm exec tsx scripts/import-typeform.ts --company dating-nelly --form AjY7UfXZ --out /tmp/typeform-dryrun.txt
# without the database, from the install file and tokens in the environment
pnpm exec tsx scripts/import-typeform.ts --install installs/dating-nelly.json --form AjY7UfXZ --token-env DN_TYPEFORM_TOKEN \
  --pit-env DATING2_GHL_PIT --location-env DATING2_GHL_LOCATION_ID
# apply: real GHL writes whatever the company's mode (a deliberate one-off), 50 a run, oldest first; re-run until nothing remains
pnpm exec tsx scripts/import-typeform.ts --company dating-nelly --form AjY7UfXZ --apply [--limit 50] [--new-lead]
```

In production: `POST /api/admin/typeform-import` with `{ "company": "dating-nelly", "form": "AjY7UfXZ" }` (dry run; the answer
carries the report) and `"apply": true` (answers `written`, `skipped`, `failed`, `remaining`, `runsStarted`). A response already
written is skipped. The importer writes the scope tag with the rest (history New from Typeform never saw). Imported history
starts no workflow and no New lead, unless `"newLead": true` / `--new-lead` (D123): then each newly imported response the webhook
never saw is dispatched as `form.submitted` exactly as the webhook dispatches one, so New from Typeform runs for it (in its own
mode) and New lead starts once a person.

## Ghost mode (how a client gets migrated)

Ghost posts to Slack ARE posted, with a "🧪 ghost —" prefix, when Slack is connected (D31): the team is not
the CRM or the contact, and seeing the posts is the point of the run. The send is recorded as `ghost`.

Every company climbs a ladder (D52, D132): **ghost** → **test** → **quiet** → **live**, the control at the top of its page.
Ghost (called shadow before D132; the old name is refused with the new one named) is below: everyone runs, nothing is
written or sent, the record says what would have happened (which card, which stage, which tag). **Test** is the dress rehearsal: the team's own test contacts, tagged
`sys-test` in the CRM or with an email on a test domain (`test.domains`, set at install as `testDomains`),
get everything for real: CRM writes, emails, texts (when SMS is on). Everyone else runs as in ghost, nothing
written or sent: their runs start and go all the way through, every write and send recorded as would-have, so
the team still sees what the engine would do for real leads. Posts to Slack before live carry a 🧪 *mode*
prefix (🧪 *ghost* for a run held as ghost in test). **Quiet** runs the CRM side for everyone: tags, cards, fields,
records, notes and tasks are written for real, but nothing reaches a contact (a text, an email, an agreement or an outbound
webhook is held back, recorded as `quiet` in `sends`). Test contacts still get everything. **Slack before live (D133):** with
a test channel set (`test.slack_channel`, Settings, or `testSlackChannel` at install) every post from a run that is not live
goes there instead of where its step points, saying where it was for ("For #deals:", "Would have sent to <name>:"). Each step
keeps its live channel, so going live (the company, or one workflow) is the only switch. Without one, a pre-live post goes to
its own channel marked 🧪 (D31) and a DM to the ops channel (D76). Moving up into quiet, like into live, passes the readiness gate and clears the runs born on a lower rung
(their first steps never wrote, so nothing resumes halfway); moving down is just the flag. Live is then taken in sections with the workflows' own switches: the simple ones first,
then the ones that only note things, then one system at a time.

**Live per workflow (D92).** A workflow can stand on its own rung: the mode control on its page (company · ghost · test ·
quiet · live) or the admin route below. Unset, it follows the company. A run goes by its workflow's mode when set, else the
company's, for everything that decides real, quiet or ghost: CRM writes, sends, the 🧪 label, DMs held back until live, runs
with no contact. So a company in test can put New lead live for everyone while the rest stays in test, which is how a
client is switched from its old GHL workflows one pair at a time. Going live on one workflow passes the company's gate
narrowed to it (its definition runs, its settings are bound, Slack is connected if it posts) and clears that workflow's
runs not born live; the company's own Go live clears only the runs of workflows that will be live. Install and template
upgrades never touch a workflow's mode. The workflow list and page say whose mode it is: "Live (this workflow)", "Test (company)".

Every company is in **ghost** until someone presses **Go live**. In ghost the engine polls,
dispatches, runs and branches exactly as live, renders every message, and writes nothing to GHL:
sends are recorded as "would send" with the exact text, tags and notes are logged, appointment
updates are logged. A read-only Private Integration Token is enough. Verified on a real
location with all nine workflows on: zero messages, zero tags reached GHL.

So: install with a read-only token → let it run → read `/c/<slug>/sends` ("Would have sent") →
fix copy or timing → **Go live** on the company page, then turn workflows on one at a time.
Go live is refused while readiness has a blocker (the response lists them), and it clears every
run born in ghost with its steps, would-sends and events: ghost was rehearsal, none of it is
history (D51). Each run carries `born_in`; back to ghost is only the flag.

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
on the same outline with every step colored, with **Retry this step / Skip this step** when it paused (the company and
workflow pages count those as "needs a hand") · `/c/<slug>/appointments` last 7 and next 14 days, flags calls needing a
disposition · `/c/<slug>/appointments/<id>` the **disposition form** (did they show, how it
went, notes) · `/c/<slug>/contacts/<id>` the journey · `/c/<slug>/sends` every message sent, suppressed, failed, or (in ghost) would-have-sent · **Go live / Switch to ghost** on the company page.

## Bring-up from a session that has the secrets

The Claude Code environment holds `SUPABASE_DB_URL`, `GHL_PRIVATE_TOKEN`, `GHL_LOCATION_ID` (plus
`BINDINGS_KEY`). From a fresh session:

```bash
cd platform && pnpm install
pnpm bootstrap --name "J. Tyler Ray" --slug jtr --tz America/Phoenix \
  --calendar GLWzPNAZPoxkROdFJbPH=closing --calendar RzQgbmwwCIJeHv8YLXO8=closing --calendar kbEwrOhdlzxAHIpNLqF7=first_call
```

Migrates the Supabase database, installs the location in ghost with SMS off and every workflow
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
  [--booking <id>] [--no-sms] [--enable] [--live]   # booking link; no number; turn workflows on; live instead of ghost
  [--scope-tag dating]                              # D117: the location is shared; only these contacts (and the calendars' bookers) are the company's
# appointments in Calendly instead of GHL calendars (ids are event type uuids; :self / :setter stamps every booking):
#   --calendly-token <read token> --calendly-user james@company.com --calendar <uuid>=closing:self --calendar <uuid>=closing:setter
pnpm tick                       # every company's tick in turn, then the engine's minute (what /api/tick with no parameters does)
# Workflows install OFF. Add --enable to the install command (or flip `workflows.enabled`) when you mean it.
# Re-running install upgrades untouched template copies; --pit may be omitted then (the stored token is kept).
pnpm test
```

## Deploy (Vercel)

Project `backend-in-a-box` exists in team `jtylerray` (root directory `platform`). The route
`/api/tick` checks `Authorization: Bearer $CRON_SECRET` (or `$CRON_SECRET_PREVIOUS` while the key is
being changed, below).

**Each client ticks on its own (D98).** Every minute the database scheduler fires, all at once, one
request per active company and one for the engine:

- `GET /api/tick?company=<id>`: that company's minute. Poll it, start what its clock says is due, run its
  due runs, collect and announce its alerts. It holds its own 6-minute lease in `engine_state`
  (`tick_lock:<id>`): a tick that arrives while the company's previous one is still running answers
  `200 { busy: true }` and does nothing, so two pollers never work one company, while other companies tick
  beside it. It records `engine_state` `scheduler:<id>`: `last_tick`, `ms`, where the time went
  (`poll_ms` per entity — `setup`, `contacts`, `appointments:<calendar>`, `conversations`, `calls`,
  `agreements`, `cards` — then `schedules_ms`, `runs_ms`, `alerts_ms`), `claimed`, `completed`, `failed`,
  the first `errors` and `recovery`. A gap of more than ten minutes in a company's own ticks puts its runs
  in recovery (D5b); a slow client is slow alone.
- `GET /api/tick?scope=engine`: the engine's own minute, under `tick_lock:engine`. The heartbeat
  (`scheduler.last_tick`, what `/api/health` and the in-database watchdog read), the engine's own alerts
  (the recovery notice; a company whose last own tick is more than five minutes old gets
  `engine:company_stale`, which resolves once it ticks again; both go to `OPERATOR_WEBHOOK_URL`), and
  retention.
- `GET /api/tick` with no parameters (the daily `?mode=sweep`, a hand call, `pnpm tick`, a scheduler
  installed before D98): every active company in turn through the same per-company tick (a busy one is
  skipped and listed in `busy`), then the engine's minute.

A tick killed mid-flight frees its lease by expiry. The first tick after installing a company is the
baseline and can take a few minutes for a large location; only that company waits for it.

Scheduler install (once per database, idempotent — re-running replaces the job):

```
curl -X POST -H "Authorization: Bearer $CRON_SECRET" https://backend-in-a-box.vercel.app/api/admin/schedule
curl -H "Authorization: Bearer $CRON_SECRET" https://backend-in-a-box.vercel.app/api/admin/schedule   # status + last 5 runs/responses
```

The job (`bb-tick`) is one statement: `select net.http_get(url := '<origin>/api/tick?' || t.q, headers :=
<bearer>, timeout_milliseconds := 310000) from (select 'scope=engine' as q union all select 'company=' ||
id from companies where status in ('active','hosted')) t`. The company list is read every minute, so a
client added later ticks the next minute with no reinstall. A job installed before D98 (one call with
no parameters) keeps working: it ticks everyone in turn, as before, until it is reinstalled.

`/api/health` reports `last_tick` (the engine's minute), `companies_stale` (each active company whose own
last tick is more than five minutes old, with the minutes) and `ticks` (each company's last tick, `ms`
and where it went). `?assert=fresh` answers 503 when either the engine or any active company is stale.

### Changing the operator key without a pause

`CRON_SECRET` opens the tick and every admin route, and the database scheduler sends it every minute.
While `CRON_SECRET_PREVIOUS` is set, that value is accepted too (constant-time compare), so the key
changes with no missed minute:

1. In Vercel set `CRON_SECRET_PREVIOUS` = the current value and `CRON_SECRET` = the new one. Redeploy.
   Both keys are accepted now; the database scheduler still sends the old one, which works.
2. `POST /api/admin/schedule` with the **new** key. It reinstalls the scheduler with the new key (and the
   watchdog, when an alert URL is set).
3. Check: `GET /api/admin/schedule` with the new key (the job is there, recent runs `succeeded`) and
   `/api/health` (`last_tick` and every company's tick under a minute or two old, `companies_stale` empty).
4. Remove `CRON_SECRET_PREVIOUS` in Vercel. Redeploy. The old key opens nothing from here on.

Dashboard sessions are signed with `SESSION_SECRET`, or with `CRON_SECRET` when it is not set; without
`SESSION_SECRET` the change signs everyone out of the dashboard once (sign in again). Set
`SESSION_SECRET` first to avoid that.

**Scheduling depends on the Vercel plan.** The team is on Hobby today, which allows daily crons only
— a deploy with `* * * * *` is rejected outright (`cron_jobs_limits_reached`). So:

| Plan | Minute scheduler | `vercel.json` cron |
|---|---|---|
| Hobby (now) | **pg_cron inside Supabase** every minute → `/api/tick?company=<id>` per active company plus `?scope=engine` (D98; installed once with `POST /api/admin/schedule`; `GET` shows the last runs; `DELETE` removes it). `.github/workflows/tick.yml` stays as a backup and is harmless when it fires. | daily `0 9 * * *` = the reconciliation sweep |
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

- Email bodies in `sends.rendered_body` are stored (they're ours); a GHL reply, text or email, stores
  only that it came in (D89). An email reply's body is not read back either (its subject is), as before.
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
