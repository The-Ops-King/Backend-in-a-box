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
  is 🔁 with the new time in the booking thread and no new card (Call booked branches on `event._type`; superseded by D71: the card again under a 🔁 face);
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

### D51 addendum. The clean slate (2026-10-09)

Item 9, "mark everything test-born and build one wipe": Go live is the wipe. Besides every run not born live, it
removes every synthetic appointment the test harness staged (`source='test'`, Calvin's ghost booking among them) with
the events, recordings and form submissions that pointed at it. Real CRM facts stay: contacts, their tags and real
appointments are the CRM's, not ours to delete. A live-born run that pointed at a synthetic booking keeps its history
and loses the pointer.

### D52 addendum. Three rungs, not four (2026-10-09)

Tyler: "test and dress rehearsal are the same… ghost, everyone with nothing moving, but we check what WOULD have
happened (including making sure it has the right pipeline stages and such). Then combine dress-rehearsal / test:
sys-test and @jtylerray.com, actually move and test and message ONLY that one. Then live in pre-determined sections."
The rehearsal rung is gone (it lived an hour; the migration folds it into test). Shadow is the ghost: every run's
steps record the card, stage, tag and message that would have happened. Test is the dress rehearsal with real
effects for test contacts alone. Live arrives by workflow switch in three sections: the simple ones that one test
proves (payments, agreements), then the ones that only note things (call outcome, end of day, wrap-ups, health,
calendar watch), then one system at a time (booking, cancellation, recordings, setter calls, the chase; pre-call
last of all), so a break is one switch away from being undone.

### D52 addendum 2. Test mode shows everyone, touches only the test contacts (2026-10-10)

Tyler: "Right now I still want to see what would happen on contacts and stuff but only actually send to me." Test is
now the hybrid of its two neighbours. A contact that passes (`sys-test`, or an email on a test domain) gets everything
for real: CRM writes, texts, emails, Slack posts prefixed 🧪 *test*. A contact that does not pass is handled exactly as
in shadow: the run starts and goes all the way through, every CRM write recorded as would-have, every send recorded
`shadow` (would-send), Slack posts prefixed 🧪 *shadow*. Nothing changes for shadow (everything shadowed) or live
(everything real). The two gates of D52 (dispatch refusing the run, the runner exiting a run in flight, `doSend`
suppressing "not a test contact") are gone; `contactPasses` is the one rule, and the runner turns it into a per-run
effective mode (`effectiveMode`, on `ExecDeps.effective`) once per claim, so a contact whose tag comes off mid-run
shadows from its next step instead of exiting, and a run with no contact (end of day, wrap-ups, health, the board
poll) stays real in test, as before. Every run in test is still born in test; Go live still clears it (D51).
## D54. One workflow per call outcome (2026-10-09)

Tyler, on the three small post-call workflows: "Remove 'No recording, presumed no-show' workflow; EOD form defaults to
no-show when call time passed and attendance empty; nothing marked." "Remove 'No-show noted' workflow; reactions move
into the EOD-filed automation as conditions (showed → ✅, no-show → 👻). Sales call recorded keeps its own ✅ ('we can be
100% confident they were a show'); EOD show ensures ✅ but doesn't overwrite." "Remove 'Payment received' (default);
'Payment recorded' stays." And the rule behind it: "Workflows accomplish one task… directly related steps stay inside one
workflow." "Simplify and condense wherever possible."

So three templates are gone and one arrived. `no-recording-no-show` and its `assume_no_show` step (D36 addendum, D46)
are deleted: the end-of-day form itself now opens with no-show for a call whose end time has passed with no recording, no
recorded outcome and no money, and nothing is marked until the closer answers (the ledger's outcome and money still
outrank it; Jev's read of a transcript still pre-fills a recorded call). The `presumed_outcome` column stays, unread.
`no-show-noted` and `payment-received` (the default thank-you email + `client` tag; `payment-recorded` is the real one)
are deleted.

`call-outcome` ("Call outcome filed") is the one workflow for what a closer filed. It starts on `appointment.outcome`,
which the disposition path emits once per call, so one run is one call, whichever form filed it (end-of-day or the
per-call disposition); the trigger takes only a closer's filing (`event._source` is `disposition`), because the engine's
own showed, written when a recording lands, is Sales call recorded's business and already carries its ✅ and
`stat-showed`. The CRM marking a no-show is `appointment.status_changed → noshow`, which never passes through
`appointment.outcome`, so the second trigger from No-show noted stays and goes straight to the 👻. A branch on
`event.outcome` carries the owner's conditions as pills: no-show → 👻 in the booking post's thread and `stat-no-show`;
showed → ✅ in that thread (Slack answers `already_reacted` when the recording's ✅ is there, and the engine reads that as
done, so the EOD show ensures the ✅ and never doubles it) and `stat-showed`, then a second branch on the call outcome;
rescheduled → stop, Call booked already posted the 🔁 card (D71). The call outcome is read from the appointment row
(`appointment.call_outcome`, new in the run context) rather than from a `call.held` trigger: `call.held` fires after
`appointment.outcome` for every show, so starting on it too would mean two runs per filed call, or a trigger match that
hides the showed/no-show condition the owner wanted on the chart; the row is what the closer's disposition just wrote,
so the value is human-confirmed by construction (D50: "use the fathom only as a way to 'tentatively' pre-set the EOD
notes. until they can be confirmed by a closer."). Tags, from the CRM's own list: closed or deposit → `stat-closed-won`,
follow-up → `stat-follow-up`, lost → `stat-lost`, disqualified → `stat-disqualified`; the form has no financing
outcome, so `stat-financing-pending` is not written by anything. Reentry is `always`: a CRM no-show followed by a filed
show (or a corrected refiling) must react again, and `once_per_appointment` would have blocked it for good.
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

## D55. The closer decides a cancel or a reschedule; Jev is scored (2026-10-10)

Tyler: "I don't know if I trust Jev yet to catch 'canceled my appointment' or 'reschedule my appointment' each time.
So if it's one of those two things, we should alert the closers and not actually cancel the meeting until there is a
confirmation, so let's do a Slack that says essentially 'hey this person wants to cancel just FYI' and let us choose
checkmark to keep, x to cancel, and reschedule to reschedule. Same with reschedule. Let the closer do it for now. And
let's track how often it's actually correct, and eventually we can automate it if it's correct enough."

- Pre-call's reply branch acts on its own for ONE reading only: a clear yes still takes the confirmed path (tags, ✅ in
  the thread) with nobody asked. Everything else — Jev reading a cancel, a reschedule, a question or nothing it can
  name — goes to the one question D53 built for unclear replies, now with Jev's read in the body ("Jev read this as:
  they want to cancel." / "…they want to reschedule." / "…I couldn't tell what they meant."), the *We sent* / *They
  wrote* quotes and "Tap ✅ keep the call, ❌ cancel it, 🔁 reschedule (they get the rebooking link)". One question node,
  one `wait_for_reaction`, one branch for all of them; the sentence is a `set_var` picked by `reply.intent`, hidden
  plumbing like the rest. Nothing touches the appointment and nothing is texted to the prospect until a person taps:
  ❌ is the only way the appointment is cancelled from a reply, 🔁 the only way the rebooking link goes out. The thread
  replies keep "Decided by <name>".
- Jev is scored on every tap. A new node, `record` `{ event, data }`, writes one event with rendered data to the
  ledger and nothing else (ours, never the CRM; shadow too; a path the run does not have lands as null rather than
  failing a run over bookkeeping). Pre-call derives `decided` from the tap (✅ confirmed, ❌ cancelled, 🔁
  reschedule_request) and `agreed` = Jev's read equals it, then records `intent.reviewed` `{ predicted, decided,
  agreed, decided_by, appointment_id }` — only when someone tapped; a day of silence records nothing. Unclear and
  question never agree. `intent.reviewed` is an event type in the schema seed and the migration, so the sweep will
  name a `record` step whose event the ledger does not accept.
- The company Health page reads it back: "Jev's reads this month: N reviewed, K agreed (P%)" with the same split by
  what Jev predicted in a fold. Read-only; the number that says when cancels and reschedules can be automated again.
- `set_var` gained `pick`: `value` rendered and looked up in a map, `else_value` when nothing matches — a three-way
  choice without two chained `when` steps. `constsOf` ignores a picked var the way it ignores a conditional one.

## D56. Six gaps closed before the first live week (2026-10-10)

The edge-case catalogue (05-edge-cases.md, Known gaps) proved ten things the engine did that an operator would not
expect; six were engine bugs with no template decision pending, and each had an `it.fails` test stating the right
behaviour. Those six are fixed and the tests are plain `it(...)` now. The standing rules decided every one: late, never
lost (D5); a failure is recorded and alerted (D33), never fixed by skipping; nothing hardcoded. G6, G7 and G10 wait on
template decisions and stay as they were.

- **G1, a text the CRM refuses.** A send the CRM turned down (no number on the sub-account, no phone on the contact) came
  back as a failed step, which failed the run: a pre-call sequence died at its first text and no reminder ever went.
  Now the send row is `failed` with the CRM's message, the step is `skipped` as blocked, the alert sweep raises "step
  could not run … the run went on without it" (D33), and the run continues to the reply wait and the emails.
- **G2, the booking source unreachable at the premise check.** `premiseAlive` reads the booking source live; a 401 after a
  token rotation or a 5xx threw, and the runner's catch marked the run failed for good — every due reminder lost at once.
  Now the runner tells "the check could not run" from "the check said no": a throw keeps the run `waiting`, its wake flags
  intact, with `next_run_at` `PREMISE_RETRY_MIN` (5 minutes, one knob in `runner.ts`) out, and opens one alert per
  company (`premise:booking-source-unreachable`) that is touched while the outage lasts and resolves when a premise read
  succeeds again. A real `ok:false` (cancelled, already happened) still exits the run as before.
- **G3, a workflow turned off while runs were parked.** The switch was read only when a run started, so turning a
  workflow off in week one — the one-switch undo D52 promises — left the texts already in flight going. Now every claimed
  run re-reads `workflows.enabled` before anything else; off means the run exits `workflow turned off` with a
  `run.exited` event. Turning the workflow back on starts fresh runs from new events; nothing resumes half-done.
- **G4, D45 on `always` workflows.** "A person is in a workflow once at a time; the newest run wins" was applied to every
  workflow, so two payments in one minute, two recordings of one call or two dialer calls in one poll superseded the first
  run before it ticked and its fact was never written. The rule now applies only to runs about one person-level fact:
  reentry `once_per_contact`, `once_per_appointment`, `once_per_contact_per_window`. `always` (and `once_per_opportunity`)
  runs are each about their own fact and are never superseded. D45 still holds for the pre-call sequence: a rebooking
  replaces the old run. Found on the way and fixed: a `thread_of` tag the context cannot name (`contact.latest_recording_id`
  for a contact never recorded) is "no post to reply to", not an unknown-path failure of the run.
- **G8, Slack refusing the bot token mid-run.** `slack_post` and `notify_owner` let `notifier.post` throw, which failed
  the run; in Sales call recorded the post comes before the Sales Call record on purpose, so a revoked token meant the call
  was never written to the CRM. Now the refusal is caught: the send row is `failed` with Slack's error, the step is
  `skipped` as blocked (one open alert per workflow step, repeated at most hourly through the existing dedupe), and the
  run goes on to the CRM steps.
- **G9, go live by re-install.** `installCompany` with `mode: "live"` wrote the flag directly: no readiness check, no clean
  slate (D51), so a shadow-born run parked for a real contact would send for real at its next wake. Install never writes
  `live` now. With `mode: "live"` it finishes the install, then calls `goLive`: refused with the blockers listed while
  readiness has one (the company keeps its mode), otherwise the rehearsal is cleared and the result carries it as
  `wentLive`. Any other mode value sets the flag as before. The test fixtures that installed straight to live without Slack
  (funnel, scenarios) now set the flag themselves and say so: the scenarios assert what happens while Slack is not connected.

## D57. A refund is a line with a minus sign (2026-10-10)

Tyler, on what a refund should do to the payment tracker: "I think we wanted to add a new line to the payment tracker
with a negative number." Until now nothing listened to `payment.refunded` (edge case G10): the ledger lowered the
running total, but cash collected on the contact and `pay-paid-full` stood after the money went back. "Directly
related steps stay inside one workflow", so the refund lives in Payment recorded, not in a workflow of its own.

- Payment recorded has a second trigger, `t2` on `payment.refunded`. The event carries the same shape as
  `payment.received` (the amount already negative, `kind` refund, `running_total` already lower), so the steps that
  compute from the event do the right thing untouched: cash collected = the lower running total, the Sales Call
  record's cash collected follows, and the Payment record is a NEW line keyed by the refund's own provider id with the
  negative `amount`, `type` refund and `status` refunded — never an edit of the payment it reverses. The CRM's Payment
  picklists must know `refund` and `refunded`; there is no `oneof:` guard on these two fields, so an option the CRM
  lacks would be dropped by it silently.
- One `set_var` (`v1`, `pick` on `event.kind`) chooses the words, the sign and the emoji for both paths, so there is
  still one Slack post node (`*Refund:* −$500` instead of `*Payment received:* $500`, posted as "Refund"), one note
  (`REFUND — …`) and one pair of thread lines, now 💸 "Refunded" with a `money_with_wings` reaction where a payment
  gets 💵 and `dollar`. `react` on a Slack post is rendered like the template, so it can be picked; a new `abs` filter
  gives the number without its sign and the template writes the minus itself.
- Tags: `pay-refunded` is added on the refund path only (`g1`, the refund edge off the same branch that sets the
  paid-full / plan tags, with `only_if` kind = refund as belt and braces). `pay-paid-full` and `pay-plan-active` are
  NOT flipped: a refund is not a payment plan, and a partial refund of a paid-in-full deal would otherwise read as
  "still owes". They stay as the last payment left them; `pay-refunded` says what came back. `pay-refunded` is the
  only tag the owner has for it; no other tag was invented.
- Not re-done on a refund: revenue generated (the stamp edge also requires kind ≠ refund, so a contact whose replica
  never learned the stamp still is not stamped by a refund), the agreement send (same guard on the first-payment edge).
  The ledger side was already right (`payments.ts`: refunds count negative in the running total, `cleared` recomputed).
- Found on the way: the 💵 thread lines named `tag:appointment:{{contact.latest_appointment_id}}` and
  `tag:recording:{{contact.latest_recording_id}}` without `default:`, so a payment for a contact with no recording (or no
  booking) failed the whole run at that step whenever the calls (or bookings) channel was bound — the Payment record
  was written, the exit never reached. Both now render empty and the step skips as "no post to reply to", which is
  what `thread_only` was for.
- Open, catalogued: a refund that brings the total to zero followed by a new first payment (`prior_total == 0` matches
  again); a refund of the whole deal leaves `pay-paid-full` on by this rule, which is the intended reading until the
  owner says otherwise.

## D58. The question stays open while the reminders go on (2026-10-10)

Tyler, on the D55 question blocking the sequence: "Reminders go out, but we ping the channel, to say 'hey something is up
with this client'… the person who said maybe still gets reminders, but then the closer can reach out." "If the call starts
with no tap, it takes the normal route, BUT we should tag it like 'possible cancel'… the 'needs attention' tag should be a
temporary tag, so we can filter by anyone who needs attention… the possible cancel should be like 'hey we're pretty sure this
guy canceled and we didn't open up the slot'." "Store Jev's confidence locally and mention it in the Slack notification for
cancel / reschedule, like 'we're 95% sure this is a cancel'." On where the question goes: "default to the same one as the
booked call, but in reality we should have our own attention / cancel channel." And: "I'm the data king, I want all the data."

- `wait_for_reaction` gained `blocking: false` and `until` (a wait rule). The step arms a *listener* on the run (`vars.__listen`:
  the post, the emojis, the until) and the run goes straight on along its plain edge. While the listener is armed every park
  also wakes on that post's tag (`runs.wake_on_tag`, as the blocking form did) and no later than the until, and the runner
  writes where the run parked and when it was due (`runs.resume_node`, `runs.resume_at`, new columns). At every wake the
  runner looks first for a tap on that very message (one of the emojis; the door's `slack.reaction` event, as D53): a tap
  jumps the run to the step's edge labelled `tap` with the tap under `into`; the until time (or the run reaching an exit with
  the listener still armed) jumps it to the edge labelled `until` with `into` null; a stray emoji wakes it and it goes back to
  sleep on the same step. A new node, `resume`, ends a listener's path: back to the step the run was pulled from, which
  re-parks itself with its own due time (a `wait` recomputes from its anchor, a reply wait keeps its pinned deadline). The
  edge labels `tap` and `until` join `timeout` as side paths a step never follows on its own (`SIDE_LABELS`). The blocking
  form is unchanged and remains the default; the chart draws the listener as "Listen for a reaction" and the two labelled
  edges, and the run page shows the arming and the jump as two rows of the same step.
- Pre-call's question (`n_ask`) is its own message in a new optional channel, `slack.channel.attention` (install input
  `slack.attention`; Setup: "Attention channel (open questions)"), falling back to `slack.channel.bookings` through a new
  `slack_post.fallback_channel` — the resolver's job, so a channel with a bound fallback is not a readiness or health warning.
  It addresses the closer (`{{appointment.closer.mention}}`: `<@U…>` when known in Slack, else the name; the run context's
  `appointment.closer` gained `email`, `slack_user_id` and `mention`, and the mention resolver looks them up like the
  contact's people) and says how sure Jev was: `classify` now also stores `reply.intent_confidence` (0–100), carried in the
  run's context, and `v_read` picks the whole sentence ("Jev is 95% sure they want to cancel." / "…want to reschedule." /
  "Jev read it as a question, not an answer (N% sure)." / "Jev couldn't tell what they meant (its guesses: …)"). The decision
  lines (`n_conf_slack`, `n_cx_slack`, `n_rs_slack`) stay in the booking thread and also put the outcome on the question
  (`slack_post.react_on`, the mirror of `unreact`), so the attention channel shows ✅ ❌ 🔁 at a glance.
- The sequence after the question: note the read on the appointment (`update_appointment` `set.pending_read`, ours never the
  CRM's: `appointments.pending_read` `{ intent, confidence, at }`, exposed as `appointment.pending_read`), tag
  `stat-needs-attention`, arm the listener, on to the 3-day wait. The tap path: `decided`, `agreed`, `intent.reviewed` (now
  with `predicted_confidence`), clear the pending read, take the tag off, then the branch: ✅ confirms and `resume`s, ❌
  cancels and exits, 🔁 texts the rebooking link and exits. The until path: `intent.unanswered` `{ predicted,
  predicted_confidence, hours_before_call, appointment_id }` (a new filter, `hours_until`, and `record` data that is one whole
  `{{expression}}` now keeps the value's type, so the hours are a number), the tag off, and the same branch's else → `resume`;
  the pending read stays. Call outcome filed's no-show branch reads it: a pending cancel or reschedule read means
  `stat-possible-cancel` and `intent.unanswered_no_show` `{ predicted, predicted_confidence, asked_at, appointment_id }`.
  Both event types are in the schema seed and the migration. The two tags do not exist in the CRM yet (D50: the CRM's tags
  are the tags); Tyler creates them.
- G7 is fixed on the way: `wait_for_reply` gained `until` (a wait rule) and the booking text's wait ends an hour before the
  call (`-1h`, editable), so a call booked two hours out takes the timeout path in time for its 1-hour and 10-minute texts. A
  call booked three minutes out now moves on at once (the until is already past): every reminder is stale but the 10-minute
  text, which has no validity rule and goes.
- Seen in passing, not fixed: the morning-of wait (`rm`, 8am) sits ahead of the 1-hour and 10-minute waits, so a call before
  8am their time sleeps through itself and those two texts never go (05-edge-cases, observed).
## D59. The journey sweep's plain bugs (2026-10-10)

Tyler asked for the end-to-end sweep (`06-journey-sweep.md`); of its findings, these were bugs with one right answer
and are fixed here. The ones that need the owner's call (F2, F6, F9, F12, F14–F21) stay open in that file. Each fix
turned its `it.fails` test in `journey.test.ts` into a plain test; the step tests that pinned the old behaviour now pin
the new.

- **F10, the morning-of text.** `predicate.ts` `operand()` resolved only a bare `{{path}}`; `{{appointment.starts_at |
  date:HH}}` stayed a literal string, `NaN >= 11` was false, and the pre-call `bm` branch took its else edge for
  everyone, so the morning-of text had never gone out. Now any `{{…}}` with a filter is rendered through the template
  renderer (contact zone, else company zone) before the compare; a bare path still keeps its type so booleans and
  numbers compare as before; an unknown path renders as absent, as a bare path does. A 2pm call gets the text at 8am.
  For a call booked a few hours out the step is now reached and skipped as stale, because the booking text's 4-hour
  reply wait still holds the run (F5/G7, open).
- **F1, the texted cancel.** `update_appointment` wrote the CRM and our row and nothing emitted
  `appointment.status_changed`: the poll compares our row with the source, saw cancelled = cancelled, and Call cancelled
  and Cancellation rebook never ran, so both cards stayed at Set/Direct + Scheduled for a dead call with `stat-booked`
  on and no rebook task. Now the step emits the event the poll would have — `{source, status: {from, to}, by:
  "workflow", node}` — and dispatches it with the poll's context shape, after waking runs parked on that appointment.
  Only a real change emits (confirmed → confirmed does not); the node writes only `status` on our row, so a reschedule
  is still the poll's event. The engine fix, not a template one: a cancel decided anywhere behaves like a cancel.
- **F3, Speed to lead after a booking.** The 2-hour reply wait's only exits were a reply or the timeout, so a lead who
  booked inside the window was asked to book. The context gains `contact.has_upcoming_call`: a closing call for this
  contact, not cancelled or no-showed, starting after now, other than the run's own appointment. A `check` before the
  nudge exits the run `booked` when it is true.
- **F8, No-show recovery after a rebook.** Same mechanism: a check before the first send and before the "Want to
  reschedule?" email; a newer booking ends the run `rebooked`. `stat-no-show` is not touched: Call booked's tags are
  the GHL-side tags the owner said to leave alone until the stat tags are declared cumulative or current (F9).
- **F4, a reschedule after the sequence ended.** Pre-call started on `appointment.booked` only and was once per
  appointment, so a GHL reschedule of a finished sequence produced a call with no prospect-facing messages. A
  definition may now carry `reentry_key`, a template appended to the policy's key; pre-call's is
  `{{appointment.starts_at}}` and it also triggers on `appointment.rescheduled`. A new time after a finished run is a
  new run (booking email and text for the new time, then the reminders). A run still in flight for the appointment
  keeps it — the parked wait follows the moved time as D20 says — and the reschedule is remembered on it as a pending
  event rather than superseding it (D45 is for a different appointment of the same person). Whether a mid-sequence
  reschedule should also tell the prospect the new time is open for the owner; today only Slack hears it (🔁).
- **F7, the Sales Call record on the EOD filing.** Only Sales call recorded and Deal closed wrote
  `custom_objects.sales_call`, so an unrecorded call's record stayed `scheduled` and a no-show never got `noshow`. Call
  outcome filed now updates the record keyed by the appointment (as Sales call recorded does), when the contact has
  one: `outcome` showed or noshow, and for a show the closer's call outcome mapped to the CRM's disposition
  (closed/deposit → closed_won, follow_up, lost, unqualified → dq) through the same `oneof:` guard.
- **F13, the 💵 thread line.** "💵 Paid 1,500· deposit." read wrong because the amount had no `$` and `prefix: ·` lost
  its leading space (the renderer trims a filter's argument). Now "💵 Paid $1,500 · deposit." and "💸 Refunded $500 ·
  refund.": the `$` and the space are in the template text, `{{event.kind | prefix:·}}` after them, which is how
  `prefix:` is used everywhere else.
- **F11, three events nobody could listen to.** `payment.paid_in_full`, `opportunity.won` and `opportunity.lost` were
  emitted without `dispatchEvent`, so a workflow could not start from them. They are dispatched now, with the same
  call the other emits use; no template listens yet (F12 is the owner's decision on what paid in full should do).
## D60. Who the person is: eleven small holes closed (2026-10-10)

Tyler asked for the engine to be tried against the shapes a person arrives in: "test if a lead comes through without a
phone number or email, or a multi part name, etc." The catalogue (05-edge-cases.md § Contacts) proved eleven holes,
G11–G21, each with an `it.fails` test stating the right behaviour. Ten are fixed and their tests are plain `it(...)`;
G17 (an orphan payment healed by the buyer's later arrival) waits on D21's "nothing is guessed" and stays as it was.
The standing rules decided every one: the CRM is the source of truth; nothing is invented on the replica; a failure is
recorded and alerted, never silently skipped; nothing hardcoded; names render as typed.

- **G11, a send to a contact with no address for the channel.** `doSend` asked the CRM and the refusal was the only
  record of why. Now, before anything is queued, it reads `contact.phone` / `contact.email` from the context (the
  replica's current identifiers): no address → the send row is `suppressed` with `no phone on the contact` /
  `no email on the contact`, the step is a `noop` with the same words, the CRM is never asked, and the run goes on to
  its reply wait. G1 (D56) still covers the CRM's own refusals, such as a sub-account with no number; its test now gives
  the contact a phone so that path is the one tested.
- **G12, names stored with their spaces.** `upsertContact` and `resolveContactForBooking` trim and collapse inner runs
  of whitespace on first and last name; case, hyphens and apostrophes stay as typed (`Jean-Luc`, `cher`, `李`). A blank
  name is stored as null so the next rule can speak.
- **G13, an empty name.** The context's `contact.first_name` is the CRM's first name, else the first word of whatever
  name there is, else null. The five greeting templates (Speed to lead, No-show recovery, Cancellation rebook, Post-call
  follow-up, Reactivation) say `{{contact.first_name | default:there}}`; everywhere else the context fallback is enough,
  so no other template changed. `pipeline_card` names a nameless person's card by their email, then phone, then CRM id,
  never " -- New".
- **G14, a reply from a duplicate CRM record.** `pollInbound` resolves the sender through `contact_identifiers
  kind='ghl_contact'` first (where a folded duplicate's id lives), then `contacts.ghl_contact_id`; the reply lands on the
  one person and wakes the run parked on it.
- **G15, a retired number.** When a CRM record's own phone or email changes, the identifier it replaced gets
  `contact_identifiers.retired_at` (a new column): kept for history and shown on the contact, never matched again.
  Identity resolution for contacts, bookings and inbound reads current identifiers only, and so does `{{contact.phone}}`.
  A new CRM contact carrying a retired number takes it with them (the row moves) and is a separate person. Only the
  primary record's update retires anything; a duplicate record folding in adds, as before.
- **G16, a person who first appears as a CRM calendar booking.** `resolveContactForBooking` reports when its live read
  made a new person, and `applyAppointment` emits and dispatches `lead.created` in the contacts poll's shape before
  `appointment.booked`, so New lead and Speed to lead run; the later contacts poll sees an existing row and fires nothing.
- **G18, a healed orphan never written to the CRM.** `settle`'s heal loop, per healed row oldest first, derives its
  `kind` and emits + dispatches its own `payment.received` (`payment.refunded` for a negative) with `prior_total` and
  `running_total` as of its day and `linked_by: heal`, so Payment recorded runs once for it; a row that already has such
  an event is skipped; `payment.linked` is still written.
- **G19, `1-602-555-0901`.** `normPhone` treats ten digits, or eleven with a leading 1, with or without the plus, as one
  US/CA number (`+1` + ten digits); any other length stays as typed.
- **G20, a garbage CRM time zone.** Validated with Luxon at upsert (CRM and booking): an unusable zone is stored as the
  company's with `timezone_source='company_default'`, exactly as a missing one is (one convention, not two). The context,
  `contactTz` and so the runner's window math also fall back to the company zone when a stored zone is unusable, so no
  invalid `next_run_at` ever reaches Postgres.
- **G21, a contact gone from the CRM.** A send that comes back with the CRM's "contact not found" (a 404, or its
  `Contact with id … not found`) stamps `contacts.gone_at` (a new column), raises one alert per contact
  (`contact:gone:<id>`, warning) and parks the run to be looked at again at once; the premise `contact_exists` reads
  `gone_at` and exits it `moot: contact gone` at that next look, as it does every other run about them. The send that
  met the refusal stays on the ledger as `failed` with the CRM's words. A CRM record that comes back, or the person
  re-made under a new id with the same email or phone, clears `gone_at` and resumes as themselves. Not done then: a sweep
  that asks the CRM about contacts with live runs; the engine learned at the first write. D68 moved the learning
  ahead of the write: every run reads the contact live before it acts.
- **G17, left.** Healing an orphan when the buyer's contact arrives through the CRM poll is a D21 question (an exact
  email match is what `resolvePayer` already trusts, but the owner decided that nothing links without a payment or a
  hand); the test stays `it.fails` until that is decided.

## D62. Milestone tags that would misfire come off; booking receipts go at once (2026-10-10)

Two owner calls on the journey sweep's open findings (06-journey-sweep.md F9 and F21).

On the tags (F9, the open half of F8): "Tags are mostly milestones. BUT I think if they book again, the 'no-show' or
'canceled' should be removed so we don't get any weird behavior, like if someone filters by 'canceled' tag, and someone
who showed up to their last call gets a 'you canceled your call' message." So the `stat-*` tags stay cumulative, with the
exceptions that would put a person in the wrong filter:

- **Call booked** (`call-booked.json` s5 self-booked, b6 setter-booked — the one tags step per path) removes
  `stat-no-show`, `stat-cancelled`, `stat-possible-cancel` and `stat-needs-attention` beside the four nurture tags it
  already removed (`seq-no-show`, `seq-nurture`, `seq-winback`, `opt-in lead`). A fresh booking resets the attention
  state: the no-show, the cancel, the possible cancel and the open question all belong to the call before this one.
- **Agreement signed** (`agreement-signed.json` g1, now a `tags` step) removes `stat-agreement-unsigned` as it adds
  `stat-agreement-signed`, so a signed client never sits in the chase's filter.
- Nothing else changes: `stat-showed`, `stat-closed-won`, `stat-customer`, `stat-follow-up`, `stat-lost`, `stat-new`,
  `stat-agreement-sent`, `meta booked call` and the `pay-*` tags are milestones nothing removes; Call cancelled still
  takes the booked tags off; a corrected filing still puts the new outcome tag beside the old one.
- The pure test (`tags across every template`) pins the two lists: what is added and never removed is now exactly the
  milestones; the four reset tags are removed by `call-booked:s5` and `call-booked:b6` (and `stat-needs-attention` also
  by the pre-call's own `n_att_off`); `stat-agreement-unsigned` by `agreement-signed:g1`. The removal is a CRM write
  whether or not the tag is there (as every `tags` step is), so a first booking removes four tags nobody set.

On the booking receipts (F21): "If they book at midnight for 9am, they might never get the response. Immediate 'you're
booked' text and email should go out imo." The pre-call sequence's `e1` (booking email) and `s1` (booking text) are
`kind: "transactional"`; no other node of the sequence changed. The mechanism is D5d's as written: the runner
(`runner.ts` send window) lets a transactional send through dark hours only when the company's
`quiet_allow_transactional` is on; a human-sounding send always waits. So the flag is what decides, per company: on, the
receipts go the minute the booking lands, the 4-hour reply wait runs from then (its cap stays call − 1h, D58), ⏳ and
`stat-unconfirmed` land at +4h even in the dark (a Slack post and a CRM write, not a send), the stale reminders are
skipped at 08:00 and the 1-hour and 10-minute texts go; off, the receipts wait for 08:00 as before. **Hair's company row
needs `quiet_allow_transactional = true`** for the owner's wording to hold there — the install input is
`quietHours: { allowTransactional: true }` (`installCompany`, an upgrade install sets only what is given); the
`install:company` script has no flag for it yet, so it is the install API's payload or the company row. The journey test
`booked at 23:00 for a 9am call (F21, fixed D62)` walks the night: receipts at 23:00, deadline 03:00, ⏳, the first
human-sounding reminder parked on the window, 1-hour text at 08:00, 10-minute text at 08:50, exit `done`.

Noted for later, not built (01-open.md #35): Deal closed fires on the first dollar plus a signature, and the owner
confirmed it should — "Correct, not paid in full. However NOT if it's a deposit, which we don't have set up right now,
but that's something we need to remember."
## D61. The cards follow the call, and a hand on a card is seen (2026-10-10)

Tyler: "Closer card should update based on what happened in the call. And when the closer manually moves them into
cancelled or no-show or follow up or whatever, that also needs to be reflected in our tracking." The journey sweep
had the two halves as F2 (a show confirmed on the EOD form with no recording left the setter card at Set / Direct)
and F6 (the closer card never left Scheduled on a show, a no-show, a loss, a DQ or a follow-up).

- **Call outcome filed moves the cards** (`call-outcome.json`). Tyler: "Setter pipeline is won when they show and lost
  when they don't show." No-show: the setter card → `crm.stage_setter_cancelled` ("No-Show / Cancel / Reschedule"),
  status **lost**; the closer card → `crm.stage_closer_cancelled` ("No Show / Cancelled"), move-only, still open. A
  rebooked no-show therefore reuses the open closer card (D41 `pickCard` is open-only) and gets a **fresh setter card**
  on the next booking (Call booked makes one when none is open): that is how the owner counts setter wins and losses,
  per booking cycle. Showed: the setter card →
  `crm.stage_setter_showed`, won, the move Sales call recorded makes (already won by the recording, the step skips);
  then by the filed outcome: follow-up → `crm.stage_closer_follow_up`, lost → `crm.stage_closer_lost` (status lost),
  unqualified → `crm.stage_closer_disqualified` (status lost); closed or deposit leave the closer card to Payment
  recorded (Agreement Sent) and Deal closed (Closed - Won). The three new `crm.*` keys are required bindings of the
  template through its manifest, so readiness asks for them. Every card step here is `if_missing: skip` — the one
  deliberate exception to D41's "gone from every template": an outcome moves a card that exists and never makes one
  (a contact booked before the engine may have none; booking makes cards).
- **A card already where a step would put it is a no-op** (`executor.ts`, `pipeline_card`: `already there`): no CRM
  write, no replica bump. A second filing, the CRM's no-show after the form, or a hand that moved it first costs
  nothing.
- **A hand on a card is seen.** Opportunities were read live per run (D41) but a closer dragging a card between runs
  was invisible. The poll has a `cards` entity (`poll.ts` `pollCards`): each tick reads the two bound boards whole
  (`CrmRead.pipelineCards`, `GET /opportunities/search?pipeline_id=…`, 100 a page, ten pages at most — the CRM's
  search has no updated-since filter) and folds every card of a known contact into `pipeline_cards` (`cards.ts`
  `foldCard`). A known card whose stage or status differs from the replica, with a CRM stamp newer than our last write
  to it, was moved by a hand or a CRM workflow (`card-moves.ts` `handMoved`): `card.moved` on the contact {pipeline,
  pipeline_id, from_stage, to_stage, from_name, to_name, from_status, to_status, by: crm, mover, crm_card}, the
  replica follows, and the booking post's thread gets "🗂️ <who> moved the closer card to Follow Up" — the mover when
  the CRM payload says who (`lastStageChangeBy` / `updatedBy`, which it usually does not), else "someone". Stage names
  come from the binding keys (`crm.stage_closer_follow_up` → Follow Up), never from a CRM call. The same detection
  runs inside every run's read of a contact's cards (`syncCards`), so whichever looks first records it, once. The
  first pass is a silent baseline, like every other entity: the replica takes the CRM's state and nothing is said.
- **A hand move that names an outcome files it.** Closer card into No Show / Cancelled → no-show; into Lost → showed +
  lost; into Disqualified → showed + unqualified; setter card into No-Show / Cancel / Reschedule → no-show — through
  `recordDisposition`, the EOD form's path, so Call outcome filed runs (tags, ✅/👻 line, Sales Call record) and its
  own card steps read `already there` or find no open card (only a status the stage implies, lost, is written). The
  handler itself never writes a status: the replica keeps the status the CRM returned, and a status the closer set by
  hand (won, lost, abandoned) is never changed, because the card step only ever picks an open card. Only for a closing call whose time has passed: a future call dragged to No Show /
  Cancelled is a cancel, and the calendar poll carries cancels. Follow Up and Financing Pending are the closer's own
  stages: noted, nothing filed. Other setter-board moves: noted, nothing filed.
- **Seen on the contact page**: the moves are listed under History (`data.ts`, `history.cards`); the event is in
  `event_types` (`card.moved`, crm) and `EVENT_LABELS`.
- Not built, proposed: an optional `crm.stage_setter_confirmed` ("Appointment Confirmed", Hair id
  `0d9c50e8-0966-4224-b790-d67b888aae83`) moved on a confirmation. Pre-call sequence owns the confirm path and was
  being edited on another branch; the confirmation produces no event of its own today, so the step would need either
  a `pipeline_card` on pre-call's confirmed path or a new `appointment.confirmed` event from `update_appointment`.
  Open for the owner.
- Tests: F2 and F6 are plain `it` in `journey.test.ts` (titled `fixed, D61`), with the hand-move journey (Pat's
  card dragged to Lost: event, replica, thread line, outcome filed, Call outcome filed's tags and the status write);
  `templates.scenarios.test.ts › D61` drives the no-show, follow-up and DQ filings and the `already there` no-op.

## D63. Two records, one person: the team is told (2026-10-10)

Tyler, on the two spellings of one number: "the 2 phone numbers should register as the same person ideally and we should
be alerted if there are 2 contacts with phone numbers in different formats." The first half is D60: `normPhone` folds
`1-602-555-0901` and `+16025550901` into one identifier, and a second CRM record carrying it attaches to the one engine
person as a second `ghl_contact` identifier, so runs, replies, payments and bookings already treat them as one. What was
missing is the second half: the CRM still holds two records, a closer working in GHL sees two people, and nobody was told.

- **A Health check, `duplicates`** (`health.ts` `findDuplicates`, in the hourly sweep like every other check, off with
  `checks: {"duplicates": false}`). Two shapes. One engine person with more than one current `ghl_contact` identifier —
  the case D60 makes. And two engine persons whose current phones or emails differ only in spelling (digits-only, a
  leading 1 dropped from eleven; email lower-cased and de-spaced): that should not exist for US numbers after D60 and
  the check proves it, and it does exist for a non-US number written with and without its `+`, which `normPhone` leaves
  as typed. Each finding reads `Two CRM records for one person: <name> — <ghl id 1>, <ghl id 2> (same phone +1602…)`,
  links to the CRM contact ("Open in the CRM": where the merge happens) and its alert's Open goes to the contact page.
  State `warn` while any, `ok` with the contact count when none.
- **One alert per pair**, `duplicate:<contact_id>` (`duplicate:<a>:<b>` for two persons), warning, source `health`,
  through the sweep's own `reconcile`: posted once in the sweep's channel with the CRM link, repeated in its thread
  hourly while open, "Resolved" in the thread with a ✅ when gone. A `Finding` may now name its alert `key` and the
  engine `page` its Open goes to; everything else keeps `health:<check>:<item>` and the health page.
- **No automatic merge.** GHL is the source of truth; a person merges the records there, and the check's `about` says
  so. The sweep does one CRM read per suspect id (`getContact`, read-only, as the whole sweep is): a record that
  answers 404 is the one the merge dropped, so its `ghl_contact` identifier is retired on the replica (`retired_at`,
  G15's mark) and `contacts.ghl_contact_id` moves to the survivor when the dropped one was primary, so sends keep
  going; for two persons, the one whose record is gone is stamped `gone_at` (G21's mark), which the premise
  `contact_exists` already honours. A CRM that cannot be read (anything but a 404) changes nothing: that is the token
  check's finding. Either way the pair is gone on that sweep, the finding clears and the alert resolves itself; before
  this nothing retired a folded id, so the alert would have outlived the merge.
- Tests: `health.duplicates.test.ts` (company `dupes`) drives two spellings of one number through the real poll, sweeps,
  announces, deletes the second record from the fake CRM, sweeps again; the same for an email in two cases where the
  merge kept the second record (the primary moves), and for the two-person non-US shape.

## D64. The ledger answers questions: setter metrics and a read-only query door (2026-10-10)

Tyler: "If I want to ask right now 'what is Luis's speed to lead, and how many calls has he actually connected
with' theoretically you should be able to answer that. You should be able to find the calls that he's made, find
when the contacts were created and then find the time it took him to call." And: he is "the data king, I want
all the data."

- **The ledger already holds it** (D28, D29): every dialer call is a `recordings` row with the caller's GHL user
  id, the direction, the CRM's status and the seconds; every contact carries the CRM's own arrival time
  (`ghl_added_at`) and owner (`assigned_ghl_user_id`); every booking carries `set_by` when the source names the
  setter. What was missing was the question asked of it. The rollups keep sums (D29: "rates are computed where
  they are read"), and a median cannot be summed, so the answer is computed from the ledger directly.
- **`setterMetrics(c, companyId, { from, to })`** (`metrics.ts`), per setter plus a company-wide line, over
  inclusive local dates: leads assigned, never dialled, dials, answered, connected (at least `reached_seconds`,
  the per-company number D29 set), talk seconds, people reached, speed to lead as median and average minutes
  from arrival to the lead's FIRST outbound dial credited to whoever made it (a lead with no dial is counted as
  never dialled, not as zero), and bookings that followed (`set_by` names them, or the person booked within a
  day after one of their dials). Calls with no caller stamped are an `unassigned` row, never dropped. Read-only;
  `GET /api/v1/companies/<slug>/metrics?from=&to=`; the wrap-ups page shows it with a date range defaulting to
  this week. The Slack wrap-up is unchanged: the template has no setter section (`sections: {}`), so there was
  nothing to add a line to; when it gets one, the headline goes there.
- **A door for the next question**, `POST /api/admin/query { company, sql, limit? }`, Bearer `$CRON_SECRET`.
  One SELECT or WITH, no semicolons, inside `withScope` for that company, in a read-only transaction
  (`set local transaction_read_only`) with a 5 s statement timeout, the statement wrapped as a subquery with the
  row cap bound as a parameter (200 default, 2000 max; the extended protocol cannot carry a second statement).
  The statement runs as `query_door` (`set local role`): a NOLOGIN, NOBYPASSRLS role with SELECT on our tables and
  nothing on `bindings` or `slack_connections`, created on first use. The tenant policy (02-data-model §12) only
  binds a role that is under it, and the login user often is not: locally it is a superuser, and a bypass there
  would have made "the company's rows only" a sentence rather than a fact — the first run of the test proved it.
  A short deny-list by name in front of that: the two ciphertext tables (a decrypt never happens here, the key is
  not in scope), `set_config` (could flip the scope mid-statement), file and connection functions. `report_token`, `bot_token`, `token_jti` are dropped from any
  result: a value that opens a door is not data. `audit_log` is readable, and every run is written to it
  (`query.ran` with the SQL and row count; `query.failed` with the error) — §12's "cross-tenant access is a
  record, not a habit", applied to the operator's own reads. Tables without `company_id` (`companies`, the
  catalogue) are global and seen whole; nothing in them is a secret.
- Tests: `metrics.test.ts` (company `metrics`: two setters, four leads, dials at known offsets, an inbound and a
  simulated call that must not count, a booking by dial and one by name) and `query.test.ts` (the guard, then the
  door: scope, read-only, timeout, cap, hidden columns, the audit rows).


## D65. The same person under a new CRM id is not a new lead (2026-10-10)

Tyler's first test-mode contact shared his email with an older record the CRM no longer had. Every poll delivered the
new record, the engine matched it to the person by email, kept the dead record as the id to write to, and counted the
arrival as a new lead: nine New lead runs in half an hour, each failing on "Contact not found". Tyler: "I can't have it
trying so many times just to fix one thing." Now an identity match is never a new lead (`lead.created` fires only for
a person the engine has never seen by any id), and the record the CRM is delivering now becomes the person's primary
id, since it is the one that exists; the older id stays as an identifier so the duplicates check (D63) can still name
the pair. A write that the CRM refuses fails its run once and alerts; nothing restarts it.

### D65 addendum. A record the CRM made is a new lead (2026-10-10)

Tyler, on the first cut of D65: "Fire on lead created. That's the new truth for that email and phone. Sometimes contacts
get deleted, especially in testing. GHL could change things like the contact id, or the email gets updated. We always
need to use GHL, not just what we have stored. No half measures like 'only when the engine hasn't seen the id before'."
So: a CRM record the engine has not seen by its id is a new lead, always, even when its email or phone belongs to a
person the engine already knows. The record joins that person's history and becomes the primary id writes go to; the
older id stays as an identifier for the duplicates check (D63). What never happens again is the loop: the same id
delivered again is the same lead, and starts nothing. "GHL is the source of truth; the engine is workflows plus
statistics, not storage for everything" — the live contact read before a run acts (D68) follows from the same words.
## D67. Every step, every error, written down before it bites (2026-10-10)

Tyler: "We need to figure out how to test what would happen if there were all sorts of errors on each step. For
example, if it came in with a phone number, without a phone number, with an email without an email; ok cool then what
happens if it can't find the setter card, what happens if it finds the setter card but it's in another column already;
what happened when it hit a 400 and just kept trying over and over; what happens if it's a 401, or a 503, how many
times do we retry and what do we do to try to fix it automatically? That's the type of bug I want you to go through
each step and try to find. A very bad bug is that it runs 20 times. A worse bug is that it creates 20 opportunity
cards, a REALLY BAD WORSE bug is if it messages someone 20 times, even worse would be if they charged them 20 times."

- **The catalogue** is `engine/07-step-failures.md`: one table per node type that touches the outside world or the
  person's data (sends, Slack, tags, cards, records, tasks, notes, contact and appointment writes, classify, analyze,
  the waits, check/branch, record, the sweeps, webhook), plus the inputs that shape every run (a contact with or
  without a phone, an email, a name, a CRM id, deleted mid-run; a booking cancelled or moved mid-run; the company's
  mode). Every row says what should happen under the policy below, what the code does today with the line, and
  which test pins it. Its top is **Could duplicate**: the eight places where today's code, or a retry written
  without a ledger, could make one of the four bad things — a second agreement sent (`send_document` has no sends
  row), a second card (create then replica, inside the CRM's index lag), a second task, a second note, a second
  custom-object record (the CRM id is learned after the create), a second `appointment.status_changed`, the
  always-a-run-per-event door that D65 closed for the poll, and the charge that nothing can make.
- **The policy the engine is being built to** (the retry work lands separately): every step error is classified.
  Transient (network, timeout, 408/425/429/5xx) → the same step is retried in place at 1 min, 5 min, 15 min, 1 h,
  the run waiting on that node between, then paused. Auth (401/403) → paused at once, one alert per vendor, woken
  when the token is replaced. Permanent (400/404/422, a "not found" / "invalid" body) → paused at once with the
  vendor's words. Unknown → one transient try, then permanent. A paused run shows the step and the error, with
  "Retry this step" and "Skip this step" for a person. Nothing ever re-runs a workflow from the top because a step
  failed. No side effect happens twice on a retry: sends keyed per run + node, cards read live first, records keyed
  by external id, notes and tasks through an effects ledger, tags idempotent. The engine never charges anyone.
- **The tests** are `platform/src/engine/step-failures.test.ts` (company `stepf`): fake vendors with a switch per
  method (`fail("addTag", { status: 503, times: 2 })`, `fail("createOpportunity", { after: true })` for a crash
  after the vendor did the thing) and a count of calls per method, so a test says "asked once", "one card", "one
  message". Written to the policy, not to today: 31 pass today (the invariants that already hold — one run however
  many ticks, one card and one message after a crash, zero charges, a card in another column adopted not re-created,
  no phone / no email skipped cleanly, a deleted contact ending the run once, a hand retry resuming at the step), 31
  are `it.fails` with today's behaviour in the title (every retry, every pause, one alert per vendor), one is
  `it.todo` (a 400 on a send: the policy says pause, D56 says carry on — decide).
- **Found on the way**, not duplicates but wrong: the send ledger row written before the CRM call (good) also blocks
  a retry after a refused send (the row is `failed`, the retry is "already sent"); a contact with no CRM id reaches
  the sender as `undefined`, the CRM says not found, and the person is stamped gone; the Jev adapter answers every
  HTTP failure as "unclear, confidence 0", so a dead key reads as a stream of vague replies routed to humans with no
  alert. Each has an `it.fails` test.

## D66. A failed step is retried in place, never the run, and never a side effect twice (2026-10-10)

Tyler, on what a retry must never do: "A very bad bug is that it runs 20 times. A worse bug is that it creates 20
opportunity cards, a REALLY BAD WORSE bug is if it messages someone 20 times, even worse would be if they charged
them 20 times. So we need to figure out how to redo ONLY the step that failed, and when to actually re-test that
step, and when to just alert. What happens if it's a 401, or a 503, how many times do we retry and what do we do to
try to fix it automatically? How often do we retry these things?" And the bar: "This should be 10000x better than
GHL." Until now a step outcome `failed` meant `finish("failed")`: the run was dead, nothing retried it, and fixing
the vendor resumed nothing (05-edge-cases "A failed run is terminal"). D56 had carved out the premise check (an
unreachable booking source keeps the run waiting) and the refusals of a send and a Slack post (recorded, the run
goes on); every other vendor blink killed the run.

- **One policy, in the runner, not per node.** Every step error, thrown or returned, goes through
  `failures.ts › classifyError` once. *transient* (a network error, a timeout, HTTP 408/425/429/5xx from any vendor,
  a Postgres connection error) → the same node is re-run at 1, 5, 15 and 60 minutes (`RETRY_SCHEDULE`, five tries over
  81 minutes), the run `waiting` on that node with `next_run_at`, its wake flags kept, nothing else moving, each try a
  new `run_steps` row with `result.attempt`; after the last try the run pauses. *auth* (401/403) → no retry, paused at
  once. *permanent* (400/404/422, a "not found" / "invalid" body, an unbound binding, a term the company lacks) → paused
  at once with the vendor's words. *unknown* → one retry as if transient, then permanent. A failure the step returned
  itself (its verdict on config or data, `{ status: "failed" }`) is permanent at once: a retry fixes nothing there.
  `runs.step_attempt` / `runs.step_error` carry the count and the last error; the counter is for that step only and
  resets when it passes. The GHL client throws a typed `VendorError` (`GhlError` extends it, the message shape
  `GHL <status> on <path>: <body>` unchanged); everything else is parsed from the adapters' message shapes, an SDK
  error's `status` property (Anthropic) included. Jev's classifier keeps returning `unclear` on a refusal (D47: an
  unclear read goes to a human by design), so it never enters the policy.
- **Paused is a status, and a person's.** `runs.status = 'paused'` (in the schema check since the start, used by
  `pause_runs` and a stale escalation), `exit_reason` = `<class>[:<vendor>]: <error>` so the wake can find runs by
  vendor, the step row `failed`, one alert `run:<id>:paused` (source `step`, headline "Run needs a hand", the step,
  the contact, the error, the Open link). The run page's two buttons, `POST /api/v1/runs/<id>/retry` (attempt counter
  reset, due now) and `/skip` (a `run_steps` row `skipped` with `{ kind: "skipped_by", by }`, `current_node` moved
  along the step's plain edge; a branch or a gate has none and answers 409), both close the alert and write
  `audit_log` (`run.retried`, `run.step_skipped`). Both also take an engine-bug `failed` run, so nothing is stuck for
  good. The company and workflow pages' "failed" tile is "needs a hand" and counts paused runs (and engine failures).
  `failed` itself is now only the engine's own fault: a graph with no way on, a node the pinned version lacks, an
  exception inside the runner.
- **A dead token is one message, and a new token is the fix.** Auth pauses raise one `auth:<vendor>` alert per company
  ("Token rejected"), touched by every further run that hits it, never doubled. `setBinding` and install's `bind`
  compare the new value with the stored one; a *different* token for that vendor (`vendorOfBinding`: `secret.ghl_pit`,
  `secret.calendly_token`, `secret.jev_key`, `secret.anthropic_key`, `secret.whop_api_key`, `secret.fathom_api_key`,
  `secret.resend_key`) wakes every run paused on `auth:<vendor>:%` for one more try of its step and resolves the alert;
  a token that is still wrong re-raises it at the first step that fails. The same value saved again wakes nothing.
  Slack is not on the list on purpose: a refused post never pauses a run (D56).
- **Never a side effect twice: the audit, node by node.** Sends keep the `sends` key written before the vendor call;
  on retry a row that is queued, sent, suppressed or shadow means do not send again, and only a row the vendor refused
  (`failed`) is reclaimed and sent once (`recordSend`'s upsert). A send the CRM answered with a 5xx or a 401 now goes
  to the policy (retried in place / paused) instead of being skipped for good; a refusal the CRM means (no number, a
  400) keeps the D56 path. Slack posts: the same key, refusals recorded, the run goes on (D56). Tags, `update_contact`,
  `update_appointment`, `record`, `set_var`: idempotent as they are. `classify` / `analyze`: reads, retried freely.
  `note`, `create_task`, `notify_owner`'s task, `send_document`, a `pipeline_card` create and a `crm_record` create
  write a `step_effects` row `{ run_id, node_id, kind, external_id, done_at }` BEFORE the vendor call and mark it done
  after: a retry that finds a done claim reuses the vendor's id (a record becomes an update; a card the CRM read
  missed is reused, never made twice; `pipeline_cards.created_by_run` names the run); one that finds a pending claim
  (the vendor never answered: a timeout, a dropped socket) does not ask twice and says so as a blocked step (the alert
  sweep's "step could not run", so a person checks the CRM), except a card step, where the CRM read first (D41) is the
  truth and decides. A vendor that answered with an error wrote nothing, so the runner releases the pending claim and
  the next try starts clean. Payments: the engine records what Whop did (`applyPayment` from webhooks and polls) and
  calls nothing that charges; there is no step that can take money, so "charged 20 times" is not a failure mode the
  engine has.
- **No duplicate runs from retries or re-deliveries**, checked once more at every door: a webhook delivered twice
  (`webhook_deliveries`, kept), a poll re-delivering an appointment (`applyAppointment`'s no-delta path emits
  nothing), the same recording twice (`recordings` unique on the external id: `duplicate`, no event), `startRun`
  twice for one event (`runs (workflow_id, reentry_key)`). D65's re-delivered contact stays fixed.
- Tests: `retry.test.ts` (the classes; a 503 on a tag retried on the schedule and passing on the third try with one tag
  write; the pause after the last try, Retry, the alert closing; a 401 paused at once, `auth:ghl`, a new token waking
  two runs, the same token waking nothing; a 400 on a card create paused with no card, Retry making exactly one, Skip
  moving on; a dropped socket after the CRM wrote a note, the retry writing no second note; a text the CRM could not
  take sent once, and the key refusing a second; an engine bug still `failed`; the three re-delivery doors).
  `alerts.test.ts`'s first case is now the auth story (one post, a second run quiet, the hourly thread line, a new
  token closing it with a ✅). `engine.integration.test.ts`'s call-booked, which has no pipeline bindings on that
  fixture, pauses instead of failing. Known limit, stated: the ledger rows live in the same transaction as the step,
  so a process killed between the vendor's answer and the commit loses the claim as it always lost the send row;
  the window is milliseconds and the CRM read (cards) or the key (sends) still covers the common cases.

### D66 addendum. The failure matrix (D67) closed against the policy (2026-10-10)

The 31 `it.fails` tests D67 wrote to this policy are plain `it` now; two were adjusted to the policy's own shape
(the fake classifier throws when its plan carries a status, as the adapter now does; the deleted-record test counts
its calls from the second run). What the matrix added beyond the first cut:

- **F1** a `failed` send row is reclaimed by the retry (`recordSend`'s upsert), and a Slack `ratelimited` / 5xx is
  transient: the post is retried in place from the reclaimed row; `invalid_auth` and `channel_not_found` stay D56.
- **F2** a contact with no CRM id reaching a send pauses as "contact has no CRM id yet (nothing to send to)"; the
  CRM is never asked about contact `undefined`, nobody is stamped gone.
- **F3** Jev's classifier throws a `VendorError` on 401/403 and 429/5xx (paused / retried); other refusals and an
  unsure answer stay `unclear`, a human's; an empty input is a noop and Jev is not asked.
- **F4** the card read at claim time no longer swallows an outage: its error is carried to the first card step of the
  tick, which fails on it (retried in place) instead of asking again; a run resuming on a card step reads once, in the
  step.
- **C6** `update_appointment` emits `appointment.status_changed` once per (run, step, appointment, status): a crash
  before the emit still emits on the retry, a crash after it emits nothing more.
- **A 404 on a write to the contact** (tags, note, task, contact update, send) whose body names the contact is the
  person gone from the CRM: `gone_at`, one alert, the run exits moot at its next look (G21's path); a 404 on a card or
  a record is that card or record and pauses the run with the CRM's words.
- **A hand wins**: a retried card step re-reads live and, finding a `card.moved` by the CRM since its first try,
  skips with "moved by hand since".
- **One alert per vendor for blocked steps too**: a Slack token refusal across any number of posts is one
  `auth:slack` alert, not one `blocked:` alert per step.
- `run_steps.status` admits `paused`: a step that itself asked for a person (a stale message escalated) is written
  so, not `ok`.
- Decided as the matrix left open: a 400 on a send, and a `channel_not_found` on a post, stay D56 (recorded, skipped
  as blocked, alerted, the run carries on: a bad number must not hold the reminders).

## D68. The live contact is read before a run acts; the engine's copy is a cache (2026-10-10)

Tyler: "We always want to use the GHL contact NOT the engine contact. We can use the engine's storage as a quick way,
but we need to actually poll GHL for the current contact. Things like variables of the person's name and all sorts need
to come from GHL, not the engine. The engine is just that, NOT storage for everything. The engine should be basically
workflows only, plus statistics. GHL is the source of truth." And: "Sometimes contacts get deleted, especially in
testing. GHL could change the contact id, or the email gets updated."

- **Before a run acts, the contact is read live** (`src/engine/contact-truth.ts`, called once per claimed run with a
  contact, right before the context is built, after the cards sync). The snapshot is folded into the replica by the
  same path the poll uses (`upsertContact`, bound custom fields only), so the name, email, phone, custom fields, time
  zone, owner and primary CRM id a step renders are the CRM's as of now; a changed number or email retires the old
  identifier (G15). The context carries `contact.fetched_at`. Shadow runs read too: a read is free.
- **A 404 is the mark.** The CRM has no such record: `gone_at` is stamped, one alert per contact is raised
  (`contact:gone:<id>`, as G21's send path does) and the run exits `moot: contact gone` now, before any send, rather
  than at the refusal of its next send. If the person carries another current CRM id (a duplicate the poll folded,
  D60/D63), that id is tried first; when it answers, it becomes the primary writes go to (D65) and the dead id is
  retired, as the duplicates sweep does. Only when every id answers 404 is the person gone.
- **A CRM that does not answer is what a cache is for.** On a thrown read (network, 5xx, 401) the run acts on the
  replica and the context says why in `contact.stale`; the run page's contact line reads "acted on the engine's copy;
  GHL did not answer". The run is never failed or held for it: the premise already decides when a run waits (D56).
- **A refresh never emits an event.** `lead.created` and the tag deltas are the poll's; a refresh must never start a
  workflow. For that reason the replica's `tags` are the one field a refresh leaves as the poll last saw them: the
  poll's `tag.added` / `tag.removed` are a diff against the replica, and a refresh that wrote the CRM's tags first
  would swallow it. `contact.tags` is therefore at most one poll old; everything else in `contact.*` is live.
- **The price.** One GET per claimed run per wake. A wake is already a round of reads (the premise reads the booking
  live, D5b; the cards are read live, D41), and a claimed run is about to write to the CRM or send to the person; a
  read that keeps a text from greeting the wrong name or going to a dead record is the cheapest step of the wake. A
  run with no contact (a closer's end-of-day) reads nothing.
- **The same record, an older stamp, is skipped.** As D41 does for cards: a snapshot whose `dateUpdated` is older
  than the one the poll already folded for the same id is the past, not the truth, and is not folded (the read still
  counts as fresh). A primary that moved to another record is folded regardless.
- Test fixtures: `fakeAdapters().read.getContact` now echoes the replica (a fake that answered null would mark every
  test contact gone on its first run); a fixture with a CRM of its own passes `fakeAdapters({ crm })`, and an id that
  CRM lacks is a 404. G21's test now sees the deletion at the run's next look, before the send, as D68 says.


## D69. Ask the CRM before saying anything (2026-10-10)

Tyler: "I just got an alert that there are 2 of the same contact, that's not true. I deleted the one contact in GHL
first. So that is alerting me based on what we have stored in the engine NOT what we have in GHL." The duplicates
check did ask the CRM, but read a 400 "Contact not found" as "could not read" and alerted anyway. Now the CRM's
"not found" is gone whatever the status (the read adapter and the check agree), and a record the CRM cannot confirm
either way is "unknown": an unconfirmed pair is never alerted, it is looked at again next sweep. The rule for every
check that names a person: the CRM is asked first; the engine's copy is never the grounds for an alert.

### D69 addendum. A vendor check names its status (2026-10-10)

The Fathom key check called any non-2xx a rejected key; Tyler got "Fathom API key rejected" with nothing to go on.
Now only a 401/403 is "rejected" (an error, with Fathom's own words); any other status or a network failure is a
warning that names the status and says the key may be fine. Same rule as D69: the alert states what the vendor said,
never a guess.
## D70. The ledger answers in Slack (2026-10-10)

Tyler: "I want to build out the bot to be able to answer questions simply through Slack. Ideally they'd be able to ask
any question possible. But I also want shortcuts: /monthly or /mtd would be the monthly report or the month-to-date
stats, /show-rate, /close-rate." "No answer beats a wrong answer. If it doesn't know what the person is asking or
doesn't know the answer it should ask for clarification, or the date range or whatever, then give the answer, and if it
can't figure it out or can't get the info it should say so and ping me." And, while it was being built: "Numbers come
only from the ledger and the API and such. We can pull data from the API when possible. But it's only real data, no
made-up data."

- **One definition per number** (`metric-registry.ts`). Every metric the bot can say is a named entry with a SQL builder
  over the ledger and the sentence that defines it, which is printed under every answer with the period and the
  company's zone. The definitions are the ones the wrap-ups (D29) and setter metrics (D64) already use, not new ones:
  a lead is a contact by the CRM's arrival time; calls booked by when the booking was made; a show is the closer's
  filed outcome or the booking source's status; a close is a won opportunity credited to the closer of the person's
  latest call; cash is payments net of refund lines (D57); speed to lead, dials and connected calls are D64's own
  numbers. Two choices made here: **show rate is shows ÷ calls due** (start time passed, not cancelled or rescheduled),
  so a call nobody filed counts as not showed — D54's end-of-day presumption, applied to the rate, and the reason the
  wrap-up's "shows ÷ scheduled" and the bot's show rate can differ; **close rate is closes ÷ shows** in the same period.
  Tyler's words become metrics: MQL = tag `mql`; marketing DQ = tag `dq` or any `dq-*`; the financial DQL is `dq-budget`
  alone (both exposed); a sales DQ is a call the closer filed as disqualified. A person's source is the CRM's lead-source
  field, else the UTM source of their latest booking. Rates are always two counts divided where they are read; a rate
  with no denominator is "—", never 0%.
- **Shortcuts are commands, not prompts.** `/mtd`, `/weekly`, `/monthly`, `/show-rate`, `/close-rate`, `/cash`,
  `/availability`, `/leads` and `/help` are registered slash commands answered from the registry with no model in the
  way, so they are the same every time and work without an AI key. Each takes a period in words (`/close-rate last
  month`); words that are not a period are refused with examples. A slash command leaves no message to thread under, so
  it posts its own (`📊 Month to date — asked by @who`) and the conversation continues in that post's thread; from a DM
  it answers in the DM. `/help` is not a Slack built-in, so it is registered under its own name; `/ops-help` is accepted
  too in case another app in the workspace owns `/help`.
- **Free questions go to a model whose only powers are tools**: `get_metric` (the registry), `get_availability` (the
  live calendar read the low-availability check makes), `run_readonly_query` (the D64 door, last resort, answer labelled
  "ad hoc, from the raw ledger" with what the query returns), `ask_clarification`, `cannot_answer`, and `reply`, which
  names the results to show. The model chooses; it does not write the answer. Our formatter renders the chosen results
  (key numbers first, aligned tables, definition and period, and on every key line the source: "from the engine's
  ledger" or "from GHL, read just now"); the model may add one sentence, which is dropped if it holds a number not
  already in the message. A live read that fails is named in the answer ("I couldn't get a live read (GHL …)"), never
  filled: a calendar read that fails everywhere is an error, not zero slots.
- **Ask, then answer; otherwise say so and ping.** No period, a person who is not on the roster or matches two people,
  or a term with two meanings ("DQ") → one question in the thread, and the reply continues the conversation without a
  new mention (`bot_threads` keeps the thread's turns). "My" is the asker: Slack id → roster, else Slack's email for
  them → roster email (remembered), else the bot asks who they are. A question the tools cannot answer, a model that
  declines, a failure → "I'm not sure how to get that information. Let me ping Tyler real quick." then "Hey @Tyler, can
  you help?" in the same thread, the reason in `audit_log` (`bot.escalated`); after that the bot leaves the thread to
  people unless mentioned again. The person pinged is the company's `bot.escalate_to`, set at install from an email.
- **Where answers go.** A mention: 👀 on the question at once, the answer in its thread, the 👀 off when it lands. A DM:
  answered privately in the DM. A reply in a thread the bot is in counts as a question unless it @mentions someone
  else. The bot's own messages, other bots, edits and retried deliveries are ignored; the company is the one whose
  Slack connection matches the event's team. Both doors acknowledge inside Slack's three seconds and work after the
  response.
- Not built: saving a thread's report as a new shortcut; live tools beyond the calendars (a question only the CRM can
  answer right now escalates); full lead attribution (D25). Open item 38.

## D71. A reschedule is the booking card again, under a 🔁 face (2026-10-10)

Was: a reschedule posted no new card; a separate step reacted 🔁 on the booking post and replied "Rescheduled to <time>" in
its thread (D44). Tyler: drop that step; a rebooked call shows as the booking card with 🔁 as its face instead of the calendar.

- Call booked has one Slack step for both. A set_var (plumbing, not on the chart) picks the face: `appointment.rescheduled`
  → "Call rescheduled" with `:repeat:`, anything else → "New call booked" with the rotating calendar faces (D31).
- The card carries the new time, the intake answers and the reschedule link, same as the first one.
- The card it replaces gets a 🔁 reaction (Tyler, same day), so the old time reads as moved. The same step does it with
  `react_on` on the appointment tag, which still names the old card at that moment; a first booking renders the mark empty
  and reacts nothing. The outcome reactions are unchanged.
- It takes the `appointment:<id>` tag, so ✅ confirmed, ❌ cancelled, 👻 no-show, ✅ showed and 💵 land on the newest card.
  The old card keeps what it had; a tap on it is no longer a fact the engine reads (only the newest post is remembered).
- Engine: a persona icon written as one whole `{{expr}}` takes the value as is, so a var can hand over a list of faces.


## D72. Availability per closer (2026-10-10)

Was: `/availability`, the bot's `get_availability` and the low-availability thread read each active calendar's open
times and grouped them by the calendar's default user, else by the calendar's name. Hair books through two Calendly
round robins ("45 Min Strategy Call", self-booked, and "45 Min Strategy Call - S", setter-booked) that pool the same
hosts (James, Josh). Calendly's available times for a round robin are pooled (a time shows when ANY host is free) and
do not say which host, so the answer was per calendar, not per person, and the same open times were counted once per
calendar (2, 4, 4 on each → 20 when there were 10 distinct times). The table also marked "light" days.

Tyler: per person, in one table, and the alert's day-by-day the same table.

- **Which times.** Only what the booking source offers: Calendly `GET /event_type_available_times` (which already
  applies buffers, minimum notice, increments and daily limits), GHL `GET /calendars/{id}/free-slots`, on the active
  closing calendars. No time the source does not offer is ever counted.
- **Whose (Calendly).** The event type's hosts (`GET /event_type_memberships`, with its `duration` from
  `GET /event_types/{uuid}`; when that endpoint refuses the token, the type is found under each member's own
  `/event_types?user=` listing, as the calendar listing does). One host: every offered time is theirs, nothing more is
  read. Several: each offered start time goes to every host free for the whole call then, by the schedule the event type
  actually uses for that host (`GET /event_type_availability_schedules`: one rule per host when each host has their own,
  one shared rule otherwise; weekday rules, date overrides first, in the schedule's own zone, touching intervals as one
  stretch) and clear of the host's busy times (`GET /user_busy_times`, one read per host for the 7 days, shared by every
  event type; a Calendly booking counts with its buffered start and end). The user's default schedule is never guessed.
- **Whose (GHL).** The calendar's team (`GET /calendars/{id}` → `teamMembers`); one member (or none, with a default
  user): every offered time is theirs; several: free slots read again per member (`userId`), kept only where the
  calendar's own read offers the same time.
- **Counting.** A closer's open times are the union across the calendars: a time both strategy calls offer for James
  counts once for James. The day's total is the sum of the closers (two closers free at 2pm = 2 open). A host is shown by
  the roster's name (email for Calendly, `ghl_user_id` for GHL, case-insensitive), else by the source's own name.
- **Self-check.** No answer beats a wrong answer: every offered time must land on at least one host. If any offered time
  matches no host (or a read the split needs fails), the per-closer columns are dropped, the day totals are the distinct
  offered times, and the answer says "Could not split by closer: N offered times matched no host's schedule" (or which
  read failed). A calendar that cannot be read at all is named and left out, as before; all of them failing is an error.
- **Layout.** One table: the days down the side, a column per closer (`James Open`, the first name when it is unique on
  the roster, else the full name), `Total Open`, and a total row. The headline stays (`*Open slots, next 7 days: 9*  ·
  _from Calendly, read just now_`), the footer is only the period line. "Light" days are gone. The definition stays in
  the data for `/help` and the model.
- **The alert.** The low-availability check keeps its per-calendar threshold (`min_slots`); the thread under each
  availability finding is the same message `/availability` posts (`readAvailability` + `formatAvailability`), reusing
  the pooled reads the check already made. If the per-closer read fails, the thread says so.
- Not covered: a Calendly per-host daily cap or the new event's own buffers against an external meeting are not in
  the API, so a host can be counted at a time Calendly would not give them; the self-check only catches the opposite.
  The new reads are implemented from Calendly's public API reference and exercised through fakes; the first live read
  on Hair verifies them.

## D73. The bot reads people and deals from GHL (2026-10-10)

Was (D70): every bot number came from the ledger. Tyler tested `/mtd` on Hair (booking source Calendly) and found it off
against GHL: 58 leads in the ledger against 59 in GHL (one not yet polled); MQLs counted from a tag `mql` (4) when an MQL
is really the answer to a form question; a close rate of 133% because `closes` counted four won cards, two of them on the
setter pipeline (marked won when a prospect shows, not a sale) and one a test contact; a show rate that left cancelled
calls out. He ruled: **"Always GHL. It's the truth. If the two are different, that's an issue."** And, on the
differences: "the engine is only the mirror of the truth and it needs to stay updated with reality; if there are
inconsistencies it needs updated, and the health check should do that."

- **Read live, at answer time** (`ghl-metrics.ts`, adapter calls in `adapters/ghl/metrics.ts`, injectable as `GhlReads`).
  Contacts: `POST /contacts/search` with a `dateAdded` range, 500 a page, continued with the last record's `searchAfter`.
  Won cards: `GET /opportunities/search?location_id&pipeline_id&status=won`, 100 a page; the won time is
  `lastStatusChangeAt`. Sales Calls: `POST /objects/<key>/records/search`, continued with `searchAfter`. A read that
  hits its page cap refuses to answer rather than return a short count. Results say `from GHL, read just now`. GHL that
  cannot be read is an error naming its status ("GHL could not be read (contacts, 503)"), escalated like a failed
  calendar read; the ledger never stands in.
- **Test contacts count nowhere.** D52's rule, now one function in `mode.ts` (`isTestContact`, and `testContactSql` for
  the ledger's SQL): tagged `sys-test`, or an email on a `test.domains` domain. Every metric leaves them out, GHL-read and
  ledger-read (and the setter numbers when the bot asks). Harness appointments (`source='test'`) stay out as before.
- **Leads** = GHL contacts by `dateAdded`, in the company's day bounds.
- **MQL / marketing DQ** come from the answer to the contact field "What best describes your current work situation?"
  (`crm.field_contact_work_situation`; on Hair `8JjXmfXouYVTX3VLXjzP`, filled by the booking form). The answer lists are
  company config, matched exactly (trimmed, any case), since they are fixed form options: `qualify.mql_answers` (Hair:
  Employed full-time, Business owner or entrepreneur, Investor) and `qualify.dq_answers` (Currently between jobs, Employed
  part-time). Every lead is MQL, DQ, unanswered (blank; 43 of Hair's 59 October leads) or unrecognized (any other text,
  never counted as MQL). Tyler: blanks are not MQLs (`qualify.unanswered_is_mql`, default false). The answer says it:
  `MQLs: 16 matched the employment standard · 43 didn't answer`, plus the unrecognized count when there is one.
- **Exactly two kinds of DQ.** A marketing DQ (also "DQL") was filtered out before a sales call on financial signals:
  the DQ answers above (`marketing_dqs`; the tag-based `dqls` and `dqls_financial` are gone). A sales DQ got on the call
  and was disqualified for any reason: a Sales Call record whose `disposition` is one of `sales_call.dq_dispositions`.
- **Closes** = distinct people with a won card on the Closer pipeline (`crm.pipeline_closer`), by won time, test contacts
  out: "the number of new people we collected cash from". `revenue` is the value of those cards. Credit: the closer of
  the person's latest call in the ledger, else the card's owner. `close_rate` = closes ÷ shows. `/closes` lists them,
  newest first: person, closer, day won.
- **Calls and shows come from GHL's Sales Call records** (`crm.object_sales_call`, outcomes mapped by
  `sales_call.outcomes`; Hair: `showed`, `no_show` → no-show, `cancelled` and `late_cancel` → cancelled; blank or anything
  unmapped is not filed). Tyler: "12 calls were booked, 3 showed": **calls booked** = records whose call time fell in the
  period and has passed, cancellations included, future calls not; `show_rate` = shows ÷ calls booked. The answer breaks
  it down: `Calls booked: 12 · Showed 3 · No-show 3 · Cancelled 2 · Missing from EOD disposition 4 (names…)`. Closer =
  the record's `closer` name on the roster, else the name as written.
- **Cancelled wins, by its timing.** A record is tied to a ledger booking only one-to-one: the same external id, else the
  same GHL contact starting the same minute (Hair's records carry an outside integration's id, not the Calendly event's,
  so the person and minute is what matches; never the name). When the booking source cancelled the booking before the
  call's start (German Arellano: Calendly cancelled Oct 2, call Oct 5, no-show filed later), the call is cancelled
  whatever was filed, and the answer names it ("GHL says no-show, Calendly says cancelled"). Cancelled after the start (a
  host clearing the slot after a no-show), the filed outcome stands. The cancel time is the earliest of the source's own
  update stamp and the poll's status change; unknown, it decides nothing.
- **Footers carry only the period.** Definitions stay in the registry for `/help` (which now lists the main ones) and the
  model; no answer prints them.
- `/mtd`, `/weekly` and `/monthly` show leads, MQLs, calls booked, show rate and close rate from GHL and cash from the
  ledger (payments are the ledger's own record); `/leads` is leads, MQLs and marketing DQs by source.
- **The health sweep keeps the mirror true** (`ledger-drift.ts`, check `ledger_drift`): over the last 7 days, minus the
  30 minutes the poll has not reached, it compares GHL with the ledger and repairs:
  - a contact GHL added that the ledger lacks is pulled in with the poll's own upsert; a record new to the engine fires
    `lead.created` once, there, so the poll sees it as known and never fires it again;
  - a ledger contact of those days that GHL itself says is gone (asked first, D69; an unanswered read is never a "gone")
    is stamped gone;
  - a Sales Call the booking source cancelled before its start is set to cancelled in GHL and in the ledger. The GHL write
    follows the mode (D52: in test only a test contact's record is written; anyone else's is held back and stays an
    alert) and the effects ledger (D66: `step_effects` row `repair:<record>:outcome` against the sweep's run; a refused
    write releases its claim, an unanswered one is not asked twice, and a record set back after a repair is never written
    again but left for a person);
  - otherwise a filed GHL outcome replaces the ledger's.
  Every repair is in `audit_log` (`health.repaired`) and listed in the sweep's result. What it cannot repair (a record
  matching no booking or several, a cancel at an unknown time, a write the mode holds back or GHL refuses, a ledger
  outcome GHL has no outcome for) is one alert naming the people, resolved by the sweep that finds nothing left. If GHL
  cannot be read, whatever alert was open stays as it is.
- Config, all bindings set at install (`InstallInput.qualify`, `.salesCall`, `crm.field_contact_work_situation` and
  `crm.pipeline_closer` through `crm`): see `platform/README.md` › Slack bot.
- Not done: tagging `mql` / `dq-budget` on the contact when the work-situation answer arrives (Tyler will add it with a
  Typeform automation; open item 39).

## D74. The bot reads any GHL field, and picks the field itself (2026-10-10)

Was: a question about a thing no metric covers ("hair loss severity") got "which field holds it?". The bot could not see the
CRM's field names (the ledger keys values by field id) and its rules said an unknown term is asked. Tyler: "I'd rather it
always check what it has available… 'this field matches best, this is probably what they mean'; if two fields could
match, then it could ask."

- `list_fields`: the location's contact custom fields and every custom object's fields (Sales Call outcome, disposition,
  objections, score…), with their answer options, read from GHL when asked.
- `field_breakdown`: one field's answers over a period, read live from GHL (D73): for a contact field the leads GHL added
  in the period; for a custom object its records whose one date field (else creation) falls in it. Multi-picks count each
  pick; option keys read as their labels; blanks are "(no answer)"; test contacts never count. `list: true` also names
  each person and their answer (first 100).
- The model resolves the asker's words to a field by meaning and uses it; the answer's first line names the field, so the
  asker sees how they were read. It asks only on a real tie (two fields that would give different answers) or no match, and
  prefers a field with fixed options over free text. A field key the catalogue does not hold is an error back to the
  model, never a guess.
- `POST /api/admin/bot-preview` (bearer, operator): a shortcut or a question answered exactly as Slack would get it,
  returned instead of posted, so live answers are checked before anyone is told they work.

### D74 addendum. Comparing an answer with showing up; reasoning; the drift alert asks (2026-10-10)

- Tyler asked whether hair-loss severity goes with showing up; the bot found the field, then had no way to join it to the
  calls and gave up. `compare_with_shows`: the Sales Calls of a period (call time passed, GHL), each contact's answer to
  one field (read live per contact), and per answer the calls, shows, no-shows, cancels, unfiled, show rate (D73's) and
  share of all shows. Whether the show rates differ by more than chance is a permutation test over the answered calls
  (χ², 5,000 deterministic shuffles); under 10 answered calls, or one answer only, the verdict says it is too few to tell.
  A pattern is called a pattern only when the test says so.
- The model's note may now be up to four short sentences reasoning through the results ("of the 10 who showed, 7 said…"),
  every number already in the rendered answer, or the note is dropped.
- Matching a Sales Call to a booking failed for Hair: the outside integration writes `scheduled_at` as display text
  ("Mon Oct 5 · 10:00 AM EDT"), not a stamp, so person-and-minute never matched and every October call alerted as
  "matches no booking". The time is now read on the record's `call_date` in the company's zone (trusted only when the
  zone abbreviation is the company zone's that day); with no readable time, the person and the day match instead.
- The drift alert is written for a person: what was fixed is a count ("5 records in the engine didn't match GHL; they've
  been updated from GHL"), then "Except these, which I have questions about:" with one line per item phrased as the
  question it needs answered. Repairs alone are logged, never announced. An open alert is updated in place, not posted
  again; it is posted again only after it resolved and something new appears.

## D75. The bot joins GHL records live (2026-10-10)

Was (D74): the bot could count one field (`field_breakdown`) or one contact field against showing up
(`compare_with_shows`), but a question that crossed records ("close rate by objection", "show rate for setter-booked vs
direct", "cash by source") had no tool, and cash came from the ledger. Tyler wants the bot "smart enough to connect all
the data", and: **"I don't want to duplicate the GHL record in my engine; just pull the necessary data from GHL when
necessary."** GHL is the source of truth.

- **The record graph** (Hair, verified live): the contact (custom fields incl. the booking-form answers, tags, source,
  Total Cash Collected) → at most one setter card (Setter pipeline, `crm.pipeline_setter`) → one Sales Call per booked call
  (`crm.object_sales_call`; `contact_id`, `opportunity_id`, `call_date`, `scheduled_at`, outcome, disposition, closer,
  setter, booking source, objections, score, cash; filed from the EOD form) → at most one closer card (Closer pipeline;
  won = a close, D73) → Payment records (`crm.object_payment`, default `custom_objects.payment`; amount, `occurred_at`,
  type, status, closer, setter: the per-transaction cash truth) and Discovery Calls (`crm.object_discovery_call`, default
  `custom_objects.discovery_call`, setter calls; read when GHL has the object). An object record's contact is its
  `contact_id`, else GHL's association (`GET /associations/relations/{id}`); a person's card is found by contact (two on
  one board: the won one, else the latest).
- **Joined live, in memory, for one answer; nothing stored** (`ghl-graph.ts`). Reads go through `GhlReads` (new:
  `cards` = `GET /opportunities/search?location_id&pipeline_id` every status, `pipelines` = `GET
  /opportunities/pipelines` for stage names, `users` = `GET /users/` for owners, the roster filling in), memoized per
  answer (`memoReads`), five requests at a time, every list paginated to a cap that refuses rather than cuts short. A
  contact is fetched one by one only when no search gives it (the people behind calls and closes). A 90-day question on
  ~50 calls costs ~55 requests (the field catalogue 5, Sales Calls 1, closer board 1, payments 1, one GET per person);
  on leads ~12, with no per-person GET.
- **Units and measures.** `lead` = contacts GHL added in the period: booked (has a Sales Call), booked rate, calls due,
  showed, show rate (shows ÷ booked calls), closed (a won closer card), close rate (closes ÷ shows), cash. `call` = Sales
  Calls whose time fell in the period and has passed, classified by D73's code itself (cancel-wins, missing from EOD,
  harness and test out): showed, no-show, cancelled, missing, show rate, closed, close rate, cash; a person's close and
  cash count once, on their latest showed call. `close` = people with a won Closer-pipeline card in the period: cash,
  card value, median days from first call to won. A lead's or a close's `call.*` is their latest Sales Call.
- **`list_columns(unit)` and `analyze(unit, period, split_by, filter, list, rate)` replace `list_fields`,
  `field_breakdown` and `compare_with_shows`** (each is now a split of one unit; an old field key still resolves).
  Columns are namespaced by the record (`contact.<field name>`, `contact.source`, `contact.tags`, `setter_card.stage`,
  `call.objection_primary`, `call.result`, `closer_card.status`, `payment.total`, `discovery.<prop>`…) with type and
  options. Per answer: the counts, the rates, the share of the main outcome, and D74's permutation test on the rate the
  question is about (lead: booked rate by default; call: show rate; `close_rate` when asked), with the same verdicts.
  Multi-picks count under each pick; blanks are "(no answer)" and named.
- **Gaps and mismatches are said, not hidden.** Link gaps: a call with no contact or no closer card, a lead with no
  setter card, a close with no Sales Call, counted and named (`*Links:* 48 calls · 46 linked to a closer card · missing:
  X (Oct 1), Y`). Mismatches, only once GHL holds Payment records: a won closer card with no payment, a payment with no
  won closer card, a contact whose Total Cash Collected is not the sum of their payments (only when they have payments).
- **Cash is GHL's.** `cash_collected`, `cash_gross`, `refunds` (and `/cash`, `/mtd`) read the Payment records by
  `occurred_at`: a succeeded payment that is not a refund or chargeback is in, a refund or chargeback that did not fail is
  out, anything else (failed, pending, a payment whose own status is refunded) moves nothing; closer and setter from the
  record. When the object holds no records at all the answer says "GHL has no Payment records yet": never $0, never the
  ledger's.
- **The drift alert** (D73, D74) asks, once Payment records exist: a closer card won in the last 7 days with no payment
  ("Did they pay, or should the card not be won?") and a payment in them with no won closer card ("Should their closer
  card be won?"), one line each, test contacts out.
- The model is taught the graph in three lines, sends cross-record questions to `analyze`, picks the column by meaning
  (the header names it; asks only on a real tie or no fit), shows only the results that answer, and reasons in its note
  (up to four sentences, numbers only from the results, a pattern only when the test says so).


## D76. Before the hand test: one record per call slot, answers edit, nothing reaches the team before live (2026-10-10)

Tyler's rulings on the sweep of 2026-10-10 (06-journey-sweep.md §4), relayed the same day and built together.

- **Each call slot is its own Sales Call.** "Each call slot is its own Sales Call. If it gets cancelled or rescheduled, we log
  that, not edit it and create a new one." Reverses the sweep's S1. An appointment carries `slot_key` (the booking's id; on a
  move that kept the id, `id@start`); the Sales Call record is keyed by it (`{{appointment.slot_key}}`). A reschedule
  (Calendly's cancel + new event, or a GHL move) logs the old slot's record as `rescheduled` (Call booked `k5`, the event's
  `slot.from`) and Call booked makes the new slot its own record; a cancel before the call marks the slot's record cancelled
  (Call cancelled `n6`), never deleted or reused. The drift sweep does not ask about a rescheduled slot's record that matches
  no booking.
- **A rescheduled slot is outside the show rate** ("calls booked for show rate = showed + no-show + cancelled/late_cancel +
  missing"): `calls_booked_due`, `show_rate`, the /show-rate breakdown ("· Rescheduled N (outside the rate)") and the
  graph's call rows leave it out.
- **Every Sales Call is linked to its contact and its closer card** (field and association). The drift sweep repairs a
  record missing either when the contact and the one closer card are certain, once (effects ledger, the mode's rules);
  none or several cards, or no GHL id, is a question in the drift alert.
- **A refiled end of day edits, never adds.** "EOD resubmit is allowed and EDITS, never adds." The call's thread line is
  edited in place (`slack_post.edit` + its tag; `chat.update`, `notifier.update`), the same Sales Call record is updated,
  the cards follow the new answer (`pipeline_card.pick: latest`; a closed answer after a no-show / lost puts the closer card
  back on Scheduled), and what the earlier answer did comes off where it differs: its reaction (👻 or ✅) and its tags
  (`appointment.outcome` carries `previous_outcome` / `previous_call_outcome`; `tags.keep`). The closer's answer is the
  whole answer: a no-show after a lost clears the call outcome, and a lost opportunity reopens.
- **A cancel after the call never overwrites what the call was**: "if the call showed or was a no-show, a later cancel
  never overwrites it — the filed/recorded outcome stands". The poll keeps the show / no-show on the row; the rollups count
  it as such; Call cancelled and Cancellation rebook ignore a cancel after the start (S11).
- **No loops.** "A step that hits the same error retries at most 3 times in total, then stops and raises one alert naming
  the step, person and error." `RETRY_SCHEDULE` is `[1, 5]`: three tries in all, then paused with one alert (auth pauses
  at once as before). A card the CRM says is gone is replaced once (S12).
- **Blank Sales Calls are chased.** "The closer is reminded every day until each of their calls with a blank outcome
  (GHL is the truth) is filled; after 2 days blank, also tell the operator." The End-of-day reminder's `eod_due` step lists
  the ledger's unfiled days and the days whose GHL Sales Calls for that closer are due with no outcome; two days on, the
  evening reminder also posts the names to the operator (`bot.escalate_to`).
- **Nothing reaches the team before live.** "Until a company is live, a Slack DM to a team member must NOT reach that
  person." In shadow and test a DM (a `slack_post` to a user id, `notify_owner`'s DM) goes to `slack.channel.ops`, else the
  operator's DM, prefixed "Would have sent to <name>:", unless the run is about a test contact and the operator is the
  recipient; neither bound, it is recorded only. A run with no contact is shadow in test (`effectiveMode`): the End-of-day
  reminder that reached James is that case. Channel posts keep D31. The operator's alerts are not runs and still go.
- **Wrap-ups say only what happened.** "If no actual calls happened today, we don't need to say that… show only what
  actually happened." The wrap-up's numbers come from the bot's metric registry (people, calls, deals and cash from GHL;
  bookings and dials from the ledger; test contacts out), so the two never disagree (Oct 10 said "New leads: 0" while GHL
  had one). A line only for a number that is not zero, a section only with a line, a rate only with its denominator, no
  definitions; nothing at all is one line ("Nothing today: no leads, bookings, calls or payments."); a GHL read that failed
  says so ("couldn't read GHL: …"), never a 0. The same for weekly and monthly.
- **The company's own picklist keys** (D-1, S9), **cancels after the start** (D-3, S11), **gone cards** (D-4, S12), **records
  found by booking** (D-7, S13), **the CRM id wait** (D-5, S14), **wrap-ups without test contacts** (D-8, S15) and
  **Cancellation rebook for closing calls** (D-9) are the sweep's, decided by the owner the same day.

## D78. Lead source: read in one order, captured by the engine (2026-10-10)

The owner: "make sure we continue capturing the lead source." On Hair (October, 60 leads) the contact's UTM fields (UTM
Source, Medium, Campaign, Content, Term, FBCLID) were filled on only 9 people: the ones a Calendly booking created, filled by
a Zap the owner switches off once the engine is live. The engine never wrote them, and read only the lead-source field and
the latest booking's UTM, so the bot's by-source splits showed 49 "unknown". GHL's own first-touch attribution
(`attributionSource`) had a source on nearly everyone: fb 38, ig 17, zapier 4, manual 1. GHL's top-level `source` is mostly
"Optin Form", which says nothing about where the person came from, so it is not read.

- **One order, everywhere a person's source is needed** (`lead-source.ts`: the GHL-read metrics, the joined analysis's
  `contact.source` column, the ledger's metrics, `contact.source` on the booking card and the close post, the bot, wrap-ups):
  1. the company's lead-source field (`crm.field_contact_lead_source`), when bound and filled;
  2. the contact's UTM Source field (`crm.field_contact_utm_source`);
  3. GHL's attribution: the first touch's `utmSource`, then the latest touch's (`lastAttributionSource.utmSource`);
  4. the UTM source of the person's latest booking (`appointments.tracking->>'utm_source'`);
  5. GHL's attribution `medium`, how the record came in (`zapier`, `manual`, `form`): what made "zapier 4, manual 1";
  6. `unknown`.
  Values are kept as GHL has them (`fb`, `ig`), trimmed and lower-cased; no renaming. The ledger's metrics read the same
  order from the contact row: the poll keeps GHL's attribution (first and last touch) on `contacts.attribution`.
- **Captured by the engine, not a Zap.** Call booked's `u1` writes the booking's UTMs (Calendly tracking: `utm_source`,
  `utm_medium`, `utm_campaign`, `utm_content`, `utm_term`; `fbclid` when a booking carries it) to the contact's six UTM
  fields, **only where GHL's field is empty right now**: the step reads the live contact (D68) and leaves a filled field
  alone (`update_contact` field `if_empty`), so a first touch is never overwritten and a second booking, a move or a re-run
  writes nothing. Each field is a binding (`crm.field_contact_utm_source`, `_utm_medium`, `_utm_campaign`, `_utm_content`,
  `_utm_term`, `_fbclid`); an unbound one is simply not written (a binding every reference of which carries `default:` is
  optional in a template's manifest). The mode rules apply as to any CRM write: in shadow, and for real contacts in test,
  what would be written is recorded and nothing is.

## D77. Three tries, then the rest of the run goes on; a changed answer clears; calls booked before the engine (2026-10-10)

Tyler's rulings, relayed the same day and built together.

- **Three tries, then skip or hold.** "A 3-attempt cap to failing steps is important. If anything is down, we just check
  every once in a while, and we only check that one specific step. We pause and wait on that specific step. If we can
  pass without pausing, that's even better, so that if something fails, we still get a 90% result. It alerts me and says
  'Hey, by the way, we couldn't complete this step, so they missed the tag or whatever it is, but everything else still
  ran.' If it's [blocking], it should pause." D66's classes stay (transient / auth / permanent / unknown; auth keeps its
  one alert per vendor and its token-change wake); a step gets at most three tries (`RETRY_SCHEDULE` 1 and 5 minutes;
  permanent is not retried, unknown once). Then:
  - a **non-blocking** step is written `skipped` (`result.kind: gave_up`, the tries, the error) and the run goes on to the
    next node, with one alert per step and person (`skipped:<workflow>:<node>:<contact>`): **"Couldn't <what the step
    does> for <name> after 3 tries (<what the vendor said>); everything else in <workflow> ran."** and a **Retry this
    step** link. Where another workflow leans on what the step does (it updates the record or card the step makes, or
    starts on the booking status the step sets), the alert says so by name.
  - a **blocking** step that is down (transient) holds the run ON that step (`status 'paused'`, `runs.step_held`, claimed
    by the scheduler when `next_run_at` comes): only that step is re-checked, 15 minutes after the hold, then hourly
    (`HOLD_RECHECK_MIN`), until it passes and the run carries on by itself. One alert (`run:<id>:paused`, headline "Run
    paused on a step"): **"<workflow> is paused: it couldn't <what> for <name> after 3 tries (<what the vendor said>).
    Nothing after it runs without it, so the engine re-checks only this step every 15 minutes, then hourly, and carries
    on by itself when it passes. Retry or skip it on the run page."**, closed with ✅ Resolved when the step passes (quietly
    when the run is mooted or turned off meanwhile). A blocking step refused for good (permanent) pauses for a person:
    **"<workflow> couldn't <what> for <name>: <what the vendor said>. Retry or skip it on the run page."**
- **The blocking rule** (`platform/src/engine/blocking.ts › failureRoles`, from the definition alone): a step is blocking
  when it decides or waits (trigger, branch, check, the waits, set_var, record, record_outcome, update_opportunity,
  start_workflow, pause_runs, resume, exit) or a later step on its path reads what it produced: `cards.<board>` /
  `opportunity.*` after a pipeline_card, `record.*` after a crm_record (a later record step's own `relate` reads its own
  record, not this one), the `into` of a classify / analyze / webhook / report / eod_due, `appointment.<field>` after an
  update_appointment that sets it, a post a blocking wait_for_reaction waits on (a listener goes on without it).
  Everything else is non-blocking: tags, notes, tasks, contact updates, sends, Slack posts and reactions, documents, cards
  and records nothing later reads, an `optional` analyze. `blocking: true|false` on any step overrides it (on
  wait_for_reaction the field keeps its D58 meaning; a wait is always blocking). In Hair's enabled templates the
  blocking vendor steps are: setter-call-logged `a1` (classify, read by `c3`) and `a2` (analyze, read by `m1`);
  call-booked `s4` and `b5` (the closer card, named by the Sales Call record `k4`); pre-call-sequence `c1` (Jev's read of
  the reply, read by `b1`); call-recorded `a1`, `a2`, `a3` (the classifications and the notes the branches and the
  record read); eod-reminder `v_evening`, `v_morning` (eod_due, read by `c_due`); wrap-ups `n_build` (the report the
  post sends). Every other step in them (every tag, note, task, send, Slack post, Sales Call / Payment record and card in
  call-outcome, call-cancelled, payment-recorded, deal-closed, …) is non-blocking (`blocking.test.ts`).
- **Alerts in plain words** (the owner's review of "\"Call booked\" needs a hand at step k4 for Tyler TEST: GHL 400 on
  /objects/…: {\"message\":…}"): every step-failure alert (paused, held, skipped, auth, the sweep's could-not-run and
  failed) says what the step does (`doingWords`, never the node id), for whom, and the vendor's own message out of its
  body (`failures.ts › plainError`: GHL `message` / `errors[].message`, Calendly `message` / `details`, Slack `error`, the
  status in words only when nothing else), never raw JSON: "Call booked couldn't create the Sales Call record for Tyler
  TEST: GHL says a record with the same value for External ID - test-20254447 already exists. Retry or skip it on the
  run page." The raw error stays in the alert's detail and on the run page.
- **Retry this step** re-runs only that step: `POST /api/v1/runs/<id>/retry` with `{ node }` (`runner.ts › rerunStep`)
  takes a step whose last row is a `gave_up` skip, runs that node once, now, against the run's saved context, whatever
  the run is doing since; nothing before or after it moves, the run keeps its place. Idempotent through the ledgers (a
  send already out, a note or task already written, a card already made are not done again); a step that already
  passed is refused (409). Passing closes its alert; `audit_log` `run.step_retried`. The run page lists each skipped
  step with its own button, and shows a held run as "Paused on <step>" with when it is re-checked next.
- **No loop anywhere**, proven in `retry.test.ts`: a permanently failing non-blocking tag makes exactly three tries over
  six looks, is skipped, the note after it is written and the run completes; a blocking card makes three fast tries, is
  held, re-checked alone at 15 minutes and then an hour, nothing after it runs, and when the CRM is back the card is
  made once, the note after it once, the run completes, and the run's rows are the trigger, five tries of the card, the
  note and the exit.
- **A changed EOD answer clears what the old one set.** "Changing an EOD shouldn't leave the old disposition." A
  `crm_record` step takes `clear`: properties an update writes as `null` unless this answer sets them (GHL ignores an
  empty string for some field types; `ghl/02-api-facts.md`, **to verify live** on a test record). Call outcome filed:
  the no-show record (`r2`) and the rescheduled-on-the-call record (`r3`) clear `disposition`, `cash_collected`,
  `objection_primary`, `next_step`, `next_step_date`, `payment_terms`; the showed record (`r1`) clears `disposition` when
  the answer has no call outcome. The closer card steps that leave a card open (`gn2` No Show, `k2` Follow Up, `kc`
  Scheduled) now say `status: open`, so a lost card the earlier answer closed is reopened; a change to rescheduled on
  the call edits the thread line (`r3s`, "🔁 Rescheduled or cancelled on the call, per <closer>.") and takes the earlier
  👻 / ✅ back. Tags and the thread line already followed the new answer (D76). Not changed: the cards after a change to
  "rescheduled on the call" stay where the earlier answer put them (no template has a stage for it).
- **Calls booked before the engine** (removed by D110). "Calls booked before the engine was installed: only have [those] that have an
  empty disposition in the Sales Call object." The end-of-day form for a closer also lists their GHL Sales Calls
  (`closer` = their roster name) whose call time has passed and that carry neither a filed outcome (blank, or a value
  the company's map does not call filed, such as `scheduled`) nor a disposition, when the record is not one of the
  engine's own bookings (we wrote or matched it, it carries a booking's id, or it is the person's booking that same
  minute). The row is `ghl:<record id>`; filing it writes to that record directly with the same properties Call outcome
  filed writes (outcome in the company's keys, disposition for a held call, the clears above), in live or for a test
  contact in test (otherwise noted in `audit_log` `eod.sales_call_filed`, not written); a row the form did not offer the
  closer is dropped before anything is stored; a write GHL refuses is one alert and is retried by filing again. A record
  with an outcome never appears, except a row the closer filed here, which stays for refiling. `eod_due` (the
  End-of-day reminder) reads the same records through the same function (`eod.ts › blankSalesCalls`) and counts, per
  day, the ledger's unfiled calls plus the blank records the form adds, so its number is the form's rows.

## D79. Jev reads what a setter call achieved (2026-10-11)

The owner: "We should have a Jev call to see if the setter call was set, follow up, or DQ."

- **Four results.** After Jev calls a dialer call a setting call (D48), Setter call logged asks Jev a second question of the
  transcript (`a3`, a classify over the core vocabulary `setter_call_result`): **set** (a call was booked on this call),
  **follow_up** (interested, not booked; a callback agreed or implied), **dq** (does not qualify) or **not_interested**
  (declined), each with its criteria on the step. A DQ also gets Jev's reason (`a4`, `setter_dq_reason`: budget, age, geo,
  medical, timeline, no_problem, competitor, bad_contact, other), read only when the result is dq or Jev is unsure. Jev's
  value and confidence land on the recording's analysis (`classify.result`, `classify.dq_reason`, merged in depth so the
  call type stays) and every read is one `setter_call.result` event (predicted, confidence, top guesses, the result
  written, who decided it, whether a booking came within 30 minutes, whether Jev agreed, the DQ reason, whether actions
  were on). A confirmation call is not read.
- **Booked within 30 minutes is Set.** The read waits until 35 minutes after the call ends (`w2`; the 5 extra minutes let
  the poll bring in a booking made at minute 29). A closing call booked for the person from the start of the call to 30
  minutes after it ended (`recording.booked_within_30m`, read live from our appointments) makes the result **set**
  whatever Jev read; the event says whether Jev agreed.
- **Where it is written.** The Discovery Call record gets `call_result`, a single option whose keys are the company's own
  (`discovery_call.results`, `{key: meaning}` like `sales_call.outcomes`, install `discoveryCall.results`; unbound, the
  keys are `set`, `follow_up`, `dq`, `not_interested`; `picklist.discovery_call_result.<meaning>` in a template). Until the
  owner adds the field in GHL the write leaves it out and names it (`not_on_object`, D76); an update with nothing else to
  write is skipped the same way, never a failure. The Slack post's outcome line is the result ("Follow up (Jev is 88%
  sure)", "Set — a closing call was booked within 30 minutes of the call (Jev read: …)").
- **Unsure reads ask the setters.** Under 70% sure, or a read a careful person would doubt (D47's ambiguity rule), nothing
  is written. The setters' channel (`slack.channel.setter_calls`, else `slack.channel.ops`, else `slack.channel.bookings`:
  `slack_post.fallback_channel` now takes a list, tried in order) gets one question naming the person and the setter with
  Jev's top guesses, offering ✅ Set, 🔁 Follow up, ❌ DQ, 🚫 Not interested. D58's non-blocking listener holds it two days
  while the run waits; the first tap writes `call_result`, is recorded as the team's answer (`intent.reviewed` with
  `domain: setter_call_result`, the same event the pre-call tap writes; the Health page's reply score leaves it out) and
  replies in the question's thread; two days unanswered records `intent.unanswered` (same domain), closes the question in
  its thread and writes nothing.
- **Suggest first.** The actions are built and off: `setter_result.act` (install `discoveryCall.act`, default false).
  Follow up → a GHL task "Call back <name>" for the setter who dialed, due the next business day (Friday → Monday), with
  the call notes' suggested next step in the body (`next_step`, added to the setter-notes prompt: Jev picks among fixed
  options, it does not write text); DQ → the tag Jev's reason maps to (`dq-budget`, `dq-age`, `dq-geo`, `dq-medical`,
  `dq-timeline`, `dq-no-problem`, `dq-competitor`, `dq-bad-contact`; any other reason → plain `dq`) and the setter card
  marked lost (moved to `crm.stage_setter_dq` when bound; a stage binding left unbound now leaves a card where it is);
  not interested → the setter card lost (`crm.stage_setter_not_interested` when bound); set → nothing (Call booked has
  the booking). Off, the post (or the thread reply after a tap) says "Would have (actions are off): a task for Allan to
  call back Tyler, due next business day." and the steps are skipped; on, it says "Next: …". Test mode and shadow (D52)
  write nothing to the CRM either way.
- **Accuracy.** `jev_setter_accuracy` in the bot's registry: of Jev's committed reads with a known outcome, how many
  matched, split by Jev's read (or by setter). What happened, strongest first: the Discovery Call's `call_result` changed
  in GHL after the engine wrote it (read live; when GHL cannot be read that rule is skipped and the answer says so); a
  team member's tap; a booking within 30 minutes, then within 7 days → set; a `dq`/`dq-*` tag added in the CRM → dq; the
  setter card marked lost in the CRM → not interested; a set read with no booking in 7 days → missed. Only what a person
  or the CRM did counts, never the engine's own actions. Reads with no outcome yet and reads Jev was unsure of are said
  under the number, not counted in it; test contacts never count. The owner turns the actions on when this says Jev is
  right often enough.
- Blocking (D77): the result read `a3` holds the run when Jev is down (the record, the post and the actions read it);
  the DQ-reason read does not (a plain `dq` tag stands in).

## D80. The end-of-day form pre-fills only from evidence (2026-10-11)

Was (D54): a past call with no recording, no outcome and no money opened the form as **No-show**, for the closer to
correct. Found in the hand test: three test calls with no recording all opened as No-show. Tyler agreed the default is a
guess a hurried closer submits unchanged, so a failed recording or a call taken by phone would quietly become a no-show.

- A call's outcome is pre-filled only from evidence: an outcome the ledger holds (filed, or marked no-show by the booking
  source or the CRM), money (a payment or a won card that day), or a recording (showed, with Jev's read of how it ended).
- Otherwise it opens **blank**, required, with the hint "No recording found for this call." Nothing is marked until the
  closer answers (unchanged).

## D81. Collected before revenue, one name for each (2026-10-11)

Tyler: money is "collected / revenue", and the deal's value is "revenue generated". The end-of-day form asked each
closed call for "Contract value" then "Cash collected", while the day's totals asked cash then revenue.

- Everywhere the two sit together, cash collected comes first: the per-call fields, the call's disposition note
  ("Closed: $1,500 collected, $2,999 revenue generated"), the filed summary and the correction lines.
- The per-call field is **Revenue generated ($)**, the same name as the day's total. A company that saved its form with
  the old default label ("Contract value ($)") follows the rename; a label the company chose stays theirs.
- A call with more cash collected than revenue generated is not filed: the form says "Check <person>: cash collected is
  more than revenue generated". If someone really paid more than the deal (an add-on), revenue is raised to match.

## D82. A call already answered is not owed (2026-10-11)

Found live: James's morning reminder listed Oct 5, 6, 8 and 9 (6 calls). Every one was already filed in GHL through the
old process (Lynton showed / closed won, the rest no-shows or close pending), and the ledger held a no-show for four of
them. The reminder's ledger half counted every held call on a day with no end-of-day form filed, answered or not; only
its GHL half (D76) looked at outcomes.

- The ledger counts a call as owed only when it holds no answer: a no-show, a call rescheduled on the call, or a call
  outcome is an answer; "showed" alone is not.
- With the Sales Call object bound, GHL decides: a ledger call whose Sales Call is filed (an outcome other than
  scheduled, or a disposition) is answered, whatever the ledger holds. A record is matched to its booking the D77 way:
  one we wrote, its booking id or slot, or the same person at the same minute (the old process carries its own ids).
- A day drops off the reminder once nothing on it is owed. Names from the old "Name · day · time" labels read as the name.

## D83. The hourly sweep copies GHL's outcome too (2026-10-11)

Tyler: attendance is showed / no-show; the outcome is closed, follow up and so on. GHL is the truth and the engine is
there to see what's going on. The drift check (D73) copied a Sales Call's attendance into the ledger, never its outcome,
so the engine had Lynton as "showed" while GHL had him closed won.

- In GHL the field keyed `outcome` is labelled **Attendance** and the one keyed `disposition` is labelled **Outcome**
  (labels renamed 2026-10-11; keys unchanged, so nothing reading them moved).
- Every hour, for each Sales Call matched to a booking in the last 7 days: a call GHL says showed takes GHL's outcome on
  the ledger (`call_outcome_term`); a call GHL says did not happen (no-show, cancelled, rescheduled) has none. A deposit
  the engine filed stays a deposit when GHL holds closed won (the field has no deposit). Nothing fires; the ledger only
  follows. Every change is in the audit log.
- What each disposition value means is `sales_call.dispositions` (JSON {value: closed | deposit | follow_up | lost |
  unqualified | pending}, or {value: {meaning, reason}}; install `salesCall.dispositions`). Unbound, it is the values the
  engine itself writes (closed_won, follow_up, lost, dq). A value with no meaning is asked about in the sweep's alert,
  never guessed.
- A reason is the company's own term under that meaning, made at install: Hair's `financing_denied` is lost with the
  reason "Financing denied" (they applied for financing and nothing offered works).
- **Pending** is a new call outcome: half a close, and only that. Tyler: "Closed Pending would be they have signed the
  agreement but no payment, or payment but no signed agreement. Everything else is just words." So a disposition meaning
  pending is checked against the ledger: paid or signed (not both) is pending; both is closed; neither is follow up.
  It is never counted as a close. Hair's `close_pending` means pending.

## D84. A run keeps its own state, not a copy of the contact (2026-10-11)

Tyler: the run should stop saving the contact copies; nobody will ever ask what a contact looked like four turns ago.
Store only what is needed, GHL is the truth. Every time a run parked, ended or paused, the engine wrote the whole context
it had built into `runs.context`: the person's name, phone, email, custom fields and tags, the booking with its answers
and tracking, the call with its transcript and summary, cards, team members. A wake read back only `vars`, `reply`,
`event` and `reaction` and rebuilt the rest from the ledger and the CRM, so the copies were never used, only kept.

- A run keeps: `vars` (its own values, with the wait pins `vars.__wait.*`, `__wait_for_reply.*`,
  `__wait_for_reaction.*`, `__check.*`, its Slack posts `vars.__slack.*` and an armed listener `vars.__listen`), `reply`
  (as today; whether the reply texts stay is a separate decision), `event` (the trigger, which names the recording by
  id), `reaction`, and `contact.fetched_at` / `contact.stale` (when the CRM was last read, for the run page, D68).
  Nothing else. One function decides it (`persistedContext`), used wherever a run is saved.
- The contact row stays (name, phone, email, GHL id, tags, custom fields), and so does the run's own record: where it
  is, its steps, what it sent. Every wake still reads the person, the booking and the call fresh, as before.
- Older rows are slimmed once by `POST /api/admin/slim-runs` (a dry run unless `dryRun: false`; it reports the rows and
  bytes it would change). Batched, compare-and-set, safe to re-run.

## D85. Workflow building blocks: wait for an event, lists, lookups, records by id, opportunities (2026-10-11)

The owner: "I want these all in individual workflows. I don't want this to be a custom build that we have to continue to
build every single time. I want to be able to adjust and adapt the existing workflows ... I do not want you to hard code it."
An audit found business behaviour held in engine code because a workflow had no generic step to say it with. These are the
steps. Nothing existing moves onto them yet; that is the next piece of work, done separately.

- **Wait for an event, or a deadline.** `wait_for_event` waits for one event type about the run's contact (or its
  appointment), optionally passing a condition, and goes on by the edge labelled `event` the moment one is written, or by
  `until` at the deadline. Nothing polls: a parked run is marked with the type it waits for (`runs.wake_on_event`) and writing
  any event wakes the runs of that company waiting for that type about that person or booking, the way a reply wakes a reply
  wait. `since` lets an event that already happened count ("a booking made during the call"); without it only events after the
  step began count, and an event the step took once is not taken again. The deadline is pinned when the step begins and waits
  for the send window as `wait` does, unless the step says it is internal.
