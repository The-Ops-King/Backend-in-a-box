# Call outcome filed

Offer: **Dating (Nelly)** (`dating-nelly`). Source: live database. Generated 2026-10-21.

| Setting | Value |
| --- | --- |
| Where this definition came from | live: version 4, saved 2026-10-18T18:21:13.843Z (upgraded to template v11) |
| Template | `call-outcome` v11 |
| Edited since copied from the template | no |
| Saved version | 4 |
| Enabled | on |
| Mode | live |
| Send lock | locked: texts, emails, documents and webhooks reach only the operator's own addresses |
| Runs again for the same person | always |
| Re-checked before every step | nothing |
| Send window | 08:00 to 20:00, the contact's time zone |
| Steps | 36 |

## Steps

Every step, in the order a run meets it from the trigger. Steps that only assemble words (`set_var`) are listed too.

### 1. The call's outcome is filed — the source is a closer's form and call type is closing call

- Step id `t1`, type `trigger`

Next:
- always → step 3 (`u1`)

<details><summary>Full step definition</summary>

```json
{
  "id": "t1",
  "type": "trigger",
  "event": "appointment.outcome",
  "match": {
    "and": [
      {
        "eq": [
          "{{event._source}}",
          "disposition"
        ]
      },
      {
        "eq": [
          "{{appointment.term.category}}",
          "closing"
        ]
      }
    ]
  }
}
```

</details>

### 2. An appointment's status changed — new status is no-show and call type is closing call

- Step id `t2`, type `trigger`

Next:
- always → step 4 (`g1`)

<details><summary>Full step definition</summary>

```json
{
  "id": "t2",
  "type": "trigger",
  "event": "appointment.status_changed",
  "match": {
    "and": [
      {
        "eq": [
          "{{event.status.to}}",
          "noshow"
        ]
      },
      {
        "eq": [
          "{{appointment.term.category}}",
          "closing"
        ]
      }
    ]
  }
}
```

</details>

### 3. What the call's earlier answer tagged

- Step id `u1`, type `set_var`
- Engine description: Remember tags before, picked by [the earlier answer]:[the earlier call outcome]
- Detail: noshow: → stat-no-show, stat-possible-cancel; showed: → stat-showed; showed:lost → stat-showed, stat-lost; showed:closed → stat-showed, stat-closed-won; showed:deposit → stat-showed, stat-deposit; showed:pending → stat-showed; showed:follow up → stat-showed, stat-follow-up; showed:unqualified → stat-showed, stat-disqualified; otherwise 
- If it keeps failing: the run is held on this step (later steps read what it remembers)

Next:
- always → step 5 (`u2`)

<details><summary>Full step definition</summary>

```json
{
  "id": "u1",
  "title": "What the call's earlier answer tagged",
  "type": "set_var",
  "key": "tags_before",
  "value": "{{event.previous_outcome | default:}}:{{event.previous_call_outcome | default:}}",
  "pick": {
    "noshow:": [
      "stat-no-show",
      "stat-possible-cancel"
    ],
    "showed:": [
      "stat-showed"
    ],
    "showed:lost": [
      "stat-showed",
      "stat-lost"
    ],
    "showed:closed": [
      "stat-showed",
      "stat-closed-won"
    ],
    "showed:deposit": [
      "stat-showed",
      "stat-deposit"
    ],
    "showed:pending": [
      "stat-showed"
    ],
    "showed:follow_up": [
      "stat-showed",
      "stat-follow-up"
    ],
    "showed:unqualified": [
      "stat-showed",
      "stat-disqualified"
    ]
  },
  "else_value": []
}
```

</details>

### 4. React 👻 on the booking post

- Step id `g1`, type `slack_post`
- Engine description: Reply in the thread of that Slack post
- Detail: reacts :ghost: on it; takes back the reaction an earlier answer left on the post
- Goes to: channel {{slack.channel.bookings}}; in the thread of tag:appointment:{{appointment.id}}; thread only; edits the earlier post; posted as "No-show"; remembered as outcome:{{appointment.id}}
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Slack post:

```
👻 No-show for the call {{appointment.starts_at | date_company}} with {{appointment.closer.name | default:the closer}}.
```

