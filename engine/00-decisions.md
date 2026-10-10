# Engine — locked decisions

Decisions made and not up for re-litigation. Anything still open is in `01-open.md`.

---

## D1. Tenant isolation — nothing but templates crosses

**Rule:** no contact, no content, no recording, no transcript, no metric, no row of any
kind moves between clients. The *only* thing that crosses a client boundary is a
**template** — a workflow definition with every literal replaced by a variable (see D3).

This kills, by design:
- cross-client benchmarking as a client-facing feature
- "customers like you" style suggestions
- any shared model, index, or cache built on client content

**The one carve-out, stated precisely so it doesn't drift:** Tyler, as operator, can read
across tenants for operations and his own business visibility. That is *read access held
by a person*, not a data flow between tenants, and it never becomes a feature, an export,
or an input to anything a client sees. Operator read access is disclosed in the agreement.
If a cross-client number ever needs to appear in a product surface, that's a new decision
with a new data clause — not an extension of this one.

**Visibility is a role, not a boundary.** Client A can never see Client B — that's absolute.
But *within* the platform there will be tiers: operator (Tyler, everything), agency, admin,
sales manager, closer. Those are roles with scopes, decided per deployment.

**Therefore: one shared database with Postgres row-level security, not a database per tenant.**
This is the hardest decision here to reverse, so the reasoning:

- Database-per-tenant gives maximum isolation but makes every cross-tenant read a fan-out.
  Operator views and any future agency roll-up become genuinely hard, not just tedious.
- Shared database with RLS policies on the tables means isolation is enforced *by the
  database*, not by every query being written correctly. A forgotten `WHERE client_id = …`
  returns zero rows instead of leaking. That's the difference between isolation as a
  property and isolation as a habit.
- A roll-up for an operator or agency role is then a scope change on the same query.

The RLS policy is the security boundary. It gets written once, tested with an explicit
"can role X read client Y's rows" test suite, and never bypassed by application code.

**Agreement clause needed from client one:** processing their data to operate the systems,
operator read access for support, recordings and transcripts never leaving their tenant,
and no use of their data for any other client. Cheap to write now, impossible to retrofit.

---

## D2. Copy on install — every client owns their own workflows

**Decided by Tyler, 2026-10-06, overruling an earlier shared-definition model.**

A template is a source. Installing it **copies** the definition into that client's tenant.
From that moment the copy is theirs: they can insert, delete, and reorder steps, and nothing
they do touches any other client.

```
Template:  A B C D E F G
Client 1:  A B C D E F G        (copy, untouched)
Client 2:  A B C D Z E F G      (copy, locally edited — Client 1 unaffected)
```

This is right. Clients will edit their workflows, and a shared definition means any edit is
a blast radius. Per-client overrides on a shared definition would work in theory and would be
a nightmare to reason about in practice — you'd never be able to look at one row and know what
actually runs for a given client.

### The cost, named: template drift
Copy-on-install has one well-known failure mode. Fix a bug in the no-show template and twelve
clients still have twelve copies of the bug. There is no propagation, by design. At 6–10 clients
that turns into twelve separate codebases unless it's handled up front. So it is:

Every instance records:
- `template_id` and `template_version` it was copied from
- `diverged` — whether it has been locally edited since the copy
- `diverged_at` + the diff from its source version

When a template is fixed and published, the dashboard answers one question: **which instances
are behind?** Then:
- **Not diverged** → one click re-copies to the new version. Safe, because the client never
  touched it.
- **Diverged** → side-by-side diff. Human decision, with their edits visible so they aren't
  silently reverted.

**Tyler's call on the remedy (2026-10-06): no one-click update UI.** Fixes get applied across
instances by AI-assisted bulk edit — read N definitions, apply the transform, write back — on
the condition that it never alters the actual flow of any given client.

The bookkeeping above still gets built, because it's what makes that possible: definitions in a
consistent machine-diffable format, a `diverged` flag so edited instances get human eyes, and a
mandatory dry-run diff per client before any write. The UI is what we're skipping, not the
version tracking.

### Custom work becomes a template by promotion
Build something bespoke for one client, then promote it: walk its literals and replace each
with a `{{variable}}`, which produces a manifest (D3). The definition goes to the library.
The values stay in the client's tenant. This is the only path from custom work to template,
and it's the reason strict isolation (D1) costs nothing — the thing worth reusing was never
the data.

## D3. Zero hardcoded values — manifest-enforced

Every key, ID, phone number, calendar ID, URL, and credential reference in a workflow
definition is a `{{variable}}`. Not a convention — enforced:

1. Saving a definition extracts every `{{...}}` into its **manifest**.
2. A workflow **cannot be enabled** while any manifest key is unbound for that client.
3. Bindings live in a per-client `bindings` table, encrypted at rest.

Two payoffs, both load-bearing:
- A template ports between offers by rebinding, with no edit to the definition.
- **The install form is the generated union of every manifest being installed.** That is
  where "installs take hours, not days" actually comes from. Hand-written onboarding forms
  drift from reality; a generated one can't.

---

## D4. Workflows branch. Every client owns their copy. Triggers sit at the top.

Third pass on this one, so stated carefully.

**Branching inside a workflow: yes, and required.** A `branch` node has N labeled outgoing
edges, each with a condition — if X go here, if Y go there, if Z go there. The reply workflow
(D13) is one workflow with a four-way branch after the classifier, not four workflows. A
`check` node is the two-way case (continue or exit).

**What was rejected, precisely:** one workflow *shared across clients or offers*, with every
client's contacts flowing through the same graph and diverging only where their paths differ.
That is out, and copy-on-install (D2) already rules it out — each client has their own copy and
branches inside it however they like. The copy boundary is between clients. Inside a client's
copy, branch freely.

**Triggers are the nodes at the top of the workflow**, exactly as in GHL. A workflow can have
several. Concretely, at Save Your Hair: the "Booking confirmation" workflow has one trigger
on top reading *New appointment booked on calendar {{calendar.hair_consult}}*. That's it. The
event arrives (delivery path in D9), the engine matches it to that trigger, a run starts.

Under the hood each trigger is a row so the engine can ask "which workflows care about this
event?" with an index lookup instead of scanning every definition. That is a performance detail.
Nobody edits a trigger table; they edit the top of the workflow.

### Re-entry policy, required per workflow
A contact can trip two triggers on the same workflow. Each workflow declares what happens:

| Workflow | Policy | Reason |
|---|---|---|
| Speed to lead | `once_per_contact` | A lead is new once. |
| No-show recovery | `once_per_appointment` | Keyed on `appointment_id`; a later no-show runs again. |
| Reactivation | `once_per_contact_per_90d` | Repeatable, not a loop. |
| Payment failed | `always` | Every failed charge gets its own chase. |

Missing policy = double-texting the same person off two triggers.

---

## D5. Durability — a 20 minute outage means late, never lost

Non-negotiable, because we're taking orchestration off GHL and onto our own box, which makes
us the single point of failure for N companies' sales operations at once.

- **Run state in the database, never in memory.** `runs.next_run_at` is the clock. The
  scheduler asks for every run whose time has passed, so an outage delays sends instead of
  dropping them.
- **Idempotency key per send.** A retry after an ambiguous failure cannot double-send.
- **Reconciliation sweep** on a slower cadence, independent of webhooks: re-read source
  state (appointments, payments, tags) and fix any run whose world moved while we were down.
  Webhooks are an optimization; the sweep is the correctness guarantee.
- **In-flight runs pin their version** (`runs.version`). Editing a workflow never strands
  someone on a node that no longer exists.
- **Quiet-hours clamp on every scheduled send.** Recovery from an outage must not deliver
  six hours of backlogged texts at 3am.

### D5a. Render at send time, never at queue time
The "your call is in 60 minutes" problem: if the step was queued at T-60 and fires 20 minutes
late, the stored text is now a lie.

**The fix is not intelligence, it's when the string is built.** A node stores the *template*
(`Your call is in {{time_until_appointment}}`) and every variable is resolved at the moment the
send actually fires. A 20-minute delay then self-corrects with nothing clever involved. Storing
rendered text is the actual bug; an agent patching bad numbers afterward is a bandaid on it.

**Deliberately imprecise, because precision reads like a robot.** The duration formatter takes
a mode and rounds:

| Mode | Behavior |
|---|---|
| `minutes` | nearest 5 — 23 min renders "about 20 minutes" |
| `hours` | nearest half hour — "in about 2 hours" |
| `auto` | minutes under an hour, hours under 4, then "tomorrow at 2" |

Per-node setting, so a 10-minute warning can be exact while a 3-hour heads-up stays loose.

**The formatter refuses to render a non-positive duration.** It throws rather than producing
"in -30 minutes," which makes the bug below impossible to ship by accident — the node's
staleness policy catches the throw. Belt and braces: the formatter can't emit nonsense, and
the policy decides what to do instead.

### D5b. Validity windows, premise re-check, and recovery mode

Re-rendering handles small delays. A three-hour outage needs more, because by then the message
may be not just wrong but absurd. Three mechanisms, in the order they run at fire time.

**1. Premise check — is this run's reason for existing still true?**
Before any node executes, the run re-reads the fact it was started over:
- A reminder run → does the appointment still exist, and is it still in the future?
- A payment chase → is it still unpaid?
- A speed-to-lead run → is the lead still unworked?

If the premise is dead, **exit the run** with a reason. Don't skip one node and march the run
through five more stale ones. This is the mechanism that actually answers the three-hour
downtime case: the run doesn't send a bad reminder because the run is over.

**2. Validity window — per node, declared by what the message says.**

| Anchor | Example | Valid |
|---|---|---|
| `before_event` | "your call is in 30 minutes" | queue time → `event − min_lead` |
| `after_event` | "sorry we missed each other" | `event` → `event + max_lag` |
| `unanchored` | "checking in" | any time, quiet hours only |

A `before_event` node whose event has passed is outside its window by definition. That's a
property of the copy, not a guess.

**3. `on_stale` — what to do when outside the window**
- `skip` — log it, move to the next node. Right when a later node covers the same ground (a
  blown 24h reminder when the 1h reminder is about to fire anyway).
- `substitute` — send a different template appropriate to now. "Your call is in 30 minutes"
  becomes "Sorry we missed each other, here's my link."
- `escalate` — send nothing, notify the owner in Slack. Default for anything money-related.

