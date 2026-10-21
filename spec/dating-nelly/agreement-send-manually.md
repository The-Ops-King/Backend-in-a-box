# Send agreement manually

Offer: **Dating (Nelly)** (`dating-nelly`). Source: **from repo, may differ from live**. Generated 2026-10-21.

| Setting | Value |
| --- | --- |
| Where this definition came from | shipped template: platform/src/templates/agreement-send-manually.json (the offer's words, if any, are applied at install) |
| Template | `agreement-send-manually` |
| Edited since copied from the template | unknown (repo) |
| Saved version | unknown (repo) |
| Enabled | unknown (repo) |
| Mode | follows the offer (quiet) |
| Send lock | unknown (repo) |
| Runs again for the same person | always |
| Re-checked before every step | contact exists |
| Send window | the offer's (unknown in repo) |
| Steps | 11 |

## Steps

Every step, in the order a run meets it from the trigger. Steps that only assemble words (`set_var`) are listed too.

### 1. Tag added — tag is “sys send agreement manually”

- Step id `t1`, type `trigger`

Next:
- always → step 3 (`c1`)

<details><summary>Full step definition</summary>

```json
{
  "id": "t1",
  "type": "trigger",
  "event": "tag.added",
  "match": {
    "eq": [
      "{{event.tag}}",
      "sys-send-agreement-manually"
    ]
  }
}
```

</details>

### 2. agreement requested

- Step id `t2`, type `trigger`

Next:
- always → step 3 (`c1`)

<details><summary>Full step definition</summary>

```json
{
  "id": "t2",
  "type": "trigger",
  "event": "agreement.requested"
}
```

</details>

### 3. Check they have not signed the agreement

- Step id `c1`, type `check`
- Detail: Otherwise the run stops: already signed
- If it keeps failing: the run is held on this step (it decides whether the run goes on)

Next:
- always → step 4 (`v_tpl`)

<details><summary>Full step definition</summary>

```json
{
  "id": "c1",
  "type": "check",
  "when": {
    "eq": [
      "{{contact.agreement_signed}}",
      false
    ]
  },
  "else_exit": "already_signed"
}
```

</details>

### 4. Which agreement: the one picked in Slack, else the offer's

- Step id `v_tpl`, type `set_var`
- Engine description: Remember agreement template = [template]
- Detail: When there is a template; otherwise [the agreement template]
- If it keeps failing: the run is held on this step (later steps read what it remembers)

Next:
- always → step 5 (`v_from`)

<details><summary>Full step definition</summary>

```json
{
  "id": "v_tpl",
  "title": "Which agreement: the one picked in Slack, else the offer's",
  "type": "set_var",
  "key": "agreement_template",
  "value": "{{event.template}}",
  "when": {
    "exists": "event.template"
  },
  "else_value": "{{crm.agreement_template}}"
}
```

</details>

### 5. From the closer who asked, else the bound sender

- Step id `v_from`, type `set_var`
- Engine description: Remember agreement sender = [sender]
- Detail: When there is a sender; otherwise [who the agreement is from]
- If it keeps failing: the run is held on this step (later steps read what it remembers)

Next:
- always → step 6 (`v_name`)

<details><summary>Full step definition</summary>

```json
{
  "id": "v_from",
  "title": "From the closer who asked, else the bound sender",
  "type": "set_var",
  "key": "agreement_sender",
  "value": "{{event.sender}}",
  "when": {
    "exists": "event.sender"
  },
  "else_value": "{{crm.agreement_sender | default:}}"
}
```

</details>

### 6. Its name

- Step id `v_name`, type `set_var`
- Engine description: Remember agreement name = [label]
- Detail: When there is a label; otherwise Purchase agreement
- If it keeps failing: the run is held on this step (later steps read what it remembers)

Next:
- always → step 7 (`v_by`)

<details><summary>Full step definition</summary>

```json
{
  "id": "v_name",
  "title": "Its name",
  "type": "set_var",
  "key": "agreement_name",
  "value": "{{event.label}}",
  "when": {
    "exists": "event.label"
  },
  "else_value": "Purchase agreement"
}
```

</details>

### 7. Who sent it, for the note

- Step id `v_by`, type `set_var`
- Engine description: Remember sent by = sent from Slack by [by name]
- Detail: When there is a by name; otherwise sent manually from [the contact's owner]
- If it keeps failing: the run is held on this step (later steps read what it remembers)

Next:
- always → step 8 (`d1`)

<details><summary>Full step definition</summary>

```json
{
  "id": "v_by",
  "title": "Who sent it, for the note",
  "type": "set_var",
  "key": "sent_by",
  "value": "sent from Slack by {{event.by_name}}",
  "when": {
    "exists": "event.by_name"
  },
  "else_value": "sent manually from {{contact.owner.name | default:the team}}"
}
```

</details>

### 8. Send agreement template for signature

- Step id `d1`, type `send_document`
- Detail: From agreement sender; recorded in the agreements ledger; the poll reports when it is signed
- Goes to: the contact (from {{vars.agreement_sender}})
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Document template:

```
{{vars.agreement_template}}
```

Document name:

```
{{vars.agreement_name}}
```

Next:
- always → step 9 (`g1`)

<details><summary>Full step definition</summary>

```json
{
  "id": "d1",
  "type": "send_document",
  "template": "{{vars.agreement_template}}",
  "sender": "{{vars.agreement_sender}}",
  "name": "{{vars.agreement_name}}"
}
```

</details>

### 9. Tags “+stat-agreement-sent” “−sys-send-agreement-manually”

- Step id `g1`, type `tags`
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Next:
- always → step 10 (`m1`)

<details><summary>Full step definition</summary>

```json
{
  "id": "g1",
  "type": "tags",
  "add": [
    "stat-agreement-sent"
  ],
  "remove": [
    "sys-send-agreement-manually"
  ]
}
```

</details>

### 10. Leave an internal note

- Step id `m1`, type `note`
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

CRM note:

```
AGREEMENT SENT — {{now | date_company}} · {{vars.agreement_name}} · {{vars.sent_by}}
```

Next:
- always → step 11 (`x1`)

<details><summary>Full step definition</summary>

```json
{
  "id": "m1",
  "type": "note",
  "template": "AGREEMENT SENT — {{now | date_company}} · {{vars.agreement_name}} · {{vars.sent_by}}"
}
```

</details>

### 11. Done: sent

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
| `crm.agreement_sender` | id | no | not read (repo) |
| `crm.agreement_template` | id | yes | not read (repo) |
| `crm.location_id` | id | yes | not read (repo) |

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
