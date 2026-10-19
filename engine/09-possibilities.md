# Every possibility: journeys, their GHL triggers, offer types (Tyler, 2026-10-19)

Tyler: "brainstorm all the possibilities and create them as templates and trigger steps." Three lists, each row with a
recommended call. **Mark the Call column** (Build / Later / Cut, or a note) and nothing below gets built until you have.

- **Part A**: every path a lead can take. Each one becomes a test journey (D179) and, where no workflow handles it, a template.
- **Part B**: every way a client's own GHL workflow can fire on what the engine does. It feeds the check at every rung up and the filters step.
- **Part C**: the kinds of offer you'll onboard. Each one becomes a playbook.

Today's harness can stage: `form`, `create`, `book` (setter), `book-self`, `reschedule`, `cancel`, `pay` (full or deposit),
`record`, `outcome`, `call` (setter dial), `agreement`, `sign`, `reset`. "New action" below means a harness action to add.

## Part A. Sales journeys

**Handled by** names today's workflows. **Gap** is what's missing. Journeys 1–8 are D179's, already built.

### A1. Getting in

| # | Journey | Handled by | Gap | Call |
|---|---|---|---|---|
| 1 | Lead lands in the CRM (ad form, GHL form) | `new-lead`, `speed-to-lead` | — (built) | Built |
| 2 | Applies through Typeform | `new-lead` + the Typeform door (D122) | — (built) | Built |
| 3 | Applies through a GHL form | `new-lead` (`lead.created`) | Answers aren't read into the profile; new action `form-ghl` | Build |
| 4 | Applies, never books | `speed-to-lead` (one email at 2h) | No chase after that (problem 4); a template "Applied, not booked" | Build |
| 5 | Applies and is DQ'd by their answers | — | No rule; a template "Disqualified by application" (tag, DQ card, polite no) | Build |
| 6 | DMs on Instagram, never reaches the CRM | — | Problem 7: a DM door (ManyChat webhook to `lead.created`) | Later |
| 7 | Referral (added by hand with a referrer) | `new-lead` | Referrer isn't credited; source "referral" with the referrer's name | Later |
| 8 | Same person comes in twice (new email, same phone) | contact-truth (D60, D68) | Detects only; a test journey that proves no double runs | Build (journey only) |
| 9 | Old lead re-applies after 90+ days | `new-lead` re-entry rules | Should count as a returning lead, not new; journey + flag on the card | Build |

### A2. Setting and booking

| # | Journey | Handled by | Gap | Call |
|---|---|---|---|---|
| 10 | Setter dials, connects, books | `setter-call-logged`, `call-booked` | — (built: `call` + `book`) | Built |
| 11 | Setter dials, no answer ×N | `setter-call-logged` | No attempt cadence or "N dials, no connect" rule; template "Dial cadence" | Build |
| 12 | Setter dials, DQs on the call | `setter-call-logged` (classifier) | Outcome isn't filed as DQ on the setter board; new action `call --dq` | Build |
| 13 | Self-books the closer call | `call-booked`, `pre-call-sequence` | — (built) | Built |
| 14 | Books the triage call first, then the closer | Dating's triage copy (D123) | Not a shipped template (problem 9); journey `triage-then-close` | Build |
| 15 | Books twice (two slots, same person) | — | No rule; template "Double booking" (keep the earlier, cancel or flag the other) | Build |
| 16 | Books a calendar we don't map (their old calendar) | poll ignores it | Silent; a Health line "booking on an unmapped calendar" | Build |
| 17 | Two reps work the same lead | — | Problem 11: owner rule + alert | Later |

### A3. Before the call

| # | Journey | Handled by | Gap | Call |
|---|---|---|---|---|
| 18 | Replies "yes" to the confirmation | `pre-call-sequence` (Jev classifies) | Harness can't stage a reply; new action `reply` (text, channel) | Build |
| 19 | Replies "can we move it" | `pre-call-sequence` → reschedule path | Same: `reply` | Build |
| 20 | Replies something unclear | `pre-call-sequence` → Slack buttons | Same: `reply`; then the button tap (`react`) | Build |
| 21 | Never replies | `pre-call-sequence` → `stat-unconfirmed` | — (waits; journey with time travel, see A7) | Build (journey) |
| 22 | Reschedules | `call-booked` reschedule (D76) | — (built) | Built |
| 23 | Reschedules a 3rd time | — | Problem 19: cap or flag serial rescheduling; template rule | Build |
| 24 | Cancels | `call-cancelled`, `cancellation-rebook` | — (built) | Built |
| 25 | Cancels, then rebooks from the rebook text | `cancellation-rebook` | Journey `cancel` → `book-self` proving the rebook run stops | Build (journey) |
| 26 | Books less than 15 minutes out | `pre-call-sequence` (stale by design) | Journey proving only the right messages go | Build (journey) |

### A4. The call