**Recovery mode.** If the last successful scheduler tick is older than a threshold, the engine
treats the backlog differently from normal operation:

1. Run the premise check across every overdue run **first, in bulk**, and exit the dead ones
   (`exit_reason: stale_after_outage`) before any send is attempted.
2. Process the survivors normally, through windows and quiet hours.
3. **Rate-limit sends during drain.** Three hours of backlog released at once reads as spam to
   recipients and as a spike to carriers, which risks filtering. Drip it.
4. **Post an outage report** to Slack: runs resumed, runs exited stale, sends suppressed. The
   failure mode to avoid is a silent recovery where nobody knows what never went out.

### D5d. Send window — defer forward, then re-check
Every client binds a send window and timezone via the manifest (e.g. 8:00–20:00
`America/Phoenix`). A send that lands outside it is **moved forward** to the next open minute —
never backward, never dropped.

Order of operations at fire time, because these compose: quiet-hours defer first, **then** the
premise check and validity window are evaluated *at the deferred time*. A "your call is in an
hour" reminder for a 7am appointment wants to go at 6am; the window pushes it to 8am; by then
the call is in the past; the premise check exits the run instead of sending nonsense. Each
mechanism does one job and the ordering makes them agree.

The "has this already happened, or is this now moot?" check is **always on** for every run.
It's not a per-node option.

### D5c. Three tiers of decision-making, and Jev owns the middle one

| Input | Question | Tool |
|---|---|---|
| Typed data | A comparison | **Code.** `payment_status = failed`, `total_collected >= contract_value` |
| Natural language | A typed decision | **Jev** (TypeSafe AI) — classifier, not a text generator |
| Anything | Produce prose | **Generative LLM**, rarely — most of our copy is templates |

**Why Jev for the middle tier rather than a prompt to a frontier model.** It's discriminative:
you send a `state` plus typed questions and it returns probability distributions — `noul`
(boolean), `choice` (unordered options), `score` (ordered scale). No token generation, so
70–500ms and 40–400x cheaper than a frontier model on comparable work.

The property that actually matters here is **calibrated confidence**. A routing decision can
have an explicit "below threshold → ask a human" path instead of accepting a confident-sounding
guess. That's a better design than a prompt returning bare yes/no, not just a cheaper one.

Where it fits in this system:
- Closer's free-text disposition note → `choice` over our controlled outcome vocabulary (D8)
- Inbound SMS reply → `noul`: is this a confirmation? a cancellation? Routes the reminder flow
- Objection category from a call transcript → `choice`
- Lead quality from form free-text → `score`

**Never for typed comparisons.** `appointment_status = noshow` is an equality check. A model in
that path adds latency, cost, and nondeterminism and buys nothing.

**Never keyword or substring matching for meaning.** If the input is prose and the question is
meaning, it's a Jev call. String matching on semantics is always wrong.

---

## D6. GHL is the send channel, not the orchestrator

Verified — see `../ghl/02-api-facts.md`. `POST /conversations/messages` with `contactId`
sends SMS and email, lands in the contact's thread, and is attributable to our integration
via `meta.marketplace.appId`. Everything stays visible inside the CRM the client already
logs into.

**We do not use GHL's `scheduledTimestamp`,** even though it works and cancels cleanly. Our
scheduler owns timing. Two systems holding the same pending send means every exit condition
has to cancel in both places, and the first one missed texts "you still haven't booked" to
someone who booked.

SMS requires a purchased number per sub-account. Email needs no provisioning.

---

## D7. Offboarding — leaving is possible, staying is obvious

Three tiers, deliberately separated:

| | What it is | Price |
|---|---|---|
| Managed | Tyler operates and keeps building | $2–3k/mo |
| Hosted | Automations run; client edits them in the visual editor | $500/mo |
| Ended | 30-day runway, then off | — |

On termination of management the client gets, at no charge:
- **~30 days of continued runtime**, so nothing breaks the day Tyler stops.
- **A readable export of every workflow** (PDF per workflow, plus the machine-readable
  definition) and their own data.

**Visibility is never paywalled.** Seeing the automations run is *how* a client feels how
much is running; hiding it makes the system look smaller than it is. The retention mechanism
is that staying is cheap and easy, not that leaving is punished.

Why the runway and the export matter commercially: without them, "stop paying and I turn it
off" is the objection a sharp buyer raises at signing. With them, there's nothing to raise.
Neither one costs anything, and neither one makes leaving attractive — rebuilding working
automations from a readable spec is still weeks of someone else's work.

---

## D8. We host the forms

Forms live on our infrastructure, not GHL and not Typeform, for internal forms
(call disposition, EOD recap). Consequences, all good:

- **We own the schema.** Disposition values, outcome enums, and stage names come from one
  controlled vocabulary instead of per-client freeform text — which is the only reason any
  future reporting works at all.
- No GHL-form-writes-to-contact-field-then-a-workflow-copies-it-to-the-object dance. The
  form writes the Sales Call record directly.
- One link in Slack per call, or one EOD form listing everything outstanding.

**Security requirement, not optional:** these links get posted in Slack channels where
everyone can see them. A link carrying a bare `appointment_id` lets any closer edit the URL
and write a disposition against someone else's call. Every form link carries a **short-lived
signed token** (HMAC over appointment id + closer id + expiry). Cheap now; a data-integrity
incident later.

Typeform stays for client-facing intake where it's already working.

---

## D9. Nothing of ours lives in GHL's workflow builder. Polling is the delivery.

Tyler, 2026-10-06: *"We are not doing GHL workflows. That's the point. This replaces the shitty
GHL workflows."* Correct, and it holds up technically — checked rather than assumed.

**Outbound: every action we take is an API call.** Send SMS and email, add and remove tags,
write notes, create and update appointments, update contacts and opportunities. All verified in
`../ghl/02-api-facts.md`. No GHL workflow is ever the thing that sends.

**Inbound: every change we care about is detectable by polling.** Each entity has an
incremental "what changed since my cursor" call — contacts by `dateUpdated` range, appointments
per calendar by time window, conversations sorted by last inbound message, opportunities by
date. Verified. The engine keeps a cursor per `(client, entity)`, polls on the scheduler tick,
diffs against the replica, and emits events. A GHL workflow with a Webhook action was the
earlier plan; it is out, and so is the marketplace app.

**Why polling is enough here, with numbers:**
- About 10 calls per client per minute (1 contacts search + ~6 calendars + 1 conversations +
  1 opportunities). GHL allows 100 per 10 seconds burst and 200,000 per day per location;
  a 1-minute poll uses ~7% of the daily budget.
- At 10 clients that's ~100 calls a minute from one scheduler tick, finishing in well under the
  function cap.
- **The 60-second floor doesn't hurt anything that needs to be fast**, because the fast things
  don't come from GHL: form submissions hit us directly (D8), Whop payment events hit us
  directly, our own disposition forms write to us directly. GHL-originated changes — a booking
  on their calendar page, a reply, a status a closer set in the UI — all tolerate a minute.

**Polling and the reconciliation sweep are now the same mechanism.** One, not two. The sweep
was always "re-read and diff"; polling is just that on a one-minute cadence. Simpler than
webhooks-plus-sweep, and nothing to go silent.

**Costs, named so they're chosen rather than discovered:**
- Latency floor is the poll interval. Acceptable per above.
- A value that flips A → B → A inside one interval is missed. Rare, and our own writes cover the
  cases that matter.
- Deletions show up as absence, not as an event. Handle "appointment vanished from the window"
  as a cancellation.
- Cost is linear in clients. Fine to a few dozen; a marketplace app is the parked upgrade path
  if it ever isn't.

**Premise checks (D5b) still read GHL live.** A replica up to a minute stale must not send a
reminder to someone who cancelled thirty seconds ago.

### Nothing pushed back into GHL
Our data is seen in our dashboard and forms, not GHL custom fields. One consequence to say once:
the GHL contact card won't show intake answers; our call-prep view does. Cheap to add later if
it ever hurts.

### What we store: the journey, not the record
See D15. Structured fields of what we poll (contacts, appointments, opportunities, tags — a few
KB each), SMS bodies (the classifier needs them), email metadata and id but not the body,
recordings as pointers, and **no GHL configuration at all** (calendars, pipelines, users are
read through on demand). A business at 20k contacts and 100k messages lands well under a
gigabyte.

### Custom, per-business data: `attributes` JSONB, schema owned by the form
"How bad is your hair" exists on one offer and not another. It does not get a column. Our intake
record carries an `attributes` JSONB, and **the form definition is its schema**: a question with
key `hair_loss_level`, type `integer`, range 1–5 becomes a typed, validated, queryable attribute
for that client. No migration per offer.

**Proven, not asserted** — run against Postgres 16 with sample data on 2026-10-06:

```sql
-- "give me all contacts who said hair loss level is 4"
select contact_id from intake where (attributes->>'hair_loss_level')::int = 4;

-- "...or 'moderate'"
select count(*) from intake where attributes->>'severity' = 'moderate';

-- "hair loss level vs show rate"
select (i.attributes->>'hair_loss_level')::int as hair_loss,
       count(*) as booked,
       count(*) filter (where a.status = 'showed') as showed,
       round(100.0 * count(*) filter (where a.status = 'showed') / count(*)) || '%' as show_rate
from intake i join appointments a using (contact_id)
where i.client_id = $1
group by 1 order by 1;
```

Two attributes crossed (income band × severity → show rate) works the same way. A GIN index on
`attributes` serves containment queries (`@>`); the planner uses it when the predicate is
selective and correctly scans instead when a value matches a large share of rows (tested at 60k
rows). If one attribute ever becomes hot across every client, promote it to a real column.

**Typed at the form, refused at ingest if wrong.** The correlation dies the moment one install
stores `"4"` and another stores `4`.

---

## D10. Command center

A console for operator-level bulk actions against live state. The example that prompted it:
*"Closer A is sick — reach out to today's calls and reschedule them with Closer B."*

The reason this is cheap rather than a project: workflows are data and runs are rows, so a
command-center action is a query plus a bulk write plus a workflow fire. Nothing new underneath.
That one example decomposes to:

1. Query appointments for today where `assignedUserId = A` (verified working).
2. For each, PUT a new `assignedUserId` (verified working).
3. Fire a `reschedule_notice` workflow per affected contact, which sends through GHL so the
   whole thread stays visible in the CRM.

**Two hard requirements before any bulk action ships:**

