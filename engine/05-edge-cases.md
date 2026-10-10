# Edge cases, per workflow: what should happen, and what is proven

Tyler, 2026-10-09: "we should also determine as many edge cases as possible and have them test." This file is that
list, one section per shipped template (by its `name`, as the dashboard shows it) plus an engine-wide section for what
is not about one template. Every row says what a sales-ops operator expects and names the test that proves it, or
says `not yet`. Coverage was checked by reading the tests, not by memory: a row is "covered" only when a test asserts
that behaviour. `edge-cases.test.ts` is `platform/src/engine/edge-cases.test.ts`; the other files are its siblings.

Where the engine does something other than the row expects, the row says **Today:** and points at the Known gap. A
Known gap has a test marked `it.fails` in `edge-cases.test.ts`: the test states the expected behaviour, and the day
the engine is fixed the test turns red for the right reason.

What happens when a step's vendor answers 400, 401, 503 or nothing at all — per node type, with the retry and pause
policy, today's behaviour by line, and the places a retry could duplicate a card, a message, a task or a note — is its
own catalogue: `engine/07-step-failures.md` (D67), tested by `platform/src/engine/step-failures.test.ts`.

## Known gaps

Engine behaviour that looks wrong, each shown by an `it.fails` test in `edge-cases.test.ts` (an `it.todo` where the
right answer is a template decision first). Ranked by how likely it is to bite in the first live week. G11 onwards are
about who the person is (no phone, no email, names, duplicates, numbers, zones, deletions); their tests live in
`edge-cases.contacts.test.ts` (`platform/src/engine/edge-cases.contacts.test.ts`) and the rows are in § Contacts.

