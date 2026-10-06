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

## D4. Workflows are linear. Variation is more workflows, never a branch.

**Tyler, 2026-10-06, settling the "no chaining" question.** A workflow is a straight list of
steps with exits. There is no node that forks a run down one of two paths. Offer variation,
client variation, outcome variation — all of it is expressed as **separate, individually
editable workflows**, each a copy the client owns (D2).

What's rejected, precisely: one shared graph that contacts from many clients or offers flow
through, diverging only at the edges where their paths differ. That model is out. It made
editing dangerous and the flow view unreadable, and copy-on-install already solves everything
it was for.

### What a step can do instead of branching
- **Continue** to the next step.
- **Exit** the run, with a reason (`check` nodes are *gates*: continue-or-exit, never fork).
- **Record** a fact — write a field, add a tag, create an event.
- **Start another workflow** as a terminal action. This is how a run hands off to reactivation
  without duplicating the reactivation steps into every tail. Not a branch: the current run ends,
  a different run begins.

### Where the fork went: the trigger table
A decision that used to be an `if` inside one workflow becomes **one workflow that records the
decision, and several workflows that trigger on the recorded value.** Each is linear, each is
editable on its own, and the flow view for any one of them is a straight line.

```
Reply received ──► [classify reply → write reply_intent → exit]
                                │
      trigger: reply_intent = confirmed   ──► "Confirmed reply" workflow (linear)
      trigger: reply_intent = cancelled   ──► "Cancelled reply" workflow (linear)
      trigger: reply_intent = reschedule  ──► "Reschedule request" workflow (linear)
      trigger: reply_intent = unclear     ──► "Needs a human" workflow (linear)
```

Nothing is lost in expressiveness. The branch still exists; it lives in `workflow_triggers`
as rows instead of inside a definition as edges, and that is exactly what makes every piece of
it safe to edit.

### Triggers
- **`workflow_triggers`** — many rows per workflow instance. Several ways to start the same run;
  adding one is an INSERT. Because instances are copies, a client changing a trigger changes
  only their own.
- **Re-entry policy, required per workflow**, because a contact can trip two triggers:

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

## D9. One writer per fact. We store everything; nothing has two writers.

Tyler, 2026-10-06: *"pulling from GHL is a bad idea … I would like to store the data."* Right,
and it doesn't conflict with "no two truths" as long as the rule is stated at the level of a
**fact**, not a system. Every fact has exactly one writer. Copies are allowed; a second writer
is not.

### Two one-way flows, split by who owns the fact

**Facts we own → our DB is truth → pushed to GHL for display.**
Everything collected by our forms (D8): intake answers, call outcomes, pains and goals,
dispositions, EOD recaps. The form writes our DB first. We then **write the value into GHL
custom fields** so the closer sees "hair loss level: 4" on the contact card. GHL holds a
display copy. We never read it back for that fact.

This inverts the sync problem for all intake data. The custom field in GHL exists for the
human looking at the CRM, not for us.

**Facts GHL owns → GHL is truth → pushed to our DB as a replica.**
Contact identity, appointment bookings and confirmation status, pipeline stage, tags set by a
human in the UI, inbound and outbound messages. GHL writes these. We hold a **replica**, kept
current by:
1. **Marketplace-app webhooks** for freshness — `ContactCreate/Update/Delete/TagUpdate`,
   `Appointment*`, `Opportunity*`, `InboundMessage/OutboundMessage`. This is now the recommended
   path (reversing the earlier "overkill" call — a synced replica of GHL-owned facts needs real
   event subscriptions, and a thin-workflow-per-event hack doesn't cover "any field changed").
2. **The reconciliation sweep (D5)** for correctness — periodic re-read and diff, so a dropped
   webhook is a delay, not a permanent divergence.

### The one read that still goes to source
**Premise checks (D5b) read GHL directly, not the replica.** A contact cancelled thirty seconds
ago with the webhook still in flight must not get a reminder off stale replica state. That's the
single place where staleness has a cost, so it's the single place that pays for a live read.
Everything else — display, analytics, correlation queries, the flow view — reads the replica.

### Custom, per-business data: `attributes` JSONB, schema owned by the form
"How bad is your hair" exists on one offer and not another. It does not get a column. Our intake
record carries an `attributes` JSONB column, and **the form definition is its schema**: when a
form declares a question with key `hair_loss_level`, type `integer`, range 1–5, that key becomes
a typed, validated, queryable attribute for that client.

- Queryable: `attributes->>'hair_loss_level'`, GIN-indexed.
- No migration per client, no sparse table of 400 nullable columns.
- **Typed at the form, validated at ingest.** The correlation ambition dies if one install stores
  `"4"` and another stores `4`. The form says `integer`; the ingest refuses a string.
- Human-entered GHL custom fields (a closer typing into the contact card) land in a separate
  `ghl_fields` JSONB on the replica, so the ownership line stays visible in the schema itself.

The payoff is the question Tyler actually wants answered — *how does hair loss level correlate
with close probability?* — which is a join between an attribute we own and an outcome we own,
across a client's whole book, with no GHL call in the path.

Verified read and write paths in `../ghl/02-api-facts.md`.

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

## D13. The reply workflow — Jev decides, a human catches the rest

Inbound reply to a reminder or outreach text. One linear workflow, per D4:

1. **Trigger:** `InboundMessage` for a contact with an active reminder or outreach run.
2. **Classify** with Jev, `choice` over the controlled set:
   `confirmed · cancelled · reschedule_request · question · unclear`, with the recent outbound
   message as `state` so "yes" means something.
3. **Confidence gate.** Below threshold → the result is `unclear` regardless of the mode.
4. **Record** `reply_intent` on the contact and in `events`. Exit.

Then four separate, editable workflows trigger on the recorded value (the fan-out in D4). The
`unclear` one, verified end to end against the live location:

- Tag the contact `needs-human-reply` → a smart list filters on the tag (smart lists can't be
  created by API; tags can).
- Write an internal note on the contact: the original text, the top guesses with their
  probabilities, and a plain line that a human needs to look. Verified: `POST /contacts/{id}/notes`.
- Pause any active reminder run for that contact so the engine doesn't keep texting someone
  who's mid-conversation with a human.

**What the engine never does with an unclear reply:** guess. A classifier that returns
calibrated probabilities is only valuable if the low-confidence path is honored.
