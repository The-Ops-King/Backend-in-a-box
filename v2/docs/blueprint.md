# Backend in a Box: Audit and Rebuild Blueprint

Copied 2026-10-21 from Tyler's doc (claude.ai/artifact/MP4tBRF9c59ofKw7mGPQB8), dated 2026-10-20. The doc is the original; this copy is what v2 is built from. Tables are flattened as "cell | cell" rows.

## Summary
The engine's core is sound, but three early choices create most of the mess: copying every workflow onto every offer, welding GHL into the core, and polling everything from a database cron. I would rebuild around pinned template versions, vendor ports, webhooks plus an outbox, and one append-only fact log for reporting.
**What works and should carry over:** idempotent sends, runs pinned to a version, premise re-checks, waits stored as data, failure classes, bindings that must be filled before enabling, and the send lock.
**What I would change, in order of value:**
- 
**Outbox plus one delivery gate.** Every send, CRM write and Slack post passes one check: sandbox or live, DND, the send window, a per-contact cap (4 a day), and a hold on blank variables. Nothing calls a vendor inside a transaction. This removes the double-send and long-transaction bug classes.
- 
**Webhooks instead of polling.** A private GHL Marketplace app gives real webhooks. A nightly reconcile is the safety net, and a persistent worker replaces pg_cron ticks.
- 
**One Slack app for the whole platform,** installed by OAuth and routed by workspace. No more per-offer manifests.
- 
**Every workflow is the offer's own, and nothing is hidden.** Each offer's workflow is a complete, self-contained definition, and every step is visible in the UI. Templates are only starting points. A template change reaches an offer only as an explicit, diffed change to that one workflow. Step semantics are versioned, so engine changes can't silently alter a live offer.
- 
**One fact log for reporting.** The CRM stays the truth for current state. Our append-only events are the truth for history, and wrap-ups, EOD, the bot and the leaderboard all read one metric layer.
- 
**Ports for every vendor,** so HubSpot (not connected today) becomes an adapter plus a field map, not a rewrite.
- 
**About 10 primitives instead of 37 step types,** plus a text-based AI editor that proposes, simulates and shows the behavior diff before you approve. The UI and chat share one pipeline.
- 
**Built for 10 to 30 offers.** Onboarding becomes OAuth installs plus config, with no hand-pasted tokens or manifests, and there is one fleet view across every offer's workflows.
**Recommendation:** don't big-bang it. Tyler's call is spec first: write down every offer's workflow behavior and capture real traces (migration steps 1 and 2), then decide between changing in place and rebuilding. The full rebuild follows the strangler plan below, proven against recorded production behavior and cut over one workflow on one offer at a time.

## What it does today
The system is a per-offer sales-ops engine. It watches the CRM and the tools around it, runs every step of the lead-to-cash journey as data-defined workflows, and talks to the team through Slack. It runs 31 workflow templates across three live offers: Hair (setter and closer), PMU (one board, deposits) and Dating/Nelly (application, triage, close).
**Correction to the brief:** HubSpot is not connected. It appears only as a dropdown option in platform/src/onboarding/intake.ts:33 and as a plan in engine/12-tools.md. Today the CRM is GHL only, and GHL is wired into 8 tables, about 12 templates and every send.
 | 
Area | 
What it does | 
Where
 | 
Lead intake | 
New-lead setter card, speed-to-lead, Typeform applications, lead source and UTMs, MQL/DQ qualification | 
new-lead, speed-to-lead, typeform.ts, D73, D78, D122
 | 
Setting | 
Logs dialer calls, AI (Jev) reads the call, records setter result | 
setter-call-logged, D79, D87, D154
 | 
Booking | 
Slack booking card with intake and source, DND/no-phone warnings, reschedules, cancels, rebook nudges, Dating's triage then sales pair | 
call-booked, call-cancelled, cancellation-rebook, D104, D123, D188
 | 
Pre-call | 
Confirm-by-reply (AI classifies the reply), confirm/cancel/reschedule buttons in Slack, 24h and 1h reminders, evening and short-notice rules, missing meeting-link alert | 
pre-call-sequence, D13, D53, D186, D193 to D199
 | 
Call | 
Fathom recording matched by meeting link, AI call notes and rubric, show/no-show, outcome, manual card moves, no-show recovery, post-call follow-up | 
call-recorded, call-outcome, card-moved, no-show-recovery
 | 
Money and paper | 
Payments (Whop, Commas via Zapier), deposits, refunds as negative lines, plan vs paid-in-full, agreements sent and chased, deal closed welcome, failed payment alert, unlinked payment/recording with a Link button | 
payment-recorded, agreement-*, deal-closed, payment-failed, D49, D57, D119, D200.8, D202
 | 
