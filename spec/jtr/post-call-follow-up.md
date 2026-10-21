# Post-call follow-up

Offer: **J. Tyler Ray** (`jtr`). Source: live database. Generated 2026-10-21.

| Setting | Value |
| --- | --- |
| Where this definition came from | live: version 1, saved 2026-10-06T14:56:54.830Z (installed from template) |
| Template | `post-call-follow-up` v1 |
| Edited since copied from the template | no |
| Saved version | 1 |
| Enabled | off |
| Mode | follows the offer (ghost) |
| Send lock | locked: texts, emails, documents and webhooks reach only the operator's own addresses |
| Runs again for the same person | once_per_appointment |
| Re-checked before every step | contact exists |
| Send window | 08:00 to 20:00, the contact's time zone |
| Steps | 4 |

## Steps

Every step, in the order a run meets it from the trigger. Steps that only assemble words (`set_var`) are listed too.

### 1. The call happened — outcome is follow up

- Step id `t1`, type `trigger`

Next:
- always → step 2 (`n1`)

<details><summary>Full step definition</summary>

```json
{
  "id": "t1",
  "type": "trigger",
  "event": "call.held",
  "match": {
    "eq": [
      "{{event.outcome}}",
      "follow_up"
    ]
  }
}
```

</details>

### 2. Wait until 9:00 AM the next day

- Step id `n1`, type `wait`
- Detail: Contact's time zone
- Wait: Wait until 9:00 AM the next day (time zone: contact)
- If it keeps failing: the run is held on this step (the run waits on it)

Next:
- always → step 3 (`n2`)

<details><summary>Full step definition</summary>

```json
{
  "id": "n1",
  "type": "wait",
  "rule": {
    "anchor": "now",
    "offset": "day_after@09:00",
    "tz": "contact"
  }
}
```

</details>

### 3. Send text

- Step id `n2`, type `send_sms`
- Goes to: the contact's phone (human)
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Text message:

```
Hey {{contact.first_name}}, good talking yesterday. If any questions came up overnight, send them over, happy to answer.
```

Next:
- always → step 4 (`x1`)

<details><summary>Full step definition</summary>

```json
{
  "id": "n2",
  "type": "send_sms",
  "template": "Hey {{contact.first_name}}, good talking yesterday. If any questions came up overnight, send them over, happy to answer.",
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
| `crm.location_id` | id | yes | `RHOfV4fFknN54YQobyWp` |

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
- **Waits** are stored on the run (`runs.next_run_at`, `wake_on_*`), not held in memory; a reply, tap or event wakes the run at once. (platform/src/engine/runner.ts:56)
