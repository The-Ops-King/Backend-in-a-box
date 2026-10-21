# Call booked

Offer: **Save Your Hair (Parungao)** (`hair`). Source: live database. Generated 2026-10-21.

| Setting | Value |
| --- | --- |
| Where this definition came from | live: version 18, saved 2026-10-20T15:09:11.593Z (Port from Nelly (engine/13 C2), Tyler's placement: a booking with no meeting link gets a note under its booking card (in the booking channel) and an issue in #sales-ops (slack.channel.no_link_alerts).) |
| Template | `call-booked` v16 |
| Edited since copied from the template | yes |
| Saved version | 18 |
| Enabled | on |
| Mode | follows the offer (test) |
| Send lock | locked: texts, emails, documents and webhooks reach only the operator's own addresses |
| Runs again for the same person | always |
| Re-checked before every step | appointment exists |
| Send window | 08:00 to 20:00, the contact's time zone; transactional messages may go at any hour |
| Steps | 30 |

## Steps

Every step, in the order a run meets it from the trigger. Steps that only assemble words (`set_var`) are listed too.

### 1. Appointment booked — call type is closing call

- Step id `t1`, type `trigger`

Next:
- always → step 3 (`c0`)

<details><summary>Full step definition</summary>

```json
{
  "id": "t1",
  "type": "trigger",
  "event": "appointment.booked",
  "match": {
    "eq": [
      "{{appointment.term.category}}",
      "closing"
    ]
  }
}
```

</details>

### 2. Appointment rescheduled — call type is closing call

- Step id `t2`, type `trigger`

Next:
- always → step 3 (`c0`)

<details><summary>Full step definition</summary>

```json
{
  "id": "t2",
  "type": "trigger",
  "event": "appointment.rescheduled",
  "match": {
    "eq": [
      "{{appointment.term.category}}",
      "closing"
    ]
  }
}
```

</details>

### 3. Wait for GHL to have the person (a booking can land first)

- Step id `c0`, type `check`
- Engine description: Check there is a CRM contact
- Detail: Waits up to 1 hour for it, looking every 2 minutes. Otherwise the run pauses for a person: contact has no CRM id yet: GHL did not have the person an hour after the booking
- If it keeps failing: the run is held on this step (it decides whether the run goes on)

Next:
- always → step 4 (`n1`)

<details><summary>Full step definition</summary>

```json
{
  "id": "c0",
  "title": "Wait for GHL to have the person (a booking can land first)",
  "type": "check",
  "when": {
    "exists": "contact.ghl_contact_id"
  },
  "else_exit": "no_crm_id",
  "else_pause": "contact has no CRM id yet: GHL did not have the person an hour after the booking",
  "retry": {
    "every": "2m",
    "for": "1h"
  }
}
```

</details>

### 4. Update the contact in the CRM

- Step id `n1`, type `update_contact`
- Detail: owner → the closer; appointment date = [call time]
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Next:
- always → step 5 (`u1`)

<details><summary>Full step definition</summary>

```json
{
  "id": "n1",
  "type": "update_contact",
  "set": {
    "assign_to": "{{appointment.closer.ghl_user_id | default:}}"
  },
  "fields": [
    {
      "id": "{{crm.field_contact_appointment_date}}",
      "value": "{{appointment.starts_at | date_company:yyyy-MM-dd}}"
    }
  ],
  "clear": []
}
```

</details>

### 5. Capture the booking's UTMs on the contact where GHL has none (D78)

- Step id `u1`, type `update_contact`
- Engine description: Update the contact in the CRM
- Detail: utm source = [UTM source] (only if empty); utm medium = [tracking utm medium] (only if empty); utm campaign = [tracking utm campaign] (only if empty); utm content = [tracking utm content] (only if empty); utm term = [tracking utm term] (only if empty); fbclid = [tracking fbclid] (only if empty)
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Next:
- always → step 6 (`n2`)

<details><summary>Full step definition</summary>

```json
{
  "id": "u1",
  "title": "Capture the booking's UTMs on the contact where GHL has none (D78)",
  "type": "update_contact",
  "set": {},
  "fields": [
    {
      "id": "{{crm.field_contact_utm_source | default:}}",
      "value": "{{appointment.tracking.utm_source | default:}}",
      "if_empty": true
    },
    {
      "id": "{{crm.field_contact_utm_medium | default:}}",
      "value": "{{appointment.tracking.utm_medium | default:}}",
      "if_empty": true
    },
    {
      "id": "{{crm.field_contact_utm_campaign | default:}}",
      "value": "{{appointment.tracking.utm_campaign | default:}}",
      "if_empty": true
    },
    {
      "id": "{{crm.field_contact_utm_content | default:}}",
      "value": "{{appointment.tracking.utm_content | default:}}",
      "if_empty": true
    },
    {
      "id": "{{crm.field_contact_utm_term | default:}}",
      "value": "{{appointment.tracking.utm_term | default:}}",
      "if_empty": true
    },
    {
      "id": "{{crm.field_contact_fbclid | default:}}",
      "value": "{{appointment.tracking.fbclid | default:}}",
      "if_empty": true
    }
  ],
  "clear": []
}
```

</details>

### 6. Which way?

- Step id `n2`, type `branch`
- If it keeps failing: the run is held on this step (it decides where the run goes)

Next:
- setter booked (when not self-booked) → step 7 (`b1`)
- self booked → step 8 (`s1`)

<details><summary>Full step definition</summary>

```json
{
  "id": "n2",
  "type": "branch"
}
```

</details>

### 7. Remember setter line = *Setter:* [setter]

- Step id `b1`, type `set_var`
- If it keeps failing: the run is held on this step (later steps read what it remembers)

Next:
- always → step 9 (`b2`)

<details><summary>Full step definition</summary>

```json
{
  "id": "b1",
  "type": "set_var",
  "key": "setter_line",
  "value": "*Setter:* {{appointment.set_by | default:unknown}}"
}
```

</details>

### 8. Remember setter line = 

- Step id `s1`, type `set_var`
- If it keeps failing: the run is held on this step (later steps read what it remembers)

Next:
- always → step 10 (`s2`)

<details><summary>Full step definition</summary>

```json
{
  "id": "s1",
  "type": "set_var",
  "key": "setter_line",
  "value": ""
}
```

</details>

### 9. Remember booking kind = setter booked

- Step id `b2`, type `set_var`
- If it keeps failing: the run is held on this step (later steps read what it remembers)

Next:
- always → step 11 (`b2b`)

<details><summary>Full step definition</summary>

```json
{
  "id": "b2",
  "type": "set_var",
  "key": "booking_kind",
  "value": "setter booked"
}
```

</details>

### 10. Remember booking kind = self-booked

- Step id `s2`, type `set_var`
- If it keeps failing: the run is held on this step (later steps read what it remembers)

Next:
- always → step 12 (`s2b`)

<details><summary>Full step definition</summary>

```json
{
  "id": "s2",
  "type": "set_var",
  "key": "booking_kind",
  "value": "self-booked"
}
```

</details>

### 11. Remember booking source = [setter]

- Step id `b2b`, type `set_var`
- If it keeps failing: the run is held on this step (later steps read what it remembers)

Next:
- always → step 13 (`b3`)

<details><summary>Full step definition</summary>

```json
{
  "id": "b2b",
  "type": "set_var",
  "key": "booking_source",
  "value": "{{picklist.sales_call_booking_source.setter}}"
}
```

</details>

### 12. Remember booking source = [self]

- Step id `s2b`, type `set_var`
- If it keeps failing: the run is held on this step (later steps read what it remembers)

Next:
- always → step 14 (`s3`)

<details><summary>Full step definition</summary>

```json
{
  "id": "s2b",
  "type": "set_var",
  "key": "booking_source",
  "value": "{{picklist.sales_call_booking_source.self}}"
}
```

</details>

### 13. Update the contact in the CRM

- Step id `b3`, type `update_contact`
- Detail: setter = [setter]
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Next:
- always → step 15 (`b4`)

<details><summary>Full step definition</summary>

```json
{
  "id": "b3",
  "type": "update_contact",
  "set": {},
  "fields": [
    {
      "id": "{{crm.field_contact_setter}}",
      "value": "{{appointment.set_by | default:}}"
    }
  ],
  "clear": []
}
```

</details>

### 14. Create or move pipeline card “[full name] -- Direct”

- Step id `s3`, type `pipeline_card`
- Detail: In the setter board, stage Direct Booked; owner → the closer
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Next:
- always → step 16 (`s4`)

<details><summary>Full step definition</summary>

```json
{
  "id": "s3",
  "type": "pipeline_card",
  "pipeline": "{{crm.pipeline_setter}}",
  "stage": "{{crm.stage_setter_direct_booked}}",
  "name": "{{contact.name}} -- Direct",
  "assign_to": "{{appointment.closer.ghl_user_id | default:}}",
  "if_missing": "create",
  "pick": "open",
  "fields": []
}
```

</details>

### 15. Create or move pipeline card “[full name] -- Set”

- Step id `b4`, type `pipeline_card`
- Detail: In the setter board, stage Appointment Set; owner → the closer; set setter owner = [setter]
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Next:
- always → step 17 (`b5`)

<details><summary>Full step definition</summary>

```json
{
  "id": "b4",
  "type": "pipeline_card",
  "pipeline": "{{crm.pipeline_setter}}",
  "stage": "{{crm.stage_setter_appointment_set}}",
  "name": "{{contact.name}} -- Set",
  "assign_to": "{{appointment.closer.ghl_user_id | default:}}",
  "if_missing": "create",
  "pick": "open",
  "fields": [
    {
      "id": "{{crm.field_opportunity_setter_owner}}",
      "value": "{{appointment.set_by | default:}}"
    }
  ]
}
```

</details>

### 16. Create or move pipeline card “[full name] -- Direct”

- Step id `s4`, type `pipeline_card`
- Detail: In the closer board, stage Scheduled; owner → the closer
- If it keeps failing: the run is held on this step (step k4 reads the closer card)

Next:
- always → step 18 (`s5`)

<details><summary>Full step definition</summary>

```json
{
  "id": "s4",
  "type": "pipeline_card",
  "pipeline": "{{crm.pipeline_closer}}",
  "stage": "{{crm.stage_closer_scheduled}}",
  "name": "{{contact.name}} -- Direct",
  "assign_to": "{{appointment.closer.ghl_user_id | default:}}",
  "if_missing": "create",
  "pick": "open",
  "fields": []
}
```

</details>

### 17. Create or move pipeline card “[full name] -- Setter Booked”

- Step id `b5`, type `pipeline_card`
- Detail: In the closer board, stage Scheduled; owner → the closer; set setter owner = [setter]
- If it keeps failing: the run is held on this step (step k4 reads the closer card)

Next:
- always → step 19 (`b6`)

<details><summary>Full step definition</summary>

```json
{
  "id": "b5",
  "type": "pipeline_card",
  "pipeline": "{{crm.pipeline_closer}}",
  "stage": "{{crm.stage_closer_scheduled}}",
  "name": "{{contact.name}} -- Setter Booked",
  "assign_to": "{{appointment.closer.ghl_user_id | default:}}",
  "if_missing": "create",
  "pick": "open",
  "fields": [
    {
      "id": "{{crm.field_opportunity_setter_owner}}",
      "value": "{{appointment.set_by | default:}}"
    }
  ]
}
```

</details>

### 18. Tags “+stat-booked” “+stat-self-booked” “+meta booked call” “−seq-no-show” “−seq-nurture” “−seq-winback” “−opt-in lead” “−stat-no-show” “−stat-cancelled” “−stat-possible-cancel” “−stat-needs-attention”

- Step id `s5`, type `tags`
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Next:
- always → step 20 (`k3`)

<details><summary>Full step definition</summary>

```json
{
  "id": "s5",
  "type": "tags",
  "add": [
    "stat-booked",
    "stat-self-booked",
    "meta booked call"
  ],
  "remove": [
    "seq-no-show",
    "seq-nurture",
    "seq-winback",
    "opt-in lead",
    "stat-no-show",
    "stat-cancelled",
    "stat-possible-cancel",
    "stat-needs-attention"
  ]
}
```

</details>

### 19. Tags “+stat-booked” “+stat-set” “+meta booked call” “−seq-no-show” “−seq-nurture” “−seq-winback” “−opt-in lead” “−stat-no-show” “−stat-cancelled” “−stat-possible-cancel” “−stat-needs-attention”

- Step id `b6`, type `tags`
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Next:
- always → step 20 (`k3`)

<details><summary>Full step definition</summary>

```json
{
  "id": "b6",
  "type": "tags",
  "add": [
    "stat-booked",
    "stat-set",
    "meta booked call"
  ],
  "remove": [
    "seq-no-show",
    "seq-nurture",
    "seq-winback",
    "opt-in lead",
    "stat-no-show",
    "stat-cancelled",
    "stat-possible-cancel",
    "stat-needs-attention"
  ]
}
```

</details>

### 20. Send {{contact.first_name}} a personalized video

- Step id `k3`, type `create_task`
- Engine description: Task for the closer: “Send [first name] a personalized video”
- Detail: Due in 1 day
- Runs only if: not a reschedule (otherwise skipped)
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Task title:

```
Send {{contact.first_name}} a personalized video
```

Task body:

```
Booked for {{appointment.starts_at | date_company}}. A quick personal video before the call.
```

Next:
- always → step 21 (`k5`)

<details><summary>Full step definition</summary>

```json
{
  "id": "k3",
  "title": "Send {{contact.first_name}} a personalized video",
  "only_if": {
    "neq": [
      "{{event._type}}",
      "appointment.rescheduled"
    ]
  },
  "type": "create_task",
  "body": "Booked for {{appointment.starts_at | date_company}}. A quick personal video before the call.",
  "due": "+1d",
  "assign_to": "{{appointment.closer.ghl_user_id | default:}}"
}
```

</details>

### 21. A reschedule: the slot the call left keeps its Sales Call, logged as rescheduled

- Step id `k5`, type `crm_record`
- Engine description: Update sales call record
- Detail: Keyed by slot the call moved from; 1 fields; only if the record already exists
- Runs only if: there is a slot the call moved from (otherwise skipped)
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Next:
- always → step 22 (`k4`)

<details><summary>Full step definition</summary>

```json
{
  "id": "k5",
  "title": "A reschedule: the slot the call left keeps its Sales Call, logged as rescheduled",
  "only_if": {
    "exists": "event.slot.from"
  },
  "type": "crm_record",
  "object": "custom_objects.sales_call",
  "key": "{{event.slot.from | default:}}",
  "properties": {
    "outcome": "{{picklist.sales_call_outcome.rescheduled}}"
  },
  "if_missing": "skip",
  "relate": [],
  "clear": []
}
```

</details>

### 22. Write sales call record

- Step id `k4`, type `crm_record`
- Detail: Keyed by this booking; 10 fields; linked to 2 related records
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Next:
- always → step 23 (`v4`)

<details><summary>Full step definition</summary>

```json
{
  "id": "k4",
  "type": "crm_record",
  "object": "custom_objects.sales_call",
  "key": "{{appointment.slot_key}}",
  "properties": {
    "closer": "{{appointment.closer.name | default:}}",
    "setter": "{{appointment.set_by | default:}}",
    "outcome": "{{picklist.sales_call_outcome.scheduled}}",
    "call_date": "{{appointment.starts_at | date_company:yyyy-MM-dd}}",
    "contact_id": "{{contact.ghl_contact_id | default:}}",
    "external_id": "{{appointment.slot_key}}",
    "scheduled_at": "{{appointment.starts_at}}",
    "display_label": "{{contact.name | default:Unknown}} — {{appointment.starts_at | date_company:yyyy-MM-dd}}",
    "booking_source": "{{vars.booking_source | default:}}",
    "opportunity_id": "{{cards.closer.id | default:}}"
  },
  "if_missing": "create",
  "relate": [
    {
      "association": "{{crm.assoc_sales_call_contact}}",
      "first": "{{contact.ghl_contact_id | default:}}",
      "second": "{{record.id}}"
    },
    {
      "association": "{{crm.assoc_sales_call_opportunity}}",
      "first": "{{record.id}}",
      "second": "{{cards.closer.id | default:}}"
    }
  ],
  "clear": []
}
```

</details>

### 23. Remember card = name Call rescheduled; icons :repeat:; reschedule mark repeat

- Step id `v4`, type `set_var`
- Detail: When this is a reschedule; otherwise name New call booked; icons :telephone_receiver:, :calendar:, :date:, :spiral_calendar_pad:; reschedule mark blank
- If it keeps failing: the run is held on this step (later steps read what it remembers)

Next:
- always → step 24 (`n4`)

<details><summary>Full step definition</summary>

```json
{
  "id": "v4",
  "type": "set_var",
  "key": "card",
  "value": {
    "name": "Call rescheduled",
    "icons": [
      ":repeat:"
    ],
    "reschedule_mark": "repeat"
  },
  "when": {
    "eq": [
      "{{event._type}}",
      "appointment.rescheduled"
    ]
  },
  "else_value": {
    "name": "New call booked",
    "icons": [
      ":telephone_receiver:",
      ":calendar:",
      ":date:",
      ":spiral_calendar_pad:"
    ],
    "reschedule_mark": ""
  }
}
```

</details>

### 24. Post the booking card in Slack (a reschedule: 🔁 face, 🔁 on the old card)

- Step id `n4`, type `slack_post`
- Engine description: Post to Slack (the bookings channel)
- Detail: reacts card reschedule mark on the post remembered as appointment:[an appointment]
- Goes to: channel {{slack.channel.bookings}}; posted as "{{vars.card.name}}"; remembered as appointment:{{appointment.id}}
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Slack post:

```
*Name:* <https://app.gohighlevel.com/v2/location/{{crm.location_id}}/contacts/detail/{{contact.ghl_contact_id | default:}}|{{contact.name | default:Unknown}}>
*Booked with:* {{appointment.closer.name | default:unassigned}}
{{vars.setter_line}}
*Appointment time:* {{appointment.starts_at | date_company}}
*Phone:* {{contact.phone | default:—}}
*Hair loss:* {{contact.fields.hair_loss | default:—}} {{contact.fields.hair_loss_stage | default:}}
*Noticing for:* {{contact.fields.noticing_for | default:—}}
*Commit to routine:* {{contact.fields.commit_routine | default:—}}
*Work situation:* {{contact.fields.work_situation | default:—}}
*Reschedule link:* {{appointment.reschedule_url | default:—}}
*Source:* {{contact.source | default:—}} · {{vars.booking_kind}}
```

Next:
- always → step 25 (`v_textoff`)

<details><summary>Full step definition</summary>

```json
{
  "id": "n4",
  "title": "Post the booking card in Slack (a reschedule: 🔁 face, 🔁 on the old card)",
  "type": "slack_post",
  "channel": "{{slack.channel.bookings}}",
  "template": "*Name:* <https://app.gohighlevel.com/v2/location/{{crm.location_id}}/contacts/detail/{{contact.ghl_contact_id | default:}}|{{contact.name | default:Unknown}}>\n*Booked with:* {{appointment.closer.name | default:unassigned}}\n{{vars.setter_line}}\n*Appointment time:* {{appointment.starts_at | date_company}}\n*Phone:* {{contact.phone | default:—}}\n*Hair loss:* {{contact.fields.hair_loss | default:—}} {{contact.fields.hair_loss_stage | default:}}\n*Noticing for:* {{contact.fields.noticing_for | default:—}}\n*Commit to routine:* {{contact.fields.commit_routine | default:—}}\n*Work situation:* {{contact.fields.work_situation | default:—}}\n*Reschedule link:* {{appointment.reschedule_url | default:—}}\n*Source:* {{contact.source | default:—}} · {{vars.booking_kind}}",
  "as": {
    "name": "{{vars.card.name}}",
    "icon": "{{vars.card.icons}}"
  },
  "thread_only": false,
  "tag": "appointment:{{appointment.id}}",
  "edit": false,
  "label": "mode",
  "react_on": {
    "of": "tag:appointment:{{appointment.id}}",
    "emojis": [
      "{{vars.card.reschedule_mark}}"
    ]
  }
}
```

</details>

### 25. Why no text can reach them: Do Not Disturb, or no phone

- Step id `v_textoff`, type `set_var`
- Engine description: Remember no text reason, picked by [contact sms dnd]
- Detail: true → has texts turned off (Do Not Disturb); otherwise 
- If it keeps failing: the run is held on this step (later steps read what it remembers)

Next:
- always → step 26 (`v_nophone`)

<details><summary>Full step definition</summary>

```json
{
  "id": "v_textoff",
  "title": "Why no text can reach them: Do Not Disturb, or no phone",
  "type": "set_var",
  "key": "no_text_reason",
  "value": "{{contact.sms_dnd}}",
  "pick": {
    "true": "has texts turned off (Do Not Disturb)"
  },
  "else_value": ""
}
```

</details>

### 26. …or no phone number on file

- Step id `v_nophone`, type `set_var`
- Engine description: Remember no text reason = has no phone number on file
- Detail: When no text reason is blank and not (there is a phone number); otherwise [no text reason]
- If it keeps failing: the run is held on this step (later steps read what it remembers)

Next:
- always → step 27 (`n_dnd`)

<details><summary>Full step definition</summary>

```json
{
  "id": "v_nophone",
  "title": "…or no phone number on file",
  "type": "set_var",
  "key": "no_text_reason",
  "value": "has no phone number on file",
  "when": {
    "and": [
      {
        "eq": [
          "{{vars.no_text_reason}}",
          ""
        ]
      },
      {
        "not": {
          "exists": "contact.phone"
        }
      }
    ]
  },
  "else_value": "{{vars.no_text_reason}}"
}
```

</details>

### 27. Texts can't reach them (Do Not Disturb or no phone): ⚠️ on the card and a note under it, once per booking

- Step id `n_dnd`, type `slack_post`
- Engine description: Reply in the thread of that Slack post
- Detail: reacts :warning: on it
- Runs only if: no text reason is not blank and this is not a reschedule (otherwise skipped)
- Goes to: channel {{slack.channel.bookings}}; in the thread of tag:appointment:{{appointment.id}}; thread only; posted as "Texts off"
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Slack post:

```
⚠️ {{contact.first_name | default:They}} {{vars.no_text_reason}}, so no texts will reach them. Call or email instead.
```

Next:
- always → step 28 (`n_nolink_note`)

<details><summary>Full step definition</summary>

```json
{
  "id": "n_dnd",
  "title": "Texts can't reach them (Do Not Disturb or no phone): ⚠️ on the card and a note under it, once per booking",
  "only_if": {
    "and": [
      {
        "neq": [
          "{{vars.no_text_reason}}",
          ""
        ]
      },
      {
        "neq": [
          "{{event._type}}",
          "appointment.rescheduled"
        ]
      }
    ]
  },
  "type": "slack_post",
  "channel": "{{slack.channel.bookings}}",
  "template": "⚠️ {{contact.first_name | default:They}} {{vars.no_text_reason}}, so no texts will reach them. Call or email instead.",
  "as": {
    "name": "Texts off",
    "icon": ":warning:"
  },
  "thread_of": "tag:appointment:{{appointment.id}}",
  "thread_only": true,
  "edit": false,
  "react": "warning",
  "label": "mode"
}
```

</details>

### 28. No meeting link: a note under the booking card, 🔗 on it

- Step id `n_nolink_note`, type `slack_post`
- Engine description: Reply in the thread of that Slack post
- Detail: reacts :link: on it
- Runs only if: not (there is a meeting link) (otherwise skipped)
- Goes to: channel {{slack.channel.bookings}}; in the thread of tag:appointment:{{appointment.id}}; thread only; posted as "No meeting link"
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Slack post:

```
🔗 No meeting link in Calendly for this call. {{appointment.closer.mention | default:Closer}}, please send them the link.
```

Next:
- always → step 29 (`n_nolink_alert`)

<details><summary>Full step definition</summary>

```json
{
  "id": "n_nolink_note",
  "title": "No meeting link: a note under the booking card, 🔗 on it",
  "only_if": {
    "not": {
      "exists": "appointment.meeting_url"
    }
  },
  "type": "slack_post",
  "channel": "{{slack.channel.bookings}}",
  "template": "🔗 No meeting link in Calendly for this call. {{appointment.closer.mention | default:Closer}}, please send them the link.",
  "as": {
    "name": "No meeting link",
    "icon": ":link:"
  },
  "thread_of": "tag:appointment:{{appointment.id}}",
  "thread_only": true,
  "edit": false,
  "react": "link",
  "label": "mode"
}
```

</details>

### 29. No meeting link: an issue in the alerts channel

- Step id `n_nolink_alert`, type `slack_post`
- Engine description: Post to Slack (the no link alerts channel)
- Runs only if: not (there is a meeting link) (otherwise skipped)
- Goes to: channel {{slack.channel.no_link_alerts}}; posted as "No meeting link"
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Slack post:

```
{{appointment.closer.mention | default:Heads up}}: {{contact.name | default:A contact}}'s call {{appointment.starts_at | date_company}} has no meeting link in Calendly. Please send them the link.
```

Next:
- always → step 30 (`x1`)

<details><summary>Full step definition</summary>

```json
{
  "id": "n_nolink_alert",
  "title": "No meeting link: an issue in the alerts channel",
  "only_if": {
    "not": {
      "exists": "appointment.meeting_url"
    }
  },
  "type": "slack_post",
  "channel": "{{slack.channel.no_link_alerts}}",
  "template": "{{appointment.closer.mention | default:Heads up}}: {{contact.name | default:A contact}}'s call {{appointment.starts_at | date_company}} has no meeting link in Calendly. Please send them the link.",
  "as": {
    "name": "No meeting link",
    "icon": ":link:"
  },
  "thread_only": false,
  "edit": false,
  "label": "mode"
}
```

</details>

### 30. Done: booking recorded

- Step id `x1`, type `exit`

Next: the run ends here.

<details><summary>Full step definition</summary>

```json
{
  "id": "x1",
  "type": "exit",
  "reason": "booked"
}
```

</details>

## Settings this workflow reads

| Key | Kind | Required to enable | Value |
| --- | --- | --- | --- |
| `crm.assoc_sales_call_contact` | id | yes | `6a8d189e508b4a44a5b37b91` |
| `crm.assoc_sales_call_opportunity` | id | yes | `6a8d189e3e5facf4692171fd` |
| `crm.field_contact_appointment_date` | id | yes | `ov1ZNmJjJyKL1YIukLck` |
| `crm.field_contact_fbclid` | id | no | `WkrOCVGjKaWxnptI1PKa` |
| `crm.field_contact_setter` | id | yes | `GngwKUu6eyjXsTmoEz8s` |
| `crm.field_contact_utm_campaign` | id | no | `WG9FD5zCk9XUyybclUPN` |
| `crm.field_contact_utm_content` | id | no | `IXnwhT2NNpwpqSujViDr` |
| `crm.field_contact_utm_medium` | id | no | `VKwcQhgFpCnHWajkwj7W` |
| `crm.field_contact_utm_source` | id | no | `VgT7mX7aJEUhwB5Wkbek` |
| `crm.field_contact_utm_term` | id | no | `BWtwm6UHjpzZmKABO2pa` |
| `crm.field_opportunity_setter_owner` | id | yes | `e9MDHi9qaP8ukfo11TKP` |
| `crm.location_id` | id | yes | `WUtLNZJFg8QbFWyQhlH1` |
| `crm.pipeline_closer` | id | yes | `TImaLginykFGirx5loC9` |
| `crm.pipeline_setter` | id | yes | `4J7CV5wJUTx1tyKhYRJb` |
| `crm.stage_closer_scheduled` | id | yes | `7f04241e-dd3b-4e9e-91e7-5fa3f485a09e` |
| `crm.stage_setter_appointment_set` | id | yes | `c4bac6ab-ff3b-448c-bdd3-09772b5d67d2` |
| `crm.stage_setter_direct_booked` | id | yes | `2f944060-d07c-4993-a6bc-040301ea4a51` |
| `slack.channel.bookings` | channel | no | `C0C7QCTHL8L` |
| `slack.channel.no_link_alerts` | channel | no | `C0BT26R4695` |

## Engine rules that apply but are not steps

These act on every run of this workflow from engine code. They are not in the definition above.

- **Mode.** The workflow's own mode, else the offer's, decides what is real: ghost writes and sends nothing, test is real only for test contacts, quiet writes the CRM but reaches no contact, live is real. (platform/src/engine/mode.ts:23, platform/src/engine/mode.ts:55)
- **Runs again?** A run's key is built from the re-entry policy; a second trigger with the same key starts nothing. A run that stops at a gate does not count. (platform/src/engine/reentry.ts:6)
- **Premise re-check.** Before each step the engine reads the CRM live; when "appointment exists" no longer holds, the run exits. (platform/src/engine/runner.ts:33)
- **Failures.** Errors are sorted into transient, auth, permanent and unknown. A step is retried after 1 and 5 minutes; then a non-blocking step is skipped and a blocking one is held and looked at again after 15 minutes, then hourly. An auth or permanent failure pauses the run until it is fixed. (platform/src/engine/failures.ts:19, platform/src/engine/failures.ts:21, platform/src/engine/blocking.ts:58)
- **Step cap.** At most 50 steps run in one go; a run past that fails. After an outage, at most 20 sends per offer per tick. (platform/src/engine/runner.ts:21, platform/src/engine/runner.ts:27)
- **CRM writes** without a natural key (notes, tasks, cards, records) are claimed once per run and step so a retry never writes twice. In ghost mode they are skipped. (platform/src/engine/effects.ts:13)
- **Slack before live.** Until the workflow is live, every post goes to the offer's test channel with a ghost/test label, unless `slack.live` is set. (platform/src/engine/mode.ts:32, platform/src/engine/mode.ts:34)
