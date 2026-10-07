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
