# Sales journeys beyond 09-possibilities (brainstorm, 2026-10-19)

Tyler: "brainstorm all of the potential sales journeys ... so we have the ability to use any of those quite easily." Builds on
`09-possibilities.md`. Missing column: **T** template only (the steps and events exist), **E** new event or door, **S** new step,
**X** new setting or data model.

What the engine hears today: the GHL polls (contacts, bookings, calls, cards, inbound messages, agreements), Calendly, the
Typeform webhook, Whop, Fathom, and the Zapier door (payments and recordings only; it folds dispute/chargeback into refunded).
Written but started on by nothing: `message.received`, `opportunity.won/lost`, `payment.paid_in_full`, `agreement.sent`,
`tag.removed`. Written by nothing: `intake.recorded`, `contact.created`, `contact.merged`, `stage.changed`.

## A. Lead sources and capture

| # | Journey | Has | Missing |
|---|---|---|---|
| L1 | Meta/TikTok instant-form lead | new-lead, speed-to-lead, lead-source | E direct lead-ads door; X ad/adset/creative ids for source to cash |
| L2 | VSL opt-in → watched → applied or not | send, wait, branch | E content.engaged (Wistia/Vidalytics/Hyros); T watched-not-applied chase; X asset per avatar |
| L3 | Webinar: register, remind, attend/miss, replay, book or checkout | send, wait, wait_for_event | E webinar door; T three templates; X event date |
| L4 | 3–5 day challenge with VIP upsell and pitch day | calendar-availability | E attendance per day; X cohort start-date anchor |
| L5 | Quiz/application with scoring and routing | branch, set_var, MQL/DQ | S score; X tier routing table; E GHL form answers |
| L6 | DM setting (IG/FB/TikTok) | call-booked setter field | E DM door (ManyChat); X setter id on the booking link |
| L7 | Inbound and missed phone calls | call.logged (outbound only) | E inbound/missed direction; T missed-call text-back |
| L8 | Outbound/cold lists | classify, wait_for_reply | E bulk import door; S cadence; X DNC/consent |
| L9 | Affiliate/partner leads | new-lead | X partner attribution and commission |
| L10 | Organic lead magnet | reactivation (one shot) | S cadence |

## B. Qualification

| # | Journey | Has | Missing |
|---|---|---|---|
| Q1 | Speed-to-lead SLA: no dial in 5 min → setter, then manager | all of it | T |
| Q2 | AI setter over SMS: asks, books, hands off | send_sms, wait_for_reply, classify, pause_runs | S converse (multi-turn, guardrails); S book_appointment / offer slots |
| Q3 | Low-ticket buyer → high-ticket call (ascension) | payment.received | X product catalog (every payment reads as the high-ticket deal today); T buyer-to-call |
| Q4 | Budget fail → financing or downsell | branch, send | E financing events; X downsell product |
| Q5 | Setter triage by phone, then books the closer | setter-call-logged | — |

## C. Booking

| # | Journey | Has | Missing |
|---|---|---|---|
| B1 | Engine-side round robin (weights, tier, language, PTO, capacity) | the booking tool does RR | S assign; X roster weights/PTO; E appointment.reassigned |
| B2 | Triage showed, closing never booked | Dating's triage workflows | T |
| B3 | Group/class close with checkout deadline | send, wait | E attendance, checkout.started/abandoned; X cart deadline |
| B4 | Book from a text ("reply 2 for Tue 3pm") | classify | S book_appointment; E message.received as a start |
| B5 | Hot transfer to a free closer | notify_owner | S availability-now; E transfer |
| B6 | Booked but intake form not filled | send, wait_for_event | E intake.recorded |
| B7 | No slots left → setter callback | calendar-availability, create_task | T |
| B8 | Other booking tools (iClosed, OnceHub, Cal.com) | call-booked | E generic booking door |

## D. Show-up

