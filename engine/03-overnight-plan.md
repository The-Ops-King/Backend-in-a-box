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
