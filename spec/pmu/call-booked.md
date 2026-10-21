# Call booked

Offer: **PMU** (`pmu`). Source: **from repo, may differ from live**. Generated 2026-10-21.

| Setting | Value |
| --- | --- |
| Where this definition came from | playbook copy: platform/installs/pmu/call-booked.json |
| Template | `call-booked` |
| Edited since copied from the template | unknown (repo) |
| Saved version | unknown (repo) |
| Enabled | unknown (repo) |
| Mode | unknown (repo) |
| Send lock | unknown (repo) |
| Runs again for the same person | always |
| Re-checked before every step | appointment exists |
| Send window | the offer's (unknown in repo) |
| Steps | 32 |
| Note | PMU: one board, one card fork after the setter / self paths: a new booking puts the card on Booked Call named -- Direct or -- Setter; a reschedule moves it to Rescheduled only off a pre-call stage and keeps its name; the Sales Call says Closing or Demo; no UTM fields; Appointment Start Time in PMU's format (MM-dd-yyyy HH:mm) |

## Steps

Every step, in the order a run meets it from the trigger. Steps that only assemble words (`set_var`) are listed too.

### 1. Appointment booked — call type is closing call

- Step id `t1`, type `trigger`

Next:
- always → step 3 (`c_via`)

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
- always → step 3 (`c_via`)

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

### 3. Where the booking came from, in words

- Step id `c_via`, type `set_var`
- Engine description: Remember booked via, picked by [appointment source]
- Detail: calendly → Calendly; ghl → GHL calendar; otherwise booking page
- If it keeps failing: the run is held on this step (later steps read what it remembers)

Next:
- always → step 4 (`c0`)

<details><summary>Full step definition</summary>

```json
{
  "id": "c_via",
  "title": "Where the booking came from, in words",
  "type": "set_var",
  "key": "booked_via",
  "value": "{{appointment.source}}",
  "pick": {
    "calendly": "Calendly",
    "ghl": "GHL calendar"
  },
  "else_value": "booking page"
}
```

</details>

### 4. Make sure the person is in GHL: found by id, email or phone, else created

- Step id `c0`, type `ensure_contact`
- Engine description: Make sure the person is in the CRM
- Detail: Found by their CRM id, email or phone, else created; tagged with the company's scope tag; fields the CRM has blank are filled, nothing it holds is overwritten
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Next:
- always → step 5 (`c_added`)

<details><summary>Full step definition</summary>

```json
{
  "id": "c0",
  "title": "Make sure the person is in GHL: found by id, email or phone, else created",
  "type": "ensure_contact",
  "scope_tag": true,
  "source": "{{vars.booked_via}} booking"
}
```

</details>

### 5. A line on the card when the booking put them in GHL

- Step id `c_added`, type `set_var`
- Engine description: Remember added line, picked by [c0 action]
- Detail: created → *New to GHL:* added from their [booked via] booking; otherwise 
- If it keeps failing: the run is held on this step (later steps read what it remembers)

Next:
- always → step 6 (`c_note`)

<details><summary>Full step definition</summary>

```json
{
  "id": "c_added",
  "title": "A line on the card when the booking put them in GHL",
  "type": "set_var",
  "key": "added_line",
  "value": "{{vars.c0.action}}",
  "pick": {
    "created": "*New to GHL:* added from their {{vars.booked_via}} booking"
  },
  "else_value": ""
}
```

</details>

### 6. Say on the contact that the booking added them

- Step id `c_note`, type `note`
- Engine description: Leave an internal note
- Runs only if: c0 action is “created” (otherwise skipped)
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

CRM note:

```
Added to GHL by the booking engine from their {{vars.booked_via}} booking ({{appointment.starts_at | date_company}}): they were not in GHL by email or phone.
```

Next:
- always → step 7 (`n1`)

<details><summary>Full step definition</summary>

```json
{
  "id": "c_note",
  "title": "Say on the contact that the booking added them",
  "only_if": {
    "eq": [
      "{{vars.c0.action}}",
      "created"
    ]
  },
  "type": "note",
  "template": "Added to GHL by the booking engine from their {{vars.booked_via}} booking ({{appointment.starts_at | date_company}}): they were not in GHL by email or phone."
}
```

</details>

### 7. Update the contact in the CRM

