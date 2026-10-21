# GHL Marketplace App Spec (copy)

A copy of Tyler's doc "GHL Marketplace App Spec", taken 2026-10-21 from https://claude.ai/artifact/PuzRea9c545w2gpMmx3ZBQ. The doc is the source; this copy is for reading beside the code. Where it differs from an ADR, the ADR wins (the agreement check cadence is ADR 0003's: 10 s for 60 min, then 5 min up to 30 days).

---


2026-10-21 · @Tyler

## Summary

One private HighLevel Marketplace app replaces a pasted Private Integration Token per offer, and turns the GHL side of the platform from polling into push. It covers contacts, appointments, opportunities, messages, custom-object records and installs, all signed and retried by HighLevel. It does not create GHL workflows, and it doesn't put any logic inside GHL; that stays true to D9.

Two facts from HighLevel's docs shape it:

1. **Private apps install into at most 5 agencies.** There is no limit on sub-accounts inside those agencies. Going past 5 agencies needs HighLevel's Security Review (available after a 6th install is blocked) or a public listing. With 10 to 30 offers, this decides how clients' sub-accounts should be organized. See Distribution.
2. **There is no webhook for a signed document.** Agreements stay on a short poll, scoped to documents actually sent and waiting.

|  | Today (PIT per offer) | Marketplace app |
|---|---|---|
| Setup per offer | Create a PIT in the sub-account and paste it | The sub-account owner clicks Install; tokens are stored automatically |
| Inbound | Poll contacts, conversations, opportunities, calendars and documents every minute (documents every 10 s) | Signed webhooks within seconds, plus a nightly reconcile |
| Latency | 1 minute or more | Seconds |
| API budget | Spent on polling | Spent on real work (100 per 10 s, 200,000 per day, per location) |
| Offboarding | Delete the PIT by hand | Uninstall fires a webhook; the platform stops and marks the offer disconnected |

## Distribution

The app is a **private** app with target user **Sub-account**, installed per offer by whoever administers that sub-account. A private app counts installs by agency, not by sub-account: "One Agency = one count, regardless of how many Sub-accounts are installed." The cap is 5 agencies per app ID, and it applies to private apps created on or after 18 November 2025.

