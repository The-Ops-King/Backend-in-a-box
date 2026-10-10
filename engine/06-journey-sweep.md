# The journey sweep: one contact, new lead to paid in full, and what slips through

Tyler, 2026-10-10: "Can we run a logic sweep end to end? See the flow of a single contact from new lead to closed and
fulfilled… make sure end to end nothing gets lost, no tags are being added and then immediately removed." This file is
that sweep. It walks one contact through every shipped template exactly as the templates and the executor do it today
(node ids are the templates'; file:line references are to `platform/src/`), then lists what is wrong or missing, each
with a severity and the test that shows it. The tests are `platform/src/engine/journey.test.ts`: one long scenario
(Jordan Vale, lead → setter call → setter-booked → confirms by text → reminders → shows on a recording → EOD filed →
deposit → agreement → signed → paid in full), one for a call booked five hours out (Kai), and three side roads (a
texted cancel, a show the closer filed with no recording, a no-show who rebooks). Every Finding has an `it.fails` test
there that states the right behaviour; the engine is not changed by this sweep.

`05-edge-cases.md` is the per-template edge-case catalogue; its Known gaps G1–G10 are cross-referenced here, not
repeated. Bindings referred to as `crm.*` are the ones the templates render (`grep 'crm.stage_' templates/*.json`):
setter board `stage_setter_new_lead / appointment_set / direct_booked / showed / cancelled`; closer board
`stage_closer_scheduled / agreement_sent / closed_won / cancelled`. **No template knows a closer "Showed", "Lost" or
"No-show" stage, or a setter "No-show" stage** — that absence drives several findings below.

## 1. The journey, stage by stage

Legend: *Setter card* / *Closer card* are the contact's open cards on the two boards after the step (stage, name,
status). "—" means the step does not touch it. Tags are the literal tags a step adds (+) or removes (−). *Slack* names
the channel binding and whether the post is its own message or a reaction + thread line on the booking post
(`tag:appointment:<id>`, D44). Timing is what the executor does with waits and `validity.min_lead`.

### 1.1 Lead created (`lead.created`, from the CRM poll or a form)

| Event | Workflow | Setter card | Closer card | Tags on | Tags off | Messages to the contact | Slack | Timing |
|---|---|---|---|---|---|---|---|---|
| New contact with a phone | **New lead** (`new-lead`, `always`) n1 check phone → n2 `pipeline_card` → n3 | **New Lead**, "Name -- New", open (created, or a CRM-made card adopted and moved, D41); `field_opportunity_stage_entered` = today | — | `stat-new` | — | — | — | n1 waits up to 24h for a phone (`retry 10m / 24h`, D39), then exits `no_phone` with no card and no tag |
| Same lead | **Speed to lead** (`once_per_contact`) n1 email, n2 text, n3 `wait_for_reply 2h`, n5 email | — | — | — | — | "Got your info" email + text at once; "Still want to talk?" email after 2h of silence | — | 2h reply wait; dark hours defer the first email to the window (D5d) |

Nothing else fires. The only route out of New Lead is a booking (§1.3). A lead that never books keeps the card at New
Lead, open, with `stat-new`, for ever (§2, F16). `seq-nurture` is removed on booking but nothing adds it: there is no
nurture sequence in the engine; `reactivation` is manual (tag `reactivate`).

### 1.2 Setter call logged (`call.logged`, the dialer; D28)

| Event | Workflow | Setter card | Closer card | Tags | Messages | Slack | Timing |
|---|---|---|---|---|---|---|---|
| A connected call ≥ 60 s with a transcript | **Setter call logged** (`always`) c1 length, c2 transcript, w1 wait, a1 Jev kind, c3, a2 digest, r1 Discovery Call record, m1 note, s1 post | — | — | — | — | `slack.channel.setter_calls`, own message: kind, setter, length, outcome line ("Set — a booking followed" / "No booking yet"), digest | w1: 15 minutes after `recording.ended_at` so a booking made right after the call counts (`led_to_booking` is read live, context.ts:67) |

Cards and tags are untouched here by design; the setter card moves only when the booking lands.

### 1.3 Call booked (`appointment.booked`, closing calls) — setter-booked and self-booked

Setter vs self is decided per company (`booking.setter_rule`, D24): by calendar, by the setter question, or either.

