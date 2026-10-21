# Payment recorded

Offer: **Dating (Nelly)** (`dating-nelly`). Source: live database. Generated 2026-10-21.

| Setting | Value |
| --- | --- |
| Where this definition came from | live: version 3, saved 2026-10-16T18:22:44.383Z (upgraded to template v14) |
| Template | `payment-recorded` v14 |
| Edited since copied from the template | no |
| Saved version | 3 |
| Enabled | off |
| Mode | follows the offer (quiet) |
| Send lock | locked: texts, emails, documents and webhooks reach only the operator's own addresses |
| Runs again for the same person | always |
| Re-checked before every step | contact exists |
| Send window | 08:00 to 20:00, the contact's time zone |
| Steps | 24 |

## Steps

Every step, in the order a run meets it from the trigger. Steps that only assemble words (`set_var`) are listed too.

### 1. Payment received

- Step id `t1`, type `trigger`

Next:
- always → step 3 (`v1`)

<details><summary>Full step definition</summary>

```json
{
  "id": "t1",
  "type": "trigger",
  "event": "payment.received"
}
```

</details>

### 2. Payment refunded

- Step id `t2`, type `trigger`

Next:
- always → step 3 (`v1`)

<details><summary>Full step definition</summary>

```json
{
  "id": "t2",
  "type": "trigger",
  "event": "payment.refunded"
}
```

</details>

### 3. Payment or refund: the words, the sign, the emoji

- Step id `v1`, type `set_var`
- Engine description: Remember pay, picked by [payment kind]
- Detail: refund → head Refund; line 💸 Refunded; note REFUND; sign −; react money_with_wings; status refunded; otherwise head Payment received; line 💵 Paid; note PAYMENT RECEIVED; sign blank; react dollar; status succeeded
- If it keeps failing: the run is held on this step (later steps read what it remembers)

Next:
- always → step 4 (`o_won`)

<details><summary>Full step definition</summary>

```json
{
  "id": "v1",
  "title": "Payment or refund: the words, the sign, the emoji",
  "type": "set_var",
  "key": "pay",
  "value": "{{event.kind}}",
  "pick": {
    "refund": {
      "head": "Refund",
      "line": "💸 Refunded",
      "note": "REFUND",
      "sign": "−",
      "react": "money_with_wings",
      "status": "refunded"
    }
  },
  "else_value": {
    "head": "Payment received",
    "line": "💵 Paid",
    "note": "PAYMENT RECEIVED",
    "sign": "",
    "react": "dollar",
    "status": "succeeded"
  }
}
```

</details>

### 4. Opportunity won on a payment beyond a deposit (D119: a deposit wins nothing; change the condition to win on paid in full, or move the step to Call outcome filed to win on the closer's answer)

