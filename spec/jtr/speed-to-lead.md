# Speed to lead

Offer: **J. Tyler Ray** (`jtr`). Source: live database. Generated 2026-10-21.

| Setting | Value |
| --- | --- |
| Where this definition came from | live: version 1, saved 2026-10-06T14:56:54.830Z (installed from template) |
| Template | `speed-to-lead` v1 |
| Edited since copied from the template | no |
| Saved version | 1 |
| Enabled | off |
| Mode | follows the offer (ghost) |
| Send lock | locked: texts, emails, documents and webhooks reach only the operator's own addresses |
| Runs again for the same person | once_per_contact |
| Re-checked before every step | contact exists |
| Send window | 08:00 to 20:00, the contact's time zone |
| Steps | 8 |

## Steps

Every step, in the order a run meets it from the trigger. Steps that only assemble words (`set_var`) are listed too.

### 1. A new lead is added in GHL

- Step id `t1`, type `trigger`

Next:
- always → step 2 (`n1`)

<details><summary>Full step definition</summary>

```json
{
  "id": "t1",
  "type": "trigger",
  "event": "lead.created"
}
```

</details>

### 2. Send email: “Got your info”

- Step id `n1`, type `send_email`
- Goes to: the contact's email (human)
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Email subject:

```
Got your info
```

Email body:

```
<p>Hey {{contact.first_name}},</p><p>Thanks for reaching out. The easiest next step is a quick call so we can see if this is a fit. Grab a time here: {{calendar.booking.url}}</p><p>Talk soon,<br>{{company.name}}</p>
```

Next:
- always → step 3 (`n2`)

<details><summary>Full step definition</summary>

```json
{
  "id": "n1",
  "type": "send_email",
  "subject": "Got your info",
  "template": "<p>Hey {{contact.first_name}},</p><p>Thanks for reaching out. The easiest next step is a quick call so we can see if this is a fit. Grab a time here: {{calendar.booking.url}}</p><p>Talk soon,<br>{{company.name}}</p>",
  "kind": "human",
  "on_stale": "skip"
}
```

</details>

### 3. Send text

- Step id `n2`, type `send_sms`
- Goes to: the contact's phone (human)
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Text message:

```
Hey {{contact.first_name}}, it's {{company.name}}. Got your info, thanks. Want to grab a time to talk? {{calendar.booking.url}}
```

Next:
- always → step 4 (`n3`)

<details><summary>Full step definition</summary>

```json
{
  "id": "n2",
  "type": "send_sms",
  "template": "Hey {{contact.first_name}}, it's {{company.name}}. Got your info, thanks. Want to grab a time to talk? {{calendar.booking.url}}",
  "kind": "human",
  "on_stale": "skip"
}
```

</details>

### 4. Wait for a reply

- Step id `n3`, type `wait_for_reply`
- Detail: Up to 2 hours; continues the minute one arrives
- Wait: Wait for a reply on any for up to 2h; after the first reply, wait 90s for the rest
- If it keeps failing: the run is held on this step (the run waits on it)

Next:
- they replied → step 5 (`n4`)
- no reply in time → step 6 (`n5`)

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

### 5. Add tag “engaged”

- Step id `n4`, type `set_tag`
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Next:
- always → step 7 (`x1`)

<details><summary>Full step definition</summary>

```json
{
  "id": "n4",
  "type": "set_tag",
  "tag": "engaged"
}
```

</details>

### 6. Send email: “Still want to talk?”

- Step id `n5`, type `send_email`
- Goes to: the contact's email (human)
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Email subject:

```
Still want to talk?
```

Email body:

```
<p>Hey {{contact.first_name}}, following up in case this got buried. If you still want to talk, here's the link: {{calendar.booking.url}}</p><p>If not, no worries.</p>
```

Next:
- always → step 8 (`x2`)

<details><summary>Full step definition</summary>

```json
{
  "id": "n5",
  "type": "send_email",
  "subject": "Still want to talk?",
  "template": "<p>Hey {{contact.first_name}}, following up in case this got buried. If you still want to talk, here's the link: {{calendar.booking.url}}</p><p>If not, no worries.</p>",
  "kind": "human",
  "on_stale": "skip"
}
```

</details>

### 7. Done: they replied

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

### 8. Done: no reply

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
| `calendar.booking` | id | yes | `kbEwrOhdlzxAHIpNLqF7` |
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
- **CRM writes** without a natural key (notes, tasks, cards, records) are claimed once per run and step so a retry never writes twice. In ghost mode they are skipped. (platform/src/engine/effects.ts:13)
- **Waits** are stored on the run (`runs.next_run_at`, `wake_on_*`), not held in memory; a reply, tap or event wakes the run at once. (platform/src/engine/runner.ts:56)
