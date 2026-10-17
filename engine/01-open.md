# Engine — open questions

Ordered by how much downstream work they block.

---

## 1. ~~Node type catalog~~ — SETTLED in `02-data-model.md` §10
The set of node types is the engine's instruction set. Adding one later is easy; changing
what one *means* after runs exist is not. Current candidate set:

`wait` · `send_sms` · `send_email` · `check_condition` · `set_field` · `add_tag` ·
`remove_tag` · `move_stage` · `assign_owner` · `create_record` · `http_call` ·
`handoff_to_workflow` · `exit`

Open: is `handoff_to_workflow` a node or a trigger on the receiving workflow? A node is
simpler to read in the editor; a trigger keeps the coupling one-directional and lets the
receiving workflow change its entry conditions without the sender knowing. **Recommend
trigger** — the sender emits an event, the receiver decides whether to care.

## 2. ~~Event bus shape~~ — SETTLED: one `events` table, `event_types` FK (`02-data-model.md` §6)
Triggers match on events. Where do events come from?
- GHL webhooks (appointments, payments, tags) — which ones are available, and which are
  only available on paid tiers?
- Our own forms (D8) — direct, trusted.
- Our own scheduler (time-based triggers, e.g. reactivation sweeps).

Open: one normalized `events` table everything writes to, or triggers matching against
source-specific tables? **Recommend one normalized table** — it's what makes the
"see it flowing" UI possible without a per-source special case, and it gives the
reconciliation sweep (D5) one place to look.

## 3. ~~Condition expression format~~ — SETTLED: JSON predicate tree (`02-data-model.md` §10)
`check_condition` needs a way to express "offer = pmu" or "total_collected >= contract_value"
that is both storable as data and editable in a visual node editor. Candidates:
- a small JSON predicate tree — safe, no eval, tedious to hand-write, trivial to render as UI
- a string DSL — pleasant to write, needs a parser, harder to render as nodes

**Recommend JSON predicate tree.** The editor is the authoring surface, so hand-writing
ergonomics don't matter, and it rules out code execution from a stored definition.

## 4. Scheduler cadence and the 300s function cap
Vercel Pro cron is 1-minute granularity; functions cap around 300s. A minute tick that
claims a batch of due runs and processes them is fine at this scale, but needs:
- row-level claim (`FOR UPDATE SKIP LOCKED` or a `claimed_at` lease) so overlapping ticks
  can't process the same run twice
- a cap on batch size per tick, with the remainder picked up next tick
- a dead-letter path for a run that fails repeatedly, so one poisoned run can't stall a batch

Open: does the 1-minute floor satisfy speed-to-lead? A 60-second worst case on top of
webhook latency is probably fine for "minutes not hours," but it's worth stating as a
number in the client-facing scope rather than implying instant.

## 5. Credential handling after handoff
Unresolved from the earlier thread. If the client is on Hosted ($500/mo) and Tyler is no
longer managing, whose GHL token is in the `bindings` table, and who rotates it? A settings
screen in the dashboard is the rotation mechanism, but someone has to notice a token died.
Needs a health check per binding plus an alert to whoever holds the account.

## 6. ~~Which GHL webhooks actually fire~~ — ANSWERED 2026-10-06
There is no webhook management API for a PIT at all (404s, not 401s — no such route). Full
findings in `../ghl/02-api-facts.md`. Resolution:

- **Primary:** a thin GHL workflow per event type whose only action is a Webhook POST to our
  endpoint. These travel in a snapshot, so they're install config rather than per-client build
  work. Lowest latency available without a marketplace app.
- **Backstop:** polling `GET /calendars/events` per calendar, confirmed working. This is the
  reconciliation sweep (D5) regardless of what's primary.
- **Later, if it earns it:** a marketplace app for real event subscriptions. Correct eventually,
  overkill at one client.

Still open under this: **which GHL plan tiers include the Webhook workflow action**, and whether
inbound POST volume is rate-limited. Worth confirming before the install SOP depends on it.

## 7. ~~What is "Jev"?~~ — ANSWERED 2026-10-06
TypeSafe AI's classifier model. Discriminative, not generative: `state` + typed questions in,
probability distributions out (`noul` boolean / `choice` / `score`). 70–500ms, 40–400x cheaper
than frontier models on comparable work, 64k token input budget. Locked into D5c as the middle
tier of decision-making.

Still to verify before depending on it: pricing at our volume, SLA and uptime posture (it
becomes a dependency in the send path for reply routing), and whether a self-hosted or fallback
path exists if it's down — a classifier outage must degrade to "escalate to human," never to
a guess or a dropped run.

## 9. ~~BLOCKING: what does "no chaining" mean?~~ — ANSWERED 2026-10-06, see D4
Tyler, 2026-10-06: *"We are not doing the chaining. i don't think that's the right way to do
it."* Two readings, materially different, and the data model can't be drafted until it's settled:

**(a) No conditional branching inside a workflow.** Workflows are linear: step → step → step,
with exits but no forks. Offer variation becomes separate workflows rather than an `if`. Under
copy-on-install (D2) this is coherent and arguably better — the thing branching solved is now
solved by having separate copies, and a linear list is far easier to render in the flow view and
to debug. Zapier is linear for the same reason. **This is my read.**

**(b) No workflow-to-workflow handoff.** Every workflow self-contained, nothing emits an event
that starts another. This one I'd push back on: without it, the reactivation sequence has to be
duplicated into the tail of every workflow that can end in "didn't book."

Asked. If (a), the engine loses `check_condition`-as-a-fork and keeps it only as
`continue-or-exit`, which simplifies the node catalog (open question 1) considerably.

