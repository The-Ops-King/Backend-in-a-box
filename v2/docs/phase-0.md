# Phase 0: decisions and checks

Phase 0 is done when every decision is an ADR (`adr/`) and every check below has an answer with evidence.

## Decisions: done
ADRs 0001 to 0007.

## Checks: GHL, on Tyler's test sub-account

The GHL design rests on webhooks, so before building on them we confirm what GHL actually sends.

### What we need to learn
1. **Scopes.** Which scope turns on the Appointment webhooks, and which turns on the custom object Record webhooks.
2. **Dialer calls.** Whether a dialer call arrives as an InboundMessage or OutboundMessage of type call, and what it carries:
   direction, duration, the recording, the user.
3. **Coverage and shape.** Whether each event fires for the installed location, and whether its payload matches GHL's docs.
   Events: Contact Create, Update, TagUpdate, DndUpdate and Delete; Appointment Create, Update and Delete; Opportunity Create,
   StageUpdate, StatusUpdate and MonetaryValue; Inbound/OutboundMessage; Record Create and Update; AppInstall and
   AppUninstall.
4. **Agreements.** Which call lists a location's sent documents with their status, in one request. That call is the
   10-seconds-then-5-minutes check in ADR 0003.
5. **Echoes.** Whether a change our app makes comes back as a webhook, and whether anything in it tells us it was ours.
6. **Signature.** Deliveries carry `X-GHL-Signature` (Ed25519), and we can verify it with GHL's published key.

### What Tyler does in GHL
1. In the GHL developer portal (marketplace.gohighlevel.com), create a **private** app:
   - target user: Sub-account;
   - scopes: the list in the GHL Marketplace App Spec;
   - the redirect URL and webhook URL from the receiver below.
2. Install the app on the test sub-account.
3. Do each of these once in that sub-account, noting the time of each:
   - create a contact, edit it, add a tag, turn DND on;
   - book, move and cancel an appointment;
   - create an opportunity, move its stage, set its value, mark it won;
   - make one dialer call;
   - create and edit a record on a custom object;
   - send a document, then sign it.

### The receiver: Tyler picks one
The webhooks need a URL that records exactly what GHL sends.
- **A. A small recorder on Railway (recommended).** About one file: it verifies the signature, stores each delivery raw in
  Postgres and answers 200. It becomes v2's inbound door (`/in/ghl`) later, so nothing is thrown away. Needs Railway set up.
- **B. A public request inspector (webhook.site or similar).** Nothing to build. The test sub-account's data passes through a
  third party, and nothing is kept for v2.

## Checks: Slack
None block building. Tyler owns the app (ADR 0007). The app itself is made in Phase 4.

## When Phase 0 ends
Every check above has an answer, with the raw payloads saved in `docs/ghl-payloads/`. Tyler signs it off. Phase 1 starts: each
offer's spec walked with Tyler.
