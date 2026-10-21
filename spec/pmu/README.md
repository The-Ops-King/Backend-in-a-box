# PMU: every workflow

Offer `pmu`. Source: live database. Generated 2026-10-21.

status active · offer mode ghost · time zone America/New_York · send window 08:00–20:00

| Workflow | Stage | On | Mode | Sends | Starts when | Steps | Contact-facing |
| --- | --- | --- | --- | --- | --- | --- | --- |
| [Call booked](call-booked.md) | booking | on | (ghost) | locked | Appointment booked — call type is closing call; Appointment rescheduled — call type is closing call | 26 | no |
| [Call cancelled](call-cancelled.md) | booking | on | (ghost) | locked | An appointment's status changed — new status is “cancelled” and call type is closing call and before start | 8 | no |
| [Cancellation rebook](cancellation-rebook.md) | booking | off | (ghost) | locked | An appointment's status changed — new status is “cancelled” and call type is closing call and before start | 4 | yes |
| [Sales call recorded](sales-call-recorded.md) | call | on | (ghost) | locked | Fathom recording received; Jev read a dialer call as a closing call | 34 | no |
| [Setter call logged](setter-call-logged.md) | call | off | (ghost) | locked | A dialer call came in from GHL — kind of recording is a phone call and the call connected | 79 | no |
| [Agreement signed](agreement-signed.md) | closing | off | (ghost) | locked | Agreement signed | 5 | no |
| [Deal closed](deal-closed.md) | closing | on | (ghost) | locked | Payment received; Agreement signed | 12 | yes |
| [Send agreement manually](send-agreement-manually.md) | closing | off | (ghost) | locked | Tag added — tag is “sys send agreement manually” | 6 | yes |
| [Unsigned agreement chase](unsigned-agreement-chase.md) | closing | off | (ghost) | locked | Payment received — there are no prior non deposit total and payment kind is not “deposit” | 16 | no |
| [Calendar availability](calendar-availability.md) | engine | off | (ghost) | locked | On a schedule: every hour; Appointment booked; Appointment rescheduled; An appointment's status changed | 6 | no |
| [Health check](health-check.md) | engine | on | quiet | locked | On a schedule: every hour; An alert is raised: something broke; An alert is still open (said again every hour until it is fixed); An alert is fixed (cleared) | 19 | no |
| [Ledger drift](ledger-drift.md) | engine | off | (ghost) | locked | A Sales Call in GHL needs marking cancelled (its booking was cancelled); A Sales Call in GHL needs linking to its contact or closer card | 6 | no |
| [New lead](new-lead.md) | lead | on | (ghost) | locked | A new lead is added in GHL | 5 | no |
| [Speed to lead](speed-to-lead.md) | lead | off | (ghost) | locked | A new lead is added in GHL | 12 | yes |
| [Payment failed](payment-failed.md) | payments | off | (ghost) | locked | Payment failed | 3 | no |
| [Payment recorded](payment-recorded.md) | payments | on | (ghost) | locked | Payment received; Payment refunded | 24 | yes |
| [Unlinked payment](unlinked-payment.md) | payments | off | (ghost) | locked | A payment matched nobody | 3 | no |
| [Call outcome filed](call-outcome-filed.md) | post_call | on | (ghost) | locked | The call's outcome is filed — the source is a closer's form; An appointment's status changed — new status is no-show | 34 | no |
| [Card moved by hand](card-moved-by-hand.md) | post_call | on | (ghost) | locked | Someone moved a card by hand in GHL | 10 | no |
| [No-show recovery](no-show-recovery.md) | post_call | off | (ghost) | locked | An appointment's status changed — new status is no-show; The call's outcome is filed — outcome is no-show | 11 | yes |
| [Post-call follow-up](post-call-follow-up.md) | post_call | off | (ghost) | locked | The call happened — outcome is follow up | 4 | yes |
| [Unmatched recording](unmatched-recording.md) | post_call | off | (ghost) | locked | A recording matched nobody | 3 | no |
| [Pre-call sequence](pre-call-sequence.md) | pre_call | on | (ghost) | locked | Appointment booked — call type is closing call and term name is not “Follow up call”; Appointment rescheduled — call type is closing call and term name is not “Follow up call” | 48 | yes |
| [Reactivation](reactivation.md) | reactivation | off | (ghost) | locked | Tag added — tag is “reactivate” | 7 | yes |
| [Daily wrap-up](daily-wrap-up.md) | team | off | (ghost) | locked | On a schedule: at 7:00 PM every day | 4 | no |
| [EOD: post the closer's day](eod-post-the-closer-s-day.md) | team | off | (ghost) | locked | A closer filed their end-of-day form | 4 | no |
| [EOD: remind closers to file](eod-remind-closers-to-file.md) | team | off | (ghost) | locked | On a schedule: at 6:00 PM every day, one run per closer; On a schedule: at 9:00 AM every day, one run per closer | 9 | no |
| [Monthly wrap-up](monthly-wrap-up.md) | team | off | (ghost) | locked | On a schedule: at 8:00 AM on day 1 of the month | 4 | no |
| [Weekly leaderboard](weekly-leaderboard.md) | team | off | (ghost) | locked | On a schedule: at 9:00 AM on Mon | 4 | no |
| [Weekly wrap-up](weekly-wrap-up.md) | team | off | (ghost) | locked | On a schedule: at 8:00 AM on Mon | 4 | no |
