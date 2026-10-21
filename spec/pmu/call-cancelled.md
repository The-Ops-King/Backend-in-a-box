# Call cancelled

Offer: **PMU** (`pmu`). Source: live database. Generated 2026-10-21.

| Setting | Value |
| --- | --- |
| Where this definition came from | live: version 2, saved 2026-10-13T21:44:51.192Z (PMU: one board. No setter card; the card moves to Canceled Call) |
| Template | `call-cancelled` v7 |
| Edited since copied from the template | yes |
| Saved version | 2 |
| Enabled | on |
| Mode | follows the offer (ghost) |
| Send lock | locked: texts, emails, documents and webhooks reach only the operator's own addresses |
| Runs again for the same person | once_per_appointment |
| Re-checked before every step | appointment exists |
| Send window | 08:00 to 20:00, the contact's time zone |
| Steps | 8 |

## Steps

Every step, in the order a run meets it from the trigger. Steps that only assemble words (`set_var`) are listed too.

### 1. An appointment's status changed — new status is “cancelled” and call type is closing call and before start

- Step id `t1`, type `trigger`

Next:
- always → step 2 (`n2`)

<details><summary>Full step definition</summary>

```json
{
  "id": "t1",
  "type": "trigger",
  "event": "appointment.status_changed",
  "match": {
    "and": [
      {
        "eq": [
          "{{event.status.to}}",
          "cancelled"
        ]
      },
      {
        "eq": [
          "{{appointment.term.category}}",
          "closing"
        ]
      },
      {
        "neq": [
          "{{event.before_start}}",
          false
        ]
      }
    ]
  }
}
```

</details>

### 2. Create or move pipeline card “[full name] -- Cancelled”

- Step id `n2`, type `pipeline_card`
- Detail: In the closer board, stage Cancelled
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Next:
- always → step 3 (`n3`)

<details><summary>Full step definition</summary>

```json
{
  "id": "n2",
  "type": "pipeline_card",
  "pipeline": "{{crm.pipeline_closer}}",
  "stage": "{{crm.stage_closer_cancelled}}",
  "name": "{{contact.name}} -- Cancelled",
  "if_missing": "create",
  "pick": "open",
  "fields": []
}
```

</details>

### 3. Update the contact in the CRM

- Step id `n3`, type `update_contact`
- Detail: clear appointment date
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Next:
- always → step 4 (`n4`)

<details><summary>Full step definition</summary>

```json
{
  "id": "n3",
  "type": "update_contact",
  "set": {},
  "fields": [],
  "clear": [
    "{{crm.field_contact_appointment_date}}"
  ]
}
```

</details>

### 4. Rebook {{contact.name}} — cancelled

- Step id `n4`, type `create_task`
- Engine description: Task for the closer: “Rebook [full name] — cancelled”
- Detail: Due in 1 day
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Task title:

```
Rebook {{contact.name}} — cancelled
```

Task body:

```
Cancelled by {{appointment.cancelled_by | default:the invitee}}. Reason: {{appointment.cancel_reason | default:none given}}.
```

Next:
- always → step 5 (`n5`)

<details><summary>Full step definition</summary>

```json
{
  "id": "n4",
  "title": "Rebook {{contact.name}} — cancelled",
  "type": "create_task",
  "body": "Cancelled by {{appointment.cancelled_by | default:the invitee}}. Reason: {{appointment.cancel_reason | default:none given}}.",
  "due": "+1d",
  "assign_to": "{{appointment.closer.ghl_user_id | default:}}"
}
```

</details>

### 5. Tags “+stat-cancelled” “−stat-booked” “−stat-self-booked” “−stat-set” “−stat-confirmed”

- Step id `n5`, type `tags`
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Next:
- always → step 6 (`n6`)

<details><summary>Full step definition</summary>

```json
{
  "id": "n5",
  "type": "tags",
  "add": [
    "stat-cancelled"
  ],
  "remove": [
    "stat-booked",
    "stat-self-booked",
    "stat-set",
    "stat-confirmed"
  ]
}
```

</details>

### 6. Sales Call record: cancelled (logged, never deleted or reused)

- Step id `n6`, type `crm_record`
- Engine description: Update sales call record
- Detail: Keyed by this booking; 2 fields; only a record that exists, found by the booking when the engine did not write it
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Next:
- always → step 7 (`n7`)

<details><summary>Full step definition</summary>

```json
{
  "id": "n6",
  "title": "Sales Call record: cancelled (logged, never deleted or reused)",
  "type": "crm_record",
  "object": "custom_objects.sales_call",
  "key": "{{appointment.slot_key}}",
  "properties": {
    "outcome": "{{picklist.sales_call_outcome.cancelled}}",
    "external_id": "{{appointment.slot_key}}"
  },
  "if_missing": "match",
  "relate": [],
  "clear": []
}
```

