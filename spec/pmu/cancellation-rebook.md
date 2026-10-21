# Cancellation rebook

Offer: **PMU** (`pmu`). Source: **from repo, may differ from live**. Generated 2026-10-21.

| Setting | Value |
| --- | --- |
| Where this definition came from | shipped template: platform/src/templates/cancellation-rebook.json (the offer's words, if any, are applied at install) |
| Template | `cancellation-rebook` |
| Edited since copied from the template | unknown (repo) |
| Saved version | unknown (repo) |
| Enabled | unknown (repo) |
| Mode | unknown (repo) |
| Send lock | unknown (repo) |
| Runs again for the same person | once_per_appointment |
| Re-checked before every step | appointment exists |
| Send window | the offer's (unknown in repo) |
| Steps | 4 |

## Steps

Every step, in the order a run meets it from the trigger. Steps that only assemble words (`set_var`) are listed too.

### 1. An appointment's status changed — new status is “cancelled” and call type is closing call and before start

- Step id `t1`, type `trigger`

Next:
- always → step 2 (`n1`)

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

### 2. Text the rebooking link

- Step id `n1`, type `send_sms`
- Engine description: Send text
- Goes to: the contact's phone (human)
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Text message:

```
Hey {{contact.first_name | default:there}}, saw the call got cancelled. If you want to pick a new time, here you go: {{calendar.closer_call.url}}
```

Next:
- always → step 3 (`n2`)

<details><summary>Full step definition</summary>

```json
{
  "id": "n1",
  "title": "Text the rebooking link",
  "type": "send_sms",
  "template": "Hey {{contact.first_name | default:there}}, saw the call got cancelled. If you want to pick a new time, here you go: {{calendar.closer_call.url}}",
  "kind": "human",
  "on_stale": "skip"
}
```

</details>

### 3. Send email: “Pick a new time?”

- Step id `n2`, type `send_email`
- Goes to: the contact's email (human)
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Email subject:

```
Pick a new time?
```

Email body:

```
<p>Hey {{contact.first_name | default:there}},</p><p>Saw the call got cancelled. No problem at all. If you'd like to pick a new time, here's the link: {{calendar.closer_call.url}}</p>
```

Next:
- always → step 4 (`x1`)

<details><summary>Full step definition</summary>

```json
{
  "id": "n2",
  "type": "send_email",
  "subject": "Pick a new time?",
  "template": "<p>Hey {{contact.first_name | default:there}},</p><p>Saw the call got cancelled. No problem at all. If you'd like to pick a new time, here's the link: {{calendar.closer_call.url}}</p>",
  "kind": "human",
  "on_stale": "skip"
}
```

</details>

### 4. Done: sent

- Step id `x1`, type `exit`

Next: the run ends here.

<details><summary>Full step definition</summary>

```json
{
  "id": "x1",
  "type": "exit",
  "reason": "sent"
}
```

</details>

## Settings this workflow reads

| Key | Kind | Required to enable | Value |
| --- | --- | --- | --- |
| `calendar.closer_call` | id | yes | not read (repo) |
| `crm.location_id` | id | yes | not read (repo) |

## Engine rules that apply but are not steps

These act on every run of this workflow from engine code. They are not in the definition above.

- **Mode.** The workflow's own mode, else the offer's, decides what is real: ghost writes and sends nothing, test is real only for test contacts, quiet writes the CRM but reaches no contact, live is real. (platform/src/engine/mode.ts:23, platform/src/engine/mode.ts:55)
- **Runs again?** A run's key is built from the re-entry policy; a second trigger with the same key starts nothing. A run that stops at a gate does not count. (platform/src/engine/reentry.ts:6)
- **Premise re-check.** Before each step the engine reads the CRM live; when "appointment exists" no longer holds, the run exits. (platform/src/engine/runner.ts:33)
- **Failures.** Errors are sorted into transient, auth, permanent and unknown. A step is retried after 1 and 5 minutes; then a non-blocking step is skipped and a blocking one is held and looked at again after 15 minutes, then hourly. An auth or permanent failure pauses the run until it is fixed. (platform/src/engine/failures.ts:19, platform/src/engine/failures.ts:21, platform/src/engine/blocking.ts:58)
- **Step cap.** At most 50 steps run in one go; a run past that fails. After an outage, at most 20 sends per offer per tick. (platform/src/engine/runner.ts:21, platform/src/engine/runner.ts:27)
- **Before any text or email goes out**, in this order: SMS switched on for the offer; timing still valid; the CRM's own template if named; the words rendered; the contact has the address; the mode holds it; already sent for this run and step (idempotency key run:step); already sent before a replay; Do Not Disturb; the send lock; then the CRM. A send the CRM did not clearly answer is never sent again. (platform/src/engine/executor.ts:170)
- **Send lock.** While locked, a text, email, document or webhook reaches a contact only when their live CRM phone or email is one of the operator's own. Changing any outbound step relocks the workflow. (platform/src/engine/send-lock.ts:27, platform/src/engine/send-lock.ts:97)
- **Send window.** A text or email due outside the offer's send window waits until it opens, in the contact's time zone; a transactional one may go at any hour when the offer allows it. (platform/src/engine/runner.ts:274)
