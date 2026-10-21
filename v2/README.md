# Backend in a Box v2

The rebuild, from scratch, next to the system it replaces. The plan is `../engine/15-rebuild-plan.md`. The design is the
blueprint (claude.ai/artifact/MP4tBRF9c59ofKw7mGPQB8), plus the GHL Marketplace App Spec and the Platform Slack App Spec.

- **The old system** (`../platform/`) keeps running the live offers. It is never edited from the rebuild branches.
- **What the new system must do** is in `../spec/<offer>/`: each offer's workflows, step by step, with real runs as traces.
- **Decisions** are short records in `docs/adr/`, one per decision. Code comments describe behavior, not decision numbers.

Current phase: **0, decisions and checks** (`docs/phase-0.md`).

## What is here now
The GHL recorder, for the Phase 0 checks. It becomes v2's GHL door later.

| Route | What it does |
| --- | --- |
| `POST /in/ghl` | Takes every GHL webhook. It checks GHL's Ed25519 signature, stores the delivery raw in `inbox` once (a retry is the same row), answers 200 and queues the GHL normalizer. A bad signature gets 401 and is kept nowhere. |
| `POST /in/whop/{connection}`, `/in/fathom/{connection}`, `/in/typeform/{connection}`, `/in/calendly/{connection}` | A vendor's webhook for one offer's connection: its signature checked with that connection's secret, kept once in `inbox`, answered 200, read by the vendor's normalizer as a job. An unknown connection is 404. |
| `POST /in/{connection}` | The generic signed door (Zapier, Make, any tool): Standard Webhooks with the connection's own secret, and a field map as the connection's config. |
| `GET /ghl/oauth/callback` | Where GHL sends the installer. It exchanges the code for the location's tokens and stores them sealed in `ghl_connections`, marked for Tyler to link to an offer; a reinstall reconnects the offers already on that location. |
| `GET /health` | Answers when the app is up. |
| `GET /slack/install?offer=…` | The Connect Slack link (signed, single use, one hour): on to Slack's "Add to Slack" page. |
| `GET /slack/oauth/callback` | Where Slack sends the installer back: the state checked, the code exchanged, the workspace kept with its bot token sealed (reused for a second offer), the offer linked. |
| `POST /slack/events`, `/slack/interactions`, `/slack/commands`, `/slack/options` | The platform Slack app's doors. Each request is checked with Slack's v0 signature and five-minute window, kept once in `inbox`, acked at once and worked as a job; a retry Slack marks is acked and dropped. `/slack/options` answers the contact search at once. |

The workflow definition format (`src/workflow/`): the ten versioned primitives, the action registry, conditions, the
template renderer with blank detection (lists laid out per item with `each`, a blank found per item), and
`validateWorkflow`, which lists the settings a workflow requires and those it can do without (a step that skips itself
while one is unset, a channel with a fallback, a picklist option), and the facts it reads that rest on a rule (whose
settings it then requires). How each v1 step is written in it is in
`docs/v1-to-v2-steps.md`.

The engine (`src/engine/`), its ports served by the connectors (below) or, in tests and the simulator, by fakes:
- **tables** (`src/db/schema.ts`, migrations `0001` to `0003`; `0005` for the connectors): offers, workflows and their immutable versions, settings,
  content, report definitions, connections, operator addresses; the append-only fact log (`events`); the projections;
  runs, run steps, the outbox, Slack posts, alerts and schedule timers. The database refuses an outbox row without the
  run and the step that asked for it.
- **the interpreter** (`interpreter.ts`): walks a run through its pinned version. Triggers and re-entry, the premise on
  every wake and before every step that reaches outside, every primitive, waits stored as data, listeners and `$resume`,
  recheck loops, pauses for a person. A step's effect is only an outbox row in the run's transaction.
- **the delivery gate** (`gate.ts`): delivery state (sandbox / live), CRM writes (dry / real), DND, the send window, the
  frequency cap and circuit breaker, the blank-variable hold, in that order, each decision kept on the row.
- **the dispatcher** (`dispatcher.ts`): claims a due row, reads the contact, applies the gate, calls the port with the
  row's idempotency key outside any transaction, records the result. Unknown is never re-sent. A CRM write that went
  through is kept as a fact (`crm.record_written`, `crm.deal_written`, `crm.deal_status_set`), so the record keys and
  cards a run reads are history, not a copy of the CRM.
