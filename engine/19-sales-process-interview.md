# 19. The sales process, piece by piece (interview with Tyler, from 2026-11-09)

Tyler: "a fully autonomous engine that runs workflows really well … when we onboard a new client, it is smooth, everything goes to
the right channel, we know which channels need to be added, and we can have a minimum install, like a 1-hour to 1-day install."
This file holds what the interview decides, batch by batch. Nothing here is built yet: it is the plan the build follows.

## The rule

The engine makes no business decision. It has three parts that work together: the workflows, the engine that runs them, and the
Slack bot.

| Part | Owns | Never does |
|---|---|---|
| Connectors | Turning outside changes into events: GHL every minute, plus Calendly, Typeform, Whop and Fathom where GHL cannot hold the data | Decide anything |
| Runner | Runs workflows: retries, quiet hours, kill switch, test/live mode, and the step history | Hold any offer's rules |
| Step types | The building blocks a workflow is made of ("match person", "qualify", "send", "check history" …) | Choose their own settings |
| Workflows | Every behaviour, as steps with settings, chosen per offer | Plumbing |
| Slack bot | Team commands and questions in, posts out | Hold rules of its own |

- A new offer's install is choosing the flows, filling in their settings and connecting the tools.
- One source of truth: the offer's CRM (GHL today). Every entry point should land there. The engine reads the CRM and stores what it
  needs to run; facts about a person (sources, lead magnets, touches) live on the CRM's objects, not only in the engine.
- **Calendars** are trigger settings. Each flow lists the calendars it fires on (a triage flow, a closing flow, maybe a
  follow-up/rebook flow). The connector reads every calendar the booking tool has; there is no watch list. The flow that handles a
  booking stamps its call type on it (triage, closing …) for the end of day, metrics and recording matching.
- **Duplicates and identity** are a step. An event (a recording, a form, a booking) can start a workflow before it has a person; the
  first step, "match person", uses the offer's own priority (email first, name first …).
- **"Already sent?"** is storage the workflow checks: the step history. The send step writes there just before it sends, so a step
  re-run after a crash sees it. Any business check ("texted them today?") is a step reading that history.

## Leads: how someone comes in

A lead needs an email or a phone. Lead types, each with subtypes:

- **Form:** Typeform (quiz, opt-in, application, VSL opt-in), GHL forms and surveys, Facebook/Instagram native lead forms (source
  says which), chat widget. A form started and left with an email or phone is a full new lead, tagged `abandoned`.
- **Lead magnet:** one of any number (PDF, video, mini course …), free or paid. A paid one is a low-ticket purchase, possibly with
  upsells. It records "lead magnet" and which one.
- **Webinar:** any platform. Each state is its own touch: registered, attended (and how long), no-show, watched the replay, booked
  from it, bought on it. Booking goes through the booking flows and buying through the payment flows.
- **Direct booking:** a booking with no opt-in before it (VSL → book, a link shared anywhere) is a new lead and a booking.
- **Social DM:** a lead the moment the ManyChat/GHL integration creates the contact, source "DM", no email needed.
- **Referral / affiliate:** a referral link (`utm_source=referral&utm_content=<referrer>`), with a "who referred you?" form question
  as fallback. The referrer is stored on the contact; a close credits them (a record and a Slack line). Payouts later.
- **Manual / cold outbound / inbound call or text:** added by the team.
- **Import:** contacts tagged `imported` on the import get only the minimum (fields, owner, a touch marked "import"): no new-lead
  post, no sequences, no speed-to-lead. Later events about them (a booking, a payment) run as usual.

Not entry points: database reactivation, existing clients (renewals, second offers and upsells are planned later).

## What a lead's arrival does

- A returning person (a second magnet, a rebook, an opt-in again) is no new lead: the lead is updated with the new touch and source.
- **Lead Touch** custom object in the CRM: one record per touch (type, subtype or magnet, source, UTMs, date); the contact keeps
  **First touch** and **Latest touch** fields.
- **Spam / test:** err on trusting. Held back only when clear: a test email or tag, both email and phone invalid, the same submission
  again within seconds. Anything doubtful goes through as a lead flagged to check.
- **Qualification** is a "qualify" step with the offer's rules (form answers → tier 1 to 4), or read from the form when the form
  scores it.
- **First response** is the workflow's choice: a post whoever grabs, an @setters ping, or an assigned owner.
- **The new-lead post:** basic information, every form they filled in, and the source; configurable per workflow.

## Later

- A Zoom integration: know a recording happened, and check it against Fathom.
- Renewals, second offers, upsells for existing clients.
