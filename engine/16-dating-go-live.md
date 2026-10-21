# Dating (Nelly) go-live on v1: checklist (2026-10-21)

Tyler: "We're getting Dating, then PMU, live on v1. Fixes only, no new features." Sends stay locked until Tyler names each
workflow to unlock (CLAUDE.md). Every change below is one named workflow (or one named engine fix), dry run first, Tyler's
go-ahead each time.

Sources: `spec/dating-nelly/` on `ccr-61654d46-qlog6a` (live workflows step by step, generated from the live database
2026-10-20, with traces), `engine/14-modular-playbooks.md` §3.2 on that branch, `v2/docs/phase-1/engine-action-inventory.md` §5
on `rebuild`, and the code on main. "Trace" = seen in a recorded run; "code" = read from the code, not seen in a run.

Offer today: active, mode **quiet**, America/Los_Angeles, send window 08:00–20:00 (contact's zone, D203). Every workflow's sends
locked.

## 0. Before anything

- [ ] **Production database reachable.** Down since the Supabase password change (2026-10-21): `SUPABASE_DB_URL` in Vercel
      carries the old password. Tyler updates it and redeploys; then health, ticks on all three offers, and the gap's Whop /
      Fathom / Typeform deliveries are checked.
- [ ] **Watchdog installed** (Tyler's Slack webhook in his own workspace) and an outside uptime check on
      `/api/health?assert=fresh`. Nothing alerted during the outage above.
- [ ] **Live state re-read** against this list (the spec is a snapshot of 2026-10-20).

## 1. Engine-wide contact-safety fixes (each on Tyler's go-ahead, dry run first)

| # | Fix | Why it matters on Dating |
| --- | --- | --- |
| E1 | The Calendly cancel bypasses the send lock (`executor.ts:640-648`) | Pre-call's ❌ tap cancels in Calendly and Calendly emails the invitee, even with sends locked. Goes away on Dating once pre-call is simplified (no taps), but other offers keep the path. |
| E2 | The health check's drift sweep fires `lead.created` (`ledger-drift.ts:100`) | Starts New lead now; would start Speed to lead (texts) if it is ever turned on. |
| E3 | History backfill can start workflows (`backfill.ts:123` → `payments.ts:143,159`) | Would start Payment recorded (sends the agreement) on old payments once it is on. |
| E4 | Hand-linking a payment or recording in Slack starts nothing (`slack-link.ts:58`) | A recording linked from Unmatched recording never reaches Sales call recorded (no showed, no Sales Call record, no review); a payment linked from Unlinked payment never reaches Payment recorded (no agreement, no cash). |

## 2. Decisions for Tyler

1. **Pre-call words** (Closing pre-call, Triage pre-call): new texts for booked / 24h / 1h and "link coming". Today's words
   are in §5.
2. **Unlock re-send.** Moving pre-call from quiet to live replays every upcoming booking into pre-call (D195), so each gets the
   "you're booked" text, however long ago they booked. Send it, or start from the next booking only.
3. **Second setter card** (§4.1): pick a fix.
4. **"Link coming" on triage:** triage calls are phone calls (the setter dials); the rule applies to the closing call only?
5. **Payments:** is Nelly taking payments through Whop yet? If so: her deposit product/plan ids (without them a $100–500
   deposit counts as the first installment, wins the deal and sends the agreement) and confirm $5,000 as the contract value.
6. **Deal closed welcome email/text:** words needed (placeholders today, so nothing is sent).
7. **Triage "set":** ends the setter card at Showed (won); a setter-call "set" ends at Appointment Set. Which is meant?
8. **Speed to lead, Reactivation, Cancellation rebook, Post-call follow-up, No-show recovery:** keep off for go-live? (Each
   has a gap below; off is the safe answer.)

## 3. Every workflow

Action column: **keep** = no change needed for go-live; **fix** = a named change before unlock; **off** = stays off.

### Booking

| Workflow | Today | Action | What's left | Edge cases |
| --- | --- | --- | --- | --- |
| Triage call booked | on, live, internal | keep (+§4.1) | — | ✓ existing contact, card moved, Discovery Call record (trace). Code: reschedule logs old slot; Calendly reschedule = one moved appointment. ⚠ second setter card (§4.1). ⚠ no trace of setter-booked, reschedule, or a contact the booking created. |
| Closing call booked | on, live, internal | fix | `k3` video task never created: tasks are off (`crm.tasks`). Turn tasks on or drop the step. | ✓ Calendly-created contact, both cards, Sales Call record, ⚠️ no-phone note (trace). ⚠ second setter card on a reschedule or a booking after triage was filed (§4.1). ⚠ `c_new` moves the closer card from any stage back to Scheduled (code). ⚠ no phone on the booking = no texts (no email fallback). |
| Call cancelled | on, live, internal | fix | Rebook task skipped (tasks off) but the post says "Rebook task: due in 1 day". | ✓ host cancel names the canceller; cards moved; Sales Call updated (trace). ✓ after-start cancel ignored; triage cancel doesn't fire it (code). ⚠ creates a "-- Cancelled" setter card when the setter card is already won (§4.1). ⚠ a workflow cancel says "Cancelled by: the invitee". ⚠ clears the appointment date even if another call is booked. |
| Triage call cancelled | on, live, internal | fix | Same rebook-task wording as Call cancelled. | No trace. Code: before-start guard. ⚠ clears the appointment date even when a closing call is booked. |
| Cancellation rebook | off, contact-facing | off | Template words; sends the closing-calendar link; no "already rebooked" check; fires on host cancels too. | — |

### Pre-call (Tyler's simplification: booked / 24h / 1h, no reply reading, no buttons)

| Workflow | Today | Action | What's left | Edge cases |
| --- | --- | --- | --- | --- |
| Closing pre-call | on, **quiet**, contact-facing (v5) | fix | Rebuild as the simple flow (§5). 25 steps go (reply wait, Jev read, confirm/unconfirm paths, Slack question and buttons, tap handling, Calendly cancel); `v_lead`, the 1h guard and the night rule change. Words approved before unlock. | ✓ cancelled call exits; no-link Slack post and no-link 1h text; DND skip; day-before stale when too close (traces, all on the operator's test contact). ⚠ no real contact's text path in a trace. ⚠ today: 1h text suppressed if any engine message went in the last hour; 08:00–08:14 calls get no 1h text; day-before lost when booked 24–28h out; reschedule sends no new text. The rebuild must cover each. |
| Triage pre-call | on, **quiet**, contact-facing (v5) | fix | Same rebuild. No meeting link handling today (phone call), see decision 4. 10 runs waiting. | ✓ booking text held to 08:00; day-before moved before 20:00; older run superseded; DND skip (traces). ⚠ same code risks as Closing pre-call; a triage and a closing call the same day can suppress each other's 1h text. |

### Calls and post-call

| Workflow | Today | Action | What's left | Edge cases |
| --- | --- | --- | --- | --- |
| Sales call recorded | on, live, internal | fix | No call-type guard: a Fathom recording of a triage call can be read as a sales call (showed with source engine, Sales Call record on the triage booking, setter card won, Triage call filed never fires). E4. | ✓ Nelly's closing call end to end (trace). ⚠ `appointmentNear` takes any call type within 24h (code). |
| Setter call logged | on, live, internal | keep | — | ✓ 60-second minimum (both traces `too_short`). ⚠ no full setting call traced. ⚠ a phoned triage call can be read as "setting". ⚠ a short or untranscribed dial is skipped from the setter's end of day silently. |
| Setter call filed | on, live, internal | keep (+§4.1) | — | No trace. ⚠ `pick: latest` reopens a won/lost setter card back to Appointment Set; a setter DQ after a triage show overwrites the won card. ⚠ "follow up" makes no callback task. |
| Triage call filed | on, live, internal | keep (+§4.1, decision 7) | Root of the second-setter-card case. | No trace. ⚠ notes and DQ reason dropped silently if Triage call booked never wrote the Discovery Call record. |
| Call outcome filed | on, live, internal | keep | — | Guarded to closing calls. No trace. ⚠ a closing no-show moves the triage's won setter card to Cancelled/lost. |
| Card moved by hand | on, live, internal | fix | Always pinned to the contact's latest closing call: a setter-card drag to Cancelled can file a no-show on an old closing call (then Call outcome filed). Both traces moved a setter card to Showed/won with no mover: find out what moved them (a GHL automation, or the engine's own write read as a hand). | Code only for the risky path. |
| No-show recovery | off, contact-facing | off (or fix) | No call-type condition: a triage no-show would get the closer's rebook link; its "rebooked?" check counts closing calls only. | — |
| Post-call follow-up | off, contact-facing | off (or fix) | No call-type condition: a triage "follow up" would get the text; says "yesterday" whenever it was filed. | — |
| Unmatched recording | on, live, internal | keep (E4) | Its "Link it" URL points at a dashboard page that doesn't exist. | No trace. |

### Leads

| Workflow | Today | Action | What's left | Edge cases |
| --- | --- | --- | --- | --- |
| New from Typeform | on, live, internal | keep | No form filter: a second Typeform would start it. | ✓ 7 runs, existing lead not re-made. |
| New lead | on, live, internal | keep | — | ✓ 7 runs. ⚠ a no-phone lead who books during the 24h wait can have the setter card moved back to New Lead. ⚠ E2 starts it. |
| Speed to lead | off, contact-facing | off | Counts only closing calls as booked (Dating's link is triage), so a lead who booked gets "still want to talk?"; first sends don't check for a booking; template words; E2. | — |
| Reactivation | off, contact-facing | off | No stop on reply or booking; template words. | — |

### Closing and payments

| Workflow | Today | Action | What's left | Edge cases |
| --- | --- | --- | --- | --- |
| Payment recorded | off, contact-facing (agreement) | on, after decision 5 | The automatic agreement send and the source of GHL cash. Deposit products undeclared; `crm.agreement_sender` unbound (sends as GHL's default user). E3, E4. | Code: deposit = tag only; refund = tags only; duplicate webhook dropped by delivery id and payment id; already signed = no second agreement. ⚠ a refund never reverses the win. ⚠ unverified: Whop keys success and failure on the same id. No trace. |
| Deal closed | off, contact-facing | on, after decision 6 | Welcome email/text are placeholders (skipped). | Code: payment-then-signature and signature-then-payment both close once; deposit only = no close. ⚠ refund never reverses the close. ⚠ `p2` makes a second setter card when the triage marked it won (§4.1). No trace. |
| Agreement signed | off, internal | on (recommended) | — | ⚠ any document signed in the location by a dating-tagged contact counts. |
| Send agreement manually | off, contact-facing | fix | Still on the old tag trigger; `/agreement` answers "no workflow on this offer takes /agreement yet" until this copy takes the template's `agreement.requested` trigger (named dry run). Then retire the tag after a test. | ✓ already signed = stop; replay never re-sends (code). |
| Unsigned agreement chase | off, internal | on (recommended) | DMs the contact owner, who is Nonie for 304 contacts (D204), not the closer. Point it at the closer? | ⚠ a misread deposit starts it. |
| Payment failed | off, internal | on | — | No customer message, no dunning. |
| Unlinked payment | off, internal | on | Off = a payment matching nobody sits silently. "Link it" URL points at a page that doesn't exist. E4. | Shared RapidCloser location: a buyer without the `dating` tag never matches. |

### Engine and team

| Workflow | Today | Action | What's left | Edge cases |
| --- | --- | --- | --- | --- |
| Calendar availability | on, live, internal (v2) | check | The booking-time run for the triage calendar checked 0 calendars: confirm the triage calendar is covered. | No alert raised in any trace. |
| Health check | on, live, internal | keep (E2) | Cannot see the database being unreachable (§0). | ✓ 23 hourly runs. |
| Ledger drift | on, live, internal | keep | — | No trace. |
| Daily / Weekly / Monthly wrap-up | on, live, internal | keep | Revenue and Cash blank until Payment recorded writes GHL Payment records. | ✓ test contacts left out. |
| Weekly leaderboard | on, live, internal | keep | Same cash gap. | ✓ quiet when empty. |
| EOD: post the closer's day | on, live, internal | keep | — | No trace. |
| EOD: remind closers to file | on, live, internal (v2, D207) | keep | — | ✓ 7 runs; the off-schedule 7:10 PM one was the move-up re-fire D201 fixed. |

## 4. Tyler's two checks

### 4.1 The second setter card: confirmed (from code; no trace yet)

`pickCard` (`cards.ts:57`) only finds an **open** setter card. Triage call filed marks the setter card **won** (or lost). After
that, any step that is "pick open, create if missing" with no status makes a new open card:

- the closing call is **rescheduled** (Closing call booked `s3` / `b4` run on every trigger): a new "-- Set" / "-- Direct";
- the closing call is **cancelled** before it starts (Call cancelled `n1`): a new "-- Cancelled";
- the closing call is **first booked after** the triage was filed (a triage "follow up" who books later): a new card;
- the deal **closes** (Deal closed `p2`): a new card.

No duplicate when the closing call is booked before the triage is filed (the open card is moved, then marked won). After a
triage *lost* (DQ, no-show), a fresh card on the next booking is the template's intent.

Fix options:
1. **Workflow-only, per step** (Dating's copies, one named dry run each): on Call cancelled `n1` and Deal closed `p2`,
   `if_missing: skip`; on Closing call booked `s3` / `b4`, run only when there is an open setter card or it is a first
   booking with no setter card. Partial: case 3 above still needs the engine option.
2. **Engine option, opt-in per step:** a pick mode "the open card, else the latest won one" so a won setter card is left
   where it is instead of a new one being made. Opt-in, so Hair and PMU keep their behaviour; Dating's four steps take it by
   name. Covers every case.
3. **Change the meaning:** leave the setter card open at Showed after triage and win it at the closing show. Changes what the
   triage credits.

Recommendation: 2. It is the only one that closes every path, and it changes no existing offer.

### 4.2 Post-call workflows without a call-type condition

| Workflow | Trigger conditions | Wrong call type can fire it? |
| --- | --- | --- |
| Call outcome filed | disposition AND category closing; no-show AND category closing | No |
| Triage call filed | disposition AND term "Triage call"; no-show AND term "Triage call" | No |
| No-show recovery (off) | no-show; outcome no-show; **no type** | Yes: triage no-show gets Nelly's closing rebook link |
| Post-call follow-up (off) | call.held outcome follow_up; **no type** | Yes: triage "follow up" gets the text |
| Card moved by hand | card.moved, pinned to the latest closing call | Yes: a setter-card drag files a no-show on a closing call |
| Sales call recorded | recording.received; call.closing | Yes: a triage recording read as a sales call |
| Setter call logged | phone AND connected | Partly: a phoned triage can be read as setting |
| Setter call filed, Unmatched recording | no type | Not applicable |

Fixes (each a named workflow, dry run first): No-show recovery and Post-call follow-up add "call type is closing call"
(or stay off); Sales call recorded adds "the matched booking is not a triage call" on t1; Card moved by hand adds "the moved
card is the closer board's" before filing a no-show from a setter-board move, or drops the setter-board Cancelled edge.

## 5. Pre-call today (for the new words)

Closing pre-call:
- At booking: "Hi {{first}}, it's Nelly. You're booked for your private consultation with me on {{date}}. It runs about an
  hour, so block off the time. Reply YES to confirm, or let me know if you need to move it."
- 24h: "Hi {{first}}, looking forward to our consultation tomorrow at {{time}}. Come ready to talk about what you want in a
  partner and what hasn't worked so far. Nelly"
- 1h with link: "{{first}}, we're on {{in N hours}} ({{time}}). Join here: {{meeting_url}} See you soon! Nelly"
- 1h no link: "{{first}}, we're on {{in N hours}} ({{time}}). I'll send you the link here shortly. See you soon! Nelly"

Triage pre-call:
- At booking: "Hi {{first}}, it's Nelly. You're booked for your free 15-minute strategy call on {{date}}. My teammate
  {{closer}} will be the one calling you. Reply YES to confirm, or reply here if you need a different time."
- 24h: "Hi {{first}}, Nelly here. Quick reminder that {{closer}} is calling you tomorrow at {{time}} for your strategy call.
  It's only 15 minutes, so find a spot where you can talk freely."
- 1h: "{{first}}, your call with {{closer}} is {{in N hours}} ({{time}}). Keep your phone close."

The simple flow, per Tyler: text at booking, 24h before, 1h before. Each checks the call is still on. 24h skipped if booked
under 24h out; 1h skipped if booked under 1h out; one that would land at night goes earlier the same day; no meeting link →
"link coming". No reply reading, no buttons.

## 6. Unlock order (each on Tyler's word, by name)

1. §0 done; E1–E4 decided.
2. Fixes in §3 saved one workflow at a time, dry run shown each time.
3. Internal workflows that are off turned on (Payment failed, Unlinked payment, Agreement signed, Unsigned agreement chase).
4. Pre-call words approved → Triage pre-call, then Closing pre-call, unlocked.
5. Payment recorded and Deal closed after decisions 5 and 6, then unlocked.
6. Send agreement manually on `/agreement`, tested, unlocked; the tag retired.