- **Read-then-write, always.** A PUT that omits `appointmentStatus` silently resets it to
  `confirmed` (see `../ghl/02-api-facts.md`). A naive bulk reassign would wipe show/no-show
  status across every appointment it touched and re-fire anything keyed on it. Every bulk write
  reads current state and re-sends the full field set.
- **Preview, then confirm.** Every action shows exactly what it will touch and what will change
  before it runs, and writes an audit row per change with a reversal path. Bulk operations
  against a client's live book of business are the one place a mistake is both easy and
  expensive.

Natural language is the input surface, not the executor: the request resolves to a named,
parameterized action with a preview. It never becomes a model improvising API calls against
live client data.

---

## D11. Events table from day one

The Zapier-style "watch people move through the workflow" view is explicitly later. The thing
that makes it *possible* later is not: every state change writes to one normalized `events`
table from the first line of code.

Rendering is a view. Reconstructing history from scattered per-source tables is a rewrite. The
table is cheap now and it's also what the reconciliation sweep (D5) reads and what every
dashboard number is eventually computed from.

---

## D13. The reply workflow — one workflow, a four-way branch, Jev decides

Inbound reply to a reminder or outreach text. **One workflow**, branching inside it (D4):

```
[trigger: Customer Replied (SMS), while a run is live]
  → classify (Jev · choice over confirmed/cancelled/reschedule_request/question/unclear,
               state = last outbound message)
  → confidence gate (below threshold → unclear)
  → branch on reply_intent
      confirmed  → tag confirmed → exit
      cancelled  → update appointment → notify closer → exit
      reschedule → send rebook link → exit
      unclear    → tag needs-human-reply → internal note → pause reminders → exit
```

The `unclear` path is verified end to end against the live location: tag (a smart list filters on
it, since smart lists can't be created by API), internal note via `POST /contacts/{id}/notes`
with the original text and the top guesses with probabilities, and a pause on any live reminder
run so the engine stops texting someone who's mid-conversation with a human.

**What the engine never does with an unclear reply:** guess. A classifier that returns
calibrated probabilities is only valuable if the low-confidence path is honored.

---

## D14. Time rules — "the morning of, in their timezone" is a wait rule, not a cron

There is one cron: the scheduler tick. Everything else is a **`wait_until` node** that computes
`next_run_at` from a rule. A cron can't know about an individual appointment; a wait rule can.

A rule has four parts:

| Part | Example |
|---|---|
| **anchor** | `appointment.start_time` · `contact.created_at` · `now` |
| **rule** | `day_of @ 08:00` · `day_before @ 19:00` · `-1h` · `+2d` |
| **timezone** | `contact` · `client` · `closer` |
| **fallback** | what to use if the result violates a guard |

Tyler's two examples:

- *"the morning of their appointment, in their timezone"* → anchor `appointment.start_time`,
  rule `day_of @ 08:00`, tz `contact`.
- *"…unless it's before 10am"* → same, plus a guard: if the computed time is less than 2h before
  the appointment, fall back to `day_before @ 19:00`. The guard is the real content of "unless";
  the fallback is what makes it a rule instead of a hole.

Rules are **named and reusable** so the editor shows a dropdown (*Morning of · Evening before ·
1 hour before · 24 hours before · Next business morning*) and a client can add their own. The
send window (D5d) still applies after the rule, and the moot check (D5b) after that.

---

## D15. We store the journey, not the record

Tyler: *"what happened with this client, rather than what were the specifics … this one
self-booked, then confirmed they'd show up, then had a discovery call, then a closing call, then
a follow-up call, then closed on a 4-pay, and they said their hair loss was minimal."*

That sentence is the data model. Per contact, an ordered stream of events drawn from a
**controlled vocabulary**:

```
contact_id · client_id · event_type · occurred_at · source · data (small jsonb)

2026-09-30 14:02  lead.created          source=form        {form: "hair-intake", referral: "ig"}
2026-09-30 14:02  intake.recorded       source=form        {hair_loss_level: 1, severity: "mild"}
2026-09-30 14:09  appointment.booked    source=ghl_poll    {calendar: "setter-discovery", self_booked: true}
2026-09-30 16:40  reply.classified      source=engine      {intent: "confirmed", confidence: 0.94}
2026-10-01 10:00  call.held             source=disposition {type: "discovery", outcome: "qualified"}
2026-10-01 10:31  appointment.booked    source=ghl_poll    {calendar: "closer-call", self_booked: false}
2026-10-03 13:00  call.held             source=disposition {type: "closing", outcome: "follow_up"}
2026-10-05 11:00  call.held             source=disposition {type: "follow_up", outcome: "closed"}
2026-10-05 11:14  payment.received      source=whop        {plan: "4-pay", amount: 1250}
```

Read it top to bottom and you have the sentence. `SELECT … WHERE contact_id ORDER BY
occurred_at` is the journey; join `intake.attributes` for "and they said their hair loss was
minimal." This is the `events` table from D11, now stated as the center of storage rather than
a side log.

**Current state is derived.** "What stage is this person in?" is the last stage event. At this
scale that's a query; if it ever isn't, a materialized `contact_state` view is a cache of the
stream, never a second truth (D9).

### Proven against Postgres 16, 2026-10-06 — `proof-journey.sql`
200 synthetic contacts, 160 booked, every query below ran as written. The stream answers the
questions Tyler asked without a second table:

| Question | Shape of the query | Result on the sample |
|---|---|---|
| How many confirmed? | one `count` with a `where` | 112 |
| The funnel | one `select` with `count(*) filter (where …)` per stage | 200 → 160 → 112 → 96 → 54 → 28 |
| Does confirming predict showing? | booked **left join** reply **join** outcome, group by intent | confirmed 73% · no reply 39% · cancelled 0% |
| One contact as a sentence | `string_agg(… order by occurred_at)` | `lead.created → intake.recorded → appointment.booked → reply.classified (confirmed) → appointment.outcome (showed) → call.held (discovery) → call.held (closing) → payment.received (pif)` |
| Attribute × behavior | join `intake.recorded` data into the funnel | confirm rate 56% → 75% across hair loss 1 → 5 |
| Median days booking → close | `percentile_cont(0.5)` over the two events | 6.0 |
| Where is everyone right now? | `distinct on (contact_id) … order by occurred_at desc` | derived live, no stored state |
| Can a typo enter the vocabulary? | `event_type` is a **foreign key** to `event_types` | `appointment.confirmd` → rejected |

Two things worth noticing. Every funnel-shaped question is the same query with different
`filter` clauses — that's the sign the model is right, because the queries stay boring as the
questions get harder. And the last row is the normalization rule from below enforced by the
database rather than by discipline: an event type that isn't in the vocabulary cannot be written.

### Normalization: two layers, one promotion rule
- **Core vocabulary — fixed, shared by every client and offer.** Event types, call types
  (`discovery · closing · follow_up`), appointment outcomes (`showed · noshow · cancelled`),
  disposition outcomes, payment plan types. This is what makes "show rate" mean the same thing
  at Save Your Hair and Beauty Moguls. Not editable per client.
- **Offer attributes — per offer, typed by the form.** `hair_loss_level` lives here. Can't be
  cross-offer by nature.
- **Promotion rule:** when an attribute turns out to be conceptually shared (income band,
  urgency, decision-maker), it moves into the core vocabulary so it's comparable everywhere.
  That's the mechanism behind "normalize as much as possible across offers" — deliberate, one
  attribute at a time, never by guessing that two clients' labels mean the same thing.

---

## D16. The install is: upload, pick, done — then customize

The product as Tyler stated it: *"upload their info and select the workflows they want, and
they're done. AND then they can say 'I want X and Y and Z to happen.'"*

1. **Upload their info** — the install form, generated from the manifests of the templates they
   pick (D3). Credentials, calendar ids, send window, timezone, Slack channel, offer attributes.
2. **Pick the workflows** — from the template library (D2). Each pick copies the template into
   their tenant.
3. **Done** — bindings validated, every copy enabled. Running.
4. **Then "I want X and Y and Z"** — the editor (D17). Their copies, their edits, nothing shared.

Nothing in this flow touches GHL's workflow builder, snapshots, or a marketplace install.

---

## D17. Everything a client might reasonably want to change is data in the definition

Every SMS, every email, every Slack message, every wait rule, every branch condition, every tag
name — stored as data in the workflow definition and editable in the editor. Message bodies are
templates rendered at send time (D5a), so editing one changes what goes out from the next send
onward, with no deploy.

What isn't editable by a client: the core vocabulary (D15), the binding keys a template
requires (D3), and the engine's safety behavior — moot checks, send window, idempotency. Those
are the floor everything else stands on.

## D18. The booking source is a per-company choice; appointments are one table regardless

Hair books every strategy call in Calendly and its GHL calendars are empty (verified 2026-10-06:
zero appointments on six calendars over sixty days, 44 Calendly events for the same host in the
same window). So "appointments come from GHL calendars" was a Tyler-location assumption, not a
rule. A company declares where its appointments live, and the engine reads them from there:

- `calendars.source` / `appointments.source` — `ghl` or `calendly`. `external_id` is the GHL id or
  the Calendly uuid. One row shape, one set of events, one set of workflows.
- The adapter boundary is `BookingRead` (list calendars, appointments in a window, one appointment
  live). GHL calendars and Calendly event types both implement it; a company uses exactly one,
  chosen by its bindings (`secret.calendly_token` present → Calendly).
- Contacts, messages and sends still come from and go to the CRM. A Calendly invitee is an
  identity (email, phone), not a contact system. The engine resolves the person through
  `contact_identifiers`; when nobody matches it holds a local replica, and the next CRM poll
  attaches the GHL id through the same identity resolution (the Zap that mirrors Calendly into GHL
  keeps running; we only read).
- A Calendly reschedule arrives as a cancelled event plus a new one, linked through the invitee.
  To us it is the same appointment moved: `external_id` is updated and `appointment.rescheduled`
  fires. Cancellation rebook never fires on a reschedule.
- Calendly is read-only to us. `update_appointment` on a Calendly booking records that it was
  skipped and the run continues. Show/no-show for Hair will come from Fathom (next automation),
  not from the booking source.
- Per-calendar `self_booked` (from the event type's internal note: round robin = direct,
  "- S" = setter) stamps every booking, so setter-vs-self is a fact on the appointment, not a
  guess from question text.

## D19. The engine owns the pipeline cards the team works from

D10 said we do not push *our* data (journey, attributes) back into GHL, and that stands. It did not
mean the engine never writes to GHL: it already tags, notes and sends through it. Hair's team
runs their day from GHL pipelines (Setter, Closer), and the automations Tyler is porting create
and move those cards. So templates get a `pipeline_card` node that writes a card to a CRM pipeline board. Ids are
`crm.*` bindings, never literals in a template. One open card per contact per board. In shadow
the card exists only in our table and the run step shows what would have been created.

Cards are not opportunities. Hair keeps a setter board and a closer board, so one sale has two
cards at once. `pipeline_cards` holds the cards; `opportunities` stays one row per pursuit
(D15), and every card, appointment and run for that sale points at the same opportunity. The
first version mirrored a card 1:1 into `opportunities`; the funnel test showed the booking then
attaching to the newest card instead of the pursuit, and it was replaced the same day.

Sequencing note for go-live: the Calendly → GHL Zap expects the setter card to exist within about
three seconds of contact creation (GHL workflow 01 does that today). The engine polls once a
minute, so the moment the engine replaces workflow 01, the engine's booking workflow must create
or move the setter card itself. Until the booking workflow is ported, new-lead runs in shadow.

## D20. Timed waits follow the appointment

Found by the funnel test (2026-10-06): a reminder parked for "8am the day of the call" kept its
wake time when the call moved, so it would have fired on the wrong morning. A `wait` node is now
re-evaluated on every wake. Waits anchored on the appointment recompute from the current start;
waits anchored on "now" pin their first answer in the run's context so they cannot slide. Any
change to an appointment (time or status) wakes the runs parked on it: a moved call re-anchors the
reminder, a cancelled call makes the reminder exit moot right away instead of at its old wake time.
Only `wait_for_reply` wakes on an inbound message.

## D21. The ledger records facts; identity is a ladder; nothing is guessed

Replaces the Zapier payment step. Every payment Whop reports becomes a row, linked to a person or
not. Linking tries, in order, the Whop member id already seen on a linked payment, the email, the
phone (last ten digits); identities are unique per company so a match is exact or absent. No match
→ `link_status = unlinked`, a `payment.unlinked` event with no contact, a team alert, and a row on
the company's Payments page where an operator links it to a contact. Linking (by ladder, by hand,
or by healing an older orphan when a later payment resolves the same buyer) settles the payment:
it joins the contact's pursuit (created if none, priced at `companies.contract_value_default`),
its kind is derived from what came before (deposit / installment / balance / paid_in_full /
refund), and `payment.received` carries running total, outstanding and `cleared`. Refunds are
negative rows. Idempotency is two-layered: the provider's delivery id, then the payment id.
Nothing customer-facing is sent from the ledger; templates decide that.

