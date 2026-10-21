# Rebuild plan (2026-10-21)

Tyler, 2026-10-21: rebuild **everything, from scratch**: "I want to build this to be incredibly robust, easy to build on and
update." The live offers **stay on the current system and move one at a time** once the rebuild has proven it does what they
do. "Every action the engine takes (bar the Slack app) should be taken through a workflow ... so anything that we do can be
adjusted at any time per client." First sales process: **setter + closer**.

This is a plan only. Nothing here is built until Tyler approves it and the rebuild branch exists.

**What it builds on:**
- **The blueprint:** "Backend in a Box: Audit and Rebuild Blueprint" (claude.ai/artifact/MP4tBRF9c59ofKw7mGPQB8, 2026-10-20).
  It holds the design: the data model, about 10 primitives, ports, one delivery gate, the outbox, the change pipeline, and the
  strangler migration. This plan does not repeat that design. It turns it into phases with gates and adds what was decided
  since.
- **The GHL Marketplace App Spec** and **the Platform Slack App Spec** (both 2026-10-21): the two connectors with the most
  design behind them.
- **The behavior spec and golden traces** of every live offer: `spec/<offer>/`, generated from production on 2026-10-21.
  These are blueprint migration steps 1 and 2, done.
- **`engine/14-modular-playbooks.md`:** what each offer runs today, every difference between offers, and the sales-process
  choices.

## 1. The rules the rebuild is held to

From the blueprint, plus what Tyler added since:

1. **Every action is a workflow step.**
   - The engine core only records facts (events) and runs workflows.
   - Every outbound effect is a row in the outbox: a text, an email, a CRM write, a Slack post, a calendar cancel, an
     agreement, an outbound webhook.
   - Every outbox row carries the run and step that asked for it. An effect without one is refused by the database (a
     constraint, not a convention).
   - The only behavior written in code is the platform itself: the Slack app's behavior (buttons, modals, commands, alert
     repeats), the primitives, the connectors and the delivery gate.
   - Today's hidden actions each become a visible step in a workflow, for example:
     - D196: cancelling the Calendly booking inside a cancel step;
     - D188: marking a contact DND when GHL refuses a text;
     - the opportunity a payment opens;
     - the other effects found in the Phase 1 inventory.
2. **Zero offer-specific code.** A CI check fails the build if code holds an offer's name, a vendor id or a client's words.
3. **No silent defaults.** A required setting with no value blocks going live. It is never filled from code.
4. **An offer owns its workflows.** Each workflow is complete and self-contained.
   - A template is a starting point, copied in full when a workflow is created.
   - A template change reaches an offer only as an explicit, diffed, simulated edit to that one workflow.
   - Step semantics are versioned (`wait@1`, `wait@2`), so an engine change cannot alter a live workflow.
5. **One offer, one workflow, per change.** The change API refuses a list. A change across all offers is a separately named
   operation, run offer by offer with a dry run each (CLAUDE.md, carried over).
6. **Slack works the same on every offer.** How Slack behaves is platform code. Where an offer posts and what it says is that
   offer's config.
7. **Facts are append-only. No vendor call runs inside a transaction.** Every vendor sits behind a port.
8. **Comments describe behavior.** Decisions go in short ADRs, not D-numbers in code.

**How sales-process templates fit rule 4.**
- A sales process (setter + closer, one board, application + triage, webinar, and so on) is a **preset**: a set of choices.
- Each choice is a **module** that contributes workflows and steps to a new offer's starting set.
- The modules are used once, when an offer's workflows are created. After that, the offer owns the result.
- This replaces engine/14's composer, which rebuilt copies from the templates on every build. Engine 14's analysis (what each
  offer runs, what each choice needs) is still the input.

## 2. What carries over, and what does not

**Carries over as ideas, rewritten in the new code:**
- Postgres as the queue, with leases.
- The idempotency row written before the vendor call, and "unknown is never re-sent".
- Runs pinned to a version.
- The premise re-check.
- Waits, windows and listeners stored as data.
- Failure classes with pause-by-vendor.
- Bindings that must be filled before going live.
- The send lock, which becomes the delivery state.
- Words kept apart from steps.
- The modes, split into two axes: delivery (sandbox / live) and CRM writes (dry / real).

**Does not carry over:**
- The current code. It stays as the reference for what the system does, and it keeps running the live offers until each one
  moves.
- The 1,230 tests. They protect the current code's shape. The rebuild has its own test tiers (section 5), whose job is to
  prove behavior. Two of the current files are mined for scenarios: `templates.scenarios.test.ts` and `step-failures.test.ts`.
- Copy-on-install, playbook copies rebuilt from templates, the GHL PIT polling backbone, pg_cron ticks, per-offer Slack apps,
  EAV text settings, and the six overlapping safety concepts.

## 3. Phases and their gates

