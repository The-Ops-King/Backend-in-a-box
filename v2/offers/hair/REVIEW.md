# Save Your Hair (Hair): v2 workflows for review

**UNSIGNED.** Every file in `offers/hair/` is a draft for Tyler. Nothing here is installed, enabled or live, and nothing here
changes Hair's v1 workflows, which keep running. Each workflow below ends with a decision line for Tyler: keep (sign the
translation as it is), change (say what), or drop.

What is here: `workflows/<id>.json` (30 workflows, each a translation of what Hair's live v1 workflow does today, from
`spec/hair/`), `content.json` (every word, by key, copied from the spec), `reports.json` (the report definitions the wrap-ups
and checks read), `settings.required.json` (every setting the workflows read, its type and what v1 had; no secret values), and
`scenarios/<id>/` (one scenario per path, plus one per path a real run took in `spec/hair/traces`). `src/offers/offers.test.ts`
validates every workflow, checks every content key, report and setting exists, and replays every scenario in the simulator with
the exact timeline it states; together the scenarios take every edge of every workflow (the few no run can take are in each
folder's `_untakeable.json`, with why). `pnpm sim offers/hair/workflows/<id>.json offers/hair/scenarios/<id>` prints the
timelines.

## The ten decisions that matter most

1. **Lists in posts (GAP 11).** Five Hair posts lose the list that is their point: Sales call recorded's "which booking was it?" options, Health check's ledger-drift questions and the alert links, EOD reminder's days and overdue calls, the EOD summary's calls. v2 content has no `each`; the choices are a list filter in content, or these posts as report definitions. Until then the translations post without the lists.
2. **Settings Hair has unbound today (GAP 6, GAP 23).** `slack.channel.attention` (Sales call recorded, Pre-call sequence; v1 fell back to ops and bookings), `crm.stage_setter_dq` and `crm.stage_setter_not_interested` (Setter call logged; v1 skipped those moves). v2 will not enable a workflow while a setting it reads is unbound: bind them (to today's fallback channels, and to real stages or an explicit "no stage"), or change the steps.
3. **Linking a phone call to a booking (GAP 18).** Sales call recorded's "link it" recorded `call.closing` to run the same workflow again on the chosen booking. v2 never starts a workflow from its own run's fact, so a tap links nothing more than the fact. Needs a mechanism: allow it explicitly, or a person's action in the Slack app.
4. **Alert posts and channels written into steps (GAP 15, GAP 16).** Calendar availability and Health check post alerts in the channel the alert names, with the persona it names; v2 posts to one setting (`slack.channel.engine_alerts`) with a fixed persona. Since "Slack works the same on every offer", these halves may belong to the platform's alert machinery, not to an offer's workflow. The three wrap-ups and the leaderboard posted to C0BT26R4695 written into the step; that is now `slack.channel.team_reports`. Both are set to C0BT26R4695 to keep today's behavior: confirm.
5. **Editing a post instead of posting again (GAP 17).** The outcome line under a booking, the call review and scorecard, the setter-call post and the EOD summary were edited in place when said again. v2 posts again. Needs an "edit if there, else post" option on message@1, or acceptance.
6. **Setter call logged acts on the team's answer two days late (possible v1 bug).** A tap is acted on (record, thread line, task, tags, cards) only when the question's two-day window closes. Keep (translated as it is), or act at once (end the tap path at the actions instead of `$resume`).
7. **Confidence as a percentage (GAP 20).** Jev's confidence was written "92% sure"; v2's is 0 to 1, so posts read "0.92% sure". Reword ("Jev's confidence: 0.92"), or add a percent filter.
8. **Engine actions with no step today (inventory E2 to E9, E12, E13).** Around these workflows v1's engine also acts on its own: the scope tag on a booking (E2), setter attribution and the missing-setter alert (E3, E4), opening the deal on a first booking or payment (E5, E6), paid in full (E7), relinking unlinked payments (E8), the deposit-names alert (E9), DND after a refused text (E12), turning a hand-moved card into card.moved (E13). v2 code does none of these, so each must become a step (the inventory's proposal) or stop. They are not in these drafts, which translate the workflows only: each waits for Tyler's yes.
9. **Health-sweep repairs (GAP 9).** v1's sweep pulled contacts in (firing lead.created, which can start Speed to lead and text them), retired duplicate ids and switched primary ids, with no step. v2 has only the findings. Decide: platform, explicit steps, or an opt-in.
10. **What v2 reads that v1 worked out (dependency).** Most branches read facts v1 computed for every run (paid beyond a deposit, signed, next call booked, owner / closer / setter, CRM record keys and cards, the appointment's outcome and pending read, the recording's caller and Set window). In v2 these come from the projections (piece 3 onward), with these names. Confirm the names, or rename them in the workflows before signing.

## How every workflow was translated

- Every word is copied from the spec. Only what is inside `{{ }}` changed, to v2's roots and filters (`docs/v1-to-v2-steps.md` has the table). Where it changed, the content entry keeps the exact v1 text as `v1`; where a list could not be written (GAP 11) the expression is left out and the rest kept.
- Each workflow's premise is v1's check written out: contact exists → `exists contact.id`; appointment exists → it exists and is not invalid; appointment in future → not cancelled and still ahead. v1 checked it once each time a run was picked up; v2 checks it on every wake and before every step that reaches outside. The one place that matters (Pre-call's cancel, then its ❌ post) is written so the post still goes.
- The send window is Hair's (8am to 8pm, the contact's zone, receipts at any hour), on the workflows that message the contact. v1 moved the message, not the wait, into the window, so every wait says `fitSendWindow: false` and the message waits for the window itself, as in v1.
- Delivery (sandbox / live) and CRM writes (dry / real) are not in a definition. Hair today is test mode with sends locked; Tyler sets these beside each workflow. Most scenarios run live so every path shows; a few run sandbox to show today's lock.
- What a failing step does is v1's rule for that step (the spec's "If it keeps failing"); a step says `onFailure` only where v2's default differs.
- Hidden actions are steps (inventory H1, H2, H3, H9, H10, H13): the Calendly cancel, the status fact, notify-owner's DM and task, the deal's won / lost, the outcome and call-held facts, CRM associations. Hidden actions with no step in Hair's copy (E2 scope tag, E3 / E4 setter attribution, E5 / E6 opportunities, E7 / E8 payments, E13 card moves) stay where v1 had them and are listed as findings.
- `facts.lookup` queries other than `last_event` and the report definitions are answered by the projections (piece 3 onward). The simulator answers from each scenario's `fixtures`; nothing here was invented for a real contact.
- v1 classifiers read their options from the database by domain; the criteria name them, so those are the options (plus "unclear" where a read below the threshold needs a name).
- Found on the way, fixed in v2 (not Hair's): a wait "24 hours from now" moved later every time the run woke early (a reply, any fact about the contact); "now" is now the moment the step was reached.

Gaps (things the format cannot say) are numbered as in `docs/v1-to-v2-steps.md`: 4 to 14 from piece 2, 15 to 23 found here.

## The workflows

| Workflow | v1 today | v1 version (template) | v1 steps → v2 steps | Scenarios |
|---|---|---|---|---|
| [New lead](#new-lead) | on, live | 3 (new-lead v3) | 5 → 6 | 3 |
| [Speed to lead](#speed-to-lead) | off, (test) | 5 (speed-to-lead v5) | 12 → 13 | 4 |
| [Call booked](#call-booked) | on, (test) | 18 (call-booked v16, edited) | 30 → 46 | 10 |
| [Call cancelled](#call-cancelled) | on, (test) | 7 (call-cancelled v7) | 9 → 11 | 3 |
| [Cancellation rebook](#cancellation-rebook) | off, (test) | 4 (cancellation-rebook v4) | 4 → 4 | 1 |
| [Pre-call sequence](#pre-call-sequence) | off, (test) | 15 (pre-call-sequence v15) | 46 → 66 | 14 |
| [Sales call recorded](#sales-call-recorded) | on, (test) | 10 (call-recorded v10) | 35 → 46 | 9 |
| [Setter call logged](#setter-call-logged) | on, (test) | 9 (setter-call-logged v9) | 79 → 100 | 21 |
| [Call outcome filed](#call-outcome-filed) | on, live | 9 (call-outcome v11) | 36 → 65 | 18 |
| [Card moved by hand](#card-moved-by-hand) | on, (test) | 1 (card-moved v1) | 10 → 15 | 5 |
| [No-show recovery](#no-show-recovery) | off, (test) | 4 (no-show-recovery v4) | 11 → 13 | 4 |
| [Post-call follow-up](#post-call-follow-up) | off, (test) | 3 (post-call-follow-up v3) | 4 → 4 | 1 |
| [Unmatched recording](#unmatched-recording) | on, (test) | 2 (recording-unlinked v3) | 3 → 3 | 1 |
| [Payment recorded](#payment-recorded) | on, (test) | 13 (payment-recorded v14) | 24 → 37 | 5 |
| [Payment failed](#payment-failed) | on, (test) | 5 (payment-failed v5) | 3 → 3 | 2 |
| [Unlinked payment](#unlinked-payment) | on, (test) | 2 (payment-unlinked v3) | 3 → 3 | 1 |
| [Deal closed](#deal-closed) | on, (test) | 6 (deal-closed v7) | 13 → 15 | 5 |
| [Agreement signed](#agreement-signed) | on, (test) | 6 (agreement-signed v6) | 5 → 6 | 1 |
| [Send agreement manually](#send-agreement-manually) | on, (test) | 2 (agreement-send-manually v2) | 6 → 8 | 3 |
| [Unsigned agreement chase](#unsigned-agreement-chase) | on, (test) | 6 (agreement-chase v6) | 16 → 22 | 5 |
| [Reactivation](#reactivation) | off, (test) | 3 (reactivation v3) | 7 → 7 | 2 |
| [Calendar availability](#calendar-availability) | on, live | 2 (calendar-availability v2) | 18 → 23 | 8 |
| [Health check](#health-check) | on, live | 6 (health-check v6) | 19 → 26 | 6 |
| [Ledger drift](#ledger-drift) | on, live | 1 (ledger-drift v1) | 6 → 9 | 3 |
| [Daily wrap-up](#daily-wrap-up) | on, live | 2 (daily-wrap-up v1, edited) | 4 → 4 | 1 |
| [Weekly wrap-up](#weekly-wrap-up) | on, live | 2 (weekly-wrap-up v1, edited) | 4 → 4 | 1 |
| [Monthly wrap-up](#monthly-wrap-up) | on, live | 2 (monthly-wrap-up v1, edited) | 4 → 4 | 1 |
| [Weekly leaderboard](#weekly-leaderboard) | on, live | 2 (weekly-leaderboard v1, edited) | 4 → 4 | 1 |
| [EOD: post the closer's day](#eod-post-the-closer-s-day) | on, live | 5 (eod-filed v5) | 4 → 5 | 1 |
| [EOD: remind closers to file](#eod-remind-closers-to-file) | on, live | 5 (eod-reminder v4, edited) | 9 → 10 | 4 |

### New lead

<a id="new-lead"></a>`workflows/new-lead.json` · v1: on, mode live, sends locked; runs again: always; re-checked: contact exists.

**What it does.** A new lead appears in GHL. It waits for a phone number (looking every 10 minutes, for up to a day); without one it stops. Then the setter card goes to New Lead (named "<name> -- New", stage-entered date set) and the lead is tagged stat-new. Nothing reaches the lead.

**Known findings.**
- E10 / E14 (inventory): what counts as a new lead, and the scope tag rule, are the CRM port's `contact.created` and a trigger match in v2; this workflow keeps v1's trigger name `lead.created`, which the connector must emit the same way.
- Choice (engine/14 §1): which board the card lands on is a sales-process choice; Hair uses the setter board.

**Scenarios.** `has-a-phone` (a lead with a phone), `no-phone-in-a-day` (no phone within a day), `phone-comes-later` (the phone comes 25 minutes later).

**Settings it reads.** `crm.pipeline_setter`, `crm.stage_setter_new_lead`.

Decision: keep / change / drop — 

### Speed to lead

<a id="speed-to-lead"></a>`workflows/speed-to-lead.json` · v1: off, mode follows the offer (test), sends locked; runs again: once_per_contact; re-checked: contact exists.

**What it does.** Off in v1. A new lead seen within 60 minutes of arriving in GHL gets the "Got your info" email and the first text with the booking link. It then waits two hours for a reply (the run ends on a reply); with none, and no call booked, the "Still want to talk?" email. A lead seen more than 60 minutes late gets nothing; the ops channel is asked to follow up by hand.

**Gaps (skipped, not worked around).**
- GAP 6: step s_late fell back to {{slack.channel.alerts}} when its channel setting was unbound; v2 refuses to enable instead

**Known findings.**
- engine/14 §1: it assumes the lead books themself; a setter model needs "call them now", not a link.
- Off on every offer.

**Proposed changes (not in the JSON).**
- Shared lesson (engine/14 §3.2, Dating): the "booked" check counts closing calls only; harmless for Hair (its booking link is the closing calendar).

**Scenarios.** `no-reply-but-booked` (in time, no reply, but booked), `no-reply-not-booked` (in time, no reply, nothing booked), `replied` (in time, they reply), `seen-late` (seen 90 minutes late).

**Settings it reads.** `calendar.booking.url`, `crm.location_id`, `slack.channel.ops`.

Decision: keep / change / drop — 

### Call booked

<a id="call-booked"></a>`workflows/call-booked.json` · v1: on, mode follows the offer (test), sends locked; runs again: always; re-checked: appointment exists.

**What it does.** A closing call booked or moved. It waits for GHL to have the person (every 2 minutes for an hour; then paused for a person). The closer is assigned on the contact, the appointment date written, the booking's UTMs filled where GHL has none. Self-booked: setter card to Direct Booked, closer card to Scheduled, stat-booked / stat-self-booked. Setter-booked: the setter on the contact, setter card to Appointment Set, closer card "Setter Booked", stat-set. A video task for the closer (not on a reschedule), the Sales Call record (the slot a reschedule left marked rescheduled), the booking card in the bookings channel (🔁 on the card it replaces), and notes under the card when texts cannot reach them (DND or no phone) or the call has no meeting link (plus an issue in the no-link channel).

**Written differently from v1, and why.**
- step c0: v1 failed the step after the retry window ("contact has no CRM id yet: GHL did not have the person an hour after the booking") so the run was held for a person, and a retry ran the check once more; v2 pauses for a person (wait@1 person), and on resume checks again (paused again when it still does not hold). Its else_exit "no_crm_id" is never reached in v1 either.
- `| date_company` (v1 "Thu Oct 29 · 2:00 PM EDT") became `| offer_date:medium` ("Thu, Oct 29 at 2:00 PM"): GAP 10, no zone name
- step k4: its associations are their own steps, crm.relate_records (H13), reading the record id the write gave back; a branch first checks the write gave one back (in v1 a failed write took its links with it)
- `{{vars.setter_line}}` is set to "" on purpose by an earlier step (v1 wrote nothing there); v2 holds a message with a blank, so the words read it with `| optional`
- step n4: the persona (name and icons) came from `vars.card` (set by v4: "Call rescheduled" with 🔁, else "New call booked"); v2 personas are fixed words, so the post picks one of two content entries with the same words by `event.type`. The 🔁 on the replaced card (v1 `react_on` with `{{vars.card.reschedule_mark}}`, empty for a new booking) is a branch and a slack.react before the post, because v1 put it on the post remembered under that tag before this one took the tag
- `{{vars.no_text_reason}}` is set to "" on purpose by an earlier step (v1 wrote nothing there); v2 holds a message with a blank, so the words read it with `| optional`
- steps n_dnd, n_nolink_note: its reactions are their own visible steps (slack.react / slack.unreact), each acting on the post it names; one whose post is not there does nothing
- what a failing step does once its tries are spent is v1's rule for each step; where v2's default (hold a step whose answer is read later, else skip) differs, the step says so (onFailure): s4, b5, k4

**Known findings.**
- engine/14 §3.2 (Hair): lacks the template's `ensure_contact` (it waits for GHL instead of finding or creating the person); its booking card has Hair's intake fields written into the words instead of the `bookingCard` setting ("configurable, not written in").
- E2 (inventory): today the engine adds the offer's scope tag to a new booker with no step (only for an offer with a scope tag; the spec export shows none for Hair). The inventory proposes it as a step here (`crm.add_tag {{setting.scope.tag}}`); that waits for Tyler's sign-off, so it is not in the JSON.
- E3 / E4 (inventory): the "setter-booked call with no setter" alert and the setter attribution (a connected dial within the window, re-read every 5 minutes) are engine actions on every new booking today. Proposed as steps here; not in the JSON until signed off.
- E5 (inventory): the ledger opportunity opened on the first booking (`opportunity.opened`) is an engine action today. Proposed as `facts.record deal.opened`; not in the JSON until signed off.
- Shared (engine/14 §1): PMU and Dating built a reschedule fork (keep the card's name, move only from pre-call stages) that Hair lacks.
- Hair's copy writes the Sales Call object as `custom_objects.sales_call` in the step, not through `crm.object_sales_call` (behind the configurable object settings).

**Proposed changes (not in the JSON).**
- Add the scope-tag step (E2) and `ensure_contact` (as `crm.find_or_create_contact` + `crm.add_tag`) in place of the wait, as the template has.
- Move the intake lines to a setting.

**Scenarios.** `crm-catches-up` (GHL has the person 10 minutes later), `no-phone` (no phone on file), `paused-for-a-person` (GHL never has the person: paused, resumed, paused again, ended), `rescheduled` (moved to another time), `resumed-once-ghl-has-them` (paused, then resumed once GHL has them), `sales-call-write-fails` (the Sales Call write fails), `self-booked` (self-booked, with a meeting link), `setter-booked` (booked by a setter), `texts-off-and-no-link` (texts off (DND) and no meeting link), `trace-setter-booked-simulated` (trace: a simulated setter-booked call (version 16)).

**Settings it reads.** `crm.assoc_sales_call_contact`, `crm.assoc_sales_call_opportunity`, `crm.location_id`, `crm.pipeline_closer`, `crm.pipeline_setter`, `crm.stage_closer_scheduled`, `crm.stage_setter_appointment_set`, `crm.stage_setter_direct_booked`, `picklist.sales_call_booking_source.self`, `picklist.sales_call_booking_source.setter`, `picklist.sales_call_outcome.rescheduled`, `picklist.sales_call_outcome.scheduled`, `slack.channel.bookings`, `slack.channel.no_link_alerts`.

Decision: keep / change / drop — 

### Call cancelled

<a id="call-cancelled"></a>`workflows/call-cancelled.json` · v1: on, mode follows the offer (test), sends locked; runs again: once_per_appointment; re-checked: appointment exists.

**What it does.** A closing call cancelled before it starts (the trigger skips a cancel after the start, which keeps the showed or no-show). Both cards go to their Cancelled stage, the appointment date is cleared, a rebook task goes to the closer, the booked tags come off and stat-cancelled goes on, the Sales Call is logged cancelled (never deleted), and ❌ with a note goes in the booking post's thread.

**Written differently from v1, and why.**
- `| date_company` (v1 "Thu Oct 29 · 2:00 PM EDT") became `| offer_date:medium` ("Thu, Oct 29 at 2:00 PM"): GAP 10, no zone name
- step n7: its reactions are their own visible steps (slack.react / slack.unreact), each acting on the post it names; one whose post is not there does nothing

**Known findings.**
- Choice (engine/14 §1): boards and call types.

**Scenarios.** `after-the-start` (cancelled after the call started), `cancelled-before-the-call` (cancelled before the call), `trace-calendly-cancel` (trace: a Calendly cancel).

**Settings it reads.** `crm.location_id`, `crm.pipeline_closer`, `crm.pipeline_setter`, `crm.stage_closer_cancelled`, `crm.stage_setter_cancelled`, `picklist.sales_call_outcome.cancelled`, `slack.channel.bookings`.

Decision: keep / change / drop — 

### Cancellation rebook

<a id="cancellation-rebook"></a>`workflows/cancellation-rebook.json` · v1: off, mode follows the offer (test), sends locked; runs again: once_per_appointment; re-checked: appointment exists.

**What it does.** Off in v1. A closing call cancelled before it starts gets the rebooking link by text and email.

**Known findings.**
- engine/14 §1: off everywhere; it links `calendar.closer_call`, not the cancelled call's own calendar.

**Scenarios.** `sent` (cancelled before the call).

**Settings it reads.** `calendar.closer_call.url`.

Decision: keep / change / drop — 

### Pre-call sequence

<a id="pre-call-sequence"></a>`workflows/pre-call-sequence.json` · v1: off, mode follows the offer (test), sends locked; runs again: once_per_appointment; key {{appointment.starts_at}}; re-checked: appointment in future.

**What it does.** Off in v1, and its words are still `[placeholder]`. A closing call booked or moved: once GHL has the person, the booking email and text (receipts, any hour). A reply within 4 hours is read by Jev: "confirmed" tags stat-confirmed and posts ✅; anything else asks the closer in the attention channel to keep, cancel or reschedule, while the reminders go on. No reply: stat-unconfirmed and ⏳. Reminders 72, 48 and 24 hours before (text, text, email and text), the morning of (calls from 11am), an hour and ten minutes before. The closer's ❌ cancels the booking (Calendly emails them) and ❌ is posted; 🔁 texts the rebooking link; ✅ confirms and the reminders go on. Jev's read is scored either way.

**Written differently from v1, and why.**
- steps n_conf and n_conf_slack are reached two ways in v1: straight from the reply read (b1: "confirmed") and from a person's ✅ tap (b_dec), and both go on to `rs` (resume), which with nothing to return to follows its edge to r72. v2's `$resume` returns only from a listener's path, so the tap path has its own copies (n_conf_tap, n_conf_slack_tap) that end in `$resume`, and the straight path goes on to r72. Same steps, same words
- step c0: v1 failed the step after the retry window ("contact has no CRM id yet: GHL did not have the person an hour after the booking") so the run was held for a person, and a retry ran the check once more; v2 pauses for a person (wait@1 person), and on resume checks again (paused again when it still does not hold). Its else_exit "no_crm_id" is never reached in v1 either.
- `ccc, LLL d 'at' h:mma` ("Thu, Oct 29 at 2:00PM") became `medium` ("Thu, Oct 29 at 2:00 PM"): GAP 10
- step c1: the read lands in `vars.intent` = { value, confidence, guesses } (v1: `reply.intent`, with the confidence as a percentage in `reply.intent_confidence`)
- steps n_unc_slack, n_conf_slack, n_cx_slack, n_rs_slack, n_conf_slack_tap: its reactions are their own visible steps (slack.react / slack.unreact), each acting on the post it names; one whose post is not there does nothing
- `| date_company` (v1 "Thu Oct 29 · 2:00 PM EDT") became `| offer_date:medium` ("Thu, Oct 29 at 2:00 PM"): GAP 10, no zone name
- step n_ask and the wait for a tap on it (w_dec, "Listen for the tap while the reminders go on") are one v2 step, ask@1 with the reactions ['white_check_mark', 'x', 'repeat'] as the answers (listens while the run goes on); the answer is `vars.reaction` = { value, person, at }: v1 `reaction.reaction` is `vars.reaction.value` and `reaction.user_name` is `vars.reaction.person` (a Slack user id, not a name)
- step n_ask: v1 posted the question, noted the pending read (n_pending), tagged stat-needs-attention (n_att_on), then armed the listener (w_dec); v2 arms the listener with the post itself (ask@1 listen), two quick steps earlier
- step n_pending (update_appointment pending_read): our own column in v1, a fact in v2 (facts.record `appointment.pending_read`); reading it back as `appointment.pending_read` (Call outcome filed does) depends on the appointments projection (piece 3 onward). v1 wrote the confidence as a percentage; v2's is 0 to 1
- `{{vars.decided}}` is set to "" on purpose by an earlier step (v1 wrote nothing there); v2 holds a message with a blank, so the words read it with `| optional`
- step n_cx (update_appointment status cancelled) is three visible steps (H1, H2): the fact's words (set), scheduling.cancel (effect contact: behind the delivery gate and the send lock, which v1's was not), and facts.record `appointment.status_changed` with startsWorkflows (v1 dispatched it, starting Call cancelled). The fact does not rewrite the appointment's own status: v1 checked the premise once per pass, so the ❌ post after it still went out; v2 checks it before each outbound step, and a folded "cancelled" would end the run before the post
- `| date:HH` compared as text ("09") became `| hour`, a number (9)
- what a failing step does once its tries are spent is v1's rule for each step; where v2's default (hold a step whose answer is read later, else skip) differs, the step says so (onFailure): n_ask, rec_un, rec

**Where the spec left a choice.**
- The pending read (update_appointment pending_read) is a fact, `appointment.pending_read`; Call outcome filed reads it back as `appointment.pending_read`, which depends on the appointments projection.

**Gaps (skipped, not worked around).**
- `reply.last_outbound.body`: the v1 reply context (what we last sent, the classifier read on the reply) has no v2 root; kept as `contact.reply.last_outbound.body` for the projection to provide
- GAP 20: v1 wrote the classifier's confidence as a percentage (`reply.intent_confidence`, 0 to 100); v2's `vars.intent.confidence` is 0 to 1 and there is no filter to turn it into one, so the words read "0.92% sure" where v1 read "92% sure"
- GAP 19: `{{reply.last_outbound.body}}` (what we last sent the contact) has no v2 source yet; read as `contact.reply.last_outbound.body | optional`, so it is empty (not held) until the messages projection provides it
- GAP 6: step n_ask fell back to {{slack.channel.bookings}} when its channel setting was unbound; v2 refuses to enable instead

**Known findings.**
- engine/14 §1: PMU and Hair words are still `[placeholder]`; Dating's copies have the timing fixes D193 / D194 / D199 and the no-link handling, which are Shared.
- H1 / inventory bug 1: v1's Calendly cancel (n_cx) was not behind the send lock; in v2 `scheduling.cancel` is a contact effect, behind the delivery gate.
- H2: the status fact and the start of the cancellation workflows are now a visible `facts.record` with startsWorkflows.

**Proposed changes (not in the JSON).**
- Shared lesson (engine/14 §1): bring in Dating's timing fixes (D193 earlier-same-day, D194, D199) and the no-link handling. Not done here: translation only.

**Scenarios.** `cancelled-at-the-source` (cancelled before the reminders), `closer-cancels` (the closer taps ❌), `closer-keeps-the-call` (the closer taps ✅), `closer-sends-the-rebooking-link` (the closer taps 🔁), `confirmed-by-reply` (they confirm by text), `early-morning-call` (a call at 8:30am), `first-seen-as-a-reschedule` (first seen as a reschedule), `mid-morning-call` (a call at 9:30am), `moved-while-in-flight` (moved to Friday while the reminders are waiting), `no-reply` (booked 3 days out, no reply), `paused-for-a-person` (GHL never has the person), `resumed-once-ghl-has-them` (resumed once GHL has them), `trace-unclear-then-turned-off` (trace: an unclear 👍, then the workflow was turned off), `unclear-nobody-decides` (an unclear reply nobody answers).

**Settings it reads.** `calendar.closer_call.url`, `slack.channel.attention`, `slack.channel.bookings`.

Decision: keep / change / drop — 

### Sales call recorded

<a id="sales-call-recorded"></a>`workflows/sales-call-recorded.json` · v1: on, mode follows the offer (test), sends locked; runs again: always; re-checked: contact exists.

**What it does.** A Fathom recording, or a dialer call Setter call logged handed over as a closing call. The whole conversation is looked up (a dropped line read as one call). Jev checks a recording is a sales call and reads how it ended; the AI writes notes and a scorecard. Matched to a booking: showed is recorded (telling the other workflows), stat-showed, the setter card won in Showed, ✅ on the booking post. The review goes to the calls channel with the scorecard in its thread, the Sales Call is written, and a CRM note. A phone closing call with no booking: the attention channel is asked which booking it was (two days to tap); a tap links it.

**Written differently from v1, and why.**
- step l_conv: `facts.lookup call_conversation` answers from the projections (piece 3 onward); the simulator answers from each scenario
- step a1: the read lands in `vars.kind` = { value, confidence, guesses } (v1: `vars.classify.kind`, with the confidence as a percentage in `reply.intent_confidence`)
- step a3: the read lands in `vars.disposition` = { value, confidence, guesses } (v1: `vars.outcome.disposition`, with the confidence as a percentage in `reply.intent_confidence`)
- step a2: v1 kept one answer in 2 variables (vars.notes, vars.rubric); v2 keeps it in `vars.review` and they read `vars.review.<key>`
- step o1 (record_outcome) is made visible (H10): facts.record_outcome writes the outcome, then facts.record `appointment.outcome` (which v1 dispatched to the other workflows, with the earlier answer) and, on a show, facts.record `call.held`, both starting the workflows that listen
- `{{vars.parts_line}}` is set to "" on purpose by an earlier step (v1 wrote nothing there); v2 holds a message with a blank, so the words read it with `| optional`
- `ccc LLL d` ("Thu Oct 29") became `short_day` ("Thu, Oct 29"): GAP 10
- step o3: one v1 card step that moves and marks the card is two v2 steps, crm.move_deal then crm.set_deal_status (pick "open", if missing "create" go with the move; the status step marks the contact's card on that pipeline)
- steps o4, q_none, q_done: its reactions are their own visible steps (slack.react / slack.unreact), each acting on the post it names; one whose post is not there does nothing
- step r1: its associations are their own steps, crm.relate_records (H13), reading the record id the write gave back; a branch first checks the write gave one back (in v1 a failed write took its links with it)
- `| date_company` (v1 "Thu Oct 29 · 2:00 PM EDT") became `| offer_date:medium` ("Thu, Oct 29 at 2:00 PM"): GAP 10, no zone name
- step l_opts: "<time> -14d" became `| minus:14d`
- step l_opts: "<time> +14d" became `| plus:14d`
- step l_opts: `facts.lookup appointments_for_contact` answers from the projections (piece 3 onward); the simulator answers from each scenario
- step q_which and the wait for a tap on it (w_which, "Wait two days for the tap") are one v2 step, ask@1 with the reactions ['one', 'two', 'three', 'x'] as the answers (waits for the answer); the answer is `vars.reaction` = { value, person, at }: v1 `reaction.reaction` is `vars.reaction.value` and `reaction.user_name` is `vars.reaction.person` (a Slack user id, not a name)
- `{{vars.chosen}}` is set to "" on purpose by an earlier step (v1 wrote nothing there); v2 holds a message with a blank, so the words read it with `| optional`
- what a failing step does once its tries are spent is v1's rule for each step; where v2's default (hold a step whose answer is read later, else skip) differs, the step says so (onFailure): o1, o1_said, o1_held, r1, rec_link

**Where the spec left a choice.**
- step a1: v1 read its options from the database (domain recording_kind); the criteria's options are used, and a read below the threshold counts as "other" (v2 needs one named)
- The recording's facts (closer, share URL, provider) are read from the fact's payload (`recording`); a `call.closing` that Setter call logged records carries only ids, so in v2 the recordings projection must give `recording.*` for that path.

**Gaps (skipped, not worked around).**
- GAP 11: `| words` (closed_won → "closed won") dropped in step s1: the raw value is shown
- GAP 11: `| bullets` in step s1 became `| join` (one line, comma separated; a list of objects reads as JSON)
- GAP 17: step s1 edits its earlier post (remembered under `recording:{{vars.convo.first.id}}`) when it is said again; v2 has no "edit if it is there, else post", so a second time posts again
- GAP 11: `| lines` (an AI answer laid out as labelled lines) dropped in steps s2, n1: the answer is written as JSON text
- GAP 17: step s2 edits its earlier post (remembered under `scorecard:{{vars.convo.first.id}}`) when it is said again; v2 has no "edit if it is there, else post", so a second time posts again
- GAP 17: step o4 edits its earlier post (remembered under `showed:{{appointment.id}}`) when it is said again; v2 has no "edit if it is there, else post", so a second time posts again
- GAP 11: `{{vars.options.items | each:"{{number}}. {{item.starts_at | date_company}} with {{...}}` (a list laid out with `| each`) cannot be written in v2 content: left out of step q_which
- GAP 6: steps q_which, q_none, q_done fell back to ['{{slack.channel.ops}}', '{{slack.channel.calls}}'] when its channel setting was unbound; v2 refuses to enable instead
- GAP 18: "Link it" (rec_link) recorded `call.closing` about the booking the team picked, with `start: true`, so this same workflow ran again on that booking (marking it showed and editing the review). v2 never starts a workflow from a fact its own run recorded, so the fact is recorded (and starts the other workflows that listen) but this workflow does not run again. Skipped, not worked around.

**Known findings.**
- engine/14 §3.2 (Hair): behind on the configurable objection, closer and object settings (harmless today): Hair's copy writes the objection picklist with `oneof:` and the object as `custom_objects.sales_call`.
- H10: record_outcome's hidden `appointment.outcome` and `call.held` dispatches are visible steps.
- H17: the analysis written to the recordings ledger is not carried (ledger only).

**Possible v1 bugs (translated as they are).**
- The CRM note's first line is "CALL SUMMARY — {{date}}{{closer}}" with nothing between the date and the closer's name ("CALL SUMMARY — 2026-10-10Luis Ortega"); the template has " · " there (spec/hair/sales-call-recorded.md, step n1). Copied as it is.

**Proposed changes (not in the JSON).**
- Shared (engine/14 §1): the configurable objection and closer options (template v11) that Hair lacks.

**Scenarios.** `meeting-matched` (a Fathom recording of a booked call), `meeting-no-booking` (a Fathom recording with no booking), `not-a-sales-call` (a recording that is not a sales call), `phone-closing-linked` (a dialer call read as closing, its booking known), `phone-no-booking-no-answer` (nobody answers in two days), `phone-no-booking-none-of-them` (the team says none of them), `phone-no-booking-team-picks` (a phone closing call with no booking: the team picks one), `sales-call-write-fails` (the Sales Call write fails), `trace-recorded` (trace: a booked call's Fathom recording).

**Settings it reads.** `calls.conversation_gap_min`, `crm.assoc_sales_call_contact`, `crm.assoc_sales_call_opportunity`, `crm.location_id`, `crm.pipeline_setter`, `crm.stage_setter_showed`, `picklist.sales_call_outcome.showed`, `slack.channel.attention`, `slack.channel.bookings`, `slack.channel.calls`.

Decision: keep / change / drop — 

### Setter call logged

<a id="setter-call-logged"></a>`workflows/setter-call-logged.json` · v1: on, mode follows the offer (test), sends locked; runs again: always; re-checked: contact exists.

**What it does.** A connected dialer call of a minute or more with a transcript (the whole conversation, if the line dropped). Jev reads its kind: a closing call is handed to Sales call recorded; anything else that is not setting or confirmation stops. A setting or confirmation call: AI notes. A setting call: Jev reads what it achieved; a booking through a setter link (during the call, or within the Set window after it) makes it Set. The Discovery Call record, a CRM note and a post in the setter-calls channel (15 minutes after hang-up, or when a booking lands). When Jev is unsure, the setters are asked (two days to tap). With acting on: a call-back task for follow up (next business day), the DQ tag and the setter card lost for DQ, the card lost for not interested. Hair's traces show acting off.

**Written differently from v1, and why.**
- step w_hold: its v1 condition also tested `vars.__listen` (an engine-internal "a listener is armed"), always true on the only path that reaches it (just after the question is posted); v2 has no such variable, so only `vars.asking` is tested
- steps l_conv, l_now, l_now2: `facts.lookup call_conversation` answers from the projections (piece 3 onward); the simulator answers from each scenario
- step a1: the read lands in `vars.call_type` = { value, confidence, guesses } (v1: `vars.classify.call_type`, with the confidence as a percentage in `reply.intent_confidence`)
- step l_book: "<time> -60m" became `| minus:60m`
- step l_book: "<time> +60m" became `| plus:60m`
- step l_book: `facts.lookup appointments_for_contact` answers from the projections (piece 3 onward); the simulator answers from each scenario
- `{{vars.booking_id}}` is set to "" on purpose by an earlier step (v1 wrote nothing there); v2 holds a message with a blank, so the words read it with `| optional`
- step a3: the read lands in `vars.setter_result` = { value, confidence, guesses } (v1: `vars.classify.result`, with the confidence as a percentage in `reply.intent_confidence`)
- `| date:X` (epoch seconds, to compare two times) dropped: v2 compares two date-times as instants
- step w_post: v1 kept { matched: true|false, ... } in `vars.booked`; v2 keeps the event (or null at the deadline), so `vars.booked.matched` is `vars.booked_matched`, set right after the wait
- `| date_company` (v1 "Thu Oct 29 · 2:00 PM EDT") became `| offer_date:medium` ("Thu, Oct 29 at 2:00 PM"): GAP 10, no zone name
- `{{vars.parts_line}}` is set to "" on purpose by an earlier step (v1 wrote nothing there); v2 holds a message with a blank, so the words read it with `| optional`
- step r1: its associations are their own steps, crm.relate_records (H13), reading the record id the write gave back; a branch first checks the write gave one back (in v1 a failed write took its links with it)
- `{{vars.decided_by}}` is set to "" on purpose by an earlier step (v1 wrote nothing there); v2 holds a message with a blank, so the words read it with `| optional`
- `{{vars.result}}` is set to "" on purpose by an earlier step (v1 wrote nothing there); v2 holds a message with a blank, so the words read it with `| optional`
- step a4: the read lands in `vars.dq_reason` = { value, confidence, guesses } (v1: `vars.classify.dq_reason`, with the confidence as a percentage in `reply.intent_confidence`)
- step q1 and the wait for a tap on it (l1, "Listen for the tap for two days") are one v2 step, ask@1 with the reactions ['white_check_mark', 'repeat', 'x', 'no_entry_sign'] as the answers (listens while the run goes on); the answer is `vars.reaction` = { value, person, at }: v1 `reaction.reaction` is `vars.reaction.value` and `reaction.user_name` is `vars.reaction.person` (a Slack user id, not a name)
- step k_task: v1 wrote the task's due as `{{vars.task_due}}` (+3d on a Friday, +2d on a Saturday, else +1d, from v_due); v2 task due times are fixed, so a branch picks one of three task steps
- `| date_company:c` (weekday number 1-7) became `| offer_date:weekday` (the weekday's name)
- steps k_lost_dq, k_lost_ni: one v1 card step that moves and marks the card is two v2 steps, crm.move_deal then crm.set_deal_status (pick "open", if missing "skip" go with the move; the status step marks the contact's card on that pipeline)
- `{{vars.result_key}}` is set to "" on purpose by an earlier step (v1 wrote nothing there); v2 holds a message with a blank, so the words read it with `| optional`
- steps ru2, q_reply: its reactions are their own visible steps (slack.react / slack.unreact), each acting on the post it names; one whose post is not there does nothing
- `{{vars.result_words}}` is set to "" on purpose by an earlier step (v1 wrote nothing there); v2 holds a message with a blank, so the words read it with `| optional`
- what a failing step does once its tries are spent is v1's rule for each step; where v2's default (hold a step whose answer is read later, else skip) differs, the step says so (onFailure): rec_close, r1, rec_read, q1, ru1, rec_rev, rec_late

**Where the spec left a choice.**
- step a1: v1 read its options from the database (domain setter_call_type); the criteria's options are used, and a read below the threshold counts as "other" (v2 needs one named)
- step a3: v1 read its options from the database (domain setter_call_result); the criteria name ['dq', 'set', 'follow_up', 'not_interested'], so those are the options, plus "unclear" for a read below the threshold (v2 needs one)
- step a4: v1 read its options from the database (domain setter_dq_reason); the criteria's options are used, and a read below the threshold counts as "other" (v2 needs one named)
- The weekday for the task's due date: v1 `{{now | date_company:c}}` (Luxon weekday number, 5 Friday, 6 Saturday) is `offer_date:weekday` ("Friday", "Saturday").

**Gaps (skipped, not worked around).**
- GAP 20: v1 wrote the classifier's confidence as a percentage (`reply.intent_confidence`, 0 to 100); v2's `vars.setter_result.confidence` is 0 to 1 and there is no filter to turn it into one, so the words read "0.92% sure" where v1 read "92% sure"
- GAP 11: `| words` (closed_won → "closed won") dropped in steps v_guess, lt_line, v_line: the raw value is shown
- GAP 17: steps s1, s_late edits its earlier post (remembered under `setter-call:{{vars.convo.key}}`) when it is said again; v2 has no "edit if it is there, else post", so a second time posts again
- GAP 6: steps q1, ru2, q_reply fell back to ['{{slack.channel.ops}}', '{{slack.channel.bookings}}'] when its channel setting was unbound; v2 refuses to enable instead

**Edges no run can take.** `w_hold_if → r2_if (else)`: w_hold is only reached just after the question to the team is posted, which happens only when vars.asking is true (b_ask); v1 also tested an engine-internal "a listener is armed" (vars.__listen), always true there.

**Known findings.**
- engine/14 §3.2 (Hair): behind on the configurable objection, closer and object settings (harmless today): the Discovery Call object is written in the step.
- engine/14 §1: Dating moves the setter's CRM writes to the end-of-day form (D154); PMU cannot enable this workflow.
- crm.stage_setter_dq and crm.stage_setter_not_interested are unbound for Hair; v1 then skipped those card moves. v2 will not enable the workflow until they are bound (GAP 23).

**Possible v1 bugs (translated as they are).**
- The team's tapped answer is acted on only when the question's two days are up, not when tapped: the tap path ends in `resume`, which returns the run to `w_hold` ("Keep the question open two days") with its own due time, and only after that wait do r2 (the record) and q_reply (who decided) run (spec/hair/setter-call-logged.md steps l1, w_hold, rs / rs2; platform/src/engine/definition.ts:72-74, resume keeps "where it was and when it was due"). Translated as it is; the scenario "unsure-team-taps-set" shows it.

**Scenarios.** `a-later-part-before-the-set-window-closed` (a later part came in before the Set window closed), `a-later-part-came-in` (a later part of the call came in), `booked-during-the-call` (booked through a setter link during the call), `booked-in-the-set-window` (booked in the Set window after the post), `closing-call` (a closing call on the dialer), `confirmation-call` (a confirmation call), `discovery-call-write-fails` (the Discovery Call write fails), `dq-acted` (a setting call, disqualified (acting on)), `follow-up-acted` (a setting call, follow up (acting on)), `follow-up-acting-off` (today: follow up with acting off), `follow-up-on-a-friday` (follow up on a Friday), `follow-up-on-a-saturday` (follow up on a Saturday), `no-transcript` (no transcript), `not-a-setting-call` (a voicemail), `not-interested-acted` (a setting call, not interested (acting on)), `too-short` (under a minute), `trace-posted` (trace: Jev read Set, the booking came after the post), `trace-too-short` (trace: a 1-second call), `unsure-nobody-answers` (Jev unsure: nobody answers), `unsure-team-taps-follow-up` (Jev unsure: the team taps 🔁), `unsure-team-taps-set` (Jev unsure: the team taps ✅).

**Settings it reads.** `calls.conversation_gap_min`, `crm.assoc_discovery_call_contact`, `crm.location_id`, `crm.pipeline_setter`, `crm.stage_setter_dq`, `crm.stage_setter_not_interested`, `picklist.discovery_call_result.dq`, `picklist.discovery_call_result.follow_up`, `picklist.discovery_call_result.not_interested`, `picklist.discovery_call_result.set`, `setter_result.act`, `slack.channel.setter_calls`.

Decision: keep / change / drop — 

### Call outcome filed

<a id="call-outcome-filed"></a>`workflows/call-outcome-filed.json` · v1: on, mode live, sends locked; runs again: always; re-checked: nothing.

**What it does.** The closer filed how a closing call went (their form), or the booking was marked no-show. A changed answer first takes off the tags the earlier answer added and, if it takes back a loss, reopens the deal. No-show: 👻 on the booking post, stat-no-show, the setter card lost, the closer card to No Show (open), the Sales Call no-show, and a recorded unanswered read when Jev had said "cancel". Showed: ✅, stat-showed, the setter card won in Showed, the Sales Call showed with the disposition, then by the call's outcome: closed (card back to Scheduled after a changed answer), deposit (Deposit stage), follow up, lost (and the deal lost), disqualified. Rescheduled on the call: a 🔁 line and the Sales Call marked rescheduled.

**Written differently from v1, and why.**
- step u1: the v1 pick key "{{event.previous_outcome | default:}}:{{event.previous_call_outcome | default:}}" is several parts; v2 `$pick` takes one expression, so the key is set first as `vars.tags_before_key`
- `| date_company` (v1 "Thu Oct 29 · 2:00 PM EDT") became `| offer_date:medium` ("Thu, Oct 29 at 2:00 PM"): GAP 10, no zone name
- steps g1, s1: its reactions are their own visible steps (slack.react / slack.unreact), each acting on the post it names; one whose post is not there does nothing
- step g1: the reaction taken back was `{{vars.undo_emoji}}` (from u3: ghost after a no-show, white_check_mark after a show, else none); v2 emoji names are fixed, so a branch on `vars.undo_emoji` picks the slack.unreact step. Only the emojis u3 can give on this path have a step (white_check_mark)
- step u2: the v1 pick key "{{event.outcome}}:{{appointment.call_outcome | default:}}" is several parts; v2 `$pick` takes one expression, so the key is set first as `vars.tags_now_key`
- step u3: the v1 pick key "{{event.previous_outcome | default:}}>{{event.outcome}}" is several parts; v2 `$pick` takes one expression, so the key is set first as `vars.undo_emoji_key`
- steps gn1, gn2, sc1, kc, kd, k2, k3, k4: one v1 card step that moves and marks the card is two v2 steps, crm.move_deal then crm.set_deal_status (pick "latest", if missing "skip" go with the move; the status step marks the contact's card on that pipeline)
- step o_reopen (update_opportunity, our ledger's deal, not the CRM card) is facts.record `deal.reopened` with startsWorkflows (H9: v1 dispatched opportunity.open); "only from ['lost']" is a branch on `deal.status` first. No CRM write, as in v1
- step s1: the reaction taken back was `{{vars.undo_emoji}}` (from u3: ghost after a no-show, white_check_mark after a show, else none); v2 emoji names are fixed, so a branch on `vars.undo_emoji` picks the slack.unreact step. Only the emojis u3 can give on this path have a step (ghost)
- step r3s: the reaction taken back was `{{vars.undo_emoji}}` (from u3: ghost after a no-show, white_check_mark after a show, else none); v2 emoji names are fixed, so a branch on `vars.undo_emoji` picks the slack.unreact step. Only the emojis u3 can give on this path have a step (ghost, white_check_mark)
- step o_lost (update_opportunity, our ledger's deal, not the CRM card) is facts.record `deal.lost` with startsWorkflows (H9: v1 dispatched opportunity.lost); "only from ['open']" is a branch on `deal.status` first. No CRM write, as in v1
- what a failing step does once its tries are spent is v1's rule for each step; where v2's default (hold a step whose answer is read later, else skip) differs, the step says so (onFailure): o_reopen_rec, g3, o_lost_rec

**Where the spec left a choice.**
- `event._source` ("disposition", the closer's form) is `event.outcome_source`: the closer's form must arrive as `appointment.outcome` with `outcome_source: "disposition"` (and Card moved by hand records it so).
- The disposition written to the Sales Call: v1 mapped the call outcome through the offer's own option keys (`option:sales_call_disposition`, GAP 11); v2 writes the call outcome as it is, which is what v1 did for an offer that declared none.

**Gaps (skipped, not worked around).**
- GAP 17: steps g1, s1, r3s edits its earlier post (remembered under `outcome:{{appointment.id}}`) when it is said again; v2 has no "edit if it is there, else post", so a second time posts again
- GAP 8: step u4 keeps ['{{vars.tags_now}}'] even when its remove list names them; v2 removes exactly the list
- GAP 11: `| words` (closed_won → "closed won") dropped in step s1: the raw value is shown
- GAP 11: `| option:sales_call_disposition` (the offer's own picklist key) dropped in step v_disp: the value is written as it is (what v1 did for an offer that declared no option keys)
- GAP 21: u4 removes `{{vars.tags_before}}`, a list held in a variable; as a v2 `tags` entry it is a list inside the list, which the CRM port must flatten (or u4 must name the tags).

**Edges no run can take.** `kd_if → x1 (else)`: v1 skipped the Deposit move when crm.stage_closer_deposit was unbound; v2 will not enable a workflow while a setting it reads is unbound (GAP 6), so in v2 the setting is always there. `r3s_undo → r3 (else)`: r3s is reached only when the earlier answer was showed or no-show (r3s_if), and then u3 always names the reaction to take back (ghost or white_check_mark).

**Known findings.**
- engine/14 §3.2 (PMU): PMU's copy lacks the closing-call condition; Hair's has it.
- H9: the deal's won / lost / reopened are visible facts.

**Scenarios.** `closed-after-a-no-show` (changed to closed after a no-show), `closed` (showed, closed), `deposit` (showed, deposit), `engine-outcome-ignored` (an outcome the engine recorded), `follow-up` (showed, follow up), `lost-deal-not-open` (showed, lost, the deal already closed), `lost-taken-back-deal-open` (changed from lost, the deal never lost), `lost-taken-back` (changed from lost to follow up), `lost` (showed, lost), `marked-no-show-after-a-cancel-read` (marked no-show after Jev read a cancel), `no-show-after-a-show` (changed to no-show after "showed"), `no-show-filed` (the closer files a no-show), `other-outcome` (an outcome with nothing to mark), `rescheduled-after-a-no-show` (changed to rescheduled after a no-show), `rescheduled-after-a-show` (changed to rescheduled after "showed"), `rescheduled-first` (rescheduled on the call, first answer), `showed-no-call-outcome` (showed, no call outcome), `unqualified` (showed, disqualified).

**Settings it reads.** `crm.object_sales_call`, `crm.pipeline_closer`, `crm.pipeline_setter`, `crm.stage_closer_cancelled`, `crm.stage_closer_deposit`, `crm.stage_closer_disqualified`, `crm.stage_closer_follow_up`, `crm.stage_closer_lost`, `crm.stage_closer_scheduled`, `crm.stage_setter_cancelled`, `crm.stage_setter_showed`, `picklist.sales_call_outcome.noshow`, `picklist.sales_call_outcome.on_call`, `picklist.sales_call_outcome.showed`, `slack.channel.bookings`.

Decision: keep / change / drop — 

### Card moved by hand

<a id="card-moved-by-hand"></a>`workflows/card-moved-by-hand.json` · v1: on, mode follows the offer (test), sends locked; runs again: always; re-checked: nothing.

**What it does.** Someone moved a card in GHL by hand: a line in the booking post's thread says who moved which card where (or what it was marked). Into the closer or setter Cancelled stage after the call started (and not already a no-show): filed as a no-show, as the closer's form would. Into Lost or Disqualified after the call started: filed as showed with that outcome.

**Written differently from v1, and why.**
- `{{vars.status_part}}` is set to "" on purpose by an earlier step (v1 wrote nothing there); v2 holds a message with a blank, so the words read it with `| optional`
- steps o_noshow, o_lost, o_dq (record_outcome) is made visible (H10): facts.record_outcome writes the outcome, then facts.record `appointment.outcome` (which v1 dispatched to the other workflows, with the earlier answer) and, on a show, facts.record `call.held`, both starting the workflows that listen
- what a failing step does once its tries are spent is v1's rule for each step; where v2's default (hold a step whose answer is read later, else skip) differs, the step says so (onFailure): o_noshow, o_noshow_said, o_lost, o_lost_said, o_lost_held, o_dq, o_dq_said, o_dq_held

**Where the spec left a choice.**
- `via: card_moved` (what filed it) has no `facts.record_outcome` param; it is kept on the `appointment.outcome` fact's data.

**Known findings.**
- E13 (inventory): turning a hand move into `card.moved` about the contact's latest closing call is engine code in v1; in v2 it is the CRM's `deal.stage_changed` and a lookup. This translation keeps the `card.moved` fact the platform must emit.
- H10: the filed outcome tells Call outcome filed (`appointment.outcome`) and, on a show, the `call.held` listeners.

**Scenarios.** `into-disqualified` (into Disqualified after the call), `into-lost` (into Lost after the call), `into-no-show` (into the closer No Show / Cancelled stage after the call), `trace-noted-before-the-call` (trace: the setter card moved to Cancelled), `trace-noted-status-only` (trace: the setter card re-opened, stage unchanged).

**Settings it reads.** `crm.stage_closer_cancelled`, `crm.stage_closer_disqualified`, `crm.stage_closer_lost`, `crm.stage_setter_cancelled`, `slack.channel.bookings`.

Decision: keep / change / drop — 

### No-show recovery

<a id="no-show-recovery"></a>`workflows/no-show-recovery.json` · v1: off, mode follows the offer (test), sends locked; runs again: once_per_appointment; re-checked: appointment exists.

**What it does.** Off in v1. Ten minutes after a no-show (marked, or filed by the closer), unless they booked again: the rebooking text and email (up to 3 days after the call). A reply ends it. With none in a day and still nothing booked: one more email (up to 7 days after the call).

**Known findings.**
- engine/14 §3.2 (Hair): lacks the closing-call condition (off). Translated as it is: a no-show of any call type starts it.

**Proposed changes (not in the JSON).**
- Add the closing-call condition to both triggers (the template has it).

**Scenarios.** `no-reply` (no reply in a day), `rebooked-at-once` (they rebook within 10 minutes), `rebooked-later` (they rebook during the day), `replied` (they reply to the rebooking text).

**Settings it reads.** `calendar.closer_call.url`.

Decision: keep / change / drop — 

### Post-call follow-up

<a id="post-call-follow-up"></a>`workflows/post-call-follow-up.json` · v1: off, mode follows the offer (test), sends locked; runs again: once_per_appointment; re-checked: contact exists.

**What it does.** Off in v1. The morning after a call filed "follow up" (9am their time), one text asking for questions.

**Known findings.**
- engine/14 §1 / §3.2: no call-type condition, even in the template.

**Scenarios.** `sent` (filed "follow up").


Decision: keep / change / drop — 

### Unmatched recording

<a id="unmatched-recording"></a>`workflows/unmatched-recording.json` · v1: on, mode follows the offer (test), sends locked; runs again: always; re-checked: nothing.

**What it does.** A recording that matched nobody: posted in the alerts channel with what is known and a "Link to a contact" button.

**Gaps (skipped, not worked around).**
- GAP 6: step n1 fell back to {{slack.channel.bookings}} when its channel setting was unbound; v2 refuses to enable instead

**Known findings.**
- Inventory bug 3: hand-linking in Slack does not start Payment recorded or Sales call recorded in v1 (the Link button is platform).

**Scenarios.** `told` (a recording matched nobody).

**Settings it reads.** `platform.base_url`, `slack.channel.alerts`.

Decision: keep / change / drop — 

### Payment recorded

<a id="payment-recorded"></a>`workflows/payment-recorded.json` · v1: on, mode follows the offer (test), sends locked; runs again: always; re-checked: contact exists.

**What it does.** Every payment or refund. A payment beyond a deposit wins the open deal; the running total goes on the contact, the revenue on the first payment beyond a deposit. The payment tags: pay-refunded, pay-deposit, pay-paid-full (pay-plan-active off), or pay-plan-active. The Payment record in GHL, linked to the contact and the closer card. The first payment beyond a deposit with the agreement unsigned sends the agreement, tags stat-agreement-sent and moves the closer card to Agreement Sent. A CRM note, the Sales Call's cash, the post in the payments channel, and a line (💵, 💸 on a refund) in the booking post's and the call review's threads.

**Written differently from v1, and why.**
- step o_won (update_opportunity, our ledger's deal, not the CRM card) is facts.record `deal.won` with startsWorkflows (H9: v1 dispatched opportunity.won); "only from ['open']" is a branch on `deal.status` first. No CRM write, as in v1
- `{{vars.pay.sign}}` is set to "" on purpose by an earlier step (v1 wrote nothing there); v2 holds a message with a blank, so the words read it with `| optional`
- step n4: its associations are their own steps, crm.relate_records (H13), reading the record id the write gave back; a branch first checks the write gave one back (in v1 a failed write took its links with it)
- `| date_company` (v1 "Thu Oct 29 · 2:00 PM EDT") became `| offer_date:medium` ("Thu, Oct 29 at 2:00 PM"): GAP 10, no zone name
- step n5: the persona name was `{{vars.pay.head}}` ("Refund" or "Payment received"); a v2 persona is fixed words, so the post picks one of two content entries with the same words by `event.kind`
- step p_book: the reaction on the parent post was `{{vars.pay.react}}` (money_with_wings on a refund, else dollar); v2 emoji names are fixed, so a branch on `event.kind` picks one of two slack.react steps
- step p_rev: the reaction on the parent post was `{{vars.pay.react}}` (money_with_wings on a refund, else dollar); v2 emoji names are fixed, so a branch on `event.kind` picks one of two slack.react steps
- what a failing step does once its tries are spent is v1's rule for each step; where v2's default (hold a step whose answer is read later, else skip) differs, the step says so (onFailure): o_won_rec, n4

**Edges no run can take.** `g1_if → n4 (else)`: g1's v1 condition (only on a refund) is the same as the branch edge that leads to it (n3: refund), so it always holds there.

**Known findings.**
- E6 / E7 / E8 / E9 (inventory): opening an opportunity on a payment (with the default contract value), deciding paid in full (and dispatching `payment.paid_in_full`), relinking earlier unlinked payments and the deposit-names alert are engine actions in v1, before this workflow runs; it reads their result (`event.cleared`, `event.running_total`, `event.kind`). They are proposed as steps (E8 is GAP 14) and wait for sign-off, so they are not in the JSON.
- Choice (engine/14 §1): the card to Agreement Sent vs Purchase.

**Scenarios.** `first-payment-beyond-deposit` (the first payment beyond a deposit, unsigned), `paid-in-full-signed` (paid in full, already signed, deal already won), `payment-record-write-fails` (the Payment record write fails), `refund` (a refund), `trace-recorded-deposit` (trace: a deposit).

**Settings it reads.** `crm.agreement_sender`, `crm.agreement_template`, `crm.assoc_payment_contact`, `crm.assoc_payment_opportunity`, `crm.location_id`, `crm.object_payment`, `crm.object_sales_call`, `crm.pipeline_closer`, `crm.stage_closer_agreement_sent`, `slack.channel.bookings`, `slack.channel.calls`, `slack.channel.payments`.

Decision: keep / change / drop — 

### Payment failed

<a id="payment-failed"></a>`workflows/payment-failed.json` · v1: on, mode follows the offer (test), sends locked; runs again: always; re-checked: contact exists.

**What it does.** A failed payment: posted in the payments channel, naming the closer to follow up (and the setter). Nothing goes to the customer.

**Known findings.**
- engine/14 §1: a closer owns collections; = on every offer.

**Scenarios.** `posted` (a failed payment is posted), `sandbox-test-channel` (today: before live, in the test channel).

**Settings it reads.** `crm.location_id`, `slack.channel.payments`.

Decision: keep / change / drop — 

### Unlinked payment

<a id="unlinked-payment"></a>`workflows/unlinked-payment.json` · v1: on, mode follows the offer (test), sends locked; runs again: always; re-checked: nothing.

**What it does.** A payment that matched nobody: posted in the alerts channel with the buyer's email, phone and Whop member, and a "Link to a contact" button.

**Written differently from v1, and why.**
- `| fixed:2` (no thousands separator) became `| money:2` ("1,500.00", with one): GAP 11 dropped `fixed`

**Gaps (skipped, not worked around).**
- GAP 6: step n1 fell back to {{slack.channel.bookings}} when its channel setting was unbound; v2 refuses to enable instead

**Known findings.**
- Inventory bug 3: the hand-link does not start Payment recorded in v1.

**Scenarios.** `told` (a payment matched nobody).

**Settings it reads.** `platform.base_url`, `slack.channel.alerts`.

Decision: keep / change / drop — 

### Deal closed

<a id="deal-closed"></a>`workflows/deal-closed.json` · v1: on, mode follows the offer (test), sends locked; runs again: once_per_contact; re-checked: contact exists.

**What it does.** Once the contact has paid beyond a deposit and signed the agreement (whichever comes second), and is not a customer yet: stat-customer, the closer card to Closed Won (won), the setter card won, the Sales Call marked closed won with the cash, the welcome email and text (receipts, any hour), and the win posted in the deals channel with an AI cheer line.

**Written differently from v1, and why.**
- step p1: one v1 card step that moves and marks the card is two v2 steps, crm.move_deal then crm.set_deal_status (pick "open", if missing "create" go with the move; the status step marks the contact's card on that pipeline)
- `ccc LLL d` ("Thu Oct 29") became `short_day` ("Thu, Oct 29"): GAP 10

**Where the spec left a choice.**
- step p2: a v1 card step with a status and no stage (if missing: create, pick: open); v2 crm.set_deal_status has no "make one when missing" and no pick, so it only marks a card that is there

**Known findings.**
- engine/14 §3.2 (PMU): the shipped deal-closed holds Hair's welcome words; PMU sends Hair's welcome. Hair's own words are right for Hair.
- Shared (engine/14 §1): Dating's won card carries the deal value (D130); Hair's does not.

**Possible v1 bugs (translated as they are).**
- The welcome email starts "Hi {{contact.first_name}}," with no default: a contact with no first name gets no welcome in v1 (the render refuses an unknown path) and in v2 it is held (spec/hair/deal-closed.md, step e1).
- The setter card is marked won with no stage and "create if missing" (step p2): v1 would make a setter card for a contact who has none, in no named stage. v2 only marks a card that is there (see the choices).

**Proposed changes (not in the JSON).**
- Shared lesson (D130): put the deal value on the won card.

**Scenarios.** `already-a-customer` (already a customer), `closed-no-sales-call` (paid and signed, no Sales Call record), `closed-with-sales-call` (paid and signed, with a Sales Call), `trace-closed-deposit` (trace: closed on a deposit (version 5)), `trace-not-yet` (trace: signed before paying).

**Settings it reads.** `crm.location_id`, `crm.object_sales_call`, `crm.pipeline_closer`, `crm.pipeline_setter`, `crm.stage_closer_closed_won`, `picklist.sales_call_outcome.showed`, `slack.channel.deals`.

Decision: keep / change / drop — 

### Agreement signed

<a id="agreement-signed"></a>`workflows/agreement-signed.json` · v1: on, mode follows the offer (test), sends locked; runs again: always; re-checked: contact exists.

**What it does.** A signed agreement: stat-agreement-signed on, stat-agreement-unsigned off, a CRM note, and a post in the deals channel.

**Written differently from v1, and why.**
- `| date_company` (v1 "Thu Oct 29 · 2:00 PM EDT") became `| offer_date:medium` ("Thu, Oct 29 at 2:00 PM"): GAP 10, no zone name

**Known findings.**
- engine/14 §1: agreement workflows assume pay first, sign after.

**Scenarios.** `trace-recorded` (trace: recorded (test contact)).

**Settings it reads.** `crm.location_id`, `slack.channel.deals`.

Decision: keep / change / drop — 

### Send agreement manually

<a id="send-agreement-manually"></a>`workflows/send-agreement-manually.json` · v1: on, mode follows the offer (test), sends locked; runs again: always; re-checked: contact exists.

**What it does.** The tag sys-send-agreement-manually on a contact who has not signed: the purchase agreement is sent, stat-agreement-sent on, the trigger tag off, a CRM note.

**Written differently from v1, and why.**
- `| date_company` (v1 "Thu Oct 29 · 2:00 PM EDT") became `| offer_date:medium` ("Thu, Oct 29 at 2:00 PM"): GAP 10, no zone name

**Known findings.**
- engine/14 §3.2 (all three): behind the template's `/agreement` trigger (D202). Hair's copy (version 2) has only the tag trigger; the template (agreement-send-manually) also starts on the Slack `/agreement` command with its own variables.

**Proposed changes (not in the JSON).**
- Bring in the template's `/agreement` trigger (D202).

**Scenarios.** `already-signed` (already signed), `locked-sends` (today: sends locked), `sent` (not signed yet: sent).

**Settings it reads.** `crm.agreement_sender`, `crm.agreement_template`.

Decision: keep / change / drop — 

### Unsigned agreement chase

<a id="unsigned-agreement-chase"></a>`workflows/unsigned-agreement-chase.json` · v1: on, mode follows the offer (test), sends locked; runs again: once_per_contact; re-checked: contact exists.

**What it does.** After a first payment that is not a deposit (nothing beyond a deposit paid before): every 24 hours, three times, while the agreement is unsigned, the owner is DMed (else the alerts channel) and given a CRM task. After the third: stat-agreement-unsigned and a post in the alerts channel.

**Written differently from v1, and why.**
- `| date_company` (v1 "Thu Oct 29 · 2:00 PM EDT") became `| offer_date:medium` ("Thu, Oct 29 at 2:00 PM"): GAP 10, no zone name
- steps n1, n2, n3 (notify_owner) is split in two visible steps (H3): the DM to the contact's owner (else the fallback channel), then the CRM task

**Known findings.**
- H3 (inventory): notify_owner's DM and task are two visible steps.
- The trace is from version 5, which also started on a deposit; version 6 (live) does not.

**Scenarios.** `signed-after-first-nudge` (signed after the first nudge), `signed-after-second-nudge` (signed after the second nudge), `signed-before-first-nudge` (signed within the day), `trace-signed-deposit` (trace: a deposit (version 5)), `unsigned-after-3` (never signed: three nudges, then the alert).

**Settings it reads.** `crm.location_id`, `slack.channel.alerts`.

Decision: keep / change / drop — 

### Reactivation

<a id="reactivation"></a>`workflows/reactivation.json` · v1: off, mode follows the offer (test), sends locked; runs again: once_per_contact_per_window (window 90d); re-checked: contact exists.

**What it does.** Off in v1. The tag reactivate starts three check-ins with the booking link: an email now, a text 3 days later, a last email 4 days after that. At most once per contact in 90 days.

**Known findings.**
- engine/14 §3.2 (all three): it does not stop when the person replies or books.

**Proposed changes (not in the JSON).**
- Shared lesson: stop on a reply or a booking (a `wait@1 reply` with the 3- and 4-day deadlines, and a premise on no upcoming call).

**Scenarios.** `again-within-90-days` (tagged again within 90 days), `sequence` (tagged reactivate).

**Settings it reads.** `calendar.booking.url`.

Decision: keep / change / drop — 

### Calendar availability

<a id="calendar-availability"></a>`workflows/calendar-availability.json` · v1: on, mode live, sends locked; runs again: always; re-checked: nothing.

**What it does.** Every hour, and on every booking, reschedule and status change, the calendars' open times are read (fewer than 3 in the next 7 days is a low-availability alert, raised by the platform). Availability alerts come back as facts: a new one is posted with Retry (skipped steps only), Resolve and Pause, with the next days' times under it; still open, a line in its thread; cleared, resolved in its thread with ✅.

**Written differently from v1, and why.**
- step n1 (availability_check) is report@1 of the availability report; raising the low-availability alert from it is platform alert machinery (H7), as in v1, and comes back as an alert.raised fact the second half posts
- step a_resolve: its reactions are their own visible steps (slack.react / slack.unreact), each acting on the post it names; one whose post is not there does nothing

**Gaps (skipped, not worked around).**
- GAP 16: steps a_post, a_repeat, a_resolve, a_thread posted where the triggering alert said (`{{event.channel}}`); a v2 Slack channel is always one setting, so it is `slack.channel.engine_alerts` (every Hair alert in the traces went to C0BT26R4695)
- GAP 11: `{{event.fix_link | each:" · <{{item}}|{{event.fix_label}}>"...}}` (a list laid out with `| each`) cannot be written in v2 content: left out of step a_post
- GAP 11: `{{event.extra_link | each:"{{event.link | then:\" · \" | default:\"\\n\"}}<{{item}...}}` (a list laid out with `| each`) cannot be written in v2 content: left out of step a_post
- GAP 15: the Slack persona name `{{event.as_name | default:Engine alerts}}` in steps a_post, a_repeat, a_resolve, a_thread is chosen by a value; v2 personas are fixed words in the content (a `pick` of content entries is used where the patch says so)
- GAP 15: the persona icon in steps a_post, a_repeat, a_resolve, a_thread is chosen by a value

**Known findings.**
- H7 (inventory): raising and resolving alerts is platform. "Slack works the same on every offer" (CLAUDE.md): how these alerts post is the platform's, so this half may belong to the platform rather than to Hair's workflow.
- engine/14 §3.2 (PMU): PMU never got this version.

**Scenarios.** `alert-raised-no-detail` (raised with no detail to thread), `alert-raised-open-cleared` (a low-availability alert: raised, still open, cleared), `alert-with-no-channel` (an alert that names no channel), `hourly` (the hourly check), `on-a-booking` (appointment.booked: read again), `on-a-reschedule` (appointment.rescheduled: read again), `on-a-status-change` (appointment.status_changed: read again), `trace-hourly` (trace: the hourly read).

**Settings it reads.** `slack.channel.engine_alerts`.

Decision: keep / change / drop — 

### Health check

<a id="health-check"></a>`workflows/health-check.json` · v1: on, mode live, sends locked; runs again: always; re-checked: nothing.

**What it does.** Every hour the health sweep runs (43 checks in the traces); its findings are raised as alerts by the platform. Every alert except availability comes back as a fact: new, posted with a headline by kind, Retry / Resolve / Pause, and the detail under it; still open, a line in its thread; cleared, resolved with ✅. The ledger-drift alert words its own questions.

**Written differently from v1, and why.**
- `{{vars.drift_head}}` is set to "" on purpose by an earlier step (v1 wrote nothing there); v2 holds a message with a blank, so the words read it with `| optional`
- step a_resolve: its reactions are their own visible steps (slack.react / slack.unreact), each acting on the post it names; one whose post is not there does nothing

**Gaps (skipped, not worked around).**
- GAP 9: step n1 (health_check) also repaired things in v1: pulled contacts in and fired lead.created (H5), retired duplicate ids and switched primary ids (H6). v2 has no verbs for these; only the findings are read (report@1). Raising its findings as alerts is platform (H7), and those alerts come back as alert.raised facts that the second half of this workflow posts
- GAP 11: `| plural` dropped in step a_dhead
- GAP 11: `{{event.detail.q.missing | each:"\n• {{item.name}} is in GHL but the engine couldn...}}` (a list laid out with `| each`) cannot be written in v2 content: left out of step a_body
- GAP 11: `{{event.detail.q.setup | each:"\n• {{item.label}}: GHL says {{item.said}}, but the...}}` (a list laid out with `| each`) cannot be written in v2 content: left out of step a_body
- GAP 11: `{{event.detail.q.disposition_unmapped | each:"\n• {{item.label}}: GHL's outcome is...}}` (a list laid out with `| each`) cannot be written in v2 content: left out of step a_body
- GAP 11: `{{event.detail.q.link_contact | each:"\n• {{item.label}}: this Sales Call isn't li...}}` (a list laid out with `| each`) cannot be written in v2 content: left out of step a_body
- GAP 11: `{{event.detail.q.link_card | each:"\n• {{item.label}}: this Sales Call isn't linke...}}` (a list laid out with `| each`) cannot be written in v2 content: left out of step a_body
- GAP 11: `{{event.detail.q.link_unhandled | each:"\n• {{item.label}}: this Sales Call isn't ...}}` (a list laid out with `| each`) cannot be written in v2 content: left out of step a_body
- GAP 11: `{{event.detail.q.unmatched | each:"\n• {{item.label}}: GHL has this Sales Call, bu...}}` (a list laid out with `| each`) cannot be written in v2 content: left out of step a_body
- GAP 11: `{{event.detail.q.ambiguous | each:"\n• {{item.label}}: this Sales Call fits more t...}}` (a list laid out with `| each`) cannot be written in v2 content: left out of step a_body
- GAP 11: `{{event.detail.q.cancel_time_unknown | each:"\n• {{item.label}}: {{item.booking_so...}}` (a list laid out with `| each`) cannot be written in v2 content: left out of step a_body
- GAP 11: `{{event.detail.q.cancel_held_back | each:"\n• {{item.label}}: {{item.booking_sourc...}}` (a list laid out with `| each`) cannot be written in v2 content: left out of step a_body
- GAP 11: `{{event.detail.q.cancel_set_back | each:"\n• {{item.label}}: {{item.booking_source...}}` (a list laid out with `| each`) cannot be written in v2 content: left out of step a_body
- GAP 11: `{{event.detail.q.cancel_no_value | each:"\n• {{item.label}}: {{item.booking_source...}}` (a list laid out with `| each`) cannot be written in v2 content: left out of step a_body
- GAP 11: `{{event.detail.q.cancel_unhandled | each:"\n• {{item.label}}: {{item.booking_sourc...}}` (a list laid out with `| each`) cannot be written in v2 content: left out of step a_body
- GAP 11: `{{event.detail.q.ledger_write | each:"\n• {{item.label}}: the engine couldn't upda...}}` (a list laid out with `| each`) cannot be written in v2 content: left out of step a_body
- GAP 11: `{{event.detail.q.ghl_unfiled | each:"\n• {{item.label}}: the engine has {{item.has...}}` (a list laid out with `| each`) cannot be written in v2 content: left out of step a_body
- GAP 11: `{{event.detail.q.won_no_payment | each:"\n• {{item.name}}: their closer card was w...}}` (a list laid out with `| each`) cannot be written in v2 content: left out of step a_body
- GAP 11: `{{event.detail.q.payment_no_won | each:"\n• {{item.name}}: GHL has a ${{item.amoun...}}` (a list laid out with `| each`) cannot be written in v2 content: left out of step a_body
- GAP 11: `{{event.detail.more | each:"\n…and {{item}} more on the dashboard."...}}` (a list laid out with `| each`) cannot be written in v2 content: left out of step a_body
- GAP 16: steps a_post, a_repeat, a_resolve, a_thread posted where the triggering alert said (`{{event.channel}}`); a v2 Slack channel is always one setting, so it is `slack.channel.engine_alerts` (every Hair alert in the traces went to C0BT26R4695)
- GAP 11: `{{event.fix_link | each:" · <{{item}}|{{event.fix_label}}>"...}}` (a list laid out with `| each`) cannot be written in v2 content: left out of step a_post
- GAP 11: `{{event.extra_link | each:"{{event.link | then:\" · \" | default:\"\\n\"}}<{{item}...}}` (a list laid out with `| each`) cannot be written in v2 content: left out of step a_post
- GAP 15: the Slack persona name `{{event.as_name | default:Engine alerts}}` in steps a_post, a_repeat, a_resolve, a_thread is chosen by a value; v2 personas are fixed words in the content (a `pick` of content entries is used where the patch says so)
- GAP 15: the persona icon in steps a_post, a_repeat, a_resolve, a_thread is chosen by a value

**Known findings.**
- H5 / H6 (inventory): the sweep pulled contacts in and fired `lead.created` (which could start Speed to lead), marked contacts gone, retired duplicate ids and switched primary ids, with no step. GAP 9.
- H7: alerts are platform; the same note as Calendar availability.
- engine/14 §3.2 (PMU): PMU's copy still says availability alerts itself.

**Scenarios.** `alert-with-no-channel` (an alert that names no channel), `availability-alerts-are-not-its` (an availability alert), `hourly` (the hourly sweep), `ledger-drift-questions` (the ledger drift alert), `trace-hourly` (trace: the hourly sweep), `trace-slack-user-alert` (trace: a Slack-user alert, still open, then cleared).

**Settings it reads.** `slack.channel.engine_alerts`.

Decision: keep / change / drop — 

### Ledger drift

<a id="ledger-drift"></a>`workflows/ledger-drift.json` · v1: on, mode live, sends locked; runs again: always; re-checked: nothing.

**What it does.** The health sweep found a GHL Sales Call drifting from the ledger: one whose booking was cancelled before the call is marked cancelled; one linked to nobody is linked to its contact and closer card.

**Written differently from v1, and why.**
- step r_link: its associations are their own steps, crm.relate_records (H13), reading the record id the write gave back; a branch first checks the write gave one back (in v1 a failed write took its links with it)
- what a failing step does once its tries are spent is v1's rule for each step; where v2's default (hold a step whose answer is read later, else skip) differs, the step says so (onFailure): r_link

**Known findings.**
- H5 (inventory): the drift events themselves come from the sweep (platform).

**Scenarios.** `cancelled` (a Sales Call to mark cancelled), `link-write-fails` (the Sales Call write fails), `unlinked` (a Sales Call to link).

**Settings it reads.** `crm.assoc_sales_call_contact`, `crm.assoc_sales_call_opportunity`, `crm.object_sales_call`.

Decision: keep / change / drop — 

### Daily wrap-up

<a id="daily-wrap-up"></a>`workflows/daily-wrap-up.json` · v1: on, mode live, sends locked; runs again: always; re-checked: nothing.

**What it does.** At 7pm every day, today's numbers (leads, bookings, calls, shows, closes, revenue, cash, refunds, dials, speed to lead, what leads said, by closer and setter) are posted. The layout is Hair's own (its copy is edited): the report definition is kept as it is in `reports.json`.

**Written differently from v1, and why.**
- step n_post: the channel id C0BT26R4695 written into the v1 step became the setting `slack.channel.team_reports`

**Where the spec left a choice.**
- step n_build: v1 has no period on a daily wrap-up (it reports today at 7pm); v2 needs one: `in_progress` (today so far)

**Known findings.**
- Hair's copy posts to the channel id C0BT26R4695 written into the step, not to `slack.channel.reports` ("configurable, not written in").
- Hair's copy dropped the template's `quiet_when_empty` and the deposits metrics.

**Scenarios.** `trace-posted` (the wrap-up is posted).

**Settings it reads.** `slack.channel.team_reports`.

Decision: keep / change / drop — 

### Weekly wrap-up

<a id="weekly-wrap-up"></a>`workflows/weekly-wrap-up.json` · v1: on, mode live, sends locked; runs again: always; re-checked: nothing.

**What it does.** At 8am every Monday, last week's numbers (leads, bookings, calls, shows, closes, revenue, cash, refunds, dials, speed to lead, what leads said, by closer and setter) are posted. The layout is Hair's own (its copy is edited): the report definition is kept as it is in `reports.json`.

**Written differently from v1, and why.**
- step n_post: the channel id C0BT26R4695 written into the v1 step became the setting `slack.channel.team_reports`

**Known findings.**
- Hair's copy posts to the channel id C0BT26R4695 written into the step, not to `slack.channel.reports` ("configurable, not written in").
- Hair's copy dropped the template's `quiet_when_empty` and the deposits metrics.

**Scenarios.** `trace-posted` (the wrap-up is posted).

**Settings it reads.** `slack.channel.team_reports`.

Decision: keep / change / drop — 

### Monthly wrap-up

<a id="monthly-wrap-up"></a>`workflows/monthly-wrap-up.json` · v1: on, mode live, sends locked; runs again: always; re-checked: nothing.

**What it does.** At 8am on the 1st, last month's numbers (leads, bookings, calls, shows, closes, revenue, cash, refunds, dials, speed to lead, what leads said, by closer and setter) are posted. The layout is Hair's own (its copy is edited): the report definition is kept as it is in `reports.json`.

**Written differently from v1, and why.**
- step n_post: the channel id C0BT26R4695 written into the v1 step became the setting `slack.channel.team_reports`

**Known findings.**
- Hair's copy posts to the channel id C0BT26R4695 written into the step, not to `slack.channel.reports` ("configurable, not written in").
- Hair's copy dropped the template's `quiet_when_empty` and the deposits metrics.

**Scenarios.** `posted` (the wrap-up is posted).

**Settings it reads.** `slack.channel.team_reports`.

Decision: keep / change / drop — 

### Weekly leaderboard

<a id="weekly-leaderboard"></a>`workflows/weekly-leaderboard.json` · v1: on, mode live, sends locked; runs again: always; re-checked: nothing.

**What it does.** At 9am every Monday, last week's closers by cash (with closes and close rate) and setters by sets (with show rate) are posted, with the period line.

**Written differently from v1, and why.**
- step n_post: the channel id C0BT26R4695 written into the v1 step became the setting `slack.channel.team_reports`

**Gaps (skipped, not worked around).**
- GAP 6: step n_post fell back to {{slack.channel.reports}} when its channel setting was unbound; v2 refuses to enable instead

**Known findings.**
- Hair's copy posts to the channel id C0BT26R4695 written into the step (its fallback to `slack.channel.reports` never applies to a literal id).
- Hair's copy dropped `quiet_when_empty`.

**Scenarios.** `trace-posted` (trace: last week's leaderboard).

**Settings it reads.** `slack.channel.team_reports`.

Decision: keep / change / drop — 

### EOD: post the closer's day

<a id="eod-post-the-closer-s-day"></a>`workflows/eod-post-the-closer-s-day.json` · v1: on, mode live, sends locked; runs again: always; re-checked: nothing.

**What it does.** A closer filed their end-of-day form: what happened on each call is posted in the EOD channel, and the closer gets "Got it" under their reminder, with ✅ on it.

**Written differently from v1, and why.**
- step n_ack: its reactions are their own visible steps (slack.react / slack.unreact), each acting on the post it names; one whose post is not there does nothing

**Gaps (skipped, not worked around).**
- GAP 11: `{{event.calls | each:"\n• {{item.contact}}: {{item.outcome_label | default:no answ...}}` (a list laid out with `| each`) cannot be written in v2 content: left out of step n_summary
- GAP 17: step n_summary edits its earlier post (remembered under `eod-summary:{{event.user_id}}:{{event.day}}`) when it is said again; v2 has no "edit if it is there, else post", so a second time posts again
- GAP 17: step n_ack edits its earlier post (remembered under `eod-ack:{{event.user_id}}:{{event.day}}`) when it is said again; v2 has no "edit if it is there, else post", so a second time posts again
- GAP 22: the ✅ reply (n_ack) was a thread under the closer's reminder DM; the v2 dispatcher threads only in a channel, so it is a plain DM. The ✅ reaction on the reminder is its own step.

**Known findings.**
- engine/14 §1: schedules and words are each offer's own.

**Scenarios.** `filed` (a closer files their day).

**Settings it reads.** `slack.channel.eod`.

Decision: keep / change / drop — 

### EOD: remind closers to file

<a id="eod-remind-closers-to-file"></a>`workflows/eod-remind-closers-to-file.json` · v1: on, mode live, sends locked; runs again: always; re-checked: nothing.

**What it does.** At 6pm (today and earlier days) and 9am (earlier days), one run per closer: when the closer has days still to file, Tyler is DMed the closer's link (closer reminders are off until launch: Hair's copy is edited for that), and calls blank in GHL for two days are told to the operator.

**Written differently from v1, and why.**
- step c_due: its else ("nothing_to_file") ends at the v1 exit x_nothing, which has that reason and which nothing else led to (v2 refuses a step no trigger reaches)
- steps n_dm, n_op: v1 posted to `{{company.operator_slack_id}}` (the offer's escalate-to person, `bot.escalate_to`): a DM to `{{setting.bot.escalate_to}}`

**Gaps (skipped, not worked around).**
- GAP 11: `{{vars.due.days | each:"• <{{item.url}}|{{item.when}}>: {{item.calls | nonzero | p...}}` (a list laid out with `| each`) cannot be written in v2 content: left out of step n_dm
- GAP 11: `{{vars.due.overdue | each:"• {{item.label}}: {{item.names | join}}" | join:"\n"...}}` (a list laid out with `| each`) cannot be written in v2 content: left out of step n_op

**Known findings.**
- Hair's copy sends the reminder to Tyler, not the closer, until launch.
- The trace's "done" runs (versions 4 and 5, test mode) kept no steps.

**Scenarios.** `evening-due-and-overdue` (evening: days to file, calls blank for two days), `morning-due` (morning: an earlier day to file), `trace-done` (trace: the morning reminder), `trace-nothing-to-file` (trace: two closers, nothing to file).

**Settings it reads.** `bot.escalate_to`.

Decision: keep / change / drop — 