Nurture | 
One-shot reactivation per 90 days | 
reactivation
 | 
End of day and reports | 
EOD form for closers and setters, reminders, daily/weekly/monthly wrap-ups, leaderboard | 
EOD templates, D34, D94, D96, D143, D207
 | 
Slack bot | 
/mtd, /close-rate, /cash, /availability, /team, /support, /agreement, free-text questions over read-only SQL | 
D64, D70, D152, D197, D202
 | 
Ops health | 
Health check, calendar availability, ledger drift vs CRM, operator alerts | 
health-check, ledger-drift, health.ts
 | 
Safety | 
Send lock to Tyler's own addresses, mode ladder ghost/test/quiet/live per workflow, dry runs, one offer at a time | 
D132, D145, D147, D151.5
 | 
Operator surface | 
Single-login dashboard (shows, toggles, retries, simulates); every change made through Claude in chat | 
D27, D32, D200.5
 | 
Onboarding | 
Wizard: offer, keys, Slack manifest, GHL data-layer build, messages, install OFF, test, go live per workflow | 
platform/src/onboarding, ghl/build-backend.sh, D170 to D183
**Not automated yet:** fulfilment handoff after the welcome message, client-facing dunning, commissions, round-robin assignment, an AI setter that converses and books, and a generic signed webhook intake (engine/11-journeys.md).

## How it is built today
The stack is a Next.js API on Vercel and a Vite React dashboard, with Supabase Postgres as both the database and the queue, ticked every minute by pg_cron. The repo holds about 46,600 lines of TypeScript and JSON, 129 test files, around 46 tables and 31 workflow templates, written over 122 commits.
 | 
Layer | 
How it works now
 | 
Hosting | 
Vercel serverless for the API and webhooks. The dashboard is a separate Vite build served under /app.
 | 
Heartbeat | 
pg_cron and pg_net inside Postgres call /api/tick per offer every minute, plus a 10 s documents job. Vercel cron runs only a daily sweep. Nothing external watches the tick.
 | 
Database | 
Supabase Postgres, raw SQL, no ORM. It is shared with other apps, and preview deploys share production. Migrations run at build time.
 | 
Workflow engine | 
A graph JSON definition with 37 step types, interpreted by executor.ts. Runs are pinned to a version, claimed with skip locked and 5-minute leases, and waits are stored as next_run_at.
 | 
Templates | 
30 JSON files. Install copies each one onto the offer as its own workflow, and playbooks generate further offer-specific copies.
 | 
Config | 
About 100 bindings keys per offer (EAV, text in bytea, secrets AES-GCM). There are 19 code fallbacks in setting-defaults.ts, install JSON files in the repo, and env vars.
 | 
CRM | 
GHL only, through one Private Integration Token per offer. It is polled, with no webhooks, and its contacts, cards and appointments are replicated locally. Metrics read some numbers live from GHL and others from the local ledger.
 | 
Sends | 
SMS, email and documents all go through GHL. An idempotency row is written before the vendor call.
 | 
Other vendors | 
Calendly (polled), Whop and Fathom (signed webhooks), Typeform (HMAC), Zapier doors (shared secret), Jev for classification, Anthropic for notes and the bot.
 | 
Slack | 
One Slack app per offer from a generated manifest that Tyler pastes by hand. It handles events, buttons, modals, 15 slash commands, and a Claude bot with read-only SQL.
 | 
Reporting | 
rollups_daily (3 dimensions, refreshed only when a wrap-up runs), a metric registry of hand-written SQL, wrap-up templates, the leaderboard, and the EOD form prefilled from the ledger.
 | 
Auth | 
One dashboard password, a bearer secret for admin and tick routes, a per-closer EOD token, and per-vendor signature checks. RLS exists but is bypassed in about 174 places.
 | 
Safety | 
Modes ghost, test, quiet and live per offer and per workflow, plus the send lock, test channel, slack.live and send windows.

## Audit findings
The engine's core ideas are right: Postgres as the queue, idempotent sends, versions pinned per run, and a send lock. The mess comes from three things. First, each workflow is copied whole onto each offer. Second, GHL is welded into the core. Third, every fix was layered on top instead of replacing what it fixed. Those three choices cause most of the incidents in the decision log.

