# Connectors

Every vendor sits behind a port (`src/engine/ports.ts`). Workflows name a port's verbs (`crm.add_tag`), never a vendor,
a provider field id or an auth mode. The connectors live in `src/connectors/`:

| Vendor | Folder | Ports | In | Out |
| --- | --- | --- | --- | --- |
| GHL (Marketplace app, or a private token past the 5-agency cap) | `ghl/` | crm, messaging, scheduling, esign | webhooks at `/in/ghl`; a poll in private-token mode; the agreement check; the nightly reconcile | contacts, tags, DND, cards, tasks, notes, custom object records and relations, SMS and email, appointment status and cancel, documents |
| Whop | `whop/` | payments | `/in/whop/{connection}` (Standard Webhooks); reconcile | none |
| Fathom | `fathom/` | recording | `/in/fathom/{connection}` (Standard Webhooks); transcript look-ups; reconcile | none |
| Typeform | `typeform/` | forms | `/in/typeform/{connection}` (Typeform-Signature) | none |
| Calendly | `calendly/` | scheduling | `/in/calendly/{connection}` (paid plan, signed); a poll only for a free plan by exception | cancel, no-show |
| Generic signed door | `generic/` | payments, recording, forms, any fact | `/in/{connection}` (Standard Webhooks, a field map as config) | none |
| Jev | `ai/jev.ts` | ai.classify | none | classify |
| Anthropic | `ai/anthropic.ts` | ai.summarize | none | summarize (the model is a setting) |

## How it fits together

