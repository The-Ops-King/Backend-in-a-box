# Call booked

Offer: **PMU** (`pmu`). Source: live database. Generated 2026-10-21.

| Setting | Value |
| --- | --- |
| Where this definition came from | live: version 7, saved 2026-10-14T00:03:18.801Z (PMU: one board, one card fork after the setter / self paths: a new booking puts the card on Booked Call named -- Direct or -- Setter; a reschedule moves it to Rescheduled only off a pre-call stage and keeps its name; the Sales Call says Closing or Demo; no UTM fields; Appointment Start Time in PMU's format (10-15-2026 15:00); the video task sits under a new booking and the old slot's Sales Call under a reschedule) |
| Template | `call-booked` v16 |
| Edited since copied from the template | yes |
| Saved version | 7 |
| Enabled | on |
| Mode | follows the offer (ghost) |
| Send lock | locked: texts, emails, documents and webhooks reach only the operator's own addresses |
| Runs again for the same person | always |
| Re-checked before every step | appointment exists |
| Send window | 08:00 to 20:00, the contact's time zone |
| Steps | 26 |

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
- always → step 5 (`n2`)

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

### 5. Which way?

- Step id `n2`, type `branch`
- If it keeps failing: the run is held on this step (it decides where the run goes)

Next:
- setter booked (when not self-booked) → step 6 (`b1`)
- self booked → step 7 (`s1`)

<details><summary>Full step definition</summary>

```json
{
  "id": "n2",
  "type": "branch"
}
```

</details>

### 6. Remember setter line = *Setter:* [setter]

- Step id `b1`, type `set_var`
- If it keeps failing: the run is held on this step (later steps read what it remembers)

Next:
- always → step 8 (`b2`)

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

### 7. Remember setter line = 

- Step id `s1`, type `set_var`
- If it keeps failing: the run is held on this step (later steps read what it remembers)

Next:
- always → step 9 (`s2`)

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

### 8. Remember booking kind = setter booked

- Step id `b2`, type `set_var`
- If it keeps failing: the run is held on this step (later steps read what it remembers)

Next:
- always → step 10 (`b2b`)

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

### 9. Remember booking kind = self-booked

- Step id `s2`, type `set_var`
- If it keeps failing: the run is held on this step (later steps read what it remembers)

Next:
- always → step 11 (`s2b`)

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

### 10. Remember booking source = [setter]

- Step id `b2b`, type `set_var`
- If it keeps failing: the run is held on this step (later steps read what it remembers)

Next:
- always → step 12 (`b3`)

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

### 11. Remember booking source = [self]

- Step id `s2b`, type `set_var`
- If it keeps failing: the run is held on this step (later steps read what it remembers)

Next:
- always → step 13 (`s_suffix`)

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

### 12. The setter goes on the contact

- Step id `b3`, type `update_contact`
- Engine description: Update the contact in the CRM
- Detail: setter = [setter]
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Next:
- always → step 14 (`b_suffix`)

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

### 13. Remember card suffix = Direct

- Step id `s_suffix`, type `set_var`
- If it keeps failing: the run is held on this step (later steps read what it remembers)

Next:
- always → step 15 (`s5`)

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

### 14. Remember card suffix = Setter

- Step id `b_suffix`, type `set_var`
- If it keeps failing: the run is held on this step (later steps read what it remembers)

Next:
- always → step 16 (`b6`)

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

### 15. Tags “+stat-booked” “+stat-self-booked” “+meta booked call” “−seq-no-show” “−seq-nurture” “−seq-winback” “−opt-in lead” “−stat-no-show” “−stat-cancelled” “−stat-possible-cancel” “−stat-needs-attention”

- Step id `s5`, type `tags`
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Next:
- always → step 17 (`f_card`)

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

### 16. Tags “+stat-booked” “+stat-set” “+meta booked call” “−seq-no-show” “−seq-nurture” “−seq-winback” “−opt-in lead” “−stat-no-show” “−stat-cancelled” “−stat-possible-cancel” “−stat-needs-attention”

- Step id `b6`, type `tags`
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Next:
- always → step 17 (`f_card`)

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

### 17. A new booking or a reschedule?

- Step id `f_card`, type `branch`
- Engine description: Which way?
- If it keeps failing: the run is held on this step (it decides where the run goes)

Next:
- a reschedule (when this is a reschedule) → step 18 (`c_rs`)
- a new booking → step 19 (`c_new`)

<details><summary>Full step definition</summary>

```json
{
  "id": "f_card",
  "title": "A new booking or a reschedule?",
  "type": "branch"
}
```

</details>

### 18. Card → Rescheduled, if it is before the call (its name stays)

