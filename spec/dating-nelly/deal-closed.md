# Deal closed

Offer: **Dating (Nelly)** (`dating-nelly`). Source: **from repo, may differ from live**. Generated 2026-10-21.

| Setting | Value |
| --- | --- |
| Where this definition came from | playbook copy: platform/installs/dating-nelly/deal-closed.json |
| Template | `deal-closed` |
| Edited since copied from the template | unknown (repo) |
| Saved version | unknown (repo) |
| Enabled | unknown (repo) |
| Mode | follows the offer (quiet) |
| Send lock | unknown (repo) |
| Runs again for the same person | once_per_contact |
| Re-checked before every step | contact exists |
| Send window | the offer's (unknown in repo) |
| Steps | 13 |
| Note | dating-nelly: the welcome email and text are the company's own (installs/dating-nelly/words.json); still placeholders, so both are skipped, not Hair's (D118); the won closer card carries the deal's value (D130) |

## Steps

Every step, in the order a run meets it from the trigger. Steps that only assemble words (`set_var`) are listed too.

### 1. Payment received

- Step id `t1`, type `trigger`

Next:
- always → step 3 (`c1`)

<details><summary>Full step definition</summary>

```json
{
  "id": "t1",
  "type": "trigger",
  "event": "payment.received"
}
```

</details>

### 2. Agreement signed

- Step id `t2`, type `trigger`

Next:
- always → step 3 (`c1`)

<details><summary>Full step definition</summary>

```json
{
  "id": "t2",
  "type": "trigger",
  "event": "agreement.signed"
}
```

</details>

### 3. Paid beyond a deposit and signed, and not a customer yet (D119: a deposit alone, even signed, is not a close)

- Step id `c1`, type `check`
- Engine description: Check contact paid non deposit and they have signed the agreement and tags do not include “stat customer”
- Detail: Otherwise the run stops: not yet
- If it keeps failing: the run is held on this step (it decides whether the run goes on)

Next:
- always → step 4 (`g1`)

<details><summary>Full step definition</summary>

```json
{
  "id": "c1",
  "title": "Paid beyond a deposit and signed, and not a customer yet (D119: a deposit alone, even signed, is not a close)",
  "type": "check",
  "when": {
    "and": [
      {
        "eq": [
          "{{contact.paid_non_deposit}}",
          true
        ]
      },
      {
        "eq": [
          "{{contact.agreement_signed}}",
          true
        ]
      },
      {
        "not": {
          "has": [
            "{{contact.tags}}",
            "stat-customer"
          ]
        }
      }
    ]
  },
  "else_exit": "not_yet"
}
```

</details>

### 4. Add tag “stat-customer”

- Step id `g1`, type `set_tag`
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Next:
- always → step 5 (`p1`)

<details><summary>Full step definition</summary>

```json
{
  "id": "g1",
  "type": "set_tag",
  "tag": [
    "stat-customer"
  ]
}
```

</details>

### 5. Create or move pipeline card

- Step id `p1`, type `pipeline_card`
- Detail: In the closer board, stage Closed Won; marked won; value [the deal value]
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Next:
- always → step 6 (`p2`)

<details><summary>Full step definition</summary>

```json
{
  "id": "p1",
  "type": "pipeline_card",
  "pipeline": "{{crm.pipeline_closer}}",
  "stage": "{{crm.stage_closer_closed_won}}",
  "status": "won",
  "if_missing": "create",
  "pick": "open",
  "fields": [],
  "value": "{{contact.revenue}}"
}
```

</details>

### 6. Update the setter card

- Step id `p2`, type `pipeline_card`
- Detail: Card stays where it is; marked won
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Next:
- always → step 7 (`b1`)

<details><summary>Full step definition</summary>

```json
{
  "id": "p2",
  "type": "pipeline_card",
  "pipeline": "{{crm.pipeline_setter}}",
  "status": "won",
  "if_missing": "create",
  "pick": "open",
  "fields": []
}
```

</details>

### 7. Which way?