| Event | Workflow | Setter card | Closer card | Tags on | Tags off | Messages | Slack | Timing |
|---|---|---|---|---|---|---|---|---|
| Setter-booked | **Call booked** (`always`) n1 `update_contact` (owner = closer, `field_contact_appointment_date`), b3 `field_contact_setter`, b4, b5, b6, k3 task, k4 Sales Call record, n4 post | **Appointment Set**, "Name -- Set", open, assigned to the **closer**, `field_opportunity_setter_owner` = setter (moved from New Lead, or created) | **Scheduled**, "Name -- Setter Booked", open, closer, setter owner field (created, or moved) | `stat-booked`, `stat-set`, `meta booked call` | `seq-no-show`, `seq-nurture`, `seq-winback`, `opt-in lead` (none of these is set by any template; the CRM spells the last `optin lead`, D50, so it matches nothing) | — | `slack.channel.bookings`, **the booking post**, remembered as `appointment:<id>`: name, closer, setter, time, phone, intake answers, reschedule link, source · "setter booked" | k3 "Send a personalized video" task due +1d |
| Self-booked | same, s3, s4, s5 | **Direct Booked Call**, "Name -- Direct", open, closer | **Scheduled**, "Name -- Direct", open, closer | `stat-booked`, `stat-self-booked`, `meta booked call` | same four | — | same post, "self-booked" | same |
| Either | **Pre-call sequence** (`once_per_appointment`, premise `appointment_in_future`) e1 email, s1 text, w1 | — | — | — | — | "You're booked: … reply to lock it in" email (valid while ≥ 5 m before the call), booking text (≥ 15 m) | — | then w1 `wait_for_reply 4h` (sms) |
| Either | **Calendar availability** | — | — | — | — | — | alert when the calendar has < 3 slots in 7 days | — |
| A reschedule (`appointment.rescheduled`, same appointment moved) | **Call booked** again (t2): n1, cards re-stamped, tags re-added (idempotent), k3 skipped (`only_if`), k4 record updated, n4 skipped, n4r | same stage | same stage | same tags again | same four again | — | 🔁 on the booking post, "Rescheduled to <time>" in its thread | Pre-call is **not** restarted: a parked run follows the new time (D20); a finished one does not (F4) |

Still running from §1.1: Speed to lead's 2h wait (F3). Both cards hang off one opportunity (the pursuit), opened at
first booking (`lifecycle.ts:8`).

### 1.4 Pre-call: reply, no reply, unclear, cancel, reschedule request

All inside **Pre-call sequence**; everything lands on the booking post (D44).

| Prospect does | Path | Tags on | Tags off | Messages | Slack | Then |
|---|---|---|---|---|---|---|
| Replies "yes" within 4h | w1 → c1 Jev → b1 → n_conf → n_conf_slack | `stat-confirmed` | `stat-unconfirmed` (a remove of a tag that is usually not there) | — | ✅ on the booking post, thread: "✅ <first name>'s call <relative> is confirmed. > <their words>" | reminders (§1.5) |
| Silent for 4h | w1 timeout → n_unc → n_unc_slack | `stat-unconfirmed` | — | — | ⏳ on the post, thread: "No reply to the booking text in 4 hours…" | reminders |
| Replies "can't make it" | b1 → n_cx `update_appointment status=cancelled` → n_cx_slack → exit `cancelled` | — | — | — | ❌ on the post, thread: "❌ <name>'s call is cancelled. > <words>" | **Nothing else.** Call cancelled and Cancellation rebook never run (F1). On Calendly the appointment is not even cancelled (F14) |
| Asks to move it | b1 → n_rs text → n_rs_slack → exit `reschedule_sent` | — | — | "No problem — grab a new time here: <closer calendar>" | 🔁 on the post, thread: "🔁 <name> got the rebooking link" | the old appointment stays confirmed (F15) |
| Unreadable ("hmm", 👎) | b1 else → n_unclear question (offers ✅ ❌ 🔁, `decision:<appt>`) → w_dec `wait_for_reaction 24h` → b_dec | as the tapped path | as the tapped path | 🔁 → the rebooking text | the question in the thread; the tapped path's reaction + "Decided by <name>"; the bot's ✅ ❌ 🔁 taken off the question | nobody taps in 24h → reminders. For a call < 24h away the tap wait outlives the call (§2 timing) |

### 1.5 Reminders (Pre-call sequence, after the reply step)

| Step | Wait rule | Message | Skipped when (`validity.min_lead`) | Today |
|---|---|---|---|---|
| r72 → m72 | call − 72h, 08:00–21:00 their time | 3-day text | call < 60h away | goes |
| r48 → m48 | call − 48h, 08:00–21:00 | 2-day text | < 36h | goes |
| r24 → m24e, m24s | call − 24h, 08:00–21:00 | "Tomorrow: your call with <closer>" email + 24-hour text | < 18h | both go |
| rm → bm → mm | the day of, 08:00 their time; only for calls at 11:00 or later | morning-of text | < 2h | **never goes: bm always takes its else edge (F10)** |
| r1 → m1 | call − 1h, from 07:00 | 1-hour text | < 15m | goes (a 7:00–7:14 call: r1 is clamped to 07:00 and m1 is then stale, F19) |
| r10 → m10 | call − 10m | 10-minute text | never | goes |

Setter card: **Appointment Set / Direct Booked**, closer card: **Scheduled**, throughout.

### 1.6 Call day

| Event | Workflow | Setter card | Closer card | Tags on | Messages | Slack | Timing / notes |
|---|---|---|---|---|---|---|---|
| A Fathom recording matched to the contact and an appointment (`recording.received`) | **Sales call recorded** (`always`) a1 Jev kind, c1, a3 Jev disposition, a2 notes + rubric, b1 → o1 `record_outcome showed`, o2, o3, o4, k1/k3, r1 Sales Call record, n1 note, s1 review, s2 scorecard | **Showed, status won** (o3) | — (stays **Scheduled**, F6) | `stat-showed` | — | ✅ on the booking post (`thread_only`), thread "✅ Showed · N min with <closer>. The review is in the calls channel."; the review in `slack.channel.calls`, own message remembered as `recording:<id>`, scorecard in its thread | `appointment.outcome` (source engine) and `call.held` (no call outcome) fire; Call outcome filed ignores the engine's showed (D54); Post-call follow-up does not start (outcome null). The Sales Call record gets `outcome: showed`, Jev's disposition through `oneof:` |
| Recording with no appointment within 24h | same, b1 else → k2/k4 | — | — | — | — | review says "⚠️ No appointment matched this recording — nothing marked showed" | record keyed by the recording |
| No recording (the call happened, Fathom missed it; or a phone close) | nothing | — | — | — | — | — | the EOD form opens with **no-show** prefilled once the end time has passed (D54); only the closer's answer changes anything |
| Not a sales call (Jev) | exit `not_a_sales_call` | — | — | — | — | — | — |

