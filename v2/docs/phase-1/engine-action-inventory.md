# Engine-action inventory: what today's code does outside a workflow (2026-10-21)

Phase 1 input for ADR 0005 ("every action the engine takes is a workflow step"). This is a read-only survey of `platform/` as
of 2026-10-21, and paths are relative to it. Tyler signs off what becomes a step, what becomes a setting and what stays
platform.

Classes:
- **ENGINE-ACTION:** the engine does it with no workflow step. In v2 it becomes a step.
- **HIDDEN-IN-STEP:** a step does more than it shows. In v2 it becomes its own visible step.
- **BUSINESS-RULE:** a decision written in code. In v2 it becomes a per-offer setting or workflow logic.
- **PLATFORM:** Slack-app behavior or engine plumbing. It stays code, by the rule.

## 1. ENGINE-ACTION: the engine acts with no workflow step

| # | Where | What it does | Started by |
|---|---|---|---|
| E1 | `engine/typeform.ts:202-227` (writes at :146, :156-157) | Creates or updates the GHL contact from a Typeform answer: fields, custom fields, UTMs. Only then does `form.submitted` start "New from Typeform". | Typeform webhook |
| E2 | `engine/scope.ts:152-170`, from `poll.ts:231-233` | Adds the offer's scope tag in GHL to a new booker. D123 moved the Typeform case into a workflow; the booking case never moved. | A new booking on a mapped calendar |
| E3 | `setter-missing.ts:267-285`, from `poll.ts:235` | Raises "setter-booked call with no setter". | A new setter-booked booking without `set_by` |
| E4 | `setter-missing.ts:257-264, 270, 312` | Attributes the setter: a connected dial within `set_within_min` of the booking, or else the Setter field typed later. Re-reads GHL every 5 minutes. | A new booking; every poll |
| E5 | `lifecycle.ts:11-21`, from `poll.ts:241` | Opens a ledger opportunity on the first booking and emits `opportunity.opened`. | A new booking |
| E6 | `payments.ts:97-108` | Opens an opportunity on a payment from someone without one and copies `contract_value_default` onto it. | A payment webhook |
| E7 | `payments.ts:157-160` | Decides "paid in full" (total within 1 cent of the contract value) and dispatches `payment.paid_in_full`. | A payment settles |
| E8 | `payments.ts:127-144` | Relinks earlier unlinked payments with the same member id or email, re-derives their kind, and dispatches `payment.*` for each. | Any linked payment |
| E9 | `payments.ts:174-195`, `deposit-names.ts:48-87` | Reads Whop product names and raises `payment:deposit-unchecked` when it cannot. | A new payment with no names |
| E10 | `poll.ts:86-90, 115, 237`; `ledger-drift.ts:100` | Decides what counts as a new lead and dispatches `lead.created`, including for contacts the drift sweep pulls in. | Poll, booking, health sweep |
| E11 | `executor.ts:255-264`, `contact-truth.ts:217-223`, `runner.ts:193-199` | Marks a contact gone; every run about them then stops. | A 404 from GHL |
| E12 | `executor.ts:229-232` | Marks a contact DND after GHL refuses a text; later texts are skipped silently. | A refused text |
| E13 | `card-moves.ts:140-153`, from `poll.ts:419`, `cards.ts:101`, `runner.ts:172-175`, `executor.ts:1060` | Turns a hand-moved card into `card.moved` about the contact's latest closing call. Any run claim can start "Card moved by hand". | The cards poll; every run claim; every card step |
| E14 | `dispatch.ts:79-86` | Refuses `lead.created` for anyone without the scope tag. | Every lead |
| E15 | `scope.ts:128-143` | Reads GHL live and, when the scope tag is gone, emits `scope.left` so nothing more starts. | Inbound message, call, agreement news |
| E16 | `poll.ts:325`, `dispatch.ts:18`, `poll.ts:273`, `executor.ts:657`, `webhooks/slack.ts:52` | Wakes waiting runs: reply, event, appointment change, tap. | Events (mostly platform) |
| E17 | `alerts.ts:235, 291-295`, `ticks.ts:89-104` | Posts engine alerts to `OPERATOR_WEBHOOK_URL`. | The engine minute (platform, but an outbound webhook) |
| E18 | `install.ts:423-438`, `health/fix/route.ts:21-24`, `typeform.ts:277-292` | Creates webhooks at Fathom, Whop and Typeform. | Install; dashboard fix (setup) |

