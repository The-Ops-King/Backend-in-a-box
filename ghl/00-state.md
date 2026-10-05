# Build state — location `RHOfV4fFknN54YQobyWp`

Template sub-account. Timezone America/Phoenix. Last synced 2026-09-12.

## Status

| Layer | State |
|---|---|
| Contact custom fields | ✅ 32 built |
| Pipelines | ✅ 2 built |
| Users | ✅ 3 built |
| Calendar group + calendars | ✅ 3 built, 2 settings pending UI |
| Custom values | ✅ 18 slots (Slack + links + copy on TODO) |
| Sales Call object + association | ✅ built, 19 fields |
| Tags | ✅ 32 |
| Attribution links | ✅ documented |
| Forms | ⬜ UI only |
| Workflows | ⬜ UI only, 14 + 7 extension points |
| Smart lists | ⬜ UI only, 10 |
| Agreement document | ⬜ blocked on PIT scope |
| Email templates | ⬜ UI only |

## Contact custom fields

Folder **Core System**. All keys stable — the `* ` prefix becomes `_`.

| Field | Type | Key |
|---|---|---|
| `* agreement_signed_at` | DATE | `contact._agreement_signed_at` |
| `* appointment_state` | SINGLE_OPTIONS | `contact._appointment_state` |
| `* client_since` | DATE | `contact._client_since` |
| `* entry_type` | SINGLE_OPTIONS | `contact._entry_type` |
| `* entry_url` | LARGE_TEXT | `contact._entry_url` |
| `* failed_payment_count` | NUMERICAL | `contact._failed_payment_count` |
| `* financial_fit` | SINGLE_OPTIONS | `contact._financial_fit` |
| `* first_call_attempt_at` | DATE | `contact._first_call_attempt_at` |
| `* first_call_duration` | NUMERICAL | `contact._first_call_duration` |
| `* first_payment_at` | DATE | `contact._first_payment_at` |
| `* last_payment_date` | DATE | `contact._last_payment_date` |
| `* last_touch_at` | DATE | `contact._last_touch_at` |
| `* lead_arrival` | SINGLE_OPTIONS | `contact._lead_arrival` |
| `* lead_source` | SINGLE_OPTIONS | `contact._lead_source` |
| `* lead_state` | SINGLE_OPTIONS | `contact._lead_state` |
| `* next_call_at` | DATE | `contact._next_call_at` |
| `* next_message_at` | DATE | `contact._next_message_at` |
| `* pain_fit` | SINGLE_OPTIONS | `contact._pain_fit` |
| `* payment_status` | SINGLE_OPTIONS | `contact._payment_status` |
| `* reactivation_cycle` | NUMERICAL | `contact._reactivation_cycle` |
| `* reactivation_reason` | SINGLE_OPTIONS | `contact._reactivation_reason` |
| `* referral_partner` | TEXT | `contact._referral_partner` |
| `* routing` | SINGLE_OPTIONS | `contact._routing` |
| `* setter_owner` | TEXT | `contact._setter_owner` |
| `* speed_to_lead_alerted_at` | DATE | `contact._speed_to_lead_alerted_at` |
| `* timing_fit` | SINGLE_OPTIONS | `contact._timing_fit` |
| `* total_collected` | MONETORY | `contact._total_collected` |
| `* touch_count` | NUMERICAL | `contact._touch_count` |
| `* utm_campaign` | TEXT | `contact._utm_campaign` |
| `* utm_content` | TEXT | `contact._utm_content` |
| `* utm_medium` | SINGLE_OPTIONS | `contact._utm_medium` |
| `* whop_membership_id` | TEXT | `contact._whop_membership_id` |

## Pipelines

**Marketing Pipeline** `kZ5ZJfFPGaICLXTUpQAK`  ← GHL default, delete before snapshot

| Stage | ID |
|---|---|
| New Lead | `9f780e51-322a-4252-a632-c81077d32826` |
| Contacted | `c28b5f4c-2359-45fe-947a-7566fbbb8180` |
| Qualified | `035a4dbe-584a-47c7-bd19-c117678d2972` |
| Proposal Sent | `eb074aad-f712-497b-b31c-770e340eb8d3` |
| Negotiation | `8e41b80c-b9e7-418f-8c87-632ef1eab45a` |
| Closed | `a9b46cc7-844a-461d-acdc-f70b0ff7c9e1` |

