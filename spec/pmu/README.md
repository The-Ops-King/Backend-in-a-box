# PMU: every workflow

Offer `pmu`. Source: **from repo, may differ from live**. Generated 2026-10-21.

time zone America/New_York · playbook one-board

| Workflow | Stage | On | Mode | Sends | Starts when | Steps | Contact-facing |
| --- | --- | --- | --- | --- | --- | --- | --- |
| [Call booked](call-booked.md) | booking | ? | ? | ? | Appointment booked — call type is closing call; Appointment rescheduled — call type is closing call | 32 | no |
| [Call cancelled](call-cancelled.md) | booking | ? | ? | ? | An appointment's status changed — new status is “cancelled” and call type is closing call and before start | 8 | no |
| [Cancellation rebook](cancellation-rebook.md) | booking | ? | ? | ? | An appointment's status changed — new status is “cancelled” and call type is closing call and before start | 4 | yes |
| [Sales call recorded](call-recorded.md) | call | ? | ? | ? | Fathom recording received; Jev read a dialer call as a closing call | 34 | no |
| [Setter call logged](setter-call-logged.md) | call | ? | ? | ? | A dialer call came in from GHL — kind of recording is a phone call and the call connected | 79 | no |
| [Agreement signed](agreement-signed.md) | closing | ? | ? | ? | Agreement signed | 5 | no |
| [Deal closed](deal-closed.md) | closing | ? | ? | ? | Payment received; Agreement signed | 12 | yes |
| [Send agreement manually](agreement-send-manually.md) | closing | ? | ? | ? | Tag added — tag is “sys send agreement manually”; agreement requested | 11 | yes |
| [Unsigned agreement chase](agreement-chase.md) | closing | ? | ? | ? | Payment received — there are no prior non deposit total and payment kind is not “deposit” | 16 | no |
| [Calendar availability](calendar-availability.md) | engine | ? | ? | ? | On a schedule: every hour; Appointment booked; Appointment rescheduled; An appointment's status changed; An alert is raised: something broke — topic is “availability”; An alert is still open (said again every hour until it is fixed) — topic is “availability”; An alert is fixed (cleared) — topic is “availability” | 18 | no |
| [Health check](health-check.md) | engine | ? | ? | ? | On a schedule: every hour; An alert is raised: something broke — topic is not “availability”; An alert is still open (said again every hour until it is fixed) — topic is not “availability”; An alert is fixed (cleared) — topic is not “availability” | 19 | no |
| [Ledger drift](ledger-drift.md) | engine | ? | ? | ? | A Sales Call in GHL needs marking cancelled (its booking was cancelled); A Sales Call in GHL needs linking to its contact or closer card | 6 | no |
| [New lead](new-lead.md) | lead | ? | ? | ? | A new lead is added in GHL | 5 | no |
| [Speed to lead](speed-to-lead.md) | lead | ? | ? | ? | A new lead is added in GHL | 12 | yes |
| [Payment failed](payment-failed.md) | payments | ? | ? | ? | Payment failed | 3 | no |
| [Payment recorded](payment-recorded.md) | payments | ? | ? | ? | Payment received; Payment refunded | 24 | yes |
| [Unlinked payment](payment-unlinked.md) | payments | ? | ? | ? | A payment matched nobody | 3 | no |
| [Call outcome filed](call-outcome.md) | post_call | ? | ? | ? | The call's outcome is filed — the source is a closer's form and call type is closing call; An appointment's status changed — new status is no-show and call type is closing call | 34 | no |
| [Card moved by hand](card-moved.md) | post_call | ? | ? | ? | Someone moved a card by hand in GHL | 10 | no |
| [No-show recovery](no-show-recovery.md) | post_call | ? | ? | ? | An appointment's status changed — new status is no-show and call type is closing call; The call's outcome is filed — outcome is no-show and call type is closing call | 11 | yes |
| [Post-call follow-up](post-call-follow-up.md) | post_call | ? | ? | ? | The call happened — outcome is follow up | 4 | yes |
| [Unmatched recording](recording-unlinked.md) | post_call | ? | ? | ? | A recording matched nobody | 3 | no |
| [Pre-call sequence](pre-call-sequence.md) | pre_call | ? | ? | ? | Appointment booked — call type is closing call and term name is not “Follow up call”; Appointment rescheduled — call type is closing call and term name is not “Follow up call” | 48 | yes |
| [Reactivation](reactivation.md) | reactivation | ? | ? | ? | Tag added — tag is “reactivate” | 7 | yes |
| [Daily wrap-up](daily-wrap-up.md) | team | ? | ? | ? | On a schedule: at 7:00 PM every day | 4 | no |
| [EOD: post the closer's day](eod-filed.md) | team | ? | ? | ? | A closer filed their end-of-day form | 4 | no |
| [EOD: remind closers to file](eod-reminder.md) | team | ? | ? | ? | On a schedule: at 6:00 PM every day, one run per closer; On a schedule: at 9:00 AM every day, one run per closer | 9 | no |
| [Monthly wrap-up](monthly-wrap-up.md) | team | ? | ? | ? | On a schedule: at 8:00 AM on day 1 of the month | 4 | no |
| [Weekly leaderboard](weekly-leaderboard.md) | team | ? | ? | ? | On a schedule: at 9:00 AM on Mon | 4 | no |
| [Weekly wrap-up](weekly-wrap-up.md) | team | ? | ? | ? | On a schedule: at 8:00 AM on Mon | 4 | no |