| Where clients' sub-accounts live | Agencies counted | Works as a private app? |
|---|---|---|
| All in Tyler's own agency | 1 | Yes, with unlimited offers |
| In a few partner agencies (Nelly sits in RapidCloser's) | One per agency | Yes, up to 5 agencies |
| Each client in their own agency | One per client | Only up to 5 clients, then the Security Review |

**Path past 5 agencies:** at the 6th agency, HighLevel opens a Security Review. It needs an end-to-end demo video, a video justifying the scopes, and a written rationale. If it passes, the cap is lifted and the app stays private and unlisted. A material change later (scopes, domains, data flows) may trigger a re-review, which is one more reason to request the scopes we need from day one.

**Decision input (Tyler, 2026-10-21):** most clients' sub-accounts sit in their own agencies. At 10 to 30 offers, the cap will be hit, probably at the 6th client.

**Plan:**

1. **Build for the Security Review from day one.** Request the final scope set now (see Scopes), and write the scope rationale as part of this spec. Record the end-to-end demo video once the first offer runs on the app.
2. **The review opens only after a 6th agency's install is blocked.** That client can't wait on HighLevel, so the GHL adapter keeps a PIT-plus-polling mode behind the same port. An offer beyond the cap runs on a PIT until the review passes, then switches to the app with the same per-offer migration below. Nothing above the adapter knows which mode an offer uses.
3. **Prefer Tyler's agency for new sub-accounts where a client allows it.** Each one avoids an agency count and gives Tyler the admin rights to install.
4. **Public listing stays the fallback** if the review is refused. It adds a 24-hour support commitment and HighLevel's power to delist the app, which is acceptable but not wanted.

Unverified: whether HighLevel charges any developer or review fee. The policy and review pages state none.

## Install and tokens

Install is an OAuth authorization-code flow. The one rule that matters most is that **refresh tokens are single-use**: two workers refreshing at once, or a crash between receiving and saving a new token, locks the offer out until it is reinstalled.

**Install flow**

1. In the offer's onboarding, Tyler clicks **Connect GHL**. The platform sends the installer to `marketplace.gohighlevel.com/oauth/chooselocation` with the app's client id, scopes, redirect URI and a signed `state` naming the offer.
2. The installer picks the sub-account. HighLevel redirects to `/ghl/oauth/callback?code=…`.
3. The platform verifies `state`, then calls `POST services.leadconnectorhq.com/oauth/token` (`grant_type=authorization_code`, `user_type=Location`).
4. In one transaction, it stores the `ghl_connections` row: offer, `locationId`, `companyId`, the installing `userId`, the access token and refresh token (both encrypted), `expires_at`, and the scopes granted.
5. The `AppInstall` webhook arrives as well. Its `locationId` must match an existing connection; an install the platform didn't start is recorded and alerted, never auto-linked to an offer.
6. Onboarding continues with the field map, pipelines and calendars, read through the new connection.

**Agency bulk install** (optional). If an agency installs to several sub-accounts, the platform receives a Company token. It calls `POST /oauth/locationToken` for each sub-account in `approvedLocations`, and each must then be linked to an offer by Tyler. No sub-account becomes an offer automatically.

**Token lifecycle**

- Access tokens last about 24 hours. A job refreshes each connection when it has less than 4 hours left, so refresh never happens on the request path.
- **Refresh under a row lock.** The job runs `select … for update` on the connection row, calls `/oauth/token` with `grant_type=refresh_token`, and writes the new pair before committing. Only one worker can hold the row, so the single-use token is never spent twice.
- If the refresh response is lost (timeout after HighLevel issued it), the connection goes to `needs_reinstall`. Its outbox items are held, not dropped, and Tyler gets an alert with the reinstall link. This is rare, but it is a real failure mode and has to be visible.
- Refresh tokens expire after a year if unused. The proactive refresh keeps them fresh.
- `AppUninstall` sets the connection to `uninstalled`, holds its outbox items and alerts Tyler. Reinstalling resumes the offer.

**Storage:** tokens are encrypted with a key held outside the database, readable only by the worker role, and never logged. The client secret and webhook public key are platform settings.

## Scopes

We request only what a named feature uses, because scopes can't be changed once the app leaves draft without a new version, and the Security Review asks us to justify each one. HighLevel has no "webhooks" scope. Each webhook event is unlocked by the matching read scope.

| Scope | Used for | Unlocks webhooks |
|---|---|---|
| `contacts.readonly`, `contacts.write` | Find, upsert, tag, set fields, notes, tasks | Contact*, ContactTagUpdate, ContactDndUpdate, Note*, Task* |
| `conversations.readonly`, `conversations.write` | Read threads; mark context for replies | ConversationUnreadWebhook |
| `conversations/message.readonly`, `conversations/message.write` | Send SMS and email; read replies and dialer calls and their transcripts | InboundMessage, OutboundMessage |
| `calendars.readonly`, `calendars.write` | Read calendars and availability; create calendars during setup | none |
| `calendars/events.readonly`, `calendars/events.write` | Read appointments; set status (showed, no-show, cancelled) | Appointment* (unverified: which scope gates them) |
| `calendars/groups.readonly`, `calendars/groups.write` | The calendar group created during setup | none |
| `opportunities.readonly`, `opportunities.write` | Cards: move stage, set value, win or lose | Opportunity* |
| `objects/schema.readonly`, `objects/schema.write` | Create Sales Call and Payment objects during setup | ObjectSchema* |
| `objects/record.readonly`, `objects/record.write` | Sales Call and Payment records | Record* (unverified: which scope gates them) |
| `associations.readonly`, `associations.write`, `associations/relation.readonly`, `associations/relation.write` | Link records to contacts | Association*, Relation* |
| `locations.readonly` | Time zone, business details | LocationUpdate |
| `locations/customFields.readonly`, `locations/customFields.write` | Field map; create missing fields during setup | none |
| `users.readonly` | Map closers and setters to people | User* |
| `workflows.readonly` | Onboarding lists the client's own GHL workflows so each can be marked replaced, filtered or harmless | none |
| `documents_contracts/list.readonly`, `documents_contracts/sendlink.write`, `documents_contracts_templates/list.readonly`, `documents_contracts_templates/sendlink.write` | Send agreements; poll their status | none |

These are left out on purpose: payments, invoices, products and orders (payments come from Whop or Stripe), custom values (the old design), custom menu links, media, forms (Typeform has its own door), and every agency scope except what a bulk install needs (`oauth.readonly`).

## Webhooks

One webhook URL serves the whole app. Each delivery is verified, stored, acked, and only then turned into canonical events. HighLevel retries up to 12 times on any non-2xx, and it pauses delivery to a URL whose success rate stays under 90%, so the endpoint must never do slow work before answering.

**Handling a delivery** (`POST /in/ghl`)

1. Verify `X-GHL-Signature`: Ed25519 over the raw body, using HighLevel's public key stored as a platform setting. The legacy RSA `X-WH-Signature` was deprecated on 2026-09-01 and is not accepted. A bad signature gets a 401 and is logged without the body.
2. Insert into `inbox` keyed on `webhookId`. A duplicate is answered 200 and dropped.
3. Answer 200.
4. A job resolves `locationId` to the offer through `ghl_connections`. An unknown location is recorded and alerted, never guessed.
5. The normalizer maps the event to canonical events (table below) and appends them to the event log.

| GHL event | Canonical event | Notes |
|---|---|---|
| ContactCreate | contact.created | Lead intake |
| ContactUpdate, ContactTagUpdate | contact.updated, tag.added/removed | Field changes go through the field map |
| ContactDndUpdate | contact.opted_out / opted_in | The delivery gate reads this |
| ContactDelete | contact.deleted | Its runs end at their next step |
| AppointmentCreate | appointment.booked | Calendar to call type through config |
| AppointmentUpdate | appointment.rescheduled / status_changed / cancelled | Decided by comparing start time and status with the projection |
| AppointmentDelete | appointment.cancelled |  |
| OpportunityCreate, OpportunityStageUpdate | deal.opened, deal.stage_changed | Stage name through config |
| OpportunityStatusUpdate | deal.won / deal.lost |  |
| OpportunityMonetaryValueUpdate, OpportunityAssignedToUpdate | deal.updated |  |
| InboundMessage (SMS or email) | message.received | Reply waits and classification |
| InboundMessage / OutboundMessage of type call | call.logged | Dialer calls for setter results (unverified: call messages arrive through these events) |
| RecordCreate, RecordUpdate | record.created / updated | Sales Call and Payment records |
| UserCreate, UserUpdate, UserDelete | person.changed | Onboarding prompts Tyler to map them |
| AppInstall, AppUninstall | connection.installed / uninstalled | See Install and tokens |

**Echoes of our own writes.** Every CRM write the platform makes also comes back as a webhook. The outbox records each write's expected change, and a matching webhook within a short window is tagged `by: platform`. Workflows trigger on human or vendor changes by default, so an engine-written tag can't start a second run. The current system had this bug: two welcome texts and an agreement sent twice (D90, item 40).

**Ordering.** Deliveries can arrive out of order. The normalizer compares each event's timestamp with the projection and drops a stale update. A workflow step that depends on current state re-reads it from GHL before acting (the premise check).

**Nightly reconcile.** For each connection, the job reads entities changed in the last 26 hours (contacts by `dateUpdated`, appointments, opportunities) and diffs them against the projections. It emits any missed events with `source: reconcile` and alerts if more than a handful were missed, since that means webhooks are failing.

## What still polls, rate limits and the API client

**Still polled** (only where HighLevel has no event):

| What | Why | How |
|---|---|---|
| Agreement status | There is no document signed or viewed webhook | Every 2 minutes, only for documents the platform sent that are still waiting. The poll stops at signed, voided or 30 days. |
| Call transcripts | A transcript arrives after the call event | When a call is logged, a job waits for the transcript with backoff (1, 3, 10 minutes), then gives up and flags it |
| Nightly reconcile | Missed deliveries | See Webhooks |

**Rate limits:** 100 requests per 10 seconds and 200,000 per day, per app per location. The client keeps a token bucket per location, reading `X-RateLimit-Remaining`, and queues requests rather than failing them. With polling gone, a normal offer stays far under both limits.

**API client rules**

- Base URL `https://services.leadconnectorhq.com`, `Authorization: Bearer`. The `Version` header is set per API family: `2021-04-15` for calendars and conversations, `2021-07-28` for everything else. The table lives in the adapter and is covered by tests.
- Retries with jittered backoff on 429, 5xx and timeouts. 401 triggers one forced refresh, then pauses the connection. 404 on a contact marks it gone.
- Every write carries the outbox idempotency key in the platform's own ledger. HighLevel has no idempotency header, so an ambiguous result is never re-sent blind: the client re-reads first.
- Known GHL quirks are fixed once inside the adapter, each with a contract test: an appointment PUT resets the status (always re-send it), DATE fields drop the time, contact search lags writes by about 10 s (use get-by-id after a write), and the `appoinmentStatus` spelling in responses.
- A browser-like `User-Agent` is set, since HighLevel's Cloudflare blocks some default agents (error 1010).

## Optional modules

The Marketplace offers more than webhooks. One of these modules is worth building later, and two should be left alone.

| Module | What it is | Recommendation |
|---|---|---|
| Custom page | An iframe of our app in the sub-account's left nav. HighLevel passes the signed-in user's context (`userId`, `role`, `activeLocation`), encrypted with the app's shared secret. | **Later, read-only.** It shows the offer's workflow pages (the same nothing-hidden view) inside GHL for Tyler, without a second login. The encrypted user context is only trusted after decrypting it on our server. Editing stays on the platform, under the one-offer rules. |
| Custom workflow actions and triggers | Our actions and triggers inside GHL's workflow builder, billed per execution to the sub-account | **No.** It would put logic back in GHL's builder, which D9 removed for good reason: two places to look and double-fires. |
| Conversation provider (SMS or email) | Our app becomes the sub-account's SMS or email sender | **No.** Sends already go through GHL's own number, and replacing the provider would change every client's GHL messaging, not just ours. |
| External authentication | HighLevel stores credentials for our system at install | Not needed: our own OAuth state covers it. |

## Migration, open questions and sources

**Moving an offer from its PIT to the app**, one offer at a time:

1. Install the app on the offer's sub-account. The webhook events land in the inbox, but the normalizer runs in observe-only mode, which records but doesn't emit.
2. For a few days, compare what the webhooks would have emitted with what the poll emitted. The diff report is per offer.
3. Switch the offer's inbound to webhooks and outbound to app tokens. The poll is turned off for that offer, except for agreements.
4. Tyler deletes the offer's PIT in GHL.

**Open questions**

- List each current offer's agency (Hair, PMU, Dating in RapidCloser's) to count the agencies already used against the 5-agency cap.
- For new clients, will sub-accounts be created in Tyler's agency? That keeps everything in one agency, avoids the cap, and gives Tyler admin access to install.
- Who installs on a client-owned sub-account, Tyler as a user there or the client's admin? Installing needs sub-account admin rights.