- Step id `b1`, type `branch`
- If it keeps failing: the run is held on this step (it decides where the run goes)

Next:
- has a Sales Call record (when there is a their Sales Call record) → step 8 (`r1`)
- no Sales Call record → step 9 (`e1`)

<details><summary>Full step definition</summary>

```json
{
  "id": "b1",
  "type": "branch"
}
```

</details>

### 8. Update sales call record

- Step id `r1`, type `crm_record`
- Detail: Keyed by their Sales Call record; 3 fields; only if the record already exists
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Next:
- always → step 9 (`e1`)

<details><summary>Full step definition</summary>

```json
{
  "id": "r1",
  "type": "crm_record",
  "object": "{{crm.object_sales_call | default:custom_objects.sales_call}}",
  "key": "{{records.sales_call.key}}",
  "properties": {
    "disposition": "closed_won",
    "outcome": "{{picklist.sales_call_outcome.showed}}",
    "cash_collected": "{{contact.cash_collected}}"
  },
  "if_missing": "skip",
  "relate": [],
  "clear": []
}
```

</details>

### 9. Welcome email [placeholder: the words are not written yet, so it is skipped]

- Step id `e1`, type `send_email`
- Engine description: Send email: “[placeholder — welcome email subject]”
- Detail: Automated receipt: may go out in dark hours if the company allows it
- Runs only if: there is a welcome copy written (otherwise skipped)
- Goes to: the contact's email (transactional)
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Email subject:

```
[placeholder — welcome email subject]
```

Email body:

```
<p>Hi {{contact.first_name | default:there}},</p><p>[placeholder — Dating Nelly's welcome email: what happens next, to come from Tyler]</p>
```

Next:
- always → step 10 (`e2`)

<details><summary>Full step definition</summary>

```json
{
  "id": "e1",
  "title": "Welcome email [placeholder: the words are not written yet, so it is skipped]",
  "only_if": {
    "exists": "vars.welcome_copy_written"
  },
  "type": "send_email",
  "subject": "[placeholder — welcome email subject]",
  "template": "<p>Hi {{contact.first_name | default:there}},</p><p>[placeholder — Dating Nelly's welcome email: what happens next, to come from Tyler]</p>",
  "kind": "transactional",
  "on_stale": "skip"
}
```

</details>

### 10. Welcome text [placeholder: the words are not written yet, so it is skipped]

- Step id `e2`, type `send_sms`
- Engine description: Send text (automated receipt, may go out in dark hours)
- Runs only if: there is a welcome copy written (otherwise skipped)
- Goes to: the contact's phone (transactional)
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Text message:

```
[placeholder — Dating Nelly's welcome text, to come from Tyler]
```

Next:
- always → step 11 (`a1`)

<details><summary>Full step definition</summary>

```json
{
  "id": "e2",
  "title": "Welcome text [placeholder: the words are not written yet, so it is skipped]",
  "only_if": {
    "exists": "vars.welcome_copy_written"
  },
  "type": "send_sms",
  "template": "[placeholder — Dating Nelly's welcome text, to come from Tyler]",
  "kind": "transactional",
  "on_stale": "skip"
}
```

</details>

### 11. AI writes from closer and more with the “close cheer” prompt

- Step id `a1`, type `analyze`
- Detail: Answer saved as cheer; skipped quietly when the AI cannot run
- If it keeps failing: after its tries it is skipped and the run goes on (optional: the steps after it go on without its answer)

AI prompt:

```
{{prompt.close_cheer}}
```

AI input:

```
Closer: {{contact.closer.name | default:the closer}}
Client first name: {{contact.first_name | default:the client}}
Cash collected: ${{contact.cash_collected | money}}
Deal value: ${{contact.revenue | money | default:unknown}}
Days from first booking to payment: {{contact.days_to_close | default:unknown}}
Lead source: {{contact.source | default:unknown}}
```

Next:
- always → step 12 (`s1`)

<details><summary>Full step definition</summary>

