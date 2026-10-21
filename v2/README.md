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
| `POST /in/ghl` | Takes every GHL webhook. It checks GHL's Ed25519 signature, stores the delivery raw in `inbox` once (a retry is the same row), and answers 200. A bad signature gets 401 and is kept nowhere. |
| `GET /ghl/oauth/callback` | Where GHL sends the installer. It exchanges the code for the location's tokens and stores them sealed in `ghl_connections`, marked for Tyler to link to an offer. |
| `GET /health` | Answers when the app is up. |

The workflow definition format (`src/workflow/`): the ten versioned primitives, the action registry, conditions, the
template renderer with blank detection (lists laid out per item with `each`, a blank found per item), and
`validateWorkflow`, which lists the settings a workflow requires and those it can do without (a step that skips itself
while one is unset, a channel with a fallback, a picklist option), and the facts it reads that rest on a rule (whose
settings it then requires). How each v1 step is written in it is in
`docs/v1-to-v2-steps.md`.

The engine (`src/engine/`), with no connectors yet (its ports have fakes only):
- **tables** (`src/db/schema.ts`, migrations `0001` to `0003`): offers, workflows and their immutable versions, settings,
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
- **what only a vendor answers** (`reads.ts`): a call's transcript, the CRM's Sales Calls still blank, the reports a
  vendor answers (calendar availability, the health probes). A caller passes them until the connectors exist.

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
1. **New project, then Deploy from GitHub repo.** Pick this repository and the branch `rebuild`. In the service's settings, set
   **Root Directory** to `v2`. `railway.json` holds the build and start commands; the start command runs the migrations first.
2. **Add a database.** In the same project, click New, then Database, then PostgreSQL.
3. **Set the service's variables:**
   - `DATABASE_URL`: `${{Postgres.DATABASE_URL}}`, Railway's reference to the database.
   - `TOKEN_KEY`: 32 random bytes as base64, for example the output of `openssl rand -base64 32`. Keep it only here.
   - `GHL_WEBHOOK_PUBLIC_KEY`: GHL's webhook public key, the PEM text from GHL's webhook authentication docs.
   - `GHL_CLIENT_ID` and `GHL_CLIENT_SECRET`: from the GHL app once it exists.
   - `GHL_REDIRECT_URI`: `https://<the service's Railway domain>/ghl/oauth/callback`.
4. **Generate a domain** under the service's Networking settings. Then check that `https://<domain>/health` answers
   `{"ok":true}`.

The GHL app takes two URLs:
- redirect URL: `https://<domain>/ghl/oauth/callback`
- webhook URL: `https://<domain>/in/ghl`

## Develop
`pnpm install`, then:
- `pnpm test` (with `DATABASE_URL` pointing at an empty Postgres, the engine's tests run on Postgres as well as in memory);
- `pnpm typecheck`;
- `pnpm db:generate` after a change to `src/db/schema.ts`. That writes the next numbered migration into `drizzle/`.