## D22. Every inbound fact has more than one door, and every door lands on the same ledger

Tyler, 2026-10-07: "I want multiple options for triggers. That's the point. It's an out-of-the-box
solution that is customizable." A client picks how a fact reaches the engine; the engine does not
care which door it came through. Payments: Whop's own webhook, or a Zap forwarding it. Recordings:
Fathom's own webhook, or a Zap forwarding it. Bookings: GHL calendars, or Calendly (D18). Behind
each door is one normaliser into one input shape, then one ingest path: ledger row, identity
ladder, team alert on a miss, workflows on a hit. Templates trigger on the event
(`payment.received`, `recording.received`), never on the transport, so a company can switch doors
without touching a workflow. Adding a provider means a parser and a route, nothing else.

Recordings follow the payments ledger shape (D21): a `recordings` row per recording the provider
reports, linked by a ladder (an invitee email on a known contact → an invitee name that is exactly
one contact → the recorder is a closer we know and had exactly one appointment within two hours of
the recording start). One unambiguous hit or nothing; a miss is an `unlinked` row with the reason,
a team alert, and a row on the company's Recordings page where an operator links it by hand (the
attendee's email is then remembered). Once the person is known, the appointment is theirs nearest
the recording start within a day, or none. The transcript lives on the row and is read into a run's
context each tick, never copied into it.