- Step id `n1`, type `update_contact`
- Detail: owner → the closer; appointment date = [call time]
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Next:
- always → step 8 (`n2`)

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
      "value": "{{appointment.starts_at | date_company:MM-dd-yyyy HH:mm}}"
    }
  ],
  "clear": []
}
```

</details>

### 8. Which way?

- Step id `n2`, type `branch`
- If it keeps failing: the run is held on this step (it decides where the run goes)

Next:
- setter booked (when not self-booked) → step 9 (`b1`)
- self booked → step 10 (`s1`)

<details><summary>Full step definition</summary>

```json
{
  "id": "n2",
  "type": "branch"
}
```

</details>

### 9. Remember setter line = *Setter:* [setter]

- Step id `b1`, type `set_var`
- If it keeps failing: the run is held on this step (later steps read what it remembers)

Next:
- always → step 11 (`b2`)

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

### 10. Remember setter line = 

- Step id `s1`, type `set_var`
- If it keeps failing: the run is held on this step (later steps read what it remembers)

Next:
- always → step 12 (`s2`)

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

### 11. Remember booking kind = setter booked

- Step id `b2`, type `set_var`
- If it keeps failing: the run is held on this step (later steps read what it remembers)

Next:
- always → step 13 (`b2b`)

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

### 12. Remember booking kind = self-booked

- Step id `s2`, type `set_var`
- If it keeps failing: the run is held on this step (later steps read what it remembers)

Next:
- always → step 14 (`s2b`)

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

### 13. Remember booking source = [setter]

- Step id `b2b`, type `set_var`
- If it keeps failing: the run is held on this step (later steps read what it remembers)

Next:
- always → step 15 (`b3`)

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

### 14. Remember booking source = [self]

- Step id `s2b`, type `set_var`
- If it keeps failing: the run is held on this step (later steps read what it remembers)

Next:
- always → step 16 (`s_suffix`)

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

### 15. The setter goes on the contact

- Step id `b3`, type `update_contact`
- Engine description: Update the contact in the CRM
- Detail: setter = [setter]
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Next:
- always → step 17 (`b_suffix`)

<details><summary>Full step definition</summary>

```json
{
  "id": "b3",
  "title": "The setter goes on the contact",
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

### 16. Remember card suffix = Direct

- Step id `s_suffix`, type `set_var`
- If it keeps failing: the run is held on this step (later steps read what it remembers)

Next:
- always → step 18 (`s5`)

<details><summary>Full step definition</summary>

```json
{
  "id": "s_suffix",
  "type": "set_var",
  "key": "card_suffix",
  "value": "Direct"
}
```

</details>

### 17. Remember card suffix = Setter

- Step id `b_suffix`, type `set_var`
- If it keeps failing: the run is held on this step (later steps read what it remembers)

Next:
- always → step 19 (`b6`)

<details><summary>Full step definition</summary>

```json
{
  "id": "b_suffix",
  "type": "set_var",
  "key": "card_suffix",
  "value": "Setter"
}
```

</details>

### 18. Tags “+stat-booked” “+stat-self-booked” “+meta booked call” “−seq-no-show” “−seq-nurture” “−seq-winback” “−opt-in lead” “−stat-no-show” “−stat-cancelled” “−stat-possible-cancel” “−stat-needs-attention”

- Step id `s5`, type `tags`
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Next:
- always → step 20 (`f_card`)

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
- always → step 20 (`f_card`)

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

### 20. A new booking or a reschedule?

- Step id `f_card`, type `branch`
- Engine description: Which way?
- If it keeps failing: the run is held on this step (it decides where the run goes)

Next:
- a reschedule (when this is a reschedule) → step 21 (`c_rs`)
- a new booking → step 22 (`c_new`)

<details><summary>Full step definition</summary>

```json
{
  "id": "f_card",
  "title": "A new booking or a reschedule?",
  "type": "branch"
}
```

</details>

### 21. Card → Rescheduled, if it is before the call (its name stays)

- Step id `c_rs`, type `pipeline_card`
- Engine description: Create or move pipeline card
- Detail: In the closer board, stage Rescheduled; owner → the closer; set setter owner = [setter]; only a card on New Lead, Scheduled, Unresponsive, Confirmed, No Show, Cancelled, Rescheduled moves (a card on any other stage is left where it is); an existing card keeps its name, a new one is named “[full name] -- [the card's name ending]”
- If it keeps failing: the run is held on this step (step k4 reads the closer card)

Next:
- always → step 23 (`k5`)

<details><summary>Full step definition</summary>

```json
{
  "id": "c_rs",
  "title": "Card → Rescheduled, if it is before the call (its name stays)",
  "type": "pipeline_card",
  "pipeline": "{{crm.pipeline_closer}}",
  "stage": "{{crm.stage_closer_rescheduled}}",
  "name": "{{contact.name}} -- {{vars.card_suffix}}",
  "assign_to": "{{appointment.closer.ghl_user_id | default:}}",
  "if_missing": "create",
  "pick": "open",
  "fields": [
    {
      "id": "{{crm.field_opportunity_setter_owner}}",
      "value": "{{appointment.set_by | default:}}"
    }
  ],
  "from_stages": [
    "{{crm.stage_closer_new_lead}}",
    "{{crm.stage_closer_scheduled}}",
    "{{crm.stage_closer_unresponsive}}",
    "{{crm.stage_closer_confirmed}}",
    "{{crm.stage_closer_no_show}}",
    "{{crm.stage_closer_cancelled}}",
    "{{crm.stage_closer_rescheduled}}"
  ],
  "keep_name": true
}
```

</details>

### 22. Card → Booked Call, named -- Setter / -- Direct

- Step id `c_new`, type `pipeline_card`
- Engine description: Create or move pipeline card “[full name] -- [the card's name ending]”
- Detail: In the closer board, stage Scheduled; owner → the closer; set setter owner = [setter]
- If it keeps failing: the run is held on this step (step k4 reads the closer card)

Next:
- always → step 24 (`k3`)

<details><summary>Full step definition</summary>

```json
{
  "id": "c_new",
  "title": "Card → Booked Call, named -- Setter / -- Direct",
  "type": "pipeline_card",
  "pipeline": "{{crm.pipeline_closer}}",
  "stage": "{{crm.stage_closer_scheduled}}",
  "name": "{{contact.name}} -- {{vars.card_suffix}}",
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

### 23. The Sales Call for the old time: logged as rescheduled

- Step id `k5`, type `crm_record`
- Engine description: Update sales call record
- Detail: Keyed by slot the call moved from; 1 fields; only if the record already exists
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Next:
- always → step 25 (`v_type`)

<details><summary>Full step definition</summary>

```json
{
  "id": "k5",
  "title": "The Sales Call for the old time: logged as rescheduled",
  "type": "crm_record",
  "object": "{{crm.object_sales_call | default:custom_objects.sales_call}}",
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

### 24. Send {{contact.first_name}} a personalized video

- Step id `k3`, type `create_task`
- Engine description: Task for the closer: “Send [first name] a personalized video”
- Detail: Due in 1 day
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
- always → step 25 (`v_type`)

<details><summary>Full step definition</summary>

```json
{
  "id": "k3",
  "title": "Send {{contact.first_name}} a personalized video",
  "type": "create_task",
  "body": "Booked for {{appointment.starts_at | date_company}}. A quick personal video before the call.",
  "due": "+1d",
  "assign_to": "{{appointment.closer.ghl_user_id | default:}}"
}
```

</details>

### 25. Closing or Demo: the call type the calendar books

- Step id `v_type`, type `set_var`
- Engine description: Remember call type, picked by [term name]
- Detail: Demo call → demo; otherwise closing
- If it keeps failing: the run is held on this step (later steps read what it remembers)

Next:
- always → step 26 (`k4`)

<details><summary>Full step definition</summary>

```json
{
  "id": "v_type",
  "title": "Closing or Demo: the call type the calendar books",
  "type": "set_var",
  "key": "call_type",
  "value": "{{appointment.term.name}}",
  "pick": {
    "Demo call": "demo"
  },
  "else_value": "closing"
}
```

</details>

### 26. Write sales call record

- Step id `k4`, type `crm_record`
- Detail: Keyed by this booking; 11 fields; linked to 2 related records
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Next:
- always → step 27 (`v4`)

<details><summary>Full step definition</summary>

```json
{
  "id": "k4",
  "type": "crm_record",
  "object": "{{crm.object_sales_call | default:custom_objects.sales_call}}",
  "key": "{{appointment.slot_key}}",
  "properties": {
    "display_label": "{{contact.name | default:Unknown}} — {{appointment.starts_at | date_company:yyyy-MM-dd}}",
    "external_id": "{{appointment.slot_key}}",
    "contact_id": "{{contact.ghl_contact_id | default:}}",
    "opportunity_id": "{{cards.closer.id | default:}}",
    "scheduled_at": "{{appointment.starts_at}}",
    "call_date": "{{appointment.starts_at | date_company:yyyy-MM-dd}}",
    "closer": "{{appointment.closer.first_name | default: | lower}}",
    "setter": "{{appointment.set_by | default:}}",
    "outcome": "{{picklist.sales_call_outcome.scheduled}}",
    "booking_source": "{{vars.booking_source | default:}}",
    "call_type": "{{vars.call_type}}"
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

### 27. Remember card = name Call rescheduled; icons :repeat:; reschedule mark repeat

- Step id `v4`, type `set_var`
- Detail: When this is a reschedule; otherwise name New call booked; icons :telephone_receiver:, :calendar:, :date:, :spiral_calendar_pad:; reschedule mark blank
- If it keeps failing: the run is held on this step (later steps read what it remembers)

Next:
- always → step 28 (`n4`)

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

### 28. Post the booking card in Slack (a reschedule: 🔁 face, 🔁 on the old card)

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
*Phone:* {{contact.phone | default:—}}{{contact.intake_lines | line}}
*Reschedule link:* {{appointment.reschedule_url | default:—}}
*Source:* {{contact.source | default:—}} · {{vars.booking_kind}}{{vars.added_line | line}}
```

Next:
- always → step 29 (`v_textoff`)

<details><summary>Full step definition</summary>

```json
{
  "id": "n4",
  "title": "Post the booking card in Slack (a reschedule: 🔁 face, 🔁 on the old card)",
  "type": "slack_post",
  "channel": "{{slack.channel.bookings}}",
  "template": "*Name:* <https://app.gohighlevel.com/v2/location/{{crm.location_id}}/contacts/detail/{{contact.ghl_contact_id | default:}}|{{contact.name | default:Unknown}}>\n*Booked with:* {{appointment.closer.name | default:unassigned}}\n{{vars.setter_line}}\n*Appointment time:* {{appointment.starts_at | date_company}}\n*Phone:* {{contact.phone | default:—}}{{contact.intake_lines | line}}\n*Reschedule link:* {{appointment.reschedule_url | default:—}}\n*Source:* {{contact.source | default:—}} · {{vars.booking_kind}}{{vars.added_line | line}}",
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

### 29. Why no text can reach them: Do Not Disturb, or no phone

- Step id `v_textoff`, type `set_var`
- Engine description: Remember no text reason, picked by [contact sms dnd]
- Detail: true → has texts turned off (Do Not Disturb); otherwise 
- If it keeps failing: the run is held on this step (later steps read what it remembers)

Next:
- always → step 30 (`v_nophone`)

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

### 30. …or no phone number on file

- Step id `v_nophone`, type `set_var`
- Engine description: Remember no text reason = has no phone number on file
- Detail: When no text reason is blank and not (there is a phone number); otherwise [no text reason]
- If it keeps failing: the run is held on this step (later steps read what it remembers)

Next:
- always → step 31 (`n_dnd`)

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

### 31. Texts can't reach them (Do Not Disturb or no phone): ⚠️ on the card and a note under it, once per booking

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
- always → step 32 (`x1`)

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

### 32. Done: booking recorded

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
| `crm.assoc_sales_call_contact` | id | yes | not read (repo) |
| `crm.assoc_sales_call_opportunity` | id | yes | not read (repo) |
| `crm.field_contact_appointment_date` | id | yes | not read (repo) |
| `crm.field_contact_setter` | id | yes | not read (repo) |
| `crm.field_opportunity_setter_owner` | id | yes | not read (repo) |
| `crm.location_id` | id | yes | not read (repo) |
| `crm.object_sales_call` | id | no | not read (repo) |
| `crm.pipeline_closer` | id | yes | not read (repo) |
| `crm.stage_closer_cancelled` | id | yes | not read (repo) |
| `crm.stage_closer_confirmed` | id | yes | not read (repo) |
| `crm.stage_closer_new_lead` | id | yes | not read (repo) |
| `crm.stage_closer_no_show` | id | yes | not read (repo) |
| `crm.stage_closer_rescheduled` | id | yes | not read (repo) |
| `crm.stage_closer_scheduled` | id | yes | not read (repo) |
| `crm.stage_closer_unresponsive` | id | yes | not read (repo) |
| `slack.channel.bookings` | channel | no | not read (repo) |

## Engine rules that apply but are not steps

These act on every run of this workflow from engine code. They are not in the definition above.

- **Mode.** The workflow's own mode, else the offer's, decides what is real: ghost writes and sends nothing, test is real only for test contacts, quiet writes the CRM but reaches no contact, live is real. (platform/src/engine/mode.ts:23, platform/src/engine/mode.ts:55)
- **Runs again?** A run's key is built from the re-entry policy; a second trigger with the same key starts nothing. A run that stops at a gate does not count. (platform/src/engine/reentry.ts:6)
- **Premise re-check.** Before each step the engine reads the CRM live; when "appointment exists" no longer holds, the run exits. (platform/src/engine/runner.ts:33)
- **Failures.** Errors are sorted into transient, auth, permanent and unknown. A step is retried after 1 and 5 minutes; then a non-blocking step is skipped and a blocking one is held and looked at again after 15 minutes, then hourly. An auth or permanent failure pauses the run until it is fixed. (platform/src/engine/failures.ts:19, platform/src/engine/failures.ts:21, platform/src/engine/blocking.ts:58)
- **Step cap.** At most 50 steps run in one go; a run past that fails. After an outage, at most 20 sends per offer per tick. (platform/src/engine/runner.ts:21, platform/src/engine/runner.ts:27)
- **CRM writes** without a natural key (notes, tasks, cards, records) are claimed once per run and step so a retry never writes twice. In ghost mode they are skipped. (platform/src/engine/effects.ts:13)
- **Slack before live.** Until the workflow is live, every post goes to the offer's test channel with a ghost/test label, unless `slack.live` is set. (platform/src/engine/mode.ts:32, platform/src/engine/mode.ts:34)
