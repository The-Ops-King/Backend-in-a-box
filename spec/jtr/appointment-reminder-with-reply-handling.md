# Appointment reminder with reply handling

Offer: **J. Tyler Ray** (`jtr`). Source: live database. Generated 2026-10-21.

| Setting | Value |
| --- | --- |
| Where this definition came from | live: version 1, saved 2026-10-06T14:56:54.830Z (installed from template) |
| Template | `appointment-reminder` v1 |
| Edited since copied from the template | no |
| Saved version | 1 |
| Enabled | off |
| Mode | follows the offer (ghost) |
| Send lock | locked: texts, emails, documents and webhooks reach only the operator's own addresses |
| Runs again for the same person | once_per_appointment |
| Re-checked before every step | appointment in future |
| Send window | 08:00 to 20:00, the contact's time zone |
| Steps | 18 |

## Steps

Every step, in the order a run meets it from the trigger. Steps that only assemble words (`set_var`) are listed too.

### 1. Appointment booked — call type is closing call

- Step id `t1`, type `trigger`

Next:
- always → step 2 (`n1`)

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

### 2. Wait until 8:00 AM the day of the call

- Step id `n1`, type `wait`
- Detail: Contact's time zone (if that is less than 2 hours away, use 7:00 PM the day before the call instead)
- Wait: Wait until 8:00 AM the day of the call (time zone: contact; if less than 2h away, day_before@19:00 instead)
- If it keeps failing: the run is held on this step (the run waits on it)

Next:
- always → step 3 (`n2`)

<details><summary>Full step definition</summary>

```json
{
  "id": "n1",
  "type": "wait",
  "rule": {
    "anchor": "appointment.starts_at",
    "offset": "day_of@08:00",
    "tz": "contact",
    "guard": {
      "min_lead": "2h",
      "fallback": "day_before@19:00"
    }
  }
}
```

</details>

### 3. Send text

- Step id `n2`, type `send_sms`
- Detail: Only if at least 15 minutes before the call; otherwise skip it
- Goes to: the contact's phone (human)
- Timing check: before event, at least 15m before; when stale: skip
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Text message:

```
Hey {{contact.first_name}}, your call with {{appointment.closer.first_name}} is {{appointment.starts_at | relative:auto}}. Reply YES to confirm or let me know if you need to move it.
```

Next:
- always → step 4 (`n3`)

<details><summary>Full step definition</summary>

```json
{
  "id": "n2",
  "type": "send_sms",
  "template": "Hey {{contact.first_name}}, your call with {{appointment.closer.first_name}} is {{appointment.starts_at | relative:auto}}. Reply YES to confirm or let me know if you need to move it.",
  "kind": "human",
  "validity": {
    "anchor": "before_event",
    "min_lead": "15m"
  },
  "on_stale": "skip"
}
```

</details>

### 4. Wait for a text reply

- Step id `n3`, type `wait_for_reply`
- Detail: Up to 4 hours; continues the minute one arrives
- Wait: Wait for a reply on sms for up to 4h; after the first reply, wait 90s for the rest
- If it keeps failing: the run is held on this step (the run waits on it)

Next:
- they replied → step 5 (`n5`)
- no reply in time → step 6 (`x5`)

<details><summary>Full step definition</summary>

```json
{
  "id": "n3",
  "type": "wait_for_reply",
  "timeout": "4h",
  "channel": "sms",
  "settle": "90s"
}
```

</details>

### 5. Jev reads the reply

- Step id `n5`, type `classify`
- Detail: Decides between the reply intent options; below 80% sure, or a reply a careful person would doubt, goes to a person
- If it keeps failing: the run is held on this step (step n6 reads the reply)

What it reads:

```
{{reply.last_inbound.body}}
```

What we sent (context):

```
{{reply.last_outbound.body | default:}}
```

Next:
- always → step 7 (`n6`)

<details><summary>Full step definition</summary>

```json
{
  "id": "n5",
  "type": "classify",
  "input": "{{reply.last_inbound.body}}",
  "state": "{{reply.last_outbound.body | default:}}",
  "domain": "reply_intent",
  "threshold": 0.8,
  "into": "reply.intent",
  "ambiguity_max": 0.8
}
```

</details>

### 6. Done: no reply

- Step id `x5`, type `exit`

Next: the run ends here.

<details><summary>Full step definition</summary>

```json
{
  "id": "x5",
  "type": "exit",
  "reason": "no_reply"
}
```

</details>

### 7. Which way?

- Step id `n6`, type `branch`
- If it keeps failing: the run is held on this step (it decides where the run goes)

