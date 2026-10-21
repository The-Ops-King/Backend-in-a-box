# Unlinked payment

Offer: **PMU** (`pmu`). Source: **from repo, may differ from live**. Generated 2026-10-21.

| Setting | Value |
| --- | --- |
| Where this definition came from | shipped template: platform/src/templates/payment-unlinked.json (the offer's words, if any, are applied at install) |
| Template | `payment-unlinked` |
| Edited since copied from the template | unknown (repo) |
| Saved version | unknown (repo) |
| Enabled | unknown (repo) |
| Mode | unknown (repo) |
| Send lock | unknown (repo) |
| Runs again for the same person | always |
| Re-checked before every step | nothing |
| Send window | the offer's (unknown in repo) |
| Steps | 3 |

## Steps

Every step, in the order a run meets it from the trigger. Steps that only assemble words (`set_var`) are listed too.

### 1. A payment matched nobody

- Step id `t1`, type `trigger`

Next:
- always → step 2 (`n1`)

<details><summary>Full step definition</summary>

```json
{
  "id": "t1",
  "type": "trigger",
  "event": "payment.unlinked"
}
```

</details>

### 2. Tell the team a payment matched nobody

- Step id `n1`, type `slack_post`
- Engine description: Post to Slack (the alerts channel, else the bookings channel)
- Detail: with the button “Link to a contact”
- Goes to: channel {{slack.channel.alerts}}; falls back to {{slack.channel.bookings}}
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Slack post:

```
*Unlinked payment* · ${{event.amount | abs | fixed:2}} {{event.status}}
Nobody in the CRM matched this buyer.
*Email:* {{event.customer_email | default:—}} · *Phone:* {{event.customer_phone | default:—}} · *Whop member:* {{event.whop_member_id | default:—}}
Link it: {{company.base_url}}/c/{{company.slug}}/payments
```

Button "Link to a contact" (link_payment, value):

```
{{event.payment_id}}
```

Next:
- always → step 3 (`x1`)

<details><summary>Full step definition</summary>

```json
{
  "id": "n1",
  "title": "Tell the team a payment matched nobody",
  "type": "slack_post",
  "channel": "{{slack.channel.alerts}}",
  "fallback_channel": "{{slack.channel.bookings}}",
  "template": "*Unlinked payment* · ${{event.amount | abs | fixed:2}} {{event.status}}\nNobody in the CRM matched this buyer.\n*Email:* {{event.customer_email | default:—}} · *Phone:* {{event.customer_phone | default:—}} · *Whop member:* {{event.whop_member_id | default:—}}\nLink it: {{company.base_url}}/c/{{company.slug}}/payments",
  "thread_only": false,
  "edit": false,
  "buttons": [
    {
      "text": "Link to a contact",
      "action": "link_payment",
      "value": "{{event.payment_id}}",
      "style": "primary"
    }
  ],
  "label": "ghost"
}
```

</details>

### 3. Stop: told

- Step id `x1`, type `exit`

Next: the run ends here.

<details><summary>Full step definition</summary>

```json
{
  "id": "x1",
  "type": "exit",
  "reason": "told"
}
```

</details>

## Settings this workflow reads

| Key | Kind | Required to enable | Value |
| --- | --- | --- | --- |
| `crm.location_id` | id | yes | not read (repo) |
| `slack.channel.alerts` | channel | no | not read (repo) |
| `slack.channel.bookings` | channel | no | not read (repo) |

## Engine rules that apply but are not steps

These act on every run of this workflow from engine code. They are not in the definition above.

- **Mode.** The workflow's own mode, else the offer's, decides what is real: ghost writes and sends nothing, test is real only for test contacts, quiet writes the CRM but reaches no contact, live is real. (platform/src/engine/mode.ts:23, platform/src/engine/mode.ts:55)
- **Runs again?** A run's key is built from the re-entry policy; a second trigger with the same key starts nothing. A run that stops at a gate does not count. (platform/src/engine/reentry.ts:6)
- **Failures.** Errors are sorted into transient, auth, permanent and unknown. A step is retried after 1 and 5 minutes; then a non-blocking step is skipped and a blocking one is held and looked at again after 15 minutes, then hourly. An auth or permanent failure pauses the run until it is fixed. (platform/src/engine/failures.ts:19, platform/src/engine/failures.ts:21, platform/src/engine/blocking.ts:58)
- **Step cap.** At most 50 steps run in one go; a run past that fails. After an outage, at most 20 sends per offer per tick. (platform/src/engine/runner.ts:21, platform/src/engine/runner.ts:27)
- **Slack before live.** Until the workflow is live, every post goes to the offer's test channel with a ghost/test label, unless `slack.live` is set. (platform/src/engine/mode.ts:32, platform/src/engine/mode.ts:34)
