# No-show recovery

Offer: **Save Your Hair (Parungao)** (`hair`). Source: live database. Generated 2026-10-21.

| Setting | Value |
| --- | --- |
| Where this definition came from | live: version 4, saved 2026-10-10T01:33:49.802Z (upgraded to template v4) |
| Template | `no-show-recovery` v4 |
| Edited since copied from the template | no |
| Saved version | 4 |
| Enabled | off |
| Mode | follows the offer (test) |
| Send lock | locked: texts, emails, documents and webhooks reach only the operator's own addresses |
| Runs again for the same person | once_per_appointment |
| Re-checked before every step | appointment exists |
| Send window | 08:00 to 20:00, the contact's time zone; transactional messages may go at any hour |
| Steps | 11 |

## Steps

Every step, in the order a run meets it from the trigger. Steps that only assemble words (`set_var`) are listed too.

### 1. An appointment's status changed — new status is no-show

- Step id `t1`, type `trigger`

Next:
- always → step 3 (`n1`)

<details><summary>Full step definition</summary>

```json
{
  "id": "t1",
  "type": "trigger",
  "event": "appointment.status_changed",
  "match": {
    "eq": [
      "{{event.status.to}}",
      "noshow"
    ]
  }
}
```

</details>

### 2. The call's outcome is filed — outcome is no-show

- Step id `t2`, type `trigger`

Next:
- always → step 3 (`n1`)

<details><summary>Full step definition</summary>

```json
{
  "id": "t2",
  "type": "trigger",
  "event": "appointment.outcome",
  "match": {
    "eq": [
      "{{event.outcome}}",
      "noshow"
    ]
  }
}
```

</details>

### 3. Wait 10 minutes

- Step id `n1`, type `wait`
- Detail: Contact's time zone
- Wait: Wait 10 minutes (time zone: contact)
- If it keeps failing: the run is held on this step (the run waits on it)

Next:
- always → step 4 (`c1`)

<details><summary>Full step definition</summary>

```json
{
  "id": "n1",
  "type": "wait",
  "rule": {
    "anchor": "now",
    "offset": "+10m",
    "tz": "contact"
  }
}
```

</details>

### 4. Still no new call booked?

- Step id `c1`, type `check`
- Engine description: Check a closing call is not on their calendar
- Detail: Otherwise the run ends: they booked a new call
- If it keeps failing: the run is held on this step (it decides whether the run goes on)

Next:
- always → step 5 (`n2`)

<details><summary>Full step definition</summary>

```json
{
  "id": "c1",
  "title": "Still no new call booked?",
  "type": "check",
  "when": {
    "eq": [
      "{{contact.has_upcoming_call}}",
      false
    ]
  },
  "else_exit": "rebooked"
}
```

</details>

### 5. Text the rebooking link

- Step id `n2`, type `send_sms`
- Engine description: Send text
- Goes to: the contact's phone (human)
- Timing check: after event, at most 3d after; when stale: skip
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Text message:

```
Hey {{contact.first_name | default:there}}, looks like we missed each other. Here's the link to grab a new time with {{appointment.closer.first_name}}: {{calendar.closer_call.url}}
```

Next:
- always → step 6 (`n3`)

<details><summary>Full step definition</summary>

```json
{
  "id": "n2",
  "title": "Text the rebooking link",
  "type": "send_sms",
  "template": "Hey {{contact.first_name | default:there}}, looks like we missed each other. Here's the link to grab a new time with {{appointment.closer.first_name}}: {{calendar.closer_call.url}}",
  "kind": "human",
  "validity": {
    "anchor": "after_event",
    "max_lag": "3d"
  },
  "on_stale": "skip"
}
```

</details>

### 6. Send email: “We missed you”

- Step id `n3`, type `send_email`
- Goes to: the contact's email (human)
- Timing check: after event, at most 3d after; when stale: skip
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Email subject:

```
We missed you
```

Email body:

```
<p>Hey {{contact.first_name | default:there}},</p><p>Looks like we missed each other for the call with {{appointment.closer.first_name}}. Things come up. If you still want to talk, pick a new time here: {{calendar.closer_call.url}}</p>
```

Next:
- always → step 7 (`n4`)

<details><summary>Full step definition</summary>

```json
{
  "id": "n3",
  "type": "send_email",
  "subject": "We missed you",
  "template": "<p>Hey {{contact.first_name | default:there}},</p><p>Looks like we missed each other for the call with {{appointment.closer.first_name}}. Things come up. If you still want to talk, pick a new time here: {{calendar.closer_call.url}}</p>",
  "kind": "human",
  "validity": {
    "anchor": "after_event",
    "max_lag": "3d"
  },
  "on_stale": "skip"
}
```

</details>

### 7. Wait for a reply

- Step id `n4`, type `wait_for_reply`
- Detail: Up to 24 hours; continues the minute one arrives
- Wait: Wait for a reply on any for up to 24h; after the first reply, wait 90s for the rest
- If it keeps failing: the run is held on this step (the run waits on it)

Next:
- no reply in time → step 8 (`c2`)
- they replied → step 9 (`x1`)

<details><summary>Full step definition</summary>

```json
{
  "id": "n4",
  "type": "wait_for_reply",
  "timeout": "24h",
  "channel": "any",
  "settle": "90s"
}
```

</details>

### 8. Still no new call booked?

- Step id `c2`, type `check`
- Engine description: Check a closing call is not on their calendar
- Detail: Otherwise the run ends: they booked a new call
- If it keeps failing: the run is held on this step (it decides whether the run goes on)

Next:
- always → step 10 (`n6`)

<details><summary>Full step definition</summary>

```json
{
  "id": "c2",
  "title": "Still no new call booked?",
  "type": "check",
  "when": {
    "eq": [
      "{{contact.has_upcoming_call}}",
      false
    ]
  },
  "else_exit": "rebooked"
}
```

</details>

### 9. Done: they replied

- Step id `x1`, type `exit`

Next: the run ends here.

<details><summary>Full step definition</summary>

```json
{
  "id": "x1",
  "type": "exit",
  "reason": "replied"
}
```

</details>

### 10. Send email: “Want to reschedule?”

- Step id `n6`, type `send_email`
- Goes to: the contact's email (human)
- Timing check: after event, at most 7d after; when stale: skip
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Email subject:

```
Want to reschedule?
```

Email body:

```
<p>Hey {{contact.first_name | default:there}}, one more nudge on this. If you'd like to reschedule, the link is here: {{calendar.closer_call.url}}</p><p>If the timing isn't right anymore, that's fine too.</p>
```

Next:
- always → step 11 (`x2`)

<details><summary>Full step definition</summary>

```json
{
  "id": "n6",
  "type": "send_email",
  "subject": "Want to reschedule?",
  "template": "<p>Hey {{contact.first_name | default:there}}, one more nudge on this. If you'd like to reschedule, the link is here: {{calendar.closer_call.url}}</p><p>If the timing isn't right anymore, that's fine too.</p>",
  "kind": "human",
  "validity": {
    "anchor": "after_event",
    "max_lag": "7d"
  },
  "on_stale": "skip"
}
```

</details>

### 11. Done: no reply

- Step id `x2`, type `exit`

Next: the run ends here.

<details><summary>Full step definition</summary>

```json
{
  "id": "x2",
  "type": "exit",
  "reason": "no_reply"
}
```

</details>

## Settings this workflow reads

| Key | Kind | Required to enable | Value |
| --- | --- | --- | --- |
| `calendar.closer_call` | id | yes | `c46086b5-f63f-423b-b568-7dd5d69119c2` |
| `crm.location_id` | id | yes | `WUtLNZJFg8QbFWyQhlH1` |

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
- **Waits** are stored on the run (`runs.next_run_at`, `wake_on_*`), not held in memory; a reply, tap or event wakes the run at once. (platform/src/engine/runner.ts:56)