</details>

### 7. React ❌, reply in the booking thread

- Step id `n7`, type `slack_post`
- Engine description: Reply in the thread of that Slack post
- Detail: reacts :x: on it
- Goes to: channel {{slack.channel.bookings}}; in the thread of tag:appointment:{{appointment.id}}; posted as "Call cancelled"
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Slack post:

```
*Cancelled:* <https://app.gohighlevel.com/v2/location/{{crm.location_id}}/contacts/detail/{{contact.ghl_contact_id | default:}}|{{contact.name | default:Unknown}}>
*Was booked with:* {{appointment.closer.name | default:unassigned}} · {{appointment.starts_at | date_company}}
*Cancelled by:* {{appointment.cancelled_by | default:the invitee}}
*Reason:* {{appointment.cancel_reason | default:none given}}
*Phone:* {{contact.phone | default:—}}
*Rebook task:* due in 1 day for {{appointment.closer.name | default:the team}}
```

Next:
- always → step 8 (`x1`)

<details><summary>Full step definition</summary>

```json
{
  "id": "n7",
  "title": "React ❌, reply in the booking thread",
  "type": "slack_post",
  "channel": "{{slack.channel.bookings}}",
  "template": "*Cancelled:* <https://app.gohighlevel.com/v2/location/{{crm.location_id}}/contacts/detail/{{contact.ghl_contact_id | default:}}|{{contact.name | default:Unknown}}>\n*Was booked with:* {{appointment.closer.name | default:unassigned}} · {{appointment.starts_at | date_company}}\n*Cancelled by:* {{appointment.cancelled_by | default:the invitee}}\n*Reason:* {{appointment.cancel_reason | default:none given}}\n*Phone:* {{contact.phone | default:—}}\n*Rebook task:* due in 1 day for {{appointment.closer.name | default:the team}}",
  "as": {
    "name": "Call cancelled",
    "icon": [
      ":x:",
      ":calendar:",
      ":no_entry_sign:"
    ]
  },
  "thread_of": "tag:appointment:{{appointment.id}}",
  "thread_only": false,
  "edit": false,
  "react": "x",
  "label": "mode"
}
```

</details>

### 8. Done: cancellation recorded

- Step id `x1`, type `exit`

Next: the run ends here.

<details><summary>Full step definition</summary>

```json
{
  "id": "x1",
  "type": "exit",
  "reason": "cancelled_recorded"
}
```

</details>

## Settings this workflow reads

| Key | Kind | Required to enable | Value |
| --- | --- | --- | --- |
| `crm.field_contact_appointment_date` | id | yes | `uqulQPE8vPu0RZDyDXIj` |
| `crm.location_id` | id | yes | `gA10c58jLJRYbNwC3apW` |
| `crm.pipeline_closer` | id | yes | `1B37Vzv6euKMpWaFFuVW` |
| `crm.stage_closer_cancelled` | id | yes | `b476556a-26f3-4bff-86eb-05fdcf0c5bd0` |
| `slack.channel.bookings` | channel | no | `C0BSCMB813L` |

## Engine rules that apply but are not steps

These act on every run of this workflow from engine code. They are not in the definition above.

- **Mode.** The workflow's own mode, else the offer's, decides what is real: ghost writes and sends nothing, test is real only for test contacts, quiet writes the CRM but reaches no contact, live is real. (platform/src/engine/mode.ts:23, platform/src/engine/mode.ts:55)
- **Runs again?** A run's key is built from the re-entry policy; a second trigger with the same key starts nothing. A run that stops at a gate does not count. (platform/src/engine/reentry.ts:6)
- **Premise re-check.** Before each step the engine reads the CRM live; when "appointment exists" no longer holds, the run exits. (platform/src/engine/runner.ts:33)
- **Failures.** Errors are sorted into transient, auth, permanent and unknown. A step is retried after 1 and 5 minutes; then a non-blocking step is skipped and a blocking one is held and looked at again after 15 minutes, then hourly. An auth or permanent failure pauses the run until it is fixed. (platform/src/engine/failures.ts:19, platform/src/engine/failures.ts:21, platform/src/engine/blocking.ts:58)
- **Step cap.** At most 50 steps run in one go; a run past that fails. After an outage, at most 20 sends per offer per tick. (platform/src/engine/runner.ts:21, platform/src/engine/runner.ts:27)
- **CRM writes** without a natural key (notes, tasks, cards, records) are claimed once per run and step so a retry never writes twice. In ghost mode they are skipped. (platform/src/engine/effects.ts:13)
- **Slack before live.** Until the workflow is live, every post goes to the offer's test channel with a ghost/test label, unless `slack.live` is set. (platform/src/engine/mode.ts:32, platform/src/engine/mode.ts:34)
