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
while one is unset, a channel with a fallback, a picklist option). How each v1 step is written in it is in
`docs/v1-to-v2-steps.md`.

The engine (`src/engine/`), with no connectors yet (its ports have fakes only):
- **tables** (`src/db/schema.ts`, migrations `0001`, `0002`): offers, workflows and their immutable versions, settings,
  content, connections, operator addresses; the append-only fact log (`events`); runs, run steps, the outbox, Slack
  posts and alerts. The database refuses an outbox row without the run and the step that asked for it.
- **the interpreter** (`interpreter.ts`): walks a run through its pinned version. Triggers and re-entry, the premise on
  every wake and before every step that reaches outside, every primitive, waits stored as data, listeners and `$resume`,
  recheck loops, pauses for a person. A step's effect is only an outbox row in the run's transaction.
- **the delivery gate** (`gate.ts`): delivery state (sandbox / live), CRM writes (dry / real), DND, the send window, the
  frequency cap and circuit breaker, the blank-variable hold, in that order, each decision kept on the row.
- **the dispatcher** (`dispatcher.ts`): claims a due row, reads the contact, applies the gate, calls the port with the
  row's idempotency key outside any transaction, records the result. Unknown is never re-sent.
- **the job runner** (`jobs.ts`, ADR 0008): graphile-worker; `Engine.runDue()` does everything due now for tests.
- **until the projections exist**: a `facts.lookup` query other than `last_event`, and a report definition, are answered by
  a resolver the caller gives (`EngineOptions.lookup`, `reports`; the simulator answers from each scenario's fixtures),
  and a schedule `for` a role runs once per person the caller names (`fireSchedule({ person })`).

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
role), `fixtures` (what is not built yet answers: `facts.lookup` queries that need the projections, rendered report
definitions, the AI port's classify and summarize answers, each one answer or a list used in turn), `steps` (each `at`
an ISO time or an offset such as `+2d3h`: a fact `{ type, contact, appointment, payload }`, a `reply`, an `answer` to a
question by node or tag, a `fail` queued on a port, an `operator` resume or end, a `schedule` trigger reached), an
optional `until`, and `expect` (the content keys sent, held and suppressed, every outbox row in order as
`"<time> <status> <key>"`, and how each run ended). Files starting with `_` are notes about the folder.

An offer's own workflows live in `offers/<offer>/`: `workflows/<id>.json`, `content.json`, `reports.json` (report
definitions by key), `settings.required.json` (what each setting is and what the old system had, never a secret's value),
`scenarios/<workflow>/` and `REVIEW.md`. `src/offers/offers.test.ts` checks every offer there: each workflow validates, the
offer has every content key, report and setting it reads, every word parses, every scenario replays with exactly the
timeline it states, and together the scenarios take every edge (an edge no run can take is listed in the folder's
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
