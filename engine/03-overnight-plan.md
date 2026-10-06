# Overnight build — 2026-10-06

Scope from Tyler: MVP only. No auth, no command center, no phone number, no v2. UI basics and
the core workflows. Everything installs OFF.

## Batch 1 — the core workflow set (templates, tests, charts)

| Template | Trigger | Re-entry | What it does |
|---|---|---|---|
| booking-confirmation (exists) | appointment.booked | once per appointment | confirmation email |
| appointment-reminder (exists) | appointment.booked, closing calls | once per appointment | morning-of SMS, waits for reply, classifies, branches |
| speed-to-lead | lead.created | once per contact | email + SMS now, wait for reply 2h, second email if silent |
| no-show-recovery | appointment.status_changed → noshow | once per appointment | 10 min, SMS + email with rebook link, wait 24h, second email if silent |
| cancellation-rebook | appointment.status_changed → cancelled | once per appointment | SMS + email with rebook link |
| post-call-follow-up | call.held, outcome follow_up | once per appointment | next morning SMS |
| payment-received | payment.received | always | thank-you email, tag client |
| payment-failed | payment.failed | always | SMS + email, 2 days, Slack the owner if connected |
| reactivation | tag.added "reactivate" | once per contact per 90d | email, 3 days, SMS, 4 days, last email |

Engine changes these need: `companies.sms_enabled` (SMS nodes skip cleanly when false, since Tyler
won't buy a number), and `event._source` / `event._type` in trigger match context.

## Batch 2 — UI basics
- Enable / disable toggle on the workflow page (writes audit_log). The only write in the UI.
- Appointments page per company: upcoming and last 7 days, status, closer, outcome.
- Disposition form per appointment: outcome, call outcome, notes. Writes the appointment, emits
  `appointment.outcome` + `call.held`, dispatches. No signed links yet (no Slack, operator only).
- Events feed on the company page.

## Batch 3 — verify and hand off
- Full test suite, production build, screenshots of the new pages, README and open-questions
  updated. Install the new templates into the local proof company and show charts.

Not doing: editor, auth, Slack OAuth, command center, hosted intake form, contact merge tooling.

---

## Result (morning of 2026-10-06)

All three batches shipped. 39 tests, production build green, every push auto-deploys.

- **Workflows:** 9 templates (7 new). Every template parses, triggers on a vocabulary event,
  references only known context, and renders as a chart. All install OFF.
- **Engine:** `sms_enabled` per company (SMS nodes skip, run continues); `event._source` and
  `event._type` in trigger matches; `migrate()` owns engine-internal schema additions; `calendar.booking`
  binding for lead and reactivation links.
- **UI:** on/off toggle (audited), appointments page, disposition form (writes our row, emits
  `appointment.outcome` + `call.held`, dispatches), events feed, Mermaid charts on workflow and
  run pages.
- **Local proof company** has all 9 installed, SMS off, everything off.

Judgment calls made without asking, flag any:
- No-show recovery triggers from **both** GHL's status and our disposition; once-per-appointment
  re-entry collapses them to one run.
- A `lost` call outcome on the disposition marks the opportunity lost.
- Message copy is mine; it's meant to be edited per company.
- Disposition has no signed links yet (operator-only behind Vercel's wall, no Slack).

Still needs Tyler: the database (then migrate + install via the admin endpoints), Pro or the two
Actions secrets, confirm the calendar mapping.

### Later the same night: scenario tests and a live round-trip
- 8 scenario tests drive every template through the engine with fake adapters (47 tests total).
- They found: an optional unbound Slack channel crashed `slack_post` (now skips); and a circular
  FK between appointments and form_submissions blocked deletes once a disposition existed (the
  pointer is now `on delete set null`).
- A live GHL round-trip found that cancellation rebook exited itself as moot, because the premise
  check treated any cancelled appointment as dead. `appointment_exists` now survives a cancellation;
  only `appointment_in_future` dies on it.
- The same round-trip appeared to miss a tag → it was GHL's search index lagging ~5–8s behind the
  write (`ghl/02-api-facts.md`). One poll late at worst; no engine change.
- Everything on the local proof company is OFF again.
- Running the suite repeatedly then found two more: a test that picked runs by `started_at`
  order (two runs inserted in one transaction share it), and a real scheduler race: the claim
  compared `next_run_at` (Postgres `now()`, microseconds) against a JavaScript timestamp
  (milliseconds), so a wake and a tick in the same millisecond made a run look not-yet-due. The
  claim now uses the database clock. Suite is green five runs in a row.