Each phase ends at a gate Tyler signs off. Nothing in a later phase starts before the gate before it. The current system is
changed only for fixes Tyler names. It gets no new features (blueprint risk 1).

### Phase 0. Decisions and checks before any code
All the open choices, decided (section 6), plus the checks the specs list as "verify before building":
- **GHL, on a test sub-account:**
  - which scope gates the Appointment and Record webhooks;
  - whether dialer calls arrive as Inbound/OutboundMessage of type call;
  - whether every installed location gets the documented payload shapes;
  - the agency count for Hair, PMU and Dating against the 5-agency cap of a private app.
- **Slack:** which workspace owns the platform app.
- **HubSpot:** current webhook support on private apps. Needed only when a HubSpot offer exists.

**Gate:** every decision recorded as an ADR, and every check answered with evidence.

### Phase 1. The spec, signed per offer: "what's going on with each"
For Hair, PMU and Dating, one at a time:
1. Walk the offer's spec (`spec/<offer>/`) with Tyler, workflow by workflow.
2. Settle each finding in engine/14 §3.2. Each one is either kept as it is, marked as a change the rebuild makes, or dropped.
   Examples:
   - PMU's welcome email that is Hair's words;
   - PMU's Follow-up calendar starting Call booked;
   - Dating's possible second setter card;
   - the workflows missing a call-type condition.
3. Record what the offer's playbook is and what its settings mean, in the offer's spec rather than in the old database. This
   is Tyler's answer 3 of 2026-10-21: "PMU, Dating, and Hair all of the above, we'll see what's going on." No old-system
   database write is needed for the rebuild.

The same phase produces the **engine-action inventory**: every place today's code sends, posts, writes to the CRM or calls a
vendor. Each entry is marked as either "is a workflow step" or "becomes a workflow step" (rule 1).

**Gate:** Tyler signs off each offer's spec and the inventory. Anything he does not want is marked as a change, never copied.

### Phase 2. The scenario corpus
The golden traces cover only the paths production has taken:
- PMU: 10 workflows have runs (68 runs, 19 ways a run ended);
- Hair: 16 workflows (52 runs, 20 ways);
- Dating: 16 workflows (50 runs, 20 ways).

Every workflow that is off has no runs at all. So:
- Every branch of every workflow gets a **scenario**: a list of events in, and the exact actions expected out. Each scenario
  is written from the signed spec, and checked against a trace where one exists.
- The scenarios are written in a format the new simulator reads. They become each workflow's permanent test suite.

**Gate:** every branch of every live workflow has at least one scenario, and each one traces back to a spec line.

### Phase 3. The core, with no connectors
- The definition format: YAML/JSON and its schema, with versioned primitives.
- The interpreter, with the ~10 primitives.
- The fact log, the config store (typed settings, field maps, content), and runs.
- The outbox and the delivery gate.
- The simulator: a fake clock and fake ports.
- The job runner: graphile-worker or pg-boss on the always-on Railway worker.

**Gate:** every Phase 2 scenario replays in the simulator with zero unexplained differences.

### Phase 4. Connectors, each behind its port, each with a contract suite
In this order:
1. the Slack platform app (its own spec);
2. GHL through the Marketplace app (its own spec), with the PIT-plus-polling mode behind the same port for offers past the
   agency cap;
3. Whop, Fathom, Calendly and Typeform;
4. the generic signed door (it retires the shared-secret Zapier doors);
5. Jev (classification) and Anthropic (notes, editor, bot).

**Gate:** each connector passes its port's shared contract suite against a sandbox account.

### Phase 5. The sales-process library
- Modules for each choice, and presets made of them.
- **First: setter + closer** (Tyler, 2026-10-21). That is Hair's process today, built from Hair's signed spec plus the shared
  lessons engine/14 found in PMU's and Dating's copies:
  - the reschedule fork;
  - the D193/D194/D199 timing rules;
  - the no-link alert;
  - the deal value on the won card;
  - call-type conditions on every post-call workflow.
- Then **one board** (PMU), then **application + triage** (Dating).
- The values engine/14 §2 marks missing are each their own module later, when Tyler asks for them: closer only, webinar, DM
  setting, financing, trial, without agreement, outbound.

**Gate:** each preset creates a test offer whose scenarios all pass, and its words are all placeholders or approved.

### Phase 6. The operator surface
- The workflow page as the blueprint describes it: chart plus step list, every step visible, settings shown in place, gate
  badges, live overlay, history.
- The one change pipeline (describe, propose, validate, simulate, approve), exposed as an MCP server, so chat and the UI share
  it.
- The fleet view.
- Onboarding as OAuth installs plus config: pick the preset, fill the settings, approve the words.

**Gate:** Tyler builds a test offer from the setter + closer preset and changes one workflow, end to end, through the UI and
through chat.