## 8. ~~Template versioning UX~~ — SETTLED: advisory; `workflows.diverged` + dry-run diff; no one-click UI (D2)
D2 requires knowing which instances are behind a template and whether they've diverged. Open:
is a divergence a blocking state (can't take template updates until resolved) or an advisory one
(update anyway, keep a backup)? **Recommend advisory with an explicit diff confirmation** —
blocking means a client's small tweak freezes them out of every future fix.

## 10. ~~Delivery~~ — SETTLED: polling only (D9). Remaining edge cases
- **Deletion detection.** An appointment that leaves the polled window is a cancellation; a
  contact that stops appearing in search needs a periodic full-list diff (daily is fine).
- **A → B → A inside one interval** is invisible. Accept it; document it.
- **Cursor durability.** Cursors live in the DB with the run state, so an outage resumes from the
  last cursor rather than re-scanning. Verify the contacts `range` filter is inclusive on `gte`
  so a cursor set to the last seen `dateUpdated` can't skip a same-millisecond record.

## 11. Jev threshold tuning
The confidence cutoff for `unclear` (D13) is a number that needs real replies to set. Start
conservative (everything under ~0.8 goes to a human), log every classification with its
distribution, and lower it only against observed data. The failure mode to avoid is tuning it on
imagined replies.

---

## Added after the data model (2026-10-06) — all verification, no design

## 12. Slack OAuth scopes and install flow
Each company connects its own workspace (grill-me batch 4). Need the minimal scope set for
`chat:write` to bound channels plus channel listing for the install dropdown, and whether a
single-workspace app or a distributed app is the right shape for N client workspaces.

## 13. Whop webhook payload
`payments` assumes `whop_payment_id`, amount, currency, installment number, status, paid_at.
Confirm field names and whether installment position is in the payload or has to be derived
from the plan.

## 14. Phone → timezone inference
`contacts.timezone_source = 'phone'` needs a library mapping E.164 area codes to IANA zones.
Pick one; note that US area codes spanning two zones resolve to the dominant one and get flagged.

## 15. `relative:auto` formatter edge cases
Cross-midnight ("tomorrow at 9"), cross-DST, and the exact rounding table per mode. Small, but
every reminder text goes through it, so it gets a test file before the first send.

## 16. ~~Scheduler claim semantics on Vercel~~ — SETTLED (lease 5 min, claim by database clock, see runner.ts)
## 16a. (was 16) Scheduler claim semantics on Vercel
`runs.claimed_at` lease length vs. the function cap, and what happens to a run whose lease
expires mid-step. Default: lease = 2× expected step time, expired lease = step re-executes
against the idempotent `sends` ledger, so the worst case is a duplicate *attempt*, never a
duplicate *send*.

---

## After the MVP (2026-10-06)

Settled by building: #4 scheduler cadence (1-min tick, claim via `for update skip locked`,
5-minute lease, 100-run batch, 50 steps per run per tick), #15 formatter (tested; DST edge
cases still open), #16 claim semantics (expired lease → step re-executes against the idempotent
`sends` ledger; worst case is a duplicate attempt, never a duplicate send).

## 17. Reply detection lag
A waiting run is woken when an inbound message arrives for its contact (`next_run_at = now`),
but the reminder template waits a fixed `+4h` before checking for a reply. Better: a
`wait_for_reply` node with a timeout, so a "yes" at minute 3 is handled at minute 4. Small, do it
before the first client.

## 18. Vercel GitHub connection and production database
Blocking deploy. Both need Tyler (see `platform/README.md`).

## 19. First-poll baseline for a company with live appointments
Baseline marks every existing appointment as already-known, so a reminder template installed
today does NOT remind people booked yesterday for tomorrow. That's the safe default; an
"also schedule reminders for upcoming existing bookings" install option is a reasonable ask
and a one-day build.

## 20. Reply handling outside the reminder
`wait_for_reply` lives inside specific workflows. A reply that arrives when no run is waiting
(someone texts back three days later) is recorded as `message.received` but nothing acts on it.
A standalone "unsolicited reply" workflow (classify → tag → note) is a small template away.

