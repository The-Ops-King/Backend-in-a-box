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

## Setting / triage (batches 4 and 5)

- **Triage kinds:** inbound, outbound, interception, cold calls, old-list reactivation.
- **Channels:** a dialer (all offers use GHL's today; Aloware, Close or Kixie possible), texts, DMs. No personal phones: every call
  must be in a system the engine can read.
- **Outcomes:** set, follow up, not a good time, not a good fit, not financially qualified, not qualified (other), wrong number, DND.
- **DND:** every workflow checks DND and stops for anyone who has it: a standard first check in every flow, and the send step itself
  refuses a DND contact as a safety net.
- **The end of day** lists only real conversations over a set length (per offer). Calls shorter than that need nothing, unless they
  were DND or a wrong number. A confirmation call must be told from a setting call better: a call to someone with an upcoming
  booking is almost always a confirmation.
- **Cadences** are per stage (new lead, no-show, follow-up, unresponsive …) and configurable (high, medium, low or none; text, email,
  calls). Tyler's default for a new lead: 3 calls on day 1, 2 on day 2, then 1 a day for the rest of the week. Setters work people
  who have not booked; confirmation calls are not a cadence.
- **Interception** (rare, per offer): a booking made straight from traffic gets a setter call to confirm they belong on the
  calendar; kept, or removed (the booking cancelled and counted as a DQ, not as the prospect cancelling).
- **Hot swap** (a setter hands a live lead to a closer): a setter SOP, not automation. It needs a calendar that can be booked for
  right now (no minimum notice).
- **Setter credit:** the setter who set the call the person showed up to. A no-show rebooked by another setter credits that setter.

## Before the call (batch 8)

- **Pre-call is a workflow**, not a setting: it sends its own texts, or starts the offer's GHL workflow through a step. Either way
  the health check confirms each expected reminder reached the person, and flags a call where one did not.
- **Confirmation** (reply YES, click) is optional per offer: steps in its workflow. Nothing is ever cancelled for not confirming.
- **Pre-call content** goes through tracked links (a short link the engine logs), so the booking card says who opened what and when.
  Watch percentage needs the video host's own data (Wistia, Vidalytics …): an optional connector, later.
- **Reschedules** (recommended, pending Tyler's yes): moved more than 24 hours ahead is a normal reschedule; within 24 hours is noted
  on the booking post as short notice; within 1 hour or after the start, with the link, is a late reschedule, counted on its own as a
  soft no-show so show rate stays honest, and the closer is told. A second reschedule of the same call is flagged as lower intent
  and gets a setter confirmation call; a third moves the card to At risk for the closer to keep or release. Never cancelled by the
  engine. The setter keeps the credit, the closer stays (Calendly's same-host setting), and reschedule rate is reported per closer,
  setter and source.
- **A day ahead,** every call is checked: a meeting link, an active closer on the roster, no double-booking on the closer's calendar,
  the person not DND. A failure goes to the closer and the alerts channel with its fix; a closer who is out has their calls reassigned.

## The call (batch 9)

Already decided: which person a recording is (D273, D306), a booking cancelled after its start is still the call (D276), a call in
parts is one call, a call handed to another closer is theirs (D254).

- **"Did X show?"**: 15 minutes after the start, with no recording and no host activity, the closer gets a DM with Showed / No-show.
  A tap starts no-show recovery at once; silence leaves it to the end of day. Nothing is written to the CRM until a person says so.
  On/off per offer.
- **No-show recovery:** a "missed you, rebook here" text and a setter rebook cadence (configurable). After a second no-show, nurture.
  A rebook by a setter credits that setter.
- **No recording** (Fathom forgotten, a phone call): the end of day asks the closer for three lines (outcome, what they want, next
  step) in place of the AI review; the call counts as "no recording", and repeated misses by a closer show in the digest.
- **Call reviews** go to the call-review channel, and whoever is in it sees them: each call's review, and a weekly per-closer trend
  (rubric scores, top objections, pain and goal groups). No DMs.
- **Odd calls:** a spouse or partner joining is still one call, one person; a manager who takes the call gets the credit; a call booked
  straight after a close (onboarding) is never a sales call; a business partner the prospect brings is added as a contact, and the call
  stays the booked person's.

## Not closed on the call (batch 10)

- **Follow-ups:** booked on the closer's own calendar; a follow-up date is not required.
- **Lost and DQ reasons** are recorded, but every lost person gets the same path: nothing branches on the reason.
- **Long-term nurture** is an email sequence, normally the offer's GHL workflow (today it is only a stage). The engine adds people to
  it and raises "warm again" to the setter or closer when someone replies, clicks, books or fills a form.
- **Downsell:** almost every offer has one, cheaper with fewer things: its own offer, so its own deal, price and payments, never
  counted as a main-offer close.
- **Failed payments:** the payment processor retries the card (Stripe, Whop …), not the engine. Every failure posts in the payments
  channel tagging the closer; a later success posts "recovered" in the same thread; still failed after the processor's last retry is
  past due, posted again and in the digest; a chargeback or dispute posts at once and alerts Tyler.

## The close (batches 6 and 7)

Already built, and it stays: a close is the first payment beyond a deposit **and** the agreement signed, in either order (Deal
closed fires on whichever comes second, once); a deposit is intent, never a close, sends no agreement and starts no chase (D119);
paid in full, deposit + balance, a payment plan, deposit + payment plan and split cards are told from what came before (D119, D322,
D329); a paid, unsigned agreement is chased daily; `/agreement` picks the agreement and the person (D202).

To build:

- **At the close:** card → Closed - Won, the Sales Call's outcome, every sales sequence stopped. The welcome (congrats, thank you,
  community invites …) is the offer's GHL workflow: a step adds the person to it through GHL's API, and the health check confirms its
  first message went out. An offer may run its own welcome workflow instead.
- **Agreements carry their adjustments:** "signed" is the agreement signed with whatever was added to it (scope, a lower price to
  get the deal across, add-ons). The adjustments are stored on the deal; the deal's contract value is what that agreement says.
- **Signed but not paid** is chased like paid-but-unsigned: a DM every 24 hours until the closer taps Pause or Cancel; Cancel asks
  where they stand, long-term nurture or lost. Both chases get the same two buttons.
- **Financing closes at funds sent:** through the business's own checkout (Klarna via Stripe or Whop is a normal payment), or a
  lender paying the business directly (ClarityPay). Approval alone is close pending.
- **Close pending** is a state with a date: paid and not signed, or signed and not paid. The owner is reminded on the date; past it,
  it is in the health digest.
- **After the close:** a refund soon after → Lost (refunded), and the closer's credit comes off; a failed installment → still
  closed, into collections.

## Direction (Tyler, 2026-11-22)

- **Evolve, not rebuild:** "I have a plan to rebuild but I want it fully functional first." The live offers are consolidated one
  at a time onto standard flows run by settings (an offer spec), not per-offer copies; each move is a dry run showing the offer's
  workflows behave the same.
- **No new installs for now.** The goal is TRC (Tiffany), PMU and the others fully live.
- **Reporting:** each client sees only their own numbers, and can change what they see: a client login per offer, a dashboard
  they arrange.
- **Ad spend** can be connected per offer (Meta, Google); nothing depends on it.
- **GHL workflows are allowed** for jobs Tyler prefers there (pre-call reminders, for one). The offer spec names which job a GHL
  workflow does, and the health check watches those too: the workflow exists and is published, and its outcome happened (for
  each upcoming call, the reminder it should have sent is in the conversation).
- **Autonomous health:** a problem is fixed when it can be; otherwise Tyler is alerted. Every fix is complete and improves the
  whole system, not one offer (CLAUDE.md, "Every alert fix prevents the next one").

## Later

- A Zoom integration: know a recording happened, and check it against Fathom.
- Renewals, second offers, upsells for existing clients.