**Setter Pipeline** `aTpVqzrb4nTNcFBaK9VI`

| Stage | ID |
|---|---|
| New Lead | `0d849f93-813b-4348-90c0-6ff6dc258b85` |
| Contacted | `bbeacab7-e586-4311-96b6-ec8c14e6d83c` |
| Qualified | `1df2eaeb-3b86-45bb-b500-5c60b25023f6` |
| Booked | `d70e9459-603e-4dbc-9003-c6441c331585` |
| Disqualified | `0073c7a7-1e8e-43ea-81ab-232463093e31` |

**Closer Pipeline** `yOv7zyX5V6Nuu8hcP9Tt`

| Stage | ID |
|---|---|
| Booked | `ee4136b0-32c9-439e-a795-b4ad60bd7a2e` |
| Showed | `e5cd7293-f3ca-400f-836e-aa92d7152805` |
| No Show | `01ca7456-d867-48fe-83a2-f2787b4b9b45` |
| Follow Up | `d5344a2a-b5d1-4a8f-acec-b1ea165c7823` |
| Closed Won | `ad30100b-cb3b-4802-a779-6d137502bd15` |
| Closed Lost | `6207c2c6-6e83-4c28-a359-d337d5536502` |

## Users

Users do **not** travel in snapshots. Test scaffolding only; recreated per install.

| Name | Email | ID |
|---|---|---|
| Closer One | closer1@jtylerray.com | `To1nWAi7bXoW46OZLQiy` |
| Closer Two | closer2@jtylerray.com | `RR0yZONzQuLR5la4YhQR` |
| Setter One | setter1@jtylerray.com | `p3yaw7xYspAY0cb9wFw7` |
| Tyler Ray | jt@jtylerray.com | `ZqF4jEd9DKTa6nEB8NUZ` |

## Calendars

Group **Core System** `nc0KdO3ujIkxueEkUwlI`

| Calendar | ID | Assign-to-user | Note |
|---|---|---|---|
| Closer Two's Personal Calendar | `7Z78XCSrSeOJiU19Qrhk` | — | auto-created with user — deselect at snapshot |
| Closer Call (Setter Booked) | `GLWzPNAZPoxkROdFJbPH` | — |  |
| Closer Call (Self Book) | `RzQgbmwwCIJeHv8YLXO8` | True | 2 settings still need UI — see 03 |
| Setter One's Personal Calendar | `XN5QPInoTGpqryysDBFH` | — | auto-created with user — deselect at snapshot |
| Closer One's Personal Calendar | `ev2rvIp5v6vQeMJUdO00` | — | auto-created with user — deselect at snapshot |
| Setter Discovery | `kbEwrOhdlzxAHIpNLqF7` | — |  |

## Sales Call object

`custom_objects.sales_call` — **permanent, cannot be deleted**. Association `contact_sales_calls`
(Contact → Sales Calls). Associations travel in snapshots and cannot be deselected.

| Field | Type | Key |
|---|---|---|
| `* appointment_at` | DATE | `custom_objects.sales_call.appointment_at` |
| `* appointment_id` | TEXT | `custom_objects.sales_call.appointment_id` |
| `* attendance` | SINGLE_OPTIONS | `custom_objects.sales_call.attendance` |
| `* call_notes` | LARGE_TEXT | `custom_objects.sales_call.call_notes` |
| `* call_outcome` | SINGLE_OPTIONS | `custom_objects.sales_call.call_outcome` |
| `* call_type` | SINGLE_OPTIONS | `custom_objects.sales_call.call_type` |
| `* cash_collected` | MONETORY | `custom_objects.sales_call.cash_collected` |
| `* closer` | TEXT | `custom_objects.sales_call.closer` |
| `* contract_value` | MONETORY | `custom_objects.sales_call.contract_value` |
| `* disposition_complete` | CHECKBOX | `custom_objects.sales_call.disposition_complete` |
| `* dq_reason` | SINGLE_OPTIONS | `custom_objects.sales_call.dq_reason` |
| `* dq_source` | SINGLE_OPTIONS | `custom_objects.sales_call.dq_source` |
| `* fathom_link` | TEXT | `custom_objects.sales_call.fathom_link` |
| `* loss_reason` | SINGLE_OPTIONS | `custom_objects.sales_call.loss_reason` |
| `* next_step` | TEXT | `custom_objects.sales_call.next_step` |
| `* next_step_date` | DATE | `custom_objects.sales_call.next_step_date` |
| `* payment_terms` | SINGLE_OPTIONS | `custom_objects.sales_call.payment_terms` |
| `* setter` | TEXT | `custom_objects.sales_call.setter` |
| `Call Name` | TEXT | `custom_objects.sales_call.name` |

