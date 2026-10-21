# Pre-call sequence

Offer: **PMU** (`pmu`). Source: live database. Generated 2026-10-21.

| Setting | Value |
| --- | --- |
| Where this definition came from | live: version 3, saved 2026-10-19T03:23:24.459Z (Carly's Strategy Call (call type Follow-up call) is a follow-up or reschedule: no pre-call reminders for it (Tyler, 2026-10-19)) |
| Template | `pre-call-sequence` v15 |
| Edited since copied from the template | yes |
| Saved version | 3 |
| Enabled | on |
| Mode | follows the offer (ghost) |
| Send lock | locked: texts, emails, documents and webhooks reach only the operator's own addresses |
| Runs again for the same person | once_per_appointment; key {{appointment.starts_at}} |
| Re-checked before every step | appointment in future |
| Send window | 08:00 to 20:00, the contact's time zone |
| Steps | 48 |

## Steps

Every step, in the order a run meets it from the trigger. Steps that only assemble words (`set_var`) are listed too.

### 1. Appointment booked — call type is closing call and term name is not “Follow up call”

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
    "and": [
      {
        "eq": [
          "{{appointment.term.category}}",
          "closing"
        ]
      },
      {
        "neq": [
          "{{appointment.term.name}}",
          "Follow-up call"
        ]
      }
    ]
  }
}
```

</details>

### 2. Appointment rescheduled — call type is closing call and term name is not “Follow up call”

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
    "and": [
      {
        "eq": [
          "{{appointment.term.category}}",
          "closing"
        ]
      },
      {
        "neq": [
          "{{appointment.term.name}}",
          "Follow-up call"
        ]
      }
    ]
  }
}
```

</details>

### 3. Wait for GHL to have the person before the receipts

- Step id `c0`, type `check`
- Engine description: Check there is a CRM contact
- Detail: Waits up to 1 hour for it, looking every 2 minutes. Otherwise the run pauses for a person: contact has no CRM id yet: GHL did not have the person an hour after the booking
- If it keeps failing: the run is held on this step (it decides whether the run goes on)

Next:
- always → step 4 (`e1`)

<details><summary>Full step definition</summary>

