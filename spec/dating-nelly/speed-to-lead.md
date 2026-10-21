# Speed to lead

Offer: **Dating (Nelly)** (`dating-nelly`). Source: **from repo, may differ from live**. Generated 2026-10-21.

| Setting | Value |
| --- | --- |
| Where this definition came from | shipped template: platform/src/templates/speed-to-lead.json (the offer's words, if any, are applied at install) |
| Template | `speed-to-lead` |
| Edited since copied from the template | unknown (repo) |
| Saved version | unknown (repo) |
| Enabled | unknown (repo) |
| Mode | follows the offer (quiet) |
| Send lock | unknown (repo) |
| Runs again for the same person | once_per_contact |
| Re-checked before every step | contact exists |
| Send window | the offer's (unknown in repo) |
| Steps | 12 |

## Steps

Every step, in the order a run meets it from the trigger. Steps that only assemble words (`set_var`) are listed too.

### 1. A new lead is added in GHL

- Step id `t1`, type `trigger`

Next:
- always → step 2 (`v_late`)

<details><summary>Full step definition</summary>

```json
{
  "id": "t1",
  "type": "trigger",
  "event": "lead.created"
}
```

</details>

### 2. Too late for a first text after this many minutes

- Step id `v_late`, type `set_var`
- Engine description: Remember late after min = 60
- If it keeps failing: the run is held on this step (later steps read what it remembers)

Next:
- always → step 3 (`b_late`)

<details><summary>Full step definition</summary>

```json
{
  "id": "v_late",
  "title": "Too late for a first text after this many minutes",
  "type": "set_var",
  "key": "late_after_min",
  "value": 60
}
```

</details>

### 3. Did the engine see this lead in time?

- Step id `b_late`, type `branch`
- Engine description: Which way?
- If it keeps failing: the run is held on this step (it decides where the run goes)

Next:
- in time (when minutes late is at most 60) → step 4 (`n1`)
- too late → step 5 (`s_late`)

<details><summary>Full step definition</summary>

```json
{
  "id": "b_late",
  "title": "Did the engine see this lead in time?",
  "type": "branch"
}
```

</details>

### 4. Send email: “Got your info”

- Step id `n1`, type `send_email`
- Goes to: the contact's email (human)
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Email subject:

```
Got your info
```

Email body:

```
<p>Hey {{contact.first_name | default:there}},</p><p>Thanks for reaching out. The easiest next step is a quick call so we can see if this is a fit. Grab a time here: {{calendar.booking.url}}</p><p>Talk soon,<br>{{company.name}}</p>
```

Next:
- always → step 6 (`n2`)

<details><summary>Full step definition</summary>

```json
{
  "id": "n1",
  "type": "send_email",
  "subject": "Got your info",
  "template": "<p>Hey {{contact.first_name | default:there}},</p><p>Thanks for reaching out. The easiest next step is a quick call so we can see if this is a fit. Grab a time here: {{calendar.booking.url}}</p><p>Talk soon,<br>{{company.name}}</p>",
  "kind": "human",
  "on_stale": "skip"
}
```

</details>

### 5. Tell the team to follow up by hand

- Step id `s_late`, type `slack_post`
- Engine description: Post to Slack (the ops channel, else the alerts channel)
- Goes to: channel {{slack.channel.ops}}; falls back to {{slack.channel.alerts}}
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Slack post:

```
<https://app.gohighlevel.com/v2/location/{{crm.location_id}}/contacts/detail/{{contact.ghl_contact_id | default:}}|{{contact.name | default:A new lead}}> came into GHL {{event.minutes_late}} minutes before the engine saw them, so no first text or email went out. Can someone follow up by hand?
```

Next:
- always → step 7 (`x_late`)

<details><summary>Full step definition</summary>

```json
{
  "id": "s_late",
  "title": "Tell the team to follow up by hand",
  "type": "slack_post",
  "channel": "{{slack.channel.ops}}",
  "fallback_channel": "{{slack.channel.alerts}}",
  "template": "<https://app.gohighlevel.com/v2/location/{{crm.location_id}}/contacts/detail/{{contact.ghl_contact_id | default:}}|{{contact.name | default:A new lead}}> came into GHL {{event.minutes_late}} minutes before the engine saw them, so no first text or email went out. Can someone follow up by hand?",
  "thread_only": false,
  "edit": false,
  "label": "mode"
}
```

</details>

### 6. First-touch text

- Step id `n2`, type `send_sms`
- Engine description: Send text
- Goes to: the contact's phone (human)
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Text message:

```
Hey {{contact.first_name | default:there}}, it's {{company.name}}. Got your info, thanks. Want to grab a time to talk? {{calendar.booking.url}}
```

Next:
- always → step 8 (`n3`)

<details><summary>Full step definition</summary>

```json
{
  "id": "n2",
  "title": "First-touch text",
  "type": "send_sms",
  "template": "Hey {{contact.first_name | default:there}}, it's {{company.name}}. Got your info, thanks. Want to grab a time to talk? {{calendar.booking.url}}",
  "kind": "human",
  "on_stale": "skip"
}
```

</details>

### 7. Stop: late

- Step id `x_late`, type `exit`

Next: the run ends here.

<details><summary>Full step definition</summary>

```json
{
  "id": "x_late",
  "type": "exit",
  "reason": "late"
}
```

</details>

### 8. Wait for a reply

- Step id `n3`, type `wait_for_reply`
- Detail: Up to 2 hours; continues the minute one arrives
- Wait: Wait for a reply on any for up to 2h; after the first reply, wait 90s for the rest
- If it keeps failing: the run is held on this step (the run waits on it)

Next:
- no reply in time → step 9 (`c1`)
- they replied → step 10 (`x1`)

<details><summary>Full step definition</summary>

```json
{
  "id": "n3",
  "type": "wait_for_reply",
  "timeout": "2h",
  "channel": "any",
  "settle": "90s"
}
```

</details>

### 9. Still nothing booked?

- Step id `c1`, type `check`
- Engine description: Check a closing call is not on their calendar
- Detail: Otherwise the run ends: booking recorded
- If it keeps failing: the run is held on this step (it decides whether the run goes on)

Next:
- always → step 11 (`n5`)

<details><summary>Full step definition</summary>

```json
{
  "id": "c1",
  "title": "Still nothing booked?",
  "type": "check",
  "when": {
    "eq": [
      "{{contact.has_upcoming_call}}",
      false
    ]
  },
  "else_exit": "booked"
}
```

</details>

### 10. Done: they replied

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

### 11. Send email: “Still want to talk?”

- Step id `n5`, type `send_email`
- Goes to: the contact's email (human)
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Email subject:

```
Still want to talk?
```

Email body:

```
<p>Hey {{contact.first_name | default:there}}, following up in case this got buried. If you still want to talk, here's the link: {{calendar.booking.url}}</p><p>If not, no worries.</p>
```

Next:
- always → step 12 (`x2`)

<details><summary>Full step definition</summary>

```json
{
  "id": "n5",
  "type": "send_email",
  "subject": "Still want to talk?",
  "template": "<p>Hey {{contact.first_name | default:there}}, following up in case this got buried. If you still want to talk, here's the link: {{calendar.booking.url}}</p><p>If not, no worries.</p>",
  "kind": "human",
  "on_stale": "skip"
}
```

</details>

### 12. Done: no reply

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
| `calendar.booking` | id | yes | not read (repo) |
| `crm.location_id` | id | yes | not read (repo) |
| `slack.channel.alerts` | channel | no | not read (repo) |
| `slack.channel.ops` | channel | no | not read (repo) |

## Engine rules that apply but are not steps

These act on every run of this workflow from engine code. They are not in the definition above.

- **Mode.** The workflow's own mode, else the offer's, decides what is real: ghost writes and sends nothing, test is real only for test contacts, quiet writes the CRM but reaches no contact, live is real. (platform/src/engine/mode.ts:23, platform/src/engine/mode.ts:55)
- **Runs again?** A run's key is built from the re-entry policy; a second trigger with the same key starts nothing. A run that stops at a gate does not count. (platform/src/engine/reentry.ts:6)
- **Premise re-check.** Before each step the engine reads the CRM live; when "contact exists" no longer holds, the run exits. (platform/src/engine/runner.ts:33)
- **Failures.** Errors are sorted into transient, auth, permanent and unknown. A step is retried after 1 and 5 minutes; then a non-blocking step is skipped and a blocking one is held and looked at again after 15 minutes, then hourly. An auth or permanent failure pauses the run until it is fixed. (platform/src/engine/failures.ts:19, platform/src/engine/failures.ts:21, platform/src/engine/blocking.ts:58)
- **Step cap.** At most 50 steps run in one go; a run past that fails. After an outage, at most 20 sends per offer per tick. (platform/src/engine/runner.ts:21, platform/src/engine/runner.ts:27)
- **Before any text or email goes out**, in this order: SMS switched on for the offer; timing still valid; the CRM's own template if named; the words rendered; the contact has the address; the mode holds it; already sent for this run and step (idempotency key run:step); already sent before a replay; Do Not Disturb; the send lock; then the CRM. A send the CRM did not clearly answer is never sent again. (platform/src/engine/executor.ts:170)
- **Send lock.** While locked, a text, email, document or webhook reaches a contact only when their live CRM phone or email is one of the operator's own. Changing any outbound step relocks the workflow. (platform/src/engine/send-lock.ts:27, platform/src/engine/send-lock.ts:97)
- **Send window.** A text or email due outside the offer's send window waits until it opens, in the contact's time zone; a transactional one may go at any hour when the offer allows it. (platform/src/engine/runner.ts:274)
- **Slack before live.** Until the workflow is live, every post goes to the offer's test channel with a ghost/test label, unless `slack.live` is set. (platform/src/engine/mode.ts:32, platform/src/engine/mode.ts:34)
- **Waits** are stored on the run (`runs.next_run_at`, `wake_on_*`), not held in memory; a reply, tap or event wakes the run at once. (platform/src/engine/runner.ts:56)
