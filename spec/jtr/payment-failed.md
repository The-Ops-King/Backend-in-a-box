# Payment failed

Offer: **J. Tyler Ray** (`jtr`). Source: live database. Generated 2026-10-21.

| Setting | Value |
| --- | --- |
| Where this definition came from | live: version 1, saved 2026-10-06T14:56:54.830Z (installed from template) |
| Template | `payment-failed` v1 |
| Edited since copied from the template | no |
| Saved version | 1 |
| Enabled | off |
| Mode | follows the offer (ghost) |
| Send lock | locked: texts, emails, documents and webhooks reach only the operator's own addresses |
| Runs again for the same person | always |
| Re-checked before every step | contact exists |
| Send window | 08:00 to 20:00, the contact's time zone |
| Steps | 6 |

## Steps

Every step, in the order a run meets it from the trigger. Steps that only assemble words (`set_var`) are listed too.

### 1. Payment failed

- Step id `t1`, type `trigger`

Next:
- always → step 2 (`n1`)

<details><summary>Full step definition</summary>

```json
{
  "id": "t1",
  "type": "trigger",
  "event": "payment.failed"
}
```

</details>

### 2. Send text

- Step id `n1`, type `send_sms`
- Goes to: the contact's phone (human)
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Text message:

```
Hey {{contact.first_name}}, heads up, your payment didn't go through. Can you update your card when you get a sec? Reply here if you need a hand.
```

Next:
- always → step 3 (`n2`)

<details><summary>Full step definition</summary>

```json
{
  "id": "n1",
  "type": "send_sms",
  "template": "Hey {{contact.first_name}}, heads up, your payment didn't go through. Can you update your card when you get a sec? Reply here if you need a hand.",
  "kind": "human",
  "on_stale": "skip"
}
```

</details>

### 3. Send email: “Payment didn't go through”

- Step id `n2`, type `send_email`
- Goes to: the contact's email (human)
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Email subject:

```
Payment didn't go through
```

Email body:

```
<p>Hey {{contact.first_name}},</p><p>Your latest payment didn't go through. Usually it's an expired card. Can you update it when you get a chance? Reply to this email if you need help.</p><p>{{company.name}}</p>
```

Next:
- always → step 4 (`n3`)

<details><summary>Full step definition</summary>

```json
{
  "id": "n2",
  "type": "send_email",
  "subject": "Payment didn't go through",
  "template": "<p>Hey {{contact.first_name}},</p><p>Your latest payment didn't go through. Usually it's an expired card. Can you update it when you get a chance? Reply to this email if you need help.</p><p>{{company.name}}</p>",
  "kind": "human",
  "on_stale": "skip"
}
```

</details>

### 4. Wait 2 days

- Step id `n3`, type `wait`
- Detail: Company's time zone
- Wait: Wait 2 days (time zone: company)
- If it keeps failing: the run is held on this step (the run waits on it)

Next:
- always → step 5 (`n4`)

<details><summary>Full step definition</summary>

```json
{
  "id": "n3",
  "type": "wait",
  "rule": {
    "anchor": "now",
    "offset": "+2d",
    "tz": "company"
  }
}
```

</details>

### 5. Post to Slack (the owner channel)

- Step id `n4`, type `slack_post`
- Goes to: channel {{slack.channel.owner}}
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Slack post:

```
{{contact.first_name}}'s payment failed two days ago and hasn't been fixed.
```

Next:
- always → step 6 (`x1`)

<details><summary>Full step definition</summary>

```json
{
  "id": "n4",
  "type": "slack_post",
  "channel": "{{slack.channel.owner}}",
  "template": "{{contact.first_name}}'s payment failed two days ago and hasn't been fixed.",
  "thread_only": false,
  "edit": false,
  "label": "mode"
}
```

</details>

### 6. Done: escalated to the owner

- Step id `x1`, type `exit`

Next: the run ends here.

<details><summary>Full step definition</summary>

```json
{
  "id": "x1",
  "type": "exit",
  "reason": "escalated"
}
```

</details>

## Settings this workflow reads

| Key | Kind | Required to enable | Value |
| --- | --- | --- | --- |
| `crm.location_id` | id | yes | `RHOfV4fFknN54YQobyWp` |
| `slack.channel.owner` | channel | no | **unbound** |

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
