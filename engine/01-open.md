# Engine — open questions

Ordered by how much downstream work they block.

---

## 1. Node type catalog (blocks the schema)
The set of node types is the engine's instruction set. Adding one later is easy; changing
what one *means* after runs exist is not. Current candidate set:

`wait` · `send_sms` · `send_email` · `check_condition` · `set_field` · `add_tag` ·
`remove_tag` · `move_stage` · `assign_owner` · `create_record` · `http_call` ·
`handoff_to_workflow` · `exit`

Open: is `handoff_to_workflow` a node or a trigger on the receiving workflow? A node is
simpler to read in the editor; a trigger keeps the coupling one-directional and lets the
receiving workflow change its entry conditions without the sender knowing. **Recommend
trigger** — the sender emits an event, the receiver decides whether to care.

## 2. Event bus shape (blocks triggers)
Triggers match on events. Where do events come from?
- GHL webhooks (appointments, payments, tags) — which ones are available, and which are
  only available on paid tiers?
- Our own forms (D8) — direct, trusted.
- Our own scheduler (time-based triggers, e.g. reactivation sweeps).

Open: one normalized `events` table everything writes to, or triggers matching against
source-specific tables? **Recommend one normalized table** — it's what makes the
"see it flowing" UI possible without a per-source special case, and it gives the
reconciliation sweep (D5) one place to look.

## 3. Condition expression format (blocks the editor)
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

## 7. What is "Jev"?
Tyler: *"we can use Jev for a lot of this too. for any routing for what to do or what happened
so we're not relying on LLMs."* I don't know what this is and I'm not going to guess — asked.
The principle behind it is already locked as D5c (deterministic routing for structured facts,
semantic calls only for natural language); this question is only about whether Jev is the
specific tool that implements it.

## 8. Template versioning UX
D2 requires knowing which instances are behind a template and whether they've diverged. Open:
is a divergence a blocking state (can't take template updates until resolved) or an advisory one
(update anyway, keep a backup)? **Recommend advisory with an explicit diff confirmation** —
blocking means a client's small tweak freezes them out of every future fix.