- **Lists in a template.** `each` renders its quoted argument once per item of a list (`{{item.*}}`, `{{index}}`,
  `{{number}}`) and `join` puts the lines together; an empty list falls to `default:`. The smallest change to the filter
  grammar that allows it: a filter argument in double quotes is read whole, so it may hold `|`, `}}` and expressions of
  its own. Nothing written before uses a quoted argument, so every existing template renders as it did.
- **Lookups.** `lookup` reads facts into a var for the steps after it, from a fixed set of named, read-only questions the
  engine owns: a person's bookings (by when booked, when they start, call type, setter or self, status), their recorded
  calls (by when, provider, caller, phone or meeting, connected) and the last event of a type. A template picks a question and
  its filters, never SQL. The facts "booked within 30 minutes of the call", "led to a booking" and "has an upcoming call" are
  each one lookup now, proven equal to the engine's own; the facts stay until the templates move.
- **A CRM record by its own id.** `crm_record` takes `record_id`, the CRM's id of a record the engine did not make (the
  old process's Sales Calls, a record a person made). It only ever updates; everything else is the keyed update's rules:
  shadow and test write nothing, unknown properties are left out and named, `clear` empties what this answer does not set.
  An update is idempotent, so it takes no create claim; nothing can be created twice.
- **Opportunities won and lost.** `update_opportunity` takes `status` (open, won, lost) and a `lost_reason` from the
  company's terms, writes our ledger, and each change to won or lost is one `opportunity.won` / `opportunity.lost` event
  that starts the workflows listening for it (once: the row and the event are written together). `card` marks the
  contact's card on a board the same way through the pipeline card step's own code, not a second copy of it.
