# Setter call logged

Offer: **Dating (Nelly)** (`dating-nelly`). Source: **from repo, may differ from live**. Generated 2026-10-21.

| Setting | Value |
| --- | --- |
| Where this definition came from | playbook copy: platform/installs/dating-nelly/setter-call-logged.json |
| Template | `setter-call-logged` |
| Edited since copied from the template | unknown (repo) |
| Saved version | unknown (repo) |
| Enabled | unknown (repo) |
| Mode | follows the offer (quiet) |
| Send lock | unknown (repo) |
| Runs again for the same person | always |
| Re-checked before every step | contact exists |
| Send window | the offer's (unknown in repo) |
| Steps | 46 |
| Note | dating-nelly: why a setter DQs a lead, in the company's words (installs/dating-nelly/words.json), not Hair's (D118); a setting call's read is posted and logged for the end of day, which writes the Discovery Call record and moves the setter card: nothing written to the CRM here, no question to the team (D154) |

## Steps

Every step, in the order a run meets it from the trigger. Steps that only assemble words (`set_var`) are listed too.

### 1. A dialer call came in from GHL — kind of recording is a phone call and the call connected

- Step id `t1`, type `trigger`

Next:
- always → step 2 (`v1`)

<details><summary>Full step definition</summary>

```json
{
  "id": "t1",
  "type": "trigger",
  "event": "call.logged",
  "match": {
    "and": [
      {
        "eq": [
          "{{recording.kind}}",
          "phone"
        ]
      },
      {
        "eq": [
          "{{recording.connected}}",
          true
        ]
      }
    ]
  }
}
```

</details>

### 2. Remember min seconds = 60

- Step id `v1`, type `set_var`
- If it keeps failing: the run is held on this step (later steps read what it remembers)

Next:
- always → step 3 (`l_conv`)

<details><summary>Full step definition</summary>

```json
{
  "id": "v1",
  "type": "set_var",
  "key": "min_seconds",
  "value": 60
}
```

</details>

### 3. The whole conversation: the same setter's calls to them, each starting within the company's gap (15 minutes) of the last one ending