Next:
- always → step 6 (`g2`)

<details><summary>Full step definition</summary>

```json
{
  "id": "g1",
  "title": "React 👻 on the booking post",
  "type": "slack_post",
  "channel": "{{slack.channel.bookings}}",
  "template": "👻 No-show for the call {{appointment.starts_at | date_company}} with {{appointment.closer.name | default:the closer}}.",
  "as": {
    "name": "No-show",
    "icon": ":ghost:"
  },
  "thread_of": "tag:appointment:{{appointment.id}}",
  "thread_only": true,
  "tag": "outcome:{{appointment.id}}",
  "edit": true,
  "react": "ghost",
  "label": "mode",
  "unreact": {
    "of": "tag:appointment:{{appointment.id}}",
    "emojis": [
      "{{vars.undo_emoji | default:}}"
    ]
  }
}
```

</details>

### 5. What this answer tags

- Step id `u2`, type `set_var`
- Engine description: Remember tags now, picked by [outcome]:[how the call went]
- Detail: noshow: → stat-no-show; showed: → stat-showed; showed:lost → stat-showed, stat-lost; showed:closed → stat-showed, stat-closed-won; showed:deposit → stat-showed, stat-deposit; showed:pending → stat-showed; showed:follow up → stat-showed, stat-follow-up; showed:unqualified → stat-showed, stat-disqualified; otherwise 
- If it keeps failing: the run is held on this step (later steps read what it remembers)

Next:
- always → step 7 (`u3`)

<details><summary>Full step definition</summary>

```json
{
  "id": "u2",
  "title": "What this answer tags",
  "type": "set_var",
  "key": "tags_now",
  "value": "{{event.outcome}}:{{appointment.call_outcome | default:}}",
  "pick": {
    "noshow:": [
      "stat-no-show"
    ],
    "showed:": [
      "stat-showed"
    ],
    "showed:lost": [
      "stat-showed",
      "stat-lost"
    ],
    "showed:closed": [
      "stat-showed",
      "stat-closed-won"
    ],
    "showed:deposit": [
      "stat-showed",
      "stat-deposit"
    ],
    "showed:pending": [
      "stat-showed"
    ],
    "showed:follow_up": [
      "stat-showed",
      "stat-follow-up"
    ],
    "showed:unqualified": [
      "stat-showed",
      "stat-disqualified"
    ]
  },
  "else_value": []
}
```

</details>

### 6. Add tag “stat-no-show”

- Step id `g2`, type `set_tag`
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Next:
- always → step 8 (`gn1`)

<details><summary>Full step definition</summary>

```json
{
  "id": "g2",
  "type": "set_tag",
  "tag": [
    "stat-no-show"
  ]
}
```

</details>

### 7. The reaction the earlier answer left that this one takes back

- Step id `u3`, type `set_var`
- Engine description: Remember undo emoji, picked by [the earlier answer]>[outcome]
- Detail: noshow>showed → ghost; showed>noshow → white_check_mark; noshow>rescheduled → ghost; showed>rescheduled → white_check_mark; otherwise 
- If it keeps failing: the run is held on this step (later steps read what it remembers)

Next:
- always → step 9 (`u4`)

<details><summary>Full step definition</summary>

```json
{
  "id": "u3",
  "title": "The reaction the earlier answer left that this one takes back",
  "type": "set_var",
  "key": "undo_emoji",
  "value": "{{event.previous_outcome | default:}}>{{event.outcome}}",
  "pick": {
    "noshow>showed": "ghost",
    "showed>noshow": "white_check_mark",
    "noshow>rescheduled": "ghost",
    "showed>rescheduled": "white_check_mark"
  },
  "else_value": ""
}
```

</details>

### 8. Setter card → No-Show / Cancel / Reschedule, marked lost (the setter pipeline is won on a show, lost on a no-show; the next booking makes a fresh setter card)

- Step id `gn1`, type `pipeline_card`
- Engine description: Move pipeline card
- Detail: In the setter board, stage Cancelled; marked lost; only if the card already exists
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Next:
- always → step 10 (`gn2`)