| # | Gap | Where | Shown by |
|---|---|---|---|
| G1 | **Fixed (D56).** The CRM refuses a text (no number on the sub-account; a contact with no phone is G11 since D60 and never reaches the CRM) and the whole run failed. Now the send row is `failed` with the CRM's message, the step is `skipped` as blocked (the alert sweep's "step could not run", D33), and the run goes on to the reply wait and the emails. Since D66 only a refusal the CRM means takes that path: a 5xx or a dead token on the send is the failure policy's (the text is retried in place, or the run pauses until the token is replaced) and the send row is reclaimed by the retry. | `executor.ts` `doSend` | `the CRM refuses the text…` |
| G2 | **Fixed (D56).** A CRM outage (401 after a token rotation, a 5xx) at the premise check failed the run for good. Now "the check could not run" is told apart from "the check said no": the run stays `waiting` with `next_run_at` `PREMISE_RETRY_MIN` (5 minutes) out, one `premise:booking-source-unreachable` alert per company is open while it lasts and resolves when a read succeeds. A real `ok:false` still exits the run. The same outage *inside* a step (a tag, a card, a note) is handled by D66: retried in place on the schedule, then paused. | `runner.ts` premise try/catch | `the CRM is down (401, token rotated) at the premise check…` |
| G3 | **Fixed (D56).** A workflow turned off while runs were parked kept running them. Now every claimed run re-reads `workflows.enabled` before anything else: off → the run exits `workflow turned off` with a `run.exited` event, so turning the switch back on starts fresh runs from new events. | `runner.ts` per-run loop, before the premise check | `a workflow turned off while a run is parked…` |
| G4 | **Fixed (D56).** The D45 supersede rule was applied to `always` workflows whose runs are about distinct facts (two payments in one minute, two recordings of one call). Now it applies only to reentry `once_per_contact`, `once_per_appointment` and `once_per_contact_per_window`; `always` (and `once_per_opportunity`) runs are never superseded. On the way: a `thread_of` tag the context cannot name (no recording yet) is "no post to reply to", not a failed run. | `dispatch.ts` `SUPERSEDES` | `two payments for one person in the same minute…` |
| G5 | **Fixed (D53).** The Slack door wrote `slack.reaction` events with `source: 'slack'`, which the events table's check constraint did not allow; `slack` is now in the schema and in `migrate.ts` EVENT_SOURCES. | `app/api/webhooks/slack/[companyId]/route.ts:39`; `engine/schema.sql:341`; `src/db/migrate.ts:6` | `the Slack door's event source is one the events table accepts…` (pure) |
| G6 | **A person rebooks, the old call is then cancelled** (how a GHL reschedule done as cancel + new booking arrives): Call cancelled moves the setter and closer cards to Cancelled with a live call days away, and Cancellation rebook texts "saw the call got cancelled, pick a new time" to someone who just did. Expected: both check for a newer confirmed closing call and stop. | `call-cancelled.json` n1/n2, `cancellation-rebook.json` n1; `poll.ts:135` only links a reschedule the source links itself (Calendly) | `a person rebooks and the old call is then cancelled…` |
| G7 | **Fixed (D58).** A call booked a few hours out got no reminders: the booking text's reply wait held the run for its full 4-hour timeout and nothing capped it at the call time. `wait_for_reply` now takes `until` (a wait rule); pre-call's is an hour before the call, so the run moves on to the reminders in time. | `executor.ts` `wait_for_reply`; `pre-call-sequence.json` w1 | `a call booked two hours out…` (passing) |
| G8 | **Fixed (D56).** Slack refusing the bot token failed the run at the post, and every CRM step after it was skipped. Now `slack_post` and `notify_owner` catch the refusal: the send row is `failed` with Slack's error, the step is `skipped` as blocked (one open alert per workflow step, repeated at most hourly, D33), and the run continues to the CRM steps. Slack refusals stay on this path under D66 (a post is never the point of a run); the CRM steps after it are the failure policy's. | `executor.ts` `slackPostOrFail` | `Slack refuses the bot token in the middle of Sales call recorded…` |
| G9 | **Fixed (D56).** Re-running install with `mode: "live"` flipped the flag without Go live. Now install never writes `live` itself: with `mode: "live"` it calls `goLive` after the install commits (the same readiness refusal, with the blockers listed; the same clean slate, D51) and reports what was cleared as `wentLive`. Any other mode value sets the flag as before. | `install.ts` after the install transaction | `re-running install with mode: live on a shadow company…` |
| G10 | **Fixed (D57).** A refund changed nothing downstream: no template listened to `payment.refunded`, so cash collected and `pay-paid-full` stood after the money went back. Payment recorded now has a second trigger on it: cash collected follows the lower running total, the Payment record is a new line with the negative amount, `pay-refunded` is added, and `pay-paid-full` / `pay-plan-active` stay as the last payment left them. | `payment-recorded.json` t2, v1, g1 | `a refund (G10, fixed by D57)…` |
| G11 | **Fixed (D60).** A send to a contact with no address for the channel asked the CRM and its refusal was the only word on why. Now `doSend` reads `contact.phone` / `contact.email` from the context before anything is queued: no address → the send row is `suppressed` with `no phone on the contact` / `no email on the contact`, the step is a `noop` with the same words, the CRM is never asked, the run goes on. G1 still covers the CRM's own refusals. | `executor.ts:108-114` | `edge-cases.contacts.test.ts › a lead with no phone and no email: Speed to lead records…`, `› a lead with an email but no phone…`, `› a lead with a phone but no email: the email is skipped…` |
| G12 | **Fixed (D60).** Names were stored as the CRM sent them, spaces included. `upsertContact` and `resolveContactForBooking` now trim and collapse inner runs of whitespace on first and last name (`normName`); case, hyphens and apostrophes are untouched, and a blank name is stored as null so a template's `default:` can speak. | `poll.ts:49-53`, `poll.ts:103`; `context.ts:31` trims only `name` | `edge-cases.contacts.test.ts › a name with leading/trailing spaces renders trimmed…` |
| G13 | **Fixed (D60).** An empty name rendered "Hey ," and a card named " -- New". Now the context's `contact.first_name` is the CRM's first name, else the first word of whatever name there is, else null; the five greeting templates say `{{contact.first_name \| default:there}}`; `pipeline_card` names a nameless person's card by their email, then phone, then CRM id (`ne1@x.com -- New`). `pre-call-sequence`, `call-booked` and `deal-closed` were not touched: their uses are Slack posts, a task title and the welcome email. | `executor.ts:340`; `speed-to-lead.json`, `pre-call-sequence.json`, `reactivation.json`, `no-show-recovery.json`, `post-call-follow-up.json` | `edge-cases.contacts.test.ts › an empty name: the text does not say 'Hey ,'…` |
| G14 | **Fixed (D60).** A reply from a duplicate CRM record's thread was dropped. `pollInbound` now resolves the sender through `contact_identifiers kind='ghl_contact'` first (where a folded duplicate's id lives), then `contacts.ghl_contact_id`; the message lands on the one person and wakes the run parked on their reply. | `poll.ts:188` | `edge-cases.contacts.test.ts › a reply from the duplicate CRM record's thread counts…` |
| G15 | **Fixed (D60).** A retired number still pointed at the old person. When the CRM record's own phone or email changes, the identifier it replaced is marked `retired_at` (kept for history, shown on the contact, never matched again); identity resolution for contacts, bookings and inbound reads current identifiers only; a new CRM contact carrying a retired number takes it with them (the row moves) and is a separate person. | `poll.ts:44` (match on any identifier ever seen), `poll.ts:55-56` (identifiers only ever added) | `edge-cases.contacts.test.ts › a number that moved to a different CRM contact belongs to the new person…` |
| G16 | **Fixed (D60).** A person whose first appearance was a CRM calendar booking never got `lead.created`. `resolveContactForBooking` now reports when the live read made a new person, and `applyAppointment` emits and dispatches `lead.created` (the contacts poll's shape: `data.ghl_contact_id`, match context with the CRM id and tags) before `appointment.booked`; the later contacts poll sees an existing row and fires nothing twice. | `poll.ts:92`; `poll.ts:40-42, 58` | `edge-cases.contacts.test.ts › a CRM calendar booking by a person the contacts poll has not seen: lead.created fires once…` |
| G17 | **An orphan payment is not healed when the buyer's contact arrives**: heal runs only inside `settle`, on a later payment or a hand link; the CRM poll that brings the contact changes nothing, so the row sits unlinked until someone notices. D21 says nothing is guessed, but an exact email match is the test `resolvePayer` already trusts — decide, then fix. Fix: after `upsertContact` adds an email/phone identifier, heal `link_status='unlinked'` rows with that `customer_email`/phone and dispatch their `payment.received`. | `payments.ts:84-87` (heal inside `settle` only); `poll.ts:37` (`upsertContact` never reads `payments`) | `edge-cases.contacts.test.ts › a payment whose email matches no contact stays unlinked; when that contact arrives…` |
| G18 | **Fixed (D60).** A healed orphan got `payment.linked`, which nothing listens to, and so no Payment record in the CRM. `settle`'s heal loop now, per healed row oldest first, derives the row's `kind` and emits + dispatches its own `payment.received` (`payment.refunded` for a negative) with `prior_total` / `running_total` as of its day and `linked_by: heal`, so Payment recorded runs once for it; a row that already has such an event is skipped; `payment.linked` is still written. | `payments.ts:84-87`; `templates/*.json` (nothing on `payment.linked`) | `edge-cases.contacts.test.ts › an orphan healed by a later payment from the same buyer is written to the CRM too…` |
| G19 | **Fixed (D60).** `normPhone` adds `+1` to ten digits, or eleven with a leading `1`, with or without the plus (`^\+?1?(\d{10})$` → `+1$1`); any other length stays as typed. `1-602-555-0901` is `+16025550901`. | `poll.ts:14` | `edge-cases.contacts.test.ts › a phone written with a leading 1 and no plus…` |
| G20 | **Fixed (D60).** A garbage CRM time zone reached the window math and Postgres refused the invalid `next_run_at`. Now the zone is validated with Luxon at upsert (CRM and booking): an unusable zone is stored as the company's with `timezone_source='company_default'`, exactly as a missing one is; and the context, `contactTz` and so the runner's window math fall back to the company zone when a stored zone is unusable, so an old row cannot bite either. | `poll.ts:46` (`s.timezone ?? companyTz`, unvalidated); `waitrule.ts:48-56`; `runner.ts:100-103` | `edge-cases.contacts.test.ts › a contact whose CRM time zone is garbage falls back…` |
| G21 | **Fixed (D60).** A contact deleted or merged in the CRM was invisible until a send's refusal failed the run. Now a send that comes back with the CRM's "contact not found" (a 404, or its `Contact with id … not found`) stamps `contacts.gone_at`, raises one alert per contact (`contact:gone:<id>`, warning) and parks the run to be looked at again at once; the premise `contact_exists` reads `gone_at` and exits it `moot: contact gone`, as it does every other run about them. A CRM record that comes back (or the person re-made under a new id with the same email/phone) clears `gone_at` and resumes as themselves. | `runner.ts:25` (replica read); `poll.ts:63-85` (no deletion path); `merged_into` written nowhere | `edge-cases.contacts.test.ts › a contact deleted in the CRM while a run is parked: the run exits moot…` |

Observed in passing, no test (rows below say `not yet`): the morning-of wait (`rm`, 8am the day of the call) comes
before the 1-hour and 10-minute waits in the pre-call chain, so a call before 8am their time sleeps on `rm` through
the call and exits moot — those two texts never go for early calls (a guard on `rm`, or moving `r1`/`r10` ahead of it,
would fix it); the order runs execute in one tick is the database's heap
order, not the due order (`runner.ts:57-59`: `update … where id in (select … order by next_run_at) returning *` does
not preserve the subquery's order), so two events landing in the same poll race; `{{contact.email}}` and
`{{contact.phone}}` are `limit 1` with no order (`context.ts:31-32`), so a contact with two emails renders either.

## Pre-call sequence

| Edge case | What should happen | Covered by |
|---|---|---|
| A booking starts the sequence; the day-one email and text go once; a second tick sends nothing again | One run, two sends, the ledger refuses a duplicate | `engine.integration.test.ts › a booked appointment starts the pre-call sequence; the booking email and text go once; it waits for the reply` |
| A booking at 23:00 for a 9am call | The booking email and text are receipts (`kind: transactional`) and go at 23:00 when the company lets transactional sends through dark hours (`quiet_allow_transactional`); the 4-hour reply wait runs from then (its call − 1h cap is 08:00, D58); no reply by 03:00 → ⏳ and `stat-unconfirmed`; the 3-day, 2-day and 24-hour reminders are stale and skipped at 08:00; the 1-hour text goes at 08:00 and the 10-minute text at 08:50 (F21, D62). With the flag off they wait for 08:00 like every other send | `journey.test.ts › booked at 23:00 for a 9am call (F21, fixed D62)` (three tests) |
| A reply arrives while the run is parked on the booking text | The poll wakes the run the same minute (`wake_on_reply`); classify → branch | `engine.integration.test.ts › reply → classify → branch → tag confirmed → on to the reminders…` |
| A reply in pieces ("yes" … "🙏") | After the newest piece the run waits `settle` (90 s); a further piece restarts the clock; the classifier reads both as one reply | same test (`settled`, `classified.at(-1)` is both pieces) |
| A reply during the settle window that cancels the first ("yes… actually no") | Both pieces go to the classifier together; the last word is read in context | `not yet` (the fake classifier answers by regex) |
| A reply after the reply wait ended (two days later: "can't make it") | `message.received` fires; a run parked on a timed reminder is not woken | `templates.scenarios.test.ts › an inbound text wakes a reply-wait but not a timed wait…` — and nothing acts on the reply: `it.todo` in `edge-cases.test.ts` |
| No reply in 4 hours | Timeout edge: `stat-unconfirmed`, the closers told in the booking thread, the reminders go on | `engine.integration.test.ts › wait_for_reply timeout: no reply by the deadline…` |
| An unclear reply (👎, "maybe") | Jev says unclear → the question in the attention channel (bookings when none is bound) addressed to the closer, with Jev's guesses, ✅ ❌ 🔁 offered, remembered as `decision:<appointment>`; `stat-needs-attention` on; the read noted on the appointment; the run does NOT wait: it goes on to the reminders and listens (D58) | `adapters/jev/classifier.test.ts › a confident answer that a careful person would still doubt is unclear`; `templates.scenarios.test.ts › D53/D58: an unclear reply asks the team…` |
| A reply Jev reads as a cancel ("cancel my appointment") | Nothing is cancelled: the same question, with "Jev is 95% sure they want to cancel."; the reminders go on. ❌ pulls the run off its reminder, cancels the call, reacts ❌ on the question, takes the tag off, scores Jev right (`intent.reviewed` with `predicted_confidence`, `agreed: true`); ✅ keeps it, scores Jev wrong and `resume` puts the run back on the same reminder, due as before (D55, D58) | `templates.scenarios.test.ts › D55/D58: a reply Jev reads as a cancel cancels nothing…`, `…a reply Jev reads as a reschedule…` |
| A reply Jev reads as a reschedule | No rebooking link goes out until a person taps 🔁; ✅ keeps the call, confirmed tags, Jev scored wrong, the run back on its reminder | `templates.scenarios.test.ts › D55/D58: a reply Jev reads as a reschedule sends no rebooking link on its own…` |
| A tap on another booking's question, or a stray emoji on this one | Nothing: the other run is not even woken; the stray wakes this run, which finds no decision and goes back to sleep on the same reminder, still listening | `templates.scenarios.test.ts › D53/D58: an unclear reply asks the team…` |
| Nobody taps by the call | The listener disarms at the call time (or when the run reaches its exit first), `stat-needs-attention` comes off, `intent.unanswered` is recorded with Jev's read, its confidence and the hours before the call; the pending read stays on the appointment; the reminders went on throughout | `templates.scenarios.test.ts › D58: nobody taps by the call…` |
| A no-show filed for a call whose cancel/reschedule read was never answered | Call outcome filed adds `stat-possible-cancel` ("we were pretty sure they cancelled and the slot was never opened") and records `intent.unanswered_no_show`; a plain no-show gets only `stat-no-show` | same test |
| The question cannot be posted (Slack unbound) | The listener is not armed (nothing to tap); the tag and the pending read still go on; the run goes on | `not yet` |
| The appointment is rescheduled while a reminder is parked | The poll wakes runs on that appointment; the wait recomputes from the new start (D20) | `funnel.e2e.test.ts › reschedule → same appointment moves, the sequence stays with it, nothing else fires` |
| The appointment is rescheduled after the sequence finished (the 10-minute text went, or it exited on a cancel / reschedule request) | A fresh run for the new time: `reentry_key` is the start time, so the booking email and text go again for the new time and the reminders follow (F4, D59) | `journey.test.ts › F4 (fixed, D59): a call rescheduled after its sequence ended gets a fresh pre-call sequence…` |
| A closer taps ❌ on a cancel Jev read | `update_appointment` cancels at the source and on our row and emits `appointment.status_changed` itself (the poll then sees no delta): Call cancelled and Cancellation rebook run as for a cancel at the source (F1, D59) | `journey.test.ts › F1 (fixed, D59): a cancel the prospect texted runs Call cancelled…` |
| The morning-of text for a call at 11am or later | Goes at 08:00 their time: the branch compares `{{appointment.starts_at \| date:HH}}` to 11 and a filtered reference is rendered before the compare (F10, D59) | `journey.test.ts › F10 (fixed, D59): a 2pm call gets the morning-of text at 8am…` |
| The appointment is cancelled while a reminder is parked | Premise `appointment_in_future` fails → `moot: appointment cancelled`, no send | `engine.integration.test.ts › premise check: a cancelled appointment exits the run instead of sending`; `funnel.e2e.test.ts › cancel → rebook sequence sends, the pre-call sequence exits as moot…` |
| The person books a second call (rebook as cancel + new booking) | The older run exits `superseded: a newer run for this person`; the new run carries on alone (D45) | `edge-cases.test.ts › D45: a second booking for the same person supersedes the pre-call run…` |
| A call booked three minutes out | Day-one email and text skipped as stale (`validity.min_lead`), nothing fails; the reply wait's `until` is already past so the run moves on: every reminder is stale but the 10-minute text, which goes (it has no validity rule), and the run completes | `edge-cases.test.ts › a call booked three minutes out…` |
| A call booked two hours out | The reply wait ends an hour before the call (`until`, D58); the run takes the timeout path (unconfirmed) and on to the reminders; the 1-hour and 10-minute texts still go | `edge-cases.test.ts › a call booked two hours out…` |
| A 10-minute reminder for a call that is already closer than that | `m10` has no validity: it sends with `relative` recomputed ("in about 5 minutes") | `not yet` |
| The 3-day text when the call is 2 days out | Skipped as stale; the 2-day one goes | `engine.integration.test.ts › reply → classify → branch…` (`3 days out` not sent) |
| A reminder that lands at 3am their time | `earliest`/`latest` move it to a human hour the same day; the send window defers forward | `waitrule.test.ts › earliest / latest: four hours before a 7am call is 8am, not 3am…`; `waitrule.test.ts › 2am → 8am same day` |
| Morning-of text for a call before 10am | Guard + fallback: the evening before | `waitrule.test.ts › …unless it's before 10am → evening before (the guard + fallback)` |
| A wait anchored on "now" must not slide on re-evaluation | The first answer is pinned in `vars.__wait.<node>.until` | `not yet` directly (scenarios fast-forward by moving the pin; the pin's own behaviour is not asserted) |
| DST changes between the booking and the reminder | Luxon computes `day_of@08:00` in the contact's zone on that day; 8am stays 8am | `not yet` |
| A contact with no timezone | Falls back to the company's zone | `not yet` (`context.ts` `timezone: contact.timezone ?? company.timezone`) |
| A contact with a garbage timezone string from the CRM | The company's zone, stored as `company_default`; nothing throws (G20, fixed by D60) | `edge-cases.contacts.test.ts › a contact whose CRM time zone is garbage takes the company's zone…` |
| The contact has no phone | The text is refused by the CRM, recorded `failed`; the run carries on to the reply wait and the emails (G1, D56) | `edge-cases.test.ts › the CRM refuses the text…` |
| The company has SMS off | Text steps are recorded `suppressed: sms_disabled`, the run continues | `templates.scenarios.test.ts › sms_enabled=false: SMS nodes are suppressed and the run continues` (on Speed to lead; same code path) |
| Placeholder copy still in place | Sends go out as `[placeholder — …]`; readiness warns, does not block (D51) | `engine.integration.test.ts › a booked appointment…` (asserts the placeholder bodies); `edge-cases.test.ts › placeholder copy at go-live time is a warning, not a blocker…` |
| A relative time rendered after the call ("in -30 minutes") | `relative` throws `StaleTemplateError`; `on_stale` decides; nothing stale ships | `template.test.ts › THROWS on a non-positive duration` |
| The workflow is turned off mid-sequence | The parked run exits `workflow turned off` at its next wake, nothing more goes out (G3, D56) | `edge-cases.test.ts › a workflow turned off while a run is parked…` |
| The template is upgraded mid-sequence | The run finishes on the version it started with; new bookings start on the new one | `edge-cases.test.ts › a template upgraded while a run is parked…` |
| The company moves from test to live while a run is parked | Go live clears every run not born live before flipping the flag | `golive.test.ts › refuses while a blocker stands, then clears shadow-born runs and goes live` |
| The booking is from Calendly, not the CRM | `update_appointment` (cancel on ❌) records "read-only" and moves on | `not yet` |

## Speed to lead

| Edge case | What should happen | Covered by |
|---|---|---|
| Lead created → email + text at once; a reply ends it `replied`; silence → one more email, `no_reply` | As described | `templates.scenarios.test.ts › speed-to-lead: email + SMS now; a reply → tag engaged; silence → second email` |
| The same lead fires twice (form resubmitted) | `once_per_contact`: the second start is refused | `not yet` (the New lead sibling is asserted; Speed to lead is not) |
| The lead books inside the two hours without replying | The check before the nudge reads `contact.has_upcoming_call`; the run exits `booked`, "Still want to talk?" never goes (F3, D59) | `journey.test.ts › F3 (fixed, D59): a lead who books inside speed-to-lead's 2 hours does not get 'Still want to talk?'` |
| 480 existing contacts at install | The first poll is a silent baseline: no `lead.created`, no 480 emails | `poll.baseline.test.ts › baseline: 3 existing contacts → replica rows, zero events` |
| A lead created at 2am | The email waits for the send window; a `transactional` one goes at once only when the company allows it | `templates.scenarios.test.ts › dark hours: a human-sounding send waits for the window…` |
| A lead with no phone | Email goes; the text is refused by the CRM and recorded `failed`; the run goes on (G1, D56) | `edge-cases.test.ts › the CRM refuses the text…` (on Pre-call; same code path) |
| A lead the poll sees but who is not a test contact, in test mode | The run starts and goes all the way through as in shadow: card and tag recorded as would-have, email and text recorded `shadow`, nothing reaches the CRM or the sender (D52 addendum 2) | `mode.test.ts › test: everyone's run starts, born in test; the tagged and the test-domain contact get it for real, the real contact gets it as in shadow` |
| In shadow | Sends recorded `shadow`, nothing delivered, the run parks for a reply as live would | `templates.scenarios.test.ts › shadow mode: the run completes, messages are recorded as would-send, nothing reaches the CRM` |
| The contact is merged (duplicate cleaned up in the CRM) mid-sequence | Premise `contact_exists` (merged_into is null) exits the run | `not yet` |
| The reply comes by email when the text asked for a text | `channel: any` on this wait: either counts | `not yet` |

## No-show recovery

| Edge case | What should happen | Covered by |
|---|---|---|
| The CRM marks no-show → 10 minutes → text + email → 24h for a reply → one more email | As described | `templates.scenarios.test.ts › no-show-recovery: GHL no-show → 10 min → SMS + email → 24h for a reply → second email` |
| The closer's form marks no-show (disposition) | Same workflow, second trigger; once per appointment | `engine.integration.test.ts › disposition: showed + follow_up emits call.held…; noshow starts no-show recovery once` |
| The CRM marks no-show and the closer files no-show too | One run, not two (`once_per_appointment`); the second trigger is remembered and dropped when the run completes | same test (`r3.runs` for recovery stays one) |
| The closer corrects a no-show to showed after the texts started | The texts already in flight should stop. **Today:** nothing stops them (premise is `appointment_exists`) | `not yet` |
| The no-show is marked three days late | "sorry we missed each other" is outside `after_event max_lag 3d`: skipped as stale | `not yet` |
| The appointment is deleted at the source after the no-show | Premise: `appointment deleted at the booking source` → exit | `not yet` |
| A reply during the 24-hour wait | Woken, exits `replied`; no second email | covered by the first row's test only for the timeout edge; the reply edge: `not yet` |
| The person books a new call during the recovery | The check before each send reads `contact.has_upcoming_call` (a live closing call other than the no-show's own): the run exits `rebooked`, nothing more is sent; Call booked runs for the new one. `stat-no-show` comes off with the new booking (F9, D62) | `journey.test.ts › F8 (fixed, D59): a new booking ends the no-show recovery…`; `journey.test.ts › F8 / F9 (fixed, D62): stat-no-show comes off on the new booking…` |

## Cancellation rebook

| Edge case | What should happen | Covered by |
|---|---|---|
| The CRM marks cancelled → text + email with the rebook link, once per appointment | As described; the premise (`appointment_exists`) must not read "cancelled" as moot | `templates.scenarios.test.ts › cancellation-rebook: GHL status → cancelled starts it; sends both, exits` |
| A Calendly reschedule (old cancelled + new event linked) | Never fires: the source links the pair and the engine treats it as a move | `poll.calendly.test.ts › a reschedule (old cancelled + new event linked) moves the appointment and fires rescheduled, never cancelled` |
| A GHL reschedule done as cancel + new booking | Should not text "pick a new time" to someone who just did. **Today:** G6 | `edge-cases.test.ts › a person rebooks and the old call is then cancelled…` (`it.fails`) |
| Cancelled at 11pm | The text waits for the send window | `waitrule.test.ts › 9pm → 8am tomorrow, never backward` (the rule); the step: `not yet` |
| Cancelled by the closer, not the invitee | Still texts the prospect a rebook link; the template does not read `cancelled_by` | `not yet` |

## Post-call follow-up

| Edge case | What should happen | Covered by |
|---|---|---|
| A follow-up disposition → text at 9am the next morning, contact time | As described | `templates.scenarios.test.ts › post-call-follow-up: a follow_up disposition schedules the SMS for 9am the next morning, contact time` |
| The closer files follow-up twice (refiles the day) | Once per appointment: one run | `not yet` (`it.todo` on refiling in `edge-cases.test.ts`) |
| The follow-up is filed at 11pm | `day_after@09:00` is still the next morning, not the same day | `not yet` |
| The person books a new call before 9am | The text still goes; nothing checks the calendar | `not yet` |

## Call outcome filed

| Edge case | What should happen | Covered by |
|---|---|---|
| The closer files one no-show and one showed follow-up | One run per call: 👻 + `stat-no-show`; ✅ + `stat-showed` + `stat-follow-up`, each in its own booking post's thread | `eod.test.ts › call outcome filed (D54): filing one no-show and one showed follow-up starts one Call outcome run per call…` |
| The CRM marks a no-show (no form) | Straight to the 👻 via `appointment.status_changed` | same test (Theo) |
| The engine's own showed (a recording landed) | Does not start it: `event._source` must be `disposition` | same test (the last assertion) |
| The recording's ✅ is already on the booking post when the closer files showed | Slack answers `already_reacted`; the engine reads that as done, no second ✅ | `adapters/slack/notifier.ts:22` reads it; `not yet` as a test |
| The closer refiles with a corrected outcome | Reentry `always`: it reacts again (a correction must be able to) | `engine.integration.test.ts › disposition…` asserts the second start (`r3.runs` is 1) |
| No booking post exists (booked before the engine, or the channel unbound) | `thread_only`: the post is skipped with that reason, the tag still goes on | `not yet` |
| Rescheduled filed as the outcome | Exit `nothing_to_mark`: Call booked already reacted 🔁 | `not yet` |
| A deposit filed | `stat-closed-won` (closed or deposit) | `not yet` |
| A no-show for a call whose reply Jev read as a cancel or a reschedule and nobody answered (D58) | `stat-possible-cancel` on top of `stat-no-show`, and `intent.unanswered_no_show` with the read, its confidence and when it was asked; a no-show with no pending read gets neither | `templates.scenarios.test.ts › D58: nobody taps by the call…` |
| The Sales Call record | Updated when the contact has one, keyed by the appointment: `outcome` showed or noshow, and for a show the closer's answer as the CRM's disposition (closed/deposit → closed_won, follow_up, lost, unqualified → dq) through the `oneof:` guard (F7, D59) | `journey.test.ts › F7 (fixed, D59): the Sales Call record says showed / follow_up…`; `› end of day, the closer files 'showed, closed'…` |
| The outcome is filed for a call booked before the engine (no Sales Call record for the contact) | The record step is skipped (`only_if` there is one); the tags and the thread line still go | `not yet` |
| A filed no-show (D61) | Setter card → No-Show / Cancel / Reschedule, status lost (won on a show, lost on a no-show); closer card → No Show / Cancelled, open; the next booking moves the closer card back and makes a fresh setter card (the lost one is the last cycle's loss) | `templates.scenarios.test.ts › D61: the filed outcome moves the cards…`; `journey.test.ts › a no-show who rebooks a week later › the no-show…` and `› they book again…` |
| A filed showed / follow-up (D61) | Setter card → Showed, won; closer card → Follow Up | same scenario; `journey.test.ts › F2 (fixed, D61)…`, `› F6 (fixed, D61): a filed follow-up…` |
| A filed showed / lost or disqualified (D61) | Setter card → Showed, won; closer card → Lost or Disqualified, status lost | same scenario (DQ); the Lost move: `journey.test.ts › D61: the closer drags Pat's card to Lost…` (k3 after the hand move) |
| A filed showed / closed or deposit (D61) | Setter card → Showed, won (a no-op when the recording already moved it); the closer card is left to Payment recorded (Agreement Sent) and Deal closed (Closed - Won) | `journey.test.ts › end of day, the closer files 'showed, closed'…` (no card write) |
| The same outcome filed twice, or filed after the CRM marked the no-show | The card steps write nothing: the closer step reads `already there`, the setter step finds no open card (it is lost) | `templates.scenarios.test.ts › D61: the filed outcome moves the cards…` (the second no-show) |
| The contact has no card on a board (booked before the engine) | The card step skips (`if_missing: skip`); nothing is created here — booking makes cards | `eod.test.ts › call outcome filed (D54)…` (contacts with no cards; the runs complete) |

## Payment failed

| Edge case | What should happen | Covered by |
|---|---|---|
| A declined card | Nothing to the client; one post in the payments channel @mentioning the closer | `templates.scenarios.test.ts › payment-failed: nothing to the client; one Slack post tagging the closer (suppressed cleanly when Slack is not connected)` |
| A failed charge then a success | The failure never counts toward the total; the success derives its kind from succeeded rows only | `payments.test.ts › derives the kind from the ledger, never from the provider` (`failed`); the sequence: `not yet` |
| The same failure delivered twice | Duplicate on `(provider, payment id)`: no second post | `payments.test.ts › the same provider payment id twice is a duplicate…` (ledger); the post: `not yet` |
| The payer is nobody we know | `payment.unlinked`: a team alert, a row on the Payments page; no workflow | `payments.test.ts › an email nobody has → unlinked, with a contact-less event, visible on the unlinked list` |
| No closer on the contact | The post renders "unknown"/no mention and still goes | `not yet` |

## Reactivation

| Edge case | What should happen | Covered by |
|---|---|---|
| Tag `reactivate` added → email, 3 days, text, 4 days, last email | As described | `templates.scenarios.test.ts › reactivation: tag starts the sequence; a second tag inside 90 days is blocked` |
| The tag added again inside 90 days | Blocked (sliding window) | same test |
| A different tag added | Nothing starts (`match` on the tag) | same test |
| The tag added, removed, added again inside the window | Still blocked: the window is per contact, not per tag event | `not yet` |
| The person books a call mid-sequence | The sequence keeps going; nothing stops it | `not yet` |
| The contact is merged mid-sequence | Premise `contact_exists` exits | `not yet` |

## New lead

| Edge case | What should happen | Covered by |
|---|---|---|
| A lead with a phone → setter card "Name -- New" + `stat-new`; without a phone → waits a day for one, then exits `no_phone` (D39) | As described | `templates.scenarios.test.ts › new-lead: a lead with a phone gets a setter-pipeline card … without a phone, the run exits no_phone` |
| The same lead fires again | The one card is moved, not duplicated | same test (`["create", "update"]`) |
| The CRM already holds a setter card (made by a GHL workflow) | Adopted and moved, never duplicated (D41) | `templates.scenarios.test.ts › D41: a setter card the CRM already holds … is adopted and moved, never duplicated` |
| The CRM cannot be read when the card step runs | The step fails rather than guessing and creating a duplicate | `not yet` |
| A card in a pipeline we have no binding for | Ignored by `pickCard` (filtered by pipeline id); nothing moved | `not yet` |
| A closed/won card on the setter board | Not adopted (history, not state) | `not yet` |
| A lead with no CRM id yet (Calendly booking before the CRM poll) | The card step fails `contact has no CRM id yet`; the CRM poll attaches the id later | `poll.calendly.test.ts › when the CRM poll later delivers the same person, the replica gains the GHL id…` (identity); the step: `not yet` |
| In shadow | The card and the tag are recorded as would-have, nothing in the CRM | `templates.scenarios.test.ts › shadow mode…` |

## Call booked

| Edge case | What should happen | Covered by |
|---|---|---|
| Self-booked closing call | Closer card at Scheduled, setter card made/moved to Direct, tags on/off, date + owner on the contact, Slack card (skipped when unbound) | `templates.scenarios.test.ts › call-booked, self-booked: …` |
| Setter-booked | Setter card → Set, closer card "-- Setter Booked", setter stamped | `templates.scenarios.test.ts › call-booked, setter booked: …` |
| A setter card the CRM already has | Adopted and moved | `templates.scenarios.test.ts › D41: …` |
| A reschedule | Second trigger; the task is not re-created; the booking post gets a 🔁 reply instead of a new card | `funnel.e2e.test.ts › reschedule → same appointment moves…` (one appointment); the `only_if` steps: `not yet` |
| Two closing calls booked for one person in one poll | Both runs complete: `always` runs are never superseded (G4, D56) | `edge-cases.test.ts › two payments for one person in the same minute…` (same rule) |
| A booking from a calendar not mapped to a call type | `applyAppointment` returns early: no appointment row, no event | `not yet` |
| A booking with no phone (Calendly) | The run does not send texts; the card and tags still happen | `not yet` |
| A booking by someone the CRM has not sent us yet | A local contact by identity; the CRM id attaches later | `poll.calendly.test.ts › a booking by someone the CRM has not sent us yet…` |
| A booking with no usable identity | Skipped, no contact invented | `poll.calendly.test.ts › a booking with no usable identity is skipped rather than inventing a contact` |
| The pipeline bindings are missing | The first card step fails; readiness blocks turning the workflow on | `engine.integration.test.ts › a booked appointment…` (`r1.failed` is 1); `install.ts:205` refuses to enable |
| Slack connected but the bookings channel unbound | The post is recorded `suppressed: slack channel not bound`, the run completes | `templates.scenarios.test.ts › call-booked, self-booked…` |
| The booking's setter name is not on the roster | `contact.setter.mention` is the typed name | `not yet` |
| A test-harness booking (`source='test'`) | Premise `appointment_exists` holds on our row alone | `templates.scenarios.test.ts › test harness: sys-test create → book → cancel → reset…` |

## Call cancelled

| Edge case | What should happen | Covered by |
|---|---|---|
| A real cancel | Both cards → Cancelled, date cleared, rebook task with who and why, tags swapped, Slack note | `templates.scenarios.test.ts › call-cancelled: a real cancel moves both cards…` |
| A Calendly reschedule | Never fires | `poll.calendly.test.ts › a reschedule … never cancelled` |
| The person rebooked before the cancel arrived | Cards should stay at Scheduled. **Today:** G6 | `edge-cases.test.ts › a person rebooks and the old call is then cancelled…` (`it.fails`) |
| No cards exist (booked before the engine) | A card step with a stage makes one at Cancelled (D41) | `not yet` |
| Cancelled twice (two polls) | Once per appointment | `not yet` |
| Cancelled and no-showed on the same appointment | Two workflows, two events; both run | `not yet` |

## Payment recorded

| Edge case | What should happen | Covered by |
|---|---|---|
| A deposit | Cash collected = running total, revenue stamped once, `pay-plan-active`, Payment record linked to contact and closer card, agreement sent on a first payment with no signature | `templates.scenarios.test.ts › payment-recorded: a deposit stamps cash collected + revenue generated…` |
| The balance | `pay-paid-full` on, `pay-plan-active` off, revenue not stamped twice | same test |
| A payment for a contact with no closer card | Record written without the card relation; the booking/recording thread replies skipped (`thread_only`) | `templates.scenarios.test.ts › payment-recorded: a payment is written to the CRM side only…` |
| A payment for a contact with no recording or no booking post, calls / bookings channel bound | The thread line skips ("no post to reply to"); the run goes on to its exit. **Was:** the unknown path failed the run at that step (fixed with D57: `default:` on both thread targets) | `edge-cases.test.ts › a refund (G10, fixed by D57)…` (the edges company binds the calls channel) |
| The same payment delivered twice | Duplicate: nothing new, nothing started | `templates.scenarios.test.ts › a redelivered payment webhook records nothing new and starts nothing` |
| The 💵 / 💸 thread lines | "💵 Paid $1,500 · deposit." / "💸 Refunded $500 · refund." (F13, D59) | `journey.test.ts › the deposit…`; `templates.scenarios.test.ts › payment-recorded (D57): a refund…` |
| Paid in full | `payment.paid_in_full` (and `opportunity.won` on the first payment) is dispatched, so a template may listen (F11, D59); none does yet (F12) | `journey.test.ts › paid in full: …nothing listens to it` |
| Two payments in one minute | Both recorded (G4, D56) | `edge-cases.test.ts › two payments for one person in the same minute…` |
| A payment before the contact exists | Unlinked + alert; a later payment from the same buyer heals it; a person can link it by hand | `payments.test.ts › a stranger's payment is unlinked; a later payment that resolves the same member heals it`; `payments.test.ts › a person links an orphan by hand…` |
| The contact arrives through the CRM poll after the orphan payment | Stays unlinked until a later payment or a hand link (D21: nothing is guessed) | `not yet` |
| A refund | A new line with a minus sign (D57): cash collected = the lower running total, a second Payment record with the negative amount, `type` refund and `status` refunded, `pay-refunded` on; `pay-paid-full` / `pay-plan-active` untouched; revenue not re-stamped, no agreement sent; Slack `*Refund:* −$X`, 💸 thread lines | `payments.test.ts › a refund is a negative row that lowers the running total`; `templates.scenarios.test.ts › payment-recorded (D57): a refund is a new line with a minus sign…`; `edge-cases.test.ts › a refund (G10, fixed by D57)…` |
| A refund of the whole deal | Running total 0, `pay-paid-full` still on (a refund is not a payment plan; the tag says what was paid, `pay-refunded` says what came back) | `not yet` |
| A failed charge then a success | The success is a deposit (failed rows do not count) | `payments.test.ts › derives the kind…`; the pair: `not yet` |
| Over by a rounding cent | Still clears | `payments.test.ts › derives the kind…` |
| No contract value anywhere | Nothing can clear; every payment is a deposit/installment | `payments.test.ts › derives the kind…` (`null`) |
| The payer matched by phone with formatting | Last ten digits | `payments.test.ts › phone matches on the last ten digits` |
| The payer's email changed at the provider | The member id links it | `payments.test.ts › the member id links the next payment even when the email changed…` |
| A payment while the agreement is already signed | No agreement sent; `a0` else-branch | `templates.scenarios.test.ts › agreements (D30)…` (Leo's second payment sends nothing) |
| In shadow | Record, tags, fields recorded as would-have | `not yet` for this template (`shadow mode…` covers the same node types on New lead / Speed to lead) |

## Sales call recorded

| Edge case | What should happen | Covered by |
|---|---|---|
| A recording matched by invitee email with an appointment | Jev: sales call + disposition; one AI read for notes + rubric; showed recorded (`call.held`), `stat-showed`, setter card Showed + won, Sales Call record updated, note, Slack | `templates.scenarios.test.ts › call-recorded: a Fathom recording matched by invitee email → …` |
| An internal meeting | Stops at the check: nothing written | same test |
| A recording with no matching appointment | Linked to the person, keyed by the recording, nothing marked showed, the Slack line says so | `templates.scenarios.test.ts › call-recorded, unmatched: a stranger's recording is unlinked…` |
| A stranger's recording | Unlinked with a reason; linking by hand starts the workflow and remembers the email | same test |
| The same recording delivered twice | Duplicate: nothing new | same test; `recordings.test.ts › records once: …` |
| Two recordings of one call | Both link to the appointment; both run (`always`, G4 fixed in D56): showed is recorded twice (idempotent on the row) and two review posts go | `not yet` (G4 shown on payments) |
| Two different contacts on one recording | Ambiguous, not a guess: unlinked | `recordings.test.ts › two different contacts on one recording is ambiguous, not a guess; all-staff is named as such` |
| Two contacts with the same name | Name alone never picks one | `recordings.test.ts › name matches only when exactly one contact has it` |
| The closer's own recording with a guest email | The closer's calendar resolves the person when one appointment is near | `recordings.test.ts › the closer's calendar: one appointment within two hours…` |
| The closer not on the roster | Still staff (`recordedBy`) | `recordings.test.ts › the closer is staff even when the roster did not list them…` |
| No AI key | `analyze` fails the run unless `optional`; readiness/health warn | `slack.post.test.ts › without the AI key the optional cheer is skipped…` (optional); the required case: `not yet` |
| Jev unsure of the kind | `unclear` → the sales-call check fails → `not_a_sales_call` | `adapters/jev/classifier.test.ts › below the threshold, outside the options, a failed call, or no key: unclear`; the exit: `not yet` |
| The disposition is a value the CRM's picklist does not have | `oneof:` leaves it blank rather than writing what the CRM would drop | `not yet` |
| Slack refuses the token at the review post | The post is recorded `failed`; the Sales Call record is still written (G8, D56) | `edge-cases.test.ts › Slack refuses the bot token in the middle of Sales call recorded…` |
| The transcript is empty | `analyze`: "nothing to analyze" skip; Jev gets an empty input | `not yet` |

## Setter call logged

| Edge case | What should happen | Covered by |
|---|---|---|
| A connected call with a transcript, 15 minutes after it ended → setting call, digest, Discovery Call record, note, Slack | As described | `templates.scenarios.test.ts › setter-call-logged: a connected dialer call with a transcript → …` |
| Under 60 seconds / no transcript / "where are you" | Each stops at its check; the AI is never called | same test |
| A call that just ended | Waits 15 minutes from the end, so the booking the setter makes after hanging up is seen | same test |
| A no-answer | Never starts (trigger wants connected) | same test |
| A connected call whose transcript lands later | Pending until the transcript or 30 minutes | `poll.calls.test.ts › a connected call waits for its transcript; a missed call settles at once; neither is a reply`; `poll.calls.test.ts › a connected call nobody recorded settles without a transcript once the wait runs out` |
| A call to a lead the contacts poll has not seen | The contact is fetched first | `poll.calls.test.ts › a call to a lead the contacts poll has not seen yet pulls the contact first` |
| Calls before install | Baseline: kept, silent | `poll.calls.test.ts › baseline keeps the calls it finds and says nothing` |
| Two calls to one lead in one poll | Both runs complete (`always`, G4 fixed in D56) | `not yet` (G4 shown on payments) |
| The booking made after the call is read live at the wait's end | `led_to_booking` is a live read | `templates.scenarios.test.ts › setter-call-logged…` (`["yes"]`) |

## Send agreement manually

| Edge case | What should happen | Covered by |
|---|---|---|
| The tag on an unsigned contact | Document sent, `stat-agreement-sent`, trigger tag removed, note | `templates.scenarios.test.ts › agreements (D30): …; the manual tag sends the agreement` |
| The tag on a signed contact | Exit `already_signed`, the tag still comes off? **Today:** the exit is before the tags step, so the trigger tag stays on | `not yet` |
| The tag added twice quickly | `always`: two runs; the second finds it unsigned too and sends twice | `not yet` |
| No agreement template bound | `send_document` fails: `template rendered empty` | `not yet` |
| The contact has no CRM id | Fails `contact has no CRM id yet` | `not yet` |

## Agreement signed

| Edge case | What should happen | Covered by |
|---|---|---|
| The documents poll sees the first completion | `agreement.signed` exactly once; tag, note, Slack | `poll.agreements.test.ts › baseline mirrors what exists and says nothing; a new document is 'sent'; its completion is 'signed' exactly once`; `templates.scenarios.test.ts › agreements (D30)…` |
| The engine sent the document itself | The poll's first sight is not a second `agreement.sent` | `poll.agreements.test.ts › …` (sent_by engine) — the recognition: `not yet` directly |
| A document with no primary signer we know | No event (needs a contact) | `not yet` |
| Signed before the first payment | Deal closed waits at its gate for the payment (D30) | `templates.scenarios.test.ts › deal-closed race…` |

## Deal closed

| Edge case | What should happen | Covered by |
|---|---|---|
| Payment first, signature later (and the reverse) | The gate stops the first and releases the once; the second closes | `templates.scenarios.test.ts › agreements (D30)…` |
| Payment and signature in the same minute | The loser is remembered on the in-flight run and replayed after the gate | `templates.scenarios.test.ts › deal-closed race: two triggers in the same minute…` |
| Already a customer (`stat-customer`) | The gate stops it | `not yet` directly (the predicate is in the template) |
| Welcome text with SMS off | Recorded `sms_disabled`, the email goes | `templates.scenarios.test.ts › agreements (D30)…` |
| No Sales Call record for this person | The else edge skips the record step | `not yet` |
| The AI cheer unavailable | `optional`: skipped, the post goes without the line | `slack.post.test.ts › without the AI key the optional cheer is skipped…` |
| The setter card is already won | `pipeline_card` without a stage: marks the open card; none open → noop | `not yet` |

## Unsigned agreement chase

| Edge case | What should happen | Covered by |
|---|---|---|
| First payment, unsigned 24h later | Owner nudged (DM, else alerts channel), CRM task; three nudges at most; then a tag and one alerts post | `templates.scenarios.test.ts › agreements (D30): the chase nudges the owner after 24h with a task…` |
| Signed between nudges | The next check exits `signed`, no further nudge | same test |
| A second payment before the chase ends | `once_per_contact`: no second chase | `not yet` |
| The owner is not in Slack and no alerts channel is bound | Recorded `unbound`, the task still made | `not yet` |
| A refund brings the total to zero, then a new first payment | `prior_total == 0` matches again; the old key blocks a second run for this contact | `not yet` |

## End-of-day reminder

| Edge case | What should happen | Covered by |
|---|---|---|
| At the evening time, each closer with calls and no report gets one DM with the standing link, once; staff never do; the morning trigger asks for earlier unfiled days | As described | `eod.test.ts › the reminder is a workflow: at its evening time, each closer with calls and no filed report gets one DM…` |
| The closer has no Slack account found by email | `{{user.slack_user_id}}` empty → the DM is recorded `suppressed: slack channel not bound` | `not yet` |
| A tick late by an hour | The period still runs once; a day the engine was down is not made up | `reports.test.ts › a schedule trigger is due after its time on its day, once per date…` |
| Two closers, one filed | Only the other is reminded | `not yet` (one closer in the test) |
| A closer with calls only on a cancelled booking | Not counted (`status not in cancelled, invalid`) | `not yet` |
| Timezone: the company's 18:00, not UTC | `periodOf` in the company zone | `eod.test.ts › the reminder…` (Phoenix) |

## End-of-day report filed

| Edge case | What should happen | Covered by |
|---|---|---|
| Filing: required answers, outcomes through the disposition path, the summary with corrections, a ✅ under the reminder | As described | `eod.test.ts › filing: required answers checked, outcomes recorded through the disposition path; …` |
| A required answer blank | Refused with the names | same test |
| The form opened at 9am vs 11pm | A call whose time has passed with no recording, outcome or money is presumed no-show on the form only; nothing marked | `eod.test.ts › presumed no-show (D54): …` |
| The closer files twice | Upsert; `refiled: true` on the event; Call outcome reacts again by design. **Today:** the summary never says it is a refiling (`eod-filed.json` ignores `event.refiled`) | `it.todo` in `edge-cases.test.ts` |
| A call moved to tomorrow after the form opened | The answer for a call that is no longer today's should be refused or flagged. **Today:** recorded anyway, `diffAnswers` skips it silently (`eod.ts:112`) | `it.todo` |
| A call cancelled after the form opened | Same shape as the row above | `not yet` |
| The reminder DM was never posted (Slack off that evening) | The ✅ reply has no parent: posts to the DM channel and says so | `not yet` |
| Filing for a day the reminder never asked about | Works: the token is standing | `not yet` |
| A deposit filed with cash above the contract | Accepted as typed; totals follow | `not yet` |

## Health check

| Edge case | What should happen | Covered by |
|---|---|---|
| A calendar with no slots, a stage that no longer exists | Alerts raised once, cleared in the thread on the next clean sweep | `alerts.test.ts › the sweep: a calendar with no free slots and a stage that no longer exists become alerts…` |
| A person the CRM holds twice | The `duplicates` check: one finding and one alert per person, cleared when the CRM merge lands (D63); see Contacts › "Two CRM records for one person" | `health.duplicates.test.ts` |
| Raise/resolve twice | Idempotent per open key | `alerts.test.ts › raise/resolve are idempotent per open key` |
| The CRM token rotated | The location probe fails → an alert; the poll's failures count too | `alerts.test.ts › polling that fails twice in a row is an alert…` |
| Slack disconnected | Every post suppressed, alerts fall back to email/webhook if bound | `not yet` |

## Calendar availability

| Edge case | What should happen | Covered by |
|---|---|---|
| Hourly, and on every booking change | Bookable slots per active calendar; under the minimum is a warning with the day-by-day | `engine.integration.test.ts › a booked appointment…` (the watch run completes); the warning: `alerts.test.ts › the sweep…` |
| In a run about a booking | Only that booking's calendar is read | `not yet` |

## Wrap-ups

| Edge case | What should happen | Covered by |
|---|---|---|
| Daily at 19:00 once; weekly Monday; monthly on the 1st | As described; "to date" when started by hand | `reports.test.ts › builds the daily wrap-up; the wrap-ups workflow fires it at 7pm once per day…`; `reports.test.ts › daily = today; weekly = last Mon–Sun, or this week so far; …` |
| Harness rows in the numbers | Excluded | `reports.test.ts › counts leads, dials, … harness rows excluded…` |
| Zero of zero | Renders "—" | `reports.test.ts › renders rates with their denominators and '—' for zero-of-zero` |
| The reports channel unbound | The post is recorded suppressed | `reports.test.ts › builds the daily wrap-up…` |

## Booking decided in Slack (retired, D53)

The workflow is gone: the question is answered inside the pre-call sequence (`wait_for_reaction`; since D58 a listener the run carries while the reminders go on). The cases below still apply, to that step.

| Edge case | What should happen | Covered by |
|---|---|---|
| ✅ on the question | `stat-confirmed`, ✅ on the booking post and on the question, the bot's ✅ ❌ 🔁 taken off the question, the run back on its reminder | `edge-cases.test.ts › the Slack door: … one real tap pulls the listening run off its reminder…` |
| ❌ on the question | The appointment is cancelled, ❌ and "Decided by" in the thread (Call cancelled does the rest) | `templates.scenarios.test.ts › D55: a reply Jev reads as a cancel cancels nothing…` |
| A reaction from the bot itself | Ignored | `edge-cases.test.ts › the Slack door: …` |
| A reaction on a message the engine does not remember | Ignored | same test |
| A reaction removed | Ignored | same test |
| Slack redelivers the event | `duplicate_delivery`, one event | same test |
| A forged or stale signature | 401 | same test; `webhooks/slack.test.ts › accepts Slack's signature inside the window and refuses a forged or stale one` |
| The signing secret not bound yet | The URL check is answered; every real event is 401 | `not yet` |
| The event's source is not in the schema's list | Accepted (G5, fixed in D53) | `edge-cases.test.ts › the Slack door's event source is one the events table accepts…` |
| A tap by someone not on the roster | "a team member" in the thread | `not yet` |
| A tap on a question whose appointment was already cancelled | `update_appointment` on a cancelled booking; should be a no-op | `not yet` |

## Engine-wide

| Edge case | What should happen | Covered by |
|---|---|---|
| Every send is idempotent per run + step | The ledger refuses a duplicate (a row that is queued, sent, suppressed or shadow); a row the vendor refused (`failed`) is reclaimed by the retry so the text goes out once (D66) | `engine.integration.test.ts › reply → classify…` (unique keys); `engine.integration.test.ts › a booked appointment…` (second tick sends nothing); `retry.test.ts › a text the CRM could not take…` (reclaim, and the refusal of a second text) |
| A step fails (a vendor error, a dead token, a refusal, its own config) | Classified once in `failures.ts` (D66): **transient** (network, timeout, 408/425/429/5xx, a database connection) → the same step is retried in place at 1, 5, 15 and 60 minutes, the run `waiting` on that node with its wake flags, nothing else moves; after the last try it pauses. **auth** (401/403) → paused at once. **permanent** (400/404/422, "not found" / "invalid", an unbound binding, a term that does not exist) → paused at once. **unknown** → one retry, then permanent. The ledger rows already written stay; a create claim the vendor answered with an error is released | `retry.test.ts › a 503 on a tag step…`; `retry.test.ts › after the last scheduled try…`; `retry.test.ts › a 401…`; `retry.test.ts › a 400 on a card create…`; `engine.integration.test.ts › a booked appointment…` (call-booked pauses on its unbound binding) |
| A paused run waits for a person | One `run:<id>:paused` alert with the step, the contact, the error and the Open link; the run page offers **Retry this step** (a fresh set of tries, due now) and **Skip this step** (a `skipped by <who>` row, on along the step's plain edge; a question or a gate has none and can only be retried); either closes the alert. `failed` is only the engine's own fault (no way on, a node the pinned version lacks, an exception in the runner) and takes the same two buttons. The company and workflow pages count both as "needs a hand" (D66) | `retry.test.ts › after the last scheduled try…` (Retry); `retry.test.ts › a 400…` (Skip); `retry.test.ts › an engine bug…` |
| A dead token (401/403) | The run pauses at once; one `auth:<vendor>` alert per company however many runs reach it (twenty runs stopped by one token are one message); a new token saved in settings or carried by a re-install wakes every run paused on that vendor for one more try of its step and closes the alert; the same token saved again wakes nothing; a token that is still wrong re-raises it (D66) | `retry.test.ts › a 401…`; `alerts.test.ts › a dead token pauses the run…` |
| A crash between the vendor call and our bookkeeping | The create ledger `step_effects`: a note, a task, a document, a card and a record claim a row before the vendor is called and mark it done with the vendor's id after. A retry that finds a done claim reuses the id (a record becomes an update, a card is not made twice); one that finds a pending claim (the vendor never answered) does not ask twice and says so as a blocked step; a card step lets the CRM read (D41) decide, since the CRM is the truth about cards. Tags, contact and appointment updates are idempotent by nature; sends and Slack posts have the sends key; `classify` / `analyze` are reads and retry freely. The engine never charges anyone: payments are facts Whop reports (D66) | `retry.test.ts › a crash between the vendor call and the bookkeeping on a note step…`; `retry.test.ts › a 400 on a card create…` (the released claim, the done claim) |
| A 404 from a write to the contact (a tag, a note, a task, a contact update, a send) | The person is gone from the CRM: `gone_at`, one `contact:gone:<id>` alert, the run looked at again at once so the premise exits it `moot: contact gone` (G21's path); a 404 on a card or a record is that card or record and pauses the run with the CRM's words (D66) | `step-failures.test.ts › 404 on a tag write…`; `step-failures.test.ts › the card was deleted in the CRM between the read and the write…`; `step-failures.test.ts › the record our row points at was deleted…` |
| A contact with no CRM id yet reaches a send or a CRM write | Paused with "contact has no CRM id yet"; the CRM is never asked about contact `undefined`, nobody is stamped gone (F2, D66) | `step-failures.test.ts › a contact with no CRM id yet is not a contact the CRM has lost…`; `step-failures.test.ts › a contact with no CRM id yet: a tag step pauses…` |
| The CRM cannot be read for the contact's cards at claim time | `cards.*` is the replica's last word for the steps that only read it; the first card step that tick fails on that read (retried in place) instead of asking a CRM that just said no; a run resuming on a card step reads once, in the step (F4, D66) | `step-failures.test.ts › the CRM cannot be read for the contact's cards (503)…` |
| A hand moved the card while the card step was between tries | The retried step re-reads live and, finding a `card.moved` by the CRM since its first try, skips with "moved by hand since; a hand wins" (D61, D66) | `not yet` |
| `update_appointment` dies between our row and its event | One `appointment.status_changed` per (run, step, appointment, status): a retry after the crash emits the event once, a retry after the emit emits nothing (C6, D66) | `not yet` |
| Jev refuses the key or is down | A 401/403 and a 429/5xx from Jev throw (`VendorError`) and take the policy (paused / retried in place), never read as a vague reply; any other refusal and an unsure answer stay `unclear` for a human (F3, D66). An empty input is a noop and Jev is not asked | `step-failures.test.ts › Jev is down (5xx) or refuses the key (401)…`; `classifier.test.ts › a dead key or an outage is an error…`; `step-failures.test.ts › an empty transcript / reply…` |
| A tick killed mid-flight | The lease expires in 5 minutes and another tick takes over | `lock.test.ts › an expired lease (tick killed mid-flight) is taken over`; `lock.test.ts › second acquirer is refused while the lease is held…` |
| Two ticks at once | One runs, the other reports busy | `lock.test.ts › withTickLock reports busy instead of running twice…` |
| A closer drags a card to another stage in the CRM between ticks (D61) | The `cards` poll diffs the bound boards against `pipeline_cards`: `card.moved` {pipeline, from/to stage and name, from/to status, by: crm, mover} on the contact, the replica follows, "🗂️ <who> moved the closer card to <stage>" under the booking post; a second look is not a second move | `journey.test.ts › D61: the closer drags Pat's card to Lost in the CRM between ticks…` |
| The hand move is into the closer board's No Show / Cancelled, Lost or Disqualified, and the call time has passed | The outcome is filed on the appointment through `recordDisposition` (no-show; showed + lost; showed + unqualified), so Call outcome filed tags it and the Sales Call record says so; the card steps read `already there` and only the status is written (lost) | same test |
| The hand move is into the setter board's No-Show / Cancel / Reschedule, status left open, call time passed | The no-show is filed; the handler writes no status (the replica keeps what the CRM returned); Call outcome filed's gn1 then marks the still-open setter card lost (the owner's rule) and gn2 moves the closer card; a status the closer set by hand (won, lost, abandoned) is never changed, because the card step only picks open cards | `journey.test.ts › D61: a setter drags Rae's setter card to No-Show / Cancel / Reschedule…` |
| The hand move is into Follow Up or Financing Pending, or any other setter stage | Noted (event, thread line), nothing filed | `not yet` |
| The hand move is for a call still ahead | Nothing filed (dragging a future call to No Show / Cancelled is a cancel; the calendar poll carries cancels); event and line still go | `not yet` |
| The CRM's snapshot is older than our last write to that card (search index lag) | Ignored, as D41 reads it: the past is not a move | `not yet` |
| The first `cards` poll of a company | Silent baseline: the replica takes the CRM's stages, nothing is said or filed | `journey.test.ts › D61…` (the first pass moves nothing) |
| A run reads the contact's cards (`syncCards`) before the poll sees the hand move | The same detection runs there; whichever looks first records it, once | `not yet` |
| A 20-minute outage | Recovery: premise first, stale exits, sends dripped (20 per company per tick) | `not yet` (the cap and the `stale_after_outage` reason are untested) |
| A run exceeds 50 steps in one tick | Fails with that reason | `not yet` |
| The order runs execute within one tick | Should be due order. **Today:** heap order (`runner.ts:57-59`, `returning *`) | `not yet` |
| D45: the newest run for a person wins | Older parked runs exit `superseded`; one mid-step inside its lease is left to finish | `edge-cases.test.ts › D45: …` (parked); mid-step: `not yet` |
| D45 on `always` workflows | Does not apply: only `once_per_contact`, `once_per_appointment`, `once_per_contact_per_window` supersede (G4, D56) | `edge-cases.test.ts › two payments…` |
| Reentry keys per policy | Contact, appointment, opportunity, window, event | `definition.test.ts › reentry keys (D4) › per policy`; `templates.scenarios.test.ts › reactivation…` (window) |
| A gate exit releases the once (D30) | The key gets a `:gate:` suffix; queued triggers replay | `templates.scenarios.test.ts › deal-closed race…` |
| A schedule period that ran stays run, gate or not | `reentry_key like 'schedule:…:gate:%'` counts | `eod.test.ts › the reminder…` (the morning trigger runs once) |
| The premise check reads the booking source live | Deleted at the source → exit; cancelled → exit for `appointment_in_future`, not for `appointment_exists` | `engine.integration.test.ts › premise check…`; `templates.scenarios.test.ts › cancellation-rebook…` |
| The premise check when the source is down | Stays waiting, retried in 5 minutes, one alert per company that resolves itself (G2, D56) | `edge-cases.test.ts › the CRM is down…` |
| The company switched booking source while runs are parked | `appointment belongs to booking source X; company now uses Y` → exit | `not yet` |
| Send window: 2am → 8am same day; 9pm → 8am tomorrow; never backward | As described | `waitrule.test.ts › 2am → 8am same day`; `waitrule.test.ts › 9pm → 8am tomorrow, never backward` |
| Send window with end before start (an overnight window) | Should be refused at settings. **Suspected:** `deferIntoWindow` never finds the window open | `not yet` |
| A wait anchored on the appointment when the appointment moves | Recomputed from the new start (D20) | `funnel.e2e.test.ts › reschedule → …` |
| A wait anchored on "now" on re-evaluation | Pinned | `not yet` directly |
| An inbound text wakes only `wait_for_reply` runs | A timed reminder stays parked | `templates.scenarios.test.ts › an inbound text wakes a reply-wait but not a timed wait…` |
| The mode in test: a run about a non-test contact | Starts, born in test, and runs as in shadow: every CRM write a would-have, every send recorded `shadow`, Slack posts prefixed 🧪 *shadow*; a test contact's run writes and sends for real, Slack prefixed 🧪 *test* (D52 addendum 2) | `mode.test.ts › test: everyone's run starts, born in test…`; `mode.test.ts › live and shadow: everyone passes; the effective mode…` |
| The mode in test: the tag comes off mid-run | The run keeps going; from its next claim it behaves as in shadow (the follow-up is a would-send, nothing exits); a run whose tag came off before its first step runs through in shadow, still born in test | `mode.test.ts › test: the tag comes off mid-run…`; `mode.test.ts › test: a run born tagged whose tag comes off before its first step…` |
| Shadow and live | Everyone passes; the effective mode is shadow for everyone in shadow, real for everyone live, and real for a run with no contact (end of day, wrap-ups, health) in test | `mode.test.ts › live and shadow: everyone passes; the effective mode…` |
| Shadow: nothing to the CRM or the contact, Slack posts labelled | As described (D31) | `templates.scenarios.test.ts › shadow mode…`; `slack.post.test.ts › the close post…` (the 🧪 prefix) |
| Go live with a blocker | Refused; the mode stays | `golive.test.ts › refuses while a blocker stands, then clears shadow-born runs and goes live` |
| Go live clears every run not born live and every synthetic appointment | As described (D51) | same test |
| Go live by re-install | Is Go live: refused with the blockers while readiness has one, clears the rehearsal otherwise (G9, D56) | `edge-cases.test.ts › re-running install with mode: live…` |
| A disabled workflow's parked runs | Exit `workflow turned off` at their next wake (G3, D56) | `edge-cases.test.ts › a workflow turned off while a run is parked…` |
| A stored definition the engine can no longer parse | Dispatch skips that one workflow and logs it; readiness blocks; re-install upgrades | `install.upgrade.test.ts › a stored copy on an old node vocabulary is flagged by readiness and skipped by dispatch instead of crashing the poll; re-install upgrades it` |
| A template upgrade while runs are parked | Runs are pinned to their version; trigger rows survive | `edge-cases.test.ts › a template upgraded while a run is parked…`; `install.upgrade.test.ts › upgrading a workflow that already has runs keeps their trigger row…` |
| An edited copy when the template moves on | Left alone | `install.upgrade.test.ts › an edited copy is left alone when the template moves on` |
| Copy with an unknown placeholder | Refused at save | `install.upgrade.test.ts › editing copy › saving a message makes a new version…` |
| A re-install without the CRM token | Keeps the stored one; a new company without one is refused | `install.upgrade.test.ts › a re-install without a pit keeps the stored token; a new company without one is refused` |
| A re-install never flips mode or SMS back | Only explicitly passed values change | `install.ts:100-103` (code); `poll.calendly.test.ts › re-installing without a booking block keeps the company on Calendly…` (booking source) |
| Placeholder copy at go live | Warning, not blocker | `edge-cases.test.ts › placeholder copy at go-live time is a warning, not a blocker…` |
| Slack not connected | Every post recorded `unbound: slack`, runs continue | `templates.scenarios.test.ts › payment-failed…`; `templates.scenarios.test.ts › call-booked, self-booked…` |
| Slack connected, channel unbound | Recorded `slack channel not bound`, a warning alert | `alerts.test.ts › a step that could not run (Slack channel not bound) is a warning…` |
| Slack refuses the token mid-run | The post fails, the run continues (G8, D56); every step it blocks is one `auth:slack` alert for the company, not one per step; `ratelimited` and a Slack 5xx are transient and the post is retried in place, once, from a reclaimed send row (D66) | `edge-cases.test.ts › Slack refuses the bot token…`; `step-failures.test.ts › Slack refuses the token: two steps in one run are one alert…`; `step-failures.test.ts › Slack says ratelimited…` |
| The owner not in Slack | DM falls back to the channel with an @mention | `templates.scenarios.test.ts › agreements (D30)…` (the nudge, suppressed: no channel) |
| @mentions remembered | Slack ids looked up by email once and stored on the user | `slack.post.test.ts › the close post: …` |
| Duplicate webhook deliveries (Whop, Fathom, Slack); a poll re-delivering an appointment or a recording; `startRun` twice for one event | `webhook_deliveries` dedupes by delivery id; the ledgers dedupe by payment/recording id; `applyAppointment` sees no delta and emits nothing; `runs (workflow_id, reentry_key)` refuses the second start | `payments.test.ts › the same provider payment id twice…`; `recordings.test.ts › records once…`; `edge-cases.test.ts › the Slack door…` (`duplicate_delivery`); `retry.test.ts › a second delivery starts nothing` (the three doors) |
| Webhook signatures: forged, stale, missing, rotated keys | Refused; several signatures in one header pass if one is valid | `payments.test.ts › accepts a correctly signed, fresh delivery and rejects tampering, stale timestamps and missing headers`; `recordings.test.ts › Standard Webhooks: whsec_ secrets verify base64-decoded…`; `webhooks/slack.test.ts › accepts Slack's signature…` |
| A poll entity fails | Only that entity rolls back; the rest commit; the failure is counted | `poll.isolation.test.ts › a SQL error inside contacts rolls back only contacts…`; `poll.isolation.test.ts › a vendor error in conversations after a good contacts poll…` |
| The first poll after install | Silent baseline: no events for what already exists | `poll.baseline.test.ts › baseline: 3 existing contacts → replica rows, zero events`; `poll.baseline.test.ts › after baseline: only the delta becomes events…` |
| A CRM 401 during the poll | The entity fails and is counted; two in a row is an alert; the cursor never moves on failure | `alerts.test.ts › polling that fails twice in a row is an alert…` |
| A tag the CRM does not have | `addTag` creates it in the CRM; `removeTag` of an absent tag is a no-op there (D50 notes `opt-in lead` matches nothing) | `not yet` (vendor behaviour, not reachable with fakes) |
| A tag added by the engine is not re-read as a new tag event | Our replica learns the tag at write time, so the next poll sees no delta | `not yet` |
| A card in a stage we do not know (D41) | Adopted with the CRM's stage; a step with a stage moves it; a closed card is not adopted | `templates.scenarios.test.ts › D41: …` (adoption); unknown stage, closed card: `not yet` |
| The CRM's search index lags a create | A snapshot older than our last write is ignored; rows are never dropped on absence | `not yet` |
| A contact with two emails | Mode checks pass on any; payments and recordings match on any; `{{contact.email}}` is `limit 1` with no order (`context.ts:32`) | `not yet` |
| A contact merged in the CRM | `merged_into` excluded from identity ladders; premise `contact_exists` exits. A deletion or merge the CRM never reports is learned at the first send it refuses: `gone_at`, one alert, `moot: contact gone` (G21, D60) | `edge-cases.contacts.test.ts › a contact deleted in the CRM while a run is parked…`; the merge itself: `not yet` |
| Retention | Old replies and finished runs' old sends dropped; the recent and the live kept | `retention.test.ts › drops old replies and finished runs' old sends, keeps the recent and the live` |
| Secrets never in a run's context or the ledger | `{{secret.*}}` resolves only in `webhook` url/headers/body | `not yet` |
| The database clock, not JS, decides due-ness | `next_run_at <= now()` in SQL | `runner.ts:57` (code); `not yet` as a test |

## Contacts: who the person is

Tyler, 2026-10-10: "test if a lead comes through without a phone number or email, or a multi part name, etc." The
rows below are about the person rather than one workflow; where a workflow's own section already has the row, it is
named instead of repeated. Tests: `edge-cases.contacts.test.ts` (`platform/src/engine/edge-cases.contacts.test.ts`),
which drives a fake CRM through the real poll, so a lead arrives the way it does in production (`contactsChangedSince`
→ `upsertContact` → `lead.created`), and whose fake sender refuses exactly what the real one refuses (no phone, no
email, contact gone).

**The name rule the engine follows today.** `{{contact.first_name}}` is the CRM's own first-name field, verbatim:
"Mary Anne" stays "Mary Anne", "Jean-Luc" stays "Jean-Luc", "cher" stays "cher", "李" and "🔥 Mike" render as typed.
`{{contact.name}}` is `first_name + ' ' + last_name`, trimmed, null when both are empty (`context.ts:31`). The
`first_name` *filter* (`template.ts:62`) takes the first whitespace-separated word of whatever it is given and is used
by no shipped template. That is the right rule — first word as typed, never re-cased, never split on a hyphen — with
two holes: surrounding spaces are kept (G12) and an empty name has no fallback (G13). A Calendly invitee without
`first_name`/`last_name` is split on the first space (`adapters/calendly/read.ts:27`), so "Mary Anne Smith" from
Calendly becomes first "Mary", last "Anne Smith"; the CRM's own fields win once the poll joins the person.

| Edge case | What should happen | Covered by |
|---|---|---|
| A lead with no phone and no email | New lead parks on its phone check, looks again every 10 minutes for 24 hours, then exits `no_phone` (D39); the tick does not throw; nothing is invented on the replica (one `ghl_contact` identifier, no email, no phone) | `edge-cases.contacts.test.ts › a lead with no phone and no email: New lead parks for a day…`; the give-up: `templates.scenarios.test.ts › new-lead: … without a phone, the run exits no_phone` |
| A lead with no phone and no email: Speed to lead | The email and the text are both recorded `suppressed` with the missing address as the reason (`no email on the contact` / `no phone on the contact`); the CRM is never asked; the run goes on to the reply wait and the second email is skipped the same way (G11, fixed by D60) | `edge-cases.contacts.test.ts › a lead with no phone and no email: Speed to lead records…` |
| A lead with an email but no phone | The email goes; the text is skipped `no phone on the contact`; the reply wait runs (G11, fixed by D60) | `edge-cases.contacts.test.ts › a lead with an email but no phone…`; Speed to lead › "A lead with no phone" |
| A lead with a phone but no email | The email is skipped `no email on the contact`, the text goes, the reply wait runs; New lead makes the card regardless (G11, fixed by D60) | `edge-cases.contacts.test.ts › a lead with a phone but no email: the email is skipped…`; the card: `› a lead with a phone but no email: New lead does not care…` |
| A phone added later in the CRM | The parked New lead run continues once the number is on the replica. It is not woken by the number's arrival: the poll adds the identifier and starts nothing (an existing contact changing is not a new lead); the run looks again on its 10-minute clock and then makes the card. Acceptable lag; a wake on identifier change would be nicer | `edge-cases.contacts.test.ts › a phone added later in the CRM: the parked New lead run is not woken…` |
| Names: one word, three words, a hyphen, an apostrophe, lower case, accents, CJK, an emoji | The text says `Hey <first_name as the CRM has it>,`; the card is `First Last -- New` (`Cher -- New` with no last name); nothing throws | `edge-cases.contacts.test.ts › names: one word, three words, a hyphen…`; the filter rule: `edge-cases.contacts.test.ts › the first_name filter takes the first whitespace-separated word…` (pure) |
| A name with leading or trailing spaces | Trimmed everywhere, inner runs of spaces collapsed, case and hyphens as typed (G12, fixed by D60) | `edge-cases.contacts.test.ts › a name with leading/trailing spaces renders trimmed…` |
| An empty name | The text falls back ("Hey there,"), the card is named by the email, then phone, then CRM id — never " -- New" (G13, fixed by D60) | `edge-cases.contacts.test.ts › an empty name: the text says 'Hey there,'…` |
| Two CRM contacts sharing an email or a phone (the same person twice) | One local person: the second CRM id attaches as a `ghl_contact` identifier, both phones stay, a payment by that email and a booking under the second CRM id land on the one person; sends keep going to the first CRM id. The second arrival fires `lead.created` again: New lead (`always`) moves the one card and renames it from the second record, Speed to lead (`once_per_contact`) does not start twice | `edge-cases.contacts.test.ts › two CRM contacts sharing an email collapse into one person…` |
| A reply from the duplicate's thread | Counts as the person's reply and wakes the parked run (G14, fixed by D60) | `edge-cases.contacts.test.ts › a reply from the duplicate CRM record's thread counts…` |
| Two CRM records for one person: the team is told | The Health check `duplicates` lists every engine person with two current `ghl_contact` identifiers as one finding — "Two CRM records for one person: Dup Spelled — DUP-1, DUP-2 (same phone +16025550901)" — with a link to the CRM contact (where the merge happens) and the alert's Open going to the contact page; one alert per person (`duplicate:<contact_id>`, warning, source `health`), posted once in the sweep's channel, repeated in its thread while it lasts. The engine never merges: GHL is the source of truth (D63) | `health.duplicates.test.ts › two CRM records with one number in two spellings arrive via the poll → … one finding naming both ids, one alert, posted once…` |
| A merge in the CRM (one record deleted) | Nothing changes for us when both records already map to one person. The sweep asks the CRM for each suspect id; the one that answers 404 is retired on the replica (`retired_at`), `contacts.ghl_contact_id` moves to the survivor when the dropped one was primary, the finding clears and the alert resolves in its thread with a ✅ (D63). A deletion of a person we hold as their only record: see "deleted while a run is parked" | `health.duplicates.test.ts › the merge lands in the CRM…`; `› the merge kept the second record…`; the deletion: G21 |
| Two engine persons whose phones or emails differ only in spelling (a non-US number with and without its `+`, which `normPhone` does not fold) | Should not exist after D60 for US numbers; the `duplicates` check proves it: one finding keyed on both ids (`duplicate:<a>:<b>`), same text shape; when the CRM no longer has one record that person is stamped `gone_at` (G21's mark) and the finding clears (D63) | `health.duplicates.test.ts › two engine persons whose numbers differ only in spelling…` |
| A contact with two phones or two emails | Both match the person for payments, recordings, bookings and the mode gate; a reply matches by CRM id whichever number it came from. `{{contact.phone}}` / `{{contact.email}}` render whichever row `limit 1` returns (no order, `context.ts:31-32`; observed in passing above) — the current one by luck | `edge-cases.contacts.test.ts › a contact's number changes in the CRM: both numbers stay on the person; a reply … still matches`; Engine-wide › "A contact with two emails" |
| A number that moved to a different CRM contact | A separate person; the number moves to them, the old person keeps it only as a retired line of history (G15, fixed by D60) | `edge-cases.contacts.test.ts › a number that moved to a different CRM contact belongs to the new person…` |
| A booking whose invitee matches no contact (Calendly-shaped: no CRM id) | A local contact with the invitee's names, zone (`timezone_source: booking`) and identifiers; Call booked and the pre-call sequence start; New lead does not — `lead.created` fires when the CRM poll delivers the person and the replica joins them (then New lead runs and makes the card) | `edge-cases.contacts.test.ts › a booking whose invitee matches no contact (Calendly-shaped…)`; Call booked › "A booking by someone the CRM has not sent us yet"; no identity at all: `poll.calendly.test.ts › a booking with no usable identity is skipped…` |
| A CRM calendar booking by a person the contacts poll has not seen | The contact is fetched live and made; `lead.created` fires once, before `appointment.booked`; the later contacts poll adds nothing (G16, fixed by D60) | `edge-cases.contacts.test.ts › a CRM calendar booking by a person the contacts poll has not seen…` |
| A payment whose email matches no contact | Unlinked, with a contact-less event, on the Payments page (D21) | `payments.test.ts › an email nobody has → unlinked…`; Payment recorded › "A payment before the contact exists" |
| …then the contact arrives through the CRM poll | Linked (heal) and Payment recorded runs once for it. **Today:** stays unlinked until a later payment or a hand link — G17 (D21 decision first) | `edge-cases.contacts.test.ts › a payment whose email matches no contact stays unlinked; when that contact arrives…` (`it.fails`); Payment recorded › "The contact arrives through the CRM poll after the orphan payment" |
| …then a later payment from the same buyer | Links, heals the orphan (`linked_by: heal`), and Payment recorded runs once per payment, the healed one with its own totals as of its day (G18, fixed by D60) | `edge-cases.contacts.test.ts › an orphan healed by a later payment from the same buyer is written to the CRM too…`; the heal itself: `payments.test.ts › a stranger's payment is unlinked; a later payment that resolves the same member heals it` |
| A phone with parentheses, dashes, dots, spaces or `+1` | One normalised `+1XXXXXXXXXX` identifier; a booking in any of those spellings resolves to the same person; a payment matches on the last ten digits | `edge-cases.contacts.test.ts › a phone with parentheses, dashes, spaces or +1 resolves to the same person…`; Payment recorded › "The payer matched by phone with formatting" |
| A phone with a leading `1` and no `+` (`1-602-555-0901`) | The same number (G19, fixed by D60) | `edge-cases.contacts.test.ts › a phone written with a leading 1 and no plus…` |
| A non-US number (`+44 20 7946 0958`) | Kept as `+442079460958`, matched exactly; reminders use the contact's zone, not the number's | `not yet` |
| A contact with no time zone in the CRM | The company's zone, `timezone_source: company_default`; the sends go | `edge-cases.contacts.test.ts › a contact with no time zone in the CRM takes the company's…`; Pre-call sequence › "A contact with no timezone" |
| A contact whose CRM time zone is garbage | The company's zone, stored as `company_default` exactly as a missing zone is; nothing throws (G20, fixed by D60) | `edge-cases.contacts.test.ts › a contact whose CRM time zone is garbage takes the company's zone…` |
| A contact deleted in the CRM while a run is parked | The CRM's "not found" at the next send stamps `gone_at` and raises one alert; the run exits `moot: contact gone` at its next look, no crash, and so does every other run about them (G21, fixed by D60) | `edge-cases.contacts.test.ts › a contact deleted in the CRM while a run is parked…`; Engine-wide › "A contact merged in the CRM" |
| A team member's own test contact (the closer's email, tagged `sys-test`) | In live mode a contact like any other: New lead card, Speed to lead sends; the plain `sys-test` tag is a `tag.added` that starts nothing (only `sys-test-<action>` is a harness instruction). In test mode the tag is exactly what lets them through for real; an untagged lead runs as in shadow | `edge-cases.contacts.test.ts › a team member's test contact…`; `mode.test.ts › test: everyone's run starts, born in test…` |
| Two contacts with the same name | Name alone never picks one (recordings) | Sales call recorded › "Two contacts with the same name" |

| A call before 9am their time | The morning-of wait (`rm`, 8am) is skipped (`only_if` the call is at 9am or later), so the 1-hour and 10-minute texts still run; a 9am call waits for 8am, which is its 1-hour mark anyway | `edge-cases.test.ts › a call booked three minutes out…` (runs at any hour) |