## Custom values

| Name | Merge field | Value |
|---|---|---|
| cfg_after_hours_cutoff_min | `{{ custom_values.cfg_after_hours_cutoff_min }}` | 15 |
| cfg_business_close | `{{ custom_values.cfg_business_close }}` | 17:00 |
| cfg_business_open | `{{ custom_values.cfg_business_open }}` | 09:00 |
| cfg_setter_daily_call_target | `{{ custom_values.cfg_setter_daily_call_target }}` | TODO |
| cfg_unreachable_attempts | `{{ custom_values.cfg_unreachable_attempts }}` | TODO |
| cfg_working_to_cold_days | `{{ custom_values.cfg_working_to_cold_days }}` | TODO |
| copy_payment_failed_email | `{{ custom_values.copy_payment_failed_email }}` | TODO |
| copy_payment_failed_sms | `{{ custom_values.copy_payment_failed_sms }}` | TODO |
| link_closer_self_book | `{{ custom_values.link_closer_self_book }}` | TODO |
| link_closer_setter_booked | `{{ custom_values.link_closer_setter_booked }}` | TODO |
| link_disposition_form | `{{ custom_values.link_disposition_form }}` | TODO |
| link_payment_update | `{{ custom_values.link_payment_update }}` | TODO |
| link_prep_video | `{{ custom_values.link_prep_video }}` | TODO |
| link_setter_discovery | `{{ custom_values.link_setter_discovery }}` | TODO |
| slack_group_closers | `{{ custom_values.slack_group_closers }}` | <!subteam^TODO> |
| slack_group_leadership | `{{ custom_values.slack_group_leadership }}` | <!subteam^TODO> |
| slack_group_setters | `{{ custom_values.slack_group_setters }}` | <!subteam^TODO> |
| slack_webhook_url | `{{ custom_values.slack_webhook_url }}` | TODO_PASTE_WEBHOOK_URL |

## Tags

**`seq-`** — Event tags — each core workflow removes its own as step one

`seq-ask-disposition` · `seq-cancelled-call` · `seq-close-check` · `seq-create-opportunity` · `seq-log-first-call` · `seq-mirror-state-tags` · `seq-no-show` · `seq-payment-cancelled` · `seq-payment-failed` · `seq-payment-received` · `seq-pre-call-reminders` · `seq-same-day-coverage` · `seq-speed-to-lead` · `seq-stamp-attribution`

**`stat-`** — State mirrors — written only by [CORE] Mirror State Tags

`stat-appt-booked` · `stat-appt-cancelled` · `stat-appt-no-show` · `stat-appt-none` · `stat-appt-showed` · `stat-lead-active-client` · `stat-lead-booked` · `stat-lead-cold` · `stat-lead-disqualified` · `stat-lead-new` · `stat-lead-nurture-only` · `stat-lead-unreachable` · `stat-lead-working`

**`sys-`** — System flags

`sys-deposit-open` · `sys-test`

## Known residue

- `ZZ SCRATCH – exclude from snapshot` (`custom_objects.zz_test_obj`) — probe object from
  the field-limit test. Fields stripped, renamed. Object schemas cannot be deleted via API;
  try the UI. Either way, deselect it in the snapshot asset picker.
- `Marketing Pipeline` — GHL default boilerplate, not part of this build.
- Three personal calendars auto-created alongside the three users.