- Each block is classified for the failure policy like the rest (D77): the event wait and the opportunity are blocking (the
  run waits on one; the other is the ledger), a lookup is blocking when a later step reads it, a record by id is not unless
  a later step reads `record.*`.

## D86. A late lead is still a lead; the workflow decides what it gets (2026-10-11)

The minute poll brings every new GHL contact in. The hourly sweep (D73) is the safety net for one the poll missed (GHL
down, a search that lagged). Was: a lead the sweep found more than 60 minutes after it arrived started no lead
workflows at all, and the sweep's alert asked someone to follow up by hand. That rule lived in code with no record.

- The sweep now always fires New lead for a contact it pulls in, with `minutes_late` on the event. New lead runs (the
  setter card and tag are right however late).
- Speed to lead decides: a setting on its first step (`late_after_min`, 60) and a branch. In time, it runs as before.
  Too late, it sends no first text or email and posts to the ops channel (else alerts) that the lead came in late and
  someone should follow up by hand.

## D87. One setter result, posted when the booking lands; calls by conversation; closing calls through the dialer; transcripts never stored (2026-10-11)

Tyler, on how calls flow: "I want these all in individual workflows ... I do not want you to hard code it." "I don't like a
hard 'wait' rule ... calls can take anywhere from 5 minutes to an hour or more." "For this application we'll never store the
transcripts." Live example: Lynton's 64-minute closing call with James on Oct 5 came through the GHL dialer (a 0-minute
connect, then the call 37 seconds later), landed in Setter call logged, was read as "other", and nothing happened.