- Step id `o_won`, type `update_opportunity`
- Engine description: Mark the opportunity won
- Detail: a change to won or lost is recorded as Deal won or Opportunity lost and starts the workflows that listen for it
- Runs only if: a payment and payment kind is not “deposit” (otherwise skipped)
- If it keeps failing: the run is held on this step (it is the run's own ledger)

Next:
- always → step 5 (`n1`)

<details><summary>Full step definition</summary>

```json
{
  "id": "o_won",
  "title": "Opportunity won on a payment beyond a deposit (D119: a deposit wins nothing; change the condition to win on paid in full, or move the step to Call outcome filed to win on the closer's answer)",
  "only_if": {
    "and": [
      {
        "eq": [
          "{{event._type}}",
          "payment.received"
        ]
      },
      {
        "neq": [
          "{{event.kind}}",
          "deposit"
        ]
      }
    ]
  },
  "type": "update_opportunity",
  "set": {},
  "status": "won",
  "from": [
    "open"
  ]
}
```

</details>

### 5. Update the contact in the CRM

- Step id `n1`, type `update_contact`
- Detail: cash collected = [running total]
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Next:
- always → step 6 (`n2`)

<details><summary>Full step definition</summary>

```json
{
  "id": "n1",
  "type": "update_contact",
  "set": {},
  "fields": [
    {
      "id": "{{crm.field_contact_cash_collected}}",
      "value": "{{event.running_total}}"
    }
  ],
  "clear": []
}
```

</details>

### 6. Which way?

- Step id `n2`, type `branch`
- If it keeps failing: the run is held on this step (it decides where the run goes)

Next:
- first payment beyond a deposit: stamp revenue (when not (there is a revenue generated) and payment kind is not a refund and payment kind is not “deposit”) → step 7 (`r1`)
- already stamped → step 8 (`n3`)

<details><summary>Full step definition</summary>

```json
{
  "id": "n2",
  "type": "branch"
}
```

</details>

### 7. Update the contact in the CRM

- Step id `r1`, type `update_contact`
- Detail: revenue generated = [program price]
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Next:
- always → step 8 (`n3`)

<details><summary>Full step definition</summary>

```json
{
  "id": "r1",
  "type": "update_contact",
  "set": {},
  "fields": [
    {
      "id": "{{crm.field_contact_revenue_generated}}",
      "value": "{{event.contract_value | default:}}"
    }
  ],
  "clear": []
}
```

</details>

### 8. Which way?

- Step id `n3`, type `branch`
- If it keeps failing: the run is held on this step (it decides where the run goes)

Next:
- refund: tags stay as the last payment left them (when payment kind is a refund) → step 9 (`g1`)
- deposit (when payment kind is “deposit”) → step 10 (`d1`)
- paid in full (when paid in full) → step 11 (`f1`)
- still owes → step 12 (`p1`)

<details><summary>Full step definition</summary>

```json
{
  "id": "n3",
  "type": "branch"
}
```

</details>

### 9. Tag pay-refunded (pay-paid-full / pay-plan-active stay as the last payment left them)

- Step id `g1`, type `tags`
- Engine description: Tags “+pay-refunded”
- Runs only if: payment kind is a refund (otherwise skipped)
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Next:
- always → step 13 (`n4`)

<details><summary>Full step definition</summary>

```json
{
  "id": "g1",
  "title": "Tag pay-refunded (pay-paid-full / pay-plan-active stay as the last payment left them)",
  "only_if": {
    "eq": [
      "{{event.kind}}",
      "refund"
    ]
  },
  "type": "tags",
  "add": [
    "pay-refunded"
  ]
}
```

</details>

### 10. Tag pay-deposit (a deposit is not a payment plan; the tag stays as a record that they paid one)

- Step id `d1`, type `tags`
- Engine description: Tags “+pay-deposit”
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Next:
- always → step 13 (`n4`)

<details><summary>Full step definition</summary>

```json
{
  "id": "d1",
  "title": "Tag pay-deposit (a deposit is not a payment plan; the tag stays as a record that they paid one)",
  "type": "tags",
  "add": [
    "pay-deposit"
  ]
}
```

</details>

### 11. Tags “+pay-paid-full” “−pay-plan-active”

- Step id `f1`, type `tags`
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Next:
- always → step 13 (`n4`)

<details><summary>Full step definition</summary>

```json
{
  "id": "f1",
  "type": "tags",
  "add": [
    "pay-paid-full"
  ],
  "remove": [
    "pay-plan-active"
  ]
}
```

</details>

### 12. Add tag “pay-plan-active”

- Step id `p1`, type `set_tag`
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Next:
- always → step 13 (`n4`)

<details><summary>Full step definition</summary>

```json
{
  "id": "p1",
  "type": "set_tag",
  "tag": [
    "pay-plan-active"
  ]
}
```

</details>

### 13. Write payment record

- Step id `n4`, type `crm_record`
- Detail: Keyed by transaction id; 11 fields; linked to 2 related records
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Next:
- always → step 14 (`a0`)

<details><summary>Full step definition</summary>

```json
{
  "id": "n4",
  "type": "crm_record",
  "object": "{{crm.object_payment | default:custom_objects.payment}}",
  "key": "{{event.provider_payment_id}}",
  "properties": {
    "type": "{{event.kind | oneof:deposit,balance,installment,paid_in_full,refund,chargeback}}",
    "amount": "{{event.amount}}",
    "closer": "{{cards.closer.owner.name | default:}}",
    "setter": "{{contact.fields.setter | default:}}",
    "status": "{{vars.pay.status | oneof:succeeded,failed,refunded,disputed,pending}}",
    "processor": "whop",
    "contact_id": "{{contact.ghl_contact_id | default:}}",
    "occurred_at": "{{event.paid_at}}",
    "display_label": "{{vars.pay.sign}}${{event.amount | abs}} · {{contact.name | default:Unknown}} · {{event.paid_at | date_company:yyyy-MM-dd}}",
    "opportunity_id": "{{cards.closer.id | default:}}",
    "transaction_id": "{{event.provider_payment_id}}"
  },
  "if_missing": "create",
  "relate": [
    {
      "association": "{{crm.assoc_payment_contact}}",
      "first": "{{contact.ghl_contact_id | default:}}",
      "second": "{{record.id}}"
    },
    {
      "association": "{{crm.assoc_payment_opportunity}}",
      "first": "{{record.id}}",
      "second": "{{cards.closer.id | default:}}"
    }
  ],
  "clear": []
}
```

</details>

### 14. Which way?

- Step id `a0`, type `branch`
- If it keeps failing: the run is held on this step (it decides where the run goes)

Next:
- first payment beyond a deposit, agreement not signed (when there are no prior non deposit total and they have not signed the agreement and not (payment kind is a refund or “deposit”)) → step 15 (`a1`)
- otherwise → step 16 (`m1`)

<details><summary>Full step definition</summary>

```json
{
  "id": "a0",
  "type": "branch"
}
```

</details>

### 15. Send the agreement template for signature

- Step id `a1`, type `send_document`
- Detail: From who the agreement is from; recorded in the agreements ledger; the poll reports when it is signed
- Goes to: the contact (from {{crm.agreement_sender | default:}})
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Document template:

```
{{crm.agreement_template}}
```

Document name:

```
Purchase agreement
```

Next:
- always → step 17 (`a2`)

<details><summary>Full step definition</summary>

```json
{
  "id": "a1",
  "type": "send_document",
  "template": "{{crm.agreement_template}}",
  "sender": "{{crm.agreement_sender | default:}}",
  "name": "Purchase agreement"
}
```

</details>

### 16. Leave an internal note

- Step id `m1`, type `note`
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

CRM note:

```
{{vars.pay.note}} — {{event.paid_at | date_company}} · {{vars.pay.sign}}${{event.amount | abs}} ({{event.kind}}) · collected {{event.running_total}} of {{event.contract_value | default:?}}
```

Next:
- always → step 18 (`b2`)

<details><summary>Full step definition</summary>

```json
{
  "id": "m1",
  "type": "note",
  "template": "{{vars.pay.note}} — {{event.paid_at | date_company}} · {{vars.pay.sign}}${{event.amount | abs}} ({{event.kind}}) · collected {{event.running_total}} of {{event.contract_value | default:?}}"
}
```

</details>

### 17. Add tag “stat-agreement-sent”

- Step id `a2`, type `set_tag`
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Next:
- always → step 19 (`a3`)

<details><summary>Full step definition</summary>

```json
{
  "id": "a2",
  "type": "set_tag",
  "tag": [
    "stat-agreement-sent"
  ]
}
```

</details>

### 18. Which way?

- Step id `b2`, type `branch`
- If it keeps failing: the run is held on this step (it decides where the run goes)

Next:
- has a Sales Call record (when there is a their Sales Call record) → step 20 (`r2`)
- no Sales Call record → step 21 (`n5`)

<details><summary>Full step definition</summary>

```json
{
  "id": "b2",
  "type": "branch"
}
```

</details>

### 19. Create or move pipeline card

- Step id `a3`, type `pipeline_card`
- Detail: In the closer board, stage Agreement Sent
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Next:
- always → step 16 (`m1`)

<details><summary>Full step definition</summary>

```json
{
  "id": "a3",
  "type": "pipeline_card",
  "pipeline": "{{crm.pipeline_closer}}",
  "stage": "{{crm.stage_closer_agreement_sent}}",
  "if_missing": "create",
  "pick": "open",
  "fields": []
}
```

</details>

### 20. Update sales call record

- Step id `r2`, type `crm_record`
- Detail: Keyed by their Sales Call record; 1 fields; only if the record already exists
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Next:
- always → step 21 (`n5`)

<details><summary>Full step definition</summary>

```json
{
  "id": "r2",
  "type": "crm_record",
  "object": "{{crm.object_sales_call | default:custom_objects.sales_call}}",
  "key": "{{records.sales_call.key}}",
  "properties": {
    "cash_collected": "{{event.running_total}}"
  },
  "if_missing": "skip",
  "relate": [],
  "clear": []
}
```

</details>

### 21. Post the payment or refund in Slack

- Step id `n5`, type `slack_post`
- Engine description: Post to Slack (the payments channel)
- Goes to: channel {{slack.channel.payments}}; posted as "{{vars.pay.head}}"
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Slack post:

```
*{{vars.pay.head}}:* {{vars.pay.sign}}${{event.amount | abs | money}}
*Name:* <https://app.gohighlevel.com/v2/location/{{crm.location_id}}/contacts/detail/{{contact.ghl_contact_id | default:}}|{{contact.name | default:Unknown}}>
*Closer:* {{contact.closer.name | default:unassigned}}{{contact.setter.name | line:*Setter:*}}
```

Next:
- always → step 22 (`p_book`)

<details><summary>Full step definition</summary>

```json
{
  "id": "n5",
  "title": "Post the payment or refund in Slack",
  "type": "slack_post",
  "channel": "{{slack.channel.payments}}",
  "template": "*{{vars.pay.head}}:* {{vars.pay.sign}}${{event.amount | abs | money}}\n*Name:* <https://app.gohighlevel.com/v2/location/{{crm.location_id}}/contacts/detail/{{contact.ghl_contact_id | default:}}|{{contact.name | default:Unknown}}>\n*Closer:* {{contact.closer.name | default:unassigned}}{{contact.setter.name | line:*Setter:*}}",
  "as": {
    "name": "{{vars.pay.head}}",
    "icon": [
      ":moneybag:",
      ":money_with_wings:",
      ":money_mouth_face:",
      ":dollar:",
      ":heavy_dollar_sign:"
    ]
  },
  "thread_only": false,
  "edit": false,
  "label": "mode"
}
```

</details>

### 22. React 💵 (💸 on a refund) on the booking post

- Step id `p_book`, type `slack_post`
- Engine description: Reply in the thread of that Slack post
- Detail: reacts pay react on it
- Goes to: channel {{slack.channel.bookings}}; in the thread of tag:appointment:{{contact.latest_appointment_id | default:}}; thread only; posted as "Payment"
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Slack post:

```
{{vars.pay.line}} ${{event.amount | abs | money}} {{event.kind | prefix:·}}. Details in the payments channel.
```

Next:
- always → step 23 (`p_rev`)

<details><summary>Full step definition</summary>

```json
{
  "id": "p_book",
  "title": "React 💵 (💸 on a refund) on the booking post",
  "type": "slack_post",
  "channel": "{{slack.channel.bookings}}",
  "template": "{{vars.pay.line}} ${{event.amount | abs | money}} {{event.kind | prefix:·}}. Details in the payments channel.",
  "as": {
    "name": "Payment",
    "icon": ":dollar:"
  },
  "thread_of": "tag:appointment:{{contact.latest_appointment_id | default:}}",
  "thread_only": true,
  "edit": false,
  "react": "{{vars.pay.react}}",
  "label": "mode"
}
```

</details>

### 23. React 💵 (💸 on a refund) on the call review

- Step id `p_rev`, type `slack_post`
- Engine description: Reply in the thread of that Slack post
- Detail: reacts pay react on it
- Goes to: channel {{slack.channel.calls}}; in the thread of tag:recording:{{contact.latest_recording_id | default:}}; thread only; posted as "Payment"
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Slack post:

```
{{vars.pay.line}} ${{event.amount | abs | money}} {{event.kind | prefix:·}}.
```

Next:
- always → step 24 (`x1`)

<details><summary>Full step definition</summary>

```json
{
  "id": "p_rev",
  "title": "React 💵 (💸 on a refund) on the call review",
  "type": "slack_post",
  "channel": "{{slack.channel.calls}}",
  "template": "{{vars.pay.line}} ${{event.amount | abs | money}} {{event.kind | prefix:·}}.",
  "as": {
    "name": "Payment",
    "icon": ":dollar:"
  },
  "thread_of": "tag:recording:{{contact.latest_recording_id | default:}}",
  "thread_only": true,
  "edit": false,
  "react": "{{vars.pay.react}}",
  "label": "mode"
}
```

</details>

### 24. Done: recorded

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

## Settings this workflow reads

| Key | Kind | Required to enable | Value |
| --- | --- | --- | --- |
| `crm.agreement_sender` | id | no | **unbound** |
| `crm.agreement_template` | id | yes | `6ad2fbb23f4568dd365afc30` |
| `crm.assoc_payment_contact` | id | yes | `6ad17a5f61b66da0c004ecc0` |
| `crm.assoc_payment_opportunity` | id | yes | `6ad17a5fdd7aac48df85df15` |
| `crm.field_contact_cash_collected` | id | yes | `Xlsk8E8iE5n7AnfXy40W` |
| `crm.field_contact_revenue_generated` | id | yes | `afj0RHT0sodPaate69mn` |
| `crm.location_id` | id | yes | `eLfhuKEaVMlrpLm2Fz8V` |
| `crm.object_payment` | id | no | `custom_objects.dating_payment` |
| `crm.object_sales_call` | id | no | `custom_objects.dating_sales_call` |
| `crm.pipeline_closer` | id | yes | `hLBo4MFsrGj7EjfDmkEn` |
| `crm.stage_closer_agreement_sent` | id | yes | `8233c8c5-f349-47cb-a599-975f978ec1e9` |
| `slack.channel.bookings` | channel | no | `C0C9Q7MEANT` |
| `slack.channel.calls` | channel | no | `C0CA0A5BTC5` |
| `slack.channel.payments` | channel | no | `C0CB00B0HC0` |

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