## 2. HIDDEN-IN-STEP: a step does more than it shows

| # | Where | Hidden effect | Step |
|---|---|---|---|
| H1 | `executor.ts:640-648` | **Cancels the Calendly booking, and Calendly emails the invitee** (D196). It is held in ghost and quiet only, and **is not behind the send lock**: there is no `checkSendLock`, and it is not in the lock's OUTBOUND set (`send-lock.ts:12, 86`). | `update_appointment` |
| H2 | `executor.ts:650-661` | Writes the ledger status, wakes waiters, and dispatches `appointment.status_changed`, which starts the cancellation workflows. | `update_appointment` |
| H3 | `executor.ts:415-432` | Two vendor writes in one step: a GHL task and a Slack DM. | `notify_owner` with `task` |
| H4 | `executor.ts:743-766` | Search, create or update, repoint the GHL id, attach identifiers, sync DND, **add the scope tag**, dispatch `tag.added`. | `ensure_contact` |
| H5 | `executor.ts:862-868` → `health.ts:690-697` → `ledger-drift.ts:48-257` | **Pulls contacts in and fires `lead.created`, which can start Speed to lead and text them.** Also marks contacts gone, rewrites ledger outcomes, and dispatches the `drift.*` events. | `health_check` |
| H6 | `health.ts:444-451, 476-478, 281-282` | Retires duplicate GHL ids, **switches a contact's primary id**, marks contacts gone, links Slack ids. | `health_check` |
| H7 | `health.ts:696, 709`; `alerts.ts:80-87` | Raises and resolves `health:*` alerts. | `health_check`, `availability_check` |
| H8 | `executor.ts:1053-1125` | Reads cards and may dispatch `card.moved`; may open an opportunity; on a 404, **creates a replacement card**. | `pipeline_card`, `update_opportunity` with `card` |
| H9 | `executor.ts:1020-1041` | Dispatches `opportunity.won` / `opportunity.lost`. | `update_opportunity` |
| H10 | `executor.ts:807-825` → `disposition.ts:13-40` | Dispatches `appointment.outcome`, and `call.held` on a show. | `record_outcome` |
| H11 | `executor.ts:311-335` | Every tag written dispatches `tag.added` / `tag.removed`, which starts other workflows. | `tags`, `set_tag`, `remove_tag` |
| H12 | `executor.ts:160-235` | Inside the send: the offer's SMS switch, the GHL snippet replacing the inline copy, the no-address skip, replay suppression, the DND skip, the contact-gone mark. | `send_sms`, `send_email` |
| H13 | `executor.ts:686-690, 829-835, 1135-1143` | Drops unknown properties, adopts a CRM record it did not make (same-minute match), writes associations. | `crm_record` |
| H14 | `executor.ts:46-57` | Looks up Slack users by email and saves their ids. | `slack_post`, `notify_owner` |
| H15 | `executor.ts:275-288` | Re-routes DMs before live, and to `bot.escalate_to` for an unlinked person. | `slack_post`, `notify_owner` |
| H18 | `executor.ts:997-1000` | Pauses every other active run for the contact, across all workflows. | `pause_runs` |

H16 (`send_document` writes the agreements ledger) and H17 (`classify`/`analyze` write `recordings.analysis`) are visible
enough and are ledger only.

## 3. BUSINESS-RULE: decisions written in code