- **Transcripts are waited for, not timed.** The minute poll re-checks a connected call for its transcript every tick, for up
  to `calls.transcript_wait_min` (a company setting, 120) after hang-up (was 30 minutes from the start), then settles without
  one. Nothing else waits for a transcript.
- **A call of 0 seconds is no call.** The dialer's "completed" with 0 seconds is `zero_seconds`: not connected, never a part
  of a conversation, no run, not a connect in the metrics (still a dial). The 60-second knob on the setter post stays.
- **Calls by conversation.** "Tech issues happen, or sometimes somebody hangs up on accident, so we need to be able to take
  both calls as a whole." The same caller's connected calls to the same person, each starting within
  `calls.conversation_gap_min` (15) of the last one ending, are one conversation (`lookup call_conversation`). The first part
  posts as usual; never a wait for a possible second part. When a later part's transcript lands, its run reads the whole
  conversation (each part's transcript fetched from GHL again) and edits the same Slack post (`slack_post` `edit` on the
  `setter-call:<first part>` tag, chat.update as D76's EOD resubmit) and updates the same Discovery Call record (keyed by the
  first part), marked "(2 parts)". A part whose later part already has a transcript leaves the whole to that part's run
  (`read_with_a_later_part`), checked before it posts and again before a late Set. Sales call recorded reads conversations the
  same way; a meeting recording is its own whole.
- **Closing calls through the dialer.** Jev's call type has a fourth answer, closing. A dialer call Jev reads as closing is
  recorded as `call.closing` about the person's booked call with the same closer starting within an hour of the call, and
  that event starts Sales call recorded (its second trigger: "another trigger on the Fathom call"), so one closer workflow
  handles Fathom and dialer closing calls: linked to the booking, marked showed, Jev's outcome read, notes, review. A closing
  call that lines up with no booking is posted as unlinked and the team is asked which booking it was (the attention channel,
  else ops, else calls; 1️⃣ 2️⃣ 3️⃣ for their closing calls two weeks either side, ❌ none, two days); the tap records
  `call.closing` about that booking and the workflow runs again on it, editing the review. To say this in a template,
  `record` gained `start` (also start the workflows listening for the event, once) and `appointment` (the event is about that
  booking); `appointments_for_contact` gained `closer`.
- **One setter result.** "Led to booking" and Set are one thing: **Set** = a booking through a setter link for that person
  (`booking_source` setter, D24's rules unchanged), made during the call or within `setter_result.set_within_min` (30) after
  hang-up, credited to the setter on the call. Otherwise Jev's read: follow up, DQ or not interested; Jev's Set with no such
  booking, or a read under 70% sure, asks the setters (D79's question, DQ reason and "Would have" unchanged). A self-booked
  link is never Set. The context facts `recording.booked_within_30m` and `recording.led_to_booking` are gone;
  `recording.set_until` (hang-up + the setting) is the window's end; the metrics' `calls_set` and the setter report's
  bookings count the same rule (`setByBookingSql`, was "a booking within a day"). The Discovery Call's `led_to_booking`
  checkbox is no longer written: GHL refuses to update a checkbox on a custom object record (found live, ghl/02-api-facts),
  and `call_result` carries Set.
- **Posted when the booking lands.** "Post as soon as the booking lands." `wait_for_event appointment.booked` (a setter-link
  booking, `since` the call's start, `until` 15 minutes after hang-up): one made during the call, or landing in those 15
  minutes, posts at once as Set; otherwise the post goes out at the 15-minute mark with Jev's result. A second
  `wait_for_event` until the Set window closes: a setter-link booking that lands then edits the post and the record to Set
  the moment it lands; one after that changes nothing. The fixed 15- and 35-minute waits are gone. A confirmation call posts
  as soon as it is read. The question to the setters and the actions wait for the window to close, so a call that becomes
  Set at minute 25 never gets a callback task.
- **Transcripts never stored.** A transcript is read from its source the moment a step needs it (`{{recording.transcript_text}}`,
  `{{vars.<lookup>.transcript_text}}` for a conversation) and dropped from the context after the step, so no run, event or step
  row keeps one (the classify event keeps the input's length when the input is a transcript). GHL dialer calls are read
  again through `callMedia` (every retry reads again). A Fathom or Zapier webhook delivers it once, so it is held on the
  recording only until the runs that read it end (kept while one is paused on a failing read), then cleared; a step that needs
  it later reads it from Fathom's API (`fathomTranscript`, to verify live). Retention clears anything still held
  `calls.transcript_hold_hours` (48) after its last run ended. The provider's summary is never kept. Jev's answers (call type,
  result, confidence, DQ reason) stay on the recording's analysis. The simulator's synthetic call holds its transcript like a
  webhook's.
- Where the numbers live: the 2 hours, 15-minute gap, 30-minute Set window and 48 hours are company settings
  (`calls.transcript_wait_min`, `calls.conversation_gap_min`, `setter_result.set_within_min`, `calls.transcript_hold_hours`,
  offered on the settings screen); the 15-minute post deadline, the hour either side for a closing call's booking and the
  two weeks of bookings offered to the team are step settings in the templates.
- Known limit, stated: a part that already asked the setters (Jev unsure) keeps its question open when a later part of the
  same conversation arrives; the later part's run reads the whole and may ask again under the same tag.

## D88. Business rules live in workflows and settings, not code (2026-10-11)

The owner: "I want these all in individual workflows. I don't want this to be a custom build that we have to continue to
build every single time. I want to be able to adjust and adapt the existing workflows ... I do not want you to hard code
it." D85 built the steps; this moves the behaviour the audit found in engine code onto them. The engine keeps the ledger,
the doors, the collecting and dedupe, the clock; what is said, what is written to the CRM and when is a workflow's or a
setting's. Existing companies get it through the normal install upgrade: an untouched copy follows the template, and a
template that carries what the engine used to do by itself (`engine_default`) installs ON into a company that already
existed (OFF into a new one, as every template). What an existing company sees stays the same except where said below.

- **A card moved by hand** (A1, was `card-moves.ts`). The engine records `card.moved` (now with the mover's roster id)
  and nothing else. The new **Card moved by hand** workflow posts the thread line, branches on `event.to_stage` against
  the stage bindings, checks the call has started (`appointment.started`) and files the outcome with `record_outcome`
  `source: disposition`, so Call outcome filed still runs. The cards poll watches every bound `crm.pipeline_*`. Tyler:
  dragging to Lost or DQ "should still show up in the end-of-day report so we can get an understanding of why it was lost
  or DQ": the form opens with that outcome and what the move said, asks the new **Why were they lost?** (or the DQ reason),
  the reminder keeps the day owed until it is filed, and the filed summary lists the reasons.
- **Unlinked payments and unmatched recordings** (A2, was `notify.ts` and the Whop / Zapier / recording doors).
  `payment.unlinked` and `recording.unlinked` are dispatched; the **Unlinked payment** and **Unmatched recording**
  workflows post the same words. `notifyTeam` is gone. An event with no contact and no person starts a run about the company.
- **An end-of-day answer for a Sales Call booked before the engine** (A3, was `eod.ts` `fileGhlRow`; removed by D110). It is an
  `eod.call_filed` event; the **Sales Call filed from the end-of-day form** workflow writes the record by its own id
  (`crm_record` `record_id`), the disposition from a pick the company edits.
- **The end-of-day reminder** (A4, was `eod_due` in the executor). `lookback_days` (7), `include_today` and
  `overdue_after_days` (2) are on the step; it hands the template a list and the DM and the operator's note are built from
  it with `each` / `join`. Tyler: "The end-of-day report: yes, that's great."
- **The hourly drift sweep** (A6, was `ledger-drift.ts`'s CRM writes and questions). The ledger mirroring stays in the
  engine (a contact pulled in, one marked gone, the attendance and D83's outcome followed); each kind of finding is one
  `drift.found` event a sweep. The two GHL writes are `drift.sales_call_cancelled` (once ever per record; GHL set back
  afterwards is a question) and `drift.sales_call_unlinked`, done by the new **Ledger drift** workflow with `crm_record`
  by id. The questions are data on the `health:ledger_drift` alert and Health check words them, the same words. D73's
  and D83's behaviour is otherwise unchanged. `drift_days` (7) and `poll_lag_min` (30) are settings on the step.
- **Alerts** (A7, was `alerts.ts` `announceDue`). Tyler: "an alerts workflow is the best way to go ... we already have an
  hourly health report, so why don't we just put that in there?" The engine collects, dedupes and times alerts and emits
  `alert.raised`, `alert.repeated` (every `alerts.repeat_minutes`, 60) and `alert.resolved`; **Health check** has three
  triggers for them and posts the alert, the still-open line in its thread and the resolved line with a ✅. A failed poll
  is an alert after `alerts.poll_failures` (2). Slack only (Tyler: "We definitely don't need to alert on an email"): the
  email (Resend) and company webhook destinations are gone with their settings; an alert about the engine itself still
  goes to `OPERATOR_WEBHOOK_URL`.
- **Wrap-ups** (A8, was `reports.ts` `renderReport` and `WRAPUP_METRICS`). Tyler: "we should absolutely have a specific
  wrap-up report section in the workflow or template ... that can be adjusted." The `report` step reads the numbers named
  in `metrics` and words the body with its `layout` (headings and the empty line by kind, sections of lines built with
  `each`); the engine only drops blank lines and empty sections. The shipped layout says exactly what the code said.
  `breakdowns` (closer, setter) now does something; `period` sends a week or month so far.
- **Won and lost** (A9, was `disposition.ts` and `payments.ts`). Call outcome filed marks the opportunity lost on a loss
  and open again when a refiled answer takes the loss back; Payment recorded marks it won on a payment
  (`update_opportunity`, `from: [open]`, so a won pursuit is never made lost by a later answer). Removed because nothing
  read them or they half worked: `purge_after_months`, `opp_lost_on`, `opp_inactive_days`, `opp_won_on` (only
  first_payment worked), `opp_opens_on` (lead_created was ignored; the ledger's opportunity is plumbing and opens at the
  first booking or a payment). A company that wins on paid in full changes the step's condition.
- **The end-of-day outcomes** (B6, was `eod-form.ts` `OUTCOMES` and the value checks in `eod.ts`). The outcome field on
  the company's `forms` row carries its own list, each answer with its label and meaning (attendance, call outcome,
  money); everything reads the meaning. **Close pending** is added (D83: only half a close, never counted as one).
- **Constants that became settings** (B): `alerts.repeat_minutes`, `alerts.poll_failures`; on the health_check step
  `slots_days` (the executor used to pass 7 whatever the step said), `fathom_silent_days` (14), `drift_days`,
  `poll_lag_min`; on eod_due the three above; on report `metrics` and `period`.

Changed for an existing company, on purpose: the unlinked, card-move, old-Sales-Call and alert posts and writes happen on
the next tick after the fact instead of in the same request; a loss now asks why (required, the company can untick it);
the form offers Close pending and Jev's "close pending" read pre-fills it; the filed summary lists lost and DQ reasons;
the drift questions are grouped by kind; the opportunity is won and lost a tick later, inside the workflows; no alert
email or webhook. A company whose Health check, Payment recorded or Call outcome filed copy was edited before D88 is not
upgraded (D16) and does not get their new steps: readiness warns when no workflow says the alerts; the others need the
copy re-made from the template.

Supersedes: D35's "the inbound doors and the alert announcer are engine" (the announcer is Health check's), D33's fixed
hourly cadence and its email and webhook destinations, D61's handler that posted the line and filed the outcome (a
workflow now), D76's fixed eod_due rules and wrap-up words in code, D77's direct write of an old Sales Call's answer and
its fixed DISPOSITION map, D73's CRM writes inside the sweep, and D29's claim that nothing about wrap-ups was in code
(true now). D82's "a call already answered is not owed" gains one exception: a loss or DQ a card move filed is owed until
the day is filed.

## D89. A reply is kept as "it came in" plus Jev's read, never its text (2026-10-11)

Tyler: GHL is the source of truth; store as little as possible while keeping what we use. "We can keep that the reply came
in as long as we're also storing the Jev score of that reply. If we say Jev is 80% sure that this is a cancellation message
or a confirmation message, that's fine." He does not want the engine keeping the text of people's texts and emails. D38
already dropped the outbound side and kept a reply's body for 7 days; the body was also copied into the run's saved
`reply`, the `message.received` event (texts) and the `reply.classified` event (`input`), and those were never dropped.

- The poll stores an inbound message as a row with no words: GHL's message and thread ids, channel, direction, when, who.
  Waking a reply wait, the settle (D47), counting replies and the "since our last send" boundary need nothing more and
  work as before. `message.received` carries the channel and the message id.
- A step whose settings read the words (`{{reply.inbound_since_send}}`, `{{reply.last_inbound.body}}` or `.subject`: today
  pre-call's classify, the question to the closer and the three decision lines that quote the reply) gets them from GHL by
  message id just before it runs and the context drops them after it, the way D87 treats a transcript. The adapter read is
  `CrmRead.messageBodies`: one read of the thread for all of its messages (`GET /conversations/{id}/messages`, the newest
  100), else the message by id (`GET /conversations/messages/{id}`, the read the delivery status already used); a message
  GHL no longer has is left out. An email reply's body is not read, as the poll never read it; its subject is.
- The run keeps which messages (`reply.message_ids`, `reply.last_inbound.message_id`), never their words: `persistedContext`
  strips them too. A step's result and a var it set are scrubbed of the words before they are saved (a skipped Slack post's
  `would_post` preview says "[their reply]"); a `record` step never writes them. The `reply.classified` event keeps
  `input_chars` instead of `input`.
- Jev's read is what is kept: `reply.intent`, `reply.intent_confidence` and `reply.top_guesses` on the run (as D58), and on
  the `reply.classified` event the intent, confidence, whether it was unclear and now also `top_guesses` and `ambiguity`, so
  "Jev was 80% sure this was a cancel" can be reported from the event alone. `intent.reviewed` and `intent.unanswered` keep
  `predicted` and `predicted_confidence`; the appointment's `pending_read` is unchanged.
- GHL down when the words are needed: the step fails and is retried in place under the normal policy (D66, D77). Jev is
  never asked to read an empty text.
- The engine's own sends keep their words (`sends.rendered_body`, D38), including a Slack post that quotes the reply: that
  is the engine's record of what it said, kept 30 days by default.
- What was stored before is cleared once by `POST /api/admin/clear-reply-texts` (operator bearer, a dry run unless
  `dryRun: false`, optionally one company): inbound `messages` lose `body` and `subject`, saved runs lose the reply's words,
  `message.received` loses `body`, `reply.classified`'s `input` becomes `input_chars` (every classify that was not of a
  transcript read a reply), and a step result quoting a reply still held in `messages` has the quote replaced. It reports
  the rows each part changes and a rerun changes nothing. Written, not yet run against production.
- To verify live: the `body` and `subject` fields on GHL's single-message read (the thread listing's shape is verified).

## D90. Found in the closing-chain test (2026-10-12)

Tyler TEST on Hair: a $1,500 deposit (Payment recorded, then Deal closed in the same tick).

- **A number goes to the CRM as a number.** Both Sales Call updates (Payment recorded `r2`, Deal closed `r1`) failed with
  GHL's `"1500" isn't a valid number for Cash Collected (USD)`: a record property was sent as text unless its key looked like
  an amount (`amount`, `total`, `count`, `score`, `duration`, `…min`), and `cash_collected` does not. The object's field
  list the engine already reads to drop unknown properties (D76, ten minutes per company) now carries each field's GHL type,
  and each property goes as its type wants (`executor.ts › propertyValue`): a number for NUMERICAL, MONETORY, FLOAT ("1,500"
  is 1500), an array for MULTIPLE_OPTIONS and CHECKBOX ("price, timing" is two), text for the rest, so a text field named
  like a number stays text. The key's name is only the fallback when the field list cannot be read. An empty value is left
  out as before, never a 0. To verify live: that GHL takes a bare number for a MONETORY property (its words say it wants
  "a valid number"; `null` already clears one, seen live on 2026-10-11).
- **What moved the closer card was the CRM, not the engine; the engine then made a second card.** The `card.moved`
  (Scheduled → Closed Won, won, no mover) was stamped by GHL at 01:07:53, between Payment recorded and Deal closed, and seen
  by Deal closed's own read of the contact's cards when it started at 01:07:56. Nothing in the engine wrote that card: the
  only engine card writes are the card step and `update_opportunity`'s card, which goes through it, and Payment recorded's
  `o_won` has no card. A workflow in Hair's GHL moved it (GHL also added `stat-closed-won`, which the engine never wrote
  that day), so the line was right by D61 ("a hand or a CRM workflow"). The harm was after it: Deal closed's step (Closed -
  Won, won) found no open closer card, the card step only picks open ones, and it **made a new card** at Closed - Won
  (`tA4hRWZtlhOQzWN3xI2w`, a duplicate now in Hair's CRM). A step that closes a card (status won or lost) and finds none
  open now takes the board's latest card when it is already closed that way, and reads "already there" when it is on the
  stage too: a closed card is never made twice.
- **An engine write is never read as a hand, on every path.** Three ways it could have been, closed together: (1) the
  replica kept the old status when a step without a status reopened a closed card it picked (`pick: latest`; the CRM is
  told `open`), so the next poll saw open against lost; the replica now holds the status the CRM was told. (2) The replica
  was stamped with the run's start, not the moment the CRM took the write, so a lagging snapshot from in between looked
  newer than our write; it is stamped with `clock_timestamp()` after the write. (3) A fold in another transaction (the
  poll, while a run started from the fire or admin routes, which run outside the tick lock, had written the CRM and not yet
  committed) compared the CRM's new stage with the old replica; a contact's cards are now read, folded and written under
  one transaction lock (`cards.ts › lockCards`), so the fold waits for the write to commit. Still a hand, once: a person's
  drag, or a CRM workflow's move. Known limit, as D66 says of the ledger: a run killed between the CRM's answer and its
  commit loses the replica's update, and the next look reads that move as the CRM's.
- **The "active" Card moved by hand run was not stuck.** It was started by the `card.moved` inside Deal closed's tick
  transaction (01:07:56, committed before the tick's alerts at 01:08:13), stood `active` on its trigger, unclaimed, while the
  minute's tick was still running (the 01:08 cron most likely found the tick lock held), and was run by the 01:09 tick: completed `noted` at 01:09:06, the post at 01:09:11. Its run row and
  its `sends` row commit together, so one never shows without the other; a query between 01:07:56 and 01:09 saw a run waiting
  for its first tick. Runs about the company (D88) end the same way (completed, finished, let go; 193 of them on Hair, none
  open). Nothing changed in the runner.
- Tests: `closing-chain.test.ts` (the engine's own Closed - Won and setter-won moves, then the poll: no `card.moved`, and a
  person's drag after it is one; the live order with a CRM workflow closing the card first: one `card.moved`, Deal closed
  "already there", no second card, the Card moved by hand run active and unclaimed until the next tick, then completed; a
  reopened closed card leaves no false move; an engine write in flight while the poll looks: the poll waits and sees no
  hand); `nodes.test.ts` (each property by its field type, the name fallback, an empty value never written); `moves.test.ts`
  (a run about the company ends completed).

## D91. The filed end-of-day post says what happened, not what was corrected (2026-10-12)

Tyler: "I don't want it to say corrected, I want it to say what happened. x calls, x collected." The Slack summary is
the day's totals and then one line per call: the person, the outcome, money collected and revenue on a close or
deposit, the next date on a follow up, the reason on a DQ or lost ("• Tyler TEST: Closed · $1,500 collected · $2,999
revenue"). The corrections are still kept on the report (D34), not posted. Found writing it: a bare date ("2026-10-29")
rendered as midnight UTC, the 28th in the US, in every template; a bare date is now that calendar day where it is shown.

## D92. Live per workflow (2026-10-12)

Tyler, before switching Hair from its GHL workflows and Zaps one pair at a time (01-open.md item 40): "we need to make
sure we have per flow toggles." Live was company-wide (`companies.mode`), so putting one engine workflow live meant the
whole company went live at once.

- **A workflow has its own mode.** `workflows.mode` is shadow, test, live or null; null follows the company. A run goes by
  its workflow's mode when set, else the company's (`mode.ts › runMode`), and the runner decides it once per claim as
  before (D52 addendum 2): `effectiveMode` is given the run's mode, not the company's. Runs with no contact (end of day,
  wrap-ups, health, alerts, drift, D76 and D88) follow the same rule: a no-contact run in a workflow live on its own is
  real; in one on test it is shadow.
- **Everything that decides real or shadow reads the run's mode.** CRM writes and sends (the effective mode), the 🧪 label
  (`mode` and `shadow` labels name the run's rung), `born_in` (the run's mode at birth), the run page's "in shadow", and
  the DM held back until live (D76 ruling 7): "until live" is the run's, so a workflow switched live DMs real people while
  the company is still in test. The drift sweep hands its two GHL repairs to the Ledger drift workflow (D88), so the
  repair goes by that workflow's mode (the least real of the workflows the event starts; none, the company's). Nothing
  outside `mode.ts` decides from `companies.mode` alone, except two company-wide things: the readiness note "Company is
  in test" and the harness refusal for a live company.
- **Going live on one workflow passes the company's gate, narrowed to it** (`readiness.ts › workflowLiveBlockers`): its
  stored definition runs, its required settings are bound (on or off: it is about to act for real), and Slack is
  connected when it posts, DMs or waits on a tap. Refused with those reasons; the workflow keeps its mode. Anything that
  puts a workflow's runs live counts, its own live or clearing back onto a live company.
- **The clean slate is per workflow** (D51). Going live on one workflow clears its runs not born live, so a run shadowed
  for a real person does not turn real halfway, and nobody already inside the GHL twin gets a second copy. The company's
  Go live now clears only the runs of workflows that will be live; one held on its own shadow or test keeps rehearsing,
  and the harness's synthetic bookings are cleared only by the company's.
- **The operator's control.** The workflow page has the company's mode control: company (its mode in brackets), shadow,
  test, live; `POST /api/v1/workflows/<id>/mode` `{ mode, by }` behind it. `POST /api/admin/workflows` takes
  `{ company, workflow, mode, by }` (`enabled` optional alongside; `null` or `"company"` follows the company), and its GET
  lists each workflow's `mode` and `runsIn`. Every change is a `workflow.mode` row in `audit_log`: by, the door, the mode
  and the rung before and after, what was cleared, when. The workflow list and page say "Live (this workflow)" or
  "Test (company)".
- **Install never writes it.** A template upgrade keeps the workflow's mode, as it keeps `enabled`.
- **The harness stays safe.** While any workflow that is on is live on its own, staging a fact (D23) for a contact who is
  not a test contact is refused unless forced: that workflow's run would reach a real person about a made-up booking.
- Tests: `flowmode.test.ts` (a company in test with New lead live: real for a real contact while Speed to lead's run for
  the same contact is shadow; cleared back to the company's; a no-contact run's label and DM follow its workflow, both
  ways; the 🧪 test and shadow labels by the run's rung; refused without Slack for a workflow that posts while one that
  does not goes live; the audit rows; only that workflow's rehearsal runs cleared; the harness refusal; the hand-off's
  mode; an install upgrade keeps the mode).

## D93. Retry and Resolve in Slack (2026-10-12)

The operator's rule: "When you fix something, remove the alert." An alert's Slack post said what broke and linked to the
dashboard (Open · Retry this step); fixing it meant leaving Slack. Now the post has the two hands on it.

- **The buttons are the workflow's** (D88). A `slack_post` takes `buttons`: up to five, each `{ text, action, value, style?,
  only_if? }`, `value` rendered, shown only when its `only_if` holds. With any, the post goes as Block Kit: the same words
  as mrkdwn sections (cut at line ends at Slack's 3,000 characters), then one row of buttons; `text` is still sent as the
  notification and the fallback, and an `edit` sends the blocks too. Health check's `a_post` carries **Retry** (only when
  `event.kind` is `skipped`: a step D77 skipped after its tries, the one alert whose fix is one step run once) and
  **Resolve** (every alert), both with the alert's id as the value. The Open link stays in the text; the "Retry this step" link went, the button does it (D95 pass).
  The actions are the engine's: `alert_retry`, `alert_resolve` (`definition.ts › SLACK_ACTIONS`); a company changes the
  words, which alerts get which button, or takes them off. An existing company gets them through the normal install
  upgrade (an untouched Health check copy follows the template; an edited one does not, D16).
- **The interactions door.** `POST /api/webhooks/slack/<companyId>/interactions`, Slack's Interactivity Request URL
  (`https://backend-in-a-box.vercel.app/api/webhooks/slack/<companyId>/interactions`; Slack app → Interactivity &
  Shortcuts on). Form-encoded `payload=`, the signature verified with the company's signing secret like the events and
  commands doors (forged, stale or missing: 401). A `block_actions` press of one of the two actions is acknowledged at
  once and handled after the response (`after()`, as the commands door does, since a retry can call GHL); anything else is
  a quiet 200. A press from another workspace than the company's Slack connection is ignored.
- **Who may press.** The company's owners and managers (`users` by `slack_user_id`, active) and the operator
  (`bot.escalate_to`). Anyone else gets a private "Only a manager can do that." and nothing moves.
- **Resolve** closes the alert through the same function as the operator's resolve route (`alerts.ts › resolveByPerson`):
  `audit_log` `alert.resolved_by_operator` with why "resolved in Slack by <name>" and who (`by: { slack_user_id, name }`).
  The post is edited in place (`chat.update`): the same words, the buttons gone, "✅ Resolved by @who" under them.
- **Retry** is D77's Retry this step (`hand.ts › retryStep` with the alert's `run_id` and `node`, so `runner.ts ›
  rerunStep`), by "<name> in Slack": that step alone, once, now. Passing resolves the alert in rerunStep, as from the
  dashboard, and the post becomes "✅ Fixed — retried by @who" with the buttons gone. Failing again keeps the alert open
  and the buttons on, and says so in the alert's thread under the alert's face: "Retry by @who didn't work: GHL says ….
  The alert stays open; retry again once that's fixed, or press Resolve." Retry on an alert that is not a skipped step
  (an old post, a hand-made payload) is refused in words.
- **A second press is harmless.** The alert's row is locked for the press, so a double tap waits for the first and finds
  it resolved: "Already done: this alert is resolved.", privately; the step is not run again and the post is not touched.
  Retry on a step that already passed is the same.
- Either way the next tick sees a resolved alert and Health check says "✅ Resolved after …" in its thread with the ✅ on
  the post, as for any resolve. Not done: a Retry on a paused or held run (`run:<id>:paused`): its retry only wakes the run,
  so whether it worked is known a tick later; those keep the run page's Retry and Skip, and the Resolve button.
- Tests: `slack-actions.test.ts` (the door refuses a forged, stale or unsigned press and hands a signed one on after the
  response; the skipped step's post carries Retry and Resolve under the same words; a closer and a stranger are told no; a
  retry while GHL is still down says so in the thread and keeps the buttons; one after it is back writes the tag once,
  resolves the alert and settles the post; a second press is "already done"; Resolve by a manager writes who and why and
  settles the post, two presses at once resolve it once, the operator may press, another workspace is ignored, an alert
  that is not a skipped step has no Retry; a long post is cut into sections Slack takes).

## D94. Leaderboard (2026-10-12)

The owner: closers ranked by cash collected with their closes and close rate beside, setters ranked by sets with the show
rate of their sets beside; on demand as `/leaderboard`, and every Monday at 9:00 company time for the last full week, in
#ops. He reads it on a phone.