What a recording means is a workflow decision, not an ingest decision. The `analyze` node reads the
transcript against a prompt bound per company (`prompt.<name>`, editable text, defaults shipped),
answered as JSON the rest of the run can address (`{{vars.notes.disposition}}`). "Is this a sales
call" is the first such read; a no stops the run and writes nothing. A show is recorded by the
`record_outcome` node onto OUR appointment row (the same path as the closer's form), which is what
makes `call.held` fire for a company whose booking source has no outcome (01-open #24). The
Anthropic key is per company (`secret.anthropic_key`); analysis runs in shadow too, because seeing
what the AI would say is the point of shadow.

## D23. The test harness lives in the engine; a simulated step is a real run on a synthetic fact

Tyler, 2026-10-07: a real-contact test has to go "totally behind the scenes"; Hair's live Zaps and
GHL workflows must not fire. So the harness does not touch anything outside the engine. A
`sys-test-<action>` tag seen by the poll on a contact (or the same action from the contact page or
`POST /api/admin/simulate`) stages the FACT synthetically and then runs everything real: a
`lead.created` event, an appointment with `source = 'test'` that exists only in our table (the
premise check reads our row for that source instead of asking Calendly), a cancel or reschedule on
it, a payment through the ledger, a recording through the match ladder. Events carry `source =
'test'` and `simulated: true`. The tag itself is an instruction, never a `tag.added` event.
`sys-test-reset` makes the engine forget everything it did for that person (runs, sends, cards,
pursuits, synthetic appointments); the contact and identifiers stay because they mirror the CRM.
The harness is refused for a live company unless forced: live means the run would write real tags
and cards for the test person. Actions: create, book (setter), book-self, reschedule, cancel, pay,
record, reset.

Dark hours, same day: `send_sms` / `send_email` carry `kind: human | transactional` (default human).
A human-sounding message always waits for the company's send window; a transactional receipt
("you're booked") goes out at any hour only when `companies.quiet_allow_transactional` is true
(install `quietHours: { start, end, allowTransactional }`). This answers the smoke-run finding in
01-open #25 without special-casing any template.

## D24. Setter attribution is a per-company rule, not a template fact

Tyler, 2026-10-07: "there are different ways setter calendars get triggered. Sometimes it's one
calendar with a specific 'who set this' question." Offers differ, so the rule is bound per company
(`booking.setter_rule`, install `setterRule`) and the template only ever reads
`appointment.self_booked`: `calendar` (the calendar is a setter calendar or not — Hair's two event
types, the default), `question` (one calendar; a setter named in the booking question means
setter-booked, no name means self-booked), `either`. A fourth strategy for GHL-native bookings (the
assigned user's role, or a tag on the appointment) can be added as a value without touching a
template. The harness states the fact outright because it stages the booking itself.

Same day, three operating rules the real-contact test and the "will it fire?" question forced:
- **The engine reports its own problems.** After every tick: poll failures, cursors failing five
  times in a row, runs failed in the last ten minutes, workflow copies that no longer parse, a
  recovery catch-up. Posted once to `OPERATOR_WEBHOOK_URL`, repeated hourly while they persist, shown
  on the dashboard home. The one thing the engine cannot report is its own scheduler being dead, so
  `/api/health?assert=fresh` answers 503 when there has been no tick for five minutes — an outside
  monitor pings it.
- **Recovery drips per company.** The catch-up cap (20 sends per tick) is per company, so one
  client's backlog cannot starve another's, and sends are processed in due order; a message that
  has lost its window (validity) is skipped by the existing staleness rules rather than sent late.
- **Migrate runs in the build.** `pnpm build` applies the schema before Next compiles, so a deploy can
  never serve code against yesterday's tables. A migration that fails fails the deploy.

### D24, continued (2026-10-07): questions live on the calendar, answers live on the appointment

Every calendar asks different questions in a different order, so each calendar carries its own
`config`: `booking` (self | setter | question — beats the company rule) and `questions`, a map from
the name we want to the question text as it appears on that form (`setter`, `phone`, and any intake
attribute such as `noticing_for`). Matching is case-insensitive on a prefix, so "(required)" suffixes
and punctuation do not matter. Mapped answers land on the appointment as `answers.<name>` and are
addressable in templates (`{{appointment.answers.noticing_for}}`), so intake captured at booking is
usable without a form or a CRM field. Lead attribution (D25, not yet built) will read these same
answers plus the booking link's UTM tracking; Tyler's rule is last touch wins, with the history kept.

## D25. The engine is the brain and the connector; the work happens in the tools

Tyler, 2026-10-07: "This is the engine, the brain, the connector. Everything happens through GHL or
whatever tool we're using, not the engine itself. Like Zapier or other middleware, but we connect it
and have our pre-built plans and automations that we can adjust on the fly, and create new ones with
ease."

Operating rule that follows: anything a human works from must exist in the tool they work in (GHL
cards, tags, notes, custom objects, Slack), written by the engine. What the engine keeps for itself
is what middleware has to keep to do its job: the facts it has seen (replica of contacts and
appointments, the payments and recordings ledgers), the timers and runs in flight, the versions of
each company's workflows, and what would have happened in shadow. The dashboard is for seeing and
configuring, never the place the team does the work.

Two places the build drifted from this and the correction for each:
- The disposition form writes the outcome to our appointment row only (D8/D12). Under D25 it must
  also land in GHL: the Sales Call record (as call-recorded already does) and the tags the team's
  smart lists key on. To do when the form is rebuilt to Tyler's real questions.
- Intake answers captured at booking (`appointment.answers.*`) are engine-side until a workflow
  writes them to contact fields. Hair's call-booked already writes the appointment date and setter;
  any answer the team needs to see gets the same treatment, per client, through the workflow.

"Adjust on the fly" today: copy editable on the workflow page, on/off per workflow, every id and rule
on the settings screen, template upgrades for untouched copies. "Create with ease" today: described
in chat, written as a template, installed; the natural-language builder in the tool comes later.

## D26. Settings live where the work is described: on the step, or in a paragraph

Tyler, 2026-10-07: "I don't want to have to explain every detail in the settings." Three consequences:
- **Pull before you ask.** Every host's calendars are listed and merged (Calendly: all organization
  members' event types, round-robin types once with all their hosts), each with its booking questions
  as the source defines them (`custom_questions`: text, type, choices). The settings screen offers
  "this question means setter / phone / <attribute>" against the real questions; nobody types
  question text. Pipelines, stages, fields, associations, users and Slack channels are lists too.
- **GHL-style, set on the step.** A company's copy of a workflow can carry literal ids on a step:
  "move it to this pipeline, that stage", "post to #this-channel", "add these tags", "owner James".
  Templates keep `crm.*` bindings so they stay portable; a copy edited this way is diverged and left
  alone by upgrades. Bindings become defaults, not a list to fill before anything works.
- **Say it in text.** "Tell it how things work" takes a paragraph plus the live facts, returns a
  proposal of operations the engine knows how to apply (map calendar, setter rule, default closer,
  calendar role, call type) and the questions it still has; a person approves before anything is
  written. Same operations the forms use. The in-tool builder for workflows themselves is later;
  this chat is that for now.
Call types are the company's words (triage, demo, strategy call) over the four core categories.

## D27. For now, this chat is the agent

Tyler, 2026-10-07: the goal right now is to tell Claude in natural language and have it configure
everything: a new offer, a new workflow, a workflow copied from one offer to another. The in-software
agent each company can talk to comes later. So the operating mode until then:

1. Tyler describes it in his words: which client, what triggers it, what it does step by step, what
   the team sees. Claude maps that onto what exists (the node vocabulary, the trigger list, the
   company's calendars, pipelines, stages, fields, channels) and asks only for what cannot be pulled
   or inferred — in batches of at most five questions.
2. Claude builds it as a template (portable: bindings for ids and copy), installs it on the named
   company, and reports what the readiness check says is still missing. New ids are set with the step
   pickers or by Tyler naming them here; copy is either given here or edited on the page.
3. Copying a workflow to another offer is "install the template on that company": the manifest lists
   what the new company has not got (copy, channel, stage…), Claude asks for exactly those, and the
   flow chart on the new company's page is the proof.
4. Everything stays visible in the dashboard: chart, steps table, copy, step settings, what happens
   next, readiness. Nothing is configured that cannot be seen there.
5. A new offer is the same shape: booking source and token, which calendars are what, what triggers
   which workflows. Claude runs install, then the settings page shows what remains.
When the in-tool agent arrives it follows the same contract: pull before asking, propose before
applying, show the result as a chart.

## D28. A dialer call is a recording; every call is kept; the AI only reads what has a transcript
Tyler, 2026-10-07, porting Hair's "hourly setter call scrape" Zap. Decisions:

1. **Event-driven, not hourly.** The conversations poll already walks every thread each minute; a
   `TYPE_CALL` entry there becomes a row in the recordings ledger (provider `ghl`) the minute it
   appears. No fixed-window dedupe: the ledger's unique key is the dedupe.
2. **Every call is a fact, answered or not.** No-answer, busy, voicemail, 10-second connects — all
   rows, with who dialed and the outcome. Connection rate and speed-to-lead are read from this table;
   nothing has to be re-scraped later. Only the workflow filters.
3. **Transcript or nothing.** Without a transcript nobody knows whether it was a setting call, so no
   Discovery Call record and no Slack post. Recording is not on for every call in GHL (2 of 4 long
   Hair calls had one); the ledger says so per call and the operator can turn recording on in GHL.
4. **The transcript lags the call**, so a connected call waits (re-read every tick, 30 minutes at
   most) and `call.logged` fires once, at settle. The workflow then waits 15 minutes from the call's
   END so the booking the setter makes right after hanging up is visible as `led_to_booking`.
   (2026-10-09: it was anchored on the call's start, which gave a long call no grace at all; Tyler:
   "It should be when a call is complete... sometimes setting calls take a long time." Now `recording.ended_at`.)
5. **Classification is the engine's `analyze` step on Claude**, same as `call-recorded`: setting /
   confirmation / other. "Are you joining?", voicemails, wrong numbers are `other` and stop. Both
   setting and confirmation calls get the same digest; the prompt is told to keep a thin
   confirmation call to one line and to add pains / goals / triage only when they came up.
6. **The 60-second floor is a knob on the workflow** (`set_var min_seconds`, editable in step
   settings), not a constant in the poll. `wait` offsets are editable the same way.
7. **Phone and meeting recordings share one ledger and one `{{recording.*}}` surface**; a trigger
   tells them apart by `recording.kind`. `call-recorded` is unaffected because it listens to
   `recording.received`, which phone calls never emit.

## D29. Three layers: the ledger the engine runs on, daily rollups, pointers for the rest
Tyler, 2026-10-07, porting the "nightly wrap-up" Zap and settling the data structure.

Tyler's instinct: do not duplicate what GHL already stores; keep per-day numbers and averages; pull a
specific thing from GHL when someone asks. The engine already stores more than that, and it should,
because the workflows cannot run without it: events with real timestamps, appointments (waits read
`starts_at`, "booked after the call" reads `booked_at`), payments, recordings, a thin contact replica.
That is working state, not a report copy. So:

1. **Ledger** stays, raw rows retained; storage is not the constraint at this scale. Two copies are
   trimmed: the contact replica keeps only the custom fields a binding names (not hundreds), and form
   answers live as one JSON (booking answers on the appointment, intake on the contact).
2. **Daily rollups** (`rollups_daily`): counts and sums per company, local day, dimension, metric.
   Rates are never stored (an average of averages is wrong); weekly and monthly are sums of days.
   Recomputed from the ledger, so a rebuild is always possible. Wrap-ups and the bot read these.
3. **Pointers** for GHL-owned content the engine only acts on; the detail is fetched live.

Why not read GHL at report time, as the Zap did: GHL has no call analytics (Luis's dials, connects
and talk time exist only here), its object dates come back as display text that needed a 60-line
parser, record search caps at 100 and lags writes. GHL stays the place to look at ONE contact's calls
and transcripts, which it answers well.

Wrap-ups: daily / weekly / monthly, every parameter a row in `wrapup_schedules` (time, day, channel,
breakdowns, sections), nothing in code. 7pm company time by default with no "day is not over" line:
a team whose calls run to 9pm moves the time. Totals by default, per-setter / per-closer switchable.
"What they said" reads whatever questions the booking source or intake form actually asked — no list
of field ids per offer. On demand = the period in progress. The bot ("how many people did Luis call
this week, how many connected, what was his talk time") answers from layers 2 and 1; it is the
reason the ledger keeps every call.

### D29, continued (2026-10-07): speed to lead is a dial, history comes from the tools once
Tyler: "the time from when the lead came in to when the lead was called, and figure out if they were
reached based on the length of the phone call." So: `leads_called` = a dialer call after the lead's
CRM arrival time, `stl_sum` = seconds to that first dial (answered or not — a dial is the team acting),
`leads_reached` = a connected call of at least `companies.reached_seconds` (default 60, a company
setting, because a 10-second "connected" is a voicemail drop). Automated texts no longer count as a
touch. Leads are counted by the CRM's own `dateAdded` (kept as `contacts.ghl_added_at`), not by our
`lead.created` event, so a month of history counts the same way as today.

History: one backfill pass per company over a window, reading GHL and the booking source the way the
poll does and writing rows only (D29 §1), then rolling the days up. GHL had 114 contacts, 145 threads
and 48 Sales Call records for Hair's last 30 days, zero Payment records (the Whop Zap never wrote
them), and 8 won opportunities with no contract value on the field. So the first weekly and monthly
wrap-ups carry leads, dials, bookings and show outcomes; money history waits for Whop's API.

## D30. Agreements: the CRM's documents are a ledger, and a gate exit does not spend the "once"
Tyler, 2026-10-07, porting Hair's agreement workflows (send manually, payment received, agreement
signed, deal closed, unsigned chase).

1. **The CRM's Documents & Contracts is the source of truth for sent and signed**, mirrored into an
   `agreements` ledger by the poll like payments and recordings. `agreement.signed` fires exactly once
   per document, on the first poll that sees it completed. No GHL workflow, no tag, needed to know.
2. **Sending stays in the engine** (`send_document` from Dr. Allan) even though the token cannot send
   yet: in shadow every CRM write is skipped anyway, and the step works the moment the documents send
   scope is granted (Tyler: after the tests pass). Until then nothing in GHL has to change.
3. **"Either order, only once" is an engine rule, not a tag dance.** Deal closed listens to the first
   payment and the signature with `once_per_contact`; its first step is a gate (paid AND signed AND not
   already a customer). A run that stops at a gate releases its once-per key, so the other event can
   run it later. `stat-customer` is still written, as the belt-and-braces guard Tyler asked for and so
   GHL users can see it.
4. **Owner nudges go to a person, not a channel**: Slack DM to the contact's owner (CRM assignee, else
   the default closer), found by email; the channel with an @mention is the fallback; a CRM task on the
   contact either way, so it is visible inside GHL. Strict 24 hours from the payment, three nudges,
   then a tag and one escalation.
5. **Welcome copy can live in the CRM**: a send step may name a GHL SMS snippet or email builder
   template; the CRM's copy wins when it exists, the step's copy is the fallback. Hair's welcome text
   ships on the step until someone makes the templates in GHL.
6. **Phase on the Sales Call**: not added yet (no write scope to create the field). Payment updates
   cash collected; the close writes `closed_won` / `showed`.
7. **The same-minute race is closed.** A trigger that loses the once-per key to a run still in flight is
   remembered on that run (`runs.pending_events`). If the run stops at a gate, the queued triggers are
   replayed in order and the first that starts takes the key; if the run completes, they are dropped,
   because the once was spent. Payment and signature can now land in the same second.

## D31. Shadow posts to the team are real posts, labelled
Tyler, 2026-10-08, setting up the private test channel: the point of the shadow run is to see what the
engine would do. Slack is the team, not the CRM or the contact, so in shadow every Slack post (steps,
owner nudges, team alerts, wrap-ups) goes out with a "🧪 shadow —" prefix when Slack is connected,
and the send is recorded as `shadow`. Nothing else in shadow leaves the engine.

### D31, continued (2026-10-08): posts have faces, mentions and threads

Each kind of post has its own name and a small list of icons, one picked per post (booking: phone or calendar;
payment: money; close: celebration; agreement: pen and paper; call: microphone). The close post @mentions the
closer and the setter (looked up in Slack by email once, remembered on the team; the setter by exact name match
against the team, else printed plain). The call post is the facts (name, recording, outcome, pain, goal, objections,
next steps) and the scorecard goes into its thread. Days to close counts first booking → first payment. The AI's
congratulations line is optional decoration: no key, no line, the post still goes out.

## D32. The dashboard shows; the chat changes (2026-10-08)

Tyler, on seeing half-editable step settings: "I'd rather have NOTHING editable there and ONLY have it
through this chat." So the dashboard is read-only (the one exception stays: Turn on / Turn off, and Go
live). A workflow is a short outline a person reads top to bottom, with what each line produces shown
on hover as an example against a made-up contact; no chart, no editors, no circle for "done". Every
change to copy, steps, channels, pipelines or icons is asked for in the chat and lands as a template
edit or a company-copy edit plus a re-install, with the version history as the audit trail.

## D33. The engine tells on itself: instant alerts, hourly sweep, silence otherwise (2026-10-08)

Tyler: a closer's calendar disconnected on one offer and nobody knew for a day. So: every failed step is
announced the minute it fails, with the reason, to wherever the company says (Slack channel, email, a Zap);
once, then hourly in the same thread while it stays broken; "resolved" in the thread and a ✅ on the first
post when it clears. No daily "all green": errors only. The hourly sweep is its own automation (clock,
channel, face, checks all configurable) and read-only against every vendor. Where a vendor has no
"connected" flag (GHL calendar sync, Calendly host calendars) the sweep reads the symptom: no bookable
slots over the next 7 days. The dashboard is read-only and phone-first; the chat is the only editor.

### D32, amended the same day

The flow chart came back, as a hover/tap peek under the outline: the list reads well, the branches do not.
"Complete." is implied and gone. Bindings, versions and the definition sit under "Advanced". Every workflow
lists who went through it and how it ended; a run is a timeline with the clock ("10/08/26 @ 13:32 ·
Agreement signed").

## D34. The closer's day is prefilled, not asked (2026-10-08)

Tyler: "How many calls did you take? Prefill 6, editable if they really had 7. How much did you close? If it didn't
show up, that's a red flag." So the end-of-day report is the engine's own picture of the closer's day with every
value editable, and what the closer corrects is posted where the team looks: the correction is the signal, not the
report. One standing link per closer, no login; a DM at the company's end-of-day time on days with calls; a ✅ on the
DM when filed. Outcomes go through the same disposition path as the form, so nothing downstream has two doors.
Setters later; the post-call variant is the same form cut to one call.

Amended the same day, after Tyler saw the form on his phone: one question first ("what happened on the call?"),
the rest appears for that answer; outcomes are Closed, Deposit, Follow up, Lost, DQ, Rescheduled / cancelled on the
call, No-show, and attendance is implied (no "showed" next to "no-show"); pains and goals fold into one "about this
prospect"; DQ asks why (a select the company edits) plus a note; what is required and which questions exist are the
company's (`forms`, purpose eod), so one offer can demand notes and another not, and "what did I do well" is one
line to add, not a build. A deposit is its own outcome and its own count, not a close: money short of the contract.
Not everyone on the CRM roster takes calls: the roster arrives as staff, closers are named (settings § Team or the
install input), and only closers get the link and the DM. The closer's page stands alone, no nav, no way into the
dashboard; auth comes later and the link is the door until then.


## D35. Everything on a clock is a workflow (2026-10-08)

Tyler: "The end of day should be a workflow. I think everything really should be a workflow. I don't think it should be
wired by hand. If I want to edit the health check on one of my companies, I can do that, and nothing is hard-coded."
So the clock is a trigger (`event: "schedule"`, `every` or `at`, one run about the company or one per closer), runs
may be about the company or a person (`runs.contact_id` nullable, `runs.user_id`, a `user` root in the context), and
the four things that ran on timers inside the engine are templates: `eod-reminder` (evening and morning schedule
triggers per closer, a check, a DM remembered by tag), `eod-filed` (the `eod.filed` event, the summary, a ✅ threaded
under the reminder), `health-check` (hourly, a `health_check` step with the check list on it), `calendar-availability`
(hourly plus every booking event, an `availability_check` step with the thresholds on it), `wrap-ups` (three schedule
triggers into one `report` step and a post). The settings page lost its Health, Wrap-ups and end-of-day sections: the
workflow is the one place, edited through the chat like every other, shown in the outline with its popovers.
`wrapup_schedules`, the health config columns and `companies.eod_at` are gone with them. A `webhook` step is the door
out to Airtable, Zapier, Make, Apps Script, anything with a URL; `{{secret.*}}` resolves there and nowhere else.
The line that stays: triggers in and side effects out are editable steps; the ledger, the poll, the form fields, the
inbound doors and the alert announcer are engine. Google Sheets "the Zapier way" needs one OAuth client for the
platform (not per client, never a service account); until Tyler decides on it, Apps Script through the webhook step.

## D36. Workflows sit on the journey; the prospect's pre-call is one sequence (2026-10-08)

Tyler: "reorganize the workflows into a chronological order, and section them: pre-call, post-call, closed." Every
template carries a `stage` (lead, booking, pre_call, call, post_call, closing, payments, reactivation, team, engine)
and a sort inside it; the company page groups by stage in that order, scheduled ones last. And: "I want one pre-call
reminder sequence, and the separate call sequence of a booked call that does different things. Copy changes and such,
I don't want to mess with one thing." So `call-booked` stays the CRM side of a booking (owner, date field, cards, tags,
the video task, the Slack card) and `pre-call-sequence` is everything the prospect hears, replacing booking-confirmation
and appointment-reminder: booking email and text, the reply wait (no reply in four hours → tagged unconfirmed and the
closers told), then 72h, 48h, 24h (text and email), the morning of for calls at 11am or later, 1h and 10m texts.
The timing is a rule, not an AI: a wait rule's `earliest`/`latest` move a computed time to a human hour the same day
(four hours before a 7am call is 8am), and each send's `validity.min_lead` skips it when the call is already closer
than it (a 24-hour text for a call eight hours away never goes). Tyler did not want a "collapse window"; there is none:
the plan page shows every planned time, and two reminders landing close together is visible, not hidden.

Addendum, no-show half (2026-10-08). Tyler: "at the end of the day if they don't have a Fathom call we assume they didn't
show (configurable in case they don't use Fathom); calls we don't know what happened, we continue to request an update
until they've been filled." So `no-recording-no-show`: a schedule at 18:00, an `assume_no_show` step (grace after the
scheduled end, which call types), marking every call that ended with no recording and no outcome as a no-show through
the same disposition path the form uses; the company turns the workflow off when its calls are not recorded. No
per-call ask-back DM: the end-of-day form is the ask, the morning reminder repeats it for unfiled days, and a closer's
answer on the form overrides the assumption. The wrap-up is Slack text, not a code block: phones wrap it.

## D37. The dashboard gets rebuilt as one React app, on the "Slate" direction (2026-10-09)

Tyler: "UI needs a LOT of work. It just looks very terminal. I want this to look and feel super premium, like Spotify
or Facebook. Flat, no liquid glass, good spacing." And: "when it's time to rebuild we rebuild the whole thing, in React
entirely so we get instant page loads and switches." The engine, the JSON templates and the admin endpoints stay as
they are; the pages become a single React app over a JSON API, with the closer's end-of-day page kept bare (no nav).

The direction was settled section by section from mocks (`design/mocks/`), dark only, one color set ("Slate"):

- The flow chart is vertical, one node per step, the reply branch drawn as a real fork, each reminder its own node
  marked conditional. No swimlanes. On a phone it wraps to two columns; nothing on any page scrolls sideways.
  A node's detail opens on hover with a mouse, on tap on a phone, and goes away on scroll; a popup that would fall off
  the bottom opens upward. A skipped step says why in words with the numbers ("the call was 21 hours away; it needs
  more than 60"); a failed step says what failed.
- "Who went through it" is one row per person: icon on the left (clock = waiting, check = finished, warning =
  a step failed), name, a strip across the row with one segment per step on that person's path (green done, purple
  where they are now, blue skipped by a condition, orange the step it failed on, dim still to come), the current step
  in words, the date as short as it can be. A branch that ends on purpose (cancelled, rescheduled) is a completion:
  check and a full green strip. Tapping a row shows the same steps as a list, from the same data as the strip.
- Purple is "waiting", orange is "failed", blue is "a condition said no". Nothing else borrows those colors.
- The page header, top to bottom: the way back to the company; the workflow's name with the on/off switch (a pill like
  Zapier's, no box around it) at the right of the same line, centred on the title even when it wraps; the tags (stage,
  "your spec" or "default", "shadow") with when it last ran; one line of what it does; then four tiles on one line at
  every width: people, in flight, finished, failed, the number big and the word under it. "Ran" as a badge meant
  nothing to Tyler and is gone.