### Structural problems (root causes)
- 
**Copy-on-install plus shared engine code (D2).** Each offer owns a full JSON copy of every workflow. A code default therefore reaches live offers silently, and a template fix can't reach them without a hand port. Both happened: PMU was silently upgraded and renamed on 2026-10-17, and PMU's Deal Closed email is still Hair's copy. The guard rails (D147, frozen fixtures, one offer at a time) are good process sitting on top of a fragile design.
- 
**GHL welded into the core.** There are ghl_* columns in 8 tables and GHL URLs in about 12 templates. liveAdapters hard-wires ghlRead, ghlWrite and ghlSender globally, and the adapter types carry PIT, locationId and GHL field-id arrays. HubSpot would be a rewrite, not an adapter.
- 
**Polling as the backbone.** GHL contacts, conversations, opportunities, calendars and documents (every 10 s), plus Calendly, are all polled from a pg_cron tick inside the same database. The 2026-10-19 audit says nothing outside watches that tick. Latency complaints led to bolt-ons (D202 "instant" payments).
- 
**Fixes layered, never replaced.** Examples: a mode ladder rebuilt five times (shadow to ghost/test/quiet/live, with shadow still preprocessed), set_tag and remove_tag kept beside tags, LEGACY_LOCK beside per-company locks, tickEveryone for pre-D98 schedulers, and about 40 "before D/legacy" branches.
- 
**Long transactions mixed with vendor calls.** CRM writes still run inside the run transaction (open item 23). A 4-minute transaction rolled back the audit row (D204), and an advisory lock deadlocked with a tick (D151).

### Hard-coding still in the code
 | 
What | 
Where
 | 
Hair intake as the default booking card | 
engine/booking-card.ts:55-72
 | 
Hair objections as the default DQ list | 
engine/setting-defaults.ts:16, sales-call.ts:94
 | 
Hair welcome copy in the generic template | 
templates/deal-closed.json:96-103
 | 
Tyler's hours and timezone as alert defaults | 
engine/setting-defaults.ts:23 (07:00-17:00, America/Phoenix)
 | 
Dating DQ categories queried by name | 
engine/eod.ts:151
 | 
One-off reassignments for named staff | 
engine/contact-ops.ts:67-73,163
 | 
EOD questions, payment kind, setter attribution, metric definitions | 
eod-form.ts, payments.ts, setter-missing.ts, metric-registry.ts
 | 
Custom-object key defaults repeated | 
5 code files plus 13 template nodes
 | 
"Jev" vendor name in user-facing copy | 
pre-call-sequence.json, setter-call-logged.json (15 hits)
 | 
Model id and vendor URLs | 
adapters/anthropic/analyst.ts:7, bot.ts:10
 | 
Silent locale defaults | 
USD/"$", +1 phones, task due "+1d"

### Overcomplication
- 
**37 step types** in a 1,276-line executor.ts switch. Five of them are reports in disguise (eod_due, report, leaderboard, health_check, availability_check), and nine are overlapping CRM writes. Each step type is spread across about 6 files.
- 
**Templates are huge.** setter-call-logged.json is 1,475 lines. Frozen fixtures copy whole templates, so the same 1,475 lines exist twice.
- 
**About 155 D-numbers cited in code.** Comments read like a changelog rather than describing behavior, and 00-decisions.md is 5,872 lines.
- 
**Six overlapping safety concepts:** mode, workflow mode override, send lock, slack.live, test channel, quiet hours. The gating order is repeated in doSend, send_document and webhook.
- 
**Settings read by hand about 70 times.** There are 4 boolean parsers and 3 phone normalizers (D200.9, D200.13).

### Fragility and security
- 
**Slack is one app per offer,** made from a hand-pasted manifest with the company UUID baked into its URLs. Slash commands go to whichever app was installed last in a workspace.
- 
**Row-level security is mostly bypassed:** 152 asOperator calls against 6 asCompany. The bot's SQL could read other tenants' run_steps before D151.
- 
**Zapier doors use a static shared secret,** not an HMAC, and treat an unknown status as succeeded.
- 
**No 5xx retry on any vendor.** GHL retries only on 429, Slack posts never retry, and the operator webhook is fire-and-forget. Production has no external watchdog.
- 
**Preview deploys share the production database.**
- 
**GHL quirks are worked around inline:** an appointment PUT resets the status, DATE fields drop the time, and the "MONETORY" spelling has its own special case. Some of these are still marked "to verify live".

### What is worth keeping
- 
Postgres as the queue, using for update skip locked with leases.
- 
The idempotency key row written before the vendor call, with an unknown status that is never re-sent.
- 
Runs pinned to a workflow version.
- 
The premise re-check before advancing, so a cancelled call never gets a reminder.
- 
Waits, send windows and listeners stored as data, not timers.
- 
Failure classes (transient, auth, permanent) with pause-by-vendor.
- 
Every literal as a binding, and blocking a workflow from being enabled while one is unbound (D3).
- 
The send lock concept.

