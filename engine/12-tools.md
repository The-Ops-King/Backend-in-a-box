# Tools and adapter ports (brainstorm, 2026-10-19)

Tyler: "I want to be able to say, 'do a speed-to-lead from HubSpot and send it to Discord' rather than our current stack." Builds
on `10-audit-2026-10-19.md` §5. Some vendor limits below are from memory and marked so; check before building.

Key point: GHL is an all-in-one. One GHL adapter fills about seven ports (CRM, calendars, SMS/email, documents, forms, dialer).
Every other vendor fills one or two. So an offer picks a provider **per port**, not per company: HubSpot instead of GHL means
HubSpot for the CRM, plus Twilio for texts (HubSpot has no native SMS), plus HubSpot Meetings or Calendly.

## Categories (build first in bold)

| Category | Vendors | Port and events | API realities that shape it |
|---|---|---|---|
| CRM | **GHL**, **HubSpot**, **Close**, Pipedrive, Salesforce, Keap, Zoho | `Crm`: find/upsert person, tags, notes, tasks, users, pipelines and deals, optional custom records, `recordUrl`. Events contact.*, deal.stage_changed, deal.won | HubSpot private-app token, webhooks set in its UI only; Close has webhooks and a 30-day event log; custom objects only in GHL/HubSpot/Salesforce (others need custom fields); GHL webhooks are marketplace-only, so the engine polls (from memory) |
| Scheduling | **Calendly**, **GHL calendars**, **Cal.com**, Chili Piper, SavvyCal, Acuity, OnceHub | `Scheduler`: calendars (questions, hosts), bookings in a window, get, optional no-show/cancel. Events booking.* | Calendly identifies the invitee by email, not a CRM id; Acuity webhooks carry an id only |
| Messaging | **GHL**, **Twilio**, **Postmark/SendGrid**, Mailgun, WhatsApp, ManyChat/IG | `Messenger`: send to a person on a channel, status, templates. Events message.inbound/status, opt_out | Twilio needs A2P 10DLC and the engine must own STOP once the CRM does not; Meta's 24-hour window; ActiveCampaign/Klaviyo are "tag and trigger a flow", not sends |
| Team notification | **Slack**, **Discord**, **Teams**, Google Chat, email | `Notifier`: post a neutral message (text, fields, links, mentions by email, actions), update, reply, optional react, find a member. Events action.clicked, command.invoked | Slack and Discord both need a 3s ack for buttons; Teams connector webhooks are retired and their replacement shows no buttons; a platform without buttons gets a signed link instead |
| Payments | **Whop**, **Commas**, **Stripe**, PayPal, ThriveCart, SamCart, Kajabi, Shopify | `PaymentSource`: payments in a window, get, optional checkout link. Events payment.succeeded/failed/refunded/disputed, installment, subscription.canceled; a `financed` flag | No public Commas API found; its events come through Zapier. Financing (Klarna, Affirm, Elective) mostly arrives through the checkout |
| Agreements | **GHL Documents**, **PandaDoc**, DocuSign, Dropbox Sign | `Signer`: send a template, status. Events doc.sent/viewed/signed/declined | DocuSign has a go-live review |
| Recording | **Fathom**, **Zoom**, Fireflies, Gong, Grain, Otter | `Recorder`: meetings in a window (neutral shape), transcript. Event recording.ready | Zoom's transcript comes after the recording; Otter API is enterprise only |
| Dialers | **GHL**, **Close**, Aircall, Kixie, JustCall | `Dialer`: calls in a window, call media. Event call.completed | GHL calls read today through the messages poll |
| Forms | **Typeform**, **GHL forms**, Jotform, Tally, ClickFunnels, Kajabi | `FormSource`: forms, fields, responses since, install. Event form.submitted | Jotform webhooks are unsigned |
| Community | Skool, Circle, Kajabi, Whop | `Access`: grant, revoke | Skool has no public API |
| Ads | **Meta CAPI**, Google Ads, Hyros | `ConversionSink`: send lead/booked/showed/purchase with hashed identity and click ids | The engine already keeps the touches |
| Glue | Zapier, Make, n8n | `GenericIngress` (verify, map to a neutral event) and an outbound hook | The way in for any vendor without an adapter |

## Shape

- Each port is a registry keyed by provider name; GHL registers under several ports.
- Every provider has `health()`, `install()` (register its webhooks), and either `ingress` (verify and parse a webhook) or
  `poll(since)`; the engine dedupes on a neutral `{ provider, id }` reference.
- An offer's config names its provider per port: `{ crm: "hubspot", scheduler: "calendly", messenger: ["twilio", "postmark"],
  notifier: "discord", payments: ["commas", "stripe"] }`.
- Steps take a person or a reference, never a vendor id. Templates use `{{mention}}`, `{{link}}`, `{{contact.crm_url}}`.
- `capabilities` drives fallbacks: no buttons → a signed ack link; no custom objects → custom fields; no SMS → a separate
  messenger.

## Build order

1. Make the existing adapters neutral (no new vendors): the Notifier and the `notify` / `deal` / `wait_for_ack` steps, CRM and
   scheduler split with metrics through the port, documents into `Signer`, calls into `Dialer`, Whop and Typeform as ports,
   neutral Fathom meetings, `provider_*` columns.
2. Commas through the generic ingress with a mapping (a native adapter only if Commas publishes an API).
3. Discord notifier, and email as the fallback.
4. HubSpot CRM, Twilio and Postmark messenger ("speed to lead from HubSpot to Discord").
5. Stripe payments, Cal.com scheduler.
6. Meta CAPI.
7. On demand: Close, Teams (a bot app), Zoom, PandaDoc, Pipedrive, Salesforce, Aircall, WhatsApp.