- The company page: the company's name with the one Go live button at the right, a "shadow" tag with what it means
  ("sends are written down, not delivered"), filters (all, on, off, needs a look), then every workflow in journey
  order down a rail: a line on the left with a dot per stage, lit when something in that stage is on, the stage as
  the section label. Rows are flat (no panels): the name, "your spec" or "default", when it last ran, then people /
  in flight / failed and the switch at the right edge. On a phone the counts fold into a short note under the name.
  Scheduled workflows (Team, Engine) come last; retired copies at the very end under Other.
- The run page: the header (who, state pill, "shadow", started, the call and the closer), then one feed in time
  order: the same step rows as the sheet, a send carrying a "the words" handle that opens the full copy under it,
  a skipped step carrying the blue icon and a "why" handle that opens the reason. Nothing blue is written on the page
  until asked; Tyler: "the blue text is a lot, too much; a simple blue icon and if I click on it it should explain".
  Then what happens next, the chart with this run's path lit (on a phone, only the path taken) and a button to the
  workflow. Raw steps and context fold at the bottom.
- The contact page is the automations hub's page for a person, not a CRM's. Tyler: "we're not trying to replace the
  CRM; this is the automations hub". The CRM's facts sit as chips under the name; then two tabs: Workflows (every
  run this person went through, the live ones first, tap a row for the whole flow) and Next (what is about to happen
  to them). Identifiers and the test harness fold at the bottom. No history, no message log.
- Still to mock: settings. The health and wrap-up pages are lists and follow the row rules in `design/GUIDE.md`.

