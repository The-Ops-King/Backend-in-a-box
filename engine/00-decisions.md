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
rescheduled → stop, Call booked already reacted 🔁. The call outcome is read from the appointment row
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