<details><summary>Full step definition</summary>

```json
{
  "id": "gn1",
  "title": "Setter card → No-Show / Cancel / Reschedule, marked lost (the setter pipeline is won on a show, lost on a no-show; the next booking makes a fresh setter card)",
  "type": "pipeline_card",
  "pipeline": "{{crm.pipeline_setter}}",
  "stage": "{{crm.stage_setter_cancelled}}",
  "status": "lost",
  "if_missing": "skip",
  "pick": "latest",
  "fields": []
}
```

</details>

### 9. A changed answer: take off what the earlier answer tagged and this one does not

- Step id `u4`, type `tags`
- Engine description: Tags “−[tags before]”
- Detail: Never takes off [tags now]
- Runs only if: there is an earlier answer and either the earlier answer is not the outcome or the earlier call outcome is not how the call went (otherwise skipped)
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Next:
- always → step 11 (`o_reopen`)

<details><summary>Full step definition</summary>

```json
{
  "id": "u4",
  "title": "A changed answer: take off what the earlier answer tagged and this one does not",
  "only_if": {
    "and": [
      {
        "exists": "event.previous_outcome"
      },
      {
        "neq": [
          "{{event.previous_outcome | default:}}:{{event.previous_call_outcome | default:}}",
          "{{event.outcome}}:{{appointment.call_outcome | default:}}"
        ]
      }
    ]
  },
  "type": "tags",
  "remove": [
    "{{vars.tags_before}}"
  ],
  "keep": [
    "{{vars.tags_now}}"
  ]
}
```

</details>

### 10. Closer card → No Show / Cancelled (move only: they can rebook)

- Step id `gn2`, type `pipeline_card`
- Engine description: Move pipeline card
- Detail: In the closer board, stage Cancelled; marked open; only if the card already exists
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Next:
- always → step 12 (`g3`)

<details><summary>Full step definition</summary>

```json
{
  "id": "gn2",
  "title": "Closer card → No Show / Cancelled (move only: they can rebook)",
  "type": "pipeline_card",
  "pipeline": "{{crm.pipeline_closer}}",
  "stage": "{{crm.stage_closer_cancelled}}",
  "status": "open",
  "if_missing": "skip",
  "pick": "latest",
  "fields": []
}
```

</details>

### 11. A changed answer takes the loss back: the opportunity is open again

