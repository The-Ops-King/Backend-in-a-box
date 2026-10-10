# Edge cases, per workflow: what should happen, and what is proven

Tyler, 2026-10-09: "we should also determine as many edge cases as possible and have them test." This file is that
list, one section per shipped template (by its `name`, as the dashboard shows it) plus an engine-wide section for what
is not about one template. Every row says what a sales-ops operator expects and names the test that proves it, or
says `not yet`. Coverage was checked by reading the tests, not by memory: a row is "covered" only when a test asserts
that behaviour. `edge-cases.test.ts` is `platform/src/engine/edge-cases.test.ts`; the other files are its siblings.

Where the engine does something other than the row expects, the row says **Today:** and points at the Known gap. A
Known gap has a test marked `it.fails` in `edge-cases.test.ts`: the test states the expected behaviour, and the day
the engine is fixed the test turns red for the right reason.

## Known gaps

Engine behaviour that looks wrong, each shown by an `it.fails` test in `edge-cases.test.ts` (an `it.todo` where the
right answer is a template decision first). Ranked by how likely it is to bite in the first live week. G11 onwards are
about who the person is (no phone, no email, names, duplicates, numbers, zones, deletions); their tests live in
`edge-cases.contacts.test.ts` (`platform/src/engine/edge-cases.contacts.test.ts`) and the rows are in § Contacts.