- **No new numbers.** Every figure is a registry metric split by person (D70), so the board can never disagree with the
  bot or the wrap-up: cash is `cash_collected` by closer (GHL Payment records, net of refunds, credited to the record's
  closer, D75); closes and close rate are `close_rate` by closer (closes ÷ shows, both from GHL, D73: its numerator is
  `closes` by closer, its denominator `shows` by closer); sets are `booked_set` by setter (bookings made in the period
  through a setter link, by the setter the booking source named, from the ledger: the same "setter-booked" the wrap-up
  says, D87); the show rate of sets is `show_rate` by setter (shows ÷ the setter's Sales Calls whose call time fell in the
  period and has passed, cancellations in, rescheduled slots out, nothing filed counted as not showed, D73). Test
  contacts never count (the registry's own rule).
- **Calls split by setter.** A Sales Call already carries the setter who booked it (`setter`, written by Call booked from
  the booking's `set_by`) and how it was booked (`booking_source`). The GHL call metrics (`calls_booked_due`, `shows`,
  `no_shows`, `cancellations`, `sales_dqs`, `show_rate`) now split and filter by setter: the record's setter on the roster
  (else the name as written), blank when the record says self-booked (`sales_call.booking_sources.self`; a self-booked link
  is never a set). A setter's "my show rate" in the bot is now the show rate of their sets. Close rate still cannot be
  split by setter (closes are credited to closers only).
- **Who is listed.** Only people with something in the period: a closer with cash, a close or a show; a setter with a set
  or a set call due. Nobody is "unassigned" on the board. Closers by cash, then closes, then close rate; setters by sets,
  then show rate. With no Payment records in GHL yet cash is "—" (never $0, D75) and closers rank by closes.
- **The words** (`leaderboard.ts › formatLeaderboard`, the body only, no source or period line: the caller adds its own).
  `🏆 *Leaderboard*`, then `*Closers* (by cash)` and `*Setters* (by sets)`, each a monospace block no line of which is
  wider than 34 characters (Slack on a phone wraps a code block at about that), names cut to fit (first name, the last
  initial when two share one), whole percents, money from $100k up as $123k / $1.2M; a side with nobody is
  `_No closes yet._` / `_No sets yet._`. No warnings, definitions or totals. A rate with nothing under it is left blank.
- **`/leaderboard`** takes a period in plain words like the other shortcuts; default this week. It must be added to the
  Slack app's slash commands (the same request URL as the others, `app/api/webhooks/slack/[companyId]/commands`).
- **The weekly post is a workflow** (D88): `weekly-leaderboard`, a schedule trigger (Monday 09:00, for the company), the new
  `leaderboard` step (`period`, plain words, `last week`; `into`) and a `slack_post` of `{{vars.board.body}}` with
  `_Last week · Oct 5–11_` under it, to `slack.channel.ops` (the owner's #ops; install's `slack: { ops }`), else
  `slack.channel.reports`. A step of its own rather than a `report` option: the wrap-up page and `/api/admin/reports`
  find "the workflow with a report step", which a second one would confuse.
- Tests: `leaderboard.test.ts` (the ranking, whole percents, idle people and test contacts out, a self-booked call no
  one's set, every number equal to its registry metric, the exact body and every block line within 34 characters, no
  Payment records, the slash plan defaulting to this week, the template firing Monday 9:00 and posting to ops).

## D95. Everything the bot posts is read on a phone (2026-10-12)

The owner read `/mtd` and three questions on his phone and called them hard to read: every line carried its source
("from GHL, read just now"), the comparison and a breakdown, so a number took three wrapped lines; a question's answer said
the same fact three times (a header naming the column, the model's paragraph, a wide table that wrapped into soup); rates
had decimals (33.3%) and data-quality lines nobody asked for came with every answer.

- **The answer first, once.** The model's `reply` now gives a one-line `headline` (the answer, in plain words; its numbers
  are checked against the results like the old note, sent back once, then dropped for our own answer line), a `detail`
  (none | breakdown | table | list | issues) and a `note` that is almost always empty. With a headline our answer lines are
  not repeated under it. Numbers are still only ever rendered from tool results (D70).
- **Breakdowns are counted bullets** ("• 2 — I have significant thinning…"), most first, no answer last, no names: the
  asker replies "who?" for names (list). A table only when asked ("as a table", "a chart"), and every monospace block is
  cut to 34 characters, the width Slack's phone app shows without wrapping (`PHONE_WIDTH`).
- **Only what someone has to fix** is warned about (calls with no EOD outcome, GHL vs the calendar, work-situation answers
  nobody recognised). What is off behind an analysis (missing answers, missing links, records that disagree) shows only
  when the asker asks (detail issues).
- **One footer** under everything: the period, where it was read and when ("Oct 1–12 · From GHL, read 9:16 PM EDT"), and
  who asked a shortcut. No time-zone name, no "Period:".
- **Shortcuts:** `/mtd`, `/weekly`, `/monthly` are one narrow table (number and change, "▲ 18", "▼ 17 pts", "same"; no
  change when last period had no rate), the top source, the warnings, the footer. `/closes` is grouped by closer, each
  close "name — cash collected / revenue — won day" (cash: all of that person's GHL Payment records, refunds out, "—"
  when GHL holds none; revenue: the won card's value). `/cash` and `/leads` lead with their main number, the others on one
  line, then one table. Rates are whole percents everywhere (`fmt`).
- **Wrap-ups** (D88's layout, still the workflow's words): a section can be a `table` of [label, value] rows the engine
  sets as one narrow block, a row whose value is blank left out; a `footer`; a `duration` filter (614 → "10 h 14 min").
  The shipped layout is one table (leads, MQLs, bookings, calls, shows, rates, closes, revenue, cash, dials, speed to
  lead), the calls with no EOD outcome, what they said as counted bullets, the footer.
- Event posts (a close, a payment, a setter call, an alert) were already one fact per line and are unchanged.
- Tests: `bot.test.ts` (the formatter, every shortcut, the headline kept or dropped by its numbers, the breakdown, the
  table width, issues only on request), `reports.test.ts`, `moves.test.ts`, `availability.test.ts`, `alerts.test.ts`.

## D96. The daily, weekly and monthly wrap-ups are three workflows (2026-10-13)

One Wrap-ups workflow carried all three on three schedule triggers, so its one switch and one mode covered all three:
the owner could not turn the daily off, put the weekly live alone, or word the monthly differently. His rule is one
automation per workflow.

- `daily-wrap-up`, `weekly-wrap-up`, `monthly-wrap-up`: each a schedule trigger (19:00; Monday 08:00; the 1st 08:00),
  its `report` step (kind fixed, the D95 layout with only its own headings) and its post to `slack.channel.reports`.
  `shippedLayout(kind)` words a copy with no layout by its own kind's template. The wrap-ups page lists all three;
  `POST /api/admin/reports { kind }` fires the one whose trigger is `t_<kind>`.
- **A template can take over another** (`replaces`). On install a successor starts as the old copy stood (on or off,
  its own mode) and the old copy goes off in the same transaction, with a `workflow.replaced` audit row: no gap and no
  double post. An old copy the company edited is theirs: it stays as it is and the successors install off, saying so.
- **Templates without the install file:** `installTemplates` is the template half of install, and
  `POST /api/admin/templates { company, templates? }` runs it alone (no bindings, calendars, Slack or secrets).
  Re-running the whole install to pick up a template meant keeping the whole file, secrets and all, which was lost
  with a recycled container on Oct 13.
- Tests: `install.upgrade.test.ts` (the handover, idempotent on a second run, an edited old copy left on and the
  successors off; it fails when the old copy is not turned off), `reports.test.ts`, `moves.test.ts`,
  `templates.test.ts`, `blocking.test.ts`.

## D97. The test harness never touches a real person (2026-10-13)

James's end of day listed Calvin Coates twice. One row was his real Calendly booking (Oct 12, 12:00 ET); the other a
booking the test harness staged on him on Oct 9 (source `test`, 2:00 PM the same day) during the end-to-end test. The
harness refused a real contact only while some workflow was live; Hair was in test, so it staged one, and the end of day,
the reminders and the ledger read harness bookings like any other. Every run about it was shadow (nothing reached GHL or
Calvin), but the closer saw it. Four such bookings sat on real people.

- `harnessRefusal`: a person who is not a test contact (tagged sys-test, or an email on a test domain) is refused in every
  mode, forced or not. `force` only lets a test contact be staged while the company is live.
- `clearStrayHarnessBookings` and `POST /api/admin/harness-cleanup { company, dryRun? }`: harness bookings on real people
  go, with the rehearsal runs they started (live-born runs keep their history and lose the pointer, as at go-live), audited
  as `harness.stray_cleared`. A test contact's staged bookings stay: those are the team's own rehearsal.
- Not done: filtering harness bookings out of the end of day. With the refusal there are none on real people to filter,
  and a test contact's staged booking on its closer's end of day is the point of the rehearsal.
- Tests: `flowmode.test.ts` (refused in test, shadow and forced live; a test contact staged; live needs force),
  `golive.test.ts` (the cleanup: dry run counts and names; the real run removes the booking, its run and events, keeps a
  test contact's, audits). Tests that drove agreements and payments through the harness now use test contacts.

## D98. Each client ticks on its own; the operator key changes without a pause (2026-10-13)

One minute tick worked through every company in turn under one lease. Errors were already isolated per company, but time
was shared: one slow client (GHL rate limits, a big first import) delayed every other, and at ten to twenty clients one tick
would reach the route's 300 s cap and the later clients would be skipped. Hair's tick alone already took about 55 s a minute,
with some minutes skipped as busy, with two companies. The owner wants twenty and more, where one client can never stall
another, and an operator key that can be changed without stopping anyone.

- **A company's minute is its own.** `GET /api/tick?company=<id>` (`tickCompany`, `src/engine/ticks.ts`) polls only that
  company (`pollCompany`, the per-company body of `pollAll`, which now loops over it), starts only its schedules, claims and
  runs only its runs, collects only its alerts (`collectThisTick` with `onlyCompanyId`: its poll alerts, its failed and
  blocked runs from its own cursor `alerts_cursor:<id>`, its step alerts) and announces only its own. It holds its own
  lease, `tick_lock:<id>`; a second tick for the same company answers `{ busy: true }` at once, a tick for another company
  runs beside it. Its clock is `scheduler:<id>`: `last_tick`, `ms`, where the time went (`poll_ms` per entity with `setup`
  for bindings and calendars, `schedules_ms`, `runs_ms`, `alerts_ms`), `claimed`, `completed`, `failed`, the first five
  `errors`, `recovery`. The timers are there to find which read is slow; they change nothing. Recovery after a gap (D5b)
  reads the company's own clock, falling back to the engine-wide `scheduler` the first time, so the upgrade is not taken
  for an outage; the same fallback gives a company's first alerts cursor the engine-wide one, so nothing is re-raised.
- **The engine's minute is its own too.** `GET /api/tick?scope=engine` (`tickEngine`, lease `tick_lock:engine`): the
  heartbeat `scheduler.last_tick` (what `/api/health` and the in-database watchdog read: the scheduler is alive), the
  recovery notice when the engine itself was away more than ten minutes, retention (D38), and staleness: an active company
  whose own last tick is more than five minutes old gets `engine:company_stale` on that company, resolved once it ticks
  again. An alert about the engine (no company, or an `engine:` key) goes to the operator's webhook, never through the
  company's Health check workflow, whose runs do not move while that company's ticks are stuck.
- **No parameters** (the daily sweep, a hand call, `pnpm tick`, a scheduler installed before this): every active company
  in turn through `tickCompany`, each under its own lease (a busy one is skipped and listed), then the engine's minute.
  So a deploy before the scheduler is reinstalled has no gap: the old job's single call ticks everyone as it did.
  A company tick also backs off while the old engine-wide `tick_lock` is held, so an older deployment finishing its last
  tick during a rollout never polls beside a new one.
- **The scheduler fans out in the database.** `installTickSchedule` writes one pg_cron job whose one statement fires a
  `net.http_get` per active company (`?company=<id>`) and one for `?scope=engine`, with the bearer header and a 310 s
  timeout. pg_net sends them side by side; the company list is read every minute, so a client added later is picked up
  with no reinstall. Same job name, same URL check; the status endpoint still masks the key.
- **`/api/health`** adds `companies_stale` (slug, minutes) and `ticks` (each company's last tick, `ms`, and its timings);
  `?assert=fresh` is 503 when the engine or any active company is stale. The home page shows each company's last tick.
- **Two keys during a change.** `operatorAuthorized` and the tick accept `CRON_SECRET` and, while it is set,
  `CRON_SECRET_PREVIOUS`, each compared in constant time (both sides hashed, then `timingSafeEqual`). The README has the
  steps: previous = current and a new current, redeploy, reinstall the schedule with the new key, check, remove the
  previous, redeploy.
- Not done: the pool stays at 3 per instance. A tick uses one connection at a time, so the fan-out opens about one per
  active company plus one; a poll entity holds its transaction across the vendor read, so a slow GHL read holds a pooler
  server connection that long. At twenty clients that is near the Supabase transaction pooler's default server pool
  (15 on the smallest compute), which would queue ticks behind each other in the pooler. The fix when it bites is a bigger
  pool size, or vendor reads outside the transaction; a lower pool `max` would not help. Runs of a company that is not
  active or hosted no longer advance (the old single tick claimed them though it neither polled nor scheduled for it);
  no code sets those statuses today.
- Tests: `ticks.test.ts` (company A's contacts read slow and failing while company B's tick finishes and records its clock
  and timings; A's second failure is A's alert only; one lease per company, a held lease busy and another company not, an
  older deployment's lease respected; an inactive company does not tick; a company's tick neither raises nor announces
  another's alerts and keeps its own cursor; a company's own gap is its recovery; the engine's minute raises and resolves
  `engine:company_stale`; the no-parameter tick skips a company whose lease is held and ticks the others; the scheduler's
  statement, run against a stub `net.http_get` inside a rolled-back transaction, fires one request per active company plus
  the engine and none for an archived one), `admin-auth.test.ts` (the previous key only while it is set; a wrong key
  refused). Breaking the per-company lease (a random key per tick) turned the lease and no-parameter tests red.

## D99. An unchanged card costs nothing (2026-10-13)

The first per-company timings (D98) showed Hair's minute at about 43 s, 33 s of it the cards poll: every card on every bound
board went through `foldCard` every minute, which takes the contact's card lock and reads the user, the replica row and the
contact (four round trips) before deciding the card had not changed. Hair's boards hold enough cards to fill the minute.

- `pollCards` reads, per board, what the replica knows about the board's cards (their last-seen time) and which person each
  GHL contact is, in two queries, then skips a card whose GHL snapshot is older than the engine's last look, and an unknown
  card that is not open. Those are `foldCard`'s own rules, applied first; the last-seen time only grows, so a skipped card is
  one `foldCard` would also have left alone. A card that may have changed still goes through `foldCard` under its lock.
- Test: `cards.poll.test.ts` (50 unchanged cards: under 10 queries, 104 before; one moved card is still a hand move).

## D100. Operator tools for onboarding: a company's whole workflow, and a shared key (2026-10-13)

A company's copy of a workflow could only be changed one step field at a time (`saveStepEdit`, `saveCopy`). Onboarding a
client whose sales process differs from the template (one pipeline instead of two, extra stages) needs steps added and
removed in that company's copy, and nothing did that short of writing rows by hand. And the owner wants some keys shared
between companies for now without the value passing through chat.

- **A whole definition, saved for one company.** `saveDefinition` (`src/engine/definitions.ts`) and
  `POST /api/admin/workflows/definition { company, workflow, definition, note, by?, dryRun? }`; `workflow` is the copy's
  id, its template's slug, or its exact name. The checks are the ones a step edit and the shipped templates already pass,
  every failure listed (422 with `problems`): the schema and the definition's own rules (a known step type, edges between
  nodes that exist, a trigger and an exit), every `{{placeholder}}` root one the engine knows, each message's words as a
  copy edit checks them, every wait offset as a step edit checks one, a reentry window that is a length of time, events
  the engine knows (triggers, waits, records) and classifier options that exist. A hand-off to a workflow the company does
  not have is a warning, not a refusal. Saved: a new `workflow_versions` row (version + 1, the note, the manifest from
  `extractManifest`), `current_version` moved, `diverged` (template upgrades leave it alone, D16), triggers re-synced
  (`syncTriggers`: a kept trigger keeps its row), `reentry_policy`/`reentry_window` from the definition, and a
  `workflow.definition_saved` audit row (by, note, from and to version, the diff). Runs in flight keep the version they
  started on. `dryRun` validates and returns the diff (nodes added, removed, changed by id; edges added and removed;
  top-level settings changed) without saving; the same definition again is no new version. `GET` with `?company=&workflow=`
  returns the current definition and version, so an operator fetches, edits and saves.
- **Missing bindings are a warning while the workflow is off, a refusal while it is on.** Saved off, the response lists
  `missing` and readiness already refuses turning it on until they are bound; that is how onboarding goes (the steps first,
  the ids after). Saving into a workflow that is on would leave it running without what its steps read, so that is 409
  with `missing`, the same rule as turning one on.
- **A shared key, inside the engine.** `copySecretBindings` (`src/engine/binding-copy.ts`) and
  `POST /api/admin/bindings/copy { from, to, keys, by? }`: each key read and decrypted on `from`, encrypted and upserted on
  `to` with the same kind. Only `secret.*` keys (plain bindings are set by install); a key `from` does not have refuses the
  whole call; the response says per key `new`, `same` or `replaced`, never the value. A replaced vendor token wakes the
  target's runs paused on that vendor's auth, as install does (D66). The target company gets a `binding.copied` audit row
  with the keys and the source slug.
- Not done: no dashboard screen for either; the definition is JSON in, JSON out. Placeholder paths are checked by their
  root only (what lies under `contact.` depends on the data), as for the shipped templates. A copied key is a copy: a later
  change on one company does not follow to the other. Only the AI keys (`secret.anthropic_key`, `secret.jev_key`) copy: a
  CRM token, a booking, recording or payments key, a webhook signing secret is one client's own account, and a copy would
  point one client's engine at another's (refused, 400).
- Tests: `definitions.test.ts` (every shipped template passes the check; a restructured copy, one node removed, two added,
  edges rewired, is a new version, diverged, its triggers re-synced, audited, a run in flight still on its version, GET
  returns it; a definition with an unknown step type, an edge to a missing node and an unknown path is refused with all
  three and nothing changes, as is one with an unknown event and a bad wait; dryRun changes nothing; the other company's
  copy is untouched; a later template upgrade leaves the diverged copy alone and upgrades the untouched one; a workflow
  that is on is not saved into a missing binding), `binding-copy.test.ts` (the target decrypts to the same value, stored
  encrypted; the response and the audit carry no value; a missing key and a plain key refused, nothing written).
  Dropping `diverged` from the save turned two red; storing the copy unencrypted turned two red.

## D101. A calendar can be the company's own call type (2026-10-13)

PMU books a "Demo call" for applicants under $4k a month: a sales call for the smaller product that Carly must know is
one before she dials in. Install mapped a calendar only to a core category's default type (Closing call, First call…).
`calendars: { <id>: { term: "closing", name: "Demo call" } }` now makes (once, by name) the company's own call type under
that category and maps the calendar to it; without `name` the default type as before. The type names the booking
everywhere it is shown; the Sales Call's own Call Type field (Closing / Demo) is what PMU's numbers split on.
Test: `install.upgrade.test.ts` (made once over two installs, default type untouched, back to the default when unmapped).

## D102. A recording finds its booking by the meeting link (2026-10-13)

PMU's Fathom recordings often carry no external invitee (only Carly, the closer), and Carly's calls sit close together, so
the closer's-calendar rung saw two bookings near the start and left the recording unlinked. The meeting link was the same
on both sides all along: Fathom reports the call's join link (`meeting_url`), and the booking carries the link it was
booked with (Calendly `location.join_url`, a GHL appointment's `address`).

- **A key, not the link.** `meetingKey(url)` (`recordings.ts`): a Zoom meeting id from `/j/<digits>` (any Zoom host, so
  `us06web.zoom.us` and `zoom.us` agree), a Google Meet code, otherwise host and path without the query (a password or a
  tracking parameter is not the meeting). Anything that is not an http(s) link (a street address, a phone number) is no
  key. Used on both sides.
- **Kept on the appointment only.** `appointments.meeting_key` (migration: `alter table appointments add column if not
  exists meeting_key text` and a partial index on `(company_id, meeting_key)`), written by the poll's upsert; an existing
  booking gets it, or a changed one (a Calendly reschedule is a new meeting), without an event. The recording's link is
  read at receipt and not stored: nothing re-runs the ladder later.
- **The rung.** Email, then **meeting link**, then name, then the closer's calendar. It is exact when exactly one live
  (not cancelled) booking of the company has the key and it starts within a day of the recording: `linked_by: meeting`,
  that booking's person and appointment. A key several bookings share (a closer's personal meeting room) says nothing and
  the next rungs decide; an unlinked reason then adds "its meeting link is on N bookings". An email hit stays first, and
  when that person has one booking with the recording's key, that is the appointment rather than merely the nearest.
- **Impromptu calls are unchanged.** A closer whose booked link failed and who starts an "Impromptu Zoom Meeting" has
  another meeting id: no booking has it, and the calendar rung finds the call as before.
- `recording.matched_by` carries `meeting`; no dashboard or Slack copy words the match today (the field is passed as is).
- Not done: `fathom/01-api-facts.md` does not list `meeting_url` among the verified payload fields; it is read when the
  payload carries it (the Zap door takes `meeting_url` too). Bookings polled before this get their key on the next poll that sees them (the poll window is two
  days back to sixty ahead).
- Tests: `recordings.test.ts` (no attendee but the closer, two calls 30 minutes apart: the Zoom link names the second;
  one link on two bookings falls through to the calendar, and the unlinked reason says so; an email hit takes that
  contact's booking with the link, not merely the nearest; an impromptu meeting with another link still links by the
  calendar; a cancelled booking's link or one days away says nothing; a Calendly booking keeps its `location.join_url`
  as the key and a new link replaces it without an event; a GHL address that is a link is kept, a street address is no
  key; the key itself; Fathom's and the Zap's `meeting_url` are read). Removing the rung, taking the first of several
  bookings with the key, and ignoring the key on an email hit each turned one test red.

## D103. A sometimes-step looks like one on the chart (2026-10-13)

Tyler read PMU's Call booked chart and took "A reschedule: card → Rescheduled", sitting in the straight line after
"Card → Booked Call", for a step every booking takes. A step with `only_if` looked exactly like one that always runs;
its condition was only in the popover, and a non-send `only_if` step did not even get the blue mark.

- **On the chart.** A node with `only_if` has a dashed blue border and its condition on a line of its own under the
  title: "only if a reschedule", "only if not a reschedule" (`ChartNode.onlyIf`, the predicate's words with a leading
  "this is" dropped); in a narrow column "if …", cut with … past that, the whole sentence in the popover, which now
  ends "Otherwise it is skipped and the run goes on." The edges into and out of it are dashed, and on the spine, where
  there is room, a thin blue line runs around its right side labelled "otherwise". A branch folded into one step
  ("Only when …") is drawn the same way. A wait with `only_if` is no longer folded into the send after it, so its
  condition is not put on the send. A step skipped for a smaller reason (a reminder too close to the call, a card move
  with no card, a Slack line with no post) keeps the blue mark: it runs on the normal path. The legend says both.
- **In the step list.** A planned step with `only_if` says "only if a reschedule; otherwise skipped" under its title.
- **The words.** Every `only_if` in the templates and PMU's copies was read through `predicateWords`: "there is a slot
  from" is "there is a slot the call moved from"; two-path comparisons ("{{a}}:{{b}}" against "{{c}}:{{d}}") read pair
  by pair instead of leaking `| default:}}`; an hour through `| date:HH` reads "the call is at 9 AM or later"; the event
  types read "a Fathom recording", "a payment", "a refund"; "the earlier answer", "their unanswered reply", "who decided
  the result is the team", and a/an before a vowel.
- **Why a step was skipped.** The run log said "only if this is not a reschedule; it is not" on a reschedule: "it is
  not" after a "not" condition says the opposite. `skippedWords` gives the condition and then what held instead
  (`notWords`: eq↔neq, exists → "there is no", in → "neither … nor", the comparisons flipped, and/or by De Morgan);
  for an "and" the executor names only the parts that failed ("…; the result is not follow up"). Rows written before
  this read right on the run page: the step list rewords a stored "…; it is not" from the step's own condition.
- Display only: what runs and when is unchanged; no template changed.
- Tests: `words.test.ts` (PMU's two card moves carry "a reschedule" and "not a reschedule", only `only_if` nodes carry
  one, a card move with no card keeps the mark only; the reschedule, slot, hour, payment and two-path words; no shipped
  `only_if` reads with a path, a filter or JSON; the skipped words for eq, neq, exists, in, not, an hour and an "and";
  a planned step carries its condition and an old "it is not" row is reworded), `moves.test.ts` (Payment recorded's
  win skipped on a deposit says "only if this is a payment and paid in full; not paid in full").

## D104. The booking card's intake lines are the company's own (2026-10-13)

Call booked's Slack card carried Hair's intake questions in the template itself (Hair loss with its stage, Noticing for,
Commit to routine, Work situation), so every client installed after Hair inherited them: PMU, a beauty salon, saw "Hair
loss" on its booking card. The owner: fix the template so each company shows its own intake questions, and Hair's card
must come out exactly as it does today.

- **A company setting.** `booking_card.intake` (kind text, JSON), set at install with
  `bookingCard: { intake: [{ label, field | answer | tags, plus? }] }`: each line a label and where its value comes from, a CRM
  contact field by the name the company bound it under (`field`: `crm.field_contact_<name>`) or a booking answer by the
  name its calendar maps the question to (`answer`: `appointment.answers.<name>`, D24); `plus` is a second value from the
  same place after one space; `tags` maps tags to words (PMU's MQL / DQ, set by a Zap, is tags, not a field). Omitted on a re-install it stays as it is; `[]` is no lines. A line with no label, or without
  exactly one of field, answer or tags, refuses the install. The Setup page shows the lines under Booking (read-only, D42).
- **One value for templates.** `{{contact.intake_lines}}`, built in `buildContext`: `*Label:* value` per line, `—` for an
  empty value, the lines joined by newlines; nothing when no line is set. The shipped card has `*Phone:* …` (generic, kept)
  followed by `{{contact.intake_lines | line}}`, so an unset company gets no intake lines and no blank line, never Hair's.
  The lines are written to match the old fixed lines byte for byte, including the space Hair's line always had before
  its stage (an empty stage leaves `*Hair loss:* — `).
- **Hair keeps its card.** Every company that bound `crm.field_contact_hair_loss` (Hair) gets the four old lines as its
  setting where the setting was never written (`backfillBookingCard`, audited as `binding.set` by "D104 backfill"). It
  runs in the migration (`pnpm build` runs it before a deploy serves; `POST /api/admin/migrate`) and again at the start of
  every template install, so it can never land after Hair's untouched Call booked copy upgrades on the next
  `POST /api/admin/templates`. A company that edited its copy (diverged, D16) keeps its own card, as before.
- **The dashboard's example** of the card shows the company's own labels with a placeholder for each value
  (`*Monthly revenue:* [monthly revenue]`), and no lines when none are set; the sample contact no longer carries a hair
  answer.
- Not done: PMU's own lines. Its copy of Call booked is its own (D100) and still has Hair's lines until it is saved again
  from the regenerated `installs/pmu/call-booked.json`, which reads the setting; PMU's questions are its to name. Other
  Hair words left in shipped text are listed for the owner, not changed here: Deal closed's welcome email and text (an open
  item already), the bot's examples of questions about hair loss, the example call notes ("thinning at the crown").
- Tests: `booking-card.test.ts` (Hair as production has it, an untouched old copy and no setting, renders three people
  through the old card; `installTemplates` backfills and upgrades; the new card renders byte-identical for all three; the
  migration backfills only a company that bound the field and never over a written setting; a company with "Monthly
  revenue" (an answer) and "Ad budget" (a field) gets those lines; unset, no intake lines and nothing of Hair's; install
  writes, refuses and keeps the setting; the example). Dropping "Commit to routine" from the backfilled lines turned the
  identity test red.

## D105. A card moves only off the stages a step names; an existing card keeps its name (2026-10-13)

PMU reschedules calls that were booked before the engine ran it: their cards were made by PMU's own GHL workflows and
sit anywhere on the board. Tyler: find the existing card and move it to Rescheduled only if it is on a stage a
reschedule belongs to; a card in Follow Up (or past the call) is left alone. A branch before the step cannot decide
this: the replica holds a board's older cards only once a step has read them (the poll sees what changed since install),
so the decision is made inside `pipeline_card`, on the card the CRM just answered with (D41).
- `from_stages: [stage ids]`: an existing card on any other stage is left where it is (skipped, the run goes on, the log
  names the stage). No card at all: the step makes one, as before.
- `keep_name: true`: an existing card keeps its name (it says how the call was booked, "-- Setter" / "-- Direct"); `name`
  names only a card this step makes.
- Test: `step-failures.test.ts` "D105" (an older card the replica never saw on an allowed stage is moved with its name;
  a card in follow up is not written; no card makes one under the step's name).

## D106. A Slack step's channel is picked in the step, from the company's own workspace (2026-10-13)

Tyler: "in the daily workflow, in the slack step, i want to be able to select which channel it goes into", from that
company's channels only, to put the daily, weekly and monthly wrap-ups live in the right place. The company page's
"settings" link still pointed at the Next page D42 removed (`/c/<slug>/settings`, a 404); it now opens
`/app/c/<slug>/setup`, which stays read-only (D42). A first cut listed every Slack post on Setup; Tyler found it too much
and wanted it where the step is, so it lives only in the step's popup on the workflow page: where the step posts today
(`#name`, through a company setting, picked on the step, or a setting's fallback; "nowhere, skipped" when nothing
resolves), whether the bot is in that channel (without `chat:write.public` a post to a channel it is not in fails), and a
picker of the company's channels. A pick is a literal channel id on that step of the company's copy (`saveStepEdit`: a
new version, diverged, so template upgrades leave that workflow alone and say so); the first option puts the template's
binding back. The server refuses a channel the company's own bot cannot list, so a pick can never name another
company's channel. Thread replies, DMs and answers in the asking channel say where they go and have no picker. Channels
are listed public and private; a bot without `groups:read` gets the public ones.
`GET|POST /api/v1/workflows/<id>/slack-channel` (`{ node, channel | "default" }`). Test: `src/api/slack-steps.test.ts`.

## D107. The chart draws every step: a fork inside a fork gets its own groups (2026-10-14)

Tyler, reading PMU's Call booked on its workflow page, saw the chart end at two "A new booking or a reschedule?" forks:
no card moves, no tags, no Slack card, no Done. The chart is the only way he sees a workflow, to update it, so it has to
be exactly how the workflow runs. The layout walked each way out of a fork only while a step had exactly one way out, so a
fork inside a fork's group ended the group there, and everything after it (the inner fork's ways, where they rejoined,
and every step after the outer fork's join) was never drawn. It was not only PMU's copy: run against every shipped
template and PMU copy (PMU's Call booked as it was that day), the old layout left steps out of 11 charts, among them Setter call logged (12 of 44 drawn), Call
outcome (2 of 30: its two triggers start in different places, so nothing after the triggers was drawn, on Hair's live
chart too), Pre-call sequence (the team's keep / cancel / reschedule fork), Call recorded (the "which booking" fork),
Speed to lead, the Daily EOD reminder and the health check.
- **Groups are drawn like the spine.** A group's content is rows again (steps and forks), so a fork inside a branch draws
  its own labelled groups inside that branch; the inner ways rejoin inside the group and the group goes on to the outer
  join on the spine. The join is the step the most ways reach first, so a cross-link (the team's ✅ going to the
  confirmed steps) is not taken for the join. A way that leaves its group for a step drawn elsewhere (the reminders that
  go on, a loop back to where the run was) ends in a short arrow, "on to “3 days before the call”". The width a group
  needs comes from what is inside it; groups that do not fit side by side stack in one column as before, and a stacked
  card is as wide as its content wants. The lines of a fork that ends a group meet inside the card and leave by its
  bottom; a short group's line drops straight before it curves in, so it never crosses a taller neighbour. A node in a
  narrow column gives its logo's room to the words and may run to six lines; a title or label that is still cut ends in …
- **Starts.** Triggers that share a first step sit side by side over it, as before. A trigger whose first step another
  start reaches anyway is drawn where it comes in (Call outcome's "Appointment no-show" at the top of the no-show group,
  the way in passing beside it). Starts that only meet further down (the EOD reminder's evening and morning runs) or
  never (the health check's hourly run and its alerts) stand side by side, each over its own steps.
- **Nothing is dropped silently.** Past four forks deep a fork's steps are listed in order in a dashed card; a visible step
  the walk never reaches is listed at the bottom under "More steps (not placed on the chart)". Neither happens for any
  shipped template or PMU copy. An exit no edge leads to is not drawn (the EOD reminder's check stops the run with its
  own `else_exit`, and its words say so).
- Kept as they were: a branch folded into its one conditional step, a wait folded into the send after it, the reply-wait
  fork's "No reply", groups that end at an exit, D103's dashed sometimes-steps and "otherwise", run badges, the phone's
  path-only view (now at every level).
- The layout moved out of the drawing into `dashboard/src/ui/arrange.ts` (pure), so it is tested without a browser.
  `pnpm exec tsx scripts/render-charts.ts --out <dir> [name …]` shoots charts with the real component in Chromium at
  desktop and phone width (a template slug, `pmu/<file>`, or `nested`: PMU's Call booked with its card fork inside each
  booking path, the shape Tyler saw).
- Tests: `src/api/chart-layout.test.ts`. For every shipped template and PMU copy: every visible step placed exactly once,
  no "More steps", every place the drawing stops is an exit, a step with no way on or an arrow on; and the connections
  the layout draws equal the workflow's own edges (consecutive steps, a fork to each group, each group that goes on to
  the join, the arrows, folds), so the order and every join are the workflow's. A fork inside each branch of a fork with
  steps after the outer join, in order; setter-call-logged fully placed with its tap fork two forks deep; Call outcome's
  entry trigger; the side-by-side starts; the unreached step and the depth limit. The "every step placed" test failed on
  the old layout for the 11 charts above.

## D108. The end-of-day workflows say what they do; a copy's name follows its template (2026-10-14)

Tyler could not tell the three end-of-day workflows apart, and "Sales Call filed from the end-of-day form", with a paragraph
under it and a trigger reading "An end-of-day answer for a Sales Call booked before the engine", told him nothing at a
glance. They are now "EOD: remind closers to file", "EOD: post the closer's day" and "EOD: results for calls booked before
the switch-over", each with one sentence under it; the triggers read "A closer filed their end-of-day form" and "A closer
filed a call booked before the switch-over". The detail the old descriptions carried is in D76, D77 and D88.
- A company's copy that was edited kept its old name on every install. Nothing renames a company's copy, so that only
  stranded old names (PMU's edited "Sales Call filed…" would never have changed): the name now follows the template on every
  install, edited or not; the steps of an edited copy stay its own as before.
- Test: `install.upgrade.test.ts` (an edited copy with an old name takes the template's name on install; its steps stay).

## D109. One plain setting set from outside, as the Settings page would (2026-10-14)

Tyler asked for Hair's health check, ledger drift and calendar availability to post into #sales-ops. They post through the
company's alerts channel (`alerts.slack_channel`), a setting; the only ways to change one were the Settings page or a whole
re-install, and Hair's install data is not a file. `POST /api/admin/bindings/set { company, key, value, by? }` sets one
setting the company's workflows or the engine read, as the Settings page does (same audit row), and answers with the value
it replaced so the change can be undone. Secrets are refused (install sets them; D100 copies the shared AI keys); so is a
key nothing reads and an empty value.
- Test: `binding-set.test.ts`.

## D110. The end-of-day form is the engine's bookings only (2026-10-14)

D77 put a closer's GHL Sales Calls with no engine booking (calls booked before the engine was installed) on the
end-of-day form as their own rows; filing one was an `eod.call_filed` event, and the "EOD: results for calls booked before
the switch-over" workflow (`eod-call-filed`, D88 A3) wrote the answer onto that record by its id. Tyler: "remove that one
entirely. We are running in ghost mode, so we should have everything in the engine." The engine polls bookings from
install on, shadow included, so every call a closer takes is a booking it has; a workflow for a passing edge case, with a
trigger that is not "whenever X happens, do Y", is not wanted.
- Gone: the `eod-call-filed` template and PMU's copy (`installs/pmu/build.py` no longer builds it); the form's `ghl:<record>`
  rows and `record_id`; the filing path that emitted `eod.call_filed`; the event type (its label, its seed in
  `engine/schema.sql`). A form opened before this that still sends a `ghl:` row has that row dropped before anything is
  stored. `migrate` deletes the `eod.call_filed` row from `event_types` once no event and no trigger points at it; events
  already in the journal stay as history and keep the row with them, and while it stays nothing offers it as a start
  (the Health page's list of starts) or accepts it in a definition (`RETIRED_EVENTS`). Company copies of the workflow are
  deleted through the admin DELETE after deploy; until then a copy is harmless (nothing emits its event).
- The end-of-day reminder (`eod_due`) counts only Sales Calls that are the engine's bookings (one we wrote, one carrying a
  booking's id or slot, or the person's booking that same minute). D76 and D82 stand for those: GHL is the truth, a booking
  filed there is answered whatever the ledger holds, and one still blank there is owed and, two days on, told to the
  operator. A Sales Call with no booking is neither a row nor counted.
- Stays: ledger drift and the metrics still read GHL's Sales Call records, every one of them, for the numbers and the drift
  questions (D73, D83); the Ledger drift workflow still writes records by id.
- D108 named three end-of-day workflows; the third is gone.
- Tests: `eod.test.ts` (the form lists only the engine's bookings and drops a stale `ghl:` row, nothing written; the
  reminder counts a booking blank in GHL and not a record with no booking; migrate drops the event type only once nothing
  points at it, and while it stays it is offered nowhere).

## D111. The chart is exactly the workflow, or it says so (2026-10-14)

Tyler: "It's really important that the workflow is clear and accurate, exactly how the workflow works, because I need to be
able to see it visually to update it ... I'm going to be adding a lot of workflows, and they all need to be 100% accurate to
what they actually do. When a chart can't be drawn exactly we need a way to draw the chart exactly." D107 proved the tidy
layout exact for the shipped templates and PMU's copies in a test; a workflow built after that was checked nowhere, and the
chart still left steps out on purpose (Jev's read of a reply, every `set_var`) and folded others into their neighbours.
- **One check** (`src/chart/exact.ts`, shared by the dashboard and the server). A drawing is its boxes and its lines, each
  line with its words and whether it is an otherwise. It is exact when every step that can run is drawn exactly once, every
  line drawn is an edge of the definition (same from, same to, same words, same otherwise-ness), every edge is drawn, and
  nothing else is. The tidy layout's lines are read off its rows (consecutive steps, a fork to each group under its
  heading, a group that carries on to the join, an arrow "on to …", an entry trigger, a folded branch); an arrow names its
  step by title, so a title two drawn steps share is a problem. Steps listed in a "More steps" or "Too deep" card are never
  exact. The one node not drawn is an exit no edge touches: it never runs (a check's `else_exit` stops the run itself).
- **Nothing hidden.** Every step that runs is on the chart. A helper (a wait, Jev reading, a lookup, a value remembered)
  is a small grey step: smaller words, `--panel` fill, the engine's mark on a remembered value; the legend says "behind the
  scenes". Waits are no longer folded into the send after them, and the reply-wait is its own fork ("They replied" on to
  Jev's read and the reply fork; "No reply in time"), not a third way out of the reply fork. A two-way branch around one
  step stays folded into that step (D103's dashed step, "only if …", otherwise skipped) only when that says everything: the
  step is reached from nowhere else, has no condition of its own, its one way on is where the otherwise goes, and the
  otherwise way has no words of its own; the check holds the step's blue line to the branch's words. Otherwise the branch is
  drawn. A run's chart badges the remembered values from the run's own rows.
- **The order of resort**, the same on the workflow page, the run page and the server (`src/chart/pick.ts`): the tidy
  layout if exact; else a plain graph (elkjs 0.12.0, ELK's layered algorithm, top to bottom, orthogonal lines, cycles
  broken depth-first from the triggers so a loop back is a line running up with its arrow) if exact; else every step listed
  in the order a run meets it, each with where it goes and on what, under an orange-red line "This workflow could not be
  drawn exactly as a chart". The graph is drawn with the tidy chart's own nodes (logos, helpers, dashed sometimes-steps,
  run badges and dimming), every edge a line with an arrowhead and its words (an otherwise's in blue, lines into or out of
  a sometimes-step dashed), under "Drawn as a plain graph: this workflow's shape is beyond the tidy chart." The graph check
  also requires each line to start on its own step's box and end on its own step's box. The graph is loaded only when
  needed. On a phone it is laid out with narrower boxes and scaled to the width; below 60% it keeps 60% and pans inside its
  own box (the page itself never scrolls sideways), opened at the trigger, with "Drag it sideways to see all of it." The
  phone's path-only view stays for the tidy layout; the graph is drawn whole.
- **Checked on save.** `saveDefinition`, a step edit, a copy edit and a template install compute the layout (ELK runs on
  the server too, only when the tidy layout is not exact). Refused (422 with every problem; a template is reported
  "refused" and not installed) only when neither layout is exact; a save says `layout: "tidy" | "graph"`. No real
  definition reaches the refusal: the graph draws any directed graph; the refusal is tested with a stand-in verdict.
- **Checked daily.** The health sweep's `charts` check holds every enabled workflow to it once a day, and again as soon as
  a workflow is turned on or saved (the stamp carries each workflow's version); in between the last findings stand, so an
  alert is not resolved by an hour that did not look. A workflow no layout draws exactly is an error alert
  (`health:charts:<workflow>`, posted like every health finding, its Open link the workflow page) that resolves when a
  later check draws it.
- **Checked on the drawing itself, in every view.** Tyler opened Hair's Health check on the live dashboard with its hourly
  run selected and saw the four triggers and nothing under them, while the placement test said every step was placed:
  the drawing he saw came from the layout before D107 (its SVG for that view, kept as
  `src/chart/fixtures/health-check-hourly.before-d107.svg`, has exactly those four nodes; main's own code draws all of
  them, so the live site was serving an older build). A check of the layout's rows cannot see what happens between the
  rows and the picture, so the check reads the SVG: the drawing (`src/chart/draw.ts`, pure, shared by the page, the
  server and the tests) marks every node (`data-id`, and `data-also` for a branch drawn as its step) and every line that
  stands for a way (`data-ways`: from, to, words, otherwise; the line's end is filled in only when the drawing reaches
  the step it goes to, so a line to nowhere is a problem), and `svgDrawing` reads them back. The page, the save and the
  sweep all use it; the save and the sweep check a laptop's width and a phone's. Every view the page draws is tested:
  no run, a run down every way each step can go, 1000px and 358px, and a run's path alone.
- **A run's path alone says so.** On a phone with a run, the groups the run did not take are left out, as before, but
  the SVG carries `data-filtered` and the page says "Showing only the path this run took. Show every step" above it; the
  check holds such a view to drawing only real steps and ways (and the run's whole path), and the same view with nothing
  left out to being exact. On a laptop nothing is ever left out: steps the run did not reach are dimmed.
- **Ways that are not edges are drawn too** (`src/chart/implicit.ts`, read off executor.ts and runner.ts; `chartOf` adds
  them, so both layouts and the check use them). A check whose condition stays false: "otherwise" (with a retry,
  "otherwise, after looking for up to 1 hour") to an end "Stop: …" in the exit's words, or "Paused for a person: …" with
  `else_pause` (Daily EOD reminder's check ends at its own "Stop: nothing to file"; its exit step of that reason, which
  nothing leads to, still never runs and is not drawn). A branch with no otherwise way: "none of these" → "Paused for a person: no
  way matched". A reply wait with no timeout way: "no reply in time" → "Done: no reply". A send with `on_stale: escalate`:
  "out of date" → "Paused for a person: the message is out of date". A hand-off (`start_workflow`): one line to
  "Hands off to “…”"; its own edges, like an exit's, are never taken and not drawn. `resume`: one line to the first step
  of the non-blocking listener's onward way, "back to the step the run was on: “3 days before the call” or one after it"
  (the run goes back to whichever step it was parked on there: a wait, a send held for the window, a held step, the exit
  it reached with the listener armed); the resume's own plain edge to that same step is that line. In the tidy layout
  a step whose other ways only end the run keeps its place in the line and its ends hang off its side, the words over a
  short line; a way on with words of its own (the resume's) says them beside its line, its arrow, or under its group.
  The run page lights the end a run stopped or paused at.
- Not lines, and why: a check's `retry` stays on the step; a send skipped as stale, out of its validity or with SMS off,
  an `only_if` skip, a Slack post with nothing to post to go on by the normal edge; a vendor's refusal retries, then
  holds or pauses the run wherever it is (D66/D77); the premise check and a contact gone from the CRM end a run moot before
  any step. A step with no way on and an event wait with no way for an outcome are refused by the definition, so never
  drawn.
- Tests: `src/chart/chart-layout.test.ts` (every shipped template and PMU copy exact in the tidy layout with every node
  drawn; helpers drawn; the fold kept only when exact, and caught when its condition is not the branch's; the check catches
  a dropped step, a doubled one, a line that is no edge and wrong words; a definition with a cross-link into the middle of
  another branch, a loop back, five deep and an unreached step: tidy not exact, ELK exact with every node and edge, the
  loop running up, no boxes overlapping; the cross-link and loop alone drawn tidily as arrows; a misrouted line caught),
  `src/chart/chart-views.test.ts` (Tyler's view of Health check on a laptop and a phone, every step drawn; the run's
  path alone, said; the drawing before D107 fails the check; a node or a line taken out of the SVG is caught; every shipped
  template and PMU copy exact with no run and every run it can show, at both widths, and its path alone; the graph with
  a run),   `src/chart/implicit.test.ts` (each way that is not an edge: on the chart, exact in the tidy layout, and a drawing
  without it caught; in the graph too; the two the definition refuses),
  `src/engine/chart-exact.test.ts` (saves report the layout; the 422, the step and copy edit refusals and the install
  refusal with a stand-in verdict; the sweep's daily stamp, alert and resolution).
  `scripts/render-charts.ts` shoots `messy`, that definition, in the graph.

## D112. The chart's words come from the step; titles are labels; each step shows who went through it (2026-10-14)

Tyler: the chart is his only view of what a workflow does, and he has to be able to trust it. A step with a `title`
showed that typed text instead of what it does: PMU's "Card → Rescheduled, if it is before the call (its name stays)"
would go on saying so after someone changed the step's `from_stages`. And nothing on the chart said whether a step had
ever run.
- **Generated words.** A node's main line is always made from its type and settings (`shortTitle` / `generic` in
  `src/api/words.ts`, over `describe.ts`); a `title` rides along as `label`, drawn small above the words and at the
  top of the popover. A task's `title` is the task itself and stays in the words. Each kind says the facts that matter at
  a glance: a card move its board and stage in a chip (by the CRM's names, below), then
  "marked lost", "only from New Lead, Booked Call, Unresponsive - Call Unconfirmed, …" (every one), "only if there is a card", "named [full name] --
  Direct/Setter" (a var that only ever holds a few literals is written as them) or "keeps its name", "owner: the
  closer"; a CRM record "Update/Write the Sales Call record", "for the slot the call moved from", the values that matter
  ("outcome = rescheduled", "sets outcome and disposition"), "+8 more fields", "empties 6 fields"; a Slack post what
  it posts (the name it posts as, else its bold opening, else its first clause) and where ("in the thread of the
  booking post", "to the bookings channel", "DM to the closer"), what it reacts and offers; email "Email: <subject>";
  "Update the contact · owner: the closer, appointment date"; "Task for the closer: … · due in 1 day"; Jev by the
  answers it picks from ("Jev: set, follow up, DQ or not interested?"); lookups, logs, opportunities, outcomes, set_var
  ("Remember …") and every end by its reason ("Done: they replied"). Facts are drawn on their own smaller lines under
  the main line so they wrap instead of being cut. `pathWords` learned the binding families (`crm.stage_*` → "No Show",
  `crm.pipeline_*` → "closer board", `crm.field_*`, `slack.channel.*` → "the bookings channel", `picklist.*` → the
  option), and "there are no later parts already in" for a count against 0. Every node of every shipped template and
  PMU copy was read; none shows a binding, an id or JSON (a test holds it). The run feed's step rows use the same words.
- **The CRM's own names, every one listed.** Boards, stages, contact and card fields and custom objects are worded by the
  names GHL gives them ("Beauty Moguls → Booked Call", not our key's "Closer → Scheduled"): one read of the company's
  pipelines, custom fields and objects (`ghlCatalog`), kept ten minutes in memory per company (a failed read one minute),
  on the workflow page, the run page and the run lists (`crmNamer` in `src/api/crm-names-read.ts`, a pure `namer` in
  `crm-names.ts`). When GHL cannot be read, or the id is not on it, our key words stand in, marked "(name not read from
  GHL)", never passed off as GHL's. A list that decides what a step does is never cut: every stage in `from_stages`
  is on the node (its fact lines wrap and the node grows), and the popover lists every field a record or a card step
  writes. D105's run-log reason ("the card is on …", worded from the key when the step ran) is shown with GHL's name for
  the stage it stores. Not named from the CRM: a Sales Call's own properties (outcome, disposition: the object's keys),
  calendars (no step words them), and stages inside a hand-written edge label or an only_if predicate; the
  `card.moved` event's stage words in Slack still come from the binding keys.
- **Helper steps read plainly too, and no two steps share a main line.** A remembered value (`set_var`, drawn since
  D111) says what is kept and each case in words: "Remember the setter line: ‘Setter: [setter]’", "Remember the
  Slack card's look · ‘Call rescheduled’ 🔁 if this is a reschedule, otherwise ‘New call booked’ …", "Remember what the
  team decided · by the tap; ✅ → ‘confirmed’; …"; never JSON, Slack's `*bold*` or a path. The chart's arrow "on to
  “…”" names a step by its main line, so steps of one workflow that would read the same are told apart by the first
  thing that differs: their first fact, the wait before them ("Text, 3 days before the call"), the way into them
  ("Text, when the call is at 11am or later"), the step before them when that settles all of them; else "(2nd time)".
  A wait, drawn as its own step since D111, says it waits ("Wait until 3 days before the call", "Wait 2 days"). The
  label line, fact lines and count pill are drawn by `src/chart/draw.ts` with every node, so D111's check reads them too.
- **What starts a workflow, in plain words.** Tyler could not tell Health check's starts apart. The event words say what
  happens: "An alert is raised: something broke", "An alert is still open (said again every hour until it is fixed)"
  (the company's `alerts.repeat_minutes`, 60 unless set), "An alert is fixed (cleared)"; the hourly run's step names
  what it checks ("the GHL token, GHL calendars bookable, …, links in messages (each where the company uses it)").
  Other vague or jargon labels were reworded the same way ("A new lead is added in GHL", "The call's outcome is filed",
  "They replied (text or email)", "Someone moved a card by hand in GHL", "A deal was won").
- **Who went through it.** The workflow page's chart carries `counts: { days: 7, by: { node_id: { went, skipped } } }`:
  per node id, the distinct runs with a step row in the last 7 days, and how many of those skipped it (skipped or
  stale). Runs, not contacts: a company-level run (a schedule) has no contact and counts once. Shadow runs count:
  companies run in shadow first. By node id, so a step kept across versions is one step. One grouped query
  (`stepCounts`), served by `runs (workflow_id, reentry_key)` and `run_steps (run_id, started_at)`; a run finished
  before the window is not read. Each node wears a pill ("12", "3 · 1 skipped", a dimmer 0); a chart with a run picked
  shows that run's states instead. "Last ran" was already on the page.
- Display only: what runs and when is unchanged; no template changed.
- Tests: `words.test.ts` (a titled step's words are generated and its title is the label, and editing `from_stages`
  changes the words not the title; card, record, Slack, email, check, contact, Jev and end words; no main line of any
  shipped template or PMU copy, helpers included, has `{{`, `}}`, braces, an id, a dotted path, an underscore or Slack
  markup; remembered values and their cases; no two steps of one workflow share a main line; the step list uses the same
  words; with a stubbed pipelines read PMU's new card goes to "Booked Call" on "Beauty Moguls" and the reschedule lists
  all seven stages by GHL's names; unread, the key words carry the marker; the D105 reason by GHL's name),
  `step-counts.test.ts` (runs over eight days: only the last seven count, per node, distinct runs, a skip
  counted, a company-level run counted, the page's chart carries them, a step reached only eight days ago has none; the
  page names a board and stage as GHL does, reading GHL once for two page loads, and marks them when GHL fails).

## D113. An open dashboard tab knows when it is running old code (2026-10-14)

Tyler opened Hair's Health check and saw only its four triggers: the chart from before D107, still running in a tab
opened before that deploy (the live bundle had D107; a single-page app keeps the code it loaded until it reloads). A
chart he cannot trust because the tab is old is as bad as a wrong chart. Every answer through the middleware now says
which deploy made it (`x-build`, the commit); the dashboard bundle knows its own (built in). Once the API is newer, a
line at the top says the page is the old one with a Reload button, and the next page change loads the new code (the
page in front of him is not reloaded under his hands). A local build ("dev") is never called stale.
- Test: `src/api/newer-deploy.test.ts`.

## D114. A run of values kept is one box that says what it is for (2026-10-14)

Tyler, on Hair's Health check: between the alert triggers and "New, still open, or cleared?" stood seven grey steps,
"Remember the alert's mark / face / company's own alert face / headline / drift line's verb / how the drift questions
start / the alert's text", each with its cases: "this is super unclear what this does." D111 drew every helper so nothing
is hidden; the seven are one thing, making the alert's words. PMU's Call booked had the same in each booking path.
- **The rule** (`src/chart/group.ts`, `helperRuns`). Grouped are only steps that keep a value for the steps after them
  (`set_var`) or read the engine's own ledger (`lookup`): they change nothing outside the run and take no time. Not
  grouped: a wait (it decides when things happen), Jev's read and an AI read (they decide forks and cost a call), a
  `record` (it writes a fact that can start workflows), a resume, and every step that touches the CRM, Slack or a person.
  A run is a maximal straight chain of such steps: each one's only way out is a plain way (no words, not an otherwise) to
  the next, and each one after the first has that as its only way in. The ways counted are the chart's, the implicit ones
  (implicit.ts) included, so a step with a second way out, a fork, or a way in from elsewhere ends the run there. A
  sometimes-step (`only_if`) can be inside: skipped, the run still goes on to the next. Two or more steps; one stays as it is.
- **The box.** One grey helper node in the run's place, with a stacked edge under it, in the tidy layout and in the plain
  graph alike (`grouped` turns the chart into the drawn one; the first step's id is the box's). Its words come from what
  its steps keep: when most of them belong to one thing, "Prepare the alert's words (7 steps)" ("details" when not every
  value is words) with its parts on the line under it ("its mark, face, headline and text; the drift line's verb (it's
  or they've); how the drift questions start; 2 only sometimes"); otherwise what it keeps, "Remember the setter line,
  booking kind, booking source and card's name ending (4 steps)" (past four, "and 3 more" with every one listed under
  it), a lookup first ("Look up their bookings, then remember …"). Two boxes that would read the same are told apart by
  the way into them ("…, when setter booked (3 steps)"), else counted. Tap it: the popover (`groupPopover`) lists every
  step inside in order with its full words, its condition in blue, and how many went through each lately, or each
  one's state on the run.
- **Counts and runs.** Without a run the box wears its first step's count (D112). With one, its badge is its steps'
  state: all ran (a check), a failure, a wait or a stop among them, all skipped; when not all simply ran, a pill beside
  the badge says so ("5 ran · 2 skipped", "failed at step 3 of 7").
- **Still exact** (D111). The box's SVG node carries `data-group`, its steps in order; the lines into it end at its first
  step and the line out of it leaves from its last, so the check reads real ways. `exactness` accepts a box only when it
  is two or more steps that each keep a value or look up, every step but the last has exactly one way out, a plain way to
  the next in the box, and every step but the first exactly one way in, from the one before; then those inner ways count
  as drawn and every step in the box as drawn once. A box that hides a fork, a way out, a way in, a step that acts, or
  leaves a step out, doubles one or reorders them is a problem, and so is a line out that does not leave from the last.
- Display only: what runs is unchanged; no template changed. The run feed already left values kept out (D111 drew them
  on the chart only).
- Tests: `src/chart/group.test.ts` (Health check's seven are one box with those words, between the alert starts and the
  three-way fork, exact at both widths, only its real ways in and out drawn; PMU's Call booked's two boxes and the lone
  `b_suffix`; the template's twin boxes told apart; a wait, a tag step and Jev's read split runs, a lookup joins one; a
  fork and a second way in split a chain; a helper with an implicit way out is not grouped across it, and its end leaves
  from the box's last step; forged drawings (a box claiming the fork, missing a step, reordered, of one, not starting at
  its node; a way into or out of the middle added to the workflow; the line out moved to the first step) all caught; the
  plain graph exact with its box for every shipped template and PMU copy that has one, at both widths; the count and the
  run pill; the popover's steps, words, conditions, counts and states), and D111's matrix in `chart-views.test.ts`
  (every shipped template and PMU copy exact with no run, every run, both widths, the path alone) now runs with boxes.
  `scripts/render-charts.ts` takes `@id:skip` for a run's other states.

## D115. A closer's Sales Calls read back from the evidence, never guessed (2026-10-14)

PMU was installed on 2026-10-13 in shadow and its GHL Sales Call object had no records. Tyler: every one of Carly's calls of
the last month, on all her Calendly event types, in the engine's ledger and as Sales Call records in PMU's GHL (a one-off write
he approved although PMU is in shadow). "Never guess": a field is filled only from evidence; for anything that cannot be
established, "an idea of what happened" (the most likely reading, its evidence and reasoning) in the review, not in GHL.

What PMU's data looks like (read 2026-10-14):
- **Calendly** carries Carly's bookings from 2026-09-21. Most of her moves are "Rescheduled from connected calendar event": she
  drags the event in her calendar, Calendly cancels it (canceler host, `rescheduled: true`, a `new_invitee`) and makes a new
  event with an `old_invitee`; the Zoom link stays. The cancellation carries its own time (`cancellation.created_at`), now kept
  on the snapshot (`cancellation.at`). Several of Tyler's own test bookings sit on her calendars (cancelled, reason "test").
- **Fathom** has ten recordings of Carly's from 2026-09-24; three are "Impromptu Zoom Meeting"s with no invitee but her (Kellee's
  close on 9-29 is one). The ladder links them by the meeting link or her calendar.
- **Closer EOD** (`custom_objects.closer_eod`, 9 records, Carly, from 9-28): one record per day, not per call: report date,
  calls scheduled / taken, offers, closes, cash, revenue, dials, pick ups and a free-text note ("1 no show", "2 calls today- 1
  close, 1 reschedule"). Its `closer` dropdown lists two former closers; `report_label` holds "Carly".
- **Notes**: mostly the booking form's answers; PMU's Fathom Zap writes CURRENT SITUATION / PAINS / GOALS / OBJECTIONS after a
  recorded call; a few "Setter call scored" notes. Carly writes no call notes.
- **Cards** (Beauty Moguls): a stage and when it last changed; no history and no mover. Many were moved in bulk on 10-12.
- **Whop**: one paid close (Kellee, $10,000). The Sales Call object's `next_step` is an option list (follow up booked, sending
  info, nurture, dead), not text.

Built:
- **History reads the recorder too.** The backfill has a `recordings` step (after `appointments`): Fathom's meetings in the window
  (`fathomListMeetings`), into the recordings ledger through `recordRecording(..., { silent: true })`: the same row and the same
  ladder, and nothing emitted, so no workflow starts and no `wait_for_event` wakes. The transcript stays at Fathom
  (`transcript_status: at_source`, read when needed, D87). The appointments count no longer counts a moved slot that made no row.
- **`backfillSalesCalls`** (`sales-call-backfill.ts`), for the company's closing-category calls in a window (Demo included, D101),
  optionally one closer's: every ledger booking, plus each slot the booking source says was moved (the ledger keeps only the
  latest slot of a moved call; D76 makes the old slot its own record, logged rescheduled). Test contacts and a team member's own
  bookings are left out and say so.
- **The record is Call booked's.** Its own Sales Call step (the company's copy that writes the record keyed by
  `{{appointment.slot_key}}`, else the shipped template) is rendered for the call: the same key and external id, the same
  property names, the company's option keys, the closer as the dropdown's key, the call type by the step's own rule, the booking
  source by the calendar. Its `outcome: scheduled` is replaced by the evidenced outcome (scheduled only for a call still ahead).
  Properties the object lacks are left out, as the executor does.
- **What counts as evidence**, per call:
  - outcome: a moved slot → rescheduled; a cancel the booking source made before the start → cancelled (a cancel after the start
    is not one, D73); a recording the ladder linked to the booking that Jev reads as a sales call (Call recorded's own
    question) → showed; the host's no-show mark → no-show; the card on No Show, Lost or Disqualified, moved there after this call
    and before any later one → what Card moved by hand files (no-show; showed); the closer's end-of-day report for that day and
    the contact's notes around the call, read by Jev ("what happened on the call in question", the other calls that day given
    as context) → that outcome; a payment within 48 hours of the call → showed;
  - disposition (only for a call that showed): the person's payments after the call and before their next one → closed (deposit
    only when the ledger calls it one against a known deal value); the card on Lost / Disqualified, or won, tied as above; Jev on
    the end-of-day report and notes; Jev on the transcript, with the company's disposition keys as the options;
  - cash collected: those payments, net; contract value: the deal won in that span; objection and next step: Call recorded's call
    review (`prompt.call_review`; a review already on the recording is reused), the next step mapped by Jev onto the field's own
    options; recording URL: the recording's share link.
  - Sources that agree fill the field; sources that disagree leave it blank, with the strongest one as the likely reading and all
    of them as the reason. Nothing at all is blank with the clues there are: Jev's leaning on a text it was not sure of, the card's
    current stage, a slot cleared after its start, a recording not read as a sales call, a late payment, and how many of her
    uncancelled calls the closer recorded once she started recording (a clue only: a missing recording alone is no no-show).
- **Dry run first, then exactly that.** A dry run writes nothing to GHL or the ledger; it keeps its rows as a plan
  (`audit_log` `sales_calls.planned`) and answers `plan_id`. The write applies a plan as reviewed (no second AI read can change
  it); without one it reads again and writes. Each call is written on its own: the record ours (crm_records) or the CRM's with
  that external id is updated, else created (a re-run or an interrupted run never makes a second); a field the CRM already has
  with another value is left as it is (named in the row); related to the contact and the one closer card; kept in crm_records
  under the slot key, so later workflows update the same record; the person's CRM id linked the poll's way when the booking
  never brought it. The ledger gets the outcome and the call outcome only where it has none, rows only (as the outcomes step),
  and the days are rolled up. Nothing is emitted.
- **Route** `POST /api/admin/backfill/sales-calls` (operator key), a time budget inside Vercel's 300 s with `resume_from`;
  **page** `scripts/sales-call-report.ts` renders the answers for review.

Consequences to know: records written blank are "owed" to the end-of-day reminder for the last seven days (D76, D110), and the
bot's calls and shows read these records (D73).

Tests: `sales-call-backfill.test.ts` (the recordings step links by the meeting link and emits nothing; a recording ⇒ showed with
the transcript's disposition, objection and next step; a cancel before the call ⇒ cancelled; a move ⇒ rescheduled on the old slot
and its own record for the new one; a payment ⇒ showed, closed and the cash; the end of day ⇒ no-show; a card in No Show ⇒ no-show;
nothing ⇒ blank with a likely reading; a test contact is not written; a person with no CRM id found by email and linked; the dry
run writes nothing; the plan writes once, related, in crm_records and the ledger, with workflows on that would answer and no run
started and no event; a second pass creates nothing and keeps a value filed in GHL; only the closer's calls), `sales-call-report.test.ts`.

### D115 addendum. A same-time re-make is no move; a slot keeps its own time (2026-10-14)

Reviewing PMU's first dry run, five "rescheduled" slots stood at the very time of the booking that replaced them (Ghenwa Oct 2
1:30 PM twice, Olena Sep 24, Christian Oct 12, Elena Oct 13, one of Sarah's two at Sep 23 5:00 PM). The rows carried their own
times: Calendly's cancelled event really has the same `start_time` as its replacement. When the host edits an event in her
connected calendar, Calendly cancels it ("Rescheduled from connected calendar event") and makes a new one, often without changing
the time. That call did not move, and the live poll agrees (under a minute is no reschedule), so such an event is no slot of its
own: no record, and the booking's row says Calendly re-made it. A real move keeps the left slot at its own start, its own date,
label and `scheduled_at`, and says where it went. A move the engine saw itself (`appointment.rescheduled` with `slot.from`, a GHL
calendar that keeps the booking's id) is a left slot too, at `starts_at.from`. The review page heads each call with the person's
name and email. Test: a chain moved twice keeps three dates; a same-time re-make makes one record; a GHL move's old slot has its
own date.

### D115 addendum 2. The card stands when nothing says otherwise; a person decides the rest, on the record (2026-10-14)

Reviewing PMU's second dry run, Tyler: "If the card says the outcome with no other supporting data for something else, that is
likely the outcome. If you can't tell, don't do anything yet. Use the supporting data to make your best decisions." Two changes.
First, a card stage that was only a lean (Follow Up, Closed Won, Cancelled, Rescheduled) now files the outcome, and the disposition
it implies for a held call, when the card moved after this call and before any later held one and every other clue agrees with
it; any clue that disagrees (a slot cleared after its start, a note read the other way) keeps the field blank, as before. Second,
a dry run takes `decide: [{ slot, fields, why }]` for what the evidence leaves open and `exclude: [{ email, why }]` for people
to leave out without tagging them in the CRM. Each decided field gets "operator decision: <why>" as its first evidence and loses
its "most likely" line. An exclusion skips the row with its why. Both stay in the plan the write applies. A decision for a call
outside the window, a field the object lacks, an option the field doesn't have, or a call decided twice stops the run with a 400
before anything is read. A pass that runs out of time is resumed with `resume_from` and the same `from`, so the window, and
what a decision may name, stays whole. Test: a card alone files showed/follow up; the same card against a slot cleared after its start stays
blank; a decision and an exclusion reach the plan; mistakes are refused; a resumed pass accepts a decision on an earlier call and reads
only the rest.

## D116. A money field goes with its currency (2026-10-14)

Writing PMU's Sales Call history, the one closed call (Kellee, $10,000) was refused on create: GHL 400 "Cash Collected is
missing a currency code". D90 had sent a MONETORY property as a bare number. That held for Hair, whose writes were all
updates and whose field takes a bare number. PMU's Cash Collected and Contract Value refuse one on create and on update alike
(seen on both, 2026-10-14), so the first live PMU close would have failed the same way. Checked live on PMU's
own record on 2026-10-14: `{ "currency": "default", "value": 10000 }` is taken on create and on update, and is what GHL reads
back. So `propertyValue` sends MONETORY/MONETARY as that object, and NUMERICAL, FLOAT and NUMBER stay bare numbers. A value
that is not a number still goes as written, so the CRM can name the problem. The backfill's "keep what someone filed in GHL"
check compares the amount, not the object. Test: `nodes.test.ts` (money with its currency), `sales-call-backfill.test.ts`
(the closed call's write).


## D117. A company in a shared location acts only on its own people: the scope tag (2026-10-16)

A new client, a dating and relationship offer, is installed into RapidCloser, a GHL location that belongs to another
business: about 19k contacts, its own power dialers, calendars and pipelines. The engine had no company-level scope, so it
would have treated the whole location as this company's. A read-only audit found the paths: the contacts poll replicated
every contact and any old one GHL updated became a new lead (D65) with a card on the setter board; the drift sweep pulled
in the same; every connected dialer call in the location became a setter call (AI read, Discovery Call record); every
signed document of a known contact fired Agreement signed and Deal closed; leads in wrap-ups and `/mtd` were the location's.
Bound boards (D88) and mapped calendars were already the company's. Tyler: the engine acts only on contacts tagged `dating`
for this company.

**The setting.** `scopeTag` at install (`--scope-tag`), bound as `scope.tag`, lowercase (GHL's tags are). Omitted on a
re-install it stays; `""` removes it. No scope tag is the engine exactly as before: every path below asks first whether one
is set (Hair and PMU have none; the rest of the suite is the proof).

**In scope** (`scope.ts`): GHL carries the tag on them, or they booked on one of the company's mapped calendars (every
ledger appointment is on one: `applyAppointment` keeps no other). A booker is in scope untagged, and the engine tags them in
GHL. That write is the engine's, made when the booking is first seen, not a template step: membership must not depend on a
workflow being installed and on (a new template would also put a workflow on Hair and PMU that never fires). Real or shadow
is decided the way every write the engine makes on its workflows' behalf is (D52, D88's drift repairs, D92): `effectiveMode`
over `handlerMode("appointment.booked")`, the least real rung of the workflows that answer the booking, else the company's;
in test, only a test contact is written. In shadow nothing is written and the would-have is recorded as a tag step records
it (`tag.added`, `shadow: true`; neither GHL nor the replica, so the next poll sees no phantom). A refusal does not hold the
booking up (they are in scope by it): it is an alert to tag them by hand. A baseline booking (before install) is in scope
and not tagged: the baseline writes nothing. A Calendly invitee the CRM has not shown yet has nothing to tag.

**Every door, path by path.**
- *Contacts poll*: the search carries `{field:"tags", operator:"contains", value:<tag>}` next to the dateUpdated range
  (the shape of the existing filter, verified read-only on RapidCloser), so the location's other contacts are never read;
  the poll also holds each row to the exact tag. An untagged contact GHL updates is not replicated and starts nothing.
- *Tag removed*: the tagged search cannot show a removal (the person stops coming back), so before anything new starts
  for someone in scope by the tag alone (a reply, a dialer call, a new or newly signed document) GHL is asked once. Gone:
  the replica takes GHL's tags (no poll will diff them again, so nothing is swallowed), `scope.left` is recorded (a new
  event type, never a start), nothing starts. Nothing is deleted; runs already going carry on. A booker needs no read.
- *Dialer calls and replies* (`pollInbound`): a scoped company never fetches a stranger on a call (the D28 fetch is for
  unscoped companies; the tagged contacts poll runs first each tick, so a tagged lead's call finds them). A known person out
  of scope gets no call row, no `call.logged`, no `message.received`.
- *Documents*: every document is still mirrored, but only an in-scope person's carries their id and says anything, so one
  signed while its person was out of scope is never news later.
- *Drift sweep*: only tagged contacts GHL added are pulled in; GHL's whole answer still says who is present (no extra reads).
- *Leads* (`leads`, `mqls`, `marketing_dqs` in wrap-ups, `/mtd`, the bot; and the bot's lead rows in `ghl-graph`): tagged in
  GHL, or booked (`ledgerFacts.booked`).
- *History backfill*: only tagged contacts; calls only of in-scope people already known, no stranger fetched.
- *Payments* (Whop, Zapier, the backfill's Whop pull): the match ladder already reads only the ledger; a hit on someone out
  of scope is no hit, so the payment stays unlinked and Unlinked payment tells the team. Linking by hand is a person's
  decision and settles as before. A refund follows the payment it reverses, as before.
- *Not scoped, and why*: the cards poll (only the company's bound boards, and only people the ledger knows); bookings (the
  mapped calendars are the scope); recordings (the company's own Fathom, matched only to ledger people and bookings); the
  Slack doors and the end-of-day form (act on runs and appointments that exist); the Sales Call backfill (its people are the
  ledger's bookers); closes, calls and cash in the metrics (the company's own closer board and Sales Call and Payment objects).
  If the other business uses the same custom object keys in the location, those numbers would be shared: checked at install,
  not by the engine.

**Hardening, same change.** `paymentOf` read a Payment record's `amount` with `String()`; a MONETORY field reads back as
`{currency, value}` (D116), which counted as 0. `amountOf` takes a number, text ("$1,500") or `{value}`. The bot's graph
reader (`ghl-graph` `text`) had the same blind spot: a Sales Call's money property and the contact cash field read as blank;
it now reads `{value}`. The Sales Call backfill already compared amounts (D116).

Tests: `scope.test.ts` (an untagged contact updated in GHL is not ingested and starts nothing, a tagged one is a lead; an
untagged booker is in scope and tagged only when writes are real; a dialer call of someone out of scope fetches and creates
nobody; a removed tag takes them out, nothing starts, nothing deleted; a document of someone out of scope says nothing; drift
pulls in only the tagged; leads count only the tagged and the bookers; a payment naming someone out of scope stays unlinked;
a money amount as `{currency, value}`). Each fails without the change. The existing suite, untouched, is the no-tag proof.

## D118. The templates write the company's own objects and option keys; a company's own words are its copies (2026-10-16)

Dating Nelly, the first of many dating offers, was installed on the shipped templates. An audit found them written for
Hair: every Sales Call, Payment and Discovery Call write went to a fixed key (`custom_objects.sales_call`, `.payment`,
`.discovery_call`), where Dating Nelly's objects are `custom_objects.dating_*` (in RapidCloser, a fixed key would have failed
or landed in the other business's object of that name); the Sales Call's Closer was written as the roster name ("Mitch
Sapoff") where her dropdown's options are `nelly` and `mitch` (GHL drops an unknown option without a word); the objection
filter and the call prompts carried Hair's `medical` and `burned_before`; Deal closed's welcome email and text are Hair's;
the setter DQ reasons ask about a medical reason. Tyler wants this to scale to many dating companies, so what is generic is
fixed in the shared templates, and only on condition that nothing changes for Hair and PMU.

- **Objects by binding.** Every `crm_record` in Call booked, Call cancelled, Call outcome filed, Sales call recorded, Payment
  recorded, Deal closed and Setter call logged writes `{{crm.object_<role> | default:custom_objects.<role>}}`. The default
  keeps the binding optional (readiness unchanged). `{{records.sales_call}}` is also the person's latest record on the bound
  object, whatever its key (`OBJECT_ROLES` in `sales-call.ts`). The health sweep reads the defaulted form as the bound object,
  else the default; the history backfill reads Sales Call outcomes from the bound object (it read the fixed key).
- **Option keys the install declares.** `salesCall.objections` (bound as `sales_call.objections`; unset, the list the
  templates always wrote) and `salesCall.closerOptions` (`sales_call.closer_options`: `{ <email | CRM user id | roster
  name>: <option key> }`; unset, the closer is written by name). The new `option:<picklist>` filter writes them:
  `{{recording.closer.name | default: | option:sales_call_closer}}`, `{{vars.notes.primary_objection | option:sales_call_objection | default:}}`.
  A list keeps only its values, a map gives the declared key (a closer without one: nothing, not a name GHL drops), an
  undeclared picklist passes the value as it is. The end-of-day reminder and the numbers read an option key back as the
  closer it belongs to. `provision-ghl` puts the Sales Call field's own objection options into the install skeleton, and the
  setup file carries the closer options, so the next dating company declares both in its setup file.
- **Hair and PMU are untouched, proven.** Hair's copies track the templates (none of these diverged; Call booked is one
  upgrade behind, D104), so they take this on the next `POST /api/admin/templates`. Read from production with a dry-run save
  (the bindings a definition lacks are listed): Hair binds `crm.object_sales_call` (its value is not readable from outside; by every sign
  `custom_objects.sales_call`: the engine's ten Sales Call records live there and the drift sweep, which compares them with
  the bound object, has one question, not ten) and not `crm.object_payment` or `crm.object_discovery_call`;
  PMU binds `crm.object_payment` to `custom_objects.cash`, and its Call booked, Call cancelled, Call outcome, Sales call
  recorded, Deal closed and Payment recorded are its own diverged copies (D100), which template upgrades leave alone and
  this change does not regenerate. On companies bound that way, every string of every changed template renders the same
  before and after, for every objection and with or without a closer; PMU's copies render the same on the new context; the
  only difference for a PMU-bound company is Payment recorded's object becoming `custom_objects.cash`, which PMU's own copy
  already writes.
- **A company's own words are its copies.** Wording is per company and has no setting: Dating Nelly gets her own Deal
  closed (welcome email and text) and Setter call logged (the DQ wording and reasons), built by `scripts/build-copies.ts
  dating-nelly` from the templates and `installs/dating-nelly/words.json` with the generator every dating company shares
  (`installs/dating/copies.ts`), and saved with the definition route as PMU's were. The copies differ from the templates
  only in those nodes; a template upgrade reaches them by building again. Her call prompts (`prompts` in the install file:
  her six objections, no medical triage) are built from the shipped ones by the same script. Hair's words stay in the
  template until Hair's are its own edit (open item 43).
- **Placeholders send nothing.** Words Tyler has not given are marked `[placeholder …]`; a welcome send whose words are a
  placeholder is built with `only_if: there is a welcome copy written` (nothing sets it), so it is skipped even live; the
  DQ reasons only label Jev's read (`setter_result.act` is off). Building with real words drops the condition.
- Not done: Hair's welcome words as Hair's own edit; a deposit is still written `closed_won` by Call outcome filed (Hair's
  model; Dating Nelly's Sales Call has its own Deposit option); Payment recorded writes `processor: whop` whatever the
  processor; the DQ reason options are shared by every company (`setter_dq_reason`).
- Tests: `company-objects.test.ts` (Hair's identity across all seven templates; PMU's copies and the one expected
  difference; Dating Nelly's objects, `mitch`, her objections only and `records.sales_call`; through the engine in shadow, a
  booking, a recording and a payment write only her objects; the end-of-day reminder reads `mitch` as Mitch's and does not
  without the setting; the option lists and the filter), `dating-copies.test.ts` (the files are the build's; only the
  welcome and DQ nodes differ, none of Hair's words; her prompts; each copy validates, draws tidy and saves; live, paid and
  signed, the placeholder welcome is skipped and nothing is sent), `moves.test.ts` (the health check on a defaulted object),
  `provision.test.ts`, `coverage.test.ts`; the chart tests hold every company copy to D111. Reverting Call booked's object or
  closer turns two red; dropping an objection from the default list turns Hair's identity red; a welcome without its
  condition turns the no-send test red.

## D119. A deposit is not a close; a deposit is a product, never an amount (2026-10-16)

Tyler, 2026-10-16, for every company: a deposit and a close are different outcomes everywhere; deposits are told apart by a
separate product at the processor, not by amount ("guessing"); the agreement goes only on a payment that is not a deposit;
Deal closed never fires on a deposit (open item 35); the reports give deposits their own line; the closer board gets a
Deposit stage. Before this, `deriveKind` called any first payment short of the price a `deposit`, and Call outcome filed
wrote a filed deposit as `closed_won` with `stat-closed-won`, which Hair's production shows was wrong both ways: Hair's only
"deposit" in the ledger, `pay_aWgRac…` ($750, 2026-10-05), is a Whop `subscription_create` on a $2,999 program, the first
installment of a payment plan.

- **What a deposit is.** The install declares the processor's deposit products: `"depositProducts": ["prod_…", "plan_…"]`
  (Whop product ids or plan ids; a Zap's `plan` / `product_id` / `plan_id` as it sends them), bound as
  `payments.deposit_products` (omitted, left as it is; `[]` removes them). Whop's payload already carries `product_id` and
  `plan_id` (both doors kept them in `raw`; the Zapier door now keeps `product_id` and `plan_id` too). A payment whose product
  or plan is declared is kind `deposit`, whatever its amount; refunds and failures keep their kinds. **Nothing else is ever a
  deposit**: the amount-based guess is gone for every company, so a first payment short of the price is the first
  `installment`, and a company that declares no product has no deposits at all. Chosen over keeping the guess for Hair and
  PMU until they declare a product: kept, the guess would have stopped Hair's agreement and Deal closed on a payment plan's
  first installment (the $750 above), the silent change to avoid; retired, Hair's gates are exactly as before and only the
  label of a first partial payment changes (`deposit` → `installment` on the Payment record, the note and the 💵 line).
  A deposit counts toward the price (the payment that clears it after is the `balance`) and is in cash collected.
  Migration, once (`engine_state` `d119_deposit_kinds`): the guessed `deposit` rows of companies with no declared product
  become `installment` (Hair's two, PMU's $0 one). The GHL Payment records already written keep their `type`.
- **Filed on a call.** Call outcome filed: `showed:deposit` tags `stat-showed` + `stat-deposit` (the changed-answer
  bookkeeping u1/u2/u4 knows it), its own branch (closed and deposit are no longer one), and the closer card to the board's
  **Deposit** stage, `crm.stage_closer_deposit`, still open (`pick: latest`, so a lost card reopens there). Unbound, the step
  skips: "only if there is a Deposit stage on the closer board; there is no Deposit stage on the closer board" (a stage
  binding in an `exists` now reads as the board's stage). A deposit refiled as closed takes `stat-deposit` off and moves the
  card back to Scheduled (`kc`) for the money to move it on. The Sales Call `disposition` is the company's own key for the
  answer: `picklist.sales_call_disposition`, the inverse of `sales_call.dispositions` (of two keys with one meaning, the one
  with no reason, then the engine's own spelling; unbound, the engine's keys `closed_won`, `deposit`, `close_pending`,
  `follow_up`, `lost`, `dq`), written by `{{appointment.call_outcome | option:sales_call_disposition}}`. A map with no deposit
  key (Hair's) gets the field emptied on a deposit, never `closed_won`. Every other answer writes what it wrote before on
  Hair's, PMU's and Dating Nelly's maps (PMU's copy no longer carries its own pick and guard: its bound map gives the same
  keys). The read-back default (`DEFAULT_DISPOSITIONS`) knows `deposit`; the hourly sweep keeps a ledger deposit against
  GHL's `closed_won` only for a company that has not declared a deposit key (that record may be the engine's old write).
- **Payments.** Each payment event carries `prior_non_deposit_total` (the earlier money toward the price, deposits and their
  refunds left out). Payment recorded: the agreement goes on the first payment beyond a deposit (`prior_non_deposit_total` 0,
  not a deposit or refund, not signed), so the payment back for the rest sends it; revenue generated is stamped on that
  payment, not a deposit (revenue contracted counts only on a close); a deposit never wins the opportunity (`o_won`); it is
  tagged `pay-deposit`, not `pay-plan-active` (a deposit is not a plan; the tag stays, like `pay-refunded`). Cash collected,
  the Payment record (type `deposit`) and the Sales Call's cash follow as before.
- **Deal closed, the chase, stat-customer.** The gate reads `contact.paid_non_deposit` (a succeeded payment that is not a
  deposit) and the signature: a deposit alone, even signed, is not a close; the first payment beyond it with the signature
  is. The chase waits too, by evidence: it nudges about an agreement Payment recorded sent, and on a deposit none is sent, so
  it starts on the same payment the agreement goes out on (`prior_non_deposit_total` 0, not a deposit). `stat-customer` is
  written only by Deal closed, so it waits with the gate (no other template reads or writes it). New context facts:
  `contact.paid_non_deposit`, `contact.deposit_paid`; `contact.paid` is unchanged.
- **Reports.** `deposits` (people with a GHL Payment record of type deposit in the period, each once) and `deposit_cash`
  (those records' money, before refunds) in the registry; the daily, weekly and monthly wrap-ups read and word them on their
  own lines after the close rate (a line only when not zero, so a company with none reads as before); `/mtd`, `/weekly` and
  `/monthly` show them; the bot answers them by definition. Closes and revenue stay the won closer cards, which a deposit
  never wins; deposit cash is inside cash collected. The end-of-day form already counted deposits on their own; now a
  deposit asks and counts cash but no revenue, and the pre-fill reads Deposit only when everything paid that day was a
  deposit (the amount says nothing).
- **The Deposit stage in GHL.** Dating: `installs/dating/ghl-setup.json`'s closer pipeline has Deposit after Follow Up;
  `provision-ghl` now puts a stage the setup adds later where the setup puts it (after the stage it follows, past anyone
  else's stages right behind it; the stages behind move down one; nothing removed or renamed), where it used to append at
  the end. PMU's Beauty Moguls board and Hair's are the parent's to change (open item 44, below).
- Not done: Payment recorded does not move the card to Deposit on a deposit payment (only a filed deposit does); a company
  that declares products later keeps its earlier payments' kinds; PMU's copies of Call booked, Call cancelled and Call
  recorded are still D118's (`build.py` regenerates them with the object binding, which renders the same for PMU).
- Tests: `deposits.test.ts` (the kinds and the products, the doors, the option keys, the form, the wrap-ups; through the
  engine on a Hair-like company: a filed deposit is `stat-deposit`, an emptied Outcome and a skipped Deposit step, a closed
  call and a $750 payment do exactly what they did, the form pre-fills it a close; PMU-like with its own copies: a deposit
  product payment sends nothing and wins nothing, the filed deposit is its Deposit outcome and stage, the balance sends the
  agreement and closes once signed; Dating-like: a deposit even signed is not a close, deposit then closed refiles cleanly;
  the install key; the numbers; the migration once), `provision.test.ts` (Deposit lands after Follow Up). Each fails without
  its change: reverting call-outcome turns 4 red, payment-recorded 2, deal-closed 1, agreement-chase 2, the amount guess 2,
  the install binding 6, the form 2, the pre-fill 1, the migration 1, the metrics 1, the wrap-ups 1, provision 1, the Zapier
  ids 1, the disposition picklist 3. Existing tests that encoded the guess say installment now (`payments`, `journey`,
  `templates.scenarios`, `edge-cases.contacts`, `eod`, `moves`); D118's identity test holds D118's claim against the
  templates as D118 left them (`fixtures/before-d119`).

### D119 addendum. A deposit is told by its name too: the word "deposit" (2026-10-16)

Tyler, 2026-10-16: "We don't have a deposit link for either [Hair or PMU] yet. But I'll make sure they say 'deposit'." So
there are no ids to declare per company: for every company (Hair, PMU, Dating Nelly, whose Whop is not set up yet), a payment
is kind `deposit` when its Whop **product's name or its plan's name has the word "deposit"**: whole, in any case ("Deposit",
"VIP Deposit", "Deposit - $250", "vip-deposit"); a word that only contains it does not count ("deposited", "nondeposit",
"Redeposit", and the plural "Deposits"). This is an exact naming convention on a label the company itself sets at Whop, read
the way an id is read (`DEPOSIT_WORD`, `deposit-names.ts`: the letters `deposit` with no letter or digit either side), not a
reading of what a name means; nothing about the amount, the buyer or the wording around it is ever read.

- **Declared ids still work, and win.** A company that declares `depositProducts` is told by its list alone: a declared
  product or plan is a deposit whatever it is called, and nothing else is, the names not read (`isDeposit`, `payments.ts`).
  That keeps the declaration an escape hatch for a name that says deposit and is not one ("No Deposit Plan").
- **Where the names come from.** Whop's Payment carries them on `line_items[]`: `product_title` and `plan_title`. Verified
  2026-10-16 read-only on PMU's key: `GET /payments/pay_VIuXKUpc6WJnhA` and the payment list carry `product_id`, `plan_id`
  and `line_items: [{ product_id, product_title: "Beauty Moguls Method", plan_id, plan_title: null }]` (its plan has no
  title: `GET /plans/plan_7tHpabPHO7RrA` is `title: null`, with `product: { id, title }`; `GET /products/{id}` has `title`).
  The webhook's `data` is the same Payment (`whop/01-api-facts.md`); no Whop webhook has reached Hair or PMU yet (their
  ledgers are backfills, which kept only the ids: `pay_aWgRac…` `prod_HrtmAIvLFEK7r` / `plan_GrC5lgQYrE6bY`). Both doors and
  the backfill now keep `product_name` and `plan_name` on the payment's `raw` (the line item for the payment's own product
  first; a nested `product`/`plan` object's `title` or a flat `product_title` also count), so reports and the dashboard can show
  them. A key left out was not carried; `null` was carried and is no name.
- **Names not carried: read from Whop.** A new succeeded payment whose product or plan has an id but no name carried (a Zap
  that sends only ids, a payload without line items) has them read with the company's `secret.whop_api_key`
  (`GET /products/{id}`, `GET /plans/{id}`, 3 s timeout, since a Whop webhook waits for its answer), the product first and the
  plan only if the product's name does not say deposit. Cached per company in `engine_state` `whop_names:<companyId>`, an hour
  (a product renamed is seen within the hour; a new product is a new id, never stale). Failed payments and refunds are never
  looked up: their kinds are never deposits. A company that declares products is never looked up either.
- **When a name cannot be had** (no Whop key, Whop down or slow, an unknown id, a non-Whop processor without names), the
  payment is **not a deposit**, recorded and settled as any other, **never held**; it is flagged on the row
  (`raw.deposit_check: { failed, at }`, findable later) and raises an error alert `payment:deposit-unchecked:<payment id>`
  (source `engine`; a person resolves it) that says the payment, why, and that the agreement went out if it was the first
  payment. Why not the other way: taken wrongly as a deposit, a real payment would send no agreement, never win the
  opportunity and never close, and nothing would say so; taken wrongly as not a deposit, the agreement goes out early, which
  the person sees and the alert names the same minute. Holding the payment until Whop answers (a non-2xx so Whop redelivers)
  was not chosen: a lasting failure (a revoked key) would leave real money unrecorded for Whop's three days of retries.
- **The Zapier door** takes the names as `product_name` / `plan_name` (also `product_title` / `plan_title`, camelCase); a Zap's
  `product` / `plan` that is not a Whop id (`prod_…` / `plan_…`) is taken as the name, one that is as the id. A Zap that
  sends only the ids has the names read from Whop as above (provider `whop`).
- **Past payments keep their kinds**, as D119 decided: a kind is derived once, when the payment settles (on arrival, or when
  an unlinked one is linked or healed), and nothing re-derives a settled payment. A product renamed to say deposit changes
  only the payments after it; there is no migration.
- Tyler: name each deposit product (or its plan) at Whop with the word "Deposit". The product's name is the one Whop's payload
  is proven to carry; a plan's title is optional at Whop and empty on PMU's plans today. PMU's archived "DEPOSIT" product
  (`prod_PR9AINNIxjRFV`) qualifies once it is sold again; its $100/$250/$500 plans on Beauty Moguls Method do not unless they
  are titled with the word.
- Tests: `deposit-names.test.ts` (the whole word; declared ids win; the names in Whop's payload, the backfill's and a Zap's;
  through the ledger with a fake Whop: the payload's names with no call, the lookup and its cache, Whop down and an unknown id
  (not a deposit, recorded, flagged, alerted), no key, failed payments and refunds never looked up, the declared company never
  looked up, the Zapier door both ways, and a rename changing only later payments). Each fails without its change: with the
  change reverted 10 of 11 fail (the declared-company case held before); a substring match turns 2 red, names read beside a
  declaration 2, a silent miss without a key 1.

## D120. A call Calendly re-makes keeps its slot key: one call, one Sales Call record (2026-10-16)

Found backfilling PMU (D115 addendum): when a host edits an event in her connected calendar, Calendly cancels it ("Rescheduled
from connected calendar event") and makes a new one, often at the very same time. The live poll treated that as no move (under a
minute is no reschedule, no `appointment.rescheduled`) but still repointed the booking's slot key to the new event's id
(`applyAppointment`, `slot_key=$2` with the new id). The Sales Call record Call booked made stays keyed by the old id
(`crm_records.record_key`, and the GHL record's `external_id`), so every later step keyed by `{{appointment.slot_key}}` missed it.
Reproduced against the shipped templates (`remake.test.ts`, before the fix): Call outcome filed's r1 skipped ("no record in the
CRM to update": the match fallback leaves out records already in `crm_records`), Call recorded created a second record, in shadow
a second `crm_records` row; a real move after a re-make logged the wrong slot as left (`slot.from` = the re-made id), so Call
booked's k5 found nothing and the original record stayed `scheduled` for good. Two re-makes between two polls were worse: the
newest event names one the ledger never held, so the poll made a second booking (a second `appointment.booked`, a second record).

Decided: **the slot key is the call's, not the event's.** A same-time re-make moves the booking's `external_id` to the new event
and leaves `slot_key` as it was (the old event's id, or `external_id` where it was null). A real move still gives the new slot the
new event's id and logs the left one under the slot key it had, so a move after any number of re-makes logs the record Call
booked made. The poll walks back up to four hops through the source (`getAppointment(...).rescheduledFrom`) when the event it
replaced is not in the ledger, so a chain made between two polls still repoints the one booking.

Why not the alternatives:
- **Re-key `crm_records` and the GHL record's `external_id` on each re-make**: a CRM write the poll would have to make (only when
  the mode makes CRM writes real, D52/D92), so shadow and test would keep the bug for everyone the mode holds back, and each
  re-make would be another write to fail, retry and keep idempotent (D66) outside any run. Drift (D88) and the backfill (D115)
  match the record by `external_id`; changing it under them invites the very mismatch this fixes.
- **Find the record by the appointment and its slot history**: needs a slot history table and every record step taught to read
  it; the key already exists and means "this call slot" (D76).
Keeping the key stable needs no write to anyone, behaves the same in every mode, and leaves `step_effects` and `crm_records`
exactly as they are.

Also:
- `if_missing: match` (`bookingRecord`) and the Sales Call matcher behind drift and the numbers (`ghl-metrics`) match a
  record's `external_id` against the booking's slot key as well as its event id.
- The backfill names a left slot as the engine did: within a chain of same-time re-makes, the id the engine already wrote
  (`crm_records`) or logged as left (`slot.from`), else the event's own id as before (so records the PMU backfill already wrote
  keep their keys). A booking whose slot key is the event Calendly re-made says it keeps the record it was booked under.
- A GHL calendar keeps the booking's id; nothing changes there.

Production, read-only on 2026-10-16: no harm yet. Hair, PMU and Dating Nelly hold no two Sales Call records for one person and
start, no record whose key matches no booking except PMU's six backfilled left slots (each a real move, at its own time) and
one harness record each on Hair and PMU (`test-…`), no step that wrote a key the booking no longer carries outside PMU's
harness moves, and no two live bookings for one person at one start. So there is nothing to repair. Hair's Calendly rows from
before D76 carry a null `slot_key`; a re-make keeps their `external_id` as the key.

Tests: `remake.test.ts` (a re-make, then Call outcome filed and Call recorded update the one record; re-made twice; re-made
twice between two polls; a re-make then a real move logs Call booked's record rescheduled and the outcome lands on the new
slot's; the backfill names that left slot once, under the engine's key; a shadow company keeps one `crm_records` row; a GHL
calendar's move is unchanged). Six of the seven fail without the poll change (the GHL case held before), the backfill case
without the backfill change.

## D121. The setup's calendars: its own group, its own team; a setter-booked call with no setter is an error (2026-10-16)

Tyler, 2026-10-16: "Create a new calendar group for Nelly." Nelly takes the Dating calendars over from Mitch (earlier:
"Assign them to Mitch for now. Eventually, when we get Nelly in, it will be Nelly"); she is now a RapidCloser GHL user
(Nelly S., `2BnOPqPK68aqZ9QBIK6B`). And: "If it's set through the setter link, and there is no setter, throw an engine
error." (Numbered D121: D120 is left to an entry being written in parallel.)

**The calendar group** (`provision-ghl`). The setup declares `calendarGroup: { name, slug, description }`; the name takes
the prefix ("Dating – Nelly"). Matched by name like everything else; missing, it is made (`POST /calendars/groups` with
`locationId`, `name`, `description`, `slug`, `isActive`), unless another group already has its slug (blocked: nothing is
made or grouped, the setup needs another slug). Every calendar of the setup goes in it: one made now is made in it
(`groupId` on the create); one in no group gets its `groupId` (`PUT /calendars/<id>`); one already in someone else's group
is left there and said (`exists-differs`). The group's id is taken from a fresh read of the groups by name, not from the
create's answer.

**The team is the setup's.** A calendar the setup names is the setup's own, so the team the setup gives it (`team`, or a
calendar's own `team`) is set on it, the one declared change to something that exists beyond the additive ones (D119).
GHL replaces `teamMembers` whole: one who stays keeps their priority and whether they are primary; a newcomer gets 0.5;
with no primary left, the first is. The dry run says it exactly, as a new plan action `change-on-ours`: `Mitch Sapoff
<mitch@revsignals.io> → Nelly S. <nellysudri@gmail.com>` (with who joins and who leaves when someone stays). A setup email
that is no user in the location changes nothing (`exists-differs`). Calls already booked are not reassigned by the script.
A calendar's length and hours are still only reported, never changed.

**The guard, extended.** What the setup owns is read off the location by the setup's names (`ownedBy`), apart from the
planner: its calendars and its group. A calendar PUT goes only to one of those calendars and carries only `groupId` and
`teamMembers`; a `groupId` (on that PUT or on a calendar create) can only be the setup's own group; a group is never PUT;
the dry run still sends nothing but GETs, and nothing is ever deleted. The other PUTs (a pipeline's stages, a field's
options) are as before.

**API shapes.** From GHL's own OpenAPI spec (`GoHighLevel/highlevel-api-docs`, `apps/calendars.json`, read 2026-10-16):
`GET /calendars/groups?locationId` → `{ groups: [{ id, locationId, name, description, slug, isActive }] }`;
`POST /calendars/groups` takes `GroupCreateDTO` (`locationId`, `name`, `description`, `slug` required, `isActive`) →
`{ group }`; `PUT /calendars/{id}` takes `CalendarUpdateDTO`, every field optional, with `groupId` and `teamMembers`
(`{ userId, priority, isPrimary, … }`); all with `Version: 2021-04-15`. Verified on RapidCloser read-only: the groups read
(three groups: General Calendar, IG, RapidCloser; no Dating one) and the calendars' `groupId` (absent on the three Dating
calendars, which are round robin with Mitch alone). Taken from the spec, not yet seen live: the create's answer and that a
PUT carrying only `groupId` and `teamMembers` leaves the rest of the calendar as it is.

Dating's setup now has `team: ["nellysudri@gmail.com"]`, the group `Nelly` / `dating-nelly`, and its install skeleton
names Nelly in `closers` and `salesCall.closerOptions` as `installs/dating-nelly.json` already does. Dry run on RapidCloser
(2026-10-16): create the group; on each of the three calendars the team Mitch → Nelly and into the group; everything else
exists. Not applied here.

**A setter-booked call with no setter is an error** (`setter-missing.ts`). When the poll first sees a new booking (not a
baseline) that the engine takes as setter-booked (`self_booked` false, D24: a `booking: "setter"` calendar, a setter
calendar under the `calendar` rule, or `either` on one) and the booking names no setter (`set_by` blank: a GHL calendar
never does; Calendly when the setter question has no answer), the engine raises one alert, `setter:missing:<appointment
id>`, level error, source engine: "Setter-booked call with no setter: Ann Doe, Mon Oct 19, 3:00 PM EDT on Dating – Strategy
Call (Setter). Say who set it: put the setter's name in Ann Doe's Setter field in GHL and this clears." (with no Setter field
bound: "Say who set it, then resolve this alert."). It is raised before Call booked runs, so nothing waits on it.

- **Who set it is known** by, in this order: the booking (`set_by`); a team member's connected dial to that person that the
  booking came during or within the Set window after (D87's rule, the one the setter numbers already credit); the
  contact's Setter field (`crm.field_contact_setter`) filled in after the booking. A dial that already names the setter
  when the booking is first seen means no alert at all. A Setter field that already held a name before the booking is not
  taken for this booking (it may be an earlier one's): the alert says what it holds, and a person resolves it if that is
  right; it closes once the field changes to a name.
- **It closes by itself**: each poll (entity `setters`, after the calls) asks every open one again; the Setter field is the
  replica's, and GHL's own every 5 minutes for a person with a GHL id (a booker in scope only by their booking is not in the
  tagged contacts poll, D117). The name goes on the booking (`set_by`, only when blank), so the numbers credit the setter,
  and Health check says ✅. A booking gone from the ledger closes it quietly. A cancel does not: a person resolves it.
- **It fires in shadow and test as in live**, as the engine's other alerts do: an alert is not a run (D76: "The operator's
  alerts are not runs and still go"; D88: the engine collects, Health check says it; D117's tag refusal and D119's
  deposit check are raised whatever the mode). Dating Nelly has every workflow off, Health check included, so until it is
  on the alert is on the dashboard and not in Slack.
- **Every company.** A question calendar with no answer is self-booked (D24), never this alert. Hair (the `calendar` rule;
  "45 Min Strategy Call - S" is its setter event type) and PMU (`booking: "setter"` on "The Beauty Moguls Consultation S")
  alert only when the setter question has no answer: Calendly's answer is trimmed, so blank or spaces is none; any words
  are an answer, read as given (no reading of what they mean). Production, read-only 2026-10-16: Hair's two setter-booked
  Calendly bookings both named a setter; PMU has no setter-booked booking yet. So none would have fired on their history.
  But PMU's Consultation S has no setter question yet (open item 34): until it has one, every booking on it has no answer
  and alerts, which is the rule as Tyler gave it; add the question before Annabelle starts setting.
- Not changed: Call booked's booking card still says "Setter: unknown" when it posts before anyone says (the alert is the
  error, the card is not edited after).

Tests: `provision.test.ts` (a fresh location: the group made and the calendars made in it with Nelly; the calendars as
the first run left them: the dry run only reads and gives the exact before → after, apply makes the group and PUTs exactly
the three with only `teamMembers` and `groupId`, the other business's calendars and group untouched, a second run only
reads; one who stays keeps their place and a group made by hand under the name is used; a calendar in someone else's group
not moved and a taken slug making nothing; the guard refusing an undeclared calendar, another key, another group, a group
PUT, a dry-run write and a delete), `setter-missing.test.ts` (a GHL setter booking raises one error in shadow, worded as
above, a self or question booking none; the Setter field typed in GHL closes it and fills `set_by`; a field filled before
the booking does not; a dial during the booking names the setter and nothing is raised; Calendly in Hair's and PMU's
shapes alerts only without an answer; blank and spaces are no answer). Removing the poll's call turns 5 of the 6 red.

Applying it on RapidCloser (2026-10-16) showed GHL's calendar PUT is not a patch: a PUT carrying only the team and the group
reset each Dating calendar to 30 minutes with no open hours (and filled its other unset settings with GHL's defaults). They
were restored by hand to 45 / 45 / 15 minutes, Mon–Fri 9–5 (no booking had been made). The script now sends every calendar
PUT with the calendar's own length, interval and hours as GHL already holds them, and the test's fake GHL resets what a PUT
leaves out, as GHL does; without the fix three tests fail.

## D122. Typeform straight into the engine: the engine's own signed webhook, every answer a contact field, an importer for the rest (2026-10-16)

Dating Nelly's intake is the Typeform "VIP Matchmaking Application" (`AjY7UfXZ`, 285 completed responses on 2026-10-16). Tyler,
2026-10-16: no Zapier, the engine connects to Typeform directly; every answer becomes a GHL contact field in its own section;
the engine registers its own webhook and keeps it registered (open item 34); the old responses are imported, and the import is
the very last step, which he approves then.

**The install key.** `typeform: { token, forms: { "<form id>": { name, answers: { <ref>: <target> }, hidden: { <name>: <target> },
submittedAt, responseId, tags? } } }`. The token is bound as `secret.typeform_token`, the map as `typeform.forms`; omitted, both
stay as they are. Answers are mapped by the question's `ref` (stable ids; the words can change, a ref does not). A target is
`first_name`, `last_name`, `email`, `phone` (GHL's own contact fields) or a contact field binding (`field_contact_…`, as in the
install's `crm`); hidden fields, the submission time and the response id go to contact fields. With a token, install reads each
form and refuses a ref that is no question of it or a hidden name it does not have. Dating Nelly's map is in
`installs/dating-nelly.json` (and the setup's `install` block): 21 questions, the six hidden fields to the existing
"Dating – UTM …" and "Dating – fbclid" fields.

**The webhook.** Install (with `typeform` and a token) registers one webhook per mapped form: `PUT /forms/{id}/webhooks/{tag}`
with `{ url, secret, enabled: true, event_types: { form_response: true } }`, the URL `<PUBLIC_URL>/api/webhooks/typeform/<company
id>`, the tag `biab-<slug>` (bound as `typeform.webhook_tag`) and a secret the engine makes once (`secret.typeform_webhook`,
`tfwh_…`); a re-install or a re-register sends the same tag and secret, so it changes nothing Typeform already has right. A form
whose map writes a field the company has not bound is not registered (the door opens only when every answer has somewhere to
go), and the install says so. A delivery's `Typeform-Signature` must be `sha256=` + the base64 HMAC-SHA256 of the raw body with
the secret; a missing or wrong one is a 401 and records nothing. Every health sweep (`typeform_webhook`) reads the webhook back
(`GET /forms/{id}/webhooks/{tag}`): gone, turned off, no longer sending form responses, or sending anywhere but this engine's URL
is an error alert with **Re-register the Typeform webhook**, which PUTs it back (`/health/fix`, provider `typeform`) and sweeps
again; a refused token is an error, a Typeform that does not answer a warning.

**A submission.** Idempotent by the response id (`form_response.token`): the first delivery is kept in `webhook_deliveries`
(`typeform`, `<form>:<response>`), so Typeform's retries are no-ops; anything that fails before the end rolls back, so Typeform's
retry does it again. Then:
- *The person in GHL*, as Tyler said: by email, then by phone (`GET /contacts/search/duplicate`, one of the two per call). If GHL
  has neither, the ledger's GHL id for that email or phone stands in (GHL's search can lag a contact made seconds ago). In
  RapidCloser another business's contact may match: the same human, so the same record.
- *The write* follows the mode as D117's tag write does: `effectiveMode` over `handlerMode("form.submitted")` (no workflow answers
  it today, so the company's rung). In shadow (and in test for someone who is not a test contact) nothing is written to GHL and
  the would-be write is the record: `form.submitted` carries `shadow: true` and `would_write` (create or update, the standard
  fields, the tag, every field by binding with its value), and `tag.added` is recorded `shadow: true`, as D117 records the tag it
  would have added. Real: a new person is made with `POST /contacts/` (the tag, the standard fields, every bound field, `source:
  "Typeform: <form name>"`); a person GHL has is updated with `PUT /contacts/{id}` (the fields only; never `tags`, which GHL's spec
  says replace them all) and the tag added with `POST /contacts/{id}/tags`. A create GHL refuses as a duplicate is found again
  and updated. Then the contact is read back and replicated, so the ledger holds the GHL id and the tag.
- *A contact GHL already has keeps its own name, email and phone*: only blanks are filled; a differing one is listed in the event
  (`kept`). Chosen because in a shared location the record may be another business's and its details theirs; the application
  fields and UTMs are the company's own and are always written. A blank answer and a blank hidden field write nothing, so the
  UTMs of an earlier touch are never wiped (older responses have no UTMs).
- *Choices are TEXT* (Tyler): a choice is its label (or what was typed under Other), several are joined with ", ", yes/no is Yes
  or No, the age is NUMERICAL, the long answer LARGE_TEXT, the submission time is Typeform's `submitted_at` as given (ISO, UTC),
  the response id as is, the consent the acknowledgment's words.
- *In scope (D117)*: `form.submitted` is recorded with the person, and someone who submitted one of the company's forms is in
  scope like a booker (`scopeSql`, `stillInScope`), so in shadow, where the tag is only what would have been written, the
  applicant is still the company's person.
- *New lead: yes, once.* A submission from someone the ledger did not know (by GHL id, email or phone) records `lead.created`
  (source `form`) and starts New lead, exactly as the contacts poll does for a newly tagged contact. Why: the application is how a
  dating lead arrives, and the person is new to the company whether or not the other business has them in GHL; waiting for the
  poll would do the same a few minutes later in live and never in shadow (nothing tagged in GHL), so shadow would not show New lead
  at all. Made here and once: the replica is written with the GHL id and the tag before the poll can see the contact, so the poll
  finds no one new. A second application from someone already known is `form.submitted` only.
- *Qualification* (MQL / DQ) is not decided. The place for it is D73's `qualify` over one of these bound fields, or a workflow on
  `form.submitted` (it carries the person, the form and the response; the values are in GHL). Nothing reads an answer as a rule.

**The importer** (`src/engine/typeform-import.ts`; `scripts/import-typeform.ts`, or `POST /api/admin/typeform-import { company,
form, apply?, limit? }` in production). It reads every completed response through the Responses API (`page_size` 1000, `before`
the last token) and puts each through the same path as the webhook, oldest first (a person who applied twice ends with the latest
answers). The dry run is the default and writes nothing anywhere (not GHL, not Typeform, not the engine's tables); it reports how
many would be created, how many match a GHL contact by email or by phone, the duplicates within Typeform, the partial and
opened-only responses (never imported), and the fill rate of every mapped question and hidden field. Apply is decided as
recommended: an explicit `--apply` / `apply: true` that writes for real **whatever the company's mode**, a deliberate one-off as
D115's backfill was, because Tyler approves the import as the last step himself. It writes up to `limit` (50) responses per call,
each in its own transaction, and skips a response already written (`webhook_deliveries` `typeform_ghl`, set only by a real write),
so it is safe to re-run and a batch carries on where the last stopped. A response the webhook only shadowed is still written by
apply, without a second `form.submitted`. History starts nothing: no `lead.created`, no workflow; the replica is written with the
tag, so the next poll does not take the imported people for new leads either. Each write is in `audit_log` (`typeform.imported`).

Dry run on 2026-10-16 (real Typeform, real RapidCloser GHL, reads only; `typeform-import-dryrun.txt`): 285 completed responses
(2026-10-08 → 2026-10-16), 3 partial, 202 opened only; 282 people; 3 emails submitted twice; 1 matches a RapidCloser contact by
email (whose phone differs, kept), 0 by phone only, 281 are not in GHL, so apply would create 281 contacts and update 4 times;
every question 99–100% filled except the consent (1 of 285: it is optional on the form) and the long answer (282); the six
hidden fields are empty on every response so far (added today). Tyler's CSV (277 rows) agrees: 275 in both, its 2 others are the
API's partial responses, and the 10 newer completed responses were submitted after the export.

**The application fields** are in the setup (`installs/dating/ghl-setup.json`, `contactFields` with `folder: "Application"`), 19
contact fields "Dating – …" in the contact-field folder "Dating – Application". Whether GHL's API can make a contact folder:
- GHL's own spec (`GoHighLevel/highlevel-api-docs`, read 2026-10-16) documents folders only for custom objects and the company
  object (`POST /custom-fields/folder`: "Only supports Custom Objects and Company (Business) today"); its contact-field create
  (`POST /locations/{id}/customFields`) documents neither a folder nor `parentId`.
- RapidCloser read-only: a contact folder is a custom field with `documentType: "folder"`; the field list leaves folders out and
  gives each field a `parentId`; `GET /locations/{id}/customFields/{folderId}` answers the folder ("Additional Info", "General
  Info", "Contact", and another business's own "Everflow Data"). The v2 route refuses contact folders ("Fields with model contact
  is not supported on this route").
- This repo's first build made a contact folder by API on the template location (`ghl/build-backend.sh`, 2026-09-12: `POST
  /locations/{id}/customFields` with `documentType: "folder"`, its fields by `parentId`; `ghl/00-state.md` records the 32 fields in
  the folder "Core System").
So it can be done, but only by an undocumented call, proven once by our own script and not yet in RapidCloser. `provision-ghl`
makes the folder that way and the fields in it by `parentId`; if GHL does not make it (or gives no id) the plan says `blocked` and
the fields are made without a folder, the manual step being to make the folder in GHL and move them. Folders are found by the
`parentId` their fields name (the list never shows a folder), so an empty folder is not seen: a run that made the folder and
then failed before any field may make a second one (delete the empty one by hand). A field made earlier outside its folder is
bound and said (`exists-differs … not moved`), never PUT (D121: a GHL PUT resets what it is not sent). Dry run on RapidCloser
(2026-10-16, `dn-appfields-dryrun.txt`): create the folder and the 19 fields; the other 90 lines `exists`.

Also: `CrmRead.findDuplicate`; `createContact` takes tags, custom fields and a source, `updateContact` an email; the setup page shows
the Typeform door and its token; the event type `form.submitted` (category lead) is in the schema.

Not done, and why: no `form_response_partial` (a partial is not an application); answers are not kept in the engine's tables
beyond the shadow record (GHL holds them, as D29 and D89 keep the ledger lean); the folder call is unproven in RapidCloser until
the apply; the setter is not told about a new application (New lead and the setter board do that, once on).

Tests: `typeform.test.ts` (install binds the token and map and registers one signed webhook per form, a re-install keeps the tag
and secret, an unknown ref is refused, an unbound field keeps the door shut; a bad or missing signature, or a body changed after signing, is a 401 and
records nothing; shadow writes nothing to GHL, records the would-be write and a shadow tag, the applicant in scope untagged and a
new lead once; a retry is a duplicate; live, a new person is one contact with the tag and the fields by ref (answers out of order,
an unmapped question, a reworded title) and the poll makes no second lead; another business's contact matched by email keeps its
own name and gets the tag added on its own, one matched by phone is updated, never recreated; a known person's second application
is no new lead; the dry run writes nothing and counts creates, matches, duplicates, partials and fill rates; apply writes each
response once, oldest first, whatever the mode, starts nothing, re-runs write nothing, a shadowed response is written once; the
sweep says gone, elsewhere and off with the button, and the re-register puts it back), `provision.test.ts` (the folder and its
fields, a second run a no-op, a field outside the folder bound and not moved, a folder GHL will not make). Each fails without its
code: dropping the signature check, the idempotency, the mode, the phone lookup, the blank-only rule, the separate tag add, the
scope rule, the replica after the write, the importer's written check, the health check or the door's lead turns 1–4 of the 12
red; dropping the folder's `parentId` or the folder read turns 5 of the provision tests red.

## D123. Dating (Nelly) books in her Calendly; a booking runs one of her two booked workflows; an applicant's tag and New lead are a workflow (2026-10-17)

Tyler, 2026-10-17: switch Dating (Nelly) from the three GHL calendars to Nelly's Calendly (nellysudri@gmail.com), where her
bookings really happen, with exactly two event types mapped; a Strategy Session booking also tags `stat-triage-first`. Then,
the same day, the design changed: two booked workflows instead of one Call booked plus a tag, and a visible workflow for what
a new applicant gets, so the tag is on a chart and not in the Typeform door's code; and the imported applicants run through
the new lead automation.

**Her Calendly, verified read-only (2026-10-17, `GET /users/me`, `/organization_memberships`, `/event_types`, `/scheduled_events`).**
The token is Nelly Sudri's (owner); the organization has one other member, "shawnee" (sobregn@gmail.com, one event type
"Dating Consultation"). Twenty event types in all: nineteen Nelly's (two inactive, two "Blush" collective) and shawnee's one.
Mapped, both closing, both self-booked, both with one optional question ("Please share anything that will help prepare for our
meeting."), no phone and no setter question:
- `86985d27-22e5-4b6b-ab66-8e68e9ee8e30` "Complimentary Dating Strategy Session ♡", 15 min, the Typeform's link: its own call type
  **"Strategy session"** (D101), `bookingCalendar` (the self-book link the templates send);
- `80955126-29fe-48ea-a85e-ba4bcd145790` "Private Dating Consultation with Nelly" (trailing space at Calendly; listing trims it),
  60 min: its own call type **"Consultation"**, the `closerCall`.
Nothing else is mapped (the 15-Min Discovery Call and the Private Dating Strategy Call are kept for a later setter triage). The
three GHL calendars stay built in RapidCloser, unmapped: a re-install with `booking.source: "calendly"` turns the GHL calendar rows
inactive and drops their poll cursors (they hold no booking). Install takes the token as `booking.token` in the body (from
`DN_CALENDLY_TOKEN` at install, never in the file) and binds `secret.calendly_token`, `calendly.organization` (the token user's
organization) and `calendly.user` from `booking.userEmail`, which must be a member of that organization; it narrows nothing (every
member's event types are listed, only mapped ones are polled, D26), so the install's doc comment that said it narrowed is fixed.

**Closing with a named type, not first_call: right.** No shipped template or PMU copy triggers on `first_call` (grep: none
mentions it), so a `first_call` mapping would run nothing; the Strategy Session is a self-booked call with Nelly that the team
works like a closing call. As PMU's "Demo call" (D101), a named type under `closing` counts as a closing call in every number,
and Call cancelled, Call outcome filed, Pre-call sequence, Cancellation rebook and the end-of-day form, all on the category,
take both types unchanged.

**Two booked workflows, her own (Tyler's change).** *Triage call booked* (a Strategy session) and *Sales call booked* (a
Consultation) are Call booked with both triggers held to the call type (`{"eq": ["{{appointment.term.name}}", "Strategy session"]}`),
the Sales Call's `call_type` written (`strategy_session`, a new option; `closing`), and on Triage `stat-triage-first` added to the
booking's two tag steps (s5, b6). Each calendar is mapped to its own type, so a booking matches exactly one trigger; a reschedule (same event type
at Calendly) runs the same one again. The match is on the call type, not the calendar id: the type is the calendar's by the
install mapping, it reads on the chart ("term name is “Strategy session”", the same words PMU's chart already uses for the
term name), and D112 holds every chart free of ids. Built by `scripts/build-copies.ts dating-nelly` from
`installs/dating-nelly/copies.json` (`booked`: workflow, name, call type, Sales Call call type, tags) and the install file; the build
refuses a call type no calendar books and a closing calendar no booked workflow takes (that booking would run nothing).

*Their shape: one card fork, as PMU's (Tyler, on her Call booked chart: "the workflow is still fucked up").* The shipped Call
booked runs the paths' tag steps into the video task (only if not a reschedule), then a dashed "slot the call moved from"
record with an otherwise bypass. Tyler had said for PMU that the video task belongs under the new booking and the reschedule
under the rescheduled card (D105, D107); both of hers are built that way, on her two boards (the Hair model): the setter and
self paths keep what says how the call was booked (the remembered values, plus `card_suffix` "Direct" / "Setter Booked", the
setter on the contact, the setter card to Direct Booked / Appointment Set, the tags), then one fork "A new booking or a
reschedule?": *a new booking* moves the closer card to Scheduled named "-- Direct" / "-- Setter Booked" (c_new), then the video
task (k3); *a reschedule* moves the closer card to Scheduled only off Scheduled or Cancelled / No Show, keeping its name (c_rs,
D105: her board has no Rescheduled stage, and a card in Follow Up or past the call is left alone), then logs the old slot's
Sales Call rescheduled (k5); both rejoin at the Sales Call record (k4), the Slack card's look, the Slack card and Done.
Dropped from the template, and only these: s4 and b5 (the closer card inside each path, now c_new and c_rs) and the `only_if`
of k3 and k5 (the fork's ways say it). A step-by-step check holds every other node to the template's own. The triggers carry a
label naming the call type. Charts rendered at desktop and phone width (`scripts/render-charts.ts`): every step drawn, tidy
and exact (D111), no "otherwise" bypass but New from Typeform's one real sometimes-step.

*Why not the generic tag option first asked about* (a calendar mapping `tags`, applied by Call booked or by the engine at
booking): in the shipped Call booked it adds a step to Hair's chart (Hair's copy tracks the template), which must not change;
applied by the engine it is a write on no chart (D111), the opposite of what Tyler asked; and after the redesign the tag sits in
her own Triage workflow's tag steps, where the chart draws it. So no `tags` option was built.

**A company's own workflow, and taking over a template** (new, generic). There was no way to make a workflow that is not a
template's copy. `createCompanyWorkflow` (`definitions.ts`), through `POST /api/admin/workflows/definition` with
`create: { stage?, sort?, takesOver? }` and a name the company does not have: validated and drawn exactly as a save (D100, D111),
made OFF, version 1, `template_id` null, origin `company`, triggers synced, audited `workflow.created`; `dryRun` makes nothing.
`takesOver: "call-booked"` (new column `workflows.takes_over`) means the template's job is done by the company's own workflows:
`installTemplates` never puts it back ("call-booked → not installed: the company's own “Sales call booked” and “Triage call booked”
do its job"), and the create is refused (409) while the company still has the template's copy, which is removed first with the
existing `DELETE /api/admin/workflows` (refused while on). So no booking can run Call booked and one of hers. Her Call booked is
removed, not just off: off, a later toggle would double every booking. Production, read-only: it is off with 0 runs.

**New from Typeform (Tyler's change), and what stays in the door.** The door keeps what only it can do: verify the signature,
take a response once, find the person in GHL (email, then phone, then the ledger's id), write the answers and UTMs as the mode
allows, keep the ledger's person, record `form.submitted` with the person (in scope by it, D117/D122) and dispatch it. Moved to a
workflow, because they are decisions about what an applicant gets, which belong on a chart (D88, D111): the scope tag and New
lead. Her own *New from Typeform* (built by the same script from `copies.json` `fromForm` and the install's `scopeTag`): on
`form.submitted`, tag `dating`, then `record lead.created` with `start: true` **only if they are not a lead** (`contact.is_lead`,
a new context fact: a `lead.created` exists for them), then done. Its rung is the door's write rung too (`handlerMode("form.submitted")`).
The door no longer writes a tag or emits `lead.created` (the map's `tags` key is gone; install refuses it with the reason).
Consequences, accepted: with New from Typeform off, a submission is recorded and starts nothing, and a real write leaves the GHL
contact untagged (the person is still in scope by the submission); a person's first application decides the lead at the step,
not at the door, so an applicant whose Calendly booking was polled first (a replica, no lead) still becomes a lead.

*Scope stays right in shadow:* the submitter is in scope by `form.submitted` (`scopeSql`, `stillInScope`), recorded before the
workflow runs, so the tag being only a would-have in shadow changes nothing.

**New lead once a person, by every door.** (1) New from Typeform's check, at the step, in the run's own transaction (a retry finds
the event its record step wrote, D87). (2) A replica the door made without a GHL id (shadow writes nothing to GHL) that GHL later
shows, tagged by hand or created by anyone, used to be a new lead again (the D65 addendum's "a new CRM record is a new lead"):
`newLeadOnUpsert` (`poll.ts`) makes that adoption no new lead when the person is already one, in the contacts poll, the booking
path (G16) and the drift sweep. Only a form makes a lead of a replica with no GHL id, so a company with no form is unchanged
(production read-only, 2026-10-17: Hair 2 and PMU 5 contacts without a GHL id, 0 of them leads).

**The importer's `newLead`.** `applyImport({ newLead: true })`, `--new-lead`, `"newLead": true` on `POST /api/admin/typeform-import`;
default off (history starts nothing, as D122). The importer's own write is unchanged (real whatever the mode, the scope tag
included: history the workflow never saw, so GHL and the tagged poll know them). With it, each newly imported response the
webhook never saw is recorded and dispatched as `form.submitted` exactly as the webhook dispatches one (`new_lead: true` in its
data), so New from Typeform runs for it in its own mode and New lead starts once a person (someone who applied twice, imported
twice, is one lead); a response the door already took is never run again; `runsStarted` is in the answer. Imported in shadow,
New lead runs in shadow (would-be card and tag), while the GHL write is real: the import is a write, the automation follows its mode.

**New lead only for someone in scope (Tyler's item 5).** Every `lead.created` today, with file:line:
- the contacts poll, `poll.ts:115`: the search is tagged and each row held to the exact tag (`poll.ts:110`);
- a GHL-calendar booking's new person (G16), `poll.ts:216`: the appointment row on a mapped calendar is inserted first
  (`poll.ts:206`), so they are a booker; not reachable on Calendly (an invitee is no CRM record);
- the drift sweep, `ledger-drift.ts:100`: only contacts GHL carries the tag on (`ledger-drift.ts:88`);
- New from Typeform's record step (`executor.ts:785`, `record` with `start`): runs on `form.submitted`, whose person is a submitter.
New lead triggers only on `lead.created`; nothing hands off to it (`start_workflow`: no template or copy names it). The old door
dispatched `lead.created` before it recorded `form.submitted`, a moment when the replica's own rule would have said out of scope.
Closed for any future door or step: `dispatchEvent` (`dispatch.ts:78`) starts nothing on a `lead.created` for a contact out of the
company's scope (by `inScope`: tagged, a booker, or a submitter) and audits `scope.lead_refused`; with no scope tag (Hair, PMU) it
reads nothing. **Not** a "has tag dating" condition step: in shadow the tag is only recorded, never on GHL or the replica, so an
untagged booker or applicant, in scope by D117/D122, would be dropped from New lead in exactly the mode used to watch it.

**What the first poll does with her bookings.** Read-only, 2026-10-17: in the poll window (2 days back, 60 ahead) 97 active
bookings on the two types (89 Strategy Session, 8 Consultation; 87 of them still ahead, 10 in the last two days) and 2 cancelled
Strategy Sessions; none beyond 60 days. Each mapped event type is a new poll entity with no cursor, so the first poll is a silent
baseline: appointments and contact replicas only (by email; no GHL id for anyone not in GHL), no event, no run, no scope tag write,
no setter alert. Only bookings made after it are news.

**Hair and PMU unchanged.** No shipped template and no PMU copy changed. The charts (`chartOf`) and node words of all 30 templates
and 9 PMU copies are byte-identical on the base commit and here (a first draft gave `appointment.term.name` the words "call type",
which changed PMU's "Remember the call type · by the term name"; the words test caught it and it was dropped). New code reads
nothing for them: the dispatch guard needs a scope tag; `newLeadOnUpsert` differs only for a replica with no GHL id that is a lead
(0 on both); `takes_over` is null on every workflow they have; `contact.is_lead` is a new fact no template of theirs reads.

**GHL.** `installs/dating/ghl-setup.json`: the Sales Call's `call_type` gains `strategy_session` "Strategy Session" (keeps `closing`,
labelled "Strategy Call" since the GHL calendars; not renamed, provision only adds). Dry run on RapidCloser (2026-10-17,
`dn-calltype-dryrun.txt`): exactly one change, `missing-on-ours options of custom_objects.dating_sales_call.call_type — adds
strategy_session (keeps closing)`; the other 109 exist. Not applied.

Tests: `dating-booked.test.ts` (made through the definition route: refused while Call booked is there, removed with DELETE, dry
run, made OFF at version 1 with their triggers, audited, a re-install does not put Call booked back; a Strategy session runs only
Triage call booked, with stat-triage-first and call type strategy_session, a Consultation only Sales call booked with closing and
no triage tag; a reschedule runs the same one again and logs the slot left; a cancel runs Call cancelled; a filed outcome runs Call
outcome filed on that call's record; a new booking's run takes c_new and k3 and never c_rs or k5, a reschedule's the opposite),
`dating-copies.test.ts` (the three files are the build's; the booked ones are Call booked less s4 and b5, plus the fork and its
edges, every other node the template's but the call type, the Sales Call's call type and Triage's tag; New from Typeform's steps; the build refuses an untaken closing calendar and a type
no calendar books), `typeform.test.ts` (the door writes no tag and makes no lead; shadow: New from Typeform records the tag and
makes one lead, New lead runs; live: the tag is the workflow's write; a second application skips the lead step; `newLead` import:
one lead a person over two responses, a response the door saw not run again; a shadow-made lead turning up tagged in GHL is not a
second lead; a `lead.created` out of scope starts nothing and is audited, tagged it starts New lead). Each fails without its
change: the dispatch guard 1, the adoption guard 1, the door's tag 3, install putting Call booked back 3, the create not refusing 3,
the import dispatch 1, `contact.is_lead` 6, booked workflows on the category instead of the type 2. The chart tests hold the three
new files to D111 (tidy, exact).

## D124. Quiet when empty: a scheduled post with nothing in it is not posted, for a company that says so (2026-10-17)

(Numbered D124: D123 is left to an entry being written in parallel.)

Tyler, for Dating (Nelly): "for this client I want nothing to post if nothing happened." The Daily wrap-up posted
"Nothing today: no leads, bookings, calls or payments." every evening, the weekly and monthly ones their own "Nothing last
week/month", and the Weekly leaderboard "_No closes yet._ / _No sets yet._".
- **The setting.** Per company: install key `quietWhenEmpty: true` (bound as `reports.quiet_when_empty`; omitted on a
  re-install it stays as it is, `false` turns it off). It is one of the engine-level settings the Settings page offers, so
  D109's `POST /api/admin/bindings/set` takes it too. `src/engine/quiet.ts` holds the key and the words.
- **What opts in.** A `slack_post` names the step before's own fact: `quiet_when_empty: "vars.report.nothing"`. With the
  setting on, a scheduled run where that fact is `true` posts nothing: the step is skipped, the run log says "nothing
  happened, so nothing was posted (quiet when empty)", and the send is kept `suppressed` ("quiet when empty: nothing
  happened") with what it would have said, as every other suppressed post is. A run started by hand (`fireNow`,
  `event.manual`) posts whatever it holds: someone asked. The report step still keeps its wrap-up in `wrapups`.
- **"Nothing" is the data's, per workflow, never the words.**
  - Wrap-ups (daily, weekly, monthly): `report.nothing` (`nothingHappened` in `reports.ts`) is true when every registry
    number the step read is zero or unread, every count in the show-rate breakdown (calls due, showed, no-shows, cancelled,
    missing outcomes, rescheduled) is zero, nobody answered a booking or intake question, no per-closer or per-setter line
    has a number, and GHL was read. A GHL read that failed is not nothing: what it would have said is not known, and the
    post says GHL could not be read.
  - Weekly leaderboard: `board.nothing` (`nothingOnBoard` in `leaderboard.ts`) is true when no closer has cash or a close
    and no setter has a set (a closer listed only for shows, or a setter only for the show rate of earlier sets, is not
    something; a close counts when GHL holds no Payment records, since the board ranks by closes then).
- **Audited, unchanged** (they already post only when there is something): Calendar availability and Health check post
  only through alerts, raised for a finding and said by Health check's alert ways (raised, still open, resolved); a sweep
  with no finding raises nothing and posts nothing. Ledger drift starts only on a finding (`drift.*`) and writes GHL,
  never Slack. The EOD reminder's check stops at "nothing to file" when nothing is due, and its operator line is
  `only_if` something is overdue two days. EOD filed starts only when a closer files. None of them carries the field.
- **On the chart** (D111, D103). For a company with the setting on, the post is a sometimes-step: dashed, "only if something
  happened; otherwise skipped" under its words, the popover "Only if something happened: this company posts nothing when
  nothing happened (quiet when empty); a run started by hand posts anyway. Otherwise it is skipped and the run goes on."
  (`chartOf` reads the company's bindings, as the workflow and run pages pass them.) For any other company the post always
  runs and is drawn so: the chart is the chart before D124, node for node and SVG for SVG. The skip goes on by the normal
  edge, so no line is added; D111's check holds the chart exact either way.
- **Without the setting nothing changes.** The four templates differ from before only by the field (and a sentence of
  description); the facts gain a `nothing` value nothing else reads. Hair's four copies are edited (diverged) and do not
  take a template upgrade; PMU's are untouched and, upgraded, post byte for byte as before (it has no setting).
- Apply, for Dating (Nelly): re-install with `installs/dating-nelly.json` (now `"quietWhenEmpty": true`), or set the one
  binding with `POST /api/admin/bindings/set { company: "dating-nelly", key: "reports.quiet_when_empty", value: "true" }`;
  then `POST /api/admin/templates { company: "dating-nelly", templates: ["daily-wrap-up", "weekly-wrap-up",
  "monthly-wrap-up", "weekly-leaderboard"] }` upgrades her four untouched copies.
- Tests: `quiet.test.ts` (the wrap-up's nothing from numbers, calls, a name list GHL hands over, answers, a failed read and
  per-person lines; the board's from cash, closes and sets; the setting's values; only the four templates opt in; the chart
  with the setting on, exact at both widths and saying "something happened", and without it or set false equal to the chart
  of the template without the field, SVG and all; on an empty Monday with the setting on neither the wrap-up nor the
  leaderboard posts, each step skipped with the reason and its send suppressed; something in the day posts; a run by hand
  posts even when empty; without the setting and with it false the templates now and before D124, side by side on one
  company, post the same text and record the same step results; install binds, keeps and turns off the key). Turning the
  executor's check off turns the empty-day test red.

## D125. The harness stages a Typeform application, and books on the calendar it is told (2026-10-17)

Tyler wants a full synthetic end-to-end test of Dating (Nelly) run by the operator: application → Strategy session → reschedule
→ cancel → Consultation → recording → end of day → deposit → payment → signature. The harness (D23) had two gaps: an applicant
could not be staged (her people arrive through the Typeform door, D122/D123), and a booking always went on the closer call's
calendar, so the Strategy session (Triage call booked) could not be staged at all.

**`form`.** `{ company, contact: <email>, action: "form", form?, answers?, responseId? }`. Unlike every other action the person
need not exist: an application is how a person arrives, so the door finds or makes them. The harness builds a synthetic
response from the company's form map (`typeform.forms`): every mapped question answered plausibly (the email as given; a phone
from the 555-0100…0199 range kept for fiction, one per email, so GHL's phone lookup finds no real person; UTM source `sys-test`),
`answers` overriding by ref, target or hidden name (a key the form lacks is refused, not ignored). It goes through
`takeDelivery`, now the one function the signed webhook calls after the signature check, so the GHL lookup and write, the
ledger's person, `form.submitted`, New from Typeform and New lead are the live ones; the only difference is `simulated: true` on
the event. The write follows the mode as always: real for a test contact in test (and live, forced), would-have in shadow.
Typeform is never called.
- *Only a test contact (D97)*: an email on a test domain, or someone the ledger already holds who passes (`sys-test`). Someone
  GHL alone tags `sys-test` is refused: the harness would have to read GHL to know, and the door would then write to them.
  Refused while live unless forced, as every action.
- *One application per response id*: the id is `sim-` + a hash of form and email, so the same request twice is the door's own
  duplicate (`webhook_deliveries`); `responseId` names a second application (New from Typeform again, no second lead).
- *Reset* removes the delivery marks of the person's `sim-` responses with the rest, so the same `form` is a first application
  again. A real response's marks stay: Typeform's retries must stay no-ops. The contact stays, as for every reset (in test mode it
  mirrors the GHL contact the door really made; GHL is never undone).
- From the contact page or a `sys-test-form` tag it applies with the contact's own email (both now pass the CRM adapters).

**`calendar`.** `book`, `book-self`: the calendar to book on, by external id, call type name (any case) or the calendar's own
name, among the company's active mapped calendars; unknown is refused naming the ones there are. Without it, as before (the
closer call). `reschedule`, `cancel`, `record`: the latest open staged booking on that calendar. The fix that matters: the staged
booking's and reschedule's run context now carry the call type's **name** with its category (the poll always did), because D123's
booked workflows match `appointment.term.name`; without it a staged Strategy session or Consultation ran neither. The booked
event carries `calendar_id` as the poll's does. `reschedule` also takes `startsAt` and keeps the booking's length.

**Also, found checking every action on a Calendly company and a form-made contact.** `pay` takes `deposit: true` (D119: the
company's first declared deposit product, else a product named "Deposit (test)"; default $100), so deposit → balance can be
staged. `call` dialed as the first active GHL user by name when there was no setter: in RapidCloser that is the other business's
staff (production read-only: Dating has no setter; 12 of 14 users are staff), so the caller is now a setter, else one of the
company's own closers or managers. `record`, `agreement`, `sign`, `cancel` needed nothing.

Tests: `simulate-form.test.ts` (the real Dating install file, Calendly calendars, her three own workflows; shadow: the person is
made, `sim-` id, no GHL write, New from Typeform and New lead once; the same request is a duplicate, a new `responseId` a second
application and no second lead, an unknown answer key refused; an email on no test domain refused with nothing made, live refused;
test mode: the GHL create with the answers by ref and the `dating` tag for real; reset then the same `form` is first again; a
Strategy session runs only Triage call booked and a Consultation only Sales call booked, reschedule and cancel by calendar, no
calendar is the Consultation; record, call (never the other business's staff), deposit, balance, agreement, sign; the route).
Each fails without its change: the term name 3, the calendar choice 2, the deterministic id 1, the reset 1, the test-domain gate
2, the caller 1.

## D126. The harness files one staged call's outcome, as the end-of-day form does, without filing the closer's day (2026-10-17)

The synthetic journey stopped at the outcome: the only way to file one is the closer's end-of-day link, and the operator has no
way to it (the query door hides `report_token`, as it should, and the listing is behind the dashboard sign-in). Filing through
the link would also be wrong for a test: an end-of-day report is the closer's whole day, so it would store Nelly's real day as
filed, post its summary and stop her reminders, for one fake call.

`outcome` (admin route and `sys-test-outcome`) takes `outcome`, one of the company's end-of-day answers by value or label, and
files it for the latest open staged call that has started, as its closer, through `fileCall`: the per-call body of `submitEod`,
moved out unchanged so the form and the harness are one path (the same answer twice is held, not filed twice). A money answer's
cash is `amount`, else the program price, a deposit 100; revenue only on a close (D119). No `eod_reports` row, no `eod.filed`.
Refused: an answer the company does not have (the refusal lists theirs), a call that has not started (only those are on the form),
no staged call. The end-of-day form itself is checked by a person once, on a real call.

Tests: `simulate-form.test.ts` (the journey files Deposit for $250 after the recording: showed + deposit on the ledger, the note,
Call outcome filed once, the second filing held, no report stored; the three refusals) and `eod.test.ts` unchanged and passing.

## D127. An unreadable Slack channel is one Health check alert, naming the permission to add (2026-10-17)

Dating's ops-test channel is private and the bot had no `groups:read`: Slack answered `missing_scope` for it, and Health check
raised one red alert on the slack check plus one per enabled workflow step that posts there (22 in all, each re-said after an
hour), for one cause. Tyler, asked whether alerts sharing a cause should be one: "Yes".

The slack check already reads each bound channel once. It now names every setting that points at the channel, and for
`missing_scope` the permission Slack says is `needed` (`groups:read`: the channel is private), what to do (add it under OAuth &
Permissions, reinstall the app) and that posts may still land. The steps check leaves a channel it cannot read to the slack
check, as it already did for membership; with the slack check off it still says it per step. The steps' own alerts close on the
next sweep. The canonical manifest gained `groups:read` the same day.

Tests: `health.slack-scope.test.ts` (one channel on three settings, missing_scope → one finding with the text, its steps
verified; another channel not found still said once; slack check off → per step). The first fails without the change.

## D128. A workflow a payment starts says it needs Whop, without being kept off (2026-10-17)

Tyler: "The payment failed should also need the Whop API key." Payment failed showed ready (its only setting is a Slack channel)
while it could never start: Dating has no Whop, and every payment the engine knows came from Whop (Hair and PMU, `pay_…`).

Readiness gains `needs`: a source a workflow's triggers come from that the company has not connected, by name. Today one: Whop,
for any `payment.*` trigger, connected by `secret.whop_api_key` or `secret.whop_webhook`. A workflow with a need is not ready:
the dashboard tag says "needs Whop", and a warning says it never starts until Whop is connected. Unlike `missing`, a need does not
refuse turning it on, because the harness stages payments to test those workflows before Whop exists (Dating's journey did).
A Zap that posts payments is not counted as a source: no company sends them that way.

Tests: `readiness.whop.test.ts` (Payment failed, Payment recorded and Deal closed need Whop, New lead does not; the warning; it
still turns on through the admin route; a webhook secret, or an API key, connects it).

## D129. A team member's Slack account mapped by hand when its email is not their GHL one (2026-10-17)

The engine finds a person in Slack by their GHL email. Mitch is mitch@revsignals.io in GHL and mitch@salesagency.ai in Slack, and
Tyler is in no GHL roster at all; Tyler: "map it by hand ... we need to think about emails not matching." Install key `slackUsers:
{ <roster email or GHL user id>: <Slack user id, or the email Slack has> }` sets the roster row's Slack id (an email is looked up
through the connected bot; an unknown person, an email Slack does not know, or a value that is neither refuses the install). The
lookups by email fill only an empty id, so nothing replaces a hand mapping; a re-install without the key leaves it. Tyler, on no
roster, is the escalation person (`bot.escalateTo`), which is what lets him press Resolve and Retry.

Tests: `install.slack-users.test.ts`.

## D130. The pipeline_card step sets the card's value; Dating's won card carries the deal (2026-10-17)

The synthetic journey ended with both won cards at $0: no step wrote a card's value, while GHL's won-card numbers add it up.
Tyler, asked whether Deal closed should set it: "Yes ... 5k as the revenue", the Whop dollars landing as cash. `pipeline_card`
takes `value` (rendered to an amount; `$` and commas allowed; blank leaves it; anything else fails the step), sent as GHL's
`monetaryValue` on create and update. Dating's Deal closed (built in `installs/dating/copies.ts`) sets the won closer card to
`{{contact.revenue}}`: the opportunity's contract value, else the program price. Cash collected stays on the Sales Call and the
payment records. Hair's and PMU's templates are untouched.

Tests: `deposits.test.ts` (Dating's won card update carries 5000; Hair's writes no value).

## D131. The harness's staged calls speak the company's offer (2026-10-17)

`record` and `call` staged one hair-loss script for every company, so Dating's staged closer call came back "closed won" about
thinning hair. The scripts move to `harness-scripts.ts`: an offer-neutral pair by default, and the company's own from install key
`harness: { closerCall?, setterCall? }` (lines of { speaker: closer|setter|prospect, text }, `{first}` for the first name; both
roles must speak), bound as `harness.transcripts`. Dating's install carries a dating pair whose closer call ends on a deposit.

Tests: `simulate-form.test.ts` (Dating's staged calls are its own lines with the people's names; the install refuses a bad
script; the defaults name no offer).

## D132. The ladder: ghost → test → quiet → live (2026-10-17)

Tyler: "I want to be able to have things moving and going behind the scenes without any issues or worries about sending SMS
to people ... If we name it Ghost and Shadow, I'm going to get them confused. Maybe we eliminate Shadow and call that Ghost
mode ... the second test mode something like quiet mode." Confirmed: "that ladder looks right"; quiet is "off emails and
agreements, and slack notifications to non-test channels"; "Update the mode yes."

- **ghost** is shadow renamed, nothing else changed: everyone runs, nothing written or sent. The stored values move (companies,
  workflows, runs.born_in, sends.status `shadow` → `ghost`); `"shadow"` given to install or a mode route is refused naming
  `ghost`. A stored definition's `slack_post.label: "shadow"` still reads (as `ghost`), so no history is rewritten; step
  results written from now carry `ghost`, and the dashboard reads either.
- **quiet** (new, between test and live): a non-test contact's run writes the CRM for real (tags, cards, fields, records,
  notes, tasks, the Typeform door's contact write), but nothing reaches the contact: a text, an email, an agreement and an
  outbound webhook are held, recorded as `sends.status = 'quiet'` with the reason. A Slack post goes only to a channel listed
  in `test.slack_channels` (install `testSlackChannels`); any other is held the same way, DMs (already redirected to the ops
  channel before live, D76) included; an alert about the engine itself (`label: none`) always goes. A test contact gets
  everything, as in test. A run with no contact is quiet too.
- **Moving up** into quiet or live (company or one workflow, D92) passes the readiness gate and clears the runs born on a lower
  rung: into quiet the ghost- and test-born ones (their CRM steps never ran, so they must not resume halfway writing); into
  live every run not born live, as before (a quiet-born run held its messages back). The harness's staged bookings are cleared
  only going live. Moving down is the flag. `setCompanyMode` is the one door (dashboard, install).
- Readiness warns when a quiet workflow posts to Slack and no test channel is set (every post would be held).

Not covered by quiet: a GHL automation of the location that our tags or stages trigger. For RapidCloser Tyler confirmed every
one is off.

Tests: `mode.test.ts` (in quiet a real contact's tag and card reach the CRM, its text and email are held with the reason, its
Slack post reaches the test channel only, a test contact gets everything; moving into quiet clears the ghost-born runs and
keeps the quiet-born ones when moving back down). The other suites only had the name changed.

## D133. Before live, every Slack post goes to the one test channel; going live is the switch (2026-10-17)

Tyler, on D132's quiet holding posts to non-test channels: "test channel only. I'd like a setting on the specific workflow step
that is the live channel, then one in the settings that's the test channel. So I set the test channel once and the other slack
channels once and it's just a toggle to go live."

Replaces D132's list of test channels and its holding of other posts. One setting, `test.slack_channel` (Settings, or install
`testSlackChannel`; D132's list migrates to its first channel). A run whose rung is not live (ghost, test or quiet; the
workflow's own rung, else the company's, D92) posts every Slack message there instead of where its step points: a channel post
says "For #<its channel>:" when that is another channel, a DM "Would have sent to <name>:", both under the rung's 🧪 mark; a
thread reply follows its parent there. Every step keeps its live channel, so the company going live (or one workflow) moves
the posts and nothing else changes. Without a test channel, as before: a post goes to its own channel marked (D31), a DM to
the ops channel or the operator (D76); readiness says so. Hair (test, no test channel) is unchanged.

Tests: `mode.test.ts` (in quiet both contacts' posts to two channels land in the test channel, the other channel's says so;
live, the same steps post where they point, unmarked).

## D134. Refiling a call GHL still shows blank files it again (2026-10-17)

Hair: Calvin Coates (Mon Oct 12) stayed a Ledger drift question ("the engine has no-show but GHL's Sales Call has no
outcome") however often James refiled the day; Tyler: "I've submitted the EOD several times so that tells me there's an issue."
The no-show was first filed on Oct 15, while Hair's Call outcome filed was still in ghost, so its run wrote nothing to GHL; going
live cleared that run (D92). Every refile since was held: `fileCall` skips an answer the ledger already holds (the sweep of
2026-10-10, so Call outcome filed does not post twice), and the ledger held it.

The end-of-day submit now reads the closer's Sales Calls in GHL (the reminder's own read, `closerSalesCalls`) and files again
any call that is due with no outcome there, even when the ledger holds the answer, so Call outcome filed writes GHL. A call GHL
already shows filed is held as before; GHL not answering leaves the old rule.

Tests: `eod.test.ts` (the ledger holds Mia's no-show and GHL is blank: refiling starts one Call outcome filed run, for her only;
GHL filled: refiling starts none).
