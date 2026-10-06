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

**Agreement clause needed from client one:** processing their data to operate the systems,
operator read access for support, recordings and transcripts never leaving their tenant,
and no use of their data for any other client. Cheap to write now, impossible to retrofit.

---

## D2. Client-specific work becomes a template by promotion

Build something bespoke for one client, then promote it: walk its literals and replace each
with a `{{variable}}`, which produces a manifest (D3). The definition travels to the library.
The values stay in the client's tenant. This is the only path from custom work to template,
and it's the reason D1 costs nothing — the thing worth reusing was never the data.

---

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

## D4. Triggers are rows; chaining is edges

Separate tables, separate concepts:

- **`workflow_triggers`** — many rows per workflow. Several ways to start the same run
  (calendar status, tag added, form submitted). Different clients can point different
  trigger rows at the identical definition. Adding a detection path is an INSERT.
- **Edges inside the definition** — conditional paths. "A → B on offer 1, A → C on offer 2"
  is one node with two conditional edges, on data the run already carries. Not two workflows.

A per-client fork of a definition is a defect. Two definitions are correct only when the
paths stop sharing content entirely.

### Re-entry policy (required per workflow)
Because a workflow can have several triggers, every workflow declares what happens when a
contact trips more than one:

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