- **the job runner** (`jobs.ts`, ADR 0008): graphile-worker; `Engine.runDue()` does everything due now for tests.
- **schedules** (`schedule.ts`): each enabled workflow's schedule trigger has a timer (a job at its next time). When it
  comes the trigger fires for that period once per subject (the offer, or each active person with the role, from the
  people projection) and sets the next time. A late job runs its period once; a period missed entirely is not made up.
- **what only a vendor answers** (`reads.ts`): a call's transcript (from the recorder's connector, `connectorReads`), the
  CRM's Sales Calls still blank, the reports a vendor answers (calendar availability, the health probes); a caller passes
  the last two.

The projections (`src/projections/`): `contacts_index` (CRM id, normalized phones and emails, merged-into, the CRM's
last-said attributes, the records we wrote, the agreement), `appointments`, `calls` (the single call fact: a booking, a
dialer call or a meeting recording; held, outcome, rep, recording, kind), `deals` (the ledger's and the CRM cards we
moved), `payments`, `people` (the team and their roles, from `person.*` facts) and `daily_facts` (counts and sums per
local day, by closer, setter and source). They are written only by the projectors, pure functions from a fact (and the
rows it touches) to row changes, in the same transaction as the fact (`recordFact`); `rebuildProjections(store, offer)`
drops them and runs the log through again, with the same result. A run reads its subjects from them (`derived.ts`),
with the facts v1 worked out: every one that rests on a business rule (a payment's kind, a deposit, paid beyond a
deposit, cleared, the price, the closer, owner and setter, the Set window) reads the rule's parameters from typed
settings (`facts.ts`), never from code: while one is unset the fact is not there, and a workflow that reads it cannot be
enabled. `facts.lookup` is answered from them (`lookups.ts`, v1's queries).

Reports (`src/reports/`): metric definitions as data, a small query vocabulary over the projections (a table, the time
its period is on, filters on its own columns with values or settings, a count, sum, median or distinct, split by
closer, setter or source; a rate is two metrics divided); report definitions as data (a wrap-up's metrics, calls and
rates in the offer's own layout; the leaderboard; the end-of-day list). `report@1` renders one into a variable.

The platform Slack app (`src/slack/`, `slack-manifest.yml`, the design in `docs/slack-app-spec.md`, setting it up in
`docs/slack.md`): one app, installed per workspace by OAuth; each channel belongs to one offer.
- **tables** (migration `0004`): `slack_workspaces` (bot token and refresh token sealed), `slack_offer_links`,
  `slack_channels` (one offer per channel, the slots it fills; mapping one also sets the offer's `slack.channel.<slot>`),
  `person_identities` (a person's confirmed Slack user), `slack_messages` (every post with its offer, channel, ts, thread,
  workflow, run, step, tag, posting app, and the press that settled it), `slack_outbox` (what the app says that no run
  asked for), `slack_alert_state`, `platform_settings` (alert repeats and hours, the operator's channel, the bot's model),
  `slack_bot_usage`, `slack_audit`.
- **the port** (`port.ts`): the engine's Slack port for real, behind the outbox and the gate: platform layouts
  (`blocks.ts`: card, alert, report table, form summary), the content's persona, buttons with signed values, a sandbox
  post in the test channel saying so; a 429 waited out for its Retry-After, Slack's own trouble tried three times then
  alerted, a refused token pausing the offer's Slack (its posts wait), the bot token refreshed before it expires.
- **routing** (`routing.ts`): an event by its channel's offer, a DM by the person's offers (asked which when several), a
  press or a modal by the offer in its signed value or metadata, a slash command by the channel, else an offer named in
  its text, else the person's only offer, else a picker.
- **presses** (`interactions.ts`, `alerts.ts`, `agreement.ts`): Confirm / Cancel / Reschedule answer the waiting ask
  (`ask.answered`); Retry / Resolve / Pause on an alert; Link opens a contact search and records `payment.linked`; Send /
  Cancel under `/agreement` record `agreement.requested` for the offer's own workflow to take. Each acked, then the
  message edited to say who pressed what and when, its buttons gone; a stale press is told who handled it; who may
  press is their role on that offer (`people.ts`), and a refusal is private and recorded.
- **alerts** (`alerts.ts`): one open alert per offer and cause key; raised is a post in the offer's alerts channel (or the
  operator's), still open a thread reply every `alerts.repeat_minutes` inside `alerts.repeat_hours`, after its cause is
  checked again; resolved a reply and a ✅.
- **slash commands** (`commands.ts`): `/mtd /weekly /monthly /show-rate /close-rate /cash /leads /closes /leaderboard
  /availability /support /help` for the team, `/agreement` for an owner, a manager or the closer on the deal, `/team`
  for the operator; answered from the metric layer; which are on, and which metrics they read, is the offer's
  `slack.commands` setting.
- **the bot** (`bot.ts`, `query-views.ts`): a mention or a DM answered by a model (the AI port; a fake in tests) through
  read-only tools bound to the routed offer (metric, contact_journey, workflow_explain, open_alerts, query_views), with its
  working shown; a daily token budget per offer; no tool that could change config, unlock sends or reach a contact.

The connectors (`src/connectors/`, set up per vendor in `docs/connectors.md`; Tyler's GHL Marketplace App Spec copied in
`docs/ghl-app-spec.md`): each vendor behind its ports, outbound verbs and an inbound normalizer to canonical facts.
- **tables** (migration `0005`): `connections` (now one row per offer per port: provider, mode, vendor account, config,
  credentials sealed; connected / paused / needs_reinstall / uninstalled, the same row the dispatcher's gate reads),
  `field_maps` (canonical field to provider field id, per object, with the value's type), `connector_echoes` (what each
  write of ours is expected to change), `entity_versions` (the last state seen per vendor entity, and poll cursors),
  `agreement_checks`, `transcript_waits`; `inbox` gains the connection, the offer and what reading it came to.
- **the framework** (`framework/`): the HTTP layer and its retry policy (429 waited out, 5xx and timeouts tried again for a
  read, a write re-read and never re-sent blind, refusals classed), a per-location rate budget, the field map, the door
  signatures, the job queue, the inbox normalizer job, the transcript waits (1, 3, 10 minutes), a fake HTTP layer for tests.
- **GHL** (`ghl/`): the API client (Version per family, browser-like user agent, 100 per 10 s, 401 then one refresh then a
  pause) over two auth modes, OAuth (the Marketplace app; tokens renewed under the row lock when under 4 hours, refresh
  tokens single-use, a lost refresh is needs_reinstall) and a private token, behind the same ports; every v1 quirk fixed
  inside it with a test; the webhook normalizer (contacts, tags, DND, appointments, cards, messages, dialer calls, records,
  notes, users, installs) with echo tagging (`by: platform`: recorded and projected, but starting only a trigger that says
  `includeOwnWrites: true`) and stale dropping; the agreement check (10 s for an hour,
  then 5 min to 30 days, one request per location); the private-token poll, which records the same facts as the
  webhooks; the nightly reconcile (26 hours, `source: reconcile`, an alert past a handful missed).
- **Whop, Fathom** (a recording placed by v1's ladder: email, meeting link, exact name, the closer's calendar, its
  thresholds the offer's settings), **Typeform, Calendly** (webhook, or a free plan's poll by exception), **the generic signed door**, **Jev**
  (ai.classify) and **Anthropic** (ai.summarize, its model a setting).
- **contract suites** (`contract/`): one suite per port (crm, messaging, scheduling, esign, ai, payments-in, recording,
  forms) that every provider passes, on the fake HTTP layer with a stateful fake GHL (`testkit/`).
- **the worker** (`src/worker.ts`, `pnpm worker`): the engine's, the Slack app's and the connectors' jobs with real ports.

The offers (`offers/`): each offer's own workflows, words and scenarios. Hair's are translated from its live v1
workflows (`spec/hair/`), UNSIGNED drafts for Tyler's review (`offers/hair/REVIEW.md`).

The simulator (`src/sim/`): the same engine on a fake clock, fake ports and an in-memory store. It takes a version and
a scenario and gives the exact timeline; `diffBehavior` compares two versions over a set of scenarios. Scenarios are JSON
(`src/sim/scenario.ts`); the examples' are in `scenarios/examples/`. `pnpm sim <workflow.json> <scenario folder>` prints
the timelines.

A scenario folder holds `content.json` (the words by key; else the nearest one above it, an offer's own) and one file
per scenario: `name`, `workflow` (its id), `start`, `offer` (`zone`, `settings`), `delivery` and `crmWrites` (live and
real unless it says), `operator` addresses, `contacts` as the CRM holds them (phone, email, zone, DND), `priorSends`
(texts other workflows already sent, for the cap), `people` (the team, for schedules that run once per person with a
role, recorded as `person.added` facts), `history` (facts from before the start, recorded before any workflow is on:
payments, bookings, agreements, records written; the projections hold them), `fixtures` (only what a vendor answers:
the AI port's classify and summarize answers, the recorder's transcripts, the CRM's blank Sales Calls, the reports a
vendor answers; `lookups` and `reports` may stand in for a projection's answer, which the offers' own scenarios never
do), `steps` (each `at`
an ISO time or an offset such as `+2d3h`: a fact `{ type, contact, appointment, payload }`, a `reply`, an `answer` to a
question by node or tag, a `fail` queued on a port, an `operator` resume or end, a `schedule` trigger reached), an
optional `until`, and `expect` (the content keys sent, held and suppressed, every outbox row in order as
`"<time> <status> <key>"`, and how each run ended). Files starting with `_` are notes about the folder.

An offer's own workflows live in `offers/<offer>/`: `workflows/<id>.json`, `content.json`, `reports.json` (report
definitions by key, and the metrics they read under `metrics`), `settings.required.json` (what each setting is and what the old system had, never a secret's value),
`scenarios/<workflow>/` and `REVIEW.md`. `src/offers/offers.test.ts` checks every offer there: each workflow validates, the
offer has every content key, report and setting it reads (and the settings of every rule a fact it reads rests on),
every word parses, every report and metric definition validates, every scenario replays with exactly the timeline it
states (fixtures only for vendor reads), and together the scenarios take every edge (an edge no run can take is listed in the folder's
`_untakeable.json`, with why).

## Deploy on Railway (from the repo)
Two services from this repository, the app and the worker, and one Postgres. Railway reads one config file per service:
the app's is `railway.json` (Railway's default name), the worker's `railway.worker.json`.

1. **New project, then Deploy from GitHub repo.** Pick this repository and the branch `rebuild`. In the service's settings, set
   **Root Directory** to `v2`. This is the app: `railway.json` holds its build and start commands (`pnpm migrate && pnpm start`);
   the start command runs the migrations first.
2. **Add a database.** In the same project, click New, then Database, then PostgreSQL.
3. **Set the service's variables:**
   - `DATABASE_URL`: `${{Postgres.DATABASE_URL}}`, Railway's reference to the database.
   - `TOKEN_KEY`: 32 random bytes as base64, for example the output of `openssl rand -base64 32`. Keep it only here.
   - `GHL_WEBHOOK_PUBLIC_KEY`: GHL's webhook public key, the PEM text from GHL's webhook authentication docs.
   - `GHL_CLIENT_ID` and `GHL_CLIENT_SECRET`: from the GHL app once it exists.
   - `GHL_REDIRECT_URI`: `https://<the service's Railway domain>/ghl/oauth/callback`.
   - `BASE_URL`, `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, `SLACK_SIGNING_SECRET`, `SLACK_STATE_SECRET`: the Slack app's
     (see `docs/slack.md`).
4. **Generate a domain** under the service's Networking settings. Then check that `https://<domain>/health` answers
   `{"ok":true}`.
5. **Add the worker** (`src/worker.ts`: every timer, delivery, Slack job and connector job runs here; without it nothing
   that waits ever happens). In the same project, click New, then GitHub Repo, and pick this repository and `rebuild` again.
   In the new service's settings:
   - **Root Directory**: `v2`.
   - **Config file** (Settings, Config-as-code, "Railway Config File"): `/v2/railway.worker.json`. The path is from the
     repository's root, not the root directory. Without it Railway reads `railway.json` and starts a second app (and a
     start command typed in the dashboard does not help: what a config file says wins over the dashboard).
   - **Variables**: the same as the app's (step 3). The simplest is to reference them: `DATABASE_URL` as
     `${{Postgres.DATABASE_URL}}`, and each other one as `${{<app service name>.TOKEN_KEY}}` and so on.
   - No domain, and no healthcheck: the worker answers no HTTP.
   - Keep it at **one replica**: GHL's rate budget is per process (`docs/connectors.md`).

   The worker brings the schema up to date at its start, as the app's `pnpm migrate` does, both under one Postgres
   advisory lock (`src/db/migrator.ts`): when both services deploy at once, whichever comes second waits for the first,
   then finds nothing left to do, and the worker never runs against an older schema than its code.

The GHL app takes two URLs:
- redirect URL: `https://<domain>/ghl/oauth/callback`
- webhook URL: `https://<domain>/in/ghl`

## Develop
`pnpm install`, then:
- `pnpm test` (with `DATABASE_URL` pointing at an empty Postgres, the engine's tests run on Postgres as well as in memory);
- `pnpm typecheck`;
- `pnpm db:generate` after a change to `src/db/schema.ts`. That writes the next numbered migration into `drizzle/`.
