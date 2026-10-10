# Step failures: every step, every error, written down before it bites

Tyler, 2026-10-10: "We need to figure out how to test what would happen if there were all sorts of errors on each
step. For example, if it came in with a phone number, without a phone number, with an email without an email; ok cool
then what happens if it can't find the setter card, what happens if it finds the setter card but it's in another
column already; what happened when it hit a 400 and just kept trying over and over; what happens if it's a 401, or a
503, how many times do we retry and what do we do to try to fix it automatically? That's the type of bug I want you
to go through each step and try to find. A very bad bug is that it runs 20 times. A worse bug is that it creates 20
opportunity cards, a REALLY BAD WORSE bug is if it messages someone 20 times, even worse would be if they charged them
20 times."

This file is that walk: one section per node type that touches the outside world or the person's data, one table per
section, one row per situation. **Expected** is the policy (D67) and the owner's four rules. **Today** is what the
code does now, read from the executor, the runner and the adapters, with the line. **Test** names the row's test in
`platform/src/engine/step-failures.test.ts` (company `stepf`); a test written to Expected that today's engine fails
is marked `it.fails` there and says so in its title, so the retry work flips it to green. `not yet` means no test.

## The policy (D67)

Every step error is classified:

| Class | What it is | What happens |
|---|---|---|
| **transient** | network error, timeout, 408 / 425 / 429 / 5xx | the same step is retried in place at 1 min, 5 min, 15 min, 1 h; the run waits on that node between tries; after the fourth miss the run pauses |
| **auth** | 401 / 403 | the run pauses at once; one alert per vendor (not per step, not per run); the paused runs are woken when the token is replaced |
| **permanent** | 400 / 404 / 422, a body that says "not found" / "invalid" | the run pauses at once, showing the vendor's words |
| **unknown** | anything else (a TypeError, an SDK error with no status) | one transient try a minute later, then permanent |

A paused run shows the step and the error, with **Retry this step** and **Skip this step** for a person. Nothing ever
re-runs a workflow from the top because a step failed. No side effect happens twice on a retry: sends are keyed per
run + node (`sends.idempotency_key`), cards are read live before any write (D41), records are keyed by external id,
notes and tasks go through an effects ledger, tags are idempotent in the CRM. The engine never charges anyone — Whop
does; the engine records (D21).

Today, before that work: a step that throws fails the run for good (`runner.ts:156,183`; the outer catch at
`runner.ts:189-192`), the failed run is one `step:<workflow>:<node>` alert (`alerts.ts:75-83`), and a stopped run's
only way forward is a hand setting it back to `active` — which does resume at the step, never from the top
(`runner.ts:126` starts from `current_node`, which `finish` left on the failed node, `runner.ts:183`). The three D56
exceptions carry on instead of failing: a send the CRM refuses (`executor.ts:126`), a Slack post refused
(`executor.ts:143-150`), and a booking source that cannot be read at the premise (`runner.ts:103-110`, retried every
5 minutes). Nothing is retried in place anywhere except the GHL client's own two 429 waits (`client.ts:19`) and the
premise.

## Could duplicate

**Closed by D66** (the retry work; `engine/00-decisions.md`): C1 `send_document` claims a `step_effects` row before the
send; C2 the card create claims one and `pipeline_cards.created_by_run` names the run, with the D41 read first and a
hand's later move winning; C3/C4 tasks and notes claim one; C5 the record create claims one and a done claim becomes
an update; C6 `update_appointment` emits once per (run, step, appointment, status); F1 a `failed` send row is reclaimed
by the retry; F2 a contact with no CRM id pauses as such, never gone; F3 Jev throws on 401/403/429/5xx. The `it.fails`
tests below are plain `it` now. The **What happens** column is kept as the record of what the code did before.

Where today's code, or a retry written without a ledger, could produce one of the owner's four bugs. Ranked by how
bad the duplicate is.

| # | Bug class | Where | What happens | Shown by |
|---|---|---|---|---|
| C1 | **messages someone twice** | `executor.ts:205-207` (`send_document`) | `sendDocumentTemplate` sends the agreement to the customer, then `recordSentByEngine` writes our row. There is no `sends` row for a document, so a crash between the two (or any retry of the step) sends the agreement again. Every other contact-facing send writes its ledger row first (`executor.ts:109`). | `not yet` (no document probe; the adapter body is itself unverified, `write.ts:24`) |
| C2 | **creates a second card** | `executor.ts:435-437` | `createOpportunity`, then the replica insert. A crash between leaves a card the replica does not know. A retry is saved only by the D41 read at `:403` — and the CRM's search index lags a create by a few seconds (`cards.ts:336-337`), so a retry inside that window makes a second card. The 1-minute first retry is outside the window; a hand retry seconds later is not. | `20 cards (crash after the CRM made the card)…` ×2 (one passing invariant, one `it.fails` for the adoption) |
| C3 | **a second task** | `executor.ts:221` (`notify_owner`, before its `recordSend` at `:228`) and `:493` (`create_task`) | No ledger for tasks. Today a crash after `createTask` fails the run, so one task; the moment the step is retried (by hand today, by policy tomorrow) a second task is made in the CRM. | `notify_owner whose task is made…` ×2; `a task whose call dies…` |
| C4 | **a second note** | `executor.ts:369` | Same shape: `addNote` with no ledger; a retry writes the note twice on the contact. | `a note whose call dies…` ×2; `a note the CRM refuses with 503…` |
| C5 | **a second custom-object record** | `executor.ts:454-458` | `createRecord`, then the `crm_records` upsert that remembers the CRM id. A crash between loses the id; the retry sees no `existing` row (`:450`) and creates again. "Keyed by external id" only holds once the row exists. | `a record made in the CRM, then the call dies…` (invariant); `a custom-object record the CRM refuses with 503 twice…` (`it.fails`) |
| C6 | **a second event, so a second downstream run** | `executor.ts:388-395` (`update_appointment`) | The CRM write at `:388`, then our status update at `:390` and a fresh `appointment.status_changed` at `:393` dispatched at `:395`. A crash between the write and the emit means the retry writes the same status again (harmless) and emits again — a second dispatch. The workflows that listen are reentry-keyed per appointment, so a second run is mostly refused (`dispatch.ts:276`); an `always` listener would run twice. | `not yet` |
| C7 | **20 runs** | `dispatch.ts:260,274-277` | A run per event for `always` workflows is by design (two payments are two facts, G4). The door to 20 runs is a source re-delivering one fact as 20 events: the contacts poll did exactly that until D65 (nine New lead runs for one person); webhooks dedupe by delivery id (`webhook_deliveries`); the premise and the runner never restart a run. | `20 runs: the same lead.created delivered twice…` (reentry); D65's test |
| C8 | **20 charges** | — | No adapter moves money (`adapters/types.ts:66-81` has no such method; nothing under `src/adapters/` mentions a charge); payments are recorded `on conflict (company, provider, whop_payment_id) do nothing` (`payments.ts:129-133`), and a redelivered payment is `duplicate` (`lifecycle.ts:473-476`). | `20 charges: the engine has no way to move money…` |