Built (2026-10-09): `platform/dashboard/` (Vite, React, React Router, TanStack Query, plain CSS on the Slate tokens, our
own SVG chart), served by Next at `/app` from `public/app`; the closer's page moved there too (`/eod/<token>`). The JSON
API under `/api/v1` (`src/api/`) composes the words from the engine's `describe.ts` into the chart and the path; the
client lays the chart out. One operator password guards the dashboard (`DASHBOARD_PASSWORD`, `SESSION_SECRET`). The
Next pages that have no design yet (settings, appointments, payments, recordings, wrap-ups, sends, triggers) stay,
reachable from the company page's "Other pages" fold, until each is rebuilt.

## D38. The hub stores what the engine needs, not the conversation (2026-10-09)

Tyler, on seeing the contact mock with every text and email: "we're not trying to store all the history, right? I
really don't want to store the SMS and such." Today the poll copies the whole GHL conversation into `messages`
(inbound and outbound, human and engine, with bodies) and only one thing reads it: the wait-for-reply step, which
needs the reply's text for a few hours so the AI can read it. So:

- The poll stops copying outbound and human messages. An inbound reply is kept while a run may be waiting on it and
  its body is dropped 7 days after it arrived; the fact "they replied" stays as the event, without the text.
- The engine's own sends keep their rendered text (shadow mode shows "this is what would have gone out", and the run
  page shows the words on tap) for 30 days by default, a per-company setting.
- Contacts keep the facts templates render from: name, timezone, tags, intake answers, identifiers. Events keep the
  facts triggers fire on. Runs and steps are the product and are kept.
- Nothing in the dashboard shows a message log; the run page shows a send's words only inside that run.

## D39. A check can wait for its condition (2026-10-09)

Tyler, on Dai Davenport's new-lead run stopping at "only if phone number exists": "Can we adjust that to wait for 24
hours or something? Wait until phone number exists for up to 24 hours. If it doesn't exist by then, exit." A `check`
takes an optional `retry: { every, for }`: when the condition is false the run parks on the step and looks again every
`every` until `for` has passed, then takes `else_exit` as before. New lead waits a day for a phone number (a Calendly
booking or a CRM edit usually brings it), looking every ten minutes. On the chart a check reads as an if: "If phone
number exists · waits up to 24 hours", with its else hanging off the side as a dim stop ("else: no phone number").

## D40. One vocabulary on the chart: titles, gates, chips, Done (2026-10-09)

Tyler, from the phone: "I'd like it to be either or. Filter or if / then. Right now it's half and half." "Tell the
team" and "reply in the thread" "don't really tell what happened. I'd rather it be descriptive and still short."
"The done:recorded should just be 'Done'." "It doesn't show that these steps are conditional. Yet in the history it
shows they were skipped." "If the card doesn't exist we should have one."

- A node may carry `title`: the words the dashboard shows for it, over the generic words. Slack and text steps in the
  templates now say what they post ("Post call review in Slack", "Post scorecard in the thread", "Text the rebooking
  link"). A task's `title` is the task itself, shown as "Task: send them a personalized video".
- Two shapes, never a third. A gate is an "If …" decision with its else hanging to the side as a dim stop pill. A step
  that only sometimes runs keeps its normal shape with the blue mark; tap it for the condition. A card move with
  `if_missing: skip` is such a step ("only if a card is already on that board").
- Every exit reads "Done". A stop (an `exit` with a "Stop: …" reason) keeps its reason as the note under the row and in
  the run's state line ("done · not a sales call").
- Tags are chips in the mono face; stage moves are blue chips "Setter → showed". Both on the chart, in the step list
  and in the words sheet. A stage chip too wide for a narrow column splits at the arrow into two.
- Every step carries the logo of what it touches, at the left. Node text is measured per glyph so a title never spills.
- Call cancelled creates its cards when they are missing (a cancelled call always has its cards); the other
  `if_missing: skip` moves stay as they are until Tyler decides (see the audit in the session).

## D41. The CRM is the truth about cards (2026-10-09)

Calvin Coates booked and the setter card move skipped: "no open card on this board". He had one, made by a GHL
workflow on the 6th; the engine only looked in its own `pipeline_cards`. Tyler: "GHL is the source of truth on
all tags and pipelines and pipeline stages. Read first. Check the contact for opportunities in GHL. That way we
won't have duplicates."

- Before a card step, and before each run's context is built, the engine reads the contact's cards from the CRM
  (`openCards`) and folds them into `pipeline_cards` (`src/engine/cards.ts`): a card it never made is adopted
  (with the contact's open pursuit, or a new one opened by the CRM); a known card takes the CRM's stage, name
  and status. Rows are never dropped on absence: the CRM's search index lags a create by seconds. A snapshot
  older than the engine's own last write to that card is ignored for the same reason.
- A card step with a stage moves the card the CRM has, or makes one when there is none. `if_missing: skip` is
  gone from every template. A card step with no stage (mark it won) marks the open card and does nothing when
  there is none; the chart shows that as a sometimes-step. A card made without a name carries the person's.
- A CRM that cannot be read fails the step; the engine never guesses and creates a duplicate.
- Contacts that predate the engine's first poll never fire New lead (the baseline is silent by design); their
  cards are found the first time any step asks.
- Also in this batch: one AI read for notes and scorecard (`analyze.into: ["notes", "rubric"]`, prompt
  `call_review`); `set_var` takes `when` / `else_value` so a line of copy chosen by a fact needs no fork
  (setter-call-logged); `no_reply` and `escalated` exits read "Done", not "Stop".

## D42. Setup is read-only; the utility pages fold into the pages they belong to (2026-10-09)

Tyler: "settings is read only for now"; yes to deleting sends, folding appointments, payments and recordings
into the contact page, triggers into health, and a short wrap-ups list. The old Next pages and their server
actions are gone; `/app/c/<slug>/setup` is built from the same manifest-driven rows (`src/api/setup.ts`), with
the CRM's names for ids. The contact page carries History (calls, payments, recordings); Health carries "What
can start a workflow"; `/app/c/<slug>/wrap-ups` lists each wrap-up as sent. Changing setup is the install
API's and the CLI's job until the chat drives it.

## D43. A Slack preview looks like Slack (2026-10-09)

Tyler: "Anywhere we have a slack message it should look like it's a slack message... like a slack message was
screenshot out of slack." `dashboard/src/ui/slack.tsx` draws a post as Slack does: the face (the step's `as`
emoji or image), the bot name, the APP tag, the time, and mrkdwn rendered (bold, italic, strike, code,
links, mentions, quotes, bullets, emoji shortcodes). A thread reply is indented with a thread line; a shadow
send carries the 🧪 shadow mark. The chart popover and the step rows use it for every Slack step; texts and
emails keep the plain quote.

## D44. One Slack message per event; updates are reactions and thread replies on it (2026-10-09)

Tyler: "I don't think I want it to post to slack. The better option is having it respond with an emoji to that
same post saying that they are booked... put the specific message they sent in the thread below. Keep
communication as condensed and localized as possible. Any new event gets its own message and any updates to
that event get emojis and threads."

- The booking post (Call booked) is remembered under `appointment:<id>` (`tag`). Everything that happens to that
  appointment lands on it: a reply to the booking text is a reaction plus a thread reply quoting what they
  wrote (✅ confirmed, ❌ cancelled, 🔁 reschedule request, ❔ unclear), four hours of silence is ⏳ in the
  thread, a real cancellation (Call cancelled) is ❌ with the cancel post as the thread reply. None of these
  are new messages in the channel any more.
- When the booking post is not there (the booking predates the engine, the channel was unbound) the reply
  posts to the channel and says so, as `thread_of` always has.
- The dashboard shows a thread reply indented under a thread line and names the reaction it leaves.
- Still their own message: the booking card, a recording's review, a payment, a signed agreement, the day's
  summary.
- Tyler, same day: "reschedule, yes. No-show, the ghost is good. Show: when the recording lands; the call review
  is its own thread. Payment: its own alert, plus a cash emoji on the lead and the booked call." So: a reschedule
  is 🔁 with the new time in the booking thread and no new card (Call booked branches on `event._type`);
  a no-show, however noticed, is 👻 on the booking post (the `no-show-noted` template, once per appointment);
  a show is ✅ on the booking post when the recording lands, and the review stays its own message, remembered
  as `recording:<id>`; a payment stays its own message and adds 💵 on the person's latest booking post and call
  review. `thread_only: true` on a post means "nothing when the post it reacts to is not there", so decoration
  never becomes a stray channel message. `only_if` on any node runs it only when a fact holds, shown as a
  sometimes-step; it replaces a fork whose branches would carry one step each.
- Hair's Slack app was reinstalled with reactions:write the same day; the token is stored by the install API
  (`slackToken`), never in the repo.

## D45. A tap in Slack is a fact; a person is in a workflow once at a time (2026-10-09)

Tyler, on the "? Reply to read" post: "Unclear response, please confirm. It should have the message that was sent
out, the reply, then reply with ✅ for confirmed or ❌ for unconfirmed. It would respond with both of those emojis so
you can just click on it. Once they click, the app removes its own x and check emojis." And on Calvin being in
pre-call twice: "Each person should only be allowed in any given workflow once at a time. If they rebook then the
second call is the correct one. They should be taken out of the workflow."

- A post may `offer` reactions (added to itself for a person to tap) and `unreact` (take the bot's own reactions
  off a post once a person has decided). `react` may be several.
- A new door, `/api/webhooks/slack/<companyId>`, takes Slack's Events API (signature verified with the company's
  signing secret, `secret.slack_signing`; URL check answered; deliveries deduplicated; the bot's own reactions
  ignored). A reaction on a post the engine remembered under a tag becomes a `slack.reaction` event carrying the
  tag's kind and ref, who reacted (by name when they are on the roster), and the run's contact and appointment.
- Pre-call's unclear reply now asks: what we sent, what they wrote, tap ✅ or ❌; remembered as
  `decision:<appointment>`. The `booking-decision` template starts from the tap: ✅ tags confirmed and reacts ✅
  on the booking post; ❌ cancels the appointment (Call cancelled does the rest) and reacts ❌; both note who
  decided in the thread and take the bot's ✅ ❌ off the question, so only the person's tap remains.
- When a run starts for a person, any older run of that workflow parked for them exits as "superseded: a newer
  run for this person" (a run mid-step inside its lease is left to finish). Reentry policies still decide whether
  the new run starts at all.
- "Call recorded" is "Sales call recorded"; the triggers read "Fathom recording received" and "Dialer call logged",
  so the chart says where each comes from.