Next:
- the reply is “confirmed” → step 8 (`n7`)
- the reply is “cancelled” → step 9 (`n8`)
- the reply is a reschedule request → step 10 (`n10`)
- otherwise → step 11 (`n11`)

<details><summary>Full step definition</summary>

```json
{
  "id": "n6",
  "type": "branch"
}
```

</details>

### 8. Add tag “confirmed”

- Step id `n7`, type `set_tag`
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Next:
- always → step 12 (`x1`)

<details><summary>Full step definition</summary>

```json
{
  "id": "n7",
  "type": "set_tag",
  "tag": "confirmed"
}
```

</details>

### 9. Mark appointment status → “cancelled”

- Step id `n8`, type `update_appointment`
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Next:
- always → step 13 (`n9`)

<details><summary>Full step definition</summary>

```json
{
  "id": "n8",
  "type": "update_appointment",
  "set": {
    "status": "cancelled"
  }
}
```

</details>

### 10. Send text

- Step id `n10`, type `send_sms`
- Goes to: the contact's phone (human)
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Text message:

```
No problem — grab a new time here: {{calendar.closer_call.url}}
```

Next:
- always → step 14 (`x3`)

<details><summary>Full step definition</summary>

```json
{
  "id": "n10",
  "type": "send_sms",
  "template": "No problem — grab a new time here: {{calendar.closer_call.url}}",
  "kind": "human",
  "on_stale": "skip"
}
```

</details>

### 11. Add tag “needs-human-reply”

- Step id `n11`, type `set_tag`
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Next:
- always → step 15 (`n12`)

<details><summary>Full step definition</summary>

```json
{
  "id": "n11",
  "type": "set_tag",
  "tag": "needs-human-reply"
}
```

</details>

### 12. Done: confirmed

- Step id `x1`, type `exit`

Next: the run ends here.

<details><summary>Full step definition</summary>

```json
{
  "id": "x1",
  "type": "exit",
  "reason": "confirmed"
}
```

</details>

### 13. Post to Slack (the closers channel)

- Step id `n9`, type `slack_post`
- Goes to: channel {{slack.channel.closers}}
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Slack post:

```
{{contact.first_name}} cancelled their call {{appointment.starts_at | relative:auto}}.
```

Next:
- always → step 16 (`x2`)

<details><summary>Full step definition</summary>

```json
{
  "id": "n9",
  "type": "slack_post",
  "channel": "{{slack.channel.closers}}",
  "template": "{{contact.first_name}} cancelled their call {{appointment.starts_at | relative:auto}}.",
  "thread_only": false,
  "edit": false,
  "label": "mode"
}
```

</details>

### 14. Done: reschedule link sent

- Step id `x3`, type `exit`

Next: the run ends here.

<details><summary>Full step definition</summary>

```json
{
  "id": "x3",
  "type": "exit",
  "reason": "reschedule_sent"
}
```

</details>

### 15. Leave an internal note

- Step id `n12`, type `note`
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

CRM note:

```
[engine] Couldn't classify reply (top guesses: {{reply.top_guesses}}). Needs a human.
Original: {{reply.last_inbound.body}}
```

Next:
- always → step 17 (`n13`)

<details><summary>Full step definition</summary>

```json
{
  "id": "n12",
  "type": "note",
  "template": "[engine] Couldn't classify reply (top guesses: {{reply.top_guesses}}). Needs a human.\nOriginal: {{reply.last_inbound.body}}"
}
```

</details>

### 16. Done: cancelled

- Step id `x2`, type `exit`

Next: the run ends here.

<details><summary>Full step definition</summary>

```json
{
  "id": "x2",
  "type": "exit",
  "reason": "cancelled"
}
```

</details>

### 17. Pause the contact's other workflows

- Step id `n13`, type `pause_runs`
- If it keeps failing: the run is held on this step (it stops the person's other runs)

Next:
- always → step 18 (`x4`)

<details><summary>Full step definition</summary>

```json
{
  "id": "n13",
  "type": "pause_runs",
  "scope": "contact"
}
```

</details>

### 18. Stop: handed to a human

- Step id `x4`, type `exit`

Next: the run ends here.

<details><summary>Full step definition</summary>

```json
{
  "id": "x4",
  "type": "exit",
  "reason": "handed_to_human"
}
```

</details>

## Settings this workflow reads

| Key | Kind | Required to enable | Value |
| --- | --- | --- | --- |
| `calendar.closer_call` | id | yes | `GLWzPNAZPoxkROdFJbPH` |
| `crm.location_id` | id | yes | `RHOfV4fFknN54YQobyWp` |
| `slack.channel.closers` | channel | no | **unbound** |

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