## Rebuild blueprint
The rebuild has two inputs (vendors and the operator), one log of facts, one store of config, one engine, and one gate that every outbound effect must pass. The only behavior written in code is the platform itself: the Slack app, the step primitives, the connectors and the gate. Everything about an offer is data.
Facts flow down the left side and config flows down the right. Both feed the engine, and everything the engine does leaves through the delivery gate. The engine's own results are written back to the event log, so reports see them too.

### Principles
- 
**Zero offer-specific code.** Code knows ports, primitives and Slack behavior. Offers are rows. A CI check fails the build if code contains an offer name, a vendor ID or a client's words.
- 
**No silent defaults.** A required setting with no value blocks enabling. It is never filled from code.
- 
**The offer owns its workflows****.** Each offer's workflow is complete and self-contained, with every step visible. A change reaches an offer only as an explicit edit to that one workflow.
- 
**Webhooks first, reconcile second.** Every vendor pushes events where it can, and a nightly diff catches what was missed.
- 
**Facts are append-only.** Reporting reads one log. The CRM is read for current state only.
- 
**No vendor call inside a transaction.** Effects go through the outbox.
- 
**One change pipeline.** UI and chat both propose, simulate, show the behavior diff, and get approval.
- 
**Comments describe behavior.** Decisions live in short ADRs, not as D-numbers in code.

### Stack
 | 
Piece | 
Choice | 
Why
 | 
Language | 
TypeScript end to end | 
Matches your JavaScript, and the current team and tooling already use it
 | 
API and dashboard | 
One app (Next.js or Hono plus React) | 
One deploy, not a Next API plus a separate Vite build
 | 
Worker | 
Node service with graphile-worker or pg-boss on Fly, Render or Railway | 
Durable jobs, timers and retries without pg_cron ticks
 | 
Database | 
Dedicated Postgres with branch databases for previews | 
Isolation from other apps and from production
 | 
Data access | 
Typed query builder (Kysely or Drizzle) plus Zod schemas | 
Ends hand-written SQL strings and parser drift
 | 
AI | 
Anthropic for notes, the editor and the bot, Jev for reply classification; model id is a setting | 
Jev stays by decision; both sit behind the AI port
 | 
Operator interface | 
MCP server exposing the change API | 
Claude chat and the UI share the same safe operations

## Rebuild data model
The CRM is the truth for **current state**, meaning who a contact is and which stage a deal is in. Our database is the truth for **what happened and what we did**: an append-only log of facts. Every report runs off that log.
That split resolves a contradiction in "CRM is the truth." A CRM can't answer "how many shows last March" reliably. It overwrites history, it rate-limits reads, and when it's down the wrap-up is wrong. Today's metrics mix live GHL reads with the local ledger, which is why numbers can disagree.

### Four kinds of data, never mixed
 | 
Kind | 
Tables | 
Rule
 | 
Configuration | 
offers, people, person_identities, connections, settings, field_maps, content, templates, workflows, workflow_versions, report_definitions, metric_definitions, form_definitions | 
Every row is typed and versioned. Every change writes config_changes (who, what diff, why). Nothing about an offer lives in code or in the repo.
 | 
Facts (append-only) | 
events, partitioned by month | 
Canonical type (for example appointment.booked or payment.succeeded), offer_id, occurred_at, subject refs (contact, appointment, deal), source, a unique dedupe_key, and a typed payload validated by a schema registry. Never updated or deleted, except for a PII scrub.
 | 
Projections (rebuildable) | 
contacts_index, appointments, calls, deals, payments, daily_facts | 
Built only from events by projectors. You can drop them and rebuild. calls is the single call fact table (booked, held, outcome, rep, recording, kind) that today is spread across four places.
 | 
Execution | 
runs, run_steps, outbox, inbox, alerts, slack_messages | 
inbox dedupes every webhook and poll item. outbox holds every outbound effect (SMS, email, CRM write, Slack post) with an idempotency key.