- Slack app setup for this: scope `reactions:read` (plus `reactions:write`), Event Subscriptions on with the
  request URL above, bot event `reaction_added`, the signing secret from Basic Information given to the install
  API as `slackSigningSecret`.

## D46. No recording by end of day is a presumption, not a mark (2026-10-09)

Tyler: "The no-recording no-show: I don't think we should mark them as no-show anymore. We should assume they're a
no-show for the EOD, but not actually marked as no-show until confirmed by the closer." `assume_no_show` now sets
`appointments.presumed_outcome = 'noshow'` and nothing else; the closer's end-of-day form opens with no-show
prefilled for that call; their answer, through the disposition path, is the fact that fires `appointment.outcome`
and from it the no-show texts, the 👻 and the CRM. The template is "No recording, presumed no-show".

Also, D40 corrected on the chart: an if-node carried a funnel glyph next to its else pill, which read as both
conventions at once. The glyph is a decision diamond; the else pill stays. Either filter or if/then means if/then.

## D40 addendum: gates read "Check <fact>", carry the split glyph, and their constants (2026-10-09)

Tyler: "If there is a possible out, the top left should be that little split icon. The wording is too complex; it
should be in simple English: 'Check the call is longer than 60 seconds'." A gate is drawn with the same split glyph
as a fork (there is a way out), titled "Check <fact>" with the workflow's own constants filled in (`vars.min_seconds`
reads as 60 seconds), negations in English ("they have not signed", "there is no transcript"), the else as the pill
and "Otherwise the run stops: too short" on tap. No blue line on a gate: it is not a sometimes-step.

## D47. Jev is real now: the verified shape, the ambiguity gate, and replies in pieces (2026-10-09)

I had reported "Jev is connected" while checking the Anthropic key. Wrong: Jev is TypeSafe AI, the reply reader
of D5c, and it had never been connected; every reply was classifying as unclear. Tyler: "Jev should be better. We
can use the 'please confirm' text plus the response, or multiple responses (very important). If they respond 💯 we
can see that's a response. But if they respond 👎 that's ambiguous and should require a human."

- Verified live against `POST https://api.typesafe.ai/v1/systemone` (model `jev-latest`, answering `jev-1.13.0`):
  `state` + `questions` keyed by name, a `choice` with `criteria` (label → meaning) and a `noul`; answers under
  `answers.<name>` as `{ choice, confidence, probabilities }` and `{ noul }`. The adapter sends two questions for
  every classification: the choice, and "a careful person would not be sure what this means". It acts only when the
  choice clears `threshold` AND the doubt is under `ambiguity_max` (0.8); otherwise `unclear` → a human. Probed:
  💯 👍 🔥🔥 "yes see you then" → confirmed; "no thanks" → cancelled; "thursday instead" → reschedule; 👎 👀 "maybe"
  "idk" "hmm" → a human.
- A classify node names what each option means (`criteria`), in the template, so the vocabulary is the workflow's.
- Replies come in pieces. `wait_for_reply` has `settle` (90 s): after the newest message it waits for the rest; a
  further message restarts the clock. The classifier then reads everything since our last send as one reply
  (`reply.inbound_since_send`); the Slack question quotes all of it.
- The key is a company binding (`secret.jev_key`, install `jevKey`) with `JEV_API_KEY` as the server fallback; the
  health sweep checks it answers and warns when there is none.

## D48. Jev makes the three call decisions; Anthropic writes the prose (2026-10-09)

Tyler: "We should use Jev to see (a) if it's a setting call, (b) if it's a sales call, (c) what is the outcome of the
sales call." Those were Anthropic reads returning JSON; they are now `classify` steps over three vocabularies seeded
in core_categories: `setter_call_type` (setting, confirmation, other), `recording_kind` (sales call, internal,
other) and `sales_call_disposition` (closed won, close pending, follow-up, lost, disqualified, financing denied,
unclear). A classify step carries the `question` Jev is asked and what each answer means; the transcript is the
text, verified live at 18k characters. The Sales Call record's disposition and the Slack outcome line come from
Jev; Anthropic keeps the notes, digest and scorecard. Below the threshold, or a transcript a careful person would
read two ways, the answer is unclear and the record's disposition is left blank rather than guessed.

## D49. A failed payment is the closer's problem, told in Slack (2026-10-09)

Tyler: "Payment Failed should post to the slack channel… this automation shouldn't SMS, it should ping slack and tag
the closer." The old chase (text + email, two days, then the owner) is gone. The workflow is one step: a post in
`slack.channel.payments` with the amount, the contact link and the closer @mentioned, who follows up personally.
The client hears nothing from the engine about a declined card. It lands in the payments channel because that is
where everything goes today; when the team splits channels, the binding moves and the template does not.

## D50. Tags are the CRM's tags (2026-10-09)

Tyler: "read first, corroborate what we've got. invent nothing." The Setup page now reads the CRM's tag list and shows
every tag beside the workflows that add or remove it and how many contacts carry it. Reading Hair's list: `confirmed`
became `stat-confirmed` (the CRM's spelling; Call cancelled already removed that one); `stat-unconfirmed` and
`stat-agreement-unsigned` were created in the CRM and the templates use them; a no-show tags `stat-no-show`, the tag the
CRM already had on 24 contacts, and not `seq-no-show` (there is no no-show sequence yet); `engaged` (Speed to lead) and
`rebooking` (No-show recovery) were ours alone and are gone. Call outcome tags (`stat-follow-up`, `stat-lost`,
`stat-disqualified`, `stat-closed-won`) come from the closer's end-of-day answer, never from Jev's read alone: the
transcript only pre-fills the form. They land with the end-of-day outcome work (items 12–13). `opt-in lead` stays as
written for now (Tyler: "nothing else"); the CRM spells it `optin lead`, so that remove step matches nothing today.
Two legacy workflows on Hair, "Appointment reminder with reply handling" and "Booking confirmation", were removed
through the new admin DELETE; they were off and superseded by the pre-call sequence.

## D51. Go live clears the rehearsal (2026-10-09)

Tyler, on what happens to runs that started in shadow when the switch flips: "remove those tests to clean up the data."
Every run is stamped `born_in` with the company's mode at the time. Go live is refused while readiness has a blocker
(the dashboard shows which), then deletes every shadow-born run with its steps, its would-sends and the events it
wrote, and only then sets the mode. A run started after that is live-born and ordinary. Back to shadow is the flag
alone. The full-scope CRM token is not probed at Go live (Tyler: the token is full scope; the end-to-end test will
prove it); a write the CRM refuses still raises an alert. Message bodies nobody has written are `[placeholder — title]`
and nothing more; readiness warns how many an enabled workflow still carries, and does not block, since the team is
testing with them. Rehearsal (item 7) and Go live are separate switches, so neither flips the other by accident.

## D52. The ladder: shadow, test, rehearsal, live (2026-10-09)

Tyler: "ghost mode, then test mode, then dress rehearsal before live… Nothing even touches GHL to write, then ONLY
sys-test and @jtylerray.com, then ONLY @jtylerray.com, then full test." The company mode is that ladder. Shadow writes
nothing. Test writes and sends only for a contact tagged `sys-test` or whose email is on a test domain; rehearsal
only for the domain, so the contact can arrive through the real funnel untouched; live is everyone. Two gates carry
it, for dual safety "so nothing gets duplicated in front of the client": a run about a contact does not start unless
the contact passes, and a run already in flight exits at its next step if its contact no longer passes; a send to a
contact that does not pass is suppressed even inside a run. Team-facing runs (end of day, wrap-ups, health, the
evening sweep) have no contact and follow only their own switch. The domain is a company setting (`test.domains`),
never a constant; Hair's is jtylerray.com because that is Tyler's. Test contacts are created in the CRM by Tyler,
never by the engine ("this is to keep you from doing anything unexpected"). Slack posts before live say which rung
they came from. Going live clears every run not born live (D51) and workflows still go on one at a time.

## D53. The question waits for its own answer (2026-10-09)

Tyler, on the separate "Booking decided in Slack" workflow: "Remove 'Booking decided in Slack' workflow; pre-call gets
a wait step that waits for a reaction on that specific question message (✅ ❌ 🔁), then branches." "Workflows accomplish
one task… directly related steps stay inside one workflow." On what a tap means: "tyler responded ✅ to Jeremy, mark
Jeremy as confirmed" — never everyone. The unclear-reply question offers Confirmed, Declined, Rescheduled (🔁 → a
reschedule request: the rebooking link goes out, the same path as a reply that asks to move the call). And the post
is made *as* a persona named "Unclear reply, please confirm", so the body must not start with that title again.

- A new node, `wait_for_reaction` `{ of, emojis, timeout?, into? }`, parks the run (`runs.wake_on_tag` = the tag of
  the post it waits on, the way `wake_on_reply` marks a reply wait) until a team member taps one of `emojis` on that
  very message. The Slack door still turns the tap into a `slack.reaction` event (D45); it now also wakes every run
  waiting on that post's tag, and the step reads the tap back from the event by the message itself (channel + ts).
  Another post's tap, another emoji, a removal or the bot's own reactions change nothing. The tap lands under `into`
  (default `reaction`) as `{ reaction, user, user_name, ts }` and is carried in the run's context. With `timeout`,
  silence continues with `reaction` null for a branch to handle; without one, only the tap moves it.
- Pre-call's unclear branch is now: the question (tagged `decision:<appointment>`, offering ✅ ❌ 🔁, body without the
  repeated title) → `wait_for_reaction` on it (a day) → a branch: ✅ takes the confirmed path, ❌ the cancel path,
  🔁 the reschedule path, nobody → the reminders go on. The three paths are the ones a prospect's own words take: one
  `stat-confirmed` step, one cancel, one rebooking text, and their thread replies now also take the bot's ✅ ❌ 🔁 off
  the question and end with "Decided by <name>" when a person decided. The run stays ONE run for ONE contact, so the
  reaction is matched to that contact's own question message, never to the whole team's. `stat-unconfirmed` comes off
  whenever a call is confirmed (a contact may still carry it from an earlier booking).
- `booking-decision` is deleted: the separate workflow it was is now a wait step inside the one it belonged to.
- Found on the way: the door's `source: 'slack'` was never in the events check constraint (the door had no DB
  test), and "our last message" for `reply.*` counted a Slack post about the contact as a message to them. Both fixed:
  `slack` is an event source; the last outbound is a text or an email only.