**Verify on a test sub-account before building**

- Which scope gates Appointment and Record webhooks.
- Whether dialer calls arrive as InboundMessage or OutboundMessage events with a call type.
- Whether Appointment and Record webhooks fire for every installed location with the payload shapes the docs show.

**Sources** (opened 2026-10-21)

- [Create a Marketplace app](https://marketplace.gohighlevel.com/docs/oauth/CreateMarketplaceApp)
- [Private app install limits](https://marketplace.gohighlevel.com/docs/MarketplacePolicies/PrivateAppInstallLimits)
- [App review guidelines](https://marketplace.gohighlevel.com/docs/oauth/AppReviewGuidelines.md)
- [OAuth 2.0](https://marketplace.gohighlevel.com/docs/Authorization/OAuth2.0)
- [Scopes](https://marketplace.gohighlevel.com/docs/Authorization/Scopes)
- [Webhook integration guide](https://marketplace.gohighlevel.com/docs/webhook/WebhookIntegrationGuide)
- [AppointmentCreate](https://marketplace.gohighlevel.com/docs/webhook/AppointmentCreate)
- [RecordCreate](https://marketplace.gohighlevel.com/docs/webhook/RecordCreate)
- [AppUninstall](https://marketplace.gohighlevel.com/docs/webhook/AppUninstall)
- [Rate limits](https://marketplace.gohighlevel.com/docs/other/rate-limits)
- [User context for custom pages](https://marketplace.gohighlevel.com/docs/other/user-context-marketplace-apps)
- [Workflow actions and triggers](https://marketplace.gohighlevel.com/docs/marketplace-modules/WorkflowActionsAndTriggers)
- [Conversation providers](https://marketplace.gohighlevel.com/docs/marketplace-modules/ConversationProviders)
- [OpenAPI specs](https://github.com/GoHighLevel/highlevel-api-docs)