- Step id `o_reopen`, type `update_opportunity`
- Engine description: Mark the opportunity open
- Detail: a change to won or lost is recorded as Deal won or Opportunity lost and starts the workflows that listen for it
- Runs only if: the earlier call outcome is “lost” and how the call went is not “lost” (otherwise skipped)
- If it keeps failing: the run is held on this step (it is the run's own ledger)

Next:
- always → step 13 (`b1`)

<details><summary>Full step definition</summary>

```json
{
  "id": "o_reopen",
  "title": "A changed answer takes the loss back: the opportunity is open again",
  "only_if": {
    "and": [
      {
        "eq": [
          "{{event.previous_call_outcome | default:}}",
          "lost"
        ]
      },
      {
        "neq": [
          "{{appointment.call_outcome | default:}}",
          "lost"
        ]
      }
    ]
  },
  "type": "update_opportunity",
  "set": {},
  "status": "open",
  "from": [
    "lost"
  ]
}
```

</details>

### 12. Record the no-show after an unanswered cancel or reschedule read

- Step id `g3`, type `record`
- Engine description: Record: A no-show after an unanswered cancel or reschedule read
- Detail: An event in the ledger with asked at, predicted, appointment id, predicted confidence; nothing leaves the engine
- Runs only if: their unanswered reply is “cancelled” or a reschedule request (otherwise skipped)
- If it keeps failing: the run is held on this step (it is the run's own ledger)

Next:
- always → step 14 (`g4`)

<details><summary>Full step definition</summary>

```json
{
  "id": "g3",
  "title": "Record the no-show after an unanswered cancel or reschedule read",
  "only_if": {
    "in": [
      "{{appointment.pending_read.intent}}",
      [
        "cancelled",
        "reschedule_request"
      ]
    ]
  },
  "type": "record",
  "event": "intent.unanswered_no_show",
  "data": {
    "asked_at": "{{appointment.pending_read.at}}",
    "predicted": "{{appointment.pending_read.intent}}",
    "appointment_id": "{{appointment.id}}",
    "predicted_confidence": "{{appointment.pending_read.confidence}}"
  }
}
```

</details>

### 13. Did they show?

- Step id `b1`, type `branch`
- Engine description: Which way?
- If it keeps failing: the run is held on this step (it decides where the run goes)

Next:
- no show (when outcome is no-show) → step 4 (`g1`)
- showed (when outcome is “showed”) → step 15 (`s1`)
- rescheduled or cancelled on the call (when outcome is “rescheduled”) → step 16 (`r3s`)
- anything else: nothing to mark → step 17 (`x0`)

<details><summary>Full step definition</summary>

```json
{
  "id": "b1",
  "title": "Did they show?",
  "type": "branch"
}
```

</details>

### 14. Tag stat-possible-cancel: we were pretty sure they cancelled and the slot was never opened

- Step id `g4`, type `tags`
- Engine description: Tags “+stat-possible-cancel”
- Runs only if: their unanswered reply is “cancelled” or a reschedule request (otherwise skipped)
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Next:
- always → step 18 (`r2`)

<details><summary>Full step definition</summary>

```json
{
  "id": "g4",
  "title": "Tag stat-possible-cancel: we were pretty sure they cancelled and the slot was never opened",
  "only_if": {
    "in": [
      "{{appointment.pending_read.intent}}",
      [
        "cancelled",
        "reschedule_request"
      ]
    ]
  },
  "type": "tags",
  "add": [
    "stat-possible-cancel"
  ]
}
```

</details>

### 15. React ✅ on the booking post

- Step id `s1`, type `slack_post`
- Engine description: Reply in the thread of that Slack post
- Detail: reacts :white_check_mark: on it; takes back the reaction an earlier answer left on the post
- Goes to: channel {{slack.channel.bookings}}; in the thread of tag:appointment:{{appointment.id}}; thread only; edits the earlier post; posted as "Showed"; remembered as outcome:{{appointment.id}}
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Slack post:

```
✅ Showed, per {{appointment.closer.name | default:the closer}}: {{appointment.call_outcome | words | default:no call outcome given}}.
```

Next:
- always → step 19 (`s2`)

<details><summary>Full step definition</summary>

```json
{
  "id": "s1",
  "title": "React ✅ on the booking post",
  "type": "slack_post",
  "channel": "{{slack.channel.bookings}}",
  "template": "✅ Showed, per {{appointment.closer.name | default:the closer}}: {{appointment.call_outcome | words | default:no call outcome given}}.",
  "as": {
    "name": "Showed",
    "icon": ":white_check_mark:"
  },
  "thread_of": "tag:appointment:{{appointment.id}}",
  "thread_only": true,
  "tag": "outcome:{{appointment.id}}",
  "edit": true,
  "react": "white_check_mark",
  "label": "mode",
  "unreact": {
    "of": "tag:appointment:{{appointment.id}}",
    "emojis": [
      "{{vars.undo_emoji | default:}}"
    ]
  }
}
```

</details>

### 16. A changed answer: the thread line says rescheduled and the earlier reaction comes off

- Step id `r3s`, type `slack_post`
- Engine description: Reply in the thread of that Slack post
- Detail: takes back the reaction an earlier answer left on the post
- Runs only if: the earlier answer is “showed” or no-show (otherwise skipped)
- Goes to: channel {{slack.channel.bookings}}; in the thread of tag:appointment:{{appointment.id}}; thread only; edits the earlier post; posted as "Rescheduled"; remembered as outcome:{{appointment.id}}
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Slack post:

```
🔁 Rescheduled or cancelled on the call, per {{appointment.closer.name | default:the closer}}.
```

Next:
- always → step 20 (`r3`)

<details><summary>Full step definition</summary>

```json
{
  "id": "r3s",
  "title": "A changed answer: the thread line says rescheduled and the earlier reaction comes off",
  "only_if": {
    "in": [
      "{{event.previous_outcome | default:}}",
      [
        "showed",
        "noshow"
      ]
    ]
  },
  "type": "slack_post",
  "channel": "{{slack.channel.bookings}}",
  "template": "🔁 Rescheduled or cancelled on the call, per {{appointment.closer.name | default:the closer}}.",
  "as": {
    "name": "Rescheduled",
    "icon": ":repeat:"
  },
  "thread_of": "tag:appointment:{{appointment.id}}",
  "thread_only": true,
  "tag": "outcome:{{appointment.id}}",
  "edit": true,
  "label": "mode",
  "unreact": {
    "of": "tag:appointment:{{appointment.id}}",
    "emojis": [
      "{{vars.undo_emoji | default:}}"
    ]
  }
}
```

</details>

### 17. Stop: nothing to mark

- Step id `x0`, type `exit`

Next: the run ends here.

<details><summary>Full step definition</summary>

```json
{
  "id": "x0",
  "type": "exit",
  "reason": "nothing_to_mark"
}
```

</details>

### 18. Sales Call record: no-show (what a held call carried is emptied)

- Step id `r2`, type `crm_record`
- Engine description: Update sales call record
- Detail: Keyed by this booking; 2 fields; empties disposition, cash collected, objection primary, next step, next step date, payment terms unless this answer sets them; only a record that exists, found by the booking when the engine did not write it
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Next:
- always → step 21 (`x1`)

<details><summary>Full step definition</summary>

```json
{
  "id": "r2",
  "title": "Sales Call record: no-show (what a held call carried is emptied)",
  "type": "crm_record",
  "object": "{{crm.object_sales_call | default:custom_objects.sales_call}}",
  "key": "{{appointment.slot_key}}",
  "properties": {
    "outcome": "{{picklist.sales_call_outcome.noshow}}",
    "external_id": "{{appointment.slot_key}}"
  },
  "if_missing": "match",
  "relate": [],
  "clear": [
    "disposition",
    "cash_collected",
    "objection_primary",
    "next_step",
    "next_step_date",
    "payment_terms"
  ]
}
```

</details>

### 19. Add tag “stat-showed”

- Step id `s2`, type `set_tag`
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Next:
- always → step 22 (`sc1`)

<details><summary>Full step definition</summary>

```json
{
  "id": "s2",
  "type": "set_tag",
  "tag": [
    "stat-showed"
  ]
}
```

</details>

### 20. Sales Call record: rescheduled or cancelled on the call (what a held call carried is emptied)

- Step id `r3`, type `crm_record`
- Engine description: Update sales call record
- Detail: Keyed by this booking; 2 fields; empties disposition, cash collected, objection primary, next step, next step date, payment terms unless this answer sets them; only a record that exists, found by the booking when the engine did not write it
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Next:
- always → step 21 (`x1`)

<details><summary>Full step definition</summary>

```json
{
  "id": "r3",
  "title": "Sales Call record: rescheduled or cancelled on the call (what a held call carried is emptied)",
  "type": "crm_record",
  "object": "{{crm.object_sales_call | default:custom_objects.sales_call}}",
  "key": "{{appointment.slot_key}}",
  "properties": {
    "outcome": "{{picklist.sales_call_outcome.on_call}}",
    "external_id": "{{appointment.slot_key}}"
  },
  "if_missing": "match",
  "relate": [],
  "clear": [
    "disposition",
    "cash_collected",
    "objection_primary",
    "next_step",
    "next_step_date",
    "payment_terms"
  ]
}
```

</details>

### 21. Stop: noted

- Step id `x1`, type `exit`

Next: the run ends here.

<details><summary>Full step definition</summary>

```json
{
  "id": "x1",
  "type": "exit",
  "reason": "noted"
}
```

</details>

### 22. Setter card → Showed, won (as the recording path does; a no-op when it is already there)

- Step id `sc1`, type `pipeline_card`
- Engine description: Move pipeline card
- Detail: In the setter board, stage Showed; marked won; only if the card already exists
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Next:
- always → step 23 (`v_disp`)

<details><summary>Full step definition</summary>

```json
{
  "id": "sc1",
  "title": "Setter card → Showed, won (as the recording path does; a no-op when it is already there)",
  "type": "pipeline_card",
  "pipeline": "{{crm.pipeline_setter}}",
  "stage": "{{crm.stage_setter_showed}}",
  "status": "won",
  "if_missing": "skip",
  "pick": "latest",
  "fields": []
}
```

</details>

### 23. The closer's answer as the CRM's disposition, in the company's own option (sales_call.dispositions): a deposit is its Deposit option, never closed won

- Step id `v_disp`, type `set_var`
- Engine description: Remember disposition = [how the call went]
- If it keeps failing: the run is held on this step (later steps read what it remembers)

Next:
- always → step 24 (`r1`)

<details><summary>Full step definition</summary>

```json
{
  "id": "v_disp",
  "title": "The closer's answer as the CRM's disposition, in the company's own option (sales_call.dispositions): a deposit is its Deposit option, never closed won",
  "type": "set_var",
  "key": "disposition",
  "value": "{{appointment.call_outcome | default: | option:sales_call_disposition}}"
}
```

</details>

### 24. Sales Call record: showed, with the disposition

- Step id `r1`, type `crm_record`
- Engine description: Update sales call record
- Detail: Keyed by this booking; 3 fields; empties disposition unless this answer sets them; only a record that exists, found by the booking when the engine did not write it
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Next:
- always → step 25 (`b2`)

<details><summary>Full step definition</summary>

```json
{
  "id": "r1",
  "title": "Sales Call record: showed, with the disposition",
  "type": "crm_record",
  "object": "{{crm.object_sales_call | default:custom_objects.sales_call}}",
  "key": "{{appointment.slot_key}}",
  "properties": {
    "outcome": "{{picklist.sales_call_outcome.showed}}",
    "disposition": "{{vars.disposition | default:}}",
    "external_id": "{{appointment.slot_key}}"
  },
  "if_missing": "match",
  "relate": [],
  "clear": [
    "disposition"
  ]
}
```

</details>

### 25. How did the call go?

- Step id `b2`, type `branch`
- Engine description: Which way?
- If it keeps failing: the run is held on this step (it decides where the run goes)

Next:
- closed (when how the call went is “closed”) → step 26 (`c1`)
- deposit (when how the call went is “deposit”) → step 27 (`c5`)
- follow up (when how the call went is follow up) → step 28 (`c2`)
- lost (when how the call went is “lost”) → step 29 (`c3`)
- disqualified (when how the call went is disqualified) → step 30 (`c4`)
- no call outcome given → step 21 (`x1`)

<details><summary>Full step definition</summary>

```json
{
  "id": "b2",
  "title": "How did the call go?",
  "type": "branch"
}
```

</details>

### 26. Add tag “stat-closed-won”

- Step id `c1`, type `set_tag`
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Next:
- always → step 31 (`kc`)

<details><summary>Full step definition</summary>

```json
{
  "id": "c1",
  "type": "set_tag",
  "tag": [
    "stat-closed-won"
  ]
}
```

</details>

### 27. Add tag “stat-deposit”

- Step id `c5`, type `set_tag`
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Next:
- always → step 32 (`kd`)

<details><summary>Full step definition</summary>

```json
{
  "id": "c5",
  "type": "set_tag",
  "tag": [
    "stat-deposit"
  ]
}
```

</details>

### 28. Add tag “stat-follow-up”

- Step id `c2`, type `set_tag`
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Next:
- always → step 33 (`k2`)

<details><summary>Full step definition</summary>

```json
{
  "id": "c2",
  "type": "set_tag",
  "tag": [
    "stat-follow-up"
  ]
}
```

</details>

### 29. Add tag “stat-lost”

- Step id `c3`, type `set_tag`
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Next:
- always → step 34 (`k3`)

<details><summary>Full step definition</summary>

```json
{
  "id": "c3",
  "type": "set_tag",
  "tag": [
    "stat-lost"
  ]
}
```

</details>

### 30. Add tag “stat-disqualified”

- Step id `c4`, type `set_tag`
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Next:
- always → step 35 (`k4`)

<details><summary>Full step definition</summary>

```json
{
  "id": "c4",
  "type": "set_tag",
  "tag": [
    "stat-disqualified"
  ]
}
```

</details>

### 31. A changed answer to closed: the closer card leaves No Show / Follow Up / Lost / Disqualified / Deposit for Scheduled (Payment recorded and Deal closed move it on)

- Step id `kc`, type `pipeline_card`
- Engine description: Move pipeline card
- Detail: In the closer board, stage Scheduled; marked open; only if the card already exists
- Runs only if: the earlier answer is no-show or the earlier call outcome is follow up, “lost”, disqualified or “deposit” (otherwise skipped)
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Next:
- always → step 21 (`x1`)

<details><summary>Full step definition</summary>

```json
{
  "id": "kc",
  "title": "A changed answer to closed: the closer card leaves No Show / Follow Up / Lost / Disqualified / Deposit for Scheduled (Payment recorded and Deal closed move it on)",
  "only_if": {
    "or": [
      {
        "eq": [
          "{{event.previous_outcome | default:}}",
          "noshow"
        ]
      },
      {
        "in": [
          "{{event.previous_call_outcome | default:}}",
          [
            "follow_up",
            "lost",
            "unqualified",
            "deposit"
          ]
        ]
      }
    ]
  },
  "type": "pipeline_card",
  "pipeline": "{{crm.pipeline_closer}}",
  "stage": "{{crm.stage_closer_scheduled}}",
  "status": "open",
  "if_missing": "skip",
  "pick": "latest",
  "fields": []
}
```

</details>

### 32. Closer card → Deposit (a deposit is not a close: the card waits there for the rest of the payment; skipped when the board has no Deposit stage bound)

- Step id `kd`, type `pipeline_card`
- Engine description: Move pipeline card
- Detail: In the closer board, stage Deposit; marked open; only if the card already exists
- Runs only if: there is a Deposit stage on the closer board (otherwise skipped)
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Next:
- always → step 21 (`x1`)

<details><summary>Full step definition</summary>

```json
{
  "id": "kd",
  "title": "Closer card → Deposit (a deposit is not a close: the card waits there for the rest of the payment; skipped when the board has no Deposit stage bound)",
  "only_if": {
    "exists": "crm.stage_closer_deposit"
  },
  "type": "pipeline_card",
  "pipeline": "{{crm.pipeline_closer}}",
  "stage": "{{crm.stage_closer_deposit | default:}}",
  "status": "open",
  "if_missing": "skip",
  "pick": "latest",
  "fields": []
}
```

</details>

### 33. Closer card → Follow Up

- Step id `k2`, type `pipeline_card`
- Engine description: Move pipeline card
- Detail: In the closer board, stage Follow Up; marked open; only if the card already exists
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Next:
- always → step 21 (`x1`)

<details><summary>Full step definition</summary>

```json
{
  "id": "k2",
  "title": "Closer card → Follow Up",
  "type": "pipeline_card",
  "pipeline": "{{crm.pipeline_closer}}",
  "stage": "{{crm.stage_closer_follow_up}}",
  "status": "open",
  "if_missing": "skip",
  "pick": "latest",
  "fields": []
}
```

</details>

### 34. Closer card → Lost, marked lost

- Step id `k3`, type `pipeline_card`
- Engine description: Move pipeline card
- Detail: In the closer board, stage Lost; marked lost; only if the card already exists
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Next:
- always → step 36 (`o_lost`)

<details><summary>Full step definition</summary>

```json
{
  "id": "k3",
  "title": "Closer card → Lost, marked lost",
  "type": "pipeline_card",
  "pipeline": "{{crm.pipeline_closer}}",
  "stage": "{{crm.stage_closer_lost}}",
  "status": "lost",
  "if_missing": "skip",
  "pick": "latest",
  "fields": []
}
```

</details>

### 35. Closer card → Disqualified, marked lost

- Step id `k4`, type `pipeline_card`
- Engine description: Move pipeline card
- Detail: In the closer board, stage Disqualified; marked lost; only if the card already exists
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Next:
- always → step 21 (`x1`)

<details><summary>Full step definition</summary>

```json
{
  "id": "k4",
  "title": "Closer card → Disqualified, marked lost",
  "type": "pipeline_card",
  "pipeline": "{{crm.pipeline_closer}}",
  "stage": "{{crm.stage_closer_disqualified}}",
  "status": "lost",
  "if_missing": "skip",
  "pick": "latest",
  "fields": []
}
```

</details>

### 36. Opportunity lost

- Step id `o_lost`, type `update_opportunity`
- Engine description: Mark the opportunity lost
- Detail: a change to won or lost is recorded as Deal won or Opportunity lost and starts the workflows that listen for it
- If it keeps failing: the run is held on this step (it is the run's own ledger)

Next:
- always → step 21 (`x1`)

<details><summary>Full step definition</summary>

```json
{
  "id": "o_lost",
  "title": "Opportunity lost",
  "type": "update_opportunity",
  "set": {},
  "status": "lost",
  "from": [
    "open"
  ]
}
```

</details>

## Settings this workflow reads

| Key | Kind | Required to enable | Value |
| --- | --- | --- | --- |
| `crm.location_id` | id | yes | `eLfhuKEaVMlrpLm2Fz8V` |
| `crm.object_sales_call` | id | no | `custom_objects.dating_sales_call` |
| `crm.pipeline_closer` | id | yes | `hLBo4MFsrGj7EjfDmkEn` |
| `crm.pipeline_setter` | id | yes | `N59nJLRaspsNwiaPWtE8` |
| `crm.stage_closer_cancelled` | id | yes | `b7b48139-37ee-4a33-a2bb-e598a36c6090` |
| `crm.stage_closer_deposit` | id | no | `ac1e5a5e-069d-4907-95a4-ac9d9499c73e` |
| `crm.stage_closer_disqualified` | id | yes | `0801a907-7652-4cb1-8e44-182a99214749` |
| `crm.stage_closer_follow_up` | id | yes | `c39d7ab9-e678-4d08-b701-61aad446e4a8` |
| `crm.stage_closer_lost` | id | yes | `c42dc364-bc41-44b9-a329-29207c22dd89` |
| `crm.stage_closer_scheduled` | id | yes | `27a674cf-4c34-48ff-8a3e-1368895b91ef` |
| `crm.stage_setter_cancelled` | id | yes | `72b4a0a0-11db-4b3c-92b7-e06c4d6112e1` |
| `crm.stage_setter_showed` | id | yes | `85af6330-f4b3-434e-a597-255f9d446e2d` |
| `slack.channel.bookings` | channel | no | `C0C9Q7MEANT` |

## Engine rules that apply but are not steps

These act on every run of this workflow from engine code. They are not in the definition above.

- **Mode.** The workflow's own mode, else the offer's, decides what is real: ghost writes and sends nothing, test is real only for test contacts, quiet writes the CRM but reaches no contact, live is real. (platform/src/engine/mode.ts:23, platform/src/engine/mode.ts:55)
- **Runs again?** A run's key is built from the re-entry policy; a second trigger with the same key starts nothing. A run that stops at a gate does not count. (platform/src/engine/reentry.ts:6)
- **Failures.** Errors are sorted into transient, auth, permanent and unknown. A step is retried after 1 and 5 minutes; then a non-blocking step is skipped and a blocking one is held and looked at again after 15 minutes, then hourly. An auth or permanent failure pauses the run until it is fixed. (platform/src/engine/failures.ts:19, platform/src/engine/failures.ts:21, platform/src/engine/blocking.ts:58)
- **Step cap.** At most 50 steps run in one go; a run past that fails. After an outage, at most 20 sends per offer per tick. (platform/src/engine/runner.ts:21, platform/src/engine/runner.ts:27)
- **CRM writes** without a natural key (notes, tasks, cards, records) are claimed once per run and step so a retry never writes twice. In ghost mode they are skipped. (platform/src/engine/effects.ts:13)
- **Slack before live.** Until the workflow is live, every post goes to the offer's test channel with a ghost/test label, unless `slack.live` is set. (platform/src/engine/mode.ts:32, platform/src/engine/mode.ts:34)
