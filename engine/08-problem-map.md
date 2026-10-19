# The problem map (Tyler, 2026-10-18)

Tyler's list of the problems an offer's sales operation has, mapped against what the engine does today. It is the menu
of what is sold and what is built next, so nothing is built blind. These are problems, not automations: some are solved by
a workflow, some by data, some by a service outside the engine. Status was checked against the templates, the code and
the decisions on 2026-10-18.

Status: **Built** (sellable now), **Partial** (something exists; the gap is named), **Queued** (written down in the open
list, not built), **None**, **Service** (Tyler's call: not the engine).
Kind: **Core** (every offer gets it), **Module** (a playbook adds it when the offer's process needs it), **Service**.
CF = sends to the contact (text or email); everything else is internal (Slack, CRM, alerts).

## 1. Intake and capture

| # | Problem | Status | What does it today | Gap | Kind |
|---|---|---|---|---|---|
| 1 | Lead scoring and routing | Partial | D73 MQL/DQ counts from the qualifying answer; Call booked makes the closer the owner | No score, no routing to setter / closer / triage (#39, #44) | Module |
| 2 | Speed to lead | Built | `speed-to-lead` (CF); `speed_to_lead` metric | The live "nobody has called yet" ping to reps (#37) | Core |
| 3 | Attribution to revenue | Partial | lead-source.ts (D78), first-touch UTMs and fbclid on Call booked, metrics by source | Source to cash (D25 full attribution, #38) | Core |
| 4 | Applied, never booked | Partial | `speed-to-lead` sends one email when no call is booked after 2h | No chase beyond that; never-booked cards sit at New Lead (#36) | Core |
| 5 | Quiz-style profiling before the call | Partial | Typeform answers into GHL fields (D122); booking card intake lines (D104) | No score or profile summary; answers route nothing | Module |
| 6 | Duplicates and dirty data | Partial | contact-truth (D68), one person over two records (D60), Health flags duplicates (D63) | Detects only; merging is by hand in GHL | Core |
| 7 | Instagram DM leads never reach the CRM | None | — | A DM intake (ManyChat or the IG API) to a new lead | Module |

## 2. Setting and booking

| # | Problem | Status | What does it today | Gap | Kind |
|---|---|---|---|---|---|
| 8 | Setter-to-closer handoff loses context | Built | `call-booked` booking card with intake and source; `setter-call-logged` posts Jev's notes, pains, fit | — | Core |
| 9 | Triage call as a filter | Partial | Dating's Triage call copy and call type (D123) | Not a shipped template; the routing rule to triage (#44) | Module |
| 10 | Closer capacity, overbooked vs idle | Partial | `calendar-availability` warns on few slots; `/availability` per closer (D72) | No balancing between closers (#37 capacity planning) | Module |
| 11 | Two reps on the same lead | None | — | Claim or owner rule, and an alert when a second rep works an owned lead | Core |
| 12 | Setter activity and EOD | Built | `setter-call-logged`, closer EOD (`eod-reminder`, `eod-filed`, D34), dial metrics | Setters have no EOD form | Core |

## 3. Before the call

| # | Problem | Status | What does it today | Gap | Kind |
|---|---|---|---|---|---|
| 13 | Double confirmation; double-book the unconfirmed | Partial | `pre-call-sequence` (CF): confirm by reply, `stat-unconfirmed` after 4h, Slack | No overbooking of unconfirmed slots. Needs a rule for both showing up | Module |
| 14 | Confirmations that read real replies | Built | `pre-call-sequence` (CF): Jev classifies replies (D13), buttons for the unclear | A reply with no run waiting is ignored (#20) | Core |
| 15 | Pre-selling by avatar (VSL, landing pages) | None | PMU's `vsl a` / `vsl b` tags only | The pages are content. The engine's part: tag the avatar, send that avatar's pre-call asset | Module |
| 16 | Testimonial library by demographic and fear | None | — | The library is content. The engine's part: pick from it by profile and objection | Module |
| 17 | Objection mining from 300-500 calls | Service | (the call notes and objections the engine already pulls feed it) | — | Service |
| 18 | No-show recovery | Built | `no-show-recovery` (CF), `call-outcome` | — | Core |
| 19 | Reschedule and cancel loops | Built | `call-cancelled`, `cancellation-rebook` (CF), reschedules on Call booked (D76) | No cap or flag on serial rescheduling | Core |
| 20 | Texts and email not delivering | None | Dark hours, transactional pass-through (D62), no duplicate sends | Delivery rates per channel from the sends ledger, alerted; the fix is the deliverability service | Core + Service |

## 4. On the call

| # | Problem | Status | What does it today | Gap | Kind |
|---|---|---|---|---|---|
| 21 | Rep needs the founder for product questions | Service | — | A Kravok / GPT add-on, not the engine | Service |
| 22 | Recordings nobody reviews | Built | `call-recorded`: AI notes and rubric score in Slack; `recording-unlinked` | Scorecards over time (#37) | Core |
| 23 | Outcomes and notes never reach the CRM | Built | `call-outcome`, `card-moved`, Sales Call records, backfill (D115) | — | Core |
| 24 | Agreement and payment link sent inconsistently | Built | Agreement on the first payment past a deposit (D119), `agreement-chase`, manual send | No payment-link send | Core |

## 5. After the call

| # | Problem | Status | What does it today | Gap | Kind |
|---|---|---|---|---|---|
| 25 | Follow-up by objection | Partial | `post-call-follow-up` (CF), one text; `primary_objection` pulled from the call | The follow-up is not chosen by objection (#37, #41) | Module |
| 26 | Pipeline rot | Partial | `card-moved`, `ledger-drift` | No stale-card rule (#36); follow-up hygiene nudges (#41) | Core |
| 27 | Deposits and payment plans | Built | D119 deposits, `payment-recorded` plan and paid-in-full tags, deposit metrics | Payment-plan schedule (what is due when) | Core |
| 28 | Failed payments, no recovery | Partial | `payment-failed`: Slack and the closer | The client hears nothing; no recovery sequence | Core |
| 29 | Nurture and reactivation of aged lists | Partial | `reactivation` (CF) on a tag, once per 90 days | Manual trigger; no aged-list finder, no long nurture | Module |

## 6. Team

| # | Problem | Status | What does it today | Gap | Kind |
|---|---|---|---|---|---|
| 30 | Closer onboarding, the 80% that is the same | Queued | Operator action "onboard a person" (#41) | Ramp material is content; the engine sets the person up | Module |
| 31 | Onboarding extremes | Service | — | Training design | Service |
| 32 | Rep KPIs without asking | Built | `weekly-leaderboard`, wrap-ups, the bot's `/close-rate`, `/cash` (D70) | — | Core |
| 33 | Commission tracking | Queued | #37, #41 ("with refund clawbacks") | Not built | Module |
| 34 | Rep churn from bad ramp | Service (partly) | Scorecards and KPIs show a struggling rep early | — | Service |
| 35 | Hiring pipeline for closers | Service | — | — | Service |

## 7. Handoff and visibility

| # | Problem | Status | What does it today | Gap | Kind |
|---|---|---|---|---|---|
| 36 | Sale-to-fulfillment handoff | Partial | `deal-closed` (CF): customer tag, won, welcome, Slack | No handoff to the fulfilment team or tool | Module |
| 37 | Founder dashboard | Partial | Dashboard, wrap-ups, the bot | Owner's digest, revenue leak, cash forecast (#37, #41) | Core |
| 38 | Founder still on calls | Service | — | — | Service |

## 8. Infrastructure

| # | Problem | Status | What does it today | Gap | Kind |
|---|---|---|---|---|---|
| 39 | Duct-tape stack (Sheets as CRM, breaking Zaps) | Built in principle | The engine replaces the chains; Health check finds what breaks | Proven by each takeover (#40) | Core |
| 40 | Forcing a tool past what it was built for | Built in principle | Logic lives in the engine, the CRM holds records | — | Core |
| 41 | Over-customised CRM nobody can maintain | Partial | Templates and playbooks (#53), versions, audit log | Playbooks not built yet | Core |
| 42 | The team does not use the system | Partial | Slack-first cards, EOD links | Adoption measured per rep (EOD filed, outcomes filed, cards moved on time) | Core |
| 43 | No SOPs, one person knows it | Partial | describe.ts plain English | Drillable explanations (#46); an SOP per playbook generated from it | Core |

## What this says

- **Sellable today:** 2, 8, 12, 14, 18, 19, 22, 23, 24, 27, 32 are built and in the core set.
- **Gaps inside the core set:** every install carries these, so they come before new modules. 4 never-booked chase, 11 two reps on one lead,
  26 stale cards, 28 failed-payment recovery, 12 setter EOD, 20 delivery rates, 6 merge, 3 source to cash, 42 adoption.
- **Modules** are what playbooks add: 1, 5, 7, 9, 10, 13, 15, 16, 25, 29, 30, 33, 36.
- **15, 16, 30 are mostly content.** The engine only routes it: the VSL, the testimonials and the ramp material have to
  exist first. The engine's job is choosing which one a contact or rep gets.
- **13 carries a risk.** Overbooking unconfirmed slots means two people can show for one slot. It needs a rule for that
  before it is built.
- **The wizard's intake asks which of these problems the offer has.** The answers pick the playbook's modules, and the
  gaps found become that offer's build list (#53).
- "Instant data" is already the design: every event lands in the ledger the moment it happens. The dashboard is a view on
  it, built later.