- **Connections** (`connections`, migration 0005): one row per offer per port: the provider, the mode, the vendor account
  (`external_id`: a GHL location, a Calendly organization), what is not secret (`config`) and the credentials, sealed with
  `TOKEN_KEY`. Its `id` names its door. Status is `connected`, `paused` (it refused its token), `needs_reinstall` or
  `uninstalled`; anything but connected holds every effect through it (the dispatcher's gate reads the same row). A port may
  be named by one verb (`ai.classify`, `ai.summarize`) when two providers share it.
- **Field map** (`field_maps`): canonical field → the provider's field id, per object (`contact`, `opportunity`, a custom
  object's key; `calendar` maps a call type to a calendar or event type), with the value's type (`date` sends the day,
  `money` a number). A canonical field with no row is refused, never guessed.
- **Inbound**: door → signature → `inbox` (once per delivery) → 200 → the `connector_inbox` job → the normalizer → canonical
  facts → `Engine.ingest`. A fact's dedupe key is built from the vendor's entity and its own time, never the delivery, so a
  webhook, a poll and the reconcile that see one change make one fact. What the normalizer learns (an entity's last state,
  an echo matched) is written only after its facts are recorded.
- **Outbound**: the dispatcher calls `connectorPorts(hub)` (`registry.ts`), which routes each call to the offer's provider.
- **Jobs** (graphile-worker, `connectorTaskList`): `connector_inbox`, `ghl_refresh`, `ghl_agreements`, `ghl_poll`,
  `calendly_poll`, `transcript_wait`, `connector_reconcile`. `pnpm worker` (`src/worker.ts`) runs them with the engine's and
  the Slack app's; it sweeps unread inbox rows at start, so a door whose queue call failed loses nothing.
- **Echoes**: every GHL write records the change it expects (`connector_echoes`) before it is made (a created contact or
  card as soon as its id is known). The webhook that echoes it inside 15 minutes says `by: platform`; every other GHL fact
  says `by: crm`. Workflows decide what to do with that (see "For Tyler" below).
- **Stale updates**: `entity_versions` keeps the last state and vendor time seen per entity; an update older than it is
  dropped, and the same version seen again (a poll's overlap) is nothing new.

## The retry policy (all vendors)

`framework/http.ts`. 429: waited out (Retry-After, else jittered backoff) and tried again. 5xx and timeouts: a read is tried
again with jitter; a write that may have been done is re-read (`confirm`) and never sent again blind; a text that cannot be
found in the thread is `ambiguous` (the outbox marks it unknown, never re-sent). A request refused before it left is tried
again. Three tries a call, then transient, and the dispatcher's own backoff takes over. 401 and 403: auth (the connection
pauses), except Cloudflare's 1010 (permanent: the client was refused, not the token). 400, 404, 422: permanent.

GHL on top: the Version header per family, a browser-like User-Agent, 100 requests per 10 s per location waited for (and
`X-RateLimit-Remaining: 0` heeded), one forced token refresh on a 401, then the pause.

## Setting up each vendor (when Railway works)

Until the onboarding screens exist, a connection is made by a one-off script on the worker's environment:

```ts
import { PgConnectorState } from "@/connectors/framework/pg-state";
import { db } from "@/db/client";
const state = new PgConnectorState(db());
await state.upsertConnection({ offerId, port: "crm", provider: "ghl", mode: "oauth", externalId: "<locationId>" });
await state.setFieldMap([{ offerId, provider: "ghl", object: "contact", canonicalField: "lead_source", providerFieldId: "<GHL field id>", valueType: "text", options: {} }]);
```

Then `startConnection(hub, conn)` (or a worker restart) starts its reconcile, poll and refresh jobs. Variables, on both
the web service and the worker: `DATABASE_URL`, `TOKEN_KEY`, `GHL_CLIENT_ID`, `GHL_CLIENT_SECRET`, `GHL_REDIRECT_URI`,
`GHL_WEBHOOK_PUBLIC_KEY`, and the Slack ones (`docs/slack.md`).

### GHL (Marketplace app)
1. The app's redirect URL is `https://<domain>/ghl/oauth/callback`, its webhook URL `https://<domain>/in/ghl`; scopes as in
   `docs/ghl-app-spec.md`.
2. Install on the offer's sub-account. The callback stores the location's tokens (sealed) in `ghl_connections`; a reinstall
   also reconnects every offer's GHL connection on that location and releases what waited.
3. Make the offer's four GHL connections (`crm`, `messaging`, `scheduling`, `esign`), `mode: "oauth"`, `externalId` the
   location id. Optional config: `scope_tag` (a location shared with another business: only contacts with that tag are
   this offer's), `email_from`.
4. Field map: the contact and opportunity custom fields the workflows write; a `calendar` row per calendar that is a call
   type (`canonicalField: "closing"`, `providerFieldId: "<calendarId>"`).
5. A location no connection names is alerted on and made into no facts; an install the platform did not start is alerted
   and never linked.

### GHL past the 5-agency cap (private token)
Same connections with `mode: "pit"` and `credentials: { token: "<PIT>" }` on each. The poll (`ghl_poll`) runs every minute
(`config.poll_seconds` to change it) over contacts, appointments, opportunities and conversations, and records the same
facts the webhooks would. Moving to the app later is the spec's per-offer migration: install, compare, switch the mode.

### Whop
Make the webhook in Whop (events `payment.succeeded`, `payment.failed`, `refund.created`) pointing at
`https://<domain>/in/whop/<connection id>`; Whop shows its signing secret once. Connection: `port: "payments"`,
`provider: "whop"`, `credentials: { webhook_secret: "<ws_/whsec_ secret>", api_key: "<for the reconcile>" }`.

### Fathom
Make the webhook with transcript and summary included, destination `https://<domain>/in/fathom/<connection id>`; the whsec_
secret is shown once. Connection: `port: "recording"`, `credentials: { webhook_secret, api_key }`. The team's emails
(the people projection) are never taken for the prospect.

### Typeform
On each form, a webhook to `https://<domain>/in/typeform/<connection id>` with a secret. Connection: `port: "forms"`,
`credentials: { webhook_secret }`, `config.forms: { "<form id>": { name, answers: { "<question ref>": "<canonical field>" },
hidden: { "<hidden field>": "<canonical field>" } } }`. The person found, tagged or made a lead is the offer's workflow on
`form.submitted`.

### Calendly
Paid plan (the rule): a webhook subscription (`invitee.created`, `invitee.canceled`, `invitee_no_show.created`, `.deleted`)
to `https://<domain>/in/calendly/<connection id>` with a signing key. Connection: `port: "scheduling"`, `mode: "webhook"`,
`externalId` the organization uri, `credentials: { token, webhook_secret: "<signing key>" }`, `config.questions:
{ setter: "Who set this call?", phone: "..." }`. Free plan, by exception only: `mode: "polling"` and
`config.free_plan_exception: { by: "Tyler", at, why }`; without the flag the poll refuses and alerts.

### The generic signed door (Zapier, Make, anything)
Connection: `provider: "generic"`, the port it feeds, `credentials: { webhook_secret }`, `config: { emits: "payment" |
"recording" | "form" | "fact", type: "<canonical type, for fact>", map: { "<canonical key>": "<dot.path in the body>" },
dedupe: "<dot.path of the body's own id>" }`. The sender signs with Standard Webhooks (headers `webhook-id`,
`webhook-timestamp`, `webhook-signature: v1,<base64 HMAC-SHA256 of "id.timestamp.body">`); in Zapier that is a Code step
before the Webhooks step. Nothing the map does not name is read.

### Jev and Anthropic
`port: "ai.classify"`, `provider: "jev"`, `credentials: { api_key }` (optional `config.criteria` per option, `config.url`).
`port: "ai.summarize"`, `provider: "anthropic"`, `credentials: { api_key }`, `config: { model: "<model id>", effort }`:
there is no default model; with none set the step fails and says so.

## Payload shapes not yet confirmed against the real vendor

The tests answer from payloads modelled on v1's verified reads and the vendors' docs. These are unverified until the Phase
0 GHL checks (`docs/phase-0.md`) or a real sandbox:

- **GHL webhooks**: the top-level keys of Contact*, Opportunity* and Record* events (flat, as the docs show), whether
  Contact events carry `dateUpdated` (the dedupe keys and the stale check use it; without it the delivery's time is used and
  a poll and a webhook of one change could be two facts), AppointmentCreate's nested `appointment`, Record*'s `properties`
  array form, INSTALL / UNINSTALL's type names, whether dialer calls arrive as Inbound/OutboundMessage with messageType CALL
  and `callDuration` / `callStatus`, and which scopes gate Appointment and Record events.
- **GHL echoes**: whether anything in a webhook marks a change as the app's own (Phase 0 check 5); the platform matches on
  the expected change instead.
- **GHL documents**: the send call's body (`POST /proposals/templates/send`), the void call (no endpoint is known), and
  whether one request can list a location's documents by status or id (the check reads a page of 21, newest first, and
  moves a page on when a waiting agreement is older than that page).
- **Calendly webhooks**: v1 only polled; the webhook envelope (`{ event, created_at, payload: invitee + scheduled_event }`)
  and the no-show payload are from Calendly's docs.
- **Fathom**: the transcript endpoint (`GET /recordings/{id}/transcript`) is v1's to-verify.
- **Whop and Typeform** envelopes are v1's, which ran against the real ones.

## For Tyler (choices made here, to confirm)

- One `connections` table for both the engine's pause and the vendor connection; the old `ok` / `paused_auth` became
  `connected` / `paused` (migration 0005 converts them).
- GHL opportunities are `card.moved` / `card.updated` / `card.deleted`, not the spec's `deal.*`: `deal.*` is the ledger's
  own deal in the projections, and a CRM card must never count as a close.
- A tag on a contact never seen before is not reported as added (GHL's update does not say which tag changed); a contact
  made in GHL reports its tags as added.
- `by: platform` is on every echoed fact, but workflows still trigger on it unless they match on `event.by` (a test shows
  `match: { eq: ["{{event.by}}", "crm"] }` keeping an engine-written tag from starting a second run). Whether that should be
  the default for every trigger is an engine decision for you.
- A location shared by two offers sends each offer every fact unless the offer's connection has a `scope_tag`.
- Whop refunds are not reconciled (the payments list has no refund id to match its webhook's fact by).
- The GHL rate budget is per process; a second worker process would need a shared one.
- The agreement check emits `agreement.signed`, `agreement.voided` and `agreement.viewed`; `agreement.sent` is left to
  the workflow that sent it.
