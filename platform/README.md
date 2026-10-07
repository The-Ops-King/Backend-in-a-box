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
contact's zone), `book-self`, `reschedule` (+2 days), `cancel`, `pay` (the program price), `record`
(a Fathom-shaped recording with a short transcript, through the match ladder), `reset` (the engine
forgets every run, send, card, pursuit and synthetic appointment for that person; the contact stays).
Synthetic appointments have `source = 'test'` and never exist at a booking source; the premise check
trusts our row for them. The closer on a staged booking is the calendar's host when known, else the
user bound as `crm.default_closer` (a GHL user id), else the first closer on the roster. Refused while the company is live (`force: true` on the API overrides).

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

Every company is in **shadow** until someone presses **Go live**. In shadow the engine polls,
dispatches, runs and branches exactly as live, renders every message, and writes nothing to GHL:
sends are recorded as "would send" with the exact text, tags and notes are logged, appointment
updates are logged. A read-only Private Integration Token is enough. Verified on a real
location with all nine workflows on: zero messages, zero tags reached GHL.

So: install with a read-only token → let it run → read `/c/<slug>/sends` ("Would have sent") →
fix copy or timing → **Go live** on the company page, then turn workflows on one at a time.

## Reading a flow chart

Every chart uses the same vocabulary, drawn by `src/engine/mermaid.ts` from the plain-English
descriptions in `src/engine/describe.ts` (the step list uses the same words, so the two never
disagree). Shape and fill say what a step *is*; the outline says what *happened* to it in a run.

| Shape | Fill | Meaning |
|---|---|---|
| pill | green | starts when (the trigger) |
| box | blue | a message goes out (text, email, Slack) |
| box | amber | a change in the CRM (tag, note, pipeline card, appointment) |
| diamond | grey | a decision (check, branch); a check's "if not" path is a dashed edge to its stop |
| double bar | dark | a wait (for a time, or for a reply) |
| box | violet | the AI reads something (a reply, a transcript) |
| double circle | dark | the run stops, with its reason |

Outline: green solid = ran, blue dashed = waiting here, red = failed, amber dotted = skipped or
stale, white = the current step. A legend sits under every chart.

## The dashboard

Read-only except one button. `/` engine health and companies · `/c/<slug>` workflows, poll
health, runs, latest events, contacts · `/c/<slug>/w/<id>` a workflow as a flow chart and step
list, bindings, versions, **Turn on / Turn off** · `/c/<slug>/r/<id>` a run on its chart with
every step colored · `/c/<slug>/appointments` last 7 and next 14 days, flags calls needing a
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