## 21. Timezone on polled contacts
GHL contacts carry a `timezone` only sometimes; the rest fall back to the company's. Phone area
code inference (#14) is still the fix. Until then, "morning of" is the company's morning for
those contacts.

## 22. Dashboard writes have no login (deferred by Tyler: "no password and such yet")
Go live / Switch to shadow, Turn on / Turn off, and Save disposition are server actions with no
authorization of their own; the only wall is Vercel's deployment protection. Fine for the test
period. Before any client logs in, these need the same gate as `/api/admin/*` at minimum.

## 23. One transaction per run per tick across external side effects
A tick processes a run's nodes inside one database transaction while calling GHL/Slack. A node
that throws no longer rolls back the ledger (the runner catches and fails the run inside the
transaction), but the design still couples external calls to a transaction. The clean version
commits the `sends` row before calling the vendor and updates it after. Not urgent at MVP volume;
do it before the first high-volume client.

Status 2026-10-06: the poller side is done — `pollAll` now runs one transaction per entity
(contacts, each calendar, conversations) and writes the failure counter in a fresh transaction
after the rollback. The runner still processes a run's nodes inside one transaction; a vendor
error there is caught without aborting the transaction, but a SQL error mid-run would still roll
back that run's ledger (the run is then marked failed from a fresh transaction, so nothing hangs).
Ticks are serialized per company by a lease row (`engine_state.tick_lock:<companyId>`, 6 minutes,
see `platform/src/engine/lock.ts`; the engine's own minute holds `tick_lock:engine`, D98); a tick that
finds its lease held returns `{ busy: true }`.
The minute scheduler is pg_cron + pg_net inside the Supabase database (`platform/src/engine/schedule.ts`);
GitHub's five-minute schedule fired once in four hours and is kept only as a backup.

## 24. Show / no-show for companies whose booking source has no outcome (closed 2026-10-08: `no-recording-no-show` template, D36; that template retired 2026-10-09, D54: the end-of-day form presumes it from the call time alone)
Calendly carries an invitee `no_show` mark (mapped to `noshow` when present) but Hair does not
use it. Hair's truth is: a Fathom recording exists for the call → showed, otherwise no-show.
That is the next automation to build; until then Hair appointments have no outcome and the
no-show-recovery and post-call-follow-up workflows cannot start for them.

Status 2026-10-07: the show half is built (D22). A Fathom recording (direct webhook or via a Zap)
becomes a `recordings` row, is matched to the contact and their appointment, and the
`call-recorded` template records the appointment as showed through `record_outcome`, so
`appointment.outcome` and `call.held` fire. Still open: the no-show half. Nothing yet marks an
appointment `noshow` when no recording arrives; that needs a timed sweep (an appointment whose end
passed N minutes ago with no recording and no outcome → noshow) and is the next piece.

## 25. Readiness: what still stands between a company and "live"
The dashboard now answers this from facts (`platform/src/engine/readiness.ts`, shown on the company
page and on each workflow page): company mode, Slack connection, every workflow's required bindings,
Slack channels unbound, and the gaps the engine knows it still has per template (`KNOWN_GAPS`; remove
an entry when the piece ships and the warning disappears). For Hair on 2026-10-07 the list is:
- BLOCKS: Slack not connected (every Slack post is recorded, never posted). Needs a bot token + channel ids.
- Call recorded is OFF, missing `secret.anthropic_key`; Fathom key not yet given, so no webhook registered (the Zapier door is open).
- Call recorded: the no-show half (#24) is not built.
- No Slack channels bound: `slack.channel.bookings`, `slack.channel.payments`, `slack.channel.calls`.
- Hair's own confirmation / reminder / nurture copy is not ported; only new-lead, call-booked, call-cancelled, payment-recorded, call-recorded are installed, so nothing goes to the prospect after a booking yet.
- Resolved 2026-10-07 (D23): sends carry `kind: human | transactional`; the company setting `quiet_allow_transactional` decides whether receipts go out in dark hours. Hair's choice (transactional allowed, or nothing at all) still has to be made when its confirmation copy is ported.

## 26. Template upgrades (found by the real-contact test, 2026-10-07)
Hair's New lead copy was installed from the first template version, whose `create_opportunity` node
was renamed `pipeline_card` the same day. Install never touched an existing copy, so the stored
definition stopped parsing and the first real lead would have taken the contacts poll down with it.
Fixed: a re-run of install upgrades every untouched copy (`diverged = false`) to the current template
as a new workflow version with its triggers re-synced; an edited copy is left alone and reported.
Dispatch skips a copy that does not parse (audit `workflow.unparseable`) instead of failing the poll,
and readiness shows it as a blocker. Still open: the `jtr` company's copies are from day one and need
a re-install to upgrade; runs already in flight stay pinned to the version they started on.

## 27. Version 2: edit everything in the UI, with an agent in it
Tyler, 2026-10-07. V1 is this chat: he describes, Claude builds and installs, and the dashboard shows
it worked (chart, steps table, copy, step settings, what happens next, readiness, test harness runs).
V2 moves the editing into the UI: copy (done), timing of waits, reordering and adding steps, switching
triggers and conditions, and an agent inside the tool that each company can talk to. Standing practice
until then: every workflow Claude installs is proven on a test contact with the harness in shadow, and
the report says what it did and where to look.

## 28. Call recording is partial on Hair; reports over the call ledger come later
2026-10-07. Of the four Hair dialer calls over a minute in the last three days, two had a recording
and transcript and two did not (one of them 172 seconds, still none 30 minutes later). Either the
setter toggles recording per call or the number's recording setting is partial — check in GHL. The
engine keeps every call either way (D28) and only classifies the ones with a transcript. Connection
rate per setter, speed to lead and set rate from the ledger belong in the nightly digest Tyler asked
for the same day; that is a scheduled report over our tables, a different shape from a per-contact
run, and is designed next.

## 29. Wrap-up follow-ups: Typeform door, history backfill, AI themes, the bot
2026-10-07. The wrap-up's "what they said" reads booking-form answers (Calendly questions) and
`intake` rows; Hair's Typeform answers reach GHL as contact fields today and are not tallied until the
Typeform door exists (one JSON of answers per submission → `intake`). History is backfilled from GHL and
Calendly (contacts, calls, bookings, Sales Call outcomes, won deals) — but not payments: GHL holds no
Payment records for Hair, so cash history needs a Whop API key, and won deals carry no contract value
on GHL's field, so revenue history is a count of deals until Whop fills it. Not built yet: a Claude roll-up of the
period's setter-call digests into themes (needs the Anthropic key), and the bot that answers ad-hoc
questions from the rollups, the ledger and live GHL.

2026-10-16, D122: the Typeform door is built (no Zapier): the engine registers its own signed webhook per form, and each
submission goes to GHL as contact fields (by question ref) with the scope tag and UTMs, as the mode allows, recorded as
`form.submitted`. The answers live in GHL, not in `intake`; a wrap-up that tallies them reads them from GHL like every other
number (not built). An importer brings in the responses from before the webhook (dry run by default; apply is a deliberate real
write). Hair's Typeform still reaches GHL through its Zap until it is mapped and installed the same way.

## 30. Agreement workflows (spec captured 2026-10-07; built the same day as D30 — send step waits on the documents scope)
Tyler walked through three GHL workflows to port, pending Deal Closed:
- **Send agreement manually**: tag `sys-send-agreement-manually` → send the "3000 Purchase Agreement"
  template (GHL Documents & Contracts, template `6a9099fcde81e5217a748adb`) from Dr. Allan
  (allan@saveyourhairtoday.com, user `4wrjXxkJOLJv6FuAOikb`) → tag `stat-agreement-sent`.
- **Payment received** (first Whop payment only, Whop → engine door directly; the Zapier → tag → GHL
  workflow chain retires): if not signed, send + tag as above → note "payment received @ date" →
  Sales Call record reflects the current phase → closer card → Agreement Sent
  (`decaf73e-bb76-4eb6-97f5-a3c613a62961`, pipeline `TImaLginykFGirx5loC9`) → Slack "Payment received".
- **Agreement signed**: new event from polling `GET /proposals/document` (status `completed`,
  recipient `signedDate`) → tag `stat-agreement-signed` → note "Agreement signed @ date" → Slack.
Phase on the Sales Call: paid-but-unsigned and signed-but-unpaid must read differently, both → closed.
Proposed a `phase` field (agreement_sent → deposit_paid → agreement_signed → closed_won); Tyler: not yet,
no write scope. Blockers Tyler owns: Documents & Contracts write scopes on the PIT (send endpoints 401
today; reads work), a Whop webhook secret or API key (the engine has never received a Whop payment for
Hair; the $750 tests went through Zapier), and the Deal Closed walkthrough.

### 30, continued: Deal Closed (spec captured 2026-10-07)
Fires when the first payment is in AND the agreement is signed, in either order, once: triggers
`payment.received` and `agreement.signed`, `reentry: once_per_contact`, first check "paid AND signed
AND not tagged stat-customer" (the tag is a belt-and-braces guard Tyler asked for), else exit. Then:
tag `stat-customer` → closer card to Closed - Won (`bff1a4e7-4c38-4c82-82e4-e78ada6884b5`), status
won → setter card status won where it sits (the setter pipeline has no closed stage; Tyler to say if
he wants one added) → Sales Call record disposition `closed_won`, outcome `showed` (payment already
updated the rest) → welcome email + welcome SMS (copy in `engine/copy/hair-welcome.md`, same for plan
and paid-in-full) → Slack. Tyler wants the messages to be GHL templates referenced by the step rather
than copy in the workflow: GHL's email builder templates list via `GET /emails/builder?locationId`
(verified, 2 on Hair) and SMS snippets via `GET /locations/{loc}/templates` (verified, none on Hair
yet); the send step gets a `template_id` option with inline copy as the fallback. Not built until the
Whop door and the Documents write scope are in place.

### 30, continued: unsigned-agreement chase (spec captured 2026-10-07)
Starts on the FIRST payment only. Strict 24h from the payment: check signed → if not, nudge the contact
owner (assigned user; fall back to `crm.default_closer`) → 24h → check → nudge → 24h → check → nudge.
Three nudges at most; a signature at any point ends the run (the agreement poll's `agreement.signed`
wakes and exits it). After the third unanswered nudge: tag `agreement-unsigned` on the contact and
escalate once to a Slack channel. Nudge = a Slack DM to the owner when the engine can map them (GHL
user email → Slack user via `users.lookupByEmail`; cache as `users.slack_user_id`); else a channel post
that @mentions them (`<@U…>`); and a GHL task on the contact assigned to the owner either way, so it is
visible inside GHL. Slack app scopes this needs when Tyler creates it: `chat:write`, `im:write`,
`users:read`, `users:read.email` (plus `channels:read`, `groups:read` for the channel picker).

## 31. Settings move onto the steps (next block, after the end-to-end test)
Tyler, 2026-10-08, on seeing the settings page: "just like in GHL, it should be configured each time."
Agreed shape: the settings page keeps only company-wide things (company, timezone, send window, price,
reached-seconds; one key per connection, with webhooks registered automatically on save; wrap-up
schedule; inbound door addresses). Every other setting is asked on the step that uses it, each time,
GHL-style — "you said the closer pipeline, which stage?" — pipelines, stages, fields, associations,
Slack channels, prompts, the agreement template and sender, calendars ("trigger on X or Y or Z
calendar", one trigger with several calendars or several triggers). No shared defaults pre-filled
from another step. A read-only audit view of everything the company uses stays on the company page.
Small fixes shipped first: timezone dropdown, saving state on every button, Fathom/Whop webhooks
registered on key save (no button), secret rows that do not wrap.

Revised the same day (D32): no step settings in the dashboard at all. Tyler: "I'd rather have NOTHING
editable there and ONLY have it through this chat." The per-step pickers and the copy editor were
removed; the workflow page is a read-only outline with examples on hover. Configuring a step
GHL-style now means: the chat asks "which stage?", edits the company's copy, re-installs. The
calendar-per-trigger question (#31) is still open as an engine question, not a UI one.

## 32. Closer ask-back when a call has no recording (and "update this" when it does)

Tyler, 2026-10-08: if Fathom recorded, the call post carries an "update this" link so the closer corrects
anything; if it did not, DM the closer "Hey, did this person show up?" with two links, one "no, they didn't
show" (records the no-show, and the GHL status when live) and one "yes, here's what happened" (the
disposition form, prefilled from Jev's notes when there are any). Decisions asked, not yet answered: wait
before asking (30 min after the scheduled end proposed), DM with channel fallback, the disposition form's
questions (Tyler owes them), whether a no-show answer starts the no-show texts, re-nudge cadence. Builds on
#24 (the no-show half of call-recorded).
The disposition form's questions are answered by the end-of-day form's definition (D34 amended): the post-call
ask-back is that form cut to one call, so it reads `forms` purpose eod, not a second list.

## 33. Health probes to verify against live vendors

`GET /calendars/{id}/free-slots` (GHL, version 2021-04-15, epoch-ms startDate/endDate, timezone) and
`GET /event_type_available_times` (Calendly, 7-day max window) are implemented from the public docs and
exercised only through fakes so far; the first live sweep on Hair verifies the GHL one. Fathom `GET /webhooks`
is a guess (returns null → the sweep falls back to delivery age). Whop `GET /webhooks/{id}` likewise.
Tyler says Calendly exposes whether a host's calendar is connected; if that is an API field rather than the
dashboard, the sweep should read it instead of inferring from availability. Hair books through Calendly
(two "45 Min Strategy Call" event types), so its first live sweep exercised the Calendly probe (the 400 on a
7-day-from-now window was fixed the same hour); the GHL free-slots probe is still unexercised live.

## 34. Typeform and other inbound doors: verify the URL, offer the fix

Tyler, 2026-10-08: "if we have a Typeform connected and the URL changes somehow we get an alert, and a
'click yes to fix'". The Whop and Fathom webhooks have that now (verified each sweep, re-registered from the
health page). Typeform is not integrated yet (#29): when it is, its webhook is registered by the engine from
a Typeform token, verified each sweep (`GET /forms/{id}/webhooks`), and re-registered from the same button.

Typeform: DONE 2026-10-16 (D122). Install with `typeform: { token, forms }` registers `biab-<slug>` on each mapped form
(`PUT /forms/{id}/webhooks/{tag}`, signed with the engine's secret); every sweep reads it back (`GET /forms/{id}/webhooks/{tag}`)
and gone, off or pointing elsewhere is an error with **Re-register the Typeform webhook**. Calendly and the Zapier doors still
have no such check.


## 35. ~~Deal closed must not fire on a deposit, once deposits are a distinct kind~~ — DONE 2026-10-16 (D119)

Tyler, 2026-10-10, on Deal closed firing at the first dollar plus a signature: "Correct, not paid in full. However NOT if
it's a deposit, which we don't have set up right now, but that's something we need to remember." Today the gate is
`contact.paid` (any succeeded payment on the pursuit) and the signature; `deriveKind` (`payments.ts`) already tells
`deposit` from `paid_in_full` / `balance` by amount against the contract value, but nothing reads it at the gate, and a
deposit is not yet a product the engine knows as its own kind (a reservation fee vs the first instalment of the price).
When it is: the gate reads the kinds paid, not the fact of a payment — a deposit alone, even signed, is not a close; the
first non-deposit dollar with the signature is. Decide with it whether the agreement chase and `stat-customer` wait too.

Done by D119: a deposit is a payment for a declared deposit product (`depositProducts`), never an amount; Deal closed's
gate reads `contact.paid_non_deposit`; the agreement, its chase and `stat-customer` wait for the first payment beyond a
deposit (the chase only ever chases a sent agreement; `stat-customer` is Deal closed's own). D119 addendum (2026-10-16):
a payment whose Whop product or plan is named with the word "deposit" is one too, for a company that declares no products;
the gate reads the kind either way, so nothing here changes.

## 36. Setter cards never booked stay at New Lead

Tyler, 2026-10-10: "They'll live in new lead in the pipeline forever until they're booked. Which might be fine actually as
long as we sort properly." No ageing rule for the setter board, no long-term-nurture stage there. Revisit if the New Lead
column stops being readable; the closer board's Long Term Nurture stage is the closer's own and the engine never moves a
card out of it.

## 37. The owner's build list from the value ideas (2026-10-10)

Tyler picked these to build eventually: revenue leak report; closer scorecards from transcripts; objection library;
source-to-cash ROI; live speed-to-lead SLA ping; follow-up hygiene nudges; cash forecast; buyer's-remorse early
warning; capacity planning; commissions with refund clawbacks; post-call follow-up draft for one-tap approval; the
owner's weekly digest. Most become answers the Slack bot gives (item 38) once the metric layer exists.

## 38. Ask the ledger from Slack — built 2026-10-10 (D70)

Shortcuts (`/mtd`, `/monthly`, `/show-rate`, `/close-rate`, …) and free questions to the bot ("build me a report of
this month's leads that showed, by source"; "what does our calendar availability look like?"). Answers must be
correct before they are clever: named metrics with fixed definitions first, free queries only through the read-only
door (D64), every answer says its period and definition. Design questions open with Tyler.

### 38, Tyler's answers (2026-10-10)

- Unsure what is asked, or no date range: ask once, then answer. Cannot answer or cannot get the data: say so, and ping
  Tyler. "No answer beats a wrong answer."
- Anyone may ask. "My close rate" filters to the asker (Slack user → engine user).
- Reply in the thread of the question; 👀 on the question at once when the answer takes time.
- This month = the calendar month (company time zone).
- Lead = a person who entered their information. MQL = a qualified lead. DQL / marketing DQ = disqualified on financial
  status. Sales DQ = a call taken where the person was not qualified.
- Full output in Slack with the key numbers on top, formatted for Slack.
- Leaning to one registered command per shortcut (`/mtd`) for the simplest experience; trade-offs set out before building.

### 38, built (2026-10-10, D70)

One slash command per shortcut (`/mtd`, `/weekly`, `/monthly`, `/show-rate`, `/close-rate`, `/cash`, `/availability`,
`/leads`, `/help`), each with an optional period in words; free questions by mention or DM, answered in the thread; the
metric registry with one definition per number; clarification before an answer, escalation to Tyler when there is none.
Setup and the Slack app changes are in `platform/README.md` › Slack bot. What is left:

- Saving a report someone built in a thread as a new shortcut ("save this as /leads-by-source"), so a good question
  becomes a command without a deploy.
- Live reads beyond the calendars: since D73 people, won deals and Sales Calls are read from GHL at answer time; other
  CRM-only questions (open cards on a board, a contact's current tags) still escalate until a live tool exists for them.
- Lead source is the CRM's lead-source field, else the latest booking's UTM source; full attribution (D25) is not built.

## 39. Tag MQL / DQ from the work-situation answer (deferred by Tyler, 2026-10-10)

The bot counts MQLs and marketing DQs from the answer itself (D73), so nothing depends on tags. Tyler will add a workflow
later, with a Typeform automation: when the "What best describes your current work situation?" answer arrives, tag the
contact `mql` (an MQL answer) or `dq-budget` (a DQ answer), using the same answer lists (`qualify.mql_answers`,
`qualify.dq_answers`). Blank answers get no tag.

## 40. Switch-over from GHL workflows and Zaps to the engine (Tyler starts 2026-10-13)

Found in the closing-chain test (D90): Hair's GHL workflows start on the same tags the engine writes, so both ran
(two welcome texts, the agreement sent again). Every engine workflow must take over from its GHL twin at one moment:
the GHL trigger gets a filter nobody new matches (e.g. "tag includes legacy-closed"; contacts already inside finish),
the engine workflow goes real for everyone, and the GHL workflow is turned off once its enrolled count is zero. A
Zap with no delay is turned off at that moment; one with a delay gets a first Filter "run started before <time>".

Pairs as read from GHL's names (to confirm with Tyler; the API gives names, not triggers):
New lead ↔ 01 -- New Lead · Card moved by hand ↔ 08 -- Closer Stage Change · Send agreement manually ↔ 09 · Payment
recorded ↔ 10 -- Payment Received · Agreement signed ↔ 11 · Deal closed ↔ 13 -- Deal Closed · Unsigned agreement chase
↔ 14 -- Paid, Not Signed · Pre-call sequence ↔ WF02. Precall MQL WF / 04 -- Setter Confirmed (?) · No-show recovery ↔
06 -- No-show sweep (?). Zaps: list from Tyler.

Order: the short, event-shaped pairs first (09, 10, 11, 13, 14), then 01, then the long-running ones (pre-call, no-show)
last. Prove the "filter nobody new matches" behaviour on Tyler TEST before relying on it.

The switch (D92): each engine workflow goes live on its own while Hair stays in test. For each pair, at the same
moment: put the filter on the GHL trigger, then on the engine workflow's page press **Go live** in its mode control
(company · shadow · test · live), or `POST /api/admin/workflows` with `{ "company": "hair", "workflow": "<slug>", "mode":
"live", "by": "Tyler" }`. It is refused with the reasons when the workflow is not ready (Slack not connected for one that
posts, a missing setting); its runs born before live are cleared, so nobody already in the GHL workflow gets a second
copy from the engine. The list then reads "Live (this workflow)" against "Test (company)" for the rest. Undo is the same
control: **company** (or `"mode": null`) puts it back on test. Every change is in the audit log. The test harness refuses
to stage a fact for anyone but a test contact while any workflow is live on its own.

## 41. Queue after the switch-over (2026-10-12)

- Team roles on the dashboard Setup page (closer, setter, manager, owner, staff); today only the install file sets them.
- "Try it": run any workflow on a GHL test contact or a made-up one (email, phone, any variables), nothing sent.
- The AI on each page and a general one: build and change workflows by asking; every change a version, rollback.
- Settings page that says what each setting does.
- From the Top 20 (Oct 10), Tyler's picks: 1 revenue leak report, 3 closer scorecards, 4 objection library, 5
  source-to-cash ROI, 7 speed-to-lead alert, 8 follow-up hygiene, 9 cash forecast, 11 buyer's-remorse warning, 12
  capacity planning, 14 commissions (a commission tracker), 16 post-call follow-up draft, 18 owner's weekly digest.
  Coaching (3, 4) may live in CloserMetrix instead. Recommended before texts go live: 20 opt-out guard.
- Operator actions the AI can run with a confirmation: onboard / offboard a person (GHL user and calendars, Calendly
  invite, Slack channels once they've joined, roster, welcome email; Fathom and Slack invites stay manual off Enterprise
  Grid), booking links with UTMs ("a link for Instagram"), GHL calendar booking windows; Calendly's to verify.
- Delete James's test tasks in GHL; the Tyler TEST / Test * records when testing is done.
- An outside check that pages if the engine hasn't ticked in 5 minutes.
- Ask the AI what a workflow sends ("what text goes out 2 hours before the call?") and change it by asking ("change it
  to say …"), a new version each time. Not from Slack (Tyler, Oct 12): on the dashboard's AI.
- The interactions and commands doors answer 500 to a company id that is not a uuid; a 404 is the right answer.

## 42. Done on Hair 2026-10-13 (kept for the record)

- Apply D96: `POST /api/admin/templates { "company": "hair" }`, then confirm Daily/Weekly/Monthly wrap-up are on in
  test and the old Wrap-ups is off (`workflow.replaced` in audit_log).
- James's EOD listed Calvin Coates twice. Find which: (1) his engine booking plus a blank GHL Sales Call the form did not
  match to it (`closerSalesCalls` matches by person and exact minute; a moved call breaks that), (2) two held bookings
  that day, or (3) two Sales Call records. Fix that cause, add "one person once per closer per day" with a test, and
  check his outcome landed on the right record.

## 43. Onboard PMU (2026-10-13)

Tyler's answers: PMU is its own GHL account (not a sub-account of Hair's); booking is Calendly; Slack: a new app "PMU Ops
Engine" in Tyler's workspace, #ops-test only until the switch-over (each client gets its own workspace later); Carly is the
only closer, a second is being onboarded. Goal: a fully onboarded PMU, used in place of its GHL automations, climbed
shadow → test → live one workflow at a time like Hair. Open: how PMU takes payments (Whop? Stripe? GHL?), whether calls are
recorded in Fathom.

The session's environment carries `BIAB_CRON_SECRET` (operator key), `PMU_GHL_LOCATION_ID`, `PMU_GHL_PIT`,
`PMU_CALENDLY_TOKEN`, optionally `PMU_FATHOM_API_KEY`. Never write their values into the repo.

1. Create PMU in shadow, every workflow off (`POST /api/admin/install`, slug `pmu`, the location id and PIT, timezone from GHL).
2. Explore read-only and report to Tyler: GHL pipelines and stages, custom fields, custom objects (a Sales Call? a Payment?),
   users, tags, every GHL workflow (what the engine will replace), forms; Calendly event types, hosts, booking questions;
   Fathom recorders. What exists, what is missing, what has to be built in GHL by hand.
3. Write PMU's install file from that into the repo (`platform/installs/pmu.json`, no secrets: tokens come from the
   environment at install time) and re-install with it; `POST /api/admin/templates` for later template changes.
4. Slack: write the "PMU Ops Engine" app manifest (request URLs with PMU's company id), Tyler creates and installs it, then
   connect it (install `slackToken`, `slackSigningSecret`, channels → #ops-test).
5. Readiness, health, then the ladder with Tyler.

**State (2026-10-13, end of day):** steps 1–3 done. Payments are Whop (the engine registered its own webhook); calls are
recorded in Fathom (webhook registered). Tyler's decisions: one board (Beauty Moguls) with no setter board, bound as the
closer board only; PMU's own copies of ten workflows (`platform/installs/pmu/`, saved with
`POST /api/admin/workflows/definition`; Hair's untouched) move the one card through New Lead → Booked Call (named
`-- Direct` / `-- Setter`) → Confirmed / Unresponsive → Rescheduled / Canceled / No Show → Follow Up / Lost / DQ → Purchase
→ Signed Contract (won). A lead has a phone or a `vsl a` / `vsl b` tag. Demo calls are their own call type and the Sales
Call says Closing or Demo (internal tracking: either call can sell either offer). Sales Call dispositions are Closed,
Deposit, Follow Up, Lost, DQ (after the pitch, e.g. financial) and No Offer (DQ before the pitch); Closer is a Carly /
Annabelle dropdown; Booking Source (Setter / Direct) and a Scheduled outcome were added. The Jev key is Hair's, copied
inside the engine (D100); the Anthropic key is PMU's own.

Still open:
- Tyler: delete the old Sales Call options in GHL (the API can add options but not remove them): Closer `carly_vu`;
  Disposition `closed_paid_full`, `closed_deposit`, `closed_payment_plan`, `not_qualified`, `no_offer_made`.
- Tyler: create the PMU Ops Engine Slack app from `installs/pmu-slack-manifest.yaml`, send the bot token and signing secret.
- The agreement goes out on every first payment (only the $10k program sells today). When the smaller offer exists under
  its own Whop product name, PMU's Payment recorded copy sends the agreement only for the program's product.
- Consultation S has no "who set this" booking question: a setter-booked call's setter reads "unknown" until it has one
  (before Annabelle starts setting). Since D121 each such booking is also an engine error alert ("Setter-booked call with no
  setter"), so add the question first.
- MQL / DQ: PMU qualifies by the `meta booked call mql` / `meta booked call dq` tags (a Zap sets them), not a field; the
  numbers' MQL split needs to read the tags.
- **Messages (blocks test/live):** PMU's copies carry the template copy. The pre-call reminders are placeholders, and
  Deal closed's welcome email and text are Hair's ("save your hair"): the shipped template holds Hair's words. PMU needs
  its own words on every send (pre-call, no-show, cancellation, post-call, reactivation, speed to lead, welcome), saved
  as PMU's copy edits. Separately: a shipped template should carry no client's words (placeholders instead), but
  changing deal-closed's would upgrade Hair's untouched copy to placeholders, so Hair's words become Hair's own edit first.
- Annabelle: add her to the roster (`closers` or `roles`) when she starts; her Closer option already exists.
- Switch-over: PMU's Whop also posts to three Zapier hooks, Make, Pabbly, a GHL trigger and strategicpartners.io; the ones
  that write Cash records retire with PMU's GHL automations.

## 44. Onboard Dating Nelly, the pilot dating offer (2026-10-16)

Tyler: the first of many dating and relationship offers, so the setup is generic and re-runnable (a small setup file per
company, no code change). Built ADDITIVELY in the RapidCloser GHL location, an existing account with another business in it:
create only, never rename, change or delete what is there. It moves to its own GHL account later by re-running the same
setup script there and importing the contacts. Fully ghost (shadow) until then. RapidCloser's A2P covers RapidCloser's own
use, so no texts go to dating contacts from its number.

Decisions:
- The engine acts only on contacts tagged `dating` (D117, a company scope tag) and on anyone who books a Dating calendar.
  Tyler adds `dating` by hand to the ~200 contacts he imports from a CSV.
- Same model as Hair: a setter pipeline (New Lead, Direct Booked, Appointment Set, Showed, Cancelled, DQ, Not Interested)
  and a closer pipeline (Scheduled, Cancelled / No Show, Follow Up, Agreement Sent, Closed Won, Lost, Disqualified).
- Contact fields: appointment date, setter, cash collected, revenue generated, the UTMs and fbclid. Opportunity fields:
  setter owner, stage entered.
- Custom objects: Dating Sales Call, Dating Payment, Dating Discovery. Sales Call closer options: Nelly, Mitch.
- Bookings: Nelly's Calendly since D123 (2026-10-17; below). Before that, GHL calendars, assigned to Mitch until Nelly was a
  user, now Nelly's (D121), in the calendar group "Dating – Nelly" (still built, unmapped since D123):
  - Strategy Call (Direct), 45 min, self-booked closer call;
  - Strategy Call (Setter), 45 min, setter-booked closer call;
  - Triage Call, 15 min, the setter's qualifying call (a downsell, or a lead not yet worth a full slot).
- Contract value $5,000 by default; deposits $100–$500; payment plans to come. Slack bot: "Ops Engine" (no workspace yet).

**State (2026-10-16):** the GHL side is built in RapidCloser by `scripts/provision-ghl.ts` from `installs/dating/ghl-setup.json`
(two pipelines, 12 contact/opportunity fields, the three Dating objects with their fields and 5 associations, three calendars
on Mitch). Dating Nelly is installed (`installs/dating-nelly.json`, slug `dating-nelly`): shadow, SMS off, every workflow off,
scope tag `dating` (D117). After its first poll it held 0 contacts, 0 events, 0 runs. D118: the templates now write her
objects and option keys (`salesCall.objections`, `salesCall.closerOptions` in her install file), and her own Deal closed and
Setter call logged (`installs/dating-nelly/`, built from `words.json`) replace Hair's words with marked placeholders that send
nothing. Applied 2026-10-16 (templates, settings, prompts, both copies saved): still shadow, every workflow off.

Tyler, 2026-10-16:
- A deposit is not a close; the two are different (settled: D119).
- He gets the Anthropic key and the agreement later.
- Keep Call booked's "send a personalized video" task.
- He invites Nelly to RapidCloser's GHL.

Still open:
- Calendars to Nelly (D121, built 2026-10-16, not applied): Nelly is a RapidCloser GHL user (Nelly S.,
  nellysudri@gmail.com, `2BnOPqPK68aqZ9QBIK6B`). The setup file now gives the three calendars her as their team and puts
  them in their own calendar group "Dating – Nelly" (slug `dating-nelly`). Dry run on RapidCloser: make the group; on each
  calendar the team Mitch Sapoff → Nelly S. and into the group; nothing else. Apply: `provision-ghl --apply` (only the group
  is created; only the three calendars are PUT, with only their team and group). Still to come: the setter as a GHL user
  (name and email to come).
- The Typeform (D122, built 2026-10-16, not installed): the "VIP Matchmaking Application" (`AjY7UfXZ`) straight into the
  engine, no Zapier. Each answer to a contact field "Dating – …" in the folder "Dating – Application" (19 new fields in the
  setup; choices as TEXT, age NUMERICAL, the long answer LARGE_TEXT, the submission time and the response id), name, email
  and phone to GHL's own fields, the six hidden UTMs to the existing UTM fields, the tag `dating`, `form.submitted` with the
  person in scope; a new person is a new lead once. Shadow records the would-be write. To do, in order:
  1. Fields: `provision-ghl --apply` on RapidCloser (dry run: the folder and the 19 fields, nothing else). The contact folder is
     made by an undocumented call (D122); if the apply says `blocked`, make "Dating – Application" in GHL by hand and move the
     19 fields into it. Copy the 19 `field_contact_app_*` ids from `--out` into `installs/dating-nelly.json`'s `crm`.
  2. Install: re-install Dating Nelly with that file plus `typeform.token` (DN_TYPEFORM_TOKEN). It checks the map against the
     form and registers the webhook; the setup page and Health check show it.
  3. Import, last, when Tyler approves: `POST /api/admin/typeform-import { company: "dating-nelly", form: "AjY7UfXZ" }` (dry run),
     then with `apply: true` until `remaining` is 0. Dry run 2026-10-16: 285 responses, 282 people, 281 new to GHL, 1 matches a
     RapidCloser contact by email, 3 applied twice.
  - Booking-card lines from the answers: not done (a `bookingCard.intake` line per field once Tyler says which).
  - Qualification (MQL / DQ) from the answers: not decided (D73's `qualify` is the place).
- With GHL calendars, a setter-booked call does not say who set it. Since D121 that is an engine alert per booking
  ("Setter-booked call with no setter: …. Say who set it"), cleared when the contact's Setter field is filled in GHL or a
  setter's dial set the booking (D87); in shadow too, but Dating Nelly's Health check is off, so it shows on the dashboard,
  not in Slack, until Health check is on. Still: the setter calendar needs a "who set this" booking
  field, or Calendly.
- Fathom: done 2026-10-16. Nelly records in her own account (nellysudri@gmail.com; Tyler: "we're using the other one now",
  blushtheapp.com is not used); the engine registered its own webhook from the key (`fathom.webhook_id` 8-RzsD2yJmHqCZL_).
- Payments: Whop, with a deposit product whose name has the word "Deposit" (D119 addendum; no ids to declare), once it is set up; the agreement template and sender (Deal closed
  needs paid and signed); the Anthropic key.
- Tyler's words for `installs/dating-nelly/words.json`: welcome email subject and body, welcome text, the setter DQ wording
  and reasons (D118). Then build and save the copies again.
- Nelly's email in `salesCall.closerOptions`: done (`installs/dating-nelly.json`, and the setup's skeleton since D121); the
  setter's too if one closes.
- Deposits (D119, built 2026-10-16, for Hair, PMU and Dating Nelly alike; not applied yet). To apply, per company:
  - Templates: `POST /api/admin/templates` upgrades the untouched copies of Call outcome filed, Payment recorded, Deal
    closed, Unsigned agreement chase and the three wrap-ups (Hair: Call outcome filed is live, its change is only the
    deposit branch). Dating Nelly: save her rebuilt `installs/dating-nelly/deal-closed.json`. PMU: save its rebuilt
    `installs/pmu/call-outcome.json`, `payment-recorded.json`, `deal-closed.json` (dry run first). Run the migration.
  - Deposit products: by name (D119 addendum, 2026-10-16), no ids to declare. Tyler names each company's deposit product
    (or its plan) at Whop with the word "Deposit" ("Deposit", "VIP Deposit", "Deposit - $250"); a payment for it is a
    deposit. The product's name is the safer place: Whop's payload is proven to carry it (`line_items[].product_title`),
    and plans have no title unless one is given. PMU's archived "DEPOSIT" product (`prod_PR9AINNIxjRFV`) qualifies once it
    is sold again; its $100/$250/$500 plans on Beauty Moguls Method do not unless titled with the word. Hair has no deposit
    link yet; Dating Nelly has no processor yet. Each company's Whop key should stay bound (`secret.whop_api_key`): a payment
    that comes without the names has them read from Whop, and without the key it raises a "could not be checked" alert.
    `depositProducts` still works and, declared, is the whole truth for that company.
  - The Deposit stage and `crm.stage_closer_deposit`: Dating Nelly by re-running `provision-ghl --apply` on RapidCloser
    (adds Deposit after Follow Up), then binding it; PMU's Beauty Moguls board and Hair's closer board by hand or a PUT
    of the whole stage list (Tyler's call); until bound, a filed deposit leaves the card where it is.
  - The Sales Call Deposit option: PMU and Dating Nelly have `deposit` and declare it; Hair's Outcome field has none (by
    every sign; its options could not be read from here): until it is added in GHL and `"deposit": "deposit"` is added to
    Hair's `salesCall.dispositions`, a deposit Hair files empties the Outcome.
  - The numbers read deposits from GHL Payment records of type `deposit`. The only one the engine wrote on Hair is the
    Oct 12 $1,500 test (a test contact, counted nowhere); a Payment record GHL's own automations typed `deposit` (the
    $750 of Oct 5 was not the engine's) would count as a deposit: check Hair's before trusting the line.
- RapidCloser's own GHL workflows: Tyler checks "Appointment Created", "SWS | Presuasion Call Booking Sequence" and anything
  on Contact Created or Tag Added (Enagic SMS WF, Enagic Email Campaign, Trigger Link Click [ANY]) before the CSV import, and
  that none triggers on the engine's stat-/seq-/meta tags before anything goes test or live.

Tyler, 2026-10-16, on MQL / DQ: "I don't think we want them fully disqualified, even if they say no to coaching… we have
so few leads, we don't really want to burn any right now… later on, those are really good metrics for DQ / MQL." So no DQ
for Dating (Nelly) now: everyone is worked; a lead that looks weak goes to the 15-minute Triage call (the setter's) to find
out. To settle with Tyler: lead tiers from the application answers (income, what they want, openness to coaching) that
route the call (strategy vs triage) and give the numbers their MQL / DQ split later. State: the Typeform webhook is
registered (`biab-dating-nelly`, D122); the 19 application fields are in the GHL folder "Dating – Application"; the
response import (285 so far) waits for Tyler's go, last.

Tyler, 2026-10-16 (later):
- The form's consent question is now required (made through the Typeform API; nothing else on the form changed).
- The booking card shows age, based in, income, looking for, biggest challenge and wants (`bookingCard.intake`).
- An existing GHL contact who applies keeps its name, email and phone; only blanks are filled.
- **TODO:** the form's "Not now" path ends on Typeform's own "create your own typeform" screen (153 of 275 responses).
  It should probably go to the Triage call link instead; do not change it until Tyler says.
- Nelly's Calendly token: given (`DN_CALENDLY_TOKEN`); see D123 below.

**Tyler, 2026-10-17 (D123, built, not applied):** bookings move to Nelly's Calendly, two event types mapped: the Complimentary
Dating Strategy Session (call type "Strategy session", the Typeform's link and the self-book link) and the Private Dating
Consultation (call type "Consultation", the closer call); nothing else (the 15-Min Discovery Call and the Private Dating Strategy
Call wait for a setter triage). Her own workflows, built by `build-copies` from `installs/dating-nelly/copies.json`: *Triage call
booked* (a Strategy session: Call booked's steps, `stat-triage-first`, the Sales Call's call type `strategy_session`) and *Sales
call booked* (a Consultation: Call booked's steps, call type `closing`), both with one card fork, a new booking or a reschedule, as PMU's, take Call booked's place; *New from Typeform* tags an
applicant `dating` and starts New lead once (the door no longer does either). The importer can run applicants through it
(`newLead`). Apply, in order (every workflow stays off; Dating (Nelly) stays in shadow):
  1. Deploy (the build migrates: `workflows.takes_over`).
  2. GHL: `provision-ghl --setup installs/dating/ghl-setup.json --pit-env DATING2_GHL_PIT --location-env DATING2_GHL_LOCATION_ID
     --out <file> --apply` (dry run 2026-10-17: only `call_type` gains `strategy_session`; 109 exist).
  3. Remove her Call booked (off, 0 runs): `DELETE /api/admin/workflows { company: "dating-nelly", workflow: "call-booked" }`.
  4. Make her three workflows, dry run first: `POST /api/admin/workflows/definition { company: "dating-nelly", workflow: <file's
     name>, definition, note, create, dryRun: true }`, then without `dryRun`, for `triage-call-booked.json`,
     `sales-call-booked.json`, `new-from-typeform.json` (made OFF). Before the re-install: from now on install skips Call booked.
  5. Re-install: `POST /api/admin/install` with `installs/dating-nelly.json` plus `booking.token` = `DN_CALENDLY_TOKEN`. It binds
     the Calendly token and organization, maps the two event types (their call types made), turns the GHL calendars inactive,
     re-PUTs the Typeform webhook with the same tag and secret (no change at Typeform), and says "call-booked → not installed". The
     first poll after it takes the ~99 bookings in the window (97 active, 2 cancelled; 87 ahead) as a silent baseline: replicas
     only, no event, no run, no tag.
  6. Import with New lead, last, when Tyler says: `POST /api/admin/typeform-import { company: "dating-nelly", form: "AjY7UfXZ",
     apply: true, newLead: true }` until `remaining` is 0, with New from Typeform and New lead turned on (in shadow) first, or the
     runs start nothing.
  Open: a booker who is not in GHL (in shadow, every applicant until the import's real write) leaves Triage call booked paused at
  "Wait for GHL to have the person" after an hour; the Sales Call option `closing` is still labelled "Strategy Call" in GHL (a
  rename by hand, if wanted); Pre-call sequence takes both types (both closing): reminders for the 15-minute session too.

- Nelly's Calendly token: later.

Tyler, 2026-10-17: "for this client I want nothing to post if nothing happened." Built (D124, not applied): install key
`quietWhenEmpty` (`reports.quiet_when_empty`); the three wrap-ups and the Weekly leaderboard post nothing on a scheduled run
with nothing in it, by their own numbers. Her install file has `"quietWhenEmpty": true`. Apply: re-install Dating Nelly with
it (or `bindings/set` the one key), then `POST /api/admin/templates { company: "dating-nelly", templates: ["daily-wrap-up",
"weekly-wrap-up", "monthly-wrap-up", "weekly-leaderboard"] }` (her four copies are untouched, so they upgrade).

Synthetic journey, test mode, 2026-10-17 (`nellytest1@jtylerray.com`, harness D125/D126): form → Strategy session → reschedule →
cancel → Consultation → recording → outcome Deposit $250 → deposit paid → balance $4,750 → agreement → signed. Every step ran the
expected workflow once; both cards ended won, the Sales Call record closed_won with $5,000, the stat tags all on. Found:
- The bot lacks `groups:read`, so every step posting to the private ops-test channel is red in Health check (missing_scope; the
  posts themselves land). Manifests fixed; Tyler adds the scope in the Slack app and reinstalls it.
- Payment recorded is off (no `crm.agreement_template`): a payment posts nothing and makes no Dating Payment record. Turns on
  with the agreement template.
- Both won cards hold $0: no workflow sets a card's value, for any company, yet the GHL won-card numbers (`ghl-metrics.ts`, the
  closes list) add it up. Open question for Tyler: should Deal closed set the closer card's value (cash or contract)?
- Deal closed's welcome email (placeholder copy) to the test address waits for 8 AM PT quiet hours.
- Calendly's "Complimentary Dating Strategy Session ♡" shows no open time in the next 7 days (Health check, yellow).
- The staged recording's transcript is hair-themed (the harness's one transcript), so the AI review reads it as a close.