| # | Gap | Where | Shown by |
|---|---|---|---|
| G1 | The CRM refuses a text (no number on the sub-account, no phone on the contact) and the **whole run fails**: a pre-call sequence dies at its first text, so the reply wait and every later email never happen. The README already names this exact CRM error. Expected: the text is recorded `failed` and alerted (D33); the run continues. | `executor.ts:114` returns `failed` for a rejected send; `runner.ts:134` ends the run on it | `the CRM refuses the text…` |
| G2 | A CRM outage (401 after a token rotation, a 5xx) **at the premise check fails the run for good**. D5 says a 20-minute outage means late, never lost; today it means every due reminder is lost at once. Expected: the run stays `waiting` and is looked at again next tick. | `runner.ts:76` calls `premiseAlive`, which reads the booking source live and throws; the catch at `runner.ts:140-142` marks the run `failed` | `the CRM is down (401, token rotated) at the premise check…` |
| G3 | A workflow **turned off while runs are parked keeps running them**: the switch is read only when a run starts. Turning a workflow off in week one is the one-switch undo D52 promises; today the texts already in flight still go. Expected: a parked run of a disabled workflow does nothing when it wakes (exits, or waits for the switch). | `runner.ts:57-59` claims by status and due time only; `dispatch.ts` checks `w.enabled` at start | `a workflow turned off while a run is parked…` |
| G4 | The D45 supersede rule ("a person is in a workflow once at a time") is applied to **`always` workflows whose runs are about distinct facts**: two payments in one minute, two recordings of one call, two dialer calls in one poll. The first run exits `superseded` before it ticks and its fact is never written (one Payment record missing from the CRM). Expected: the supersede applies to per-person sequences (once_per_contact / once_per_appointment), not to `always`. | `dispatch.ts:42-44` | `two payments for one person in the same minute…` |
| G5 | **Fixed (D53).** The Slack door wrote `slack.reaction` events with `source: 'slack'`, which the events table's check constraint did not allow; `slack` is now in the schema and in `migrate.ts` EVENT_SOURCES. | `app/api/webhooks/slack/[companyId]/route.ts:39`; `engine/schema.sql:341`; `src/db/migrate.ts:6` | `the Slack door's event source is one the events table accepts…` (pure) |
| G6 | **A person rebooks, the old call is then cancelled** (how a GHL reschedule done as cancel + new booking arrives): Call cancelled moves the setter and closer cards to Cancelled with a live call days away, and Cancellation rebook texts "saw the call got cancelled, pick a new time" to someone who just did. Expected: both check for a newer confirmed closing call and stop. | `call-cancelled.json` n1/n2, `cancellation-rebook.json` n1; `poll.ts:135` only links a reschedule the source links itself (Calendly) | `a person rebooks and the old call is then cancelled…` |
| G7 | **A call booked a few hours out gets no reminders**: the booking text's reply wait holds the run for its full 4-hour timeout, and nothing caps it at the call time. The 1-hour and 10-minute texts never run; the run exits moot when the call starts. Expected: the reply wait ends at the call (or the reminders run beside it). | `executor.ts:216-219` | `a call booked two hours out…` |
| G8 | **Slack refusing the bot token fails the run** at the post, and every CRM step after the post is skipped. In Sales call recorded the post comes before the Sales Call record and the note on purpose ("Slack goes out first"), so a revoked token means the call is never written to the CRM. Expected: a Slack error is recorded on the send and alerted; the run continues. | `executor.ts:243` (`slack_post`), `executor.ts:194` (`notify_owner`) let `notifier.post` throw; `runner.ts:111` turns the throw into `failed` | `Slack refuses the bot token in the middle of Sales call recorded…` |
| G9 | **Re-running install with `mode: "live"` flips the flag without Go live**: no readiness check, no clean slate (D51), so a shadow-born run parked for a real contact sends for real at its next wake. Expected: the only way to live is `goLive`. | `install.ts:100-103` | `re-running install with mode: live on a shadow company…` |
| G10 | **A refund changes nothing downstream**: no template listens to `payment.refunded`, so cash collected on the contact and `pay-paid-full` stand after the money went back. A template decision before it is an engine bug. | `templates/*.json` (no trigger on `payment.refunded`) | `it.todo` |
| G11 | **A send to a contact with no address for the channel is not skipped; the CRM is asked and its refusal fails the run.** `contact.phone` and `contact.email` are already in the context, yet `doSend` never looks at them: a lead with no email dies at Speed to lead's first step and the text never goes; a lead with no phone gets the email, then the text's refusal kills the run (G1's root). Expected: recorded `suppressed: no phone on the contact` / `no email on the contact`, the run goes on. Fix: in `doSend`, before the queued `recordSend`, suppress and return `skipped` when the channel's address is missing; G1's fix (a refused send is `failed` + alert, the run continues) still covers the CRM-side refusals. | `executor.ts:108-114` | `edge-cases.contacts.test.ts › a lead with no phone and no email: Speed to lead records…`, `› a lead with an email but no phone…`, `› a lead with a phone but no email: the email is skipped…` |
| G12 | **Names are stored as the CRM sends them, spaces included**: `  Zed  ` renders `Hey   Zed  ,` and the card is `  Zed    Zee  -- New`; only the joined `name` is trimmed. Fix: `trim()` and collapse inner whitespace on `firstName`/`lastName` in `upsertContact` and `resolveContactForBooking` (or in the adapter mapping, `adapters/ghl/read.ts:7`). | `poll.ts:49-53`, `poll.ts:103`; `context.ts:31` trims only `name` | `edge-cases.contacts.test.ts › a name with leading/trailing spaces renders trimmed…` |
| G13 | **An empty name renders "Hey ," and a card named " -- New"**: no template gives `{{contact.first_name}}` a fallback, and `pipeline_card` accepts a blank name (" -- New" is truthy). Fix: templates say `{{contact.first_name \| default:there}}`; the context builds `contact.first_name` as the CRM's first name, else the first word of `name`, else null; `pipeline_card` falls back to an identifier (email, phone) when `contact.name` is empty. | `executor.ts:340`; `speed-to-lead.json`, `pre-call-sequence.json`, `reactivation.json`, `no-show-recovery.json`, `post-call-follow-up.json` | `edge-cases.contacts.test.ts › an empty name: the text does not say 'Hey ,'…` |
| G14 | **A reply from a duplicate CRM record never counts**: two CRM contacts with one email fold into one person (`upsertContact` attaches the second CRM id as a `ghl_contact` identifier, which is right), but `pollInbound` looks the sender up by `contacts.ghl_contact_id` only, so a text from the second record's thread is dropped and the parked run never wakes. Fix: resolve `m.contactId` through `contact_identifiers where kind='ghl_contact'` (the ladder bookings already use), then `contacts.ghl_contact_id`. | `poll.ts:188` | `edge-cases.contacts.test.ts › a reply from the duplicate CRM record's thread counts…` |
| G15 | **A retired phone number still points at the old person**: when a contact's number changes the old identifier stays, so the next CRM contact carrying that number (recycled, or re-typed on the wrong record) is folded into the old person — a stranger inherits someone else's runs, card and payments. Fix: when the CRM's current phone/email differs from the replica's, retire the stale identifier (delete it, or `retired_at`) and match only on current ones; a hit on a retired identifier is a question for a person, not a merge. | `poll.ts:44` (match on any identifier ever seen), `poll.ts:55-56` (identifiers only ever added) | `edge-cases.contacts.test.ts › a number that moved to a different CRM contact belongs to the new person…` |
| G16 | **A person whose first appearance is a CRM calendar booking never gets `lead.created`**: `resolveContactForBooking` upserts them from a live read without an event, and the later contacts poll sees an existing row (`isNew` means "no row with this CRM id"), so New lead and Speed to lead never run for them. The Calendly-shaped path does fire it, late, when the CRM poll joins the person to the local replica. Fix: have `resolveContactForBooking` return `isNew` and emit `lead.created` before `appointment.booked`, or make `isNew` mean "no replica row before this poll". | `poll.ts:92`; `poll.ts:40-42, 58` | `edge-cases.contacts.test.ts › a CRM calendar booking by a person the contacts poll has not seen: lead.created fires once…` |
| G17 | **An orphan payment is not healed when the buyer's contact arrives**: heal runs only inside `settle`, on a later payment or a hand link; the CRM poll that brings the contact changes nothing, so the row sits unlinked until someone notices. D21 says nothing is guessed, but an exact email match is the test `resolvePayer` already trusts — decide, then fix. Fix: after `upsertContact` adds an email/phone identifier, heal `link_status='unlinked'` rows with that `customer_email`/phone and dispatch their `payment.received`. | `payments.ts:84-87` (heal inside `settle` only); `poll.ts:37` (`upsertContact` never reads `payments`) | `edge-cases.contacts.test.ts › a payment whose email matches no contact stays unlinked; when that contact arrives…` |
| G18 | **A healed orphan is never written to the CRM**: heal relinks the row and emits `payment.linked`, which no template listens to; only the later payment's `payment.received` starts Payment recorded, so one Payment record is missing (cash collected is still right: `priorTotal` counts the healed row). The hand-link path (`linkPayment`) does emit `payment.received`. Fix: in `settle`'s heal loop emit and dispatch each healed row's `payment.received` with its own `prior_total`, or let Payment recorded trigger on `payment.linked` too. | `payments.ts:84-87`; `templates/*.json` (nothing on `payment.linked`) | `edge-cases.contacts.test.ts › an orphan healed by a later payment from the same buyer is written to the CRM too…` |
| G19 | **`1-602-555-0901` is not `+16025550901`**: `normPhone` adds `+1` to exactly ten digits; eleven digits starting with 1 stay as typed, match nothing, and a booking or CRM contact with that spelling invents a second person. Payments already get this right (`phoneKey`, last ten digits). Fix: normalise `^\+?1?(\d{10})$` to `+1$1`, or match on the last ten digits as `payments.ts:28` does. | `poll.ts:14` | `edge-cases.contacts.test.ts › a phone written with a leading 1 and no plus…` |
| G20 | **A garbage CRM time zone fails the run**: the replica stores whatever the CRM sends; `deferIntoWindow` on an invalid zone returns an invalid DateTime, the runner writes it as `next_run_at`, Postgres refuses (pg already warns `PG_INVALID_DATE`), the run is `failed`. Expected: the company's zone. Fix: validate with Luxon (`DateTime.now().setZone(tz).isValid`) in `upsertContact`/`resolveContactForBooking` (store the company zone, `timezone_source='company_default'`) and defensively in `contactTz` and the runner's `tz`. | `poll.ts:46` (`s.timezone ?? companyTz`, unvalidated); `waitrule.ts:48-56`; `runner.ts:100-103` | `edge-cases.contacts.test.ts › a contact whose CRM time zone is garbage falls back…` |
| G21 | **A contact deleted or merged in the CRM is invisible**: `contactsChangedSince` never reports deletions, nothing ever writes `contacts.merged_into`, and the premise `contact_exists` reads the replica — so a parked run wakes, asks the CRM to send to a contact that is gone, and fails on the refusal. Expected: exit `moot: contact gone`. Fix: on a CRM "contact not found" at a send or write, mark the replica (`merged_into` to the survivor when the CRM says, else a `deleted_at`) and exit the run moot; and/or a daily `getContact` sweep over contacts with live runs. | `runner.ts:25` (replica read); `poll.ts:63-85` (no deletion path); `merged_into` written nowhere | `edge-cases.contacts.test.ts › a contact deleted in the CRM while a run is parked: the run exits moot…` |

Observed in passing, no test (rows below say `not yet`): the order runs execute in one tick is the database's heap
order, not the due order (`runner.ts:57-59`: `update … where id in (select … order by next_run_at) returning *` does
not preserve the subquery's order), so two events landing in the same poll race; `{{contact.email}}` and
`{{contact.phone}}` are `limit 1` with no order (`context.ts:31-32`), so a contact with two emails renders either.

## Pre-call sequence

| Edge case | What should happen | Covered by |
|---|---|---|
| A booking starts the sequence; the day-one email and text go once; a second tick sends nothing again | One run, two sends, the ledger refuses a duplicate | `engine.integration.test.ts › a booked appointment starts the pre-call sequence; the booking email and text go once; it waits for the reply` |
| A reply arrives while the run is parked on the booking text | The poll wakes the run the same minute (`wake_on_reply`); classify → branch | `engine.integration.test.ts › reply → classify → branch → tag confirmed → on to the reminders…` |
| A reply in pieces ("yes" … "🙏") | After the newest piece the run waits `settle` (90 s); a further piece restarts the clock; the classifier reads both as one reply | same test (`settled`, `classified.at(-1)` is both pieces) |
| A reply during the settle window that cancels the first ("yes… actually no") | Both pieces go to the classifier together; the last word is read in context | `not yet` (the fake classifier answers by regex) |
| A reply after the reply wait ended (two days later: "can't make it") | `message.received` fires; a run parked on a timed reminder is not woken | `templates.scenarios.test.ts › an inbound text wakes a reply-wait but not a timed wait…` — and nothing acts on the reply: `it.todo` in `edge-cases.test.ts` |
| No reply in 4 hours | Timeout edge: `stat-unconfirmed`, the closers told in the booking thread, the reminders go on | `engine.integration.test.ts › wait_for_reply timeout: no reply by the deadline…` |
| An unclear reply (👎, "maybe") | Jev says unclear → the question post with ✅ ❌ offered, remembered as `decision:<appointment>` | `adapters/jev/classifier.test.ts › a confident answer that a careful person would still doubt is unclear`; the post itself: `not yet` |
| The appointment is rescheduled while a reminder is parked | The poll wakes runs on that appointment; the wait recomputes from the new start (D20) | `funnel.e2e.test.ts › reschedule → same appointment moves, the sequence stays with it, nothing else fires` |
| The appointment is cancelled while a reminder is parked | Premise `appointment_in_future` fails → `moot: appointment cancelled`, no send | `engine.integration.test.ts › premise check: a cancelled appointment exits the run instead of sending`; `funnel.e2e.test.ts › cancel → rebook sequence sends, the pre-call sequence exits as moot…` |
| The person books a second call (rebook as cancel + new booking) | The older run exits `superseded: a newer run for this person`; the new run carries on alone (D45) | `edge-cases.test.ts › D45: a second booking for the same person supersedes the pre-call run…` |
| A call booked three minutes out | Day-one email and text skipped as stale (`validity.min_lead`), nothing fails, the run exits moot once the call has started | `edge-cases.test.ts › a call booked three minutes out…` |
| A call booked two hours out | The 1-hour and 10-minute texts still go. **Today:** G7, the run sits on the 4-hour reply wait until the call starts | `edge-cases.test.ts › a call booked two hours out…` (`it.fails`) |
| A 10-minute reminder for a call that is already closer than that | `m10` has no validity: it sends with `relative` recomputed ("in about 5 minutes") | `not yet` |
| The 3-day text when the call is 2 days out | Skipped as stale; the 2-day one goes | `engine.integration.test.ts › reply → classify → branch…` (`3 days out` not sent) |
| A reminder that lands at 3am their time | `earliest`/`latest` move it to a human hour the same day; the send window defers forward | `waitrule.test.ts › earliest / latest: four hours before a 7am call is 8am, not 3am…`; `waitrule.test.ts › 2am → 8am same day` |
| Morning-of text for a call before 10am | Guard + fallback: the evening before | `waitrule.test.ts › …unless it's before 10am → evening before (the guard + fallback)` |
| A wait anchored on "now" must not slide on re-evaluation | The first answer is pinned in `vars.__wait.<node>.until` | `not yet` directly (scenarios fast-forward by moving the pin; the pin's own behaviour is not asserted) |
| DST changes between the booking and the reminder | Luxon computes `day_of@08:00` in the contact's zone on that day; 8am stays 8am | `not yet` |
| A contact with no timezone | Falls back to the company's zone | `not yet` (`context.ts` `timezone: contact.timezone ?? company.timezone`) |
| A contact with a garbage timezone string from the CRM | Should fall back to the company's zone. **Suspected:** an invalid zone makes `deferIntoWindow` produce an invalid date and the run fails | `not yet` |
| The contact has no phone | The text is refused by the CRM; the run should carry on to the reply wait and the emails. **Today:** G1 | `edge-cases.test.ts › the CRM refuses the text…` (`it.fails`) |
| The company has SMS off | Text steps are recorded `suppressed: sms_disabled`, the run continues | `templates.scenarios.test.ts › sms_enabled=false: SMS nodes are suppressed and the run continues` (on Speed to lead; same code path) |
| Placeholder copy still in place | Sends go out as `[placeholder — …]`; readiness warns, does not block (D51) | `engine.integration.test.ts › a booked appointment…` (asserts the placeholder bodies); `edge-cases.test.ts › placeholder copy at go-live time is a warning, not a blocker…` |
| A relative time rendered after the call ("in -30 minutes") | `relative` throws `StaleTemplateError`; `on_stale` decides; nothing stale ships | `template.test.ts › THROWS on a non-positive duration` |
| The workflow is turned off mid-sequence | The parked run does nothing more. **Today:** G3 | `edge-cases.test.ts › a workflow turned off while a run is parked…` (`it.fails`) |
| The template is upgraded mid-sequence | The run finishes on the version it started with; new bookings start on the new one | `edge-cases.test.ts › a template upgraded while a run is parked…` |
| The company moves from test to live while a run is parked | Go live clears every run not born live before flipping the flag | `golive.test.ts › refuses while a blocker stands, then clears shadow-born runs and goes live` |
| The booking is from Calendly, not the CRM | `update_appointment` (cancel on ❌) records "read-only" and moves on | `not yet` |

## Speed to lead

| Edge case | What should happen | Covered by |
|---|---|---|
| Lead created → email + text at once; a reply ends it `replied`; silence → one more email, `no_reply` | As described | `templates.scenarios.test.ts › speed-to-lead: email + SMS now; a reply → tag engaged; silence → second email` |
| The same lead fires twice (form resubmitted) | `once_per_contact`: the second start is refused | `not yet` (the New lead sibling is asserted; Speed to lead is not) |
| 480 existing contacts at install | The first poll is a silent baseline: no `lead.created`, no 480 emails | `poll.baseline.test.ts › baseline: 3 existing contacts → replica rows, zero events` |
| A lead created at 2am | The email waits for the send window; a `transactional` one goes at once only when the company allows it | `templates.scenarios.test.ts › dark hours: a human-sounding send waits for the window…` |
| A lead with no phone | Email goes; the text is refused by the CRM. **Today:** G1 kills the run | `edge-cases.test.ts › the CRM refuses the text…` (`it.fails`, on Pre-call; same code path) |
| A lead the poll sees but who is not a test contact, in test mode | No run starts; a run in flight stops before any write | `mode.test.ts › test: a tagged contact and a test-domain contact start runs; a real one does not`; `mode.test.ts › test: a run in flight about a contact that stops passing exits…` |
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
| The person books a new call during the recovery | Nothing in this workflow stops; Call booked runs for the new one | `not yet` |

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
| Two closing calls booked for one person in one poll | Both runs should complete (`always`). **Today:** G4, the first is superseded | `edge-cases.test.ts › two payments for one person in the same minute…` (`it.fails`, same rule) |
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
| The same payment delivered twice | Duplicate: nothing new, nothing started | `templates.scenarios.test.ts › a redelivered payment webhook records nothing new and starts nothing` |
| Two payments in one minute | Both recorded. **Today:** G4 | `edge-cases.test.ts › two payments for one person in the same minute…` (`it.fails`) |
| A payment before the contact exists | Unlinked + alert; a later payment from the same buyer heals it; a person can link it by hand | `payments.test.ts › a stranger's payment is unlinked; a later payment that resolves the same member heals it`; `payments.test.ts › a person links an orphan by hand…` |
| The contact arrives through the CRM poll after the orphan payment | Stays unlinked until a later payment or a hand link (D21: nothing is guessed) | `not yet` |
| A refund | The ledger lowers the running total; the CRM side should follow. **Today:** G10, nothing listens | `payments.test.ts › a refund is a negative row that lowers the running total`; `it.todo` |
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
| Two recordings of one call | Both link to the appointment; the second should also run (`always`). **Today:** if both land in one minute G4 drops the first; otherwise showed is recorded twice (idempotent on the row) and two review posts go | `not yet` (G4 shown on payments) |
| Two different contacts on one recording | Ambiguous, not a guess: unlinked | `recordings.test.ts › two different contacts on one recording is ambiguous, not a guess; all-staff is named as such` |
| Two contacts with the same name | Name alone never picks one | `recordings.test.ts › name matches only when exactly one contact has it` |
| The closer's own recording with a guest email | The closer's calendar resolves the person when one appointment is near | `recordings.test.ts › the closer's calendar: one appointment within two hours…` |
| The closer not on the roster | Still staff (`recordedBy`) | `recordings.test.ts › the closer is staff even when the roster did not list them…` |
| No AI key | `analyze` fails the run unless `optional`; readiness/health warn | `slack.post.test.ts › without the AI key the optional cheer is skipped…` (optional); the required case: `not yet` |
| Jev unsure of the kind | `unclear` → the sales-call check fails → `not_a_sales_call` | `adapters/jev/classifier.test.ts › below the threshold, outside the options, a failed call, or no key: unclear`; the exit: `not yet` |
| The disposition is a value the CRM's picklist does not have | `oneof:` leaves it blank rather than writing what the CRM would drop | `not yet` |
| Slack refuses the token at the review post | The post is recorded failed; the Sales Call record still written. **Today:** G8 | `edge-cases.test.ts › Slack refuses the bot token in the middle of Sales call recorded…` (`it.fails`) |
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
| Two calls to one lead in one poll | Both runs should complete (`always`). **Today:** G4 | `not yet` (G4 shown on payments) |
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

The workflow is gone: the question now waits for its own answer inside the pre-call sequence (`wait_for_reaction`). The cases below still apply, to that step.

| Edge case | What should happen | Covered by |
|---|---|---|
| ✅ on the question | `stat-confirmed`, ✅ on the booking post, the bot's ✅ ❌ taken off the question | `edge-cases.test.ts › the Slack door: … one real tap starts the booking decision` (the tag; the thread reply is `thread_only` and skipped without a booking post) |
| ❌ on the question | The appointment is cancelled (Call cancelled does the rest) | `not yet` |
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
| Every send is idempotent per run + step | The ledger refuses a duplicate; retries are safe | `engine.integration.test.ts › reply → classify…` (unique keys); `engine.integration.test.ts › a booked appointment…` (second tick sends nothing) |
| A step throws (vendor error) | The run fails; the ledger rows already written stay | `alerts.test.ts › a failed step is announced the minute it fails, once…` |
| A failed run is terminal | There is no retry; fixing the vendor does not resume it | `not yet` (and see G2, G8: the failures that should not have been terminal) |
| A tick killed mid-flight | The lease expires in 5 minutes and another tick takes over | `lock.test.ts › an expired lease (tick killed mid-flight) is taken over`; `lock.test.ts › second acquirer is refused while the lease is held…` |
| Two ticks at once | One runs, the other reports busy | `lock.test.ts › withTickLock reports busy instead of running twice…` |
| A 20-minute outage | Recovery: premise first, stale exits, sends dripped (20 per company per tick) | `not yet` (the cap and the `stale_after_outage` reason are untested) |
| A run exceeds 50 steps in one tick | Fails with that reason | `not yet` |
| The order runs execute within one tick | Should be due order. **Today:** heap order (`runner.ts:57-59`, `returning *`) | `not yet` |
| D45: the newest run for a person wins | Older parked runs exit `superseded`; one mid-step inside its lease is left to finish | `edge-cases.test.ts › D45: …` (parked); mid-step: `not yet` |
| D45 on `always` workflows | Should not apply. **Today:** G4 | `edge-cases.test.ts › two payments…` (`it.fails`) |
| Reentry keys per policy | Contact, appointment, opportunity, window, event | `definition.test.ts › reentry keys (D4) › per policy`; `templates.scenarios.test.ts › reactivation…` (window) |
| A gate exit releases the once (D30) | The key gets a `:gate:` suffix; queued triggers replay | `templates.scenarios.test.ts › deal-closed race…` |
| A schedule period that ran stays run, gate or not | `reentry_key like 'schedule:…:gate:%'` counts | `eod.test.ts › the reminder…` (the morning trigger runs once) |
| The premise check reads the booking source live | Deleted at the source → exit; cancelled → exit for `appointment_in_future`, not for `appointment_exists` | `engine.integration.test.ts › premise check…`; `templates.scenarios.test.ts › cancellation-rebook…` |
| The premise check when the source is down | Stay waiting. **Today:** G2 | `edge-cases.test.ts › the CRM is down…` (`it.fails`) |
| The company switched booking source while runs are parked | `appointment belongs to booking source X; company now uses Y` → exit | `not yet` |
| Send window: 2am → 8am same day; 9pm → 8am tomorrow; never backward | As described | `waitrule.test.ts › 2am → 8am same day`; `waitrule.test.ts › 9pm → 8am tomorrow, never backward` |
| Send window with end before start (an overnight window) | Should be refused at settings. **Suspected:** `deferIntoWindow` never finds the window open | `not yet` |
| A wait anchored on the appointment when the appointment moves | Recomputed from the new start (D20) | `funnel.e2e.test.ts › reschedule → …` |
| A wait anchored on "now" on re-evaluation | Pinned | `not yet` directly |
| An inbound text wakes only `wait_for_reply` runs | A timed reminder stays parked | `templates.scenarios.test.ts › an inbound text wakes a reply-wait but not a timed wait…` |
| The mode gate: a run about a non-test contact in test mode | Never starts; a run in flight exits before any write; a send to a non-passing contact is suppressed even inside a run | `mode.test.ts › test: a tagged contact and a test-domain contact start runs; a real one does not`; `mode.test.ts › test: a run in flight about a contact that stops passing exits…` |
| Shadow and live | Everyone passes | `mode.test.ts › live and shadow: everyone passes` |
| Shadow: nothing to the CRM or the contact, Slack posts labelled | As described (D31) | `templates.scenarios.test.ts › shadow mode…`; `slack.post.test.ts › the close post…` (the 🧪 prefix) |
| Go live with a blocker | Refused; the mode stays | `golive.test.ts › refuses while a blocker stands, then clears shadow-born runs and goes live` |
| Go live clears every run not born live and every synthetic appointment | As described (D51) | same test |
| Go live by re-install | Should be the same as Go live. **Today:** G9 | `edge-cases.test.ts › re-running install with mode: live…` (`it.fails`) |
| A disabled workflow's parked runs | Stop. **Today:** G3 | `edge-cases.test.ts › a workflow turned off while a run is parked…` (`it.fails`) |
| A stored definition the engine can no longer parse | Dispatch skips that one workflow and logs it; readiness blocks; re-install upgrades | `install.upgrade.test.ts › a stored copy on an old node vocabulary is flagged by readiness and skipped by dispatch instead of crashing the poll; re-install upgrades it` |
| A template upgrade while runs are parked | Runs are pinned to their version; trigger rows survive | `edge-cases.test.ts › a template upgraded while a run is parked…`; `install.upgrade.test.ts › upgrading a workflow that already has runs keeps their trigger row…` |
| An edited copy when the template moves on | Left alone | `install.upgrade.test.ts › an edited copy is left alone when the template moves on` |
| Copy with an unknown placeholder | Refused at save | `install.upgrade.test.ts › editing copy › saving a message makes a new version…` |
| A re-install without the CRM token | Keeps the stored one; a new company without one is refused | `install.upgrade.test.ts › a re-install without a pit keeps the stored token; a new company without one is refused` |
| A re-install never flips mode or SMS back | Only explicitly passed values change | `install.ts:100-103` (code); `poll.calendly.test.ts › re-installing without a booking block keeps the company on Calendly…` (booking source) |
| Placeholder copy at go live | Warning, not blocker | `edge-cases.test.ts › placeholder copy at go-live time is a warning, not a blocker…` |
| Slack not connected | Every post recorded `unbound: slack`, runs continue | `templates.scenarios.test.ts › payment-failed…`; `templates.scenarios.test.ts › call-booked, self-booked…` |
| Slack connected, channel unbound | Recorded `slack channel not bound`, a warning alert | `alerts.test.ts › a step that could not run (Slack channel not bound) is a warning…` |
| Slack refuses the token mid-run | The post fails, the run continues. **Today:** G8 | `edge-cases.test.ts › Slack refuses the bot token…` (`it.fails`) |
| The owner not in Slack | DM falls back to the channel with an @mention | `templates.scenarios.test.ts › agreements (D30)…` (the nudge, suppressed: no channel) |
| @mentions remembered | Slack ids looked up by email once and stored on the user | `slack.post.test.ts › the close post: …` |
| Duplicate webhook deliveries (Whop, Fathom, Slack) | `webhook_deliveries` dedupes by delivery id; the ledgers dedupe by payment/recording id | `payments.test.ts › the same provider payment id twice…`; `recordings.test.ts › records once…`; `edge-cases.test.ts › the Slack door…` (`duplicate_delivery`) |
| Webhook signatures: forged, stale, missing, rotated keys | Refused; several signatures in one header pass if one is valid | `payments.test.ts › accepts a correctly signed, fresh delivery and rejects tampering, stale timestamps and missing headers`; `recordings.test.ts › Standard Webhooks: whsec_ secrets verify base64-decoded…`; `webhooks/slack.test.ts › accepts Slack's signature…` |
| A poll entity fails | Only that entity rolls back; the rest commit; the failure is counted | `poll.isolation.test.ts › a SQL error inside contacts rolls back only contacts…`; `poll.isolation.test.ts › a vendor error in conversations after a good contacts poll…` |
| The first poll after install | Silent baseline: no events for what already exists | `poll.baseline.test.ts › baseline: 3 existing contacts → replica rows, zero events`; `poll.baseline.test.ts › after baseline: only the delta becomes events…` |
| A CRM 401 during the poll | The entity fails and is counted; two in a row is an alert; the cursor never moves on failure | `alerts.test.ts › polling that fails twice in a row is an alert…` |
| A tag the CRM does not have | `addTag` creates it in the CRM; `removeTag` of an absent tag is a no-op there (D50 notes `opt-in lead` matches nothing) | `not yet` (vendor behaviour, not reachable with fakes) |
| A tag added by the engine is not re-read as a new tag event | Our replica learns the tag at write time, so the next poll sees no delta | `not yet` |
| A card in a stage we do not know (D41) | Adopted with the CRM's stage; a step with a stage moves it; a closed card is not adopted | `templates.scenarios.test.ts › D41: …` (adoption); unknown stage, closed card: `not yet` |
| The CRM's search index lags a create | A snapshot older than our last write is ignored; rows are never dropped on absence | `not yet` |
| A contact with two emails | Mode checks pass on any; payments and recordings match on any; `{{contact.email}}` is `limit 1` with no order (`context.ts:32`) | `not yet` |
| A contact merged in the CRM | `merged_into` excluded from identity ladders; premise `contact_exists` exits | `not yet` |
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
| A lead with no phone and no email: Speed to lead | The email and the text are both recorded `suppressed` with the missing address as the reason; the run goes on to the reply wait and the second email is skipped the same way. **Today:** the run says why only as the CRM's refusal in `exit_reason`, and dies at the first send — G11 (and G1) | `edge-cases.contacts.test.ts › a lead with no phone and no email: Speed to lead records…` (`it.fails`) |
| A lead with an email but no phone | The email goes; the text is skipped `no phone on the contact`; the reply wait runs. **Today:** the email goes, the text's refusal fails the run — G1/G11 | `edge-cases.contacts.test.ts › a lead with an email but no phone…` (`it.fails`); Speed to lead › "A lead with no phone" |
| A lead with a phone but no email | The email is skipped, the text goes, the reply wait runs; New lead makes the card regardless. **Today:** the email is the first step, its refusal fails the run, the text never goes — G11 | `edge-cases.contacts.test.ts › a lead with a phone but no email: the email is skipped…` (`it.fails`); the card: `› a lead with a phone but no email: New lead does not care…` |
| A phone added later in the CRM | The parked New lead run continues once the number is on the replica. It is not woken by the number's arrival: the poll adds the identifier and starts nothing (an existing contact changing is not a new lead); the run looks again on its 10-minute clock and then makes the card. Acceptable lag; a wake on identifier change would be nicer | `edge-cases.contacts.test.ts › a phone added later in the CRM: the parked New lead run is not woken…` |
| Names: one word, three words, a hyphen, an apostrophe, lower case, accents, CJK, an emoji | The text says `Hey <first_name as the CRM has it>,`; the card is `First Last -- New` (`Cher -- New` with no last name); nothing throws | `edge-cases.contacts.test.ts › names: one word, three words, a hyphen…`; the filter rule: `edge-cases.contacts.test.ts › the first_name filter takes the first whitespace-separated word…` (pure) |
| A name with leading or trailing spaces | Trimmed everywhere. **Today:** G12 | `edge-cases.contacts.test.ts › a name with leading/trailing spaces renders trimmed…` (`it.fails`) |
| An empty name | The text falls back ("Hey there,"), the card is named by an identifier, never " -- New". **Today:** G13 | `edge-cases.contacts.test.ts › an empty name: the text does not say 'Hey ,'…` (`it.fails`) |
| Two CRM contacts sharing an email or a phone (the same person twice) | One local person: the second CRM id attaches as a `ghl_contact` identifier, both phones stay, a payment by that email and a booking under the second CRM id land on the one person; sends keep going to the first CRM id. The second arrival fires `lead.created` again: New lead (`always`) moves the one card and renames it from the second record, Speed to lead (`once_per_contact`) does not start twice | `edge-cases.contacts.test.ts › two CRM contacts sharing an email collapse into one person…` |
| A reply from the duplicate's thread | Counts as the person's reply and wakes the parked run. **Today:** dropped — G14 | `edge-cases.contacts.test.ts › a reply from the duplicate CRM record's thread counts…` (`it.fails`) |
| A merge in the CRM (one record deleted) | Nothing changes for us when both records already map to one person; the deleted CRM id simply stops appearing. A deletion of a person we hold as their only record: see "deleted while a run is parked" | the duplicate case above; the deletion: G21 |
| A contact with two phones or two emails | Both match the person for payments, recordings, bookings and the mode gate; a reply matches by CRM id whichever number it came from. `{{contact.phone}}` / `{{contact.email}}` render whichever row `limit 1` returns (no order, `context.ts:31-32`; observed in passing above) — the current one by luck | `edge-cases.contacts.test.ts › a contact's number changes in the CRM: both numbers stay on the person; a reply … still matches`; Engine-wide › "A contact with two emails" |
| A number that moved to a different CRM contact | A separate person. **Today:** the stale identifier folds the stranger into the old person — G15 | `edge-cases.contacts.test.ts › a number that moved to a different CRM contact belongs to the new person…` (`it.fails`) |
| A booking whose invitee matches no contact (Calendly-shaped: no CRM id) | A local contact with the invitee's names, zone (`timezone_source: booking`) and identifiers; Call booked and the pre-call sequence start; New lead does not — `lead.created` fires when the CRM poll delivers the person and the replica joins them (then New lead runs and makes the card) | `edge-cases.contacts.test.ts › a booking whose invitee matches no contact (Calendly-shaped…)`; Call booked › "A booking by someone the CRM has not sent us yet"; no identity at all: `poll.calendly.test.ts › a booking with no usable identity is skipped…` |
| A CRM calendar booking by a person the contacts poll has not seen | The contact is fetched live and made; `lead.created` fires once. **Today:** it never fires — G16 | `edge-cases.contacts.test.ts › a CRM calendar booking by a person the contacts poll has not seen…` (`it.fails`) |
| A payment whose email matches no contact | Unlinked, with a contact-less event, on the Payments page (D21) | `payments.test.ts › an email nobody has → unlinked…`; Payment recorded › "A payment before the contact exists" |
| …then the contact arrives through the CRM poll | Linked (heal) and Payment recorded runs once for it. **Today:** stays unlinked until a later payment or a hand link — G17 (D21 decision first) | `edge-cases.contacts.test.ts › a payment whose email matches no contact stays unlinked; when that contact arrives…` (`it.fails`); Payment recorded › "The contact arrives through the CRM poll after the orphan payment" |
| …then a later payment from the same buyer | Links, heals the orphan (`linked_by: heal`), and Payment recorded runs once per payment. **Today:** the heal is right, the healed row gets no run — G18 | `edge-cases.contacts.test.ts › an orphan healed by a later payment from the same buyer is written to the CRM too…` (`it.fails`); the heal itself: `payments.test.ts › a stranger's payment is unlinked; a later payment that resolves the same member heals it` |
| A phone with parentheses, dashes, dots, spaces or `+1` | One normalised `+1XXXXXXXXXX` identifier; a booking in any of those spellings resolves to the same person; a payment matches on the last ten digits | `edge-cases.contacts.test.ts › a phone with parentheses, dashes, spaces or +1 resolves to the same person…`; Payment recorded › "The payer matched by phone with formatting" |
| A phone with a leading `1` and no `+` (`1-602-555-0901`) | The same number. **Today:** a second person is invented — G19 | `edge-cases.contacts.test.ts › a phone written with a leading 1 and no plus…` (`it.fails`) |
| A non-US number (`+44 20 7946 0958`) | Kept as `+442079460958`, matched exactly; reminders use the contact's zone, not the number's | `not yet` |
| A contact with no time zone in the CRM | The company's zone, `timezone_source: company_default`; the sends go | `edge-cases.contacts.test.ts › a contact with no time zone in the CRM takes the company's…`; Pre-call sequence › "A contact with no timezone" |
| A contact whose CRM time zone is garbage | The company's zone; nothing throws. **Today:** the run fails — G20 (the Pre-call row's "Suspected" is confirmed) | `edge-cases.contacts.test.ts › a contact whose CRM time zone is garbage falls back…` (`it.fails`) |
| A contact deleted in the CRM while a run is parked | The run exits `moot: contact gone` at its next step, no crash. **Today:** the engine never learns; the send's refusal fails the run — G21 | `edge-cases.contacts.test.ts › a contact deleted in the CRM while a run is parked…` (`it.fails`); Engine-wide › "A contact merged in the CRM" |
| A team member's own test contact (the closer's email, tagged `sys-test`) | In live mode a contact like any other: New lead card, Speed to lead sends; the plain `sys-test` tag is a `tag.added` that starts nothing (only `sys-test-<action>` is a harness instruction). In test mode the tag is exactly what lets them through; an untagged lead does not pass | `edge-cases.contacts.test.ts › a team member's test contact…`; `mode.test.ts › test: a tagged contact and a test-domain contact start runs; a real one does not` |
| Two contacts with the same name | Name alone never picks one (recordings) | Sales call recorded › "Two contacts with the same name" |