### Key design choices
- 
**One tenant concept: the offer.** A client with two offers is two offers under one client row. People and identities (Slack id, CRM user id, email, phone) live once and are linked to offers with roles. That replaces users.ghl_user_id, slack_user_id and the free-text set_by fields.
- 
**Typed settings, not EAV text.** A setting_definitions registry in code declares each key's type, scope, and whether it's required. Values are jsonb validated against it. There are no code fallbacks: a required setting with no value blocks enabling the workflow (D3, enforced by the database).
- 
**Field maps as data.** field_maps(offer, canonical_field, provider, provider_field_id) replaces about 60 crm.field_* bindings and every ghl_* column. Canonical fields (lead_source, call_outcome, contract_value) are what workflows reference.
- 
**Content as its own table.** Each message has a key, body, channel, an approved hash and who approved it. Workflows reference content by key, so copy edits never touch workflow logic and approvals track exact words (keeps the D177 idea).
- 
**Store less CRM.** contacts_index holds only what matching and routing need: CRM id, normalized phones and emails, offer, and merged-into. Everything else is read from the CRM when needed, behind a short cache.
- 
**Real constraints.** Enums are Postgres enums or check constraints. Every row that belongs to an offer carries offer_id with RLS forced. The app connects as a role that can't bypass RLS, and only migrations run as owner.
- 
**Retention by class.** Message bodies and transcripts are held for a set time, then scrubbed in place. The fact row stays without the PII, so counts never change after a purge.
- 
**Own database, with branches.** No shared production database with other apps. Previews get a branch database (Supabase branching or Neon), and migrations run only in the deploy pipeline.

## Rebuild workflow engine and the text editor
The engine shrinks from 37 step types to about 10 primitives, and everything else becomes a connector action or a report definition. Every workflow belongs to its offer as a complete definition. Nothing in it is inherited, defaulted from code, or hidden inside a step.

### Primitives
 | 
Primitive | 
Replaces today
 | 
trigger (event, schedule, manual) | 
trigger, the clock jobs
 | 
wait (duration, until a time rule, or for an event or reply, with a timeout) | 
wait, wait_for_reply, wait_for_event, wait_for_reaction
 | 
branch (conditions over context) | 
check, branch, lookup gates
 | 
set (compute variables) | 
set_var, lookup
 | 
message (to a contact over SMS or email, or to people over Slack DM or channel; content by key) | 
send_sms, send_email, notify_owner, slack_post
 | 
ask (Slack buttons or a modal, waits for the answer) | 
wait_for_reaction listeners, confirm buttons
 | 
action (connector.verb: crm.update_contact, crm.move_deal, esign.send, ai.classify, ai.summarize) | 
the 9 overlapping CRM writes, send_document, classify, analyze, webhook
 | 
report (render a report definition) | 
report, leaderboard, eod_due, health_check, availability_check
 | 
call (run a sub-workflow) | 
start_workflow
 | 
end | 
exit, pause_runs
The premise check, re-entry policy and send window stay as workflow-level properties, not steps.