```json
{
  "id": "c0",
  "title": "Wait for GHL to have the person before the receipts",
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

### 4. Send email: “You're booked: [call time] — reply to lock it in”

- Step id `e1`, type `send_email`
- Detail: Automated receipt: may go out in dark hours if the company allows it
- Goes to: the contact's email (transactional)
- Timing check: before event, at least 5m before; when stale: skip
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Email subject:

```
You're booked: {{appointment.starts_at | date:ccc, LLL d 'at' h:mma}} — reply to lock it in
```

Email body:

```
[placeholder — day-one email]
```

Next:
- always → step 5 (`s1`)

<details><summary>Full step definition</summary>

```json
{
  "id": "e1",
  "type": "send_email",
  "subject": "You're booked: {{appointment.starts_at | date:ccc, LLL d 'at' h:mma}} — reply to lock it in",
  "template": "[placeholder — day-one email]",
  "kind": "transactional",
  "validity": {
    "anchor": "before_event",
    "min_lead": "5m"
  },
  "on_stale": "skip"
}
```

</details>

### 5. Booking text

- Step id `s1`, type `send_sms`
- Engine description: Send text (automated receipt, may go out in dark hours)
- Detail: Only if at least 15 minutes before the call; otherwise skip it
- Goes to: the contact's phone (transactional)
- Timing check: before event, at least 15m before; when stale: skip
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Text message:

```
[placeholder — immediate text]
```

Next:
- always → step 6 (`w1`)

<details><summary>Full step definition</summary>

```json
{
  "id": "s1",
  "title": "Booking text",
  "type": "send_sms",
  "template": "[placeholder — immediate text]",
  "kind": "transactional",
  "validity": {
    "anchor": "before_event",
    "min_lead": "15m"
  },
  "on_stale": "skip"
}
```

</details>

### 6. Wait for a text reply

- Step id `w1`, type `wait_for_reply`
- Detail: Up to 4 hours; continues the minute one arrives
- Wait: Wait for a reply on sms for up to 4h, and no later than until 1 hour before the call; after the first reply, wait 90s for the rest
- If it keeps failing: the run is held on this step (the run waits on it)

Next:
- they replied → step 7 (`c1`)
- no reply in time → step 8 (`n_unc`)

<details><summary>Full step definition</summary>

```json
{
  "id": "w1",
  "type": "wait_for_reply",
  "timeout": "4h",
  "channel": "sms",
  "settle": "90s",
  "until": {
    "anchor": "appointment.starts_at",
    "offset": "-1h",
    "tz": "contact"
  }
}
```

</details>

### 7. Jev reads the reply

- Step id `c1`, type `classify`
- Detail: Decides between unclear, question, cancelled, confirmed, reschedule request; below 80% sure, or a reply a careful person would doubt, goes to a person
- If it keeps failing: the run is held on this step (step b1 reads the reply)

What it reads:

```
{{reply.inbound_since_send}}
```

What we sent (context):

```
{{reply.last_outbound.body | default:}}
```

Option "unclear" means:

```
The meaning is not plain: a negative or ambiguous emoji on its own, 'maybe', 'idk', 'hmm', or an unrelated message.
```

Option "question" means:

```
They ask something and do not confirm, cancel or ask to move the call.
```

Option "cancelled" means:

```
They clearly say, in words, that they will not attend or want to cancel.
```

Option "confirmed" means:

```
They clearly confirm or accept the call: yes, ok, see you then, a thumbs up, a positive or celebratory emoji.
```

Option "reschedule_request" means:

```
They ask for a different day or time.
```

Next:
- always → step 9 (`b1`)

<details><summary>Full step definition</summary>

```json
{
  "id": "c1",
  "type": "classify",
  "input": "{{reply.inbound_since_send}}",
  "state": "{{reply.last_outbound.body | default:}}",
  "domain": "reply_intent",
  "threshold": 0.8,
  "into": "reply.intent",
  "criteria": {
    "unclear": "The meaning is not plain: a negative or ambiguous emoji on its own, 'maybe', 'idk', 'hmm', or an unrelated message.",
    "question": "They ask something and do not confirm, cancel or ask to move the call.",
    "cancelled": "They clearly say, in words, that they will not attend or want to cancel.",
    "confirmed": "They clearly confirm or accept the call: yes, ok, see you then, a thumbs up, a positive or celebratory emoji.",
    "reschedule_request": "They ask for a different day or time."
  },
  "ambiguity_max": 0.8
}
```

</details>

### 8. Add tag “stat-unconfirmed”

- Step id `n_unc`, type `set_tag`
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Next:
- always → step 10 (`k_unc`)

<details><summary>Full step definition</summary>

```json
{
  "id": "n_unc",
  "type": "set_tag",
  "tag": "stat-unconfirmed"
}
```

</details>

### 9. Which way?

- Step id `b1`, type `branch`
- If it keeps failing: the run is held on this step (it decides where the run goes)

Next:
- the reply is “confirmed” → step 11 (`n_conf`)
- otherwise → step 12 (`v_read`)

<details><summary>Full step definition</summary>

```json
{
  "id": "b1",
  "type": "branch"
}
```

</details>

### 10. No reply in 4 hours: card → Unresponsive - Call Unconfirmed

- Step id `k_unc`, type `pipeline_card`
- Engine description: Move pipeline card
- Detail: In the closer board, stage Unresponsive; only if the card already exists
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Next:
- always → step 13 (`n_unc_slack`)

<details><summary>Full step definition</summary>

```json
{
  "id": "k_unc",
  "title": "No reply in 4 hours: card → Unresponsive - Call Unconfirmed",
  "type": "pipeline_card",
  "pipeline": "{{crm.pipeline_closer}}",
  "stage": "{{crm.stage_closer_unresponsive}}",
  "if_missing": "skip",
  "pick": "latest",
  "fields": []
}
```

</details>

### 11. Tags “+stat-confirmed” “−stat-unconfirmed”

- Step id `n_conf`, type `tags`
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Next:
- always → step 14 (`k_conf`)

<details><summary>Full step definition</summary>

```json
{
  "id": "n_conf",
  "type": "tags",
  "add": [
    "stat-confirmed"
  ],
  "remove": [
    "stat-unconfirmed"
  ]
}
```

</details>

### 12. Remember jev read, picked by [the reply]

- Step id `v_read`, type `set_var`
- Detail: question → Jev read it as a question, not an answer ([reply intent confidence]% sure).; cancelled → Jev is [reply intent confidence]% sure they want to cancel.; reschedule request → Jev is [reply intent confidence]% sure they want to reschedule.; otherwise Jev couldn't tell what they meant (its guesses: [top guesses]).
- If it keeps failing: the run is held on this step (later steps read what it remembers)

Next:
- always → step 15 (`n_ask`)

<details><summary>Full step definition</summary>

```json
{
  "id": "v_read",
  "type": "set_var",
  "key": "jev_read",
  "value": "{{reply.intent}}",
  "pick": {
    "question": "Jev read it as a question, not an answer ({{reply.intent_confidence}}% sure).",
    "cancelled": "Jev is {{reply.intent_confidence}}% sure they want to cancel.",
    "reschedule_request": "Jev is {{reply.intent_confidence}}% sure they want to reschedule."
  },
  "else_value": "Jev couldn't tell what they meant (its guesses: {{reply.top_guesses}})."
}
```

</details>

### 13. React ⏳ in the booking thread

- Step id `n_unc_slack`, type `slack_post`
- Engine description: Reply in the thread of that Slack post
- Detail: reacts :hourglass_flowing_sand: on it
- Goes to: channel {{slack.channel.bookings}}; in the thread of tag:appointment:{{appointment.id}}; posted as "Not confirmed yet"
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Slack post:

```
⏳ No reply to the booking text in 4 hours. Not confirmed yet; the reminders keep going.
```

Next:
- always → step 16 (`r72`)

<details><summary>Full step definition</summary>

```json
{
  "id": "n_unc_slack",
  "title": "React ⏳ in the booking thread",
  "type": "slack_post",
  "channel": "{{slack.channel.bookings}}",
  "template": "⏳ No reply to the booking text in 4 hours. Not confirmed yet; the reminders keep going.",
  "as": {
    "name": "Not confirmed yet",
    "icon": ":hourglass_flowing_sand:"
  },
  "thread_of": "tag:appointment:{{appointment.id}}",
  "thread_only": false,
  "edit": false,
  "react": "hourglass_flowing_sand",
  "label": "mode"
}
```

</details>

### 14. Card → Call Confirmed

- Step id `k_conf`, type `pipeline_card`
- Engine description: Move pipeline card
- Detail: In the closer board, stage Confirmed; only if the card already exists
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Next:
- always → step 17 (`n_conf_slack`)

<details><summary>Full step definition</summary>

```json
{
  "id": "k_conf",
  "title": "Card → Call Confirmed",
  "type": "pipeline_card",
  "pipeline": "{{crm.pipeline_closer}}",
  "stage": "{{crm.stage_closer_confirmed}}",
  "if_missing": "skip",
  "pick": "latest",
  "fields": []
}
```

</details>

### 15. Ask the closer in the attention channel: keep, cancel or reschedule?

- Step id `n_ask`, type `slack_post`
- Engine description: Post to Slack (the attention channel, else the bookings channel)
- Detail: offers :white_check_mark: :x: :repeat: for a person to tap
- Goes to: channel {{slack.channel.attention}}; falls back to {{slack.channel.bookings}}; posted as "Keep, cancel or reschedule?"; remembered as decision:{{appointment.id}}
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Slack post:

```
{{appointment.closer.mention | default:Heads up}} — {{contact.first_name}} replied to the booking text for the call {{appointment.starts_at | date_company}}. {{vars.jev_read}}
*We sent:*
> {{reply.last_outbound.body}}
*They wrote:*
> {{reply.inbound_since_send}}
Tap ✅ keep the call, ❌ cancel it, 🔁 reschedule (they get the rebooking link). The reminders keep going until you do.
```

Next:
- always → step 18 (`n_pending`)

<details><summary>Full step definition</summary>

```json
{
  "id": "n_ask",
  "title": "Ask the closer in the attention channel: keep, cancel or reschedule?",
  "type": "slack_post",
  "channel": "{{slack.channel.attention}}",
  "fallback_channel": "{{slack.channel.bookings}}",
  "template": "{{appointment.closer.mention | default:Heads up}} — {{contact.first_name}} replied to the booking text for the call {{appointment.starts_at | date_company}}. {{vars.jev_read}}\n*We sent:*\n> {{reply.last_outbound.body}}\n*They wrote:*\n> {{reply.inbound_since_send}}\nTap ✅ keep the call, ❌ cancel it, 🔁 reschedule (they get the rebooking link). The reminders keep going until you do.",
  "as": {
    "name": "Keep, cancel or reschedule?",
    "icon": ":grey_question:"
  },
  "thread_only": false,
  "tag": "decision:{{appointment.id}}",
  "edit": false,
  "offer": [
    "white_check_mark",
    "x",
    "repeat"
  ],
  "label": "mode"
}
```

</details>

### 16. Wait until 72 hours before the call (not before 8:00 AM, not after 9:00 PM)

- Step id `r72`, type `wait`
- Detail: Contact's time zone
- Wait: Wait until 72 hours before the call (not before 8:00 AM, not after 9:00 PM) (time zone: contact)
- If it keeps failing: the run is held on this step (the run waits on it)

Next:
- always → step 19 (`m72`)

<details><summary>Full step definition</summary>

```json
{
  "id": "r72",
  "type": "wait",
  "rule": {
    "anchor": "appointment.starts_at",
    "offset": "-72h",
    "tz": "contact",
    "earliest": "08:00",
    "latest": "21:00"
  }
}
```

</details>

### 17. React ✅, note who confirmed

- Step id `n_conf_slack`, type `slack_post`
- Engine description: Reply in the thread of that Slack post
- Detail: reacts :white_check_mark: on it; takes its own :white_check_mark: :x: :repeat: off the post once decided; reacts :white_check_mark: on the post remembered as decision:[an appointment]
- Goes to: channel {{slack.channel.bookings}}; in the thread of tag:appointment:{{appointment.id}}; posted as "Confirmed"
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Slack post:

```
✅ {{contact.first_name}}'s call {{appointment.starts_at | relative:auto}} is confirmed.
> {{reply.inbound_since_send}}{{reaction.user_name | line:Decided by}}
```

Next:
- always → step 20 (`rs`)

<details><summary>Full step definition</summary>

```json
{
  "id": "n_conf_slack",
  "title": "React ✅, note who confirmed",
  "type": "slack_post",
  "channel": "{{slack.channel.bookings}}",
  "template": "✅ {{contact.first_name}}'s call {{appointment.starts_at | relative:auto}} is confirmed.\n> {{reply.inbound_since_send}}{{reaction.user_name | line:Decided by}}",
  "as": {
    "name": "Confirmed",
    "icon": ":white_check_mark:"
  },
  "thread_of": "tag:appointment:{{appointment.id}}",
  "thread_only": false,
  "edit": false,
  "react": "white_check_mark",
  "label": "mode",
  "unreact": {
    "of": "tag:decision:{{appointment.id}}",
    "emojis": [
      "white_check_mark",
      "x",
      "repeat"
    ]
  },
  "react_on": {
    "of": "tag:decision:{{appointment.id}}",
    "emojis": [
      "white_check_mark"
    ]
  }
}
```

</details>

### 18. Note Jev's pending read on the appointment

- Step id `n_pending`, type `update_appointment`
- Detail: What Jev read, how sure it was and when, kept until a person decides; a no-show after it is a possible cancel
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Next:
- always → step 21 (`n_att_on`)

<details><summary>Full step definition</summary>

```json
{
  "id": "n_pending",
  "title": "Note Jev's pending read on the appointment",
  "type": "update_appointment",
  "set": {
    "pending_read": {
      "at": "{{now}}",
      "intent": "{{reply.intent}}",
      "confidence": "{{reply.intent_confidence}}"
    }
  }
}
```

</details>

### 19. Send text

- Step id `m72`, type `send_sms`
- Detail: Only if at least 60 hours before the call; otherwise skip it
- Goes to: the contact's phone (human)
- Timing check: before event, at least 60h before; when stale: skip
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Text message:

```
[placeholder — 3 days out]
```

Next:
- always → step 22 (`r48`)

<details><summary>Full step definition</summary>

```json
{
  "id": "m72",
  "type": "send_sms",
  "template": "[placeholder — 3 days out]",
  "kind": "human",
  "validity": {
    "anchor": "before_event",
    "min_lead": "60h"
  },
  "on_stale": "skip"
}
```

</details>

### 20. Back to the reminder the run was on

- Step id `rs`, type `resume`
- Engine description: Go back to where the run was
- Detail: The step the listener pulled the run away from, with its own due time; nothing to go back to, and the run simply goes on
- If it keeps failing: the run is held on this step (it decides where the run goes)

Next:
- always → step 16 (`r72`)

<details><summary>Full step definition</summary>

```json
{
  "id": "rs",
  "title": "Back to the reminder the run was on",
  "type": "resume"
}
```

</details>

### 21. Tags “+stat-needs-attention”

- Step id `n_att_on`, type `tags`
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Next:
- always → step 23 (`w_dec`)

<details><summary>Full step definition</summary>

```json
{
  "id": "n_att_on",
  "type": "tags",
  "add": [
    "stat-needs-attention"
  ]
}
```

</details>

### 22. Wait until 48 hours before the call (not before 8:00 AM, not after 9:00 PM)

- Step id `r48`, type `wait`
- Detail: Contact's time zone
- Wait: Wait until 48 hours before the call (not before 8:00 AM, not after 9:00 PM) (time zone: contact)
- If it keeps failing: the run is held on this step (the run waits on it)

Next:
- always → step 24 (`m48`)

<details><summary>Full step definition</summary>

```json
{
  "id": "r48",
  "type": "wait",
  "rule": {
    "anchor": "appointment.starts_at",
    "offset": "-48h",
    "tz": "contact",
    "earliest": "08:00",
    "latest": "21:00"
  }
}
```

</details>

### 23. Listen for the tap while the reminders go on

- Step id `w_dec`, type `wait_for_reaction`
- Engine description: Listen for a reaction on that Slack post: :white_check_mark: :x: :repeat:
- Detail: The run goes on at once; a tap on that very message, whenever it comes, pulls the run to the tap path and "go back" returns it to where it was; nobody by the call and it takes the no-answer path
- Wait: Wait for one of white_check_mark x repeat on tag:decision:{{appointment.id}}, until until the call (a listener: the run goes on and jumps when tapped)
- If it keeps failing: the run is held on this step (the run waits on it; set on the step)

Next:
- the reminders go on → step 16 (`r72`)
- a team member taps → step 25 (`v_decided`)
- nobody tapped in time → step 26 (`rec_un`)

<details><summary>Full step definition</summary>

```json
{
  "id": "w_dec",
  "title": "Listen for the tap while the reminders go on",
  "blocking": false,
  "type": "wait_for_reaction",
  "of": "tag:decision:{{appointment.id}}",
  "emojis": [
    "white_check_mark",
    "x",
    "repeat"
  ],
  "into": "reaction",
  "until": {
    "anchor": "appointment.starts_at",
    "offset": "-0m",
    "tz": "contact"
  }
}
```

</details>

### 24. Send text

- Step id `m48`, type `send_sms`
- Detail: Only if at least 36 hours before the call; otherwise skip it
- Goes to: the contact's phone (human)
- Timing check: before event, at least 36h before; when stale: skip
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Text message:

```
[placeholder — 2 days out]
```

Next:
- always → step 27 (`r24`)

<details><summary>Full step definition</summary>

```json
{
  "id": "m48",
  "type": "send_sms",
  "template": "[placeholder — 2 days out]",
  "kind": "human",
  "validity": {
    "anchor": "before_event",
    "min_lead": "36h"
  },
  "on_stale": "skip"
}
```

</details>

### 25. Remember decided, picked by [the tap]

- Step id `v_decided`, type `set_var`
- Detail: x → cancelled; repeat → reschedule_request; white check mark → confirmed; otherwise 
- If it keeps failing: the run is held on this step (later steps read what it remembers)

Next:
- always → step 28 (`v_agreed`)

<details><summary>Full step definition</summary>

```json
{
  "id": "v_decided",
  "type": "set_var",
  "key": "decided",
  "value": "{{reaction.reaction | default:}}",
  "pick": {
    "x": "cancelled",
    "repeat": "reschedule_request",
    "white_check_mark": "confirmed"
  },
  "else_value": ""
}
```

</details>

### 26. Record that nobody answered before the call

- Step id `rec_un`, type `record`
- Engine description: Record: Nobody answered the team's question in time
- Detail: An event in the ledger with predicted, appointment id, hours before call, predicted confidence; nothing leaves the engine
- If it keeps failing: the run is held on this step (it is the run's own ledger)

Next:
- always → step 29 (`n_att_off`)

<details><summary>Full step definition</summary>

```json
{
  "id": "rec_un",
  "title": "Record that nobody answered before the call",
  "type": "record",
  "event": "intent.unanswered",
  "data": {
    "predicted": "{{reply.intent}}",
    "appointment_id": "{{appointment.id}}",
    "hours_before_call": "{{appointment.starts_at | hours_until}}",
    "predicted_confidence": "{{reply.intent_confidence}}"
  }
}
```

</details>

### 27. Wait until 24 hours before the call (not before 8:00 AM, not after 9:00 PM)

- Step id `r24`, type `wait`
- Detail: Contact's time zone
- Wait: Wait until 24 hours before the call (not before 8:00 AM, not after 9:00 PM) (time zone: contact)
- If it keeps failing: the run is held on this step (the run waits on it)

Next:
- always → step 30 (`m24e`)

<details><summary>Full step definition</summary>

```json
{
  "id": "r24",
  "type": "wait",
  "rule": {
    "anchor": "appointment.starts_at",
    "offset": "-24h",
    "tz": "contact",
    "earliest": "08:00",
    "latest": "21:00"
  }
}
```

</details>

### 28. Remember agreed = true

- Step id `v_agreed`, type `set_var`
- Detail: When the reply is what the team decided; otherwise false
- If it keeps failing: the run is held on this step (later steps read what it remembers)

Next:
- always → step 31 (`rec`)

<details><summary>Full step definition</summary>

```json
{
  "id": "v_agreed",
  "type": "set_var",
  "key": "agreed",
  "value": true,
  "when": {
    "eq": [
      "{{reply.intent}}",
      "{{vars.decided}}"
    ]
  },
  "else_value": false
}
```

</details>

### 29. Tags “−stat-needs-attention”

- Step id `n_att_off`, type `tags`
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Next:
- always → step 32 (`b_dec`)

<details><summary>Full step definition</summary>

```json
{
  "id": "n_att_off",
  "type": "tags",
  "remove": [
    "stat-needs-attention"
  ]
}
```

</details>

### 30. Send email: “Tomorrow: your call with [closer's first name]”

- Step id `m24e`, type `send_email`
- Goes to: the contact's email (human)
- Timing check: before event, at least 18h before; when stale: skip
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Email subject:

```
Tomorrow: your call with {{appointment.closer.first_name}}
```

Email body:

```
[placeholder — 24-hour email]
```

Next:
- always → step 33 (`m24s`)

<details><summary>Full step definition</summary>

```json
{
  "id": "m24e",
  "type": "send_email",
  "subject": "Tomorrow: your call with {{appointment.closer.first_name}}",
  "template": "[placeholder — 24-hour email]",
  "kind": "human",
  "validity": {
    "anchor": "before_event",
    "min_lead": "18h"
  },
  "on_stale": "skip"
}
```

</details>

### 31. Score Jev: did the person agree with the read?

- Step id `rec`, type `record`
- Engine description: Record: A team member said whether Jev read it right
- Detail: An event in the ledger with agreed, decided, predicted, decided by, appointment id, predicted confidence; nothing leaves the engine
- If it keeps failing: the run is held on this step (it is the run's own ledger)

Next:
- always → step 34 (`n_clear`)

<details><summary>Full step definition</summary>

```json
{
  "id": "rec",
  "title": "Score Jev: did the person agree with the read?",
  "type": "record",
  "event": "intent.reviewed",
  "data": {
    "agreed": "{{vars.agreed}}",
    "decided": "{{vars.decided}}",
    "predicted": "{{reply.intent}}",
    "decided_by": "{{reaction.user_name}}",
    "appointment_id": "{{appointment.id}}",
    "predicted_confidence": "{{reply.intent_confidence}}"
  }
}
```

</details>

### 32. Which way?

- Step id `b_dec`, type `branch`
- If it keeps failing: the run is held on this step (it decides where the run goes)

Next:
- ✅ keep the call (when the tap is “white check mark”) → step 11 (`n_conf`)
- ❌ cancel it (when the tap is “x”) → step 35 (`n_cx`)
- 🔁 reschedule (when the tap is “repeat”) → step 36 (`n_rs`)
- nobody decided: back to where the reminders were → step 20 (`rs`)

<details><summary>Full step definition</summary>

```json
{
  "id": "b_dec",
  "type": "branch"
}
```

</details>

### 33. Send text

- Step id `m24s`, type `send_sms`
- Detail: Only if at least 18 hours before the call; otherwise skip it
- Goes to: the contact's phone (human)
- Timing check: before event, at least 18h before; when stale: skip
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Text message:

```
[placeholder — 24-hour text]
```

Next:
- always → step 37 (`rm`)

<details><summary>Full step definition</summary>

```json
{
  "id": "m24s",
  "type": "send_sms",
  "template": "[placeholder — 24-hour text]",
  "kind": "human",
  "validity": {
    "anchor": "before_event",
    "min_lead": "18h"
  },
  "on_stale": "skip"
}
```

</details>

### 34. Clear the pending read: a person decided

- Step id `n_clear`, type `update_appointment`
- Engine description: Clear the pending read on the appointment
- Detail: A person decided; the appointment no longer carries an open question
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Next:
- always → step 29 (`n_att_off`)

<details><summary>Full step definition</summary>

```json
{
  "id": "n_clear",
  "title": "Clear the pending read: a person decided",
  "type": "update_appointment",
  "set": {
    "pending_read": null
  }
}
```

</details>

### 35. Mark appointment status → “cancelled”

- Step id `n_cx`, type `update_appointment`
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Next:
- always → step 38 (`n_cx_slack`)

<details><summary>Full step definition</summary>

```json
{
  "id": "n_cx",
  "type": "update_appointment",
  "set": {
    "status": "cancelled"
  }
}
```

</details>

### 36. Text the rebooking link

- Step id `n_rs`, type `send_sms`
- Engine description: Send text
- Goes to: the contact's phone (human)
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Text message:

```
No problem — grab a new time here: {{calendar.closer_call.url}}
```

Next:
- always → step 39 (`n_rs_slack`)

<details><summary>Full step definition</summary>

```json
{
  "id": "n_rs",
  "title": "Text the rebooking link",
  "type": "send_sms",
  "template": "No problem — grab a new time here: {{calendar.closer_call.url}}",
  "kind": "human",
  "on_stale": "skip"
}
```

</details>

### 37. Wait for 8am their time (calls at 9am or later; an earlier call goes straight to its 1-hour text)

- Step id `rm`, type `wait`
- Engine description: Wait until 8:00 AM the day of the call
- Detail: Contact's time zone
- Runs only if: the call is at 9 AM or later (otherwise skipped)
- Wait: Wait until 8:00 AM the day of the call (time zone: contact)
- If it keeps failing: the run is held on this step (the run waits on it)

Next:
- always → step 40 (`bm`)

<details><summary>Full step definition</summary>

```json
{
  "id": "rm",
  "title": "Wait for 8am their time (calls at 9am or later; an earlier call goes straight to its 1-hour text)",
  "only_if": {
    "gte": [
      "{{appointment.starts_at | date:HH}}",
      "09"
    ]
  },
  "type": "wait",
  "rule": {
    "anchor": "appointment.starts_at",
    "offset": "day_of@08:00",
    "tz": "contact"
  }
}
```

</details>

### 38. React ❌, note who cancelled

- Step id `n_cx_slack`, type `slack_post`
- Engine description: Reply in the thread of that Slack post
- Detail: reacts :x: on it; takes its own :white_check_mark: :x: :repeat: off the post once decided; reacts :x: on the post remembered as decision:[an appointment]
- Goes to: channel {{slack.channel.bookings}}; in the thread of tag:appointment:{{appointment.id}}; posted as "Call cancelled"
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Slack post:

```
❌ {{contact.first_name}}'s call is cancelled.
> {{reply.inbound_since_send}}{{reaction.user_name | line:Decided by}}
```

Next:
- always → step 41 (`x_cancelled`)

<details><summary>Full step definition</summary>

```json
{
  "id": "n_cx_slack",
  "title": "React ❌, note who cancelled",
  "type": "slack_post",
  "channel": "{{slack.channel.bookings}}",
  "template": "❌ {{contact.first_name}}'s call is cancelled.\n> {{reply.inbound_since_send}}{{reaction.user_name | line:Decided by}}",
  "as": {
    "name": "Call cancelled",
    "icon": ":x:"
  },
  "thread_of": "tag:appointment:{{appointment.id}}",
  "thread_only": false,
  "edit": false,
  "react": "x",
  "label": "mode",
  "unreact": {
    "of": "tag:decision:{{appointment.id}}",
    "emojis": [
      "white_check_mark",
      "x",
      "repeat"
    ]
  },
  "react_on": {
    "of": "tag:decision:{{appointment.id}}",
    "emojis": [
      "x"
    ]
  }
}
```

</details>

### 39. React 🔁, note who decided

- Step id `n_rs_slack`, type `slack_post`
- Engine description: Reply in the thread of that Slack post
- Detail: reacts :repeat: on it; takes its own :white_check_mark: :x: :repeat: off the post once decided; reacts :repeat: on the post remembered as decision:[an appointment]
- Goes to: channel {{slack.channel.bookings}}; in the thread of tag:appointment:{{appointment.id}}; posted as "Reschedule"
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Slack post:

```
🔁 {{contact.first_name}} got the rebooking link.
> {{reply.inbound_since_send}}{{reaction.user_name | line:Decided by}}
```

Next:
- always → step 42 (`x_reschedule`)

<details><summary>Full step definition</summary>

```json
{
  "id": "n_rs_slack",
  "title": "React 🔁, note who decided",
  "type": "slack_post",
  "channel": "{{slack.channel.bookings}}",
  "template": "🔁 {{contact.first_name}} got the rebooking link.\n> {{reply.inbound_since_send}}{{reaction.user_name | line:Decided by}}",
  "as": {
    "name": "Reschedule",
    "icon": ":repeat:"
  },
  "thread_of": "tag:appointment:{{appointment.id}}",
  "thread_only": false,
  "edit": false,
  "react": "repeat",
  "label": "mode",
  "unreact": {
    "of": "tag:decision:{{appointment.id}}",
    "emojis": [
      "white_check_mark",
      "x",
      "repeat"
    ]
  },
  "react_on": {
    "of": "tag:decision:{{appointment.id}}",
    "emojis": [
      "repeat"
    ]
  }
}
```

</details>

### 40. Which way?

- Step id `bm`, type `branch`
- If it keeps failing: the run is held on this step (it decides where the run goes)

Next:
- the call is at 11am or later (when the call is at 11 AM or later) → step 43 (`mm`)
- otherwise → step 44 (`r1`)

<details><summary>Full step definition</summary>

```json
{
  "id": "bm",
  "type": "branch"
}
```

</details>

### 41. Done: cancelled

- Step id `x_cancelled`, type `exit`

Next: the run ends here.

<details><summary>Full step definition</summary>

```json
{
  "id": "x_cancelled",
  "type": "exit",
  "reason": "cancelled"
}
```

</details>

### 42. Done: reschedule link sent

- Step id `x_reschedule`, type `exit`

Next: the run ends here.

<details><summary>Full step definition</summary>

```json
{
  "id": "x_reschedule",
  "type": "exit",
  "reason": "reschedule_sent"
}
```

</details>

### 43. Send text

- Step id `mm`, type `send_sms`
- Detail: Only if at least 2 hours before the call; otherwise skip it
- Goes to: the contact's phone (human)
- Timing check: before event, at least 2h before; when stale: skip
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Text message:

```
[placeholder — morning-of text]
```

Next:
- always → step 44 (`r1`)

<details><summary>Full step definition</summary>

```json
{
  "id": "mm",
  "type": "send_sms",
  "template": "[placeholder — morning-of text]",
  "kind": "human",
  "validity": {
    "anchor": "before_event",
    "min_lead": "2h"
  },
  "on_stale": "skip"
}
```

</details>

### 44. Wait until 1 hour before the call (not before 7:00 AM)

- Step id `r1`, type `wait`
- Detail: Contact's time zone
- Wait: Wait until 1 hour before the call (not before 7:00 AM) (time zone: contact)
- If it keeps failing: the run is held on this step (the run waits on it)

Next:
- always → step 45 (`m1`)

<details><summary>Full step definition</summary>

```json
{
  "id": "r1",
  "type": "wait",
  "rule": {
    "anchor": "appointment.starts_at",
    "offset": "-1h",
    "tz": "contact",
    "earliest": "07:00"
  }
}
```

</details>

### 45. Send text

- Step id `m1`, type `send_sms`
- Detail: Only if at least 15 minutes before the call; otherwise skip it
- Goes to: the contact's phone (human)
- Timing check: before event, at least 15m before; when stale: skip
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Text message:

```
[placeholder — 1-hour text]
```

Next:
- always → step 46 (`r10`)

<details><summary>Full step definition</summary>

```json
{
  "id": "m1",
  "type": "send_sms",
  "template": "[placeholder — 1-hour text]",
  "kind": "human",
  "validity": {
    "anchor": "before_event",
    "min_lead": "15m"
  },
  "on_stale": "skip"
}
```

</details>

### 46. Wait until 10 minutes before the call

- Step id `r10`, type `wait`
- Detail: Contact's time zone
- Wait: Wait until 10 minutes before the call (time zone: contact)
- If it keeps failing: the run is held on this step (the run waits on it)

Next:
- always → step 47 (`m10`)

<details><summary>Full step definition</summary>

```json
{
  "id": "r10",
  "type": "wait",
  "rule": {
    "anchor": "appointment.starts_at",
    "offset": "-10m",
    "tz": "contact"
  }
}
```

</details>

### 47. Send text

- Step id `m10`, type `send_sms`
- Goes to: the contact's phone (human)
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Text message:

```
[placeholder — 10-minute text]
```

Next:
- always → step 48 (`x_done`)

<details><summary>Full step definition</summary>

```json
{
  "id": "m10",
  "type": "send_sms",
  "template": "[placeholder — 10-minute text]",
  "kind": "human",
  "on_stale": "skip"
}
```

</details>

### 48. Done

- Step id `x_done`, type `exit`

Next: the run ends here.

<details><summary>Full step definition</summary>

```json
{
  "id": "x_done",
  "type": "exit",
  "reason": "done"
}
```

</details>

## Settings this workflow reads

| Key | Kind | Required to enable | Value |
| --- | --- | --- | --- |
| `calendar.closer_call` | id | yes | `6f818f39-a3ae-47c8-a7d1-1d9f453686d5` |
| `crm.location_id` | id | yes | `gA10c58jLJRYbNwC3apW` |
| `crm.pipeline_closer` | id | yes | `1B37Vzv6euKMpWaFFuVW` |
| `crm.stage_closer_confirmed` | id | yes | `d2fdd051-1e22-4e8c-8d52-dc94ed41b91b` |
| `crm.stage_closer_unresponsive` | id | yes | `17b819aa-4423-4771-b53e-731289529026` |
| `slack.channel.attention` | channel | no | `C0BSCMFBY3C` |
| `slack.channel.bookings` | channel | no | `C0BSCMB813L` |

## Engine rules that apply but are not steps

These act on every run of this workflow from engine code. They are not in the definition above.

- **Mode.** The workflow's own mode, else the offer's, decides what is real: ghost writes and sends nothing, test is real only for test contacts, quiet writes the CRM but reaches no contact, live is real. (platform/src/engine/mode.ts:23, platform/src/engine/mode.ts:55)
- **Runs again?** A run's key is built from the re-entry policy; a second trigger with the same key starts nothing. A run that stops at a gate does not count. (platform/src/engine/reentry.ts:6)
- **Premise re-check.** Before each step the engine reads the CRM live; when "appointment in future" no longer holds, the run exits. (platform/src/engine/runner.ts:33)
- **Failures.** Errors are sorted into transient, auth, permanent and unknown. A step is retried after 1 and 5 minutes; then a non-blocking step is skipped and a blocking one is held and looked at again after 15 minutes, then hourly. An auth or permanent failure pauses the run until it is fixed. (platform/src/engine/failures.ts:19, platform/src/engine/failures.ts:21, platform/src/engine/blocking.ts:58)
- **Step cap.** At most 50 steps run in one go; a run past that fails. After an outage, at most 20 sends per offer per tick. (platform/src/engine/runner.ts:21, platform/src/engine/runner.ts:27)
- **Before any text or email goes out**, in this order: SMS switched on for the offer; timing still valid; the CRM's own template if named; the words rendered; the contact has the address; the mode holds it; already sent for this run and step (idempotency key run:step); already sent before a replay; Do Not Disturb; the send lock; then the CRM. A send the CRM did not clearly answer is never sent again. (platform/src/engine/executor.ts:170)
- **Send lock.** While locked, a text, email, document or webhook reaches a contact only when their live CRM phone or email is one of the operator's own. Changing any outbound step relocks the workflow. (platform/src/engine/send-lock.ts:27, platform/src/engine/send-lock.ts:97)
- **Send window.** A text or email due outside the offer's send window waits until it opens, in the contact's time zone; a transactional one may go at any hour when the offer allows it. (platform/src/engine/runner.ts:274)
- **CRM writes** without a natural key (notes, tasks, cards, records) are claimed once per run and step so a retry never writes twice. In ghost mode they are skipped. (platform/src/engine/effects.ts:13)
- **Slack before live.** Until the workflow is live, every post goes to the offer's test channel with a ghost/test label, unless `slack.live` is set. (platform/src/engine/mode.ts:32, platform/src/engine/mode.ts:34)
- **Waits** are stored on the run (`runs.next_run_at`, `wake_on_*`), not held in memory; a reply, tap or event wakes the run at once. (platform/src/engine/runner.ts:56)