### Phase 7. Move each offer's config
A script reads one offer's bindings, calendars, people and workflows from the old database. It writes that offer's typed
settings, field maps, content and workflows in the new system, as the signed spec says. Anything in old code that was Hair's
default is written onto Hair only, and onto nothing else.

**Gate:** a config diff report per offer that Tyler reviews.

### Phase 8. Shadow run, per offer
The new system takes the offer's live inputs with delivery set to sandbox and CRM writes set to dry. It posts what it would
have done next to what the old system did. Differences are reviewed daily.

**Gate:** a full business week with no unexplained difference for that offer.

### Phase 9. Cutover, one workflow on one offer at a time
- Tyler names each one.
- Order: read-only first (wrap-ups, leaderboard, EOD), then alerts, then contact-facing sequences last.
- In-flight runs finish on the old engine. Triggers after the cutover time start on the new one, so no contact is in both.
- An offer's old engine retires once all of its workflows have moved and its last runs have finished. Its old data stays
  readable for 90 days.

**Gate per workflow:** Tyler names it. Sends start in sandbox, as now.

## 4. Where the code lives

**Recommendation:** the same repository, a new top-level folder `v2/` on a long-lived branch `rebuild` cut from `main`.
- The old `platform/` is never edited from that branch.
- `spec/` and the traces sit beside the new code, so its tests can read them directly.
- The new system has **its own database** (blueprint: never shared with another app or with production previews) and its own
  deploy.

The alternative, a new repository, separates history cleanly but puts the spec and the old code one hop away. Tyler decides
(section 6).

## 5. How the rebuild is tested (what replaces the 1,230 tests)

| Tier | What it proves | Where it comes from |
| --- | --- | --- |
| Primitive tests | each primitive's semantics at each version (`wait@1`) | written with the core |
| Gate suite | every outbound effect passes every check, in order: delivery state, CRM dry/real, DND/opt-out, window, caps, blank-variable hold | one suite, one function |
| Port contract suites | every adapter behaves the same behind its port (idempotent upsert, field round-trip, merges, rate limits, vendor quirks) | one suite per port, run against each provider's sandbox |
| Workflow scenarios | every branch of every workflow does what its signed spec says | Phase 2, then grows with every edit |
| Behavior-diff check in CI | no code change alters any live workflow version's behavior unless that change is declared and approved | replays every live version's scenarios before and after; replaces hand-frozen fixtures |
| Golden-trace replay | the new engine does what the old one did on real history | `spec/<offer>/traces/` |
| A few end-to-end runs | the deployed system works against sandbox accounts | per connector |

## 6. Decided (Tyler, 2026-10-21)

1. **Where the code lives:** `v2/` in this repository, on new branches. Not a new repo.
2. **Hosting, one subscription: Railway.** It runs:
   - the app (Next.js: API and dashboard);
   - the always-on worker;
   - Postgres.

   No Vercel and no Supabase for v2. The old system stays where it is until each offer moves. Why not the free tiers: an
   always-on worker keeps the database awake, and Neon Free's 100 compute-hours a month runs out mid-month. Supabase's free
   projects are used up, and its preview branches are paid. Vercel Hobby is non-commercial only.
3. **No every-minute poll.**
   - Vendors push: webhooks from GHL (Marketplace app), Whop, Fathom, Typeform and Slack.
   - Timers are jobs with an exact run time on the worker.
   - A nightly reconcile catches anything a webhook missed.
   - Polling stays only where a vendor cannot push, inside its connector:
     - GHL agreements still waiting for a signature (every 2 minutes, until signed or 30 days);
     - call transcripts (with back-off);
     - Calendly on a plan without webhooks;
     - a GHL offer past the 5-agency cap (PIT mode, until the Security Review passes).
4. **App framework:** Next.js and React (Tyler knows them).
5. **Data access:** Drizzle plus Zod: tables written as TypeScript, and every setting and workflow checked against a schema.
6. **GHL agencies:** every client is in its own agency. Three of the private app's five installs are used by Hair, PMU and
   Dating, so the 6th client hits the cap. The Security Review is built for from the start: the scope rationale now, the demo
   video once the first offer runs on the app (GHL spec).
7. **Slack and GHL app owner:** Tyler.
8. **Slash commands:** simple names, no prefix (`/mtd`, `/cash`). With one platform app, offers no longer collide with each
   other. The only remaining risk is another app in a client's workspace using the same name.

Still open for Phase 0: the GHL test-sub-account checks (Phase 0 above) and HubSpot (only when a HubSpot offer exists).

## 7. Not in this plan

- New features on the old system. Only fixes Tyler names.
- Any change to a live offer before its Phase 9 cutover, apart from those fixes.
- The missing sales-process values beyond the first three presets, until Tyler asks for each one.
- Timelines. Each phase ends at its gate, not on a date.