- Step id `c_rs`, type `pipeline_card`
- Engine description: Create or move pipeline card
- Detail: In the closer board, stage Rescheduled; owner → the closer; set setter owner = [setter]; only a card on New Lead, Scheduled, Unresponsive, Confirmed, No Show, Cancelled, Rescheduled moves (a card on any other stage is left where it is); an existing card keeps its name, a new one is named “[full name] -- [the card's name ending]”
- If it keeps failing: the run is held on this step (step k4 reads the closer card)

Next:
- always → step 20 (`k5`)

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

### 19. Card → Booked Call, named -- Setter / -- Direct

- Step id `c_new`, type `pipeline_card`
- Engine description: Create or move pipeline card “[full name] -- [the card's name ending]”
- Detail: In the closer board, stage Scheduled; owner → the closer; set setter owner = [setter]
- If it keeps failing: the run is held on this step (step k4 reads the closer card)

Next:
- always → step 21 (`k3`)

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

### 20. The Sales Call for the old time: logged as rescheduled

- Step id `k5`, type `crm_record`
- Engine description: Update sales call record
- Detail: Keyed by slot the call moved from; 1 fields; only if the record already exists
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Next:
- always → step 22 (`v_type`)

<details><summary>Full step definition</summary>

```json
{
  "id": "k5",
  "title": "The Sales Call for the old time: logged as rescheduled",
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

### 21. Send {{contact.first_name}} a personalized video

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
- always → step 22 (`v_type`)

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

### 22. Closing or Demo: the call type the calendar books

- Step id `v_type`, type `set_var`
- Engine description: Remember call type, picked by [term name]
- Detail: Demo call → demo; otherwise closing
- If it keeps failing: the run is held on this step (later steps read what it remembers)

Next:
- always → step 23 (`k4`)

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

### 23. Write sales call record

- Step id `k4`, type `crm_record`
- Detail: Keyed by this booking; 11 fields; linked to 2 related records
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Next:
- always → step 24 (`v4`)

<details><summary>Full step definition</summary>

```json
{
  "id": "k4",
  "type": "crm_record",
  "object": "custom_objects.sales_call",
  "key": "{{appointment.slot_key}}",
  "properties": {
    "closer": "{{appointment.closer.first_name | default: | lower}}",
    "setter": "{{appointment.set_by | default:}}",
    "outcome": "{{picklist.sales_call_outcome.scheduled}}",
    "call_date": "{{appointment.starts_at | date_company:yyyy-MM-dd}}",
    "call_type": "{{vars.call_type}}",
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

### 24. Remember card = name Call rescheduled; icons :repeat:; reschedule mark repeat

- Step id `v4`, type `set_var`
- Detail: When this is a reschedule; otherwise name New call booked; icons :telephone_receiver:, :calendar:, :date:, :spiral_calendar_pad:; reschedule mark blank
- If it keeps failing: the run is held on this step (later steps read what it remembers)

Next:
- always → step 25 (`n4`)

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

### 25. Post the booking card in Slack (a reschedule: 🔁 face, 🔁 on the old card)

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
*Source:* {{contact.source | default:—}} · {{vars.booking_kind}}
```

Next:
- always → step 26 (`x1`)

<details><summary>Full step definition</summary>

```json
{
  "id": "n4",
  "title": "Post the booking card in Slack (a reschedule: 🔁 face, 🔁 on the old card)",
  "type": "slack_post",
  "channel": "{{slack.channel.bookings}}",
  "template": "*Name:* <https://app.gohighlevel.com/v2/location/{{crm.location_id}}/contacts/detail/{{contact.ghl_contact_id | default:}}|{{contact.name | default:Unknown}}>\n*Booked with:* {{appointment.closer.name | default:unassigned}}\n{{vars.setter_line}}\n*Appointment time:* {{appointment.starts_at | date_company}}\n*Phone:* {{contact.phone | default:—}}{{contact.intake_lines | line}}\n*Reschedule link:* {{appointment.reschedule_url | default:—}}\n*Source:* {{contact.source | default:—}} · {{vars.booking_kind}}",
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

### 26. Done: booking recorded

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
| `crm.assoc_sales_call_contact` | id | yes | `6ab44fe67f8a0a87bc8a542d` |
| `crm.assoc_sales_call_opportunity` | id | yes | `6ace9cd588661082b9b4aa71` |
| `crm.field_contact_appointment_date` | id | yes | `uqulQPE8vPu0RZDyDXIj` |
| `crm.field_contact_setter` | id | yes | `h6eZzKxkKp6dLfQfxVdO` |
| `crm.field_opportunity_setter_owner` | id | yes | `Q2rC8L2dLPizfO2mC6Rd` |
| `crm.location_id` | id | yes | `gA10c58jLJRYbNwC3apW` |
| `crm.pipeline_closer` | id | yes | `1B37Vzv6euKMpWaFFuVW` |
| `crm.stage_closer_cancelled` | id | yes | `b476556a-26f3-4bff-86eb-05fdcf0c5bd0` |
| `crm.stage_closer_confirmed` | id | yes | `d2fdd051-1e22-4e8c-8d52-dc94ed41b91b` |
| `crm.stage_closer_new_lead` | id | yes | `7dc8ac43-8b8a-4db7-bc13-ff73c7a326de` |
| `crm.stage_closer_no_show` | id | yes | `89d423f9-38f0-4e51-87e5-ce007c9c5de7` |
| `crm.stage_closer_rescheduled` | id | yes | `bfd72f87-56e1-43c3-847f-12f0864df851` |
| `crm.stage_closer_scheduled` | id | yes | `0c8b03fb-9e38-46ed-a33f-5e02d7f264a3` |
| `crm.stage_closer_unresponsive` | id | yes | `17b819aa-4423-4771-b53e-731289529026` |
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