| # | Journey | Has | Missing |
|---|---|---|---|
| S1 | Late-join rescue at T+2 min | send_sms, notify_owner | E Zoom/Meet participant events (D102 meeting key matches them) |
| S2 | Pre-call homework tracked | pre-call-sequence | E content.engaged; X asset library |
| S3 | WhatsApp, voicemail drop, AI reminder call | sms, email | S send_whatsapp, send_voicemail / ai_call |
| S4 | Multi-day no-show chain → setter re-dial task | no-show-recovery (one round) | T |
| S5 | Closer cancels / no-shows | partial | E who cancelled; S assign |

## E. Closing outcomes

| # | Journey | Has | Missing |
|---|---|---|---|
| C1 | Deposit: balance due by a date | D119 deposits | X balance due date; T balance-due ladder |
| C2 | Payment plan schedule | plan tags | X plan schedule; E payment.due |
| C3 | Third-party financing (Klarna, Affirm, Cherry, Elective) | financing_denied reason | E financing.*; T financing pending |
| C4 | Payment link sent on the call, unpaid after 15 min | send | S/E payment link, checkout abandoned |
| C5 | Partner objection → second call with the partner | post-call-follow-up | T follow-up by objection |
| C6 | Downsell after lost on price | branch, send | X product catalog |
| C7 | Closing DQ → refer out | webhook | T |

## F. Post-sale

| # | Journey | Has | Missing |
|---|---|---|---|
| P1 | Onboarding handoff (access, onboarding call in 48h) | deal-closed, webhook | X call types beyond closing; T onboarding-not-booked |
| P2 | Refund-window save flow | classify | E refund.requested |
| P3 | Client-facing dunning | payment-failed (Slack only) | T + X dunning ladder |
| P4 | Chargeback evidence pack | the data is in the ledger | E payment.disputed (the Zapier door folds it into refunded); S evidence bundle |
| P5 | Refund: clawback, revoke access, exit survey | payment-recorded | X commission; T |
| P6 | Upsell mid-program | wait, create_task | E milestone door; X close-date anchor |
| P7 | Renewal at term end | none | X contract term; T |
| P8 | Referral and testimonial ask | send | E survey/NPS door; X referral codes |

## G. Nurture and reactivation

| # | Journey | Has | Missing |
|---|---|---|---|
| N1 | 6–12 month nurture | reactivation (one shot) | S cadence (N messages, spacing, stop on book/reply) |
| N2 | Scheduled cohort finder (lost 90d, never rebooked, deposit never balanced) | lookup (fixed queries) | S find_contacts → start workflow, throttled |
| N3 | Intent spike → tell the last closer | notify_owner | E click/visit |
| N4 | Broadcast to a segment, throttled | send window | S N2 + daily cap |
| N5 | Opt-out across every run (STOP) | send lock, send window | E opt-out that ends runs; consent proof |

## H. Team operations

T1 setter EOD (T + setter form) · T2 unworked-leads board (T) · T3 commissions (S/X) · T4 call review queue and scorecard trend
(T) · T5 rep certification gate (X) · T6 morning brief per rep (T) · T7 stale card / no outcome after 24h (T).

## I. Reporting

R1 source to cash with ad spend (E ad-spend import) · R2 revenue leak (X plan schedule) · R3 cash forecast (X) · R4 owner's
weekly email (T) · R5 two offers in one company (X offer dimension).

## Gaps that block "any offer in a couple of hours", in order

1. A generic signed webhook door with a field map: any JSON becomes lead.created, form.submitted, payment.* (with disputed),
   financing.*, event.registered/attended, content.engaged, agreement.signed or a booking. Today every new tool is code.
2. A product/offer catalog: each product or plan has an offer and a role (front end, deposit, core, plan, downsell, upsell,
   renewal), a price and a schedule.
3. Payment schedules and dunning: a plan object, payment.due, a client-facing failed-payment ladder, payment.disputed.
4. Cadence and segment primitives: a multi-touch sequence that stops on reply/book/event; a scheduled find_contacts.
5. Score, route, assign: `score`, `assign` (round robin, weights, tier, PTO, capacity), the owner rule.
6. Call types per offer beyond closing (onboarding, follow-up, renewal, upgrade).
7. Turn on the dormant events.
8. book_appointment and converse (the AI setter, book-from-text).
9. Meeting attendance events (webinars, challenges, late-join rescue).
10. Commissions; extra channels (WhatsApp, voicemail drop).