| # | Journey | Handled by | Gap | Call |
|---|---|---|---|---|
| 27 | Shows, closes, pays in full, signs | `call-outcome`, `payment-recorded`, `deal-closed`, `agreement-*` | — (built) | Built |
| 28 | Shows, deposit, pays the rest later | D119 deposit path | Journey `deposit` → `pay` the balance | Build (journey) |
| 29 | Shows, payment plan, pays installments | `payment-recorded` plan tags | What is due when (problem 27); template "Plan installment due" | Build |
| 30 | Shows, "close pending" (thinking about it) | `call-outcome` | Journey; follow-up by objection is problem 25 | Build (journey) |
| 31 | Shows, follow-up booked | `call-outcome` | Journey (`outcome follow_up` + `book-self`) | Build (journey) |
| 32 | Shows, lost (with reason) | `call-outcome` | Journey | Build (journey) |
| 33 | Shows, DQ | `call-outcome` | Journey | Build (journey) |
| 34 | No-show (GHL marks it, not the EOD) | `no-show-recovery` (`appointment.status_changed`) | New action `noshow-status` (the poll's version, not the EOD's) | Build |
| 35 | No-show, rebooks from the recovery text | `no-show-recovery` | Journey proving the recovery run stops | Build (journey) |
| 36 | Call recorded but nobody files the EOD | `eod-reminder` | Journey with the reminder fired | Build (journey) |
| 37 | Recording matches no contact | `recording-unlinked` | New action `record --unmatched` | Build |
| 38 | Rescheduled or cancelled on the call itself | `call-outcome` (rescheduled) | Journey | Build (journey) |

### A5. Money and paper

| # | Journey | Handled by | Gap | Call |
|---|---|---|---|---|
| 39 | Payment fails | `payment-failed` (Slack + closer) | Client hears nothing (problem 28); new action `pay --failed`; template "Failed payment recovery" | Build |
| 40 | Refund | `payment-recorded` (`payment.refunded`) | New action `refund`; commission clawback is problem 33 | Build (action) |
| 41 | Payment from someone we can't match | `payment-unlinked` | New action `pay --unmatched` | Build |
| 42 | Pays before the call (link sent early) | `payment-recorded` | Journey: no booking, then pay | Build (journey) |
| 43 | Agreement sent by hand (tag) | `agreement-send-manually` | New action `tag <name>` | Build |
| 44 | Agreement sent, never signed | `agreement-chase` | Journey with time travel | Build (journey) |
| 45 | Signs before paying | `agreement-signed`, `deal-closed` | Journey (order flipped) | Build (journey) |
| 46 | Chargeback / dispute | — | Whop sends it; template "Dispute" (Slack, owner, freeze) | Later |

### A6. After

| # | Journey | Handled by | Gap | Call |
|---|---|---|---|---|
| 47 | Closed, handed to fulfilment | `deal-closed` (welcome, Slack) | Problem 36: handoff to their fulfilment tool | Later |
| 48 | Lost, reactivated in 90 days | `reactivation` (tag) | Manual trigger; template "Aged list" that finds them (problem 29) | Build |
| 49 | Card moved by hand in GHL | `card-moved` | New action `move-card` | Build |
| 50 | Contact deleted or merged in GHL mid-journey | runs exit moot (`gone_at`) | New action `gone`; journey | Build |

### A7. What the harness needs to run these

| # | Piece | Why | Call |
|---|---|---|---|
| H1 | **Time travel**: fast-forward a journey's waits (move `next_run_at` to now, one wait at a time) | Journeys 21, 26, 36, 44 wait hours or days; without it they can only prove "waiting" | Build |
| H2 | New actions: `reply`, `react`, `tag`, `move-card`, `noshow-status`, `refund`, `pay --failed`, `pay --unmatched`, `record --unmatched`, `gone`, `form-ghl`, `call --dq` | Listed above | Build |
| H3 | Journeys are data (a list per playbook, in the template business), not code | So a new offer type adds journeys without a deploy | Build |
| H4 | Expected runs per journey ("won" must start Call booked, Call outcome filed, Payment recorded, Deal closed) | Today a journey passes if nothing fails; a workflow that silently never starts would pass | Build |

## Part B. Their GHL workflows: what fires on what the engine does

The engine writes to the test contact (on the test rung) and, once live, to every contact. Each row is a GHL trigger
their own workflows can use, what the engine does that fires it, and the filter that keeps their workflow off.

**One limit to know first:** GHL's API lists a location's workflows (name, status, published) but **does not return their
triggers, filters or actions**. So the engine can say "these 23 workflows exist, 4 are new since your last check" but
not "this one fires on tag X". You classify each one by opening it in GHL. The checklist is the trigger types below.

