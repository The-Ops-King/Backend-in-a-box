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

## 16. Scheduler claim semantics on Vercel
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
