# Sales call recorded

Offer: **Dating (Nelly)** (`dating-nelly`). Source: **from repo, may differ from live**. Generated 2026-10-21.

| Setting | Value |
| --- | --- |
| Where this definition came from | shipped template: platform/src/templates/call-recorded.json (the offer's words, if any, are applied at install) |
| Template | `call-recorded` |
| Edited since copied from the template | unknown (repo) |
| Saved version | unknown (repo) |
| Enabled | unknown (repo) |
| Mode | follows the offer (quiet) |
| Send lock | unknown (repo) |
| Runs again for the same person | always |
| Re-checked before every step | contact exists |
| Send window | the offer's (unknown in repo) |
| Steps | 35 |

## Steps

Every step, in the order a run meets it from the trigger. Steps that only assemble words (`set_var`) are listed too.

### 1. A meeting recording came in (Fathom)

- Step id `t1`, type `trigger`
- Engine description: Fathom recording received

Next:
- always → step 3 (`l_conv`)

<details><summary>Full step definition</summary>

```json
{
  "id": "t1",
  "title": "A meeting recording came in (Fathom)",
  "type": "trigger",
  "event": "recording.received"
}
```

</details>

### 2. A dialer call Jev read as a closing call (Setter call logged hands it over)

- Step id `t2`, type `trigger`
- Engine description: Jev read a dialer call as a closing call

Next:
- always → step 3 (`l_conv`)

<details><summary>Full step definition</summary>

```json
{
  "id": "t2",
  "title": "A dialer call Jev read as a closing call (Setter call logged hands it over)",
  "type": "trigger",
  "event": "call.closing"
}
```

</details>

### 3. The whole call: a dialer call in parts (a dropped line) is read as one; a meeting recording is its own whole

- Step id `l_conv`, type `lookup`
- Engine description: Look up the whole conversation this call is part of (the same caller's calls to them, each starting within the gap of the last one ending)
- Detail: recording id [this recording]; gap min [the gap between parts of one call (minutes)]; saved as convo for the steps after it (the engine's own question, read-only)
- If it keeps failing: the run is held on this step (step a1 reads what it looked up)

Next:
- always → step 4 (`a1`)

<details><summary>Full step definition</summary>

```json
{
  "id": "l_conv",
  "title": "The whole call: a dialer call in parts (a dropped line) is read as one; a meeting recording is its own whole",
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

### 4. Jev: is it a sales call? (a dialer call Jev already read as closing skips this)

- Step id `a1`, type `classify`
- Engine description: Jev: what kind of recording is this?
- Detail: Decides between sales call, internal, other; below 80% sure, or a reply a careful person would doubt, goes to a person
- Runs only if: a Fathom recording (otherwise skipped)
- If it keeps failing: the run is held on this step (step c1 reads the recording)

Question asked of the classifier:

```
What kind of recording is this?
```

What it reads:

```
{{vars.convo.transcript_text}}
```

Option "sales_call" means:

```
A conversation between someone on the team and a prospect or customer about buying, starting, continuing or paying for the program.
```

Option "internal" means:

```
Team members talking to each other: a standup, training, role-play, a vendor call.
```

Option "other" means:

```
Anything else: a voicemail, a wrong number, a personal call, an unrelated meeting.
```

Next:
- always → step 5 (`c1`)

<details><summary>Full step definition</summary>

```json
{
  "id": "a1",
  "title": "Jev: is it a sales call? (a dialer call Jev already read as closing skips this)",
  "only_if": {
    "eq": [
      "{{event._type}}",
      "recording.received"
    ]
  },
  "type": "classify",
  "input": "{{vars.convo.transcript_text}}",
  "domain": "recording_kind",
  "threshold": 0.8,
  "into": "vars.classify.kind",
  "question": "What kind of recording is this?",
  "criteria": {
    "sales_call": "A conversation between someone on the team and a prospect or customer about buying, starting, continuing or paying for the program.",
    "internal": "Team members talking to each other: a standup, training, role-play, a vendor call.",
    "other": "Anything else: a voicemail, a wrong number, a personal call, an unrelated meeting."
  },
  "ambiguity_max": 0.8
}
```

</details>

### 5. Check the recording is a sales call or this is a closing call Jev read

- Step id `c1`, type `check`
- Detail: Otherwise the run stops: not a sales call
- If it keeps failing: the run is held on this step (it decides whether the run goes on)

Next:
- always → step 6 (`a3`)

<details><summary>Full step definition</summary>

```json
{
  "id": "c1",
  "type": "check",
  "when": {
    "or": [
      {
        "eq": [
          "{{vars.classify.kind}}",
          "sales_call"
        ]
      },
      {
        "eq": [
          "{{event._type}}",
          "call.closing"
        ]
      }
    ]
  },
  "else_exit": "not_a_sales_call"
}
```

</details>

### 6. Jev: how did the call end?

- Step id `a3`, type `classify`
- Engine description: Jev: how did this sales call end?
- Detail: Decides between closed won, close pending, follow up, lost, dq, financing denied, unclear; below 70% sure, or a reply a careful person would doubt, goes to a person
- If it keeps failing: the run is held on this step (step s1 reads how the call ended)

Question asked of the classifier:

```
How did this sales call end?
```

What it reads:

```
{{vars.convo.transcript_text}}
```

Option "closed_won" means:

```
They agreed to buy and payment was arranged or taken on the call.
```

Option "close_pending" means:

```
They agreed in principle; payment or paperwork is still to come.
```

Option "follow_up" means:

```
No decision yet; a next conversation or a think-it-over was agreed.
```

Option "lost" means:

```
They said no.
```

Option "dq" means:

```
Not a fit: the team disqualified them.
```

Option "financing_denied" means:

```
They wanted to buy but could not pay or finance.
```

Option "unclear" means:

```
The transcript does not show how it ended.
```

Next:
- always → step 7 (`a2`)

<details><summary>Full step definition</summary>

```json
{
  "id": "a3",
  "title": "Jev: how did the call end?",
  "type": "classify",
  "input": "{{vars.convo.transcript_text}}",
  "domain": "sales_call_disposition",
  "threshold": 0.7,
  "into": "vars.outcome.disposition",
  "question": "How did this sales call end?",
  "criteria": {
    "closed_won": "They agreed to buy and payment was arranged or taken on the call.",
    "close_pending": "They agreed in principle; payment or paperwork is still to come.",
    "follow_up": "No decision yet; a next conversation or a think-it-over was agreed.",
    "lost": "They said no.",
    "dq": "Not a fit: the team disqualified them.",
    "financing_denied": "They wanted to buy but could not pay or finance.",
    "unclear": "The transcript does not show how it ended."
  },
  "ambiguity_max": 0.85
}
```

</details>

### 7. AI: call notes and scorecard

- Step id `a2`, type `analyze`
- Engine description: AI reads the whole conversation's transcript with the “call review” prompt
- Detail: Answer saved as notes and rubric (structured)
- If it keeps failing: the run is held on this step (step s1 reads the AI's notes)

AI prompt:

```
{{prompt.call_review}}
```

AI input:

```
{{vars.convo.transcript_text}}
```

Next:
- always → step 8 (`v_parts`)

<details><summary>Full step definition</summary>

```json
{
  "id": "a2",
  "title": "AI: call notes and scorecard",
  "type": "analyze",
  "prompt": "{{prompt.call_review}}",
  "input": "{{vars.convo.transcript_text}}",
  "into": [
    "notes",
    "rubric"
  ],
  "format": "json",
  "optional": false
}
```

</details>

### 8. A call in parts says so

- Step id `v_parts`, type `set_var`
- Engine description: Remember parts line = ([the parts of the call] parts)
- Detail: When the parts of the call is more than 1; otherwise 
- If it keeps failing: the run is held on this step (later steps read what it remembers)

Next:
- always → step 9 (`v_rec`)

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

### 9. Remember recording line, picked by [provider]

- Step id `v_rec`, type `set_var`
- Detail: ghl → *Recording:*; otherwise [recording link]
- If it keeps failing: the run is held on this step (later steps read what it remembers)

Next:
- always → step 10 (`b1`)

<details><summary>Full step definition</summary>

```json
{
  "id": "v_rec",
  "type": "set_var",
  "key": "recording_line",
  "value": "{{recording.provider}}",
  "pick": {
    "ghl": "\n*Recording:* <{{recording.share_url | default:}}|Open the call in GHL>"
  },
  "else_value": "{{recording.share_url | link:Fathom | line:*Recording:*}}"
}
```

</details>

### 10. Which way?

- Step id `b1`, type `branch`
- If it keeps failing: the run is held on this step (it decides where the run goes)

Next:
- appointment matched (when there is an appointment) → step 11 (`o1`)
- a phone call, no booking lines up (when this is a closing call Jev read and not (there is an appointment)) → step 12 (`k5`)
- no appointment matched → step 13 (`k2`)

<details><summary>Full step definition</summary>

```json
{
  "id": "b1",
  "type": "branch"
}
```

</details>

### 11. Record the appointment as “showed”

- Step id `o1`, type `record_outcome`
- Detail: On our record of the appointment; a show also fires “call held”
- If it keeps failing: the run is held on this step (it is the run's own ledger)

Next:
- always → step 14 (`o2`)

<details><summary>Full step definition</summary>

```json
{
  "id": "o1",
  "type": "record_outcome",
  "outcome": "showed",
  "source": "engine"
}
```

</details>

### 12. Remember appt line = ⚠️ A closing call by phone that lines up with none of their bookings — nothing marked showed. The team is asked which booking it was.

- Step id `k5`, type `set_var`
- If it keeps failing: the run is held on this step (later steps read what it remembers)

Next:
- always → step 15 (`s1`)

<details><summary>Full step definition</summary>

```json
{
  "id": "k5",
  "type": "set_var",
  "key": "appt_line",
  "value": "⚠️ A closing call by phone that lines up with none of their bookings — nothing marked showed. The team is asked which booking it was."
}
```

</details>

### 13. Remember call key = [provider]-[the conversation]

- Step id `k2`, type `set_var`
- If it keeps failing: the run is held on this step (later steps read what it remembers)

Next:
- always → step 16 (`k4`)

<details><summary>Full step definition</summary>

```json
{
  "id": "k2",
  "type": "set_var",
  "key": "call_key",
  "value": "{{recording.provider}}-{{vars.convo.key}}"
}
```

</details>

### 14. Add tag “stat-showed”

- Step id `o2`, type `set_tag`
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Next:
- always → step 17 (`o3`)

<details><summary>Full step definition</summary>

```json
{
  "id": "o2",
  "type": "set_tag",
  "tag": [
    "stat-showed"
  ]
}
```

</details>

### 15. Post the call review in Slack (the same call again edits it)

- Step id `s1`, type `slack_post`
- Engine description: Post to Slack (the calls channel)
- Goes to: channel {{slack.channel.calls}}; edits the earlier post; posted as "Sales call recorded"; remembered as recording:{{vars.convo.first.id}}
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Slack post:

```
*Name:* <https://app.gohighlevel.com/v2/location/{{crm.location_id}}/contacts/detail/{{contact.ghl_contact_id | default:}}|{{contact.name | default:Unknown}}>{{vars.recording_line}}
{{vars.appt_line}}
*Closer:* {{recording.closer.name | default:unknown}} · {{vars.convo.total_min | default:?}} min{{vars.parts_line}}

*Outcome:* {{vars.outcome.disposition | words | default:unclear}}
*Pain:* {{vars.notes.pain | bullets | default:—}}
*Goal:* {{vars.notes.desire | bullets | default:—}}
*Objections:* {{vars.notes.objections | bullets | default:none heard}}
*Next Steps:* {{vars.notes.next_step | default:—}} {{vars.notes.next_step_date | date_company:ccc LLL d | prefix:by}}
```

Next:
- always → step 18 (`s2`)

<details><summary>Full step definition</summary>

```json
{
  "id": "s1",
  "title": "Post the call review in Slack (the same call again edits it)",
  "type": "slack_post",
  "channel": "{{slack.channel.calls}}",
  "template": "*Name:* <https://app.gohighlevel.com/v2/location/{{crm.location_id}}/contacts/detail/{{contact.ghl_contact_id | default:}}|{{contact.name | default:Unknown}}>{{vars.recording_line}}\n{{vars.appt_line}}\n*Closer:* {{recording.closer.name | default:unknown}} · {{vars.convo.total_min | default:?}} min{{vars.parts_line}}\n\n*Outcome:* {{vars.outcome.disposition | words | default:unclear}}\n*Pain:* {{vars.notes.pain | bullets | default:—}}\n*Goal:* {{vars.notes.desire | bullets | default:—}}\n*Objections:* {{vars.notes.objections | bullets | default:none heard}}\n*Next Steps:* {{vars.notes.next_step | default:—}} {{vars.notes.next_step_date | date_company:ccc LLL d | prefix:by}}",
  "as": {
    "name": "Sales call recorded",
    "icon": [
      ":studio_microphone:",
      ":headphones:",
      ":movie_camera:",
      ":speech_balloon:"
    ]
  },
  "thread_only": false,
  "tag": "recording:{{vars.convo.first.id}}",
  "edit": true,
  "label": "mode"
}
```

</details>

### 16. Remember appt line = ⚠️ No appointment matched this recording — nothing marked showed. Check the contact's bookings.

- Step id `k4`, type `set_var`
- If it keeps failing: the run is held on this step (later steps read what it remembers)

Next:
- always → step 15 (`s1`)

<details><summary>Full step definition</summary>

```json
{
  "id": "k4",
  "type": "set_var",
  "key": "appt_line",
  "value": "⚠️ No appointment matched this recording — nothing marked showed. Check the contact's bookings."
}
```

</details>

### 17. Create or move pipeline card

- Step id `o3`, type `pipeline_card`
- Detail: In the setter board, stage Showed; marked won
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Next:
- always → step 19 (`o4`)

<details><summary>Full step definition</summary>

```json
{
  "id": "o3",
  "type": "pipeline_card",
  "pipeline": "{{crm.pipeline_setter}}",
  "stage": "{{crm.stage_setter_showed}}",
  "status": "won",
  "if_missing": "create",
  "pick": "open",
  "fields": []
}
```

</details>

### 18. Post scorecard in the thread

- Step id `s2`, type `slack_post`
- Engine description: Reply in the thread of that Slack post
- Goes to: channel {{slack.channel.calls}}; in the thread of s1; edits the earlier post; posted as "Call review"; remembered as scorecard:{{vars.convo.first.id}}
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Slack post:

```
*Scorecard:* {{vars.rubric.overall_score | default:?}}/10
{{vars.rubric | lines}}
```

Next:
- always → step 20 (`r1`)

<details><summary>Full step definition</summary>

```json
{
  "id": "s2",
  "title": "Post scorecard in the thread",
  "type": "slack_post",
  "channel": "{{slack.channel.calls}}",
  "template": "*Scorecard:* {{vars.rubric.overall_score | default:?}}/10\n{{vars.rubric | lines}}",
  "as": {
    "name": "Call review",
    "icon": [
      ":clipboard:",
      ":bar_chart:",
      ":mag:"
    ]
  },
  "thread_of": "s1",
  "thread_only": false,
  "tag": "scorecard:{{vars.convo.first.id}}",
  "edit": true,
  "label": "mode"
}
```

</details>

### 19. React ✅ on the booking post

- Step id `o4`, type `slack_post`
- Engine description: Reply in the thread of that Slack post
- Detail: reacts :white_check_mark: on it
- Goes to: channel {{slack.channel.bookings}}; in the thread of tag:appointment:{{appointment.id}}; thread only; edits the earlier post; posted as "Showed"; remembered as showed:{{appointment.id}}
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Slack post:

```
✅ Showed · {{vars.convo.total_min | default:?}} min{{vars.parts_line}} with {{recording.closer.name | default:the closer}}. The review is in the calls channel.
```

Next:
- always → step 21 (`k1`)

<details><summary>Full step definition</summary>

```json
{
  "id": "o4",
  "title": "React ✅ on the booking post",
  "type": "slack_post",
  "channel": "{{slack.channel.bookings}}",
  "template": "✅ Showed · {{vars.convo.total_min | default:?}} min{{vars.parts_line}} with {{recording.closer.name | default:the closer}}. The review is in the calls channel.",
  "as": {
    "name": "Showed",
    "icon": ":white_check_mark:"
  },
  "thread_of": "tag:appointment:{{appointment.id}}",
  "thread_only": true,
  "tag": "showed:{{appointment.id}}",
  "edit": true,
  "react": "white_check_mark",
  "label": "mode"
}
```

</details>

### 20. Write sales call record

- Step id `r1`, type `crm_record`
- Detail: Keyed by key for the Sales Call record; 17 fields; linked to 2 related records
- Runs only if: there is a key for the Sales Call record (otherwise skipped)
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Next:
- always → step 22 (`n1`)

<details><summary>Full step definition</summary>

```json
{
  "id": "r1",
  "only_if": {
    "exists": "vars.call_key"
  },
  "type": "crm_record",
  "object": "{{crm.object_sales_call | default:custom_objects.sales_call}}",
  "key": "{{vars.call_key}}",
  "properties": {
    "display_label": "{{contact.name | default:Unknown}} — {{recording.started_at | date_company:yyyy-MM-dd}}",
    "external_id": "{{vars.call_key}}",
    "contact_id": "{{contact.ghl_contact_id | default:}}",
    "opportunity_id": "{{cards.closer.id | default:}}",
    "scheduled_at": "{{appointment.starts_at | default:}}",
    "call_date": "{{recording.started_at | date_company:yyyy-MM-dd}}",
    "outcome": "{{picklist.sales_call_outcome.showed}}",
    "recording_url": "{{recording.share_url | default:}}",
    "transcript_ref": "{{recording.url | default:}}",
    "closer": "{{recording.closer.name | default: | option:sales_call_closer}}",
    "duration_min": "{{vars.convo.total_min | default:}}",
    "disposition": "{{vars.outcome.disposition | oneof:closed_won,follow_up,lost,dq,financing_denied,close_pending | default:}}",
    "objection_primary": "{{vars.notes.primary_objection | option:sales_call_objection | default:}}",
    "next_step": "{{vars.notes.next_step | default:}}",
    "next_step_date": "{{vars.notes.next_step_date | default:}}",
    "payment_terms": "{{vars.notes.payment_terms | default:}}",
    "setter": "{{contact.fields.setter | default:}}"
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

### 21. Remember call key = [this booking]

- Step id `k1`, type `set_var`
- If it keeps failing: the run is held on this step (later steps read what it remembers)

Next:
- always → step 23 (`k3`)

<details><summary>Full step definition</summary>

```json
{
  "id": "k1",
  "type": "set_var",
  "key": "call_key",
  "value": "{{appointment.slot_key}}"
}
```

</details>

### 22. Leave an internal note

- Step id `n1`, type `note`
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

CRM note:

```
CALL SUMMARY — {{recording.started_at | date_company:yyyy-MM-dd}}{{recording.closer.name | default:}}

{{vars.notes | lines}}

Call review: {{vars.rubric.overall_score | default:?}}/10
{{vars.rubric | lines}}

Recording: {{recording.share_url | default:—}}
```

Next:
- always → step 24 (`b_q`)

<details><summary>Full step definition</summary>

```json
{
  "id": "n1",
  "type": "note",
  "template": "CALL SUMMARY — {{recording.started_at | date_company:yyyy-MM-dd}}{{recording.closer.name | default:}}\n\n{{vars.notes | lines}}\n\nCall review: {{vars.rubric.overall_score | default:?}}/10\n{{vars.rubric | lines}}\n\nRecording: {{recording.share_url | default:—}}"
}
```

</details>

### 23. Remember appt line = *Appointment:* [call time] · marked showed

- Step id `k3`, type `set_var`
- If it keeps failing: the run is held on this step (later steps read what it remembers)

Next:
- always → step 15 (`s1`)

<details><summary>Full step definition</summary>

```json
{
  "id": "k3",
  "type": "set_var",
  "key": "appt_line",
  "value": "*Appointment:* {{appointment.starts_at | date_company}} · marked showed"
}
```

</details>

### 24. A closing call by phone with no booking?

- Step id `b_q`, type `branch`
- Engine description: Which way?
- If it keeps failing: the run is held on this step (it decides where the run goes)

Next:
- ask which booking (when this is a closing call Jev read and not (there is an appointment)) → step 25 (`l_opts`)
- linked, or a meeting recording → step 26 (`x1`)

<details><summary>Full step definition</summary>

```json
{
  "id": "b_q",
  "title": "A closing call by phone with no booking?",
  "type": "branch"
}
```

</details>

### 25. Their closing calls booked in the two weeks either side

- Step id `l_opts`, type `lookup`
- Engine description: Look up their bookings
- Detail: kind closing; status not cancelled; starts since [the call started] -14d; starts until [the call started] +14d; order starts at; saved as options for the steps after it (the engine's own question, read-only)
- If it keeps failing: the run is held on this step (step q_which reads what it looked up)

Next:
- always → step 27 (`q_which`)

<details><summary>Full step definition</summary>

```json
{
  "id": "l_opts",
  "title": "Their closing calls booked in the two weeks either side",
  "type": "lookup",
  "query": "appointments_for_contact",
  "params": {
    "kind": "closing",
    "status_not": "cancelled",
    "starts_since": "{{recording.started_at}} -14d",
    "starts_until": "{{recording.started_at}} +14d",
    "order": "starts_at"
  },
  "into": "options"
}
```

</details>

### 26. Done: recorded

- Step id `x1`, type `exit`

Next: the run ends here.

<details><summary>Full step definition</summary>

```json
{
  "id": "x1",
  "type": "exit",
  "reason": "recorded"
}
```

</details>

### 27. Ask which booking the call was

- Step id `q_which`, type `slack_post`
- Engine description: Post to Slack (the attention channel, else the ops channel, else the calls channel)
- Detail: offers :one: :two: :three: :x: for a person to tap
- Goes to: channel {{slack.channel.attention}}; falls back to {{slack.channel.ops}}, then {{slack.channel.calls}}; posted as "Which booking was this call?"; remembered as closing-which:{{vars.convo.first.id}}
- If it keeps failing: the run is held on this step (step w_which reads the post)

Slack post:

```
{{recording.closer.name | default:A closer}} had a {{vars.convo.total_min | default:?}}-minute closing call{{vars.parts_line}} by phone with <https://app.gohighlevel.com/v2/location/{{crm.location_id}}/contacts/detail/{{contact.ghl_contact_id | default:}}|{{contact.name | default:Unknown}}> ({{recording.started_at | date_company}}) that lines up with none of their bookings. Which booking was it?
{{vars.options.items | each:"{{number}}. {{item.starts_at | date_company}} with {{item.closer | default:no closer}} ({{item.status}})" | join:"\n" | default:They have no closing call booked in the two weeks around it.}}
Tap 1️⃣ 2️⃣ or 3️⃣ for that booking (the first three), or ❌ if it was none of them. Nothing is marked until someone does; the question closes in two days.
```

Next:
- always → step 28 (`w_which`)

<details><summary>Full step definition</summary>

```json
{
  "id": "q_which",
  "title": "Ask which booking the call was",
  "type": "slack_post",
  "channel": "{{slack.channel.attention}}",
  "fallback_channel": [
    "{{slack.channel.ops}}",
    "{{slack.channel.calls}}"
  ],
  "template": "{{recording.closer.name | default:A closer}} had a {{vars.convo.total_min | default:?}}-minute closing call{{vars.parts_line}} by phone with <https://app.gohighlevel.com/v2/location/{{crm.location_id}}/contacts/detail/{{contact.ghl_contact_id | default:}}|{{contact.name | default:Unknown}}> ({{recording.started_at | date_company}}) that lines up with none of their bookings. Which booking was it?\n{{vars.options.items | each:\"{{number}}. {{item.starts_at | date_company}} with {{item.closer | default:no closer}} ({{item.status}})\" | join:\"\\n\" | default:They have no closing call booked in the two weeks around it.}}\nTap 1️⃣ 2️⃣ or 3️⃣ for that booking (the first three), or ❌ if it was none of them. Nothing is marked until someone does; the question closes in two days.",
  "as": {
    "name": "Which booking was this call?",
    "icon": ":grey_question:"
  },
  "thread_only": false,
  "tag": "closing-which:{{vars.convo.first.id}}",
  "edit": false,
  "offer": [
    "one",
    "two",
    "three",
    "x"
  ],
  "label": "mode"
}
```

</details>

### 28. Wait two days for the tap

- Step id `w_which`, type `wait_for_reaction`
- Engine description: Wait for a reaction on that Slack post: :one: :two: :three: :x:
- Detail: Up to 2 days; continues the minute a team member taps one of them on that very message; any other reaction, or a tap on another post, changes nothing; silence continues with no decision
- Wait: Wait for one of one two three x on tag:closing-which:{{vars.convo.first.id}} for up to 2d
- If it keeps failing: the run is held on this step (the run waits on it; set on the step)

Next:
- always → step 29 (`v_pick`)

<details><summary>Full step definition</summary>

```json
{
  "id": "w_which",
  "title": "Wait two days for the tap",
  "blocking": true,
  "type": "wait_for_reaction",
  "of": "tag:closing-which:{{vars.convo.first.id}}",
  "emojis": [
    "one",
    "two",
    "three",
    "x"
  ],
  "timeout": "2d",
  "into": "reaction"
}
```

</details>

### 29. Remember chosen, picked by [the tap]

- Step id `v_pick`, type `set_var`
- Detail: one → [option 1]; two → [option 2]; three → [option 3]; otherwise 
- If it keeps failing: the run is held on this step (later steps read what it remembers)

Next:
- always → step 30 (`b_pick`)

<details><summary>Full step definition</summary>

```json
{
  "id": "v_pick",
  "type": "set_var",
  "key": "chosen",
  "value": "{{reaction.reaction | default:}}",
  "pick": {
    "one": "{{vars.options.items.0.id | default:}}",
    "two": "{{vars.options.items.1.id | default:}}",
    "three": "{{vars.options.items.2.id | default:}}"
  },
  "else_value": ""
}
```

</details>

### 30. Did someone pick a booking?

- Step id `b_pick`, type `branch`
- Engine description: Which way?
- If it keeps failing: the run is held on this step (it decides where the run goes)

Next:
- a booking was picked (when the booking the team picked is not blank) → step 31 (`rec_link`)
- none of them, or nobody answered → step 32 (`q_none`)

<details><summary>Full step definition</summary>

```json
{
  "id": "b_pick",
  "title": "Did someone pick a booking?",
  "type": "branch"
}
```

</details>

### 31. Link it: this workflow runs again on that booking (marks it showed, edits the review)

- Step id `rec_link`, type `record`
- Engine description: Record: Jev read a dialer call as a closing call
- Detail: An event in the ledger with recording id, external id, conversation, linked by, about [the booking the team picked]; it starts the workflows that listen for it (once)
- If it keeps failing: the run is held on this step (it is the run's own ledger)

Next:
- always → step 33 (`q_done`)

<details><summary>Full step definition</summary>

```json
{
  "id": "rec_link",
  "title": "Link it: this workflow runs again on that booking (marks it showed, edits the review)",
  "type": "record",
  "event": "call.closing",
  "data": {
    "recording_id": "{{recording.id}}",
    "external_id": "{{recording.external_id}}",
    "conversation": "{{vars.convo.key}}",
    "linked_by": "{{reaction.user_name | default:}}"
  },
  "appointment": "{{vars.chosen}}",
  "start": true
}
```

</details>

### 32. Say it stays unlinked, in the question's thread

- Step id `q_none`, type `slack_post`
- Engine description: Reply in the thread of that Slack post
- Detail: takes its own :one: :two: :three: :x: off the post once decided
- Goes to: channel {{slack.channel.attention}}; falls back to {{slack.channel.ops}}, then {{slack.channel.calls}}; in the thread of tag:closing-which:{{vars.convo.first.id}}; thread only; posted as "Which booking was this call?"
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Slack post:

```
{{reaction.user_name | prefix:Not linked: none of these, per | default:Nobody answered in two days, so nothing was linked}}.
```

Next:
- always → step 34 (`x_unlinked`)

<details><summary>Full step definition</summary>

```json
{
  "id": "q_none",
  "title": "Say it stays unlinked, in the question's thread",
  "type": "slack_post",
  "channel": "{{slack.channel.attention}}",
  "fallback_channel": [
    "{{slack.channel.ops}}",
    "{{slack.channel.calls}}"
  ],
  "template": "{{reaction.user_name | prefix:Not linked: none of these, per | default:Nobody answered in two days, so nothing was linked}}.",
  "as": {
    "name": "Which booking was this call?",
    "icon": ":grey_question:"
  },
  "thread_of": "tag:closing-which:{{vars.convo.first.id}}",
  "thread_only": true,
  "edit": false,
  "label": "mode",
  "unreact": {
    "of": "tag:closing-which:{{vars.convo.first.id}}",
    "emojis": [
      "one",
      "two",
      "three",
      "x"
    ]
  }
}
```

</details>

### 33. Say who linked it, in the question's thread

- Step id `q_done`, type `slack_post`
- Engine description: Reply in the thread of that Slack post
- Detail: takes its own :one: :two: :three: :x: off the post once decided
- Goes to: channel {{slack.channel.attention}}; falls back to {{slack.channel.ops}}, then {{slack.channel.calls}}; in the thread of tag:closing-which:{{vars.convo.first.id}}; thread only; posted as "Which booking was this call?"
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Slack post:

```
Linked to the booking, per {{reaction.user_name | default:the team}}; it is marked showed and the review is updated.
```

Next:
- always → step 35 (`x_linked`)

<details><summary>Full step definition</summary>

```json
{
  "id": "q_done",
  "title": "Say who linked it, in the question's thread",
  "type": "slack_post",
  "channel": "{{slack.channel.attention}}",
  "fallback_channel": [
    "{{slack.channel.ops}}",
    "{{slack.channel.calls}}"
  ],
  "template": "Linked to the booking, per {{reaction.user_name | default:the team}}; it is marked showed and the review is updated.",
  "as": {
    "name": "Which booking was this call?",
    "icon": ":grey_question:"
  },
  "thread_of": "tag:closing-which:{{vars.convo.first.id}}",
  "thread_only": true,
  "edit": false,
  "label": "mode",
  "unreact": {
    "of": "tag:closing-which:{{vars.convo.first.id}}",
    "emojis": [
      "one",
      "two",
      "three",
      "x"
    ]
  }
}
```

</details>

### 34. Stop: recorded unlinked

- Step id `x_unlinked`, type `exit`

Next: the run ends here.

<details><summary>Full step definition</summary>

```json
{
  "id": "x_unlinked",
  "type": "exit",
  "reason": "recorded_unlinked"
}
```

</details>

### 35. Stop: linked by the team

- Step id `x_linked`, type `exit`

Next: the run ends here.

<details><summary>Full step definition</summary>

```json
{
  "id": "x_linked",
  "type": "exit",
  "reason": "linked_by_the_team"
}
```

</details>

## Settings this workflow reads

| Key | Kind | Required to enable | Value |
| --- | --- | --- | --- |
| `crm.assoc_sales_call_contact` | id | yes | not read (repo) |
| `crm.assoc_sales_call_opportunity` | id | yes | not read (repo) |
| `crm.location_id` | id | yes | not read (repo) |
| `crm.object_sales_call` | id | no | not read (repo) |
| `crm.pipeline_setter` | id | yes | not read (repo) |
| `crm.stage_setter_showed` | id | yes | not read (repo) |
| `prompt.call_review` | text | yes | not read (repo) |
| `secret.anthropic_key` | secret | yes | not read (repo) |
| `slack.channel.attention` | channel | no | not read (repo) |
| `slack.channel.bookings` | channel | no | not read (repo) |
| `slack.channel.calls` | channel | no | not read (repo) |
| `slack.channel.ops` | channel | no | not read (repo) |

## Engine rules that apply but are not steps

These act on every run of this workflow from engine code. They are not in the definition above.

- **Mode.** The workflow's own mode, else the offer's, decides what is real: ghost writes and sends nothing, test is real only for test contacts, quiet writes the CRM but reaches no contact, live is real. (platform/src/engine/mode.ts:23, platform/src/engine/mode.ts:55)
- **Runs again?** A run's key is built from the re-entry policy; a second trigger with the same key starts nothing. A run that stops at a gate does not count. (platform/src/engine/reentry.ts:6)
- **Premise re-check.** Before each step the engine reads the CRM live; when "contact exists" no longer holds, the run exits. (platform/src/engine/runner.ts:33)
- **Failures.** Errors are sorted into transient, auth, permanent and unknown. A step is retried after 1 and 5 minutes; then a non-blocking step is skipped and a blocking one is held and looked at again after 15 minutes, then hourly. An auth or permanent failure pauses the run until it is fixed. (platform/src/engine/failures.ts:19, platform/src/engine/failures.ts:21, platform/src/engine/blocking.ts:58)
- **Step cap.** At most 50 steps run in one go; a run past that fails. After an outage, at most 20 sends per offer per tick. (platform/src/engine/runner.ts:21, platform/src/engine/runner.ts:27)
- **CRM writes** without a natural key (notes, tasks, cards, records) are claimed once per run and step so a retry never writes twice. In ghost mode they are skipped. (platform/src/engine/effects.ts:13)
- **Slack before live.** Until the workflow is live, every post goes to the offer's test channel with a ghost/test label, unless `slack.live` is set. (platform/src/engine/mode.ts:32, platform/src/engine/mode.ts:34)
- **Waits** are stored on the run (`runs.next_run_at`, `wake_on_*`), not held in memory; a reply, tap or event wakes the run at once. (platform/src/engine/runner.ts:56)
