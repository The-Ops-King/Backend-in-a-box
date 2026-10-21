# Save Your Hair (Parungao): every workflow

Offer `hair`. Source: live database. Generated 2026-10-21.

status active · offer mode test · time zone America/New_York · send window 08:00–20:00

| Workflow | Stage | On | Mode | Sends | Starts when | Steps | Contact-facing |
| --- | --- | --- | --- | --- | --- | --- | --- |
| [Call booked](call-booked.md) | booking | on | (test) | locked | Appointment booked — call type is closing call; Appointment rescheduled — call type is closing call | 30 | no |
| [Call cancelled](call-cancelled.md) | booking | on | (test) | locked | An appointment's status changed — new status is “cancelled” and call type is closing call and before start | 9 | no |
| [Cancellation rebook](cancellation-rebook.md) | booking | off | (test) | locked | An appointment's status changed — new status is “cancelled” and call type is closing call and before start | 4 | yes |
| [Sales call recorded](sales-call-recorded.md) | call | on | (test) | locked | Fathom recording received; Jev read a dialer call as a closing call | 35 | no |
| [Setter call logged](setter-call-logged.md) | call | on | (test) | locked | A dialer call came in from GHL — kind of recording is a phone call and the call connected | 79 | no |
| [Agreement signed](agreement-signed.md) | closing | on | (test) | locked | Agreement signed | 5 | no |
| [Deal closed](deal-closed.md) | closing | on | (test) | locked | Payment received; Agreement signed | 13 | yes |
| [Send agreement manually](send-agreement-manually.md) | closing | on | (test) | locked | Tag added — tag is “sys send agreement manually” | 6 | yes |
| [Unsigned agreement chase](unsigned-agreement-chase.md) | closing | on | (test) | locked | Payment received — there are no prior non deposit total and payment kind is not “deposit” | 16 | no |
| [Calendar availability](calendar-availability.md) | engine | on | live | locked | On a schedule: every hour; Appointment booked; Appointment rescheduled; An appointment's status changed; An alert is raised: something broke — topic is “availability”; An alert is still open (said again every hour until it is fixed) — topic is “availability”; An alert is fixed (cleared) — topic is “availability” | 18 | no |
| [Health check](health-check.md) | engine | on | live | locked | On a schedule: every hour; An alert is raised: something broke — topic is not “availability”; An alert is still open (said again every hour until it is fixed) — topic is not “availability”; An alert is fixed (cleared) — topic is not “availability” | 19 | no |
| [Ledger drift](ledger-drift.md) | engine | on | live | locked | A Sales Call in GHL needs marking cancelled (its booking was cancelled); A Sales Call in GHL needs linking to its contact or closer card | 6 | no |
| [New lead](new-lead.md) | lead | on | live | locked | A new lead is added in GHL | 5 | no |
| [Speed to lead](speed-to-lead.md) | lead | off | (test) | locked | A new lead is added in GHL | 12 | yes |
| [Payment failed](payment-failed.md) | payments | on | (test) | locked | Payment failed | 3 | no |
| [Payment recorded](payment-recorded.md) | payments | on | (test) | locked | Payment received; Payment refunded | 24 | yes |
| [Unlinked payment](unlinked-payment.md) | payments | on | (test) | locked | A payment matched nobody | 3 | no |
| [Call outcome filed](call-outcome-filed.md) | post_call | on | live | locked | The call's outcome is filed — the source is a closer's form and call type is closing call; An appointment's status changed — new status is no-show and call type is closing call | 36 | no |
| [Card moved by hand](card-moved-by-hand.md) | post_call | on | (test) | locked | Someone moved a card by hand in GHL | 10 | no |
| [No-show recovery](no-show-recovery.md) | post_call | off | (test) | locked | An appointment's status changed — new status is no-show; The call's outcome is filed — outcome is no-show | 11 | yes |
| [Post-call follow-up](post-call-follow-up.md) | post_call | off | (test) | locked | The call happened — outcome is follow up | 4 | yes |
| [Unmatched recording](unmatched-recording.md) | post_call | on | (test) | locked | A recording matched nobody | 3 | no |
| [Pre-call sequence](pre-call-sequence.md) | pre_call | off | (test) | locked | Appointment booked — call type is closing call; Appointment rescheduled — call type is closing call | 46 | yes |
| [Reactivation](reactivation.md) | reactivation | off | (test) | locked | Tag added — tag is “reactivate” | 7 | yes |
| [Daily wrap-up](daily-wrap-up.md) | team | on | live | locked | On a schedule: at 7:00 PM every day | 4 | no |
| [EOD: post the closer's day](eod-post-the-closer-s-day.md) | team | on | live | locked | A closer filed their end-of-day form | 4 | no |
| [EOD: remind closers to file](eod-remind-closers-to-file.md) | team | on | live | locked | On a schedule: at 6:00 PM every day, one run per closer; On a schedule: at 9:00 AM every day, one run per closer | 9 | no |
| [Monthly wrap-up](monthly-wrap-up.md) | team | on | live | locked | On a schedule: at 8:00 AM on day 1 of the month | 4 | no |
| [Weekly leaderboard](weekly-leaderboard.md) | team | on | live | locked | On a schedule: at 9:00 AM on Mon | 4 | no |
| [Weekly wrap-up](weekly-wrap-up.md) | team | on | live | locked | On a schedule: at 8:00 AM on Mon | 4 | no |