### Other findings (not duplicates, but wrong)

| # | Where | What |
|---|---|---|
| F1 | `executor.ts:109-110` | The send ledger is written **before** the vendor call (good: a crash after the CRM accepted is skipped as `already sent`), but the same row blocks a retry after a **refused** send: the row sits at `failed`, the retry's insert conflicts, the step is skipped `already sent (idempotency)` and the text never goes. The retry work must reopen or replace the failed row before asking the CRM again, or the policy's send retry is a no-op. Shown by `20 messages (503 twice, then ok)…` (`it.fails`). |
| F2 | `executor.ts:116,124` + `:130` | A contact with no CRM id yet (a form lead the poll has not matched) reaches `doSend` with `ghl_contact_id!` undefined; the CRM is asked about contact `undefined`, answers "not found", `contactGone` matches it, and the person is stamped `gone_at` — every run about them exits `moot: contact gone`. Shown by `a contact with no CRM id yet is not a contact the CRM has lost…` (`it.fails`). |
| F3 | `classifier.ts:36` | Every HTTP failure from Jev (401 on a dead key, a 5xx, a 429) is returned as `unclear, confidence 0`. The engine cannot tell "the key is dead" from "the reply is vague": a rotated key routes every reply to a human for as long as nobody notices, with no alert (the health sweep's `jevPing` is the only thing that would say). A network error at `classifier.ts:18` is the opposite: it throws, and the run fails. Shown by `Jev is down (5xx) or refuses the key (401)…` (`it.fails`). |
| F4 | `runner.ts:122` | The card read before the context is built is warn-only (`.catch(console.warn)`), so with the CRM down a step reads `cards.*` from a stale replica and decides on it. The step's own read (`executor.ts:403`) fails the run instead. Two answers to one outage. |
| F5 | `executor.ts:318,321,325,326` | Reactions on a Slack post swallow every error (`.catch(() => false)`): a rotated token mid-step leaves the post up with no offered reactions, and the `wait_for_reaction` that follows waits for a tap nobody can give. Not a duplicate; a silent dead end. |
| F6 | `write.ts:59-66` | `updateAppointment` is a GET then a PUT. A 404 on the GET (the booking was deleted at the source between the premise and the step) throws like any permanent error; a transient error on the PUT after a good GET is a plain retry. Fine, but the premise's "deleted at the source → exit" (`runner.ts:36`) is the better answer and only runs at claim time. |

## Inputs that shape every run

The person, the booking and the company's mode decide what a step can do before any vendor is asked.

| Situation | Expected | Today | Test |
|---|---|---|---|
| Contact with a phone and an email | Every channel open | `context.ts:35-36` reads the first live identifier of each kind | every passing send test |
| Contact without a phone | A text step is a `noop` with `no phone on the contact`, the send row `suppressed`, the CRM never asked, the run goes on (G11, D60) | `executor.ts:106-108`: exactly that | `no phone on the contact…` |
| Contact without an email | Same for the email step | `executor.ts:106-108` | `no email on the contact…` |
| Contact with neither | Both suppressed; New lead parks on its phone check up to a day (`new-lead.json` n1 `retry`) | `executor.ts:353-358` | `edge-cases.contacts.test.ts › a lead with no phone and no email…` |
| Contact with no name | Greeting says "there"; a card is named by email, then phone, then CRM id (G13) | `executor.ts:409-411`; the templates' `default:there` | `edge-cases.contacts.test.ts › an empty name…` |
| Contact with no CRM id (a form lead the poll has not matched yet) | A CRM write step pauses with "no CRM id yet" (or waits for one, as New lead waits for a phone); a send is skipped with the reason; nobody is stamped gone | Tags `executor.ts:161`, document `:204`, card `:434`, contact `:479`, task `:492` all **fail the run** with `contact has no CRM id yet`; a send asks the CRM about `undefined` and marks the person gone (F2) | `a contact with no CRM id yet: a tag step pauses…` (`it.fails`); `a contact with no CRM id yet is not a contact the CRM has lost…` (`it.fails`) |
| Contact deleted or merged in the CRM mid-run | The first send the CRM refuses with "not found" stamps `gone_at`, one alert per contact, the run exits `moot: contact gone` at its next look; nothing is sent after (G21, D60). Once, not per step. | `executor.ts:124,130-140`; premise `runner.ts:28` | `the contact is deleted in the CRM mid-run…` |
| Contact deleted, seen first by a tag / note / card write (404) | Same as the send: stamp gone, one alert, exit moot — never a failed run | A 404 from any write other than a send throws and **fails the run** (`executor.ts:163,369,429,435,480,493`) | `404 on a tag write…` (`it.fails`) |
| Appointment cancelled mid-run | The poll wakes every run parked on the appointment (`poll.ts:197`); the premise `appointment_in_future` exits `moot: appointment cancelled`; `appointment_exists` runs on (cancellation rebook is about the cancellation) | `runner.ts:35-44` reads the source live at every claim | `engine.integration.test.ts › premise check…`; `templates.scenarios.test.ts › cancellation-rebook…` |
| Appointment rescheduled mid-run | A wait anchored on the appointment recomputes from the new start (D20); a wait anchored on now is pinned | `executor.ts:184-192`; `poll.ts:194,197` | `funnel.e2e.test.ts › reschedule → …` |
| Appointment deleted at the source mid-run | Exit `moot: appointment deleted at the booking source` | `runner.ts:36` | `engine.integration.test.ts › premise check…` |
| Booking source unreachable at the premise | Waiting, retried every 5 minutes, one alert per company that resolves itself (G2, D56) | `runner.ts:103-110,194` | `edge-cases.test.ts › the CRM is down…` |
| Company in shadow | The CRM is read (cards first, D41) and never written; sends are `shadow` rows; Slack posts go, labelled; the replica card has no CRM id | `executor.ts:59,111-115,157-160,208,387,429,433,457,478,491`; `runner.ts:119-122` | `shadow: the CRM is read…` |
| Company in test | Everyone's run starts; a contact who does not pass runs as in shadow, one who does runs for real (D52 addendum 2) | `mode.ts:37` decides once per claim, `runner.ts:119` | `mode.test.ts › test: …` |
| Company live | Everything real | — | every passing test here |

## send_sms / send_email

`executor.ts:82-127`. The ledger row (`sends`, key `<run>:<node>`) is written **before** the CRM is asked
(`:109`); the real sender catches the CRM's refusal and answers `accepted: false` with its words (`sender.ts:10,16,22`),
so a refusal is never an exception.

| Situation | Expected | Today | Test |
|---|---|---|---|
| The CRM accepts | `sent`, external id kept, `message.sent` event | `executor.ts:120-122` | every passing send test |
| 503 / 502 / 500 / 429 / network from the CRM (transient) | Retry the step in place at 1, 5, 15, 60 min; the text goes once; one `sent` row for the step | The refusal is written `failed`, the step is `skipped` as `blocked` (one `blocked:` alert), the run walks on (`executor.ts:126`, D56/G1). **Never retried, so the text never goes.** And F1: the failed row would block a retry. | `20 messages (503 twice, then ok)…` (`it.fails`); invariant `20 messages, the invariant that holds today…` |
| 401 / 403 (token rotated) | Pause at once; one alert for the CRM; woken when the token is replaced | Same as above: written, blocked, walks on — and every CRM step after it fails the same way, each its own alert | `401 on a send…` (`it.fails`) |
| 400 / 422 (the number is invalid, the sub-account has no SMS number) | **Policy:** pause with the vendor's words. **D56/G1:** write the refusal, skip as blocked, carry on to the emails. Decide. | D56: `executor.ts:126` | `400 on a send…` (`it.todo`) |
| 404 / "Contact with id … not found" | Stamp `gone_at`, one alert per contact, exit `moot` at the next look | `executor.ts:124,130-140` | `the contact is deleted in the CRM mid-run…` |
| The CRM accepted, then the call died before the ledger update | The retry finds the `queued` row and skips the step `already sent (idempotency)`; exactly one text | Row stays `queued`, run failed (`runner.ts:156`); one text; a hand retry skips it correctly (`executor.ts:110`) | `20 messages (crash after the CRM accepted…)…` ×2 (invariant passes, recovery `it.fails`) |
| No phone / no email on the contact | Suppressed, `noop`, the CRM never asked (G11) | `executor.ts:106-108` | `no phone…`, `no email…` |
| Company has no SMS number (`sms_enabled=false`) | Suppressed `sms_disabled`, `noop` | `executor.ts:84` | `the company has no SMS number…` |
| Dark hours | The step waits for the window; a transactional one goes at once when the company allows it | `runner.ts:144-148` | `waitrule.test.ts`; `edge-cases.test.ts` |
| Recovery after an outage | Sends dripped, 20 per company per tick | `runner.ts:149` | `not yet` |
| Stale (past the validity deadline) | `on_stale: skip` → `stale` row; `escalate` → paused; `substitute` → the other copy | `executor.ts:85-92,100-101` | `templates.scenarios.test.ts`; `edge-cases.test.ts › G7` |
| Template names a CRM snippet that cannot be read | The inline copy is used (the snippet read is `.catch(() => null)`) | `executor.ts:96` | `not yet` |
| A placeholder the context cannot name | `failed` with the path (a copy bug, not a vendor error) → should pause as permanent | `executor.ts:102` | `not yet` |
| Contact with no CRM id | Skip with the reason, never ask the CRM, never stamp gone | F2: the CRM is asked about `undefined`, the person is stamped gone | `a contact with no CRM id yet is not a contact the CRM has lost…` (`it.fails`) |
| Shadow | `shadow` row, `message.sent {shadow:true}`, nothing leaves | `executor.ts:111-115` | `templates.scenarios.test.ts › shadow mode…` |

## send_document

`executor.ts:198-209`. The one contact-facing send with no `sends` row (C1).

| Situation | Expected | Today | Test |
|---|---|---|---|
| Sent | Our agreement row written with the document id | `executor.ts:205-207` | `poll.agreements.test.ts` |
| Transient / auth / permanent from the CRM | Per policy; **a retry must not send a second document** — write a ledger row first | Throws → run failed; a retry sends again (C1) | `not yet` |
| Template binding empty | Pause (configuration) | `failed` (`:202`) | `not yet` |
| No CRM id on the contact | Pause with the reason | `failed` (`:204`) | `not yet` |

## slack_post

`executor.ts:290-330`. The ledger row is written before the post (`:310`); the notifier throws `slack: <error>` on a
refusal (`notifier.ts:16`), caught by `slackPostOrFail` (`:143-150`).

| Situation | Expected | Today | Test |
|---|---|---|---|
| Posted | `sent` with the ts; `vars.__slack.<node>` remembers it; a `tag:` is upserted into `slack_posts` | `executor.ts:315-316,328` | `slack.post.test.ts` |
| `invalid_auth` / `account_inactive` / `token_revoked` (auth) | **Policy:** pause, one alert for Slack, woken on a new token. **D56/G8:** write `failed`, skip as blocked, carry on (the CRM steps after a post are the point of the run). The decision stands on carrying on; the alert should be one per vendor, not one per step. | Carries on; one `blocked:<wf>:<node>` alert per step (`alerts.ts:85-92`) | `Slack refuses the token (invalid_auth)…` (passes, D56); `…two steps in one run are one alert for Slack…` (`it.fails`) |
| `ratelimited` / 5xx / network (transient) | Retry in place; the post goes once | Treated exactly like a refusal: written failed, never retried | `Slack says ratelimited (transient)…` (`it.fails`) |
| `channel_not_found` / `not_in_channel` (permanent) | Write failed, skip as blocked, carry on (D56); one alert naming the channel | Same path as any refusal | `edge-cases.test.ts › Slack refuses the bot token…` (G8) |
| Slack not connected | Suppressed `unbound: slack`, run continues | `executor.ts:299` | `templates.scenarios.test.ts › payment-failed…` |
| Channel binding unbound, no fallback | Suppressed `unbound: slack channel`, a warning alert | `executor.ts:296,299` | `alerts.test.ts › a step that could not run (Slack channel not bound)…` |
| Thread parent missing (`thread_only`) | `noop: nothing to react to` | `executor.ts:309` | `templates.scenarios.test.ts` (D45 lines) |
| A `tag:` anchor the context cannot name | Posts to the channel, says so | `executor.ts:305` | `edge-cases.test.ts › two payments…` (G4) |
| Posted, then the call died before the ledger update | The retry finds the `queued` row and skips `already posted (idempotency)` | `executor.ts:310` | `not yet` |
| Reactions (`offer`, `react`, `unreact`, `react_on`) refused | Say so in the step result; a post with no offered reactions should still be a tap target (F5) | Every reaction error is swallowed to `false` (`:318-326`) | `not yet` |
| @mention lookup refused (not `users_not_found`) | Post without the mention | `resolveMentions` catches to null (`:33`) | `not yet` |

## notify_owner

`executor.ts:210-233`. The task is made at `:221` **before** the ledger row at `:228` (C3).

| Situation | Expected | Today | Test |
|---|---|---|---|
| Owner in Slack | DM, `sent` | `:229-232` | `templates.scenarios.test.ts › agreements (D30)…` |
| Owner not in Slack, fallback channel | Channel post with the owner's name in bold | `:226,230` | same |
| Neither | Suppressed `unbound`, run continues | `:227` | same |
| Task `createTask` transient | Retry in place; **one task** (effects ledger) | Throws → run failed; the ledger row was never written; a retry makes a second task (C3) | `notify_owner whose task is made and then the call dies…` ×2 |
| Task `createTask` 401 / 400 | Pause per class | Throws → failed | `not yet` (same path as `create_task` below) |
| Post refused after the task was made | Task stays, post `failed`, run continues (D56) | `:230` | `not yet` |

## set_tag / remove_tag / tags

`executor.ts:153-168`, `write.ts:9-10`. The CRM write first, then the replica, then one event per direction. Tags are
idempotent in the CRM (adding an existing tag, removing an absent one, both succeed), so a retry is safe by nature.

| Situation | Expected | Today | Test |
|---|---|---|---|
| Added / removed | Replica follows at write time so the next poll sees no delta; `tag.added` / `tag.removed` | `:163-165` | `templates.scenarios.test.ts`; `new-lead` tests |
| 401 / 403 | Pause at once; one alert for the CRM (two runs, two workflows: still one alert) | Throws → run failed; one `step:` alert per workflow+node (`alerts.ts:81`) | `401: the run pauses at the step…` (`it.fails`) |
| 400 / 422 | Pause with the vendor's words; asked once | Failed; asked once | `400: never retried…` (passes); `400: the run pauses…` (`it.fails`) |
| 404 (the contact is gone) | Stamp gone + exit moot, as a send does; never failed | Failed | `404 on a tag write…` (`it.fails`) |
| 429 | Transient (the client already waited 1.5 s and 3 s, `client.ts:19`); retry at 1 min | Failed | `429 (the client already waited…)…` (`it.fails`) |
| 503 / 502 / 500 | Retry at 1, 5, 15, 60 min, then pause; five calls in all | Failed on the first | `503 that never clears…` (`it.fails`) |
| Network (ECONNRESET, timeout) | Transient | Failed | `a network error (ECONNRESET, no status)…` (`it.fails`) |
| Unknown (a TypeError in the adapter) | One try a minute later, then pause | Failed at once | `an error nobody classified…` (`it.fails`) |
| Stopped run retried by hand | Resumes at the tag step; the trigger ran once; the tag went on once | Exactly that (`runner.ts:126`, `:183`) | `a stopped run retried by hand resumes at the step…` |
| Several tags, the second write fails | The first tag is on in the CRM and on the replica? No: the replica loop runs after the whole CRM loop (`:163-164`), so the replica knows none of them; the next poll corrects it. A retry re-adds the first (idempotent). | As described | `not yet` |
| Contact with no CRM id | Pause / wait with the reason | Failed `contact has no CRM id yet` (`:161`) | `a contact with no CRM id yet: a tag step pauses…` (`it.fails`) |
| Shadow | Events only; neither the CRM nor the replica | `:157-160` | `templates.scenarios.test.ts › shadow mode…` |

## pipeline_card

`executor.ts:398-442`, `cards.ts`. The CRM is read first, always (`:403`, D41): a card made by anything else is adopted
and moved, never duplicated. "Already there" is no write (`:420`, D61). Create at `:435`, the replica row at `:437` (C2).

| Situation | Expected | Today | Test |
|---|---|---|---|
| No card on the board, step has a stage | One card created in the CRM, one replica row, `opportunity.opened` when the person had none | `:422-426,432-437` | `the closer closed the card by hand…` (the fresh card); New lead tests |
| Card is already on the board in another column (a hand, a CRM workflow) | Adopted, moved; nothing created | `cards.ts:355-360` adopts, `:429-430` moves | `the setter card is already on the board in another column…` |
| Card already where the step would put it | `noop: already there`, no CRM write | `:420` — only when the step has no fields / owner to stamp; New lead's n2 stamps a date, so it writes every time | `the card is already where the step would put it…` |
| Two open cards on the board | One is moved (the CRM-known, newest), the other left alone, nothing created. Which one is "newest" is the replica's `updated_at`, and two cards adopted in one read share a timestamp (`cards.ts:375`) — the pick is then arbitrary but stable | `pickCard` | `two open cards on the same board…` |
| Card missing, `if_missing: skip` | `noop`, nothing created | `:415` | `no card and the step says if_missing: skip…` |
| Status-only step (mark lost), no open card | `noop: no open card on this board to mark lost` | `:416` | `a status-only step…` |
| The closer closed the card by hand (won / lost) | History; a step with a stage makes a fresh open card; a status the closer set is never changed | `pickCard` picks `status='open'` only | `the closer closed the card by hand (won)…` |
| The closer moved the card by hand since the engine last wrote it | The run's read sees the hand (`card.moved`, a thread line, an outcome filed for the stages that name one, D61); then **the step files where it files** — a retry after a hand move puts the card back. Whether that is right is a template question (see "Could not pin down"). | `cards.ts:350-353` → `handMoved`; the step moves it (`:429`) | `a card the closer moved by hand since the engine last wrote it…` (asserts the event and no new card only) |
| The CRM cannot be read (503 / network at `openCards`) | Transient: retry in place; one card when it answers | `failed: could not read the contact's cards` (`:404`); the runner's earlier read is warn-only (F4) | `the CRM cannot be read for the contact's cards (503)…` (`it.fails`) |
| `openCards` 401 | Pause, one alert for the CRM | Failed | `not yet` (same path as the 503) |
| `createOpportunity` 503 twice then ok | Retry at 1 then 5 min; one card; run completes | Failed on the first; no card | `20 cards (503 twice, then ok)…` (`it.fails`); invariant passes |
| `createOpportunity` succeeded, then the call died | The retry reads the CRM, adopts the card, completes; one card both sides | Failed; one card in the CRM, none in the replica; a retry inside the CRM's index lag could create a second (C2) | `20 cards (crash after…)…` ×2 |
| `createOpportunity` 400 / 422 (a stage id that is not on that pipeline, a bad custom field id) | Pause with the vendor's words | Failed | `not yet` (same path as the tag 400) |
| `updateOpportunity` 404 (the card was deleted between the read and the write) | The replica card is marked `gone` and the step makes one fresh card, once (effects ledger); a move-only step skips | Done (sweep 2026-10-10, S12) | `the card was deleted in the CRM between the read and the write…`; `a card deleted in the CRM since an earlier run…` |
| Pipeline / stage binding unresolved | Pause (configuration) | `failed: pipeline, stage or name unresolved` (`:417`) | `not yet` |
| Run not about a contact | Pause (definition) | `failed` (`:401`) | `not yet` |
| Contact with no CRM id | Pause / wait | `failed` (`:434`) | `not yet` (same words as the tag step) |
| The CRM's search index lags the create | A snapshot older than our last write is ignored; rows never dropped on absence | `cards.ts:350` | `not yet` |
| Shadow | Read, never written; replica card with no CRM id; a live card on the same board outranks it | `:429,433`; `cards.ts:375` | `shadow: the CRM is read…` |

## crm_record

`executor.ts:443-468`, `write.ts:29-39`. Keyed by `(object, record_key)` in `crm_records`; the CRM id is learned
from the create and remembered at `:456` (C5). `relateRecords` swallows 400 / 409 as "already related" (`write.ts:38`).

| Situation | Expected | Today | Test |
|---|---|---|---|
| New key | Created, our row carries the CRM id, `record` in the context | `:454,456-459` | `payments.test.ts`; `templates.scenarios.test.ts` |
| Known key | Updated in place; properties merged on our row | `:453,457` | same |
| `createRecord` transient (503 ×2 then ok) | Retry in place; created once; our row carries the id | Failed on the first | `a custom-object record the CRM refuses with 503 twice…` (`it.fails`) |
| Created, then the call died before our row | The retry must not create again (C5): remember the id before anything else, or look the record up by key in the CRM | Failed; a retry creates a second | `a record made in the CRM, then the call dies…` (invariant) |
| `updateRecord` 404 (the record was deleted in the CRM) | Pause with the words; asked once. (Or: forget the id and re-create — a decision) | Failed | `the record our row points at was deleted in the CRM…` (`it.fails`) |
| Missing association (`relateRecords` 404 / a bad association id) | Pause with the words | Throws → failed (`write.ts:38` lets everything but 400/409 through) | `not yet` |
| Association already exists (400 / 409) | Swallowed, `related` still listed | `write.ts:38` | `not yet` |
| Object or key rendered empty | Pause (configuration) | `failed` (`:445`) | `not yet` |
| 401 / 400 on the create | Per class | Failed | `not yet` (same path as the tag step) |

## create_task

`executor.ts:486-495`. No ledger (C3).

| Situation | Expected | Today | Test |
|---|---|---|---|
| Made | `task_id` in the result | `:493-494` | `call-booked` tests |
| Transient / auth / permanent | Per class; **one task** across retries | Throws → failed; a retry makes a second | `a task whose call dies after the CRM made it…` (invariant) |
| Contact with no CRM id | Pause / wait | `failed` (`:492`) | `not yet` |
| Shadow | `would_create_task` | `:491` | `templates.scenarios.test.ts › shadow mode…` |

## note

`executor.ts:365-371`. No ledger (C4).

| Situation | Expected | Today | Test |
|---|---|---|---|
| Written | ok | `:369` | `templates.scenarios.test.ts` |
| 503 | Retry in place; written once | Failed | `a note the CRM refuses with 503…` (`it.fails`) |
| Written, then the call died | One note across retries | Failed; a retry writes a second | `a note whose call dies…` ×2 |
| 401 / 400 / 404 | Per class | Failed | `not yet` |
| Contact with no CRM id | Pauses "note: contact has no CRM id yet"; the CRM is never asked (fixed in the sweep of 2026-10-10; was: asked for `/contacts/undefined/notes`) | `executor.ts` note | `a note for a contact with no CRM id yet…` |

## update_contact

`executor.ts:469-485`, `write.ts:12-18`. The replica learns what was written (`:483`).

| Situation | Expected | Today | Test |
|---|---|---|---|
| Written | Replica updated so a later step in the same minute reads it | `:480-483` | `call-booked` tests |
| Every value rendered empty | `noop: nothing to write` | `:477` | `not yet` |
| 503 | Retry in place | Failed | `update_contact the CRM refuses with 503…` (`it.fails`) |
| 401 / 400 / 404 | Per class | Failed | `not yet` |
| Contact with no CRM id | Pause / wait | `failed` (`:479`) | `not yet` |
| A `clear` the CRM accepts and ignores (some field types) | Noted in the template; nothing to do | `:472` | `not yet` |

## update_appointment

`executor.ts:372-397`, `write.ts:54-67` (read then write, always). `pending_read` is our column and is written whatever
the source and the mode (`:379-383`).

| Situation | Expected | Today | Test |
|---|---|---|---|
| GHL appointment, status changed | CRM written, our row updated, one `appointment.status_changed` (the poll then sees no delta), runs parked on the call woken | `:388-395` | `pre-call` tests (`templates.scenarios.test.ts`) |
| Calendly appointment | Read-only: `skipped: true` with what would have been written, run goes on | `:386` | `a Calendly booking is read-only to the engine…` |
| GHL 503 on the PUT | Retry in place; written once | Failed | `a GHL appointment write the CRM refuses with 503…` (`it.fails`) |
| GHL 404 on the GET (deleted at the source since the premise) | Exit moot (the premise's answer), not a failed run | Throws → failed | `not yet` |
| 401 / 400 | Per class | Failed | `not yet` |
| Written, then the call died before our row / the event | Idempotent write; **one** `appointment.status_changed` (C6) | Failed; a retry emits a second | `not yet` |
| No appointment on the run | Pause (definition) | `failed` (`:373`) | `update_appointment on a run with no appointment…` (`it.fails`) |
| Shadow | `would_update` | `:387` | `templates.scenarios.test.ts › shadow mode…` |

## classify

`executor.ts:332-342`, `classifier.ts:24-45`. The adapter never throws on an HTTP failure (F3); it throws on a network
failure (`classifier.ts:18` has no catch).

| Situation | Expected | Today | Test |
|---|---|---|---|
| Confident, unambiguous | The value in `into`, `reply.confidence`, `reply.classified` | `:337,340` | `pre-call` tests |
| Low confidence, or a careful person would doubt it | `unclear`; the run goes on to the human path (D13/D47) — not an error | `classifier.ts:43` | `a reply the classifier is not sure about…` |
| Jev 5xx / 429 / timeout | Transient: retry in place | Answered `unclear, 0` (F3): routed to a human, no alert | `Jev is down (5xx) or refuses the key (401)…` (`it.fails`) |
| Jev 401 (dead key) | Pause, one alert for Jev, woken on a new key | Same: `unclear, 0`, forever, silently | same test |
| Jev network error | Transient | Throws → run failed (`classifier.ts:18`, no try at `:335`) | `not yet` |
| No key bound | `unclear, 0` (documented: "without a key every call returns unclear") — should be a readiness blocker for a template that classifies | `classifier.ts:29` | `not yet` |
| Empty transcript / reply | `noop: nothing to classify`, Jev never asked | Jev is asked about an empty text | `an empty transcript / reply…` (`it.fails`) |
| `core_categories` has no rows for the domain | Jev is asked with no options → `unclear`. Should pause (definition) | `:334` | `not yet` |

## analyze

`executor.ts:502-525`, `analyst.ts:15-35`. The SDK throws (`APIError` with `status`); the step catches only when
`optional` (`:513`).

| Situation | Expected | Today | Test |
|---|---|---|---|
| Answered | Vars set, `recordings.analysis` merged, `call.analyzed` | `:517-521` | `recordings.test.ts`; `call-recorded` tests |
| Anthropic 529 / 503 / 429 (transient) | Retry in place; read once | Not optional: throws → failed. Optional: skipped as blocked (the value is missing downstream) | `analyze when the model is down (529 / 503)…` (`it.fails`); `analyze marked optional when the model is down…` (passes) |
| Anthropic 401 (dead key) | Pause, one alert for Anthropic | Failed (optional: blocked) | `analyze when the key is refused (401)…` (`it.fails`) |
| No key bound | Pause (configuration); optional: blocked | `soft("no Anthropic key")` (`:506`) | `not yet` |
| Over length: the answer was cut at `max_tokens` | Step ok, `parsed: false` with `parse_error: cut off at max_tokens`, the prompt's JSON closed at its last complete value (`analyst.ts:37-42`) | `:515,522-523` | `not yet` |
| Over length: the transcript exceeds the model's context (a 400 from the API) | Permanent: pause with the words; for a transcript, better: analyze the first N tokens and say so | Failed (`:513`) | `not yet` |
| The model declined (`refusal`) | `failed: the model declined` → should pause as permanent | `:514` | `not yet` |
| Empty input (no transcript) | `noop: nothing to analyze` | `:510` | `analyze with nothing to read (empty input)…` |
| Prompt rendered empty | Pause (configuration) | `soft(...)` (`:508`) | `not yet` |
| Shadow | Runs: seeing what the AI would say is the point of shadow | `:503` | `not yet` |

## wait / wait_for_reply / wait_for_reaction

`executor.ts:179-195, 235-263, 265-288`. No vendor; the clock and the ledger.

| Situation | Expected | Today | Test |
|---|---|---|---|
| Wait anchored on the appointment, appointment moves | Recomputed from the new start at every wake (`stay`) | `:184-194` | `funnel.e2e.test.ts` |
| Wait anchored on now, re-evaluated | Pinned in `vars.__wait.<node>.until`; never slides | `:189-191` | `not yet` directly |
| Wait lands in dark hours | Deferred into the window | `:189` | `waitrule.test.ts` |
| Wait already past (a reminder computed for a call that is sooner than the rule) | `ok` at once with `waited_until` | `:193` | `590be44` (a call before 9am) |
| A zone the contact carries that Luxon cannot use | Company zone (G20) | `context.ts:38`, `:57` | `edge-cases.contacts.test.ts › a garbage time zone…` |
| `wait_for_reply`: a reply before the send | Not counted: the boundary is our last contact-facing send in this run | `:238-239` | `engine.integration.test.ts` |
| `wait_for_reply`: a reply in pieces | Settles `settle` after the newest; a further reply restarts the clock (D47) | `:245-246` | `templates.scenarios.test.ts › D47…` |
| `wait_for_reply`: timeout with no `timeout` edge | Exit `no_reply` | `:262` | `speed-to-lead` tests |
| `wait_for_reply`: the deadline persists across an outage | Pinned in `vars.__wait_for_reply.<node>.deadline`; the `until` rule caps it (G7) | `:252-259` | `edge-cases.test.ts › a call booked two hours out…` |
| `wait_for_reply`: wake by an inbound message only | `wake_on_reply` runs only (`poll.ts:236`) | `runner.ts:161` | `templates.scenarios.test.ts › an inbound text wakes a reply-wait but not a timed wait…` |
| `wait_for_reaction`: the post is not in Slack | `noop: nothing to tap` | `:270` | `not yet` |
| `wait_for_reaction` (blocking): a tap before the wait armed | Found in `events` by channel + ts, counted | `:279-281` | `slack.test.ts` |
| `wait_for_reaction` (blocking), no timeout | Waits with no `until`: only a wake moves it. A dead end when Slack later refuses the reactions (F5) | `:285` | `not yet` |
| `wait_for_reaction` (listener, D58): fires while the run is parked elsewhere | Jump to the `tap` / `until` edge, `resume` returns | `runner.ts:128-136`, `:141` | `templates.scenarios.test.ts › D58…` |
| Clock: the tick is late by an hour (outage) | Recovery: premise first, stale exits, dripped sends | `runner.ts:64,113,149` | `not yet` |
| Clock: the DB clock, not JS, decides due-ness | `next_run_at <= now()` in SQL | `runner.ts:69` | `not yet` as a test |

## check / branch

`executor.ts:344-360`.

| Situation | Expected | Today | Test |
|---|---|---|---|
| `check` on a path the context cannot name | Not met → gate exit (no error, D30: the once-per key is released) | `predicate.ts:32` → `exists` false; `:359` | `a check on a path the context cannot name…` |
| `check` with a filtered value (`{{appointment.starts_at \| date:HH}}`) that does not render | `operand` returns undefined → not met | `predicate.ts:17-18` | `not yet` |
| `check` with `retry`: parks and looks again | Waiting on the node every `every` until `for` | `:353-358` | `edge-cases.contacts.test.ts › a lead with no phone and no email…` |
| `branch`: no edge matched, no else | A definition problem: pause with the reason (permanent) | `failed: no edge matched and no else` (`:348`) | `a branch with no matching edge and no else…` (`it.fails`) |
| `branch`: a `when` that throws (a template error other than an unknown path) | Pause as permanent | Throws → failed | `not yet` |
| A node with no outgoing edge | Definition problem → pause | `failed: has no outgoing edge` (`runner.ts:184`) | `not yet` |
| 50 steps in one tick | `failed: exceeded 50 steps` → should pause as permanent (a loop) | `runner.ts:187` | `not yet` |

## record

`executor.ts:595-601`. Bookkeeping never fails a run.

| Situation | Expected | Today | Test |
|---|---|---|---|
| A field whose path is not in the context | Lands as null, the rest kept | `:598` | `record never fails a run…` |
| An event type the table does not know | The insert throws (`events.event_type` references `event_types`) → failed. A definition problem; readiness should catch it | `dispatch.ts:247` | `not yet` |

## health_check / availability_check / report

`executor.ts:565-586`, `health.ts`. Probes catch their own vendor errors and turn them into findings; nothing here
retries, and nothing should (the hourly sweep is the retry).

| Situation | Expected | Today | Test |
|---|---|---|---|
| A probe cannot reach its vendor | A finding, not a failed run; the alert says what could not be read | `health.ts:79,95,104,149,168,186` catch to findings | `health.test.ts` (various) |
| The CRM 401 at the token probe | Finding `ghl_token` error; the same alert the auth class would raise for a step — these should be one alert (`health` and `step` sources today both say "token") | `health.ts` | `not yet` |
| `availability_check` on a company with no calendars | `calendars: 0`, nothing raised | `health.ts` | `not yet` |
| `report` with an unknown kind | Pause (definition) | `failed` (`:580`) | `not yet` |
| `report`: `buildReport` throws (a SQL error) | Unknown → one retry then pause | Throws → failed (`:583`, no catch) | `not yet` |
| `report`: a Slack post of the report refused | The report row exists (`reports.id`); the post is the ordinary `slack_post` path | — | `reports.test.ts` |

## webhook

`executor.ts:538-564`. The ledger row before the call (`:548`), a 20 s timeout (`:550`), `on_error: skip` or `fail`.

| Situation | Expected | Today | Test |
|---|---|---|---|
| 2xx | `sent`, the body in `vars.<into>` | `:554-557` | `not yet` |
| 5xx / timeout (`on_error: fail`) | Transient: retry in place; the receiver sees one call per attempt (the ledger says `failed` between) | `failed` (`:556,562`); `skip` → blocked, carry on | `not yet` |
| 4xx | Permanent: pause with the receiver's words | `failed` / `skip` | `not yet` |
| Called, then the call died before the ledger update | The retry finds the `queued` row → `already called (idempotency)` | `:548` | `not yet` |
| Secret in the URL | Masked in the result and the ledger | `:546` | `not yet` |

## Could not pin down

- **400 on a send** (and `channel_not_found` on a post): the policy says pause; D56 (G1, G8) says write the refusal,
  skip the step as blocked and carry on. Both are defensible; the sends policy should say which. The test is
  `it.todo` until it does.
- **A retry after a hand move**: the step files where it files, so a step retried a minute after the closer dragged
  the card puts it back. D61 says a hand on a card is seen, not that it wins. For stages that name an outcome the
  engine already files the outcome; for the others the template decides. Open.
- **404 on a write other than a send**: pause (the policy's permanent class) or stamp `gone_at` and exit moot (what a
  send does, G21)? The test accepts either; the engine should do the second when the body names the contact.
- **"Retry this step" / "Skip this step"**: no door exists yet; the tests pin what a hand retry does through SQL (back
  to `active` at `current_node`). Skip is the same with `current_node` moved along the onward edge; `not yet`.
- **One alert per vendor**: the key the retry work picks (`auth:ghl`, `auth:slack`, …) is its own; the tests count
  open alerts for the company, not keys.
- **`run_steps.status`** has no `paused` value (`schema.sql:499`); today a paused run's last step row is `ok`
  (`runner.ts:158`). The retry work decides whether a paused step is its own status or a `failed` row with the run
  paused.

## Row counts

Rows per section of this catalogue (the Could-duplicate and Other-findings tables are not counted):

| Section | Rows |
|---|---|
| Inputs that shape every run | 15 |
| send_sms / send_email | 15 |
| send_document | 4 |
| slack_post | 11 |
| notify_owner | 6 |
| set_tag / remove_tag / tags | 12 |
| pipeline_card | 19 |
| crm_record | 9 |
| create_task | 4 |
| note | 5 |
| update_contact | 6 |
| update_appointment | 8 |
| classify | 8 |
| analyze | 10 |
| wait / wait_for_reply / wait_for_reaction | 16 |
| check / branch | 7 |
| record | 2 |
| health_check / availability_check / report | 6 |
| webhook | 5 |
| **Total** | **168** |

Tests in `step-failures.test.ts`, by its `describe` block. A row's test may live in another block (the four bad bugs block
holds the card and send retries), and many rows are proven by tests in other files, named in the row.

| Block | Passing today | `it.fails` | `it.todo` |
|---|---|---|---|
| the four bad bugs | 6 | 4 | 0 |
| how an error is classified (a tag write) | 2 | 8 | 0 |
| pipeline_card | 8 | 2 | 0 |
| send_sms / send_email | 4 | 2 | 1 |
| slack_post / notify_owner | 2 | 3 | 0 |
| note / create_task / crm_record / update_contact | 3 | 5 | 0 |
| classify / analyze | 3 | 4 | 0 |
| update_appointment | 1 | 2 | 0 |
| branch / check / record | 2 | 1 | 0 |
| **Total** | **31** | **31** | **1** |