```json
{
  "id": "a1",
  "type": "analyze",
  "prompt": "{{prompt.close_cheer}}",
  "input": "Closer: {{contact.closer.name | default:the closer}}\nClient first name: {{contact.first_name | default:the client}}\nCash collected: ${{contact.cash_collected | money}}\nDeal value: ${{contact.revenue | money | default:unknown}}\nDays from first booking to payment: {{contact.days_to_close | default:unknown}}\nLead source: {{contact.source | default:unknown}}",
  "into": "cheer",
  "format": "text",
  "max_tokens": 80,
  "optional": true
}
```

</details>

### 12. Post the win in Slack

- Step id `s1`, type `slack_post`
- Engine description: Post to Slack (the deals channel)
- Goes to: channel {{slack.channel.deals}}; posted as "NEW CLOSE"
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Slack post:

```
*NEW CLOSE!* Well done {{contact.closer.mention | default:team}}!
*Name:* <https://app.gohighlevel.com/v2/location/{{crm.location_id}}/contacts/detail/{{contact.ghl_contact_id | default:}}|{{contact.name | default:Unknown}}>{{contact.setter.mention | line:*Setter:*}}
*Cash Collected:* ${{contact.cash_collected | money}}
*Revenue Generated:* ${{contact.revenue | money | default:—}}

*First Booking:* {{contact.first_booked_at | date_company:ccc LLL d | default:—}}
*Days to Close:* {{contact.days_to_close | default:—}}

*Source:* {{contact.source | default:—}}{{vars.cheer | line:}}
```

Next:
- always → step 13 (`x1`)

<details><summary>Full step definition</summary>

```json
{
  "id": "s1",
  "title": "Post the win in Slack",
  "type": "slack_post",
  "channel": "{{slack.channel.deals}}",
  "template": "*NEW CLOSE!* Well done {{contact.closer.mention | default:team}}!\n*Name:* <https://app.gohighlevel.com/v2/location/{{crm.location_id}}/contacts/detail/{{contact.ghl_contact_id | default:}}|{{contact.name | default:Unknown}}>{{contact.setter.mention | line:*Setter:*}}\n*Cash Collected:* ${{contact.cash_collected | money}}\n*Revenue Generated:* ${{contact.revenue | money | default:—}}\n\n*First Booking:* {{contact.first_booked_at | date_company:ccc LLL d | default:—}}\n*Days to Close:* {{contact.days_to_close | default:—}}\n\n*Source:* {{contact.source | default:—}}{{vars.cheer | line:}}",
  "as": {
    "name": "NEW CLOSE",
    "icon": [
      ":tada:",
      ":boom:",
      ":partying_face:",
      ":bomb:",
      ":mirror_ball:",
      ":man_dancing:",
      ":dancer:",
      ":fire:",
      ":rocket:",
      ":champagne:"
    ]
  },
  "thread_only": false,
  "edit": false,
  "label": "mode"
}
```

</details>

### 13. Stop: closed

- Step id `x1`, type `exit`

Next: the run ends here.

<details><summary>Full step definition</summary>

```json
{
  "id": "x1",
  "type": "exit",
  "reason": "closed"
}
```

</details>

## Settings this workflow reads

| Key | Kind | Required to enable | Value |
| --- | --- | --- | --- |
| `crm.location_id` | id | yes | not read (repo) |
| `crm.object_sales_call` | id | no | not read (repo) |
| `crm.pipeline_closer` | id | yes | not read (repo) |
| `crm.pipeline_setter` | id | yes | not read (repo) |
| `crm.stage_closer_closed_won` | id | yes | not read (repo) |
| `prompt.close_cheer` | text | yes | not read (repo) |
| `secret.anthropic_key` | secret | yes | not read (repo) |
| `slack.channel.deals` | channel | no | not read (repo) |

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
- **Slack before live.** Until the workflow is live, every post goes to the offer's test channel with a ghost/test label, unless `slack.live` is set. (platform/src/engine/mode.ts:32, platform/src/engine/mode.ts:34)