### Every workflow is the offer's own
- 
**Self-contained.** An offer's workflow stores every step, every word, every timing, channel and condition. Reading it tells you everything it does, and nothing is looked up from a template at run time.
- 
**Templates are starting points.** Creating a workflow from a template copies it in full. The workflow remembers which template@version it came from, for information only.
- 
**Bringing a template change to an offer** is an explicit edit to that one workflow. You see a three-way diff (template then, template now, this offer's workflow), the behavior diff from the simulator, and then approve. It never happens in bulk or by install.
- 
**Versions are immutable.** Each save is a new version with who, why and the approved simulation attached. Runs in flight keep the version they started on. Rollback re-saves an older version.
- 
**Step semantics are versioned.** A change to how wait works ships as wait@2, and existing workflows keep wait@1 until edited. CI replays every live workflow's scenarios on every code change, and any behavior diff fails the build. This replaces hand-frozen fixtures.

### Nothing hidden: what the UI shows
The workflow page is the workflow. If something affects what happens to a contact, it appears on that page, on the step it affects.
- 
**Every step is its own visible step,** including what today hides as plumbing (set_var, which collapsePlumbing in describe.ts:308 removes from the chart) and logic buried inside step types (eod_due, report, doSend's gate order). One step does one thing.
- 
**Two synced views of the same version:** a flowchart and a numbered step list. Click a step in either view and both highlight it.
- 
**Each step card shows:**
- 
what it does in plain English
- 
the exact words sent, rendered with a sample contact
- 
who it goes to and through which channel
- 
its conditions
- 
its wait rule as a real clock example ("booked Tue 3 pm for Thu 10 am: fires Wed 7 pm")
- 
what happens on failure (retry, skip or hold)
- 
every way out, labelled
- 
**Workflow-level rules appear as a header strip:** trigger, re-entry policy, the "is the call still on" check, the send window, delivery state (sandbox or live, and who unlocked it and when), CRM writes (dry or real), and the frequency cap.
- 
**Gate badges on every outbound step** show which gate checks apply (sandbox, DND, window, cap, blank hold), so the delivery gate is never invisible.
- 
**Settings appear in place.** A step that uses channel.bookings shows the actual channel name inline with a link to the setting. Nothing reads "unbound" without a red flag that blocks going live.
- 
**Live overlay:** counts of contacts at each step now, in the last 7 days, and the last failures. Click through to the runs.
- 
**History:** every version with its reason and its diff, side by side.
- 
**Edit in place:** the text box for plain-English changes sits on the page and is scoped to this offer and this workflow. The same page shows the proposed diff and simulation before approval.
**Fleet view for 10 to 30 offers.** A grid of offers by workflow shows enabled, delivery state, version, "differs from template", open alerts and runs today. It is read-only, and every change still happens one offer and one workflow at a time.

### Runtime
- 
**Postgres stays the queue, behind a proven job library** (graphile-worker or pg-boss) running on a persistent worker (Fly, Render or Railway), not serverless ticks fired from inside the database. The cadence goes from a minute to sub-second, and timers become job run_at values.
- 
**Outbox for every external effect.** A step writes its intent to outbox in the run's transaction. A separate dispatcher delivers it with the idempotency key and records the result. No vendor call ever runs inside a database transaction, which retires the D151, D204 and item 23 bug class.
- 
**Retry policy per connector.** Transient errors (429, 5xx, timeouts) back off with jitter. Auth errors pause by connection. Permanent errors fail the step. An ambiguous result is never re-sent (keeps today's unknown rule).
- 
**Simulator as a first-class component.** The same interpreter runs against a fake clock and fake connectors. It takes a scenario (a list of events) and returns the exact timeline: messages with rendered words, CRM writes and Slack posts.

### The text-based AI editor (UI and chat, one pipeline)
The dashboard and Claude chat call the same change API, exposed as an MCP server, so both surfaces behave the same way.
- 
**Describe.** Pick the offer and workflow, then type the change in plain English, for example "Move the 1h reminder to 2h and skip it if they confirmed." Scope is fixed to that one workflow by the UI, not inferred.
- 
**Propose.** Claude edits the workflow's readable definition (YAML, with the plain-English spec beside it) and returns a structured diff.
- 
**Validate.** Schema check, unbound parameters, unapproved content, and a check that outbound steps changed (which relocks sends).
- 
**Simulate.** Run the offer's scenario suite on the old and new versions, and show a behavior diff, for example "Contact booked 26h out: reminder moves from T-1h to T-2h, and the confirmed case now gets no reminder."
- 
**Approve.** One click (or "yes" in chat) saves a new version with the reason. In-flight runs keep their pinned version, and rollback is picking the previous version.
The definition itself is also editable as text in the UI for direct tweaks, and goes through the same validate, simulate and approve steps.

## Integrations in the rebuild
Every vendor sits behind a **port**: a small typed interface with canonical events in and canonical actions out. Each offer picks one provider per port in its connections rows. Workflows never name a vendor, so "speed to lead from HubSpot" means changing a connection, not a workflow.
 | 
Port | 
Providers | 
Events in | 
Actions out
 | 
CRM | 
GHL, HubSpot | 
contact.created/updated/merged, deal.stage_changed, deal.won/lost, note.added | 
find/upsert contact, set field (canonical name via field map), tag or list, move deal, create task, add note, record URL
 | 
Messaging | 
GHL SMS and email, Twilio, Postmark | 
message.received, message.delivered/failed, contact.opted_out | 
send SMS, send email
 | 
Scheduling | 
GHL calendars, Calendly, HubSpot Meetings | 
appointment.booked/rescheduled/cancelled, attendance | 
cancel, read availability
 | 
Payments | 
Whop, Stripe, generic signed webhook | 
payment.succeeded/failed/refunded | 
none (read only)
 | 
Recording | 
Fathom, GHL dialer | 
call.recorded (with transcript ref) | 
fetch transcript
 | 
Forms | 
Typeform, GHL forms, generic | 
form.submitted | 
none
 | 
E-sign | 
GHL Documents, PandaDoc or DocuSign later | 
agreement.sent/viewed/signed | 
send agreement
 | 
AI | 
Anthropic | 
none | 
classify, summarize, score, answer
 | 
Team chat | 
Slack (the one platform app) | 
button pressed, modal submitted, slash command, mention | 
post, update, DM, open modal

### CRM: GHL and HubSpot as equals
- 
**GHL through a private Marketplace app, not per-location PITs.** That gives OAuth per sub-account and real webhooks (contact, appointment, opportunity, inbound message). GHL's own docs in this repo say webhooks are Marketplace-only, and that single fact is why the current system polls everything. Polling stays only as a nightly reconcile that diffs and emits missed events.
- 
**HubSpot through a private app token.** It supports webhooks and has no native SMS, so a HubSpot offer pairs it with Twilio for messaging. Tags map to a multi-select property or lists, handled inside the adapter through the field map. Verify before building: current webhook support on HubSpot private apps, and GHL's private Marketplace app approval path.
- 
**Adapter contract tests.** Each CRM adapter must pass one shared test suite (upsert idempotent, field round-trip, merge handling, rate-limit behavior). Vendor quirks like the GHL appointment PUT that resets status are fixed once inside the adapter and covered by a test.

### Slack: one app for the whole platform
- 
**A single distributed Slack app** (unlisted, installed through an Add-to-Slack OAuth flow) replaces one hand-pasted manifest per offer. Request URLs are fixed and route by team_id and channel. That ends manifest pasting, slash command collisions, and per-offer signing secrets.
- 
**Where Slack posts and what it says is per-offer config:** channel slots, personas and content. **How Slack behaves is platform code:** buttons, modals, repeat rules, Pause, slash command handling. That matches the 2026-10-19 rule exactly, and it is the only place behavior is written in code.
- 
**Workspaces shared by offers:** commands resolve the offer from the channel's mapping, or take /mtd pmu. A channel belongs to exactly one offer.
- 
**The bot answers from the metric layer, not raw SQL.** Free-form SQL becomes a fallback over per-offer read-only views, which removes the cross-tenant risk at the root.

### Inbound: one door for everything
POST /in/{connection_id} takes a vendor webhook. The flow is:
- 
Verify the vendor's signature.
- 
Write to inbox (deduped on the vendor's delivery id).
- 
Respond 200 at once.
- 
A normalizer turns the payload into canonical events.
Zapier, Make and unknown tools get a **generic signed door**: an HMAC secret per connection and a field map that is set as config. That retires the shared-secret Zapier doors and the alias guessing.

## Safety by construction
Today's six overlapping safety concepts collapse into one **delivery gate** in the outbox dispatcher. Every outbound effect passes through it, so no step type can skip a check.
The gate checks these in order, in one function, with one test suite:
- 
**Workflow delivery state.** sandbox sends contact messages only to the operator's own addresses and Slack posts only to the test channel. live sends for real. Every workflow starts in sandbox, and only Tyler can set live, by naming the offer and workflow. That is the send lock as a column, not a separate system. Any change to an outbound step drops the workflow back to sandbox.
- 
**CRM writes.** dry records the intended write without making it. real writes it. This covers today's ghost and quiet modes on a separate axis, so "quiet" no longer means half of two things.
- 
**Contact opt-out and DND**, read from the CRM at send time.
- 
**Send window** in the contact's time zone.
- 
**Frequency caps.** No contact receives more than N messages per day across all workflows (default 4, set per offer). A message that would break the cap is held and Tyler is alerted in Slack; the workflow continues. An offer that exceeds M sends per hour trips a circuit breaker: sends pause and Slack alerts Tyler. This is the direct answer to "it messages someone 20 times", and today nothing enforces it.
- 
**Blank-variable hold.** A message whose rendered text has an empty variable or a placeholder is held, never sent. That generalizes the D186 meeting-link fix (open item 51).

### One offer at a time
- 
**Scope is part of every change call.** A change request carries exactly one offer_id and one workflow_id. The API refuses a list. A change across all offers is a separate, explicitly named operation that runs offer by offer, with a dry run and a confirmation for each.
- 
**A template change can't reach an existing offer.** Templates are only copied when a workflow is created. After that, a template change reaches an offer only as an explicit edit to that one workflow (see the engine section).
- 
**Engine changes can't silently change an offer.** Step semantics are versioned, and CI runs every live workflow version's scenario suite before and after a code change. Any behavior diff fails the build unless it is declared and approved. This replaces hand-frozen fixtures with an automatic, complete check.

### Audit and recovery
- 
config_changes records every edit with actor, offer, workflow, diff, reason, and the simulation result that was approved.
- 
Rollback means repinning the previous version: one click, offer-scoped, also recorded in config_changes.
- 
An outage backlog is released under the same frequency caps, so recovery can't flood contacts. That replaces the ad hoc RECOVERY_SEND_CAP.
- 
An external watchdog (a health endpoint plus an uptime monitor) pages Tyler if the worker or the inbox lag stalls.

## Reverse-engineering and migration plan
The way to rebuild without breaking live offers is to treat the current system as the specification. Record what it actually does, prove that the new system does the same, then cut over one workflow on one offer at a time. A big-bang rewrite of a system with three live offers is the riskiest option. This plan is a strangler: the old system keeps running until each piece is proven.
- 
**Extract the behavior spec.** For each offer and workflow, generate a plain-English spec covering triggers, waits, messages (exact words), CRM writes, Slack posts and exits. Source it from the saved definitions, then confirm it against production history in events, runs, run_steps and sends.
- 
Gate: Tyler signs off each offer's spec, and any behavior he doesn't want is marked as a change rather than copied.
- 
**Capture golden traces.** Export real event streams per offer (scrubbed of PII), along with what the old engine did in response. Then add the existing scenario tests (templates.scenarios.test.ts, step-failures.test.ts) as synthetic cases.
- 
Gate: every workflow has at least one trace covering each branch.
- 
**Build the core and simulator first,** before any connector. That covers the definition format, interpreter, delivery gate, outbox and the fake clock and connectors. Replay the golden traces and diff the intended actions against what the old system did.
- 
Gate: zero unexplained diffs per workflow.
- 
**Build connectors with contract tests:** GHL Marketplace app, Slack platform app, Whop, Fathom, Calendly, Typeform, generic door.
- 
Gate: each passes the shared port suite against a sandbox account.
- 
**Port config, not code.** A script reads each offer's bindings, calendars, people and workflow copies, and writes the new typed settings, field maps, content and pinned instances. Hair-specific defaults found in code get written onto Hair explicitly, never onto anything else.
- 
Gate: a config diff report per offer that Tyler reviews.
- 
**Shadow run.** The new system consumes the same live inputs per offer in sandbox with CRM writes set to dry, and posts its intended actions next to the old system's real ones. Diff daily.
- 
Gate: a full business week with no unexplained diff for that offer.
- 
**Cut over one workflow at a time,** starting with read-only ones (wrap-ups, leaderboard, EOD), then alerts, then contact-facing sequences last. In-flight runs drain on the old engine. New triggers after the cutover timestamp start on the new one, so no contact is in both.
- 
Gate: Tyler names the offer and workflow to cut over, just as he unlocks sends today.
- 
**Retire the old engine per offer** once all of its workflows are cut over and its last runs have drained. Keep the old database read-only for 90 days for reporting continuity.
**Faster path worth considering:** most of the gain can be had inside the current codebase, in roughly this order of value:
- 
Outbox and delivery gate.
- 
GHL Marketplace app webhooks.
- 
One distributed Slack app.
- 
Pinned template versions with parameters instead of copies.
- 
A single source for metrics.
Steps 1 to 3 of the plan above are worth doing either way, because they are the spec and the safety net for any change.

## Risks, trade-offs and open questions
 | 
Risk or trade-off | 
Why it matters | 
Mitigation
 | 
A rewrite stalls while live offers need fixes | 
Two systems to maintain, and Tyler's attention split | 
The strangler plan. Freeze new features on the old engine except fixes. Cut over read-only workflows early so progress is real.
 | 
GHL Marketplace app approval or scope limits | 
The webhook-first design depends on it | 
Verify first. If it's blocked, the GHL adapter keeps polling behind the same port and nothing else changes.
 | 
HubSpot webhook support on private apps | 
The HubSpot adapter design assumes it | 
Verify against current HubSpot docs. The fallback is a public app or a polling adapter.
 | 
A persistent worker is one more thing to host | 
Vercel alone can't hold a long-running worker | 
One small always-on service (Fly, Render or Railway) plus the external watchdog. It is cheaper than the incidents from tick races.
 | 
Fewer primitives means bigger connector actions | 
Logic moves from step types into adapters | 
Contract tests per port, and every action is idempotent by key.
 | 
Simulation diffs can be noisy | 
Timestamps and ordering differ between engines | 
Compare normalized actions (who, what, content key, relative time), not raw rows.
 | 
Storing less CRM data means more live reads | 
Rate limits (GHL: 100 per 10 s per location) | 
A short read-through cache, and webhooks keep it warm. Reports never read the CRM live.

### Decisions from Tyler
 | 
Question | 
Decision
 | 
Jev or Claude for reply classification | 
Keep Jev. Classification stays a connector action (ai.classify) with Jev as the provider.
 | 
What a cap breach does | 
Hold only the message that would break the cap, alert Tyler in Slack, and let the workflow continue.
 | 
Default per-contact cap | 
At most 4 messages per contact per day across all workflows. 3 is the expected norm, and 4 leaves room. Each offer can override it.
 | 
Rebuild or change in place | 
Spec first, decide later. Do migration steps 1 and 2 (behavior spec and golden traces) for every offer, then decide.
**Scale (Tyler, 2026-10-21):** 10 to 30 offers in 12 months, about 750 workflows. Postgres plus a job library on a persistent worker handles that load comfortably. The pressure is operational, not computational. That makes these three things required, not optional: OAuth installs for GHL and Slack, onboarding as config, and the fleet view.