### 1.7 End of day filed (`appointment.outcome`, source `disposition`; D34, D54)

The reminder (**End-of-day reminder**, 18:00 and 09:00 per closer) DMs the standing link; **End-of-day report filed**
posts the summary to `slack.channel.eod` and ✅ on the DM. Each call's answer goes through `recordDisposition` →
`applyOutcome` (`disposition.ts:12`): the outcome is written on our appointment row, `appointment.outcome` fires and,
for a show, `call.held` with the call outcome.

| Closer files | Workflow | Setter card | Closer card | Tags on | Messages | Slack | Also |
|---|---|---|---|---|---|---|---|
| No-show | **Call outcome filed** (`always`) b1 → g1 → g2 | — (stays **Set / Direct**, open) | — (**Scheduled**, open) | `stat-no-show` | — | 👻 on the booking post, thread "👻 No-show for the call <time> with <closer>" | **No-show recovery** (`once_per_appointment`): 10 min → text + email with the rebook link (valid ≤ 3 days after the call) → 24h reply wait → "Want to reschedule?" email (≤ 7 days). The CRM marking `noshow` takes the same two paths |
| Showed, closed or deposit | b1 → s1 → s2 → b2 → c1 | — (F2) | — (F6) | `stat-showed`, `stat-closed-won` | — | ✅ ensured on the post (Slack `already_reacted` is read as done), thread "✅ Showed, per <closer>: closed." | `call.held closed`; the Sales Call record is **not** updated (F7) |
| Showed, follow-up | … → c2 | — | — | `stat-showed`, `stat-follow-up` | **Post-call follow-up**: text at 09:00 the next morning, their time | ✅ + thread line | — |
| Showed, lost | … → c3 | — | — | `stat-showed`, `stat-lost` | — | ✅ + thread line | `applyOutcome` marks **our** opportunity `lost` (`disposition.ts:29`) and emits `opportunity.lost`, which nothing dispatches or listens to (F11); no card moves |
| Showed, disqualified | … → c4 | — | — | `stat-showed`, `stat-disqualified` | — | ✅ + thread line | — |
| Rescheduled | b1 else → exit `nothing_to_mark` | — | — | — | — | — (Call booked's 🔁) | — |
| Refiled with a correction | runs again (`always`) | — | — | the new tag beside the old one (F9) | — | reacts again | — |

### 1.8 Agreement sent, signed, chased (D30)

| Event | Workflow | Closer card | Tags on | Tags off | Messages | Slack | Timing |
|---|---|---|---|---|---|---|---|
| First payment, not signed | **Payment recorded** a0 → a1 `send_document` → a2 → a3 | **Agreement Sent** (a3; created there if no card) | `stat-agreement-sent` | — | the CRM's document for signature | (the payment line, §1.9) | — |
| Tag `sys-send-agreement-manually` added | **Send agreement manually** (`always`) c1 → d1 → g1 → m1 | — | `stat-agreement-sent` | `sys-send-agreement-manually` (only on the sent path; on `already_signed` the trigger tag stays, 05-edge-cases "not yet") | the document | — | — |
| First payment | **Unsigned agreement chase** (`once_per_contact`) w1 24h → c1 → n1 … three nudges → g1 → s1 | — | `stat-agreement-unsigned` after the third unanswered nudge | — | — | owner DM (else `slack.channel.alerts` @mention) + CRM task per nudge; one alerts post after the third | strictly 24h apart from the payment; a signature at any check exits `signed` |
| Signer completes the document (`agreement.signed`, from the documents poll, exactly once) | **Agreement signed** (`always`) g1 → m1 → s1 | — | `stat-agreement-signed` (`stat-agreement-unsigned` is **not** removed, F9) | — | — | `slack.channel.deals`, own message "Agreement signed" | the booking post hears nothing (§2 j) |

### 1.9 Money (`payment.received`, Whop or Zapier; D21)

| Event | Workflow | Closer card | Setter card | Tags on | Tags off | Contact fields | Messages | Slack | Also |
|---|---|---|---|---|---|---|---|---|---|
| Deposit (first payment, total < contract) | **Payment recorded** (`always`) n1 → n2/r1 → n3 → p1 → n4 Payment record → a0 (§1.8) → m1 note → b2 → r2 → n5 → p_book → p_rev | **Agreement Sent** (if unsigned) | — | `pay-plan-active`, (`stat-agreement-sent`) | — | cash collected = running total; revenue generated stamped once with the program price | **nothing** (D54) | `slack.channel.payments` own message; 💵 on the latest booking post ("💵 Paid 1,500· deposit. Details in the payments channel.", F13) and on the latest call review | Sales Call record `cash_collected` updated; **Deal closed** starts and stops at its gate (`not_yet`, key released, D30); **the chase** starts |
| Balance / paid in full | same, n3 → f1 | — | — | `pay-paid-full` | `pay-plan-active` | cash collected | — | same + 💵 again | `payment.paid_in_full` is emitted (`payments.ts:105`) and **never dispatched; nothing listens** (F11, F12). Deal closed: no new run (its once is spent) |
| First payment **and** signed (either order) | **Deal closed** (`once_per_contact`) c1 gate → g1 → p1 → p2 → b1 → r1 → e1 → e2 → a1 → s1 | **Closed - Won, status won** (p1) | **won** without a stage change (p2; a no-op when the card is already won by the recording) | `stat-customer` | — | — | welcome email (transactional) + welcome text | `slack.channel.deals` "NEW CLOSE!" with cash, revenue, first booking, days to close, source, the AI cheer | Sales Call record `disposition closed_won / outcome showed / cash_collected`; the booking post hears nothing |
| Failed charge | **Payment failed** (`always`) n1 | — | — | — | — | — | — | `slack.channel.payments` @closer "please follow up" | the ledger keeps a `failed` row that never counts |
| Refund | — | — | — | — | — | — | — | — | the ledger lowers the running total (`payments.ts:34`); **no template listens to `payment.refunded`** (G10): cash collected, `pay-paid-full`, `stat-customer` and Closed - Won all stand |
| Paid in full → fulfilment | — | — | — | — | — | — | — | — | **nothing marks the client fulfilled or onboarded** (F12); the journey ends at Closed - Won + `pay-paid-full` |

### 1.10 Cancel and rebook

| Event | Workflow | Setter card | Closer card | Tags on | Tags off | Messages | Slack | Then |
|---|---|---|---|---|---|---|---|---|
| The source marks it cancelled (`appointment.status_changed → cancelled`, from the poll's delta) | **Call cancelled** (`once_per_appointment`) n1 → n2 → n3 clear date → n4 task → n5 → n7 | **Cancelled**, "Name -- Cancelled", **still open** | **Cancelled**, "Name -- Cancelled", **still open** | `stat-cancelled` | `stat-booked`, `stat-self-booked`, `stat-set`, `stat-confirmed` | — | ❌ on the booking post, thread: who cancelled and why, rebook task due in 1 day | **Cancellation rebook**: text + email with the rebook link. A parked pre-call exits `moot`. A rebook (new booking) moves both cards back to Set/Direct + Scheduled, `stat-cancelled` stays (F9). Never rebooks: both cards sit open at Cancelled (F16) |
| The prospect cancels by text | pre-call n_cx only | — | — | — | — | — | ❌ | **none of the above runs** (F1) |
| No-show, then rebooks | Call booked | Set/Direct | Scheduled | `stat-booked`… again | `seq-no-show` (nothing sets it) | the new pre-call | new booking post | No-show recovery keeps going (F8); `stat-no-show` stays (F9) |

### 1.11 Reactivation

Tag `reactivate` added → **Reactivation** (`once_per_contact_per_window 90d`): email, 3 days, text, 4 days, last email,
all with the booking link. Nothing stops it when they book; the trigger tag is never removed. No card, no stat tag.

## 2. Findings

Severity: **high** = a client or the team is misinformed or a CRM state is wrong in the normal path; **medium** = a
loop that never closes or a message a person should not get; **low** = cosmetic, or a decision the owner should make.
Test names are the `it.fails` titles in `journey.test.ts` (abbreviated).

| # | Finding | Today (where) | Should | Why it matters | Severity | Test |
|---|---|---|---|---|---|---|
| **F1** | **Fixed (D59).** `update_appointment` now emits and dispatches `appointment.status_changed` {from, to, by: workflow, node} when it changes the status, so the ❌ tap runs Call cancelled and Cancellation rebook like a cancel at the source. Was: **A cancel the prospect texts never runs Call cancelled or Cancellation rebook.** | Pre-call n_cx `update_appointment` writes the CRM and sets our row's status to cancelled directly (`executor.ts:327`). The only emitter of `appointment.status_changed` is the poll (`poll.ts:159-165`), which compares our row with the source: cancelled = cancelled, no delta, no event. Verified: `grep appointment.status_changed src` finds no other emitter. | `update_appointment` should emit `appointment.status_changed` (status from → to) and dispatch it, or pre-call's cancel path should start Call cancelled explicitly. D45 wrote "❌ cancels the appointment (Call cancelled does the rest)" — it does not. | Both cards stay at Set/Direct + Scheduled for a dead call, the appointment date stays on the contact, no rebook task, `stat-booked` stays on, the prospect never gets the rebook link. The team's only trace is one ❌ in a thread. | fixed | `F1 (fixed, D59): a cancel the prospect texted runs Call cancelled…` |
| **F2** | **A show the closer confirmed on the EOD form (no recording) leaves the setter card at Set / Direct Booked, open.** | Sales call recorded o3 moves the setter card to `stage_setter_showed` + won; Call outcome filed (D54) only tags (`call-outcome.json` s1, s2, c1–c4; no `pipeline_card` node). Deal closed p2 later marks it won **without a stage**. | Call outcome filed's showed branch should carry the same `pipeline_card` setter → Showed / won step (and the no-show branch a setter no-show stage once one is bound). | The setter board is the setter's scoreboard: unrecorded shows (phone closes, Fathom misses) read as never showed; a setter whose lead paid still has a card at "Appointment Set". | **high** | `F2: a show the closer confirmed should move the setter card to Showed…` |
| **F3** | **Fixed (D59).** A `check` before the nudge reads `contact.has_upcoming_call` (a live closing call ahead of them, other than the run's own); a lead who booked exits `booked` and gets nothing more. Was: **Speed to lead keeps running after a booking.** | `speed-to-lead.json` n3 `wait_for_reply 2h`; its only exits are a reply or the timeout. A lead who books (clicks the link, or is set) inside 2h without texting back gets "Still want to talk? …here's the link" (n5). Pre-call does not supersede it (different workflow; D45 is per workflow). | Speed to lead should stop when the person books (an `appointment.booked` exit, or n5 `only_if` no future closing call). | A booked prospect is asked to book. Common: the whole point of speed-to-lead is booking inside the window. | fixed | `F3 (fixed, D59): a lead who books inside speed-to-lead's 2 hours does not get 'Still want to talk?'` |
| **F4** | **Fixed (D59).** Pre-call also starts on `appointment.rescheduled`; its `reentry_key` is the start time, so a moved call whose sequence has finished gets a fresh run (booking email and text for the new time, then the reminders). A run still parked keeps the appointment and follows the move (D20); the reschedule is remembered on it, no second run. Was: **A call rescheduled after its pre-call sequence ended gets no booking text and no reminders.** | Pre-call starts on `appointment.booked` only and is `once_per_appointment`; a GHL reschedule is the same appointment (`appointment.rescheduled`). A parked run follows (D20); a completed or exited one (10-minute text sent; a `reschedule_sent` exit; a `cancelled` exit) is never restarted. Call booked re-runs (🔁 in the thread) and calls it done. | `appointment.rescheduled` should start a fresh pre-call for the new time when none is parked (reentry keyed on appointment + start time, or an explicit restart). | A closer who drags a call to next week — the normal way to move a GHL appointment — produces a call with zero prospect-facing messages. Same for a no-show the closer reschedules. | fixed | `F4 (fixed, D59): a call rescheduled after its sequence ended gets a fresh pre-call sequence…` |
| **F5** | **The 4-hour reply wait holds the run past its reminders** (G7, catalogued; the numbers are in §2e). | `wait_for_reply` (`executor.ts:216-219`) has no cap at the appointment; `w_dec` (24h tap wait) the same. | The wait should end at min(timeout, call − margin), or the reminders run beside it. | Short-notice bookings lose the morning-of (8h, 5h) or everything after the booking text (≤ 4h). | medium (G7) | `F5 (G7) + F10: the morning-of text was valid until 1pm…` |
| **F6** | **The closer card never leaves Scheduled on a show, a no-show, a loss, a DQ or a follow-up.** | The only closer stage bindings any template renders are `stage_closer_scheduled`, `_agreement_sent`, `_closed_won`, `_cancelled`. Moves: Call booked → Scheduled; Call cancelled → Cancelled (open); Payment recorded → Agreement Sent; Deal closed → Closed - Won (won). A `lost` filing marks **our** opportunity lost (`disposition.ts:30`) and nothing else. | Bind the closer board's Showed / No-show / Lost stages and move the card from Call outcome filed and Sales call recorded; mark the card `lost` on a lost/DQ filing. | The closer board is the team's working view; every no-show, loss and follow-up sits at Scheduled with the shows and the live calls. | **high** | `F6: the closer card should leave Scheduled when the call shows…` |
| **F7** | **Fixed (D59).** Call outcome filed updates the Sales Call record call-booked created (keyed by the appointment, only when the contact has one): `outcome` showed or noshow, and for a show the closer's call outcome mapped to the CRM's disposition through the same `oneof:` guard Sales call recorded uses. Was: **The Sales Call record is not updated when the closer files the outcome.** | Only Sales call recorded r1 and Deal closed r1 write `custom_objects.sales_call`. An unrecorded call's record keeps `outcome: scheduled`; a no-show never gets `outcome: noshow`; a follow-up/lost/DQ never gets its disposition unless a recording landed (and then it is Jev's read, not the closer's). | Call outcome filed should update the record (`records.sales_call.key`) with outcome, disposition and cash. | The CRM object the team reports from disagrees with the EOD answer that is the human truth (D50). | fixed | `F7 (fixed, D59): the Sales Call record says showed / follow_up once the closer filed it…` |
| **F8** | **Half fixed (D59).** A `check` before each send reads `contact.has_upcoming_call`; a newer booking ends the run `rebooked` with nothing more sent. `stat-no-show` still stays on: Call booked's tags are the owner's call (F9), left alone. Was: **No-show recovery keeps nudging after the person rebooked; `stat-no-show` stays on.** | `no-show-recovery.json` n4 → n6 "Want to reschedule?" fires a day later regardless; Call booked removes `seq-no-show` (nothing sets it, D50) and not `stat-no-show`. Same shape as G6 (cancel after rebook). | Recovery should stop on a newer booking (premise or `only_if`); Call booked should clear `stat-no-show` (and `stat-cancelled`) or the stat tags should be declared cumulative. | "Want to reschedule?" to someone who did; `stat-no-show` + `stat-booked` + later `stat-showed` on one contact. | fixed (recovery) / **medium** (tag, F9) | `F8 (fixed, D59): a new booking ends the no-show recovery…`; open half: `F8 / F9 (open, the owner's call): stat-no-show should come off…` |
| **F9** | **Tag churn.** Added-then-removed in the same run: none. Added by one step and removed by the next workflow in the normal path: only `pay-plan-active` → `pay-paid-full` (correct) and `stat-unconfirmed` → confirmed (correct). **Removed but never set by any template:** `seq-no-show`, `seq-nurture`, `seq-winback`, `opt-in lead` (CRM spells it `optin lead`), `sys-send-agreement-manually` (a human trigger). **Set and never removed:** `stat-new`, `meta booked call`, `stat-showed`, `stat-no-show`, `stat-cancelled`, `stat-closed-won`, `stat-follow-up`, `stat-lost`, `stat-disqualified`, `stat-agreement-sent`, `stat-agreement-signed`, `stat-agreement-unsigned`, `stat-customer`, `pay-paid-full`. `stat-booked`/`stat-set`/`stat-self-booked`/`stat-confirmed` come off only on a source cancel. `stat-unconfirmed` is removed on every confirmation, usually of a tag that is not there (a harmless CRM write). A reschedule re-adds the booking tags and re-removes the nurture tags (idempotent). | as described (`setup-data.ts:62-78` logic, run over the templates in the pure test) | Decide: are `stat-*` cumulative milestones (then Call cancelled should not remove `stat-booked`, and nothing is wrong) or current state (then booking clears `stat-no-show`/`stat-cancelled`, signing clears `stat-agreement-unsigned`, a corrected filing clears the old outcome tag)? Today it is both. | Filters in the CRM built on these tags double count: a no-show who rebooked and showed carries `stat-no-show` and `stat-showed`; a signed client can carry `stat-agreement-unsigned`. | **medium** | pure: `tags a template adds that nothing ever removes (F9)…`, `tags a template removes that no template ever adds…` |
| **F10** | **Fixed (D59).** `operand()` renders any `{{…}}` with a filter through the template renderer (a bare path still keeps its type), so `bm` compares "14" to 11 and the morning-of text goes at 8am for calls at 11am or later. For short-notice bookings it is now `stale` instead of never reached — that is F5/G7, still open. Was: **The morning-of text is never sent to anyone.** | Pre-call `bm` branches on `{"gte": ["{{appointment.starts_at | date:HH}}", "11"]}`. `predicate.ts:4-8` `operand()` resolves only a bare `{{path}}` (regex `^\{\{\s*[a-zA-Z0-9_.]+\s*\}\}$`); a reference with a filter is returned as the literal string, `num()` gives `NaN`, `NaN >= 11` is false, the `else` edge to r1 is always taken. Verified in isolation (`evaluate` with a 2pm appointment → false) and in both scenarios (bm result `{edge: r1, else: true}` for a 2pm and a 3pm call). | `operand()` should render a templated string (`render()` then `num()`), or the template should compare a plain path. Any other predicate that templates a filtered value is broken the same way (today: this is the only one in the shipped templates; `only_if`/`match` use bare paths). | Tyler's spec (D36) names the morning-of text; the plan page shows it as planned; it has never gone out. | fixed | `F10 (fixed, D59): a 2pm call gets the morning-of text at 8am…`; `F10 (fixed, D59): for a 3pm call the morning-of branch takes the mm edge…` |
| **F11** | **Fixed (D59).** `payments.ts` dispatches `opportunity.won` and `payment.paid_in_full`, `disposition.ts` dispatches `opportunity.lost`, with the same `dispatchEvent` the other emits use. No template listens yet (F12). Was: **`payment.paid_in_full`, `opportunity.won` and `opportunity.lost` are emitted but never dispatched, and nothing listens.** | `payments.ts:98-106` and `disposition.ts:29-32` call `emitEvent` without `dispatchEvent`; no template has a trigger on them (`grep '"payment.paid_in_full"' templates/` is empty). The dashboard's journey shows them; a workflow could not start from them even if written. | Dispatch them (the ledger already has them) so a paid-in-full / lost hand-off can be a template. | Blocks F12 and any "lost" automation. | fixed | shown by F12's assertion (still `it.fails`: no listener) |
| **F12** | **Nothing marks the client fulfilled / onboarded after paid in full.** | The last CRM moves are Deal closed (Closed - Won, `stat-customer`, welcome email + text) and Payment recorded (`pay-paid-full`, 💵). No stage, tag, task or Slack line says "paid in full", "onboarding booked" or "fulfilled"; the welcome email asks them to book a coaching call on a Calendly link the engine does not watch. | A paid-in-full hand-off: a stage/tag + a task or Slack line to the fulfilment owner; optionally watch the onboarding calendar (a `first_call`/`follow_up` term) and close the loop when it is held. Needs F11. | The owner's stated end state is "fulfilled"; the engine's is "won". | **medium** (a decision) | `F12: paid in full should close the loop…` |
| **F13** | **Fixed (D59).** "💵 Paid $1,500 · deposit." — the `$` is in the template and the separator is `{{event.kind | prefix:·}}` after a space in the text, the way `prefix:` is used elsewhere. Was: 💵 thread copy: "💵 Paid 1,500· deposit." | `payment-recorded.json` p_book/p_rev: `{{event.amount | money}}` has no `$` (n5 writes `${{…}}`), and `{{event.kind | prefix: ·}}` loses the leading space of its argument. | "💵 Paid $1,500 · deposit." | cosmetic | fixed | pinned in `the deposit: …` and the scenarios' refund line |
| **F14** | On Calendly the texted cancel cancels nothing. | `update_appointment` skips non-GHL sources as read-only (`executor.ts:324`); pre-call still posts ❌ "cancelled" and exits. The booking stands in Calendly and GHL. | The ❌ line should say the booking is still on the calendar (or the engine should cancel through the Calendly cancel URL / tell the closer). | The team reads "cancelled"; the closer's calendar says otherwise; the EOD form later shows it as a presumed no-show. | medium (Calendly companies) | not tested (needs a Calendly-sourced appointment) |
| **F15** | A reschedule request leaves the old appointment confirmed. | Pre-call n_rs sends the rebooking link and exits; nothing cancels or flags the old slot. | Cancel it (GHL) or say in the thread that the old slot is still held, with a task for the closer. | The slot stays blocked; at end of day the form opens with a presumed no-show for a call the prospect asked to move. | medium | not tested |
| **F16** | **Loops that never close.** A lead that never books: setter card open at New Lead with `stat-new`, for ever. A no-show who never rebooks: both cards open at Set/Direct + Scheduled, `stat-no-show`, one day of recovery, then silence. A cancel that never rebooks: both cards open at Cancelled, a rebook task due +1d, nothing after. A lost/DQ filing: our opportunity `lost`, the cards unchanged. | as described; no template has a timed sweep, a stage-age rule or a `lost`/`abandoned` card status | Decide an ageing rule (e.g. 14 days at New Lead / Cancelled / no-show without a booking → card lost + tag + reactivation hand-off), and mark cards lost on a lost/DQ filing. | Boards fill with dead cards; "open pipeline" is wrong. | medium (a decision) | documented by the scenario assertions (cards open after the no-show and after the texted cancel) |
| **F17** | Deal closed fires on the first dollar + signature, not on paid in full; `contact.paid` is `payments_count > 0` (`context.ts:111`). | by design (D30 "either order, once"); noted so the owner knows "NEW CLOSE" and `stat-customer` happen on a deposit | — | expectations | low (information) | — |
| **F18** | The setter card is assigned to the closer at booking. | `call-booked.json` b4/s3 `assign_to: appointment.closer` on the **setter** card; the setter's name only in `field_opportunity_setter_owner` | assign the setter card to the setter (a user lookup by `set_by`), or leave its owner | setter board ownership reads as the closer | low | — |
| **F19** | Calls at 07:00–07:14 lose the 1-hour text. | r1 `earliest 07:00` clamps call − 1h to 07:00; m1 `min_lead 15m` is then stale | clamp earlier, or no earliest on r1 | rare | low | — |
| **F20** | A second closing call after a show creates a **new** setter card. | the first is `won` (o3); `pickCard` takes open cards only (`cards.ts:36`); s3/b4 have a stage, so they create | re-open the won card, or `if_missing`-style move-only after a show | duplicate setter cards for re-booked customers | low | — |
| **F21** | The ⏳ "not confirmed yet" and the 1h/10m texts are also lost when the booking is made in dark hours: e1/s1 wait for 08:00, the 4h hold starts then. | `runner.ts:102` defers the sends; `pre-call` e1/s1 are not `transactional`, so `quiet_allow_transactional` does not help | mark the booking email/text transactional (they are receipts) | a 23:00 booking for a 9am call sends nothing at all | medium | not tested (edge-cases "Cancelled at 11pm" is the same rule) |
| G4, G6, G10 | one person in two workflows (`always` supersede), rebook-then-cancel, refund | 05-edge-cases.md | | | | cross-reference |

### 2e. Timing: what the prospect receives, by lead time

Written before D59. The morning-of column now reads: the text goes at 08:00 (or at the reply, when the booking text's
reply wait ends first) for calls at 11:00 or later; for a booking a few hours out it is reached and skipped as stale
because the 4-hour reply wait still holds the run (F5/G7, open). F3's nudge no longer goes to a lead who booked.

Assumes the default windows (sends 08:00–20:00 company, reminders 08:00–21:00 contact) are open and the booking is not
in dark hours. "hold" = pre-call's 4-hour `wait_for_reply` (w1) with no reply; the unclear-reply tap wait (w_dec, 24h)
behaves the same way for any call under a day away. Today's column is what `journey.test.ts` shows; the ✔/✘ in the
"should" column is the template's own intent (`validity.min_lead`).

| Lead time | Booking email e1 (≥ 5m) | Booking text s1 (≥ 15m) | ⏳ / `stat-unconfirmed` | 3d / 2d / 24h | Morning-of mm (≥ 2h, calls ≥ 11:00) | 1-hour m1 (≥ 15m) | 10-minute m10 | Outcome today |
|---|---|---|---|---|---|---|---|---|
| ≥ 4 days (Jordan, replied) | at booking | at booking | — (confirmed) | each at its time | **never (F10)** — should: 08:00 | call − 1h | call − 10m | 6 of 7 reminders |
| ≥ 4 days, silent | at booking | at booking | at +4h | each at its time | never (F10) | ✔ | ✔ | 6 of 7 |
| 8h (e.g. 10:00 → 18:00) | ✔ | ✔ | at 14:00 | all stale, skipped | never (F10); should: 14:00 (valid until 16:00) — with F10 fixed it would still go, at 14:00 instead of 10:00 | 17:00 ✔ | 17:50 ✔ | 4 messages |
| 5h (Kai: 10:00 → 15:00) | ✔ | ✔ | at 14:00 | stale, skipped | never (F10); should: 10:00 (valid until 13:00) — with F10 fixed it would be **stale** at 14:00 (G7) | 14:01 ✔ (by coincidence the hold ends at call − 1h) | 14:50 ✔ | 4 messages |
| 5h, replied "yes" at once | ✔ | ✔ | — | stale | never (F10); should: at the reply (immediately after the booking text) | ✔ | ✔ | 4 messages |
| 2h | ✔ | ✔ | **never**: the hold outlives the call; the next wake finds the premise dead (`moot`) | stale | — | **never (G7)**; should: call − 1h | **never (G7)** | 2 messages, then silence |
| 30 minutes | ✔ | ✔ | never | — | — | never (G7); should: at booking (30m ≥ 15m) | never (G7) | 2 messages |
| 3 minutes | stale | stale | never | — | — | — | — | nothing (05-edge-cases: by design) |
| Any lead time, booked in dark hours | deferred to the window, hold starts then (F21) | same | later | | | lost for any call within the window + 4h | | |
| Unclear reply, call < 24h | ✔ | ✔ | the question to the team | | the tap wait holds until a tap or the call | lost unless someone taps | | |

Tyler's example ("the reminder has to wait 24 hours before the flow moves on, but the call is 5 hours from now") does
not happen as such: every reminder wait is anchored to the appointment and collapses to "now" when it is already past
(`waitrule.ts:35`), and each send checks its own `min_lead`. The two waits that *are* anchored to "now" and can
outlive a short-notice call are the 4-hour reply wait and the 24-hour tap wait (F5/G7).

### 2j. The booking post's story (D44)

| Event | On the booking post | Where else |
|---|---|---|
| Booked | the post itself (`appointment:<id>`) | — |
| Reply: confirmed / cancelled / reschedule request / unclear | ✅ / ❌ / 🔁 / the question with ✅ ❌ 🔁 offered; a thread line quoting them | — |
| 4h silence | ⏳ + thread line | — |
| Source cancel | ❌ + thread line (who, why, task) | — |
| Reschedule (same appointment) | 🔁 + "Rescheduled to <time>" | no new card |
| Showed (recording) | ✅ + "Showed · N min" | the review, own message in `calls`, scorecard in its thread |
| Showed (EOD) | ✅ ensured + "Showed, per <closer>: <outcome>" | — |
| No-show (EOD or CRM) | 👻 + thread line | — |
| Payment (any) | 💵 + "Paid …" | own message in `payments`; 💵 on the latest review |
| **Silent on the post:** agreement sent, agreement signed, deal closed, payment failed, refund, the setter card won, the chase nudges, a lost/DQ filing's consequence (only the ✅ line names the outcome) | — | agreement signed and the close are own messages in `deals`; failed payment in `payments`; the chase goes to the owner |

A 🎉 (or 💰) on the booking post at the close, and a line when the agreement goes out, would complete the story the
owner described ("any updates to that event get emojis and threads"). Low priority; noted, not a finding.

## 3. Tests

`platform/src/engine/journey.test.ts` — 33 tests after D59: 29 pass, 4 are `it.fails` (they pass *because* the engine
is wrong; fixing the engine turns them red for the right reason, and the title says what to look at). The findings D59
fixed are plain tests now, titled `F<n> (fixed, D59): …`, beside the step tests that pinned the old behaviour and now
pin the new.

| Finding | status | title (abbreviated) |
|---|---|---|
| F1 | fixed (D59) | a cancel the prospect texted runs Call cancelled … and Cancellation rebook |
| F2 | `it.fails` | a show the closer confirmed should move the setter card to Showed and mark it won |
| F3 | fixed (D59) | a lead who books inside speed-to-lead's 2 hours does not get 'Still want to talk?' |
| F4 | fixed (D59) | a call rescheduled after its sequence ended gets a fresh pre-call sequence |
| F5 (G7) | `it.fails` | the morning-of text was valid until 1pm and should have gone at booking (the reply wait holds it) |
| F6 | `it.fails` | the closer card should leave Scheduled when the call shows |
| F7 | fixed (D59) | the Sales Call record says showed / follow_up once the closer filed it |
| F8 | fixed (D59), recovery half | a new booking ends the no-show recovery |
| F8 / F9 | `it.fails` | stat-no-show should come off on the new booking (the owner's call) |
| F10 | fixed (D59) | a 2pm call gets the morning-of text at 8am; a 3pm call's branch takes the mm edge |
| F12 | `it.fails` | paid in full should close the loop (F11's dispatch is in; no listener yet) |

F9 is pinned by the pure tests (`tags across every template`), F13 (fixed) and F16 by the scenario assertions.

Run: `cd platform && pnpm exec tsc --noEmit -p . && DATABASE_URL=… BINDINGS_KEY=… pnpm exec vitest run
src/engine/journey.test.ts` (company slug `journey`, wiped at start; fake adapters from `test-install.ts` plus a
`liveCards` map for the CRM's cards and recorders for sends, tags, cards, records, posts and reactions; time is driven
by waking a parked run and handing `tick` the clock the steps should believe, since due-ness is the database's `now()`
and the premise check reads the booking source live).