- Step id `l_conv`, type `lookup`
- Engine description: Look up the whole conversation this call is part of (the same caller's calls to them, each starting within the gap of the last one ending)
- Detail: recording id [this recording]; gap min [the gap between parts of one call (minutes)]; saved as convo for the steps after it (the engine's own question, read-only)
- If it keeps failing: the run is held on this step (step c1 reads what it looked up)

Next:
- always → step 4 (`c1`)

<details><summary>Full step definition</summary>

```json
{
  "id": "l_conv",
  "title": "The whole conversation: the same setter's calls to them, each starting within the company's gap (15 minutes) of the last one ending",
  "type": "lookup",
  "query": "call_conversation",
  "params": {
    "recording_id": "{{recording.id}}",
    "gap_min": "{{setting.calls.conversation_gap_min}}"
  },
  "into": "convo"
}
```

</details>

### 4. Check the whole conversation's length (seconds) is at least the minimum call length (seconds)

- Step id `c1`, type `check`
- Detail: Otherwise the run stops: too short
- If it keeps failing: the run is held on this step (it decides whether the run goes on)

Next:
- always → step 5 (`c2`)

<details><summary>Full step definition</summary>

```json
{
  "id": "c1",
  "type": "check",
  "when": {
    "gte": [
      "{{vars.convo.total_sec}}",
      "{{vars.min_seconds}}"
    ]
  },
  "else_exit": "too_short"
}
```

</details>

### 5. Check there is a transcript

- Step id `c2`, type `check`
- Detail: Otherwise the run stops: no transcript
- If it keeps failing: the run is held on this step (it decides whether the run goes on)

Next:
- always → step 6 (`a1`)

<details><summary>Full step definition</summary>

```json
{
  "id": "c2",
  "type": "check",
  "when": {
    "eq": [
      "{{recording.has_transcript}}",
      true
    ]
  },
  "else_exit": "no_transcript"
}
```

</details>

### 6. Jev: setting, confirmation or closing call?

- Step id `a1`, type `classify`
- Engine description: Jev: what kind of phone call between someone on the sales team and a lead was this?
- Detail: Decides between setting, confirmation, closing, other; below 80% sure, or a reply a careful person would doubt, goes to a person
- If it keeps failing: the run is held on this step (step b_kind reads the call type)

Question asked of the classifier:

```
What kind of phone call between someone on the sales team and a lead was this?
```

What it reads:

```
{{vars.convo.transcript_text}}
```

Option "setting" means:

```
The setter learns about the lead's situation, qualifies them, and works toward booking (or books) a closing call with Nelly. A booked triage or strategy call is a setting call too, whether or not it ends in a booking.
```

Option "confirmation" means:

```
The setter confirms an appointment that is already booked: time, link, what to expect, perhaps a brief re-qualification.
```

Option "closing" means:

```
The booked sales call itself: a closer presents the program, its price or payment, handles objections and asks for a decision to buy.
```

Option "other" means:

```
Anything else: 'are you joining the call', 'where are you', a voicemail greeting, a wrong number, spam, a call that never got past hello, an internal or personal call, or a transcript too thin to tell.
```

Next:
- always → step 7 (`b_kind`)

<details><summary>Full step definition</summary>

```json
{
  "id": "a1",
  "title": "Jev: setting, confirmation or closing call?",
  "type": "classify",
  "input": "{{vars.convo.transcript_text}}",
  "domain": "setter_call_type",
  "threshold": 0.8,
  "into": "vars.classify.call_type",
  "question": "What kind of phone call between someone on the sales team and a lead was this?",
  "criteria": {
    "setting": "The setter learns about the lead's situation, qualifies them, and works toward booking (or books) a closing call with Nelly. A booked triage or strategy call is a setting call too, whether or not it ends in a booking.",
    "confirmation": "The setter confirms an appointment that is already booked: time, link, what to expect, perhaps a brief re-qualification.",
    "closing": "The booked sales call itself: a closer presents the program, its price or payment, handles objections and asks for a decision to buy.",
    "other": "Anything else: 'are you joining the call', 'where are you', a voicemail greeting, a wrong number, spam, a call that never got past hello, an internal or personal call, or a transcript too thin to tell."
  },
  "ambiguity_max": 0.8
}
```

</details>

### 7. What kind of call?

- Step id `b_kind`, type `branch`
- Engine description: Which way?
- If it keeps failing: the run is held on this step (it decides where the run goes)

Next:
- closing call (when the call type is closing call) → step 8 (`l_book`)
- setting or confirmation call (when the call type is a setting call or a confirmation call) → step 9 (`a2`)
- anything else → step 10 (`x_other`)

<details><summary>Full step definition</summary>

```json
{
  "id": "b_kind",
  "title": "What kind of call?",
  "type": "branch"
}
```

</details>

### 8. Their booked call with this closer, starting within an hour of the call

- Step id `l_book`, type `lookup`
- Engine description: Look up their bookings
- Detail: kind closing; status not cancelled; closer [who dialed]; starts since [the call started] -60m; starts until [the call started] +60m; order starts at; saved as closing booking for the steps after it (the engine's own question, read-only)
- If it keeps failing: the run is held on this step (step v_link reads what it looked up)

Next:
- always → step 11 (`v_link`)

<details><summary>Full step definition</summary>

```json
{
  "id": "l_book",
  "title": "Their booked call with this closer, starting within an hour of the call",
  "type": "lookup",
  "query": "appointments_for_contact",
  "params": {
    "kind": "closing",
    "status_not": "cancelled",
    "closer": "{{recording.caller.ghl_user_id | default:}}",
    "starts_since": "{{vars.convo.first.started_at}} -60m",
    "starts_until": "{{vars.convo.first.started_at}} +60m",
    "order": "starts_at"
  },
  "into": "closing_booking"
}
```

</details>

### 9. AI reads the whole conversation's transcript with the “setter call notes” prompt

- Step id `a2`, type `analyze`
- Detail: Answer saved as notes (structured)
- If it keeps failing: the run is held on this step (step s1 reads the AI's notes)

AI prompt:

```
{{prompt.setter_call_notes}}
```

AI input:

```
{{vars.convo.transcript_text}}
```

Next:
- always → step 12 (`v_parts`)

<details><summary>Full step definition</summary>

```json
{
  "id": "a2",
  "type": "analyze",
  "prompt": "{{prompt.setter_call_notes}}",
  "input": "{{vars.convo.transcript_text}}",
  "into": "notes",
  "format": "json",
  "optional": false
}
```

</details>

### 10. Stop: not a setting call

- Step id `x_other`, type `exit`

Next: the run ends here.

<details><summary>Full step definition</summary>

```json
{
  "id": "x_other",
  "type": "exit",
  "reason": "not_a_setting_call"
}
```

</details>

### 11. Exactly one booking lines up (none or several: the closer's workflow asks which)

- Step id `v_link`, type `set_var`
- Engine description: Remember booking id = [the booking that lines up]
- Detail: When bookings that line up is 1; otherwise 
- If it keeps failing: the run is held on this step (later steps read what it remembers)

Next:
- always → step 13 (`rec_close`)

<details><summary>Full step definition</summary>

```json
{
  "id": "v_link",
  "title": "Exactly one booking lines up (none or several: the closer's workflow asks which)",
  "type": "set_var",
  "key": "booking_id",
  "value": "{{vars.closing_booking.first.id}}",
  "when": {
    "eq": [
      "{{vars.closing_booking.count}}",
      1
    ]
  },
  "else_value": ""
}
```

</details>

### 12. A call in parts says so

- Step id `v_parts`, type `set_var`
- Engine description: Remember parts line = ([the parts of the call] parts)
- Detail: When the parts of the call is more than 1; otherwise 
- If it keeps failing: the run is held on this step (later steps read what it remembers)

Next:
- always → step 14 (`b_type`)

<details><summary>Full step definition</summary>

```json
{
  "id": "v_parts",
  "title": "A call in parts says so",
  "type": "set_var",
  "key": "parts_line",
  "value": " ({{vars.convo.count}} parts)",
  "when": {
    "gt": [
      "{{vars.convo.count}}",
      1
    ]
  },
  "else_value": ""
}
```

</details>

### 13. A closing call: Sales call recorded takes it from here

- Step id `rec_close`, type `record`
- Engine description: Record: Jev read a dialer call as a closing call
- Detail: An event in the ledger with recording id, external id, conversation, parts, closer, linked, about [the booking it lines up with]; it starts the workflows that listen for it (once)
- If it keeps failing: the run is held on this step (it is the run's own ledger)

Next:
- always → step 15 (`x_close`)

<details><summary>Full step definition</summary>

```json
{
  "id": "rec_close",
  "title": "A closing call: Sales call recorded takes it from here",
  "type": "record",
  "event": "call.closing",
  "data": {
    "recording_id": "{{recording.id}}",
    "external_id": "{{recording.external_id}}",
    "conversation": "{{vars.convo.key}}",
    "parts": "{{vars.convo.count}}",
    "closer": "{{recording.caller.name | default:}}",
    "linked": "{{vars.booking_id}}"
  },
  "appointment": "{{vars.booking_id}}",
  "start": true
}
```

</details>

### 14. A setting call: what did it achieve?

- Step id `b_type`, type `branch`
- Engine description: Which way?
- If it keeps failing: the run is held on this step (it decides where the run goes)

Next:
- setting call (when the call type is a setting call) → step 16 (`a3`)
- confirmation call: post as soon as it is read → step 17 (`v_cline`)

<details><summary>Full step definition</summary>

```json
{
  "id": "b_type",
  "title": "A setting call: what did it achieve?",
  "type": "branch"
}
```

</details>

### 15. Stop: closing call

- Step id `x_close`, type `exit`

Next: the run ends here.

<details><summary>Full step definition</summary>

```json
{
  "id": "x_close",
  "type": "exit",
  "reason": "closing_call"
}
```

</details>

### 16. Jev: set, follow up, DQ or not interested?

- Step id `a3`, type `classify`
- Engine description: Jev: what did this setting call between a setter and a lead achieve?
- Detail: Decides between set, follow up, dq, not interested; below 70% sure, or a reply a careful person would doubt, goes to a person
- If it keeps failing: the run is held on this step (step v_conf reads reply intent confidence)

Question asked of the classifier:

```
What did this setting call between a setter and a lead achieve?
```

What it reads:

```
{{vars.convo.transcript_text}}
```

Option "set" means:

```
A call with the closer or specialist was booked on this call: a day and time were agreed, or the setter booked it while they were on the phone.
```

Option "follow_up" means:

```
The lead is interested but nothing was booked: a callback, a later conversation or sending them information was agreed or clearly implied.
```

Option "dq" means:

```
The lead is not a fit: they cannot afford the program right now, are not ready for a serious relationship, are already in one, want something casual, or it is a wrong or fake contact.
```

Option "not_interested" means:

```
The lead declined: they said they are not interested, do not want a call, or asked not to be contacted.
```

Next:
- always → step 18 (`v_conf`)

<details><summary>Full step definition</summary>

```json
{
  "id": "a3",
  "title": "Jev: set, follow up, DQ or not interested?",
  "type": "classify",
  "input": "{{vars.convo.transcript_text}}",
  "domain": "setter_call_result",
  "threshold": 0.7,
  "into": "vars.classify.result",
  "question": "What did this setting call between a setter and a lead achieve?",
  "criteria": {
    "set": "A call with the closer or specialist was booked on this call: a day and time were agreed, or the setter booked it while they were on the phone.",
    "follow_up": "The lead is interested but nothing was booked: a callback, a later conversation or sending them information was agreed or clearly implied.",
    "dq": "The lead is not a fit: they cannot afford the program right now, are not ready for a serious relationship, are already in one, want something casual, or it is a wrong or fake contact.",
    "not_interested": "The lead declined: they said they are not interested, do not want a call, or asked not to be contacted."
  },
  "ambiguity_max": 0.8
}
```

</details>

### 17. Remember outcome line = Confirmation call (no result read)

- Step id `v_cline`, type `set_var`
- If it keeps failing: the run is held on this step (later steps read what it remembers)

Next:
- always → step 19 (`l_now`)

<details><summary>Full step definition</summary>

```json
{
  "id": "v_cline",
  "type": "set_var",
  "key": "outcome_line",
  "value": "Confirmation call (no result read)"
}
```

</details>

### 18. Remember jev confidence = [reply intent confidence]

- Step id `v_conf`, type `set_var`
- If it keeps failing: the run is held on this step (later steps read what it remembers)

Next:
- always → step 20 (`v_guess`)

<details><summary>Full step definition</summary>

```json
{
  "id": "v_conf",
  "type": "set_var",
  "key": "jev_confidence",
  "value": "{{reply.intent_confidence}}"
}
```

</details>

### 19. Has a later part of this conversation come in meanwhile?

- Step id `l_now`, type `lookup`
- Engine description: Look up the whole conversation this call is part of (the same caller's calls to them, each starting within the gap of the last one ending)
- Detail: recording id [this recording]; gap min [the gap between parts of one call (minutes)]; saved as convo now for the steps after it (the engine's own question, read-only)
- If it keeps failing: the run is held on this step (step c_latest reads what it looked up)

Next:
- always → step 21 (`c_latest`)

<details><summary>Full step definition</summary>

```json
{
  "id": "l_now",
  "title": "Has a later part of this conversation come in meanwhile?",
  "type": "lookup",
  "query": "call_conversation",
  "params": {
    "recording_id": "{{recording.id}}",
    "gap_min": "{{setting.calls.conversation_gap_min}}"
  },
  "into": "convo_now"
}
```

</details>

### 20. Remember jev guesses = [top guesses]

- Step id `v_guess`, type `set_var`
- If it keeps failing: the run is held on this step (later steps read what it remembers)

Next:
- always → step 22 (`w_post`)

<details><summary>Full step definition</summary>

```json
{
  "id": "v_guess",
  "type": "set_var",
  "key": "jev_guesses",
  "value": "{{reply.top_guesses | words}}"
}
```

</details>

### 21. Check there are no later parts already in

- Step id `c_latest`, type `check`
- Detail: Otherwise the run stops: read with a later part
- If it keeps failing: the run is held on this step (it decides whether the run goes on)

Next:
- always → step 23 (`s1`)

<details><summary>Full step definition</summary>

```json
{
  "id": "c_latest",
  "type": "check",
  "when": {
    "eq": [
      "{{vars.convo_now.later_ready}}",
      0
    ]
  },
  "else_exit": "read_with_a_later_part"
}
```

</details>

### 22. Post as soon as a booking lands through a setter link (one made during the call counts at once), else 15 minutes after hang-up

- Step id `w_post`, type `wait_for_event`
- Engine description: Wait for appointment booked, until 15 minutes after the call ended
- Detail: About this person, when how it was booked is “setter” and when it was booked is at most the Set window closes (the company's minutes after hang-up); moves on the moment one arrives; one already there from [the call started] counts at once; nothing by then and it takes the no-event path
- Wait: Wait for "appointment.booked" about the contact where how it was booked is “setter” and when it was booked is at most the Set window closes (the company's minutes after hang-up), counting one since {{vars.convo.first.started_at}}, until until 15 minutes after the call ended (deadline ignores the send window)
- If it keeps failing: the run is held on this step (the run waits on it)

Next:
- always → step 24 (`v_by`)

<details><summary>Full step definition</summary>

```json
{
  "id": "w_post",
  "title": "Post as soon as a booking lands through a setter link (one made during the call counts at once), else 15 minutes after hang-up",
  "type": "wait_for_event",
  "event": "appointment.booked",
  "match": {
    "and": [
      {
        "eq": [
          "{{vars.booked.appointment.booking_source}}",
          "setter"
        ]
      },
      {
        "lte": [
          "{{vars.booked.appointment.booked_at | date:X}}",
          "{{recording.set_until | date:X}}"
        ]
      }
    ]
  },
  "about": "contact",
  "since": "{{vars.convo.first.started_at}}",
  "until": {
    "anchor": "recording.ended_at",
    "offset": "+15m",
    "tz": "company"
  },
  "into": "booked",
  "respect_send_window": false
}
```

</details>

### 23. Post the setter call in Slack (a later part edits the same post)

- Step id `s1`, type `slack_post`
- Engine description: Post to Slack (the setter calls channel)
- Goes to: channel {{slack.channel.setter_calls}}; edits the earlier post; posted as "Setter call"; remembered as setter-call:{{vars.convo.key}}
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Slack post:

```
*Setter call with:* <https://app.gohighlevel.com/v2/location/{{crm.location_id}}/contacts/detail/{{contact.ghl_contact_id | default:}}|{{contact.name | default:Unknown}}> · {{vars.classify.call_type}}
*Setter:* {{recording.caller.name | default:unknown}} · *Length:* {{vars.convo.total_min}} min{{vars.parts_line}} · {{recording.direction}}
*Outcome:* {{vars.outcome_line}}

{{vars.notes.digest}}

<{{recording.share_url | default:}}|Open the conversation in GHL>
```

Next:
- always → step 25 (`w_late`)

<details><summary>Full step definition</summary>

```json
{
  "id": "s1",
  "title": "Post the setter call in Slack (a later part edits the same post)",
  "type": "slack_post",
  "channel": "{{slack.channel.setter_calls}}",
  "template": "*Setter call with:* <https://app.gohighlevel.com/v2/location/{{crm.location_id}}/contacts/detail/{{contact.ghl_contact_id | default:}}|{{contact.name | default:Unknown}}> · {{vars.classify.call_type}}\n*Setter:* {{recording.caller.name | default:unknown}} · *Length:* {{vars.convo.total_min}} min{{vars.parts_line}} · {{recording.direction}}\n*Outcome:* {{vars.outcome_line}}\n\n{{vars.notes.digest}}\n\n<{{recording.share_url | default:}}|Open the conversation in GHL>",
  "as": {
    "name": "Setter call",
    "icon": [
      ":telephone_receiver:",
      ":speech_balloon:",
      ":headphones:"
    ]
  },
  "thread_only": false,
  "tag": "setter-call:{{vars.convo.key}}",
  "edit": true,
  "label": "mode"
}
```

</details>

### 24. Without a booking, Jev's read (a Set read with no booking is left to the end of day)

- Step id `v_by`, type `set_var`
- Engine description: Remember decided by = jev
- Detail: When Jev's read of the result is follow up, disqualified or “not interested”; otherwise 
- If it keeps failing: the run is held on this step (later steps read what it remembers)

Next:
- always → step 26 (`v_by30`)

<details><summary>Full step definition</summary>

```json
{
  "id": "v_by",
  "title": "Without a booking, Jev's read (a Set read with no booking is left to the end of day)",
  "type": "set_var",
  "key": "decided_by",
  "value": "jev",
  "when": {
    "in": [
      "{{vars.classify.result}}",
      [
        "follow_up",
        "dq",
        "not_interested"
      ]
    ]
  },
  "else_value": ""
}
```

</details>

### 25. Until the Set window closes (the company's 30 minutes after hang-up): a booking through a setter link makes it Set

- Step id `w_late`, type `wait_for_event`
- Engine description: Wait for appointment booked, until the Set window closes (the company's minutes after hang-up)
- Detail: About this person, when how it was booked is “setter” and when it was booked is at most the Set window closes (the company's minutes after hang-up); moves on the moment one arrives; one already there from [the call started] counts at once; nothing by then and it takes the no-event path
- Runs only if: the call type is a setting call and the result is not “set” (otherwise skipped)
- Wait: Wait for "appointment.booked" about the contact where how it was booked is “setter” and when it was booked is at most the Set window closes (the company's minutes after hang-up), counting one since {{vars.convo.first.started_at}}, until until the Set window closes (the company's minutes after hang-up) (deadline ignores the send window)
- If it keeps failing: the run is held on this step (the run waits on it)

Next:
- always → step 27 (`l_now2`)

<details><summary>Full step definition</summary>

```json
{
  "id": "w_late",
  "title": "Until the Set window closes (the company's 30 minutes after hang-up): a booking through a setter link makes it Set",
  "only_if": {
    "and": [
      {
        "eq": [
          "{{vars.classify.call_type}}",
          "setting"
        ]
      },
      {
        "neq": [
          "{{vars.result}}",
          "set"
        ]
      }
    ]
  },
  "type": "wait_for_event",
  "event": "appointment.booked",
  "match": {
    "and": [
      {
        "eq": [
          "{{vars.late.appointment.booking_source}}",
          "setter"
        ]
      },
      {
        "lte": [
          "{{vars.late.appointment.booked_at | date:X}}",
          "{{recording.set_until | date:X}}"
        ]
      }
    ]
  },
  "about": "contact",
  "since": "{{vars.convo.first.started_at}}",
  "until": {
    "anchor": "recording.set_until",
    "offset": "+0m",
    "tz": "company"
  },
  "into": "late",
  "respect_send_window": false
}
```

</details>

### 26. A booking through a setter link: Set, whatever Jev read

- Step id `v_by30`, type `set_var`
- Engine description: Remember decided by = booking
- Detail: When a booking came through a setter link; otherwise [who decided the result]
- If it keeps failing: the run is held on this step (later steps read what it remembers)

Next:
- always → step 28 (`v_res`)

<details><summary>Full step definition</summary>

```json
{
  "id": "v_by30",
  "title": "A booking through a setter link: Set, whatever Jev read",
  "type": "set_var",
  "key": "decided_by",
  "value": "booking",
  "when": {
    "eq": [
      "{{vars.booked.matched}}",
      true
    ]
  },
  "else_value": "{{vars.decided_by}}"
}
```

</details>

### 27. Has a later part of this conversation come in meanwhile?

- Step id `l_now2`, type `lookup`
- Engine description: Look up the whole conversation this call is part of (the same caller's calls to them, each starting within the gap of the last one ending)
- Detail: recording id [this recording]; gap min [the gap between parts of one call (minutes)]; saved as convo now for the steps after it (the engine's own question, read-only)
- If it keeps failing: the run is held on this step (step c_latest2 reads what it looked up)

Next:
- always → step 29 (`c_latest2`)

<details><summary>Full step definition</summary>

```json
{
  "id": "l_now2",
  "title": "Has a later part of this conversation come in meanwhile?",
  "type": "lookup",
  "query": "call_conversation",
  "params": {
    "recording_id": "{{recording.id}}",
    "gap_min": "{{setting.calls.conversation_gap_min}}"
  },
  "into": "convo_now"
}
```

</details>

### 28. Remember result, picked by [who decided the result]

- Step id `v_res`, type `set_var`
- Detail: booking → set; jev → [Jev's read of the result]; otherwise 
- If it keeps failing: the run is held on this step (later steps read what it remembers)

Next:
- always → step 30 (`v_agree`)

<details><summary>Full step definition</summary>

```json
{
  "id": "v_res",
  "type": "set_var",
  "key": "result",
  "value": "{{vars.decided_by}}",
  "pick": {
    "booking": "set",
    "jev": "{{vars.classify.result}}"
  },
  "else_value": ""
}
```

</details>

### 29. A later part's run has the whole conversation (its post, its record, its question)

- Step id `c_latest2`, type `check`
- Engine description: Check there are no later parts already in
- Detail: Otherwise the run stops: read with a later part
- If it keeps failing: the run is held on this step (it decides whether the run goes on)

Next:
- always → step 31 (`b_late`)

<details><summary>Full step definition</summary>

```json
{
  "id": "c_latest2",
  "title": "A later part's run has the whole conversation (its post, its record, its question)",
  "type": "check",
  "when": {
    "eq": [
      "{{vars.convo_now.later_ready}}",
      0
    ]
  },
  "else_exit": "read_with_a_later_part"
}
```

</details>

### 30. Remember jev agreed = true

- Step id `v_agree`, type `set_var`
- Detail: When Jev's read of the result is the result; otherwise false
- If it keeps failing: the run is held on this step (later steps read what it remembers)

Next:
- always → step 32 (`a4`)

<details><summary>Full step definition</summary>

```json
{
  "id": "v_agree",
  "type": "set_var",
  "key": "jev_agreed",
  "value": true,
  "when": {
    "eq": [
      "{{vars.classify.result}}",
      "{{vars.result}}"
    ]
  },
  "else_value": false
}
```

</details>

### 31. Did a booking through a setter link land in the Set window?

- Step id `b_late`, type `branch`
- Engine description: Which way?
- If it keeps failing: the run is held on this step (it decides where the run goes)

Next:
- booked: Set (when late matched) → step 33 (`lt_res`)
- no booking in the window → step 34 (`x1`)

<details><summary>Full step definition</summary>

```json
{
  "id": "b_late",
  "title": "Did a booking through a setter link land in the Set window?",
  "type": "branch"
}
```

</details>

### 32. Jev: why disqualified?

- Step id `a4`, type `classify`
- Engine description: Jev: if this lead was disqualified on the call, what was the reason?
- Detail: Decides between budget, not ready, in relationship, casual, bad contact, other; below 60% sure, or a reply a careful person would doubt, goes to a person
- Runs only if: the result is disqualified or blank (otherwise skipped)
- If it keeps failing: after its tries it is skipped and the run goes on (set on the step (blocking: false); set on the step)

Question asked of the classifier:

```
If this lead was disqualified on the call, what was the reason?
```

What it reads:

```
{{vars.convo.transcript_text}}
```

Option "budget" means:

```
They cannot afford the program right now, or have no money set aside for it.
```

Option "not_ready" means:

```
They are not ready to date seriously yet: still getting over a breakup, too busy, or not in the right place for a relationship.
```

Option "in_relationship" means:

```
They are already in a relationship or married.
```

Option "casual" means:

```
They want casual dating or hookups, not a committed relationship.
```

Option "bad_contact" means:

```
A wrong number, a fake or duplicate contact, or someone who never asked to be contacted.
```

Option "other" means:

```
Any other reason, or the transcript does not say.
```

Next:
- always → step 35 (`rec_read`)

<details><summary>Full step definition</summary>

```json
{
  "id": "a4",
  "title": "Jev: why disqualified?",
  "only_if": {
    "in": [
      "{{vars.result}}",
      [
        "dq",
        ""
      ]
    ]
  },
  "blocking": false,
  "type": "classify",
  "input": "{{vars.convo.transcript_text}}",
  "domain": "dating_dq_reason",
  "threshold": 0.6,
  "into": "vars.classify.dq_reason",
  "question": "If this lead was disqualified on the call, what was the reason?",
  "criteria": {
    "budget": "They cannot afford the program right now, or have no money set aside for it.",
    "not_ready": "They are not ready to date seriously yet: still getting over a breakup, too busy, or not in the right place for a relationship.",
    "in_relationship": "They are already in a relationship or married.",
    "casual": "They want casual dating or hookups, not a committed relationship.",
    "bad_contact": "A wrong number, a fake or duplicate contact, or someone who never asked to be contacted.",
    "other": "Any other reason, or the transcript does not say."
  },
  "ambiguity_max": 0.8
}
```

</details>

### 33. Remember result = set

- Step id `lt_res`, type `set_var`
- If it keeps failing: the run is held on this step (later steps read what it remembers)

Next:
- always → step 36 (`lt_by`)

<details><summary>Full step definition</summary>

```json
{
  "id": "lt_res",
  "type": "set_var",
  "key": "result",
  "value": "set"
}
```

</details>

### 34. Stop: posted

- Step id `x1`, type `exit`

Next: the run ends here.

<details><summary>Full step definition</summary>

```json
{
  "id": "x1",
  "type": "exit",
  "reason": "posted"
}
```

</details>

### 35. Log Jev's read, to score it later

- Step id `rec_read`, type `record`
- Engine description: Record: Jev read what a setter call achieved
- Detail: An event in the ledger with recording id, external id, parts, setter, predicted, predicted confidence, top guesses, result, decided by, set by booking, booked at, jev agreed, dq reason, acts, call type, dq domain, digest; nothing leaves the engine
- If it keeps failing: the run is held on this step (it is the run's own ledger)

Next:
- always → step 37 (`v_words`)

<details><summary>Full step definition</summary>

```json
{
  "id": "rec_read",
  "title": "Log Jev's read, to score it later",
  "type": "record",
  "event": "setter_call.result",
  "data": {
    "recording_id": "{{vars.convo.first.id}}",
    "external_id": "{{vars.convo.key}}",
    "parts": "{{vars.convo.count}}",
    "setter": "{{recording.caller.name | default:}}",
    "predicted": "{{vars.classify.result}}",
    "predicted_confidence": "{{vars.jev_confidence}}",
    "top_guesses": "{{vars.jev_guesses}}",
    "result": "{{vars.result}}",
    "decided_by": "{{vars.decided_by}}",
    "set_by_booking": "{{vars.booked.matched | default:false}}",
    "booked_at": "{{vars.booked.appointment.booked_at | default:}}",
    "jev_agreed": "{{vars.jev_agreed}}",
    "dq_reason": "{{vars.classify.dq_reason | default:}}",
    "acts": "{{setting.setter_result.act}}",
    "call_type": "{{vars.classify.call_type}}",
    "dq_domain": "dating_dq_reason",
    "digest": "{{vars.notes.digest | default:}}"
  }
}
```

</details>

### 36. Remember decided by = booking

- Step id `lt_by`, type `set_var`
- If it keeps failing: the run is held on this step (later steps read what it remembers)

Next:
- always → step 38 (`lt_agree`)

<details><summary>Full step definition</summary>

```json
{
  "id": "lt_by",
  "type": "set_var",
  "key": "decided_by",
  "value": "booking"
}
```

</details>

### 37. Remember result words, picked by [the result]

- Step id `v_words`, type `set_var`
- Detail: set → Set; follow up → Follow up; dq → DQ; not interested → Not interested; otherwise 
- If it keeps failing: the run is held on this step (later steps read what it remembers)

Next:
- always → step 39 (`v_when`)

<details><summary>Full step definition</summary>

```json
{
  "id": "v_words",
  "type": "set_var",
  "key": "result_words",
  "value": "{{vars.result}}",
  "pick": {
    "set": "Set",
    "follow_up": "Follow up",
    "dq": "DQ",
    "not_interested": "Not interested"
  },
  "else_value": ""
}
```

</details>

### 38. Remember jev agreed = true

- Step id `lt_agree`, type `set_var`
- Detail: When Jev's read of the result is “set”; otherwise false
- If it keeps failing: the run is held on this step (later steps read what it remembers)

Next:
- always → step 40 (`lt_ask`)

<details><summary>Full step definition</summary>

```json
{
  "id": "lt_agree",
  "type": "set_var",
  "key": "jev_agreed",
  "value": true,
  "when": {
    "eq": [
      "{{vars.classify.result}}",
      "set"
    ]
  },
  "else_value": false
}
```

</details>

### 39. Remember booked when = during the call

- Step id `v_when`, type `set_var`
- Detail: When when it was booked is at most the call ended; otherwise after the call
- If it keeps failing: the run is held on this step (later steps read what it remembers)

Next:
- always → step 41 (`v_unsure`)

<details><summary>Full step definition</summary>

```json
{
  "id": "v_when",
  "type": "set_var",
  "key": "booked_when",
  "value": "during the call",
  "when": {
    "lte": [
      "{{vars.booked.appointment.booked_at | date:X}}",
      "{{recording.ended_at | date:X}}"
    ]
  },
  "else_value": "after the call"
}
```

</details>

### 40. Remember asking = false

- Step id `lt_ask`, type `set_var`
- If it keeps failing: the run is held on this step (later steps read what it remembers)

Next:
- always → step 42 (`lt_words`)

<details><summary>Full step definition</summary>

```json
{
  "id": "lt_ask",
  "type": "set_var",
  "key": "asking",
  "value": false
}
```

</details>

### 41. Remember unsure line, picked by [Jev's read of the result]

- Step id `v_unsure`, type `set_var`
- Detail: set → Jev read Set ([how sure Jev was]% sure), but no booking came through a setter link; otherwise Jev isn't sure (its guesses: [Jev's guesses])
- If it keeps failing: the run is held on this step (later steps read what it remembers)

Next:
- always → step 43 (`v_line`)

<details><summary>Full step definition</summary>

```json
{
  "id": "v_unsure",
  "type": "set_var",
  "key": "unsure_line",
  "value": "{{vars.classify.result}}",
  "pick": {
    "set": "Jev read Set ({{vars.jev_confidence}}% sure), but no booking came through a setter link"
  },
  "else_value": "Jev isn't sure (its guesses: {{vars.jev_guesses}})"
}
```

</details>

### 42. Remember result words = Set

- Step id `lt_words`, type `set_var`
- If it keeps failing: the run is held on this step (later steps read what it remembers)

Next:
- always → step 44 (`lt_line`)

<details><summary>Full step definition</summary>

```json
{
  "id": "lt_words",
  "type": "set_var",
  "key": "result_words",
  "value": "Set"
}
```

</details>

### 43. Remember outcome line, picked by [who decided the result]

- Step id `v_line`, type `set_var`
- Detail: booking → Set — booked through a setter link [when it was booked] (Jev read: [Jev's read of the result], [how sure Jev was]% sure); jev → [the result] (Jev is [how sure Jev was]% sure); otherwise [why the team is asked]; the end of day asks
- If it keeps failing: the run is held on this step (later steps read what it remembers)

Next:
- always → step 19 (`l_now`)

<details><summary>Full step definition</summary>

```json
{
  "id": "v_line",
  "type": "set_var",
  "key": "outcome_line",
  "value": "{{vars.decided_by}}",
  "pick": {
    "booking": "Set — booked through a setter link {{vars.booked_when}} (Jev read: {{vars.classify.result | words}}, {{vars.jev_confidence}}% sure)",
    "jev": "{{vars.result_words}} (Jev is {{vars.jev_confidence}}% sure)"
  },
  "else_value": "{{vars.unsure_line}}; the end of day asks"
}
```

</details>

### 44. Remember outcome line = Set — booked through a setter link after the call (Jev read: [Jev's read of the result], [how sure Jev was]% sure)

- Step id `lt_line`, type `set_var`
- If it keeps failing: the run is held on this step (later steps read what it remembers)

Next:
- always → step 45 (`rec_late`)

<details><summary>Full step definition</summary>

```json
{
  "id": "lt_line",
  "type": "set_var",
  "key": "outcome_line",
  "value": "Set — booked through a setter link after the call (Jev read: {{vars.classify.result | words}}, {{vars.jev_confidence}}% sure)"
}
```

</details>

### 45. Log the result again: Set by the booking

- Step id `rec_late`, type `record`
- Engine description: Record: Jev read what a setter call achieved
- Detail: An event in the ledger with recording id, external id, parts, setter, predicted, predicted confidence, top guesses, result, decided by, set by booking, booked at, jev agreed, dq reason, acts, call type, dq domain, digest; nothing leaves the engine
- If it keeps failing: the run is held on this step (it is the run's own ledger)

Next:
- always → step 46 (`s_late`)

<details><summary>Full step definition</summary>

```json
{
  "id": "rec_late",
  "title": "Log the result again: Set by the booking",
  "type": "record",
  "event": "setter_call.result",
  "data": {
    "recording_id": "{{vars.convo.first.id}}",
    "external_id": "{{vars.convo.key}}",
    "parts": "{{vars.convo.count}}",
    "setter": "{{recording.caller.name | default:}}",
    "predicted": "{{vars.classify.result}}",
    "predicted_confidence": "{{vars.jev_confidence}}",
    "top_guesses": "{{vars.jev_guesses}}",
    "result": "set",
    "decided_by": "booking",
    "set_by_booking": "true",
    "booked_at": "{{vars.late.appointment.booked_at | default:}}",
    "jev_agreed": "{{vars.jev_agreed}}",
    "dq_reason": "{{vars.classify.dq_reason | default:}}",
    "acts": "{{setting.setter_result.act}}",
    "call_type": "{{vars.classify.call_type}}",
    "dq_domain": "dating_dq_reason",
    "digest": "{{vars.notes.digest | default:}}"
  }
}
```

</details>

### 46. Edit the post to Set

- Step id `s_late`, type `slack_post`
- Engine description: Post to Slack (the setter calls channel)
- Goes to: channel {{slack.channel.setter_calls}}; edits the earlier post; posted as "Setter call"; remembered as setter-call:{{vars.convo.key}}
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Slack post:

```
*Setter call with:* <https://app.gohighlevel.com/v2/location/{{crm.location_id}}/contacts/detail/{{contact.ghl_contact_id | default:}}|{{contact.name | default:Unknown}}> · {{vars.classify.call_type}}
*Setter:* {{recording.caller.name | default:unknown}} · *Length:* {{vars.convo.total_min}} min{{vars.parts_line}} · {{recording.direction}}
*Outcome:* {{vars.outcome_line}}

{{vars.notes.digest}}

<{{recording.share_url | default:}}|Open the conversation in GHL>
```

Next:
- always → step 34 (`x1`)

<details><summary>Full step definition</summary>

```json
{
  "id": "s_late",
  "title": "Edit the post to Set",
  "type": "slack_post",
  "channel": "{{slack.channel.setter_calls}}",
  "template": "*Setter call with:* <https://app.gohighlevel.com/v2/location/{{crm.location_id}}/contacts/detail/{{contact.ghl_contact_id | default:}}|{{contact.name | default:Unknown}}> · {{vars.classify.call_type}}\n*Setter:* {{recording.caller.name | default:unknown}} · *Length:* {{vars.convo.total_min}} min{{vars.parts_line}} · {{recording.direction}}\n*Outcome:* {{vars.outcome_line}}\n\n{{vars.notes.digest}}\n\n<{{recording.share_url | default:}}|Open the conversation in GHL>",
  "as": {
    "name": "Setter call",
    "icon": [
      ":telephone_receiver:",
      ":speech_balloon:",
      ":headphones:"
    ]
  },
  "thread_only": false,
  "tag": "setter-call:{{vars.convo.key}}",
  "edit": true,
  "label": "mode"
}
```

</details>

## Settings this workflow reads

| Key | Kind | Required to enable | Value |
| --- | --- | --- | --- |
| `crm.location_id` | id | yes | not read (repo) |
| `prompt.setter_call_notes` | text | yes | not read (repo) |
| `secret.anthropic_key` | secret | yes | not read (repo) |
| `slack.channel.setter_calls` | channel | no | not read (repo) |

## Engine rules that apply but are not steps

These act on every run of this workflow from engine code. They are not in the definition above.

- **Mode.** The workflow's own mode, else the offer's, decides what is real: ghost writes and sends nothing, test is real only for test contacts, quiet writes the CRM but reaches no contact, live is real. (platform/src/engine/mode.ts:23, platform/src/engine/mode.ts:55)
- **Runs again?** A run's key is built from the re-entry policy; a second trigger with the same key starts nothing. A run that stops at a gate does not count. (platform/src/engine/reentry.ts:6)
- **Premise re-check.** Before each step the engine reads the CRM live; when "contact exists" no longer holds, the run exits. (platform/src/engine/runner.ts:33)
- **Failures.** Errors are sorted into transient, auth, permanent and unknown. A step is retried after 1 and 5 minutes; then a non-blocking step is skipped and a blocking one is held and looked at again after 15 minutes, then hourly. An auth or permanent failure pauses the run until it is fixed. (platform/src/engine/failures.ts:19, platform/src/engine/failures.ts:21, platform/src/engine/blocking.ts:58)
- **Step cap.** At most 50 steps run in one go; a run past that fails. After an outage, at most 20 sends per offer per tick. (platform/src/engine/runner.ts:21, platform/src/engine/runner.ts:27)
- **Slack before live.** Until the workflow is live, every post goes to the offer's test channel with a ghost/test label, unless `slack.live` is set. (platform/src/engine/mode.ts:32, platform/src/engine/mode.ts:34)
- **Waits** are stored on the run (`runs.next_run_at`, `wake_on_*`), not held in memory; a reply, tap or event wakes the run at once. (platform/src/engine/runner.ts:56)
