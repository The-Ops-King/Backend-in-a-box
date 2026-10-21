# Closing pre-call

Offer: **Dating (Nelly)** (`dating-nelly`). Source: **from repo, may differ from live**. Generated 2026-10-21.

| Setting | Value |
| --- | --- |
| Where this definition came from | the offer's own workflow: platform/installs/dating-nelly/closing-pre-call.json |
| Template | none (the offer's own workflow) |
| Edited since copied from the template | unknown (repo) |
| Takes over | `pre-call-sequence` |
| Saved version | unknown (repo) |
| Enabled | unknown (repo) |
| Mode | follows the offer (quiet) |
| Send lock | unknown (repo) |
| Runs again for the same person | once_per_appointment; key {{appointment.starts_at}} |
| Re-checked before every step | appointment in future |
| Send window | the offer's (unknown in repo) |
| Steps | 38 |
| Note | the Closing call's pre-call texts, all from Nelly (D155): the booking text with its reply handling, a day before and an hour before; no emails; no rebooking text (a reschedule is moved by hand, 🔁 notes who) |

## Steps

Every step, in the order a run meets it from the trigger. Steps that only assemble words (`set_var`) are listed too.

### 1. A Closing call booked

- Step id `t1`, type `trigger`
- Engine description: Appointment booked — term name is “Closing call”

Next:
- always → step 3 (`c0`)

<details><summary>Full step definition</summary>

```json
{
  "id": "t1",
  "title": "A Closing call booked",
  "type": "trigger",
  "event": "appointment.booked",
  "match": {
    "eq": [
      "{{appointment.term.name}}",
      "Closing call"
    ]
  }
}
```

</details>

### 2. A Closing call moved

- Step id `t2`, type `trigger`
- Engine description: Appointment rescheduled — term name is “Closing call”

Next:
- always → step 3 (`c0`)

<details><summary>Full step definition</summary>

```json
{
  "id": "t2",
  "title": "A Closing call moved",
  "type": "trigger",
  "event": "appointment.rescheduled",
  "match": {
    "eq": [
      "{{appointment.term.name}}",
      "Closing call"
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
- always → step 4 (`n_nolink`)

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

### 4. No meeting link: tell the closer in the booking channel

- Step id `n_nolink`, type `slack_post`
- Engine description: Post to Slack (the no link channel)
- Runs only if: not (there is a meeting link) (otherwise skipped)
- Goes to: channel {{slack.channel.no_link}}; posted as "No meeting link"
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Slack post:

```
{{appointment.closer.mention | default:Heads up}}: {{contact.name | default:A contact}}'s consultation {{appointment.starts_at | date_company}} has no meeting link in Calendly. Please send them the link.
```

Next:
- always → step 5 (`n_nolink_alert`)

<details><summary>Full step definition</summary>

```json
{
  "id": "n_nolink",
  "title": "No meeting link: tell the closer in the booking channel",
  "only_if": {
    "not": {
      "exists": "appointment.meeting_url"
    }
  },
  "type": "slack_post",
  "channel": "{{slack.channel.no_link}}",
  "template": "{{appointment.closer.mention | default:Heads up}}: {{contact.name | default:A contact}}'s consultation {{appointment.starts_at | date_company}} has no meeting link in Calendly. Please send them the link.",
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

### 5. No meeting link: and in the alerts channel

- Step id `n_nolink_alert`, type `slack_post`
- Engine description: Post to Slack (the no link alerts channel)
- Runs only if: not (there is a meeting link) (otherwise skipped)
- Goes to: channel {{slack.channel.no_link_alerts}}; posted as "No meeting link"
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Slack post:

```
{{appointment.closer.mention | default:Heads up}}: {{contact.name | default:A contact}}'s consultation {{appointment.starts_at | date_company}} has no meeting link in Calendly. Please send them the link.
```

Next:
- always → step 6 (`s1`)

<details><summary>Full step definition</summary>

```json
{
  "id": "n_nolink_alert",
  "title": "No meeting link: and in the alerts channel",
  "only_if": {
    "not": {
      "exists": "appointment.meeting_url"
    }
  },
  "type": "slack_post",
  "channel": "{{slack.channel.no_link_alerts}}",
  "template": "{{appointment.closer.mention | default:Heads up}}: {{contact.name | default:A contact}}'s consultation {{appointment.starts_at | date_company}} has no meeting link in Calendly. Please send them the link.",
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

### 6. Booking text

- Step id `s1`, type `send_sms`
- Engine description: Send text (automated receipt, may go out in dark hours)
- Detail: Only if at least 15 minutes before the call; otherwise skip it
- Goes to: the contact's phone (transactional)
- Timing check: before event, at least 15m before; when stale: skip
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Text message:

```
Hi {{contact.first_name}}, it's Nelly. You're booked for your private consultation with me on {{appointment.starts_at | date:"cccc, LLL d 'at' h:mm a ZZZZ"}}. It runs about an hour, so block off the time. Reply YES to confirm, or let me know if you need to move it.
```

Next:
- always → step 7 (`w1`)

<details><summary>Full step definition</summary>

```json
{
  "id": "s1",
  "title": "Booking text",
  "type": "send_sms",
  "template": "Hi {{contact.first_name}}, it's Nelly. You're booked for your private consultation with me on {{appointment.starts_at | date:\"cccc, LLL d 'at' h:mm a ZZZZ\"}}. It runs about an hour, so block off the time. Reply YES to confirm, or let me know if you need to move it.",
  "kind": "transactional",
  "validity": {
    "anchor": "before_event",
    "min_lead": "15m"
  },
  "on_stale": "skip"
}
```

</details>

### 7. Wait for a text reply

- Step id `w1`, type `wait_for_reply`
- Detail: Up to 4 hours; continues the minute one arrives
- Wait: Wait for a reply on sms for up to 4h, and no later than until 1 hour before the call; after the first reply, wait 90s for the rest
- If it keeps failing: the run is held on this step (the run waits on it)

Next:
- they replied → step 8 (`c1`)
- no reply in time → step 9 (`n_unc`)

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

### 8. Jev reads the reply

- Step id `c1`, type `classify`
- Detail: Decides between confirmed, cancelled, reschedule request, question, unclear; below 80% sure, or a reply a careful person would doubt, goes to a person
- If it keeps failing: the run is held on this step (step b1 reads the reply)

What it reads:

```
{{reply.inbound_since_send}}
```

What we sent (context):

```
{{reply.last_outbound.body | default:}}
```

Option "confirmed" means:

```
They clearly confirm or accept the call: yes, ok, see you then, a thumbs up, a positive or celebratory emoji.
```

Option "cancelled" means:

```
They clearly say, in words, that they will not attend or want to cancel.
```

Option "reschedule_request" means:

```
They ask for a different day or time.
```

Option "question" means:

```
They ask something and do not confirm, cancel or ask to move the call.
```

Option "unclear" means:

```
The meaning is not plain: a negative or ambiguous emoji on its own, 'maybe', 'idk', 'hmm', or an unrelated message.
```

Next:
- always → step 10 (`b1`)

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
    "confirmed": "They clearly confirm or accept the call: yes, ok, see you then, a thumbs up, a positive or celebratory emoji.",
    "cancelled": "They clearly say, in words, that they will not attend or want to cancel.",
    "reschedule_request": "They ask for a different day or time.",
    "question": "They ask something and do not confirm, cancel or ask to move the call.",
    "unclear": "The meaning is not plain: a negative or ambiguous emoji on its own, 'maybe', 'idk', 'hmm', or an unrelated message."
  },
  "ambiguity_max": 0.8
}
```

</details>

### 9. Add tag “stat-unconfirmed”

- Step id `n_unc`, type `set_tag`
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Next:
- always → step 11 (`n_unc_slack`)

<details><summary>Full step definition</summary>

```json
{
  "id": "n_unc",
  "type": "set_tag",
  "tag": "stat-unconfirmed"
}
```

</details>

### 10. Which way?

- Step id `b1`, type `branch`
- If it keeps failing: the run is held on this step (it decides where the run goes)

Next:
- the reply is “confirmed” → step 12 (`n_conf`)
- otherwise → step 13 (`v_read`)

<details><summary>Full step definition</summary>

```json
{
  "id": "b1",
  "type": "branch"
}
```

</details>

### 11. React ⏳ in the booking thread

- Step id `n_unc_slack`, type `slack_post`
- Engine description: Reply in the thread of that Slack post
- Detail: reacts :hourglass_flowing_sand: on it
- Runs only if: call time is more than 1.5 (otherwise skipped)
- Goes to: channel {{slack.channel.bookings}}; in the thread of tag:appointment:{{appointment.id}}; posted as "Not confirmed yet"
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Slack post:

```
⏳ No reply to the booking text in 4 hours. Not confirmed yet; the reminders keep going.
```

Next:
- always → step 14 (`v_lead`)

<details><summary>Full step definition</summary>

```json
{
  "id": "n_unc_slack",
  "title": "React ⏳ in the booking thread",
  "only_if": {
    "gt": [
      "{{appointment.starts_at | hours_until}}",
      1.5
    ]
  },
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

### 12. Tags “+stat-confirmed” “−stat-unconfirmed”

- Step id `n_conf`, type `tags`
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Next:
- always → step 15 (`n_conf_slack`)

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

### 13. Remember jev read, picked by [the reply]

- Step id `v_read`, type `set_var`
- Detail: cancelled → Jev is [reply intent confidence]% sure they want to cancel.; reschedule request → Jev is [reply intent confidence]% sure they want to reschedule.; question → Jev read it as a question, not an answer ([reply intent confidence]% sure).; otherwise Jev couldn't tell what they meant (its guesses: [top guesses]).
- If it keeps failing: the run is held on this step (later steps read what it remembers)

Next:
- always → step 16 (`n_ask`)

<details><summary>Full step definition</summary>

```json
{
  "id": "v_read",
  "type": "set_var",
  "key": "jev_read",
  "value": "{{reply.intent}}",
  "pick": {
    "cancelled": "Jev is {{reply.intent_confidence}}% sure they want to cancel.",
    "reschedule_request": "Jev is {{reply.intent_confidence}}% sure they want to reschedule.",
    "question": "Jev read it as a question, not an answer ({{reply.intent_confidence}}% sure)."
  },
  "else_value": "Jev couldn't tell what they meant (its guesses: {{reply.top_guesses}})."
}
```

</details>

### 14. How far off the call is when the day-before wait starts

- Step id `v_lead`, type `set_var`
- Engine description: Remember lead at day before = [call time]
- If it keeps failing: the run is held on this step (later steps read what it remembers)

Next:
- always → step 17 (`r24`)

<details><summary>Full step definition</summary>

```json
{
  "id": "v_lead",
  "title": "How far off the call is when the day-before wait starts",
  "type": "set_var",
  "key": "lead_at_day_before",
  "value": "{{appointment.starts_at | hours_until}}"
}
```

</details>

### 15. React ✅, note who confirmed

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
- always → step 18 (`rs`)

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

### 16. Ask in the booking channel: keep, cancel or reschedule?

- Step id `n_ask`, type `slack_post`
- Engine description: Post to Slack (the bookings channel, else the bookings channel)
- Detail: offers :white_check_mark: :x: :repeat: for a person to tap
- Goes to: channel {{slack.channel.bookings}}; falls back to {{slack.channel.bookings}}; posted as "Keep, cancel or reschedule?"; remembered as decision:{{appointment.id}}
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Slack post:

```
{{appointment.closer.mention | default:Heads up}} — {{contact.first_name}} replied to the booking text for the call {{appointment.starts_at | date_company}}. {{vars.jev_read}}
*We sent:*
> {{reply.last_outbound.body | default:nothing yet: our booking text didn't go out}}
*They wrote:*
> {{reply.inbound_since_send}}
Tap ✅ keep the call, ❌ cancel it, 🔁 reschedule (move it by hand; no text goes out). The reminders keep going until you do.
```

Next:
- always → step 19 (`n_pending`)

<details><summary>Full step definition</summary>

```json
{
  "id": "n_ask",
  "title": "Ask in the booking channel: keep, cancel or reschedule?",
  "type": "slack_post",
  "channel": "{{slack.channel.bookings}}",
  "fallback_channel": "{{slack.channel.bookings}}",
  "template": "{{appointment.closer.mention | default:Heads up}} — {{contact.first_name}} replied to the booking text for the call {{appointment.starts_at | date_company}}. {{vars.jev_read}}\n*We sent:*\n> {{reply.last_outbound.body | default:nothing yet: our booking text didn't go out}}\n*They wrote:*\n> {{reply.inbound_since_send}}\nTap ✅ keep the call, ❌ cancel it, 🔁 reschedule (move it by hand; no text goes out). The reminders keep going until you do.",
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

### 17. Wait until 24 hours before the call (not before 8:00 AM, not after 9:00 PM)

- Step id `r24`, type `wait`
- Detail: Contact's time zone
- Wait: Wait until 24 hours before the call (not before 8:00 AM, not after 9:00 PM) (time zone: contact; a time after the send window moves back before it closes)
- If it keeps failing: the run is held on this step (the run waits on it)

Next:
- always → step 20 (`m24s`)

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
    "latest": "21:00",
    "window": "before"
  }
}
```

</details>

### 18. Back to the reminder the run was on

- Step id `rs`, type `resume`
- Engine description: Go back to where the run was
- Detail: The step the listener pulled the run away from, with its own due time; nothing to go back to, and the run simply goes on
- If it keeps failing: the run is held on this step (it decides where the run goes)

Next:
- always → step 14 (`v_lead`)

<details><summary>Full step definition</summary>

```json
{
  "id": "rs",
  "title": "Back to the reminder the run was on",
  "type": "resume"
}
```

</details>

### 19. Note Jev's pending read on the appointment

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
      "intent": "{{reply.intent}}",
      "confidence": "{{reply.intent_confidence}}",
      "at": "{{now}}"
    }
  }
}
```

</details>

### 20. The day before

- Step id `m24s`, type `send_sms`
- Engine description: Send text
- Detail: Only if at least 18 hours before the call; otherwise skip it
- Runs only if: not (there is a lead at day before) or lead at day before is more than 24 (otherwise skipped)
- Goes to: the contact's phone (human)
- Timing check: before event, at least 18h before; when stale: skip
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Text message:

```
Hi {{contact.first_name}}, looking forward to our consultation tomorrow at {{appointment.starts_at | date:"h:mm a ZZZZ"}}. Come ready to talk about what you want in a partner and what hasn't worked so far. Nelly
```

Next:
- always → step 22 (`r1`)

<details><summary>Full step definition</summary>

```json
{
  "id": "m24s",
  "title": "The day before",
  "only_if": {
    "or": [
      {
        "not": {
          "exists": "vars.lead_at_day_before"
        }
      },
      {
        "gt": [
          "{{vars.lead_at_day_before}}",
          24
        ]
      }
    ]
  },
  "type": "send_sms",
  "template": "Hi {{contact.first_name}}, looking forward to our consultation tomorrow at {{appointment.starts_at | date:\"h:mm a ZZZZ\"}}. Come ready to talk about what you want in a partner and what hasn't worked so far. Nelly",
  "kind": "human",
  "validity": {
    "anchor": "before_event",
    "min_lead": "18h"
  },
  "on_stale": "skip"
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

### 22. Wait until 1 hour before the call (not before 7:00 AM)

- Step id `r1`, type `wait`
- Detail: Contact's time zone
- Wait: Wait until 1 hour before the call (not before 7:00 AM) (time zone: contact; a time after the send window moves back before it closes)
- If it keeps failing: the run is held on this step (the run waits on it)

Next:
- always → step 24 (`m1`)

<details><summary>Full step definition</summary>

```json
{
  "id": "r1",
  "type": "wait",
  "rule": {
    "anchor": "appointment.starts_at",
    "offset": "-1h",
    "tz": "contact",
    "earliest": "07:00",
    "window": "before"
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
- the reminders go on → step 14 (`v_lead`)
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

### 24. An hour before

- Step id `m1`, type `send_sms`
- Engine description: Send text
- Detail: Only if at least 15 minutes before the call; otherwise skip it
- Runs only if: there is a meeting link and not (there is a last outbound at) or last outbound at is less than -1 (otherwise skipped)
- Goes to: the contact's phone (human)
- Timing check: before event, at least 15m before; when stale: skip
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Text message:

```
{{contact.first_name}}, we're on {{appointment.starts_at | relative:hours}} ({{appointment.starts_at | date:"h:mm a ZZZZ"}}). Join here: {{appointment.meeting_url}} See you soon! Nelly
```

Next:
- always → step 27 (`m1_nolink`)

<details><summary>Full step definition</summary>

```json
{
  "id": "m1",
  "title": "An hour before",
  "only_if": {
    "and": [
      {
        "exists": "appointment.meeting_url"
      },
      {
        "or": [
          {
            "not": {
              "exists": "reply.last_outbound.at"
            }
          },
          {
            "lt": [
              "{{reply.last_outbound.at | hours_until}}",
              -1
            ]
          }
        ]
      }
    ]
  },
  "type": "send_sms",
  "template": "{{contact.first_name}}, we're on {{appointment.starts_at | relative:hours}} ({{appointment.starts_at | date:\"h:mm a ZZZZ\"}}). Join here: {{appointment.meeting_url}} See you soon! Nelly",
  "kind": "human",
  "validity": {
    "anchor": "before_event",
    "min_lead": "15m"
  },
  "on_stale": "skip"
}
```

</details>

### 25. Remember decided, picked by [the tap]

- Step id `v_decided`, type `set_var`
- Detail: white check mark → confirmed; x → cancelled; repeat → reschedule_request; otherwise 
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
    "white_check_mark": "confirmed",
    "x": "cancelled",
    "repeat": "reschedule_request"
  },
  "else_value": ""
}
```

</details>

### 26. Record that nobody answered before the call

- Step id `rec_un`, type `record`
- Engine description: Record: Nobody answered the team's question in time
- Detail: An event in the ledger with predicted, predicted confidence, hours before call, appointment id; nothing leaves the engine
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
    "predicted_confidence": "{{reply.intent_confidence}}",
    "hours_before_call": "{{appointment.starts_at | hours_until}}",
    "appointment_id": "{{appointment.id}}"
  }
}
```

</details>

### 27. An hour before, no link yet

- Step id `m1_nolink`, type `send_sms`
- Engine description: Send text
- Detail: Only if at least 15 minutes before the call; otherwise skip it
- Runs only if: not (there is a meeting link) and not (there is a last outbound at) or last outbound at is less than -1 (otherwise skipped)
- Goes to: the contact's phone (human)
- Timing check: before event, at least 15m before; when stale: skip
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Text message:

```
{{contact.first_name}}, we're on {{appointment.starts_at | relative:hours}} ({{appointment.starts_at | date:"h:mm a ZZZZ"}}). I'll send you the link here shortly. See you soon! Nelly
```

Next:
- always → step 30 (`x_done`)

<details><summary>Full step definition</summary>

```json
{
  "id": "m1_nolink",
  "title": "An hour before, no link yet",
  "only_if": {
    "and": [
      {
        "not": {
          "exists": "appointment.meeting_url"
        }
      },
      {
        "or": [
          {
            "not": {
              "exists": "reply.last_outbound.at"
            }
          },
          {
            "lt": [
              "{{reply.last_outbound.at | hours_until}}",
              -1
            ]
          }
        ]
      }
    ]
  },
  "type": "send_sms",
  "template": "{{contact.first_name}}, we're on {{appointment.starts_at | relative:hours}} ({{appointment.starts_at | date:\"h:mm a ZZZZ\"}}). I'll send you the link here shortly. See you soon! Nelly",
  "kind": "human",
  "validity": {
    "anchor": "before_event",
    "min_lead": "15m"
  },
  "on_stale": "skip"
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

### 30. Done

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

### 31. Score Jev: did the person agree with the read?

- Step id `rec`, type `record`
- Engine description: Record: A team member said whether Jev read it right
- Detail: An event in the ledger with predicted, predicted confidence, decided, agreed, decided by, appointment id; nothing leaves the engine
- If it keeps failing: the run is held on this step (it is the run's own ledger)

Next:
- always → step 33 (`n_clear`)

<details><summary>Full step definition</summary>

```json
{
  "id": "rec",
  "title": "Score Jev: did the person agree with the read?",
  "type": "record",
  "event": "intent.reviewed",
  "data": {
    "predicted": "{{reply.intent}}",
    "predicted_confidence": "{{reply.intent_confidence}}",
    "decided": "{{vars.decided}}",
    "agreed": "{{vars.agreed}}",
    "decided_by": "{{reaction.user_name}}",
    "appointment_id": "{{appointment.id}}"
  }
}
```

</details>

### 32. Which way?

- Step id `b_dec`, type `branch`
- If it keeps failing: the run is held on this step (it decides where the run goes)

Next:
- ✅ keep the call (when the tap is “white check mark”) → step 12 (`n_conf`)
- ❌ cancel it (when the tap is “x”) → step 34 (`n_cx`)
- 🔁 reschedule (when the tap is “repeat”) → step 35 (`n_rs_slack`)
- nobody decided: back to where the reminders were → step 18 (`rs`)

<details><summary>Full step definition</summary>

```json
{
  "id": "b_dec",
  "type": "branch"
}
```

</details>

### 33. Clear the pending read: a person decided

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

### 34. Mark appointment status → “cancelled”

- Step id `n_cx`, type `update_appointment`
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Next:
- always → step 36 (`n_cx_slack`)

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

### 35. React 🔁, note who is moving it (by hand)

- Step id `n_rs_slack`, type `slack_post`
- Engine description: Reply in the thread of that Slack post
- Detail: reacts :repeat: on it; takes its own :white_check_mark: :x: :repeat: off the post once decided; reacts :repeat: on the post remembered as decision:[an appointment]
- Goes to: channel {{slack.channel.bookings}}; in the thread of tag:appointment:{{appointment.id}}; posted as "Reschedule"
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Slack post:

```
🔁 {{contact.first_name}} wants a new time: moving the call by hand.
> {{reply.inbound_since_send}}{{reaction.user_name | line:Decided by}}
```

Next:
- always → step 37 (`x_reschedule`)

<details><summary>Full step definition</summary>

```json
{
  "id": "n_rs_slack",
  "title": "React 🔁, note who is moving it (by hand)",
  "type": "slack_post",
  "channel": "{{slack.channel.bookings}}",
  "template": "🔁 {{contact.first_name}} wants a new time: moving the call by hand.\n> {{reply.inbound_since_send}}{{reaction.user_name | line:Decided by}}",
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

### 36. React ❌, note who cancelled

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
- always → step 38 (`x_cancelled`)

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

### 37. Done: reschedule link sent

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

### 38. Done: cancelled

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

## Settings this workflow reads

| Key | Kind | Required to enable | Value |
| --- | --- | --- | --- |
| `crm.location_id` | id | yes | not read (repo) |
| `slack.channel.bookings` | channel | no | not read (repo) |
| `slack.channel.no_link` | channel | no | not read (repo) |
| `slack.channel.no_link_alerts` | channel | no | not read (repo) |

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