| Where | What it decides |
|---|---|
| `payments.ts:40-47, 33` | Payment kind (deposit, paid in full, balance, installment, refund) from the running total; cleared within $0.01 |
| `deposit-names.ts:13`, `payments.ts:64-67` | Deposit = declared products, else a name containing "deposit" |
| `payments.ts:78-94, 127-129, 166-171` | Who paid: member id, then email, then the last 10 digits of the phone; heal; refunds follow the original payment |
| `recordings.ts:34-37, 74-111, 181-185` | Recording match ladder and its thresholds (120, 15 and 40 minutes, 24 hours); the dialer status vocabulary |
| `poll.ts:160-203` | Self- vs setter-booked; the setter-link UTM convention; the calendar owner overriding the host |
| `poll.ts:221, 253-256, 274-276` | A remake within 60 s keeps its slot; a cancel after the start keeps showed or no-show; `before_start` |
| `poll.ts:56-96`, `typeform.ts:121-123` | Identity: same email or phone means the same person, the newest record is primary, recycled numbers move; match policy |
| `card-moves.ts:147-148` | A hand move is about the latest closing call |
| `context.ts:144-169` | Who the owner, closer and setter are |
| `runner.ts:22, 27, 270-276` | Recovery after a 10-minute gap; 20 sends per offer per tick; **the send window is per offer, not per workflow** |
| `failures.ts:19-21`, `setter-missing.ts:247` | Retry 1 and 5 minutes; hold re-check 15 and 60 minutes; GHL re-read every 5 minutes |
| `eod.ts:328-334`, `ledger-drift.ts:29-30, 146-154` | Deposit filed as "closed" without a deposit outcome; what "pending" means; drift window 7 days, lag 30 minutes |
| `executor.ts:909` | `eod.triage_overdue` read by its own regex |
| `mode.ts:30-37`, `poll.ts:118-119` | A test contact is the `sys-test` tag or a test-domain email; `sys-test-<action>` tags run the simulator |

## 4. PLATFORM: stays code

- **The Slack app:**
  - alert buttons (Resolve, Pause, Retry);
  - the Link modal;
  - the `/agreement` modal;
  - `/ticket`, which creates a GitHub issue;
  - `/team`;
  - the bot;
  - the reaction door.
- **Alert machinery:** raise, dedupe, repeat cadence and hours, re-check, pause; runner alerts; stale offer.
- **Plumbing:** polls, dispatch, re-entry, retries and holds, idempotency, the send lock, modes, the premise check, live
  contact refresh, retention purge, clock schedules, ledger links.
- **Operator tools, dry run by default and audited, each writing to GHL outside a workflow:**
  - contact-ops (delete a test contact, tags, bulk reassign, Discovery Call setter);
  - crm-repair, undo;
  - sales-call backfill;
  - Typeform import;
  - test-contact;
  - GHL provisioning;
  - replay, simulate, go-live cleanup;
  - the install defaults.

  **For Tyler to decide:** do these stay operator tools, or become one-off workflow runs?

## 5. Old-system bugs found on the way (each is a fix only if Tyler names it)

1. **The Calendly cancel is not behind the send lock** (H1). It is held in ghost and quiet only, so on a test or live offer a
   workflow cancel makes Calendly email the invitee even while that workflow's sends are locked.
2. **Backfill can start workflows.** `backfill.ts:123` → `recordPayment` dispatches healed payments and `paid_in_full`
   (`payments.ts:143, 159`). Its header says "no workflow starts".
3. **Hand-linking in Slack does not start Payment recorded or Call recorded.** `slack-link.ts:58` → `linkPayment` /
   `linkRecording` emit `payment.received` / `recording.received` but never dispatch them. The comment says it settles "exactly
   as if it had matched on arrival".
4. **`backfillBookingCard` runs before every template install** (`install.ts:129`). It writes a setting onto any offer that bound
   `hair_loss`: a code default reaching an existing offer.

## 6. What v2 makes visible (the proposal for Tyler's sign-off)

**Become workflow steps:**
- E1, the Typeform contact write: an ensure-contact step in "New from Typeform".
- E2, the scope tag on a booking: a tags step in Call booked.
- H1, the Calendly cancel: its own `scheduling.cancel` action, **behind the delivery gate**.
- H3, the task inside notify-owner: its own step.
- H4, the parts of ensure-contact: separate steps.
- H5 and H6, the health and drift repairs: visible steps or explicit opt-ins, never a silent `lead.created`.
- E5 and E6, opportunities opened, with the contract value: steps in Call booked and Payment recorded.
- E7 and E8, paid in full and healed payments: steps or explicit rules in Payment recorded.
- E3 and E4, setter attribution and the missing-setter alert: a step, with its window as a setting.
- E9, the deposit-unchecked alert.
- E13, card-move attribution.
- E11 and E12, contact gone and DND: visible results, with what follows chosen per offer.

**Become settings or workflow logic:** everything in section 3. Notably, **the send window becomes per workflow**.