| # | GHL trigger | What the engine does that fires it | Test-contact filter | When live | Call |
|---|---|---|---|---|---|
| B1 | Contact Created | The wizard's "create test contact" button; the engine never creates leads otherwise | Tag doesn't include `sys-test` | — | Build (checklist) |
| B2 | Contact Tag (added/removed) | Every tag step (`booked`, `showed`, `deposit`, `paid in full`, `customer`…) | Tag doesn't include `sys-test` | Theirs on the same tag runs twice: replace or off | Build (checklist) |
| B3 | Pipeline Stage Changed | Every card move (both boards) | Tag doesn't include `sys-test` | Theirs on the same stage runs twice | Build (checklist) |
| B4 | Opportunity Created / Status Changed (won/lost) | Card made at booking; won at Deal closed | Tag doesn't include `sys-test` | Same | Build (checklist) |
| B5 | Contact Changed (custom field) | Field writes (closer, call date, objection, source) | Tag doesn't include `sys-test` | Any "field changed" workflow | Build (checklist) |
| B6 | Custom Object record created/updated (Sales Call) | Sales Call records (D115) | (GHL filters on the record's contact: tag) | Same | Build (checklist) |
| B7 | Note Added / Task Added | Notes and tasks steps | Tag doesn't include `sys-test` | Rare, but check | Build (checklist) |
| B8 | Document sent / signed | `send_document` (agreement) | Tag doesn't include `sys-test` | Their own agreement flow runs twice | Build (checklist) |
| B9 | Date reminder (a date field) | The engine writes call-date fields | Tag doesn't include `sys-test` | A reminder on that field doubles ours | Build (checklist) |
| B10 | Appointment Status | **Not fired by staged bookings** (they're ours only); fired by real bookings once live | — | Their confirmations + ours: replace or off | Build (checklist) |
| B11 | Customer Replied / Inbound Message | The test contact replying to our texts (you, from your phone) | Tag doesn't include `sys-test` | Their reply bots fight Jev's | Build (checklist) |
| B12 | Email events (opened, clicked) / Trigger Link Clicked | Our emails, if they carry their trigger links | Tag doesn't include `sys-test` | Rare | Build (checklist) |
| B13 | Form Submitted / Survey | Not fired by the engine (staged forms are ours) | — | Their form → their workflow stays theirs | Build (checklist) |
| B14 | Payment / Invoice / Order | Not fired by the engine (payments come from Whop/Stripe) | — | Theirs stays | Build (checklist) |
| B15 | Inbound webhook / Zapier | Only if their Zaps listen to GHL events above | Same filter in the Zap | Their Zaps on our tags | Build (checklist) |

Each of their workflows gets one mark: **replaced** (ours does it; turn theirs off at go-live), **kept + filter** (stays,
with the `sys-test` filter, and with a "not engine-handled" filter at go-live), **harmless** (fires, does nothing bad), or
**off**. Marks are re-asked when the workflow list changes, and before every rung up (your answer: every rung up).

## Part C. Offer types (playbooks)

Today's playbooks: **Setter and closer** (Hair, two boards), **One board** (PMU), **Application and triage** (Dating).

| # | Offer type | Journey shape | Traits | New templates it needs | Call |
|---|---|---|---|---|---|
| C1 | High-ticket coaching, setters + closers | Ad → app → setter → closer → pay/plan | two boards, app, setters, plans | — (Hair) | Built |
| C2 | Service sold on one call, no setters | Ad → book → call → deposit → balance | one board, deposits | — (PMU) | Built |
| C3 | Application with triage | App → triage → closer | app, triage | Triage as a shipped template (A14) | Built (partly) |
| C4 | Med spa / aesthetics consult | Ad → book consult → show → deposit → treatment booked | one board, deposits, no agreement, high no-show | Treatment booking after close; rebook cadence | Build |
| C5 | Agency / B2B retainer | Inbound → discovery → proposal → contract → first invoice | one board, proposal stage, agreement-first | "Proposal sent / chase", contract before payment (A45) | Build |
| C6 | Course or program via webinar | Webinar reg → attend/no → call or checkout | event attendance, mixed self-checkout | Webinar door (registered, attended), "attended, didn't book" | Later |
| C7 | Low-ticket front end to high-ticket call | Buys $X → onboarding → upsell call | payment first, call second | Pays-before-call (A42) as the main path | Later |
| C8 | Local services estimate | Form → estimate visit → quote → job | field visit, quote, deposit | Quote stage and chase | Later |
| C9 | Takeover of any of the above | Their system → mapped → swapped | per offer | The mapping step (#53 P2) | Build (P2) |

## What gets built once you've marked it

1. The harness pieces (A7: time travel, the new actions, journeys as data, expected runs).
2. Each **Build** journey added to its playbooks' template businesses, run on the snapshot sub-account's test contact.
3. Each **Build** template through the build-workflow skill, one at a time, with its own questions.
4. The Part B checklist in the GHL workflows step (step 8) and at every rung up.
5. Each **Build** offer type as a playbook, starting from the closest one.
