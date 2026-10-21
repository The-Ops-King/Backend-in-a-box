# Unsigned agreement chase

Offer: **Dating (Nelly)** (`dating-nelly`). Source: live database. Generated 2026-10-21.

| Setting | Value |
| --- | --- |
| Where this definition came from | live: version 2, saved 2026-10-16T18:22:44.383Z (upgraded to template v6) |
| Template | `agreement-chase` v6 |
| Edited since copied from the template | no |
| Saved version | 2 |
| Enabled | off |
| Mode | follows the offer (quiet) |
| Send lock | locked: texts, emails, documents and webhooks reach only the operator's own addresses |
| Runs again for the same person | once_per_contact |
| Re-checked before every step | contact exists |
| Send window | 08:00 to 20:00, the contact's time zone |
| Steps | 16 |

## Steps

Every step, in the order a run meets it from the trigger. Steps that only assemble words (`set_var`) are listed too.

### 1. Payment received — there are no prior non deposit total and payment kind is not “deposit”

- Step id `t1`, type `trigger`

Next:
- always → step 2 (`w1`)

<details><summary>Full step definition</summary>

```json
{
  "id": "t1",
  "type": "trigger",
  "event": "payment.received",
  "match": {
    "and": [
      {
        "eq": [
          "{{event.prior_non_deposit_total}}",
          0
        ]
      },
      {
        "neq": [
          "{{event.kind}}",
          "deposit"
        ]
      }
    ]
  }
}
```

</details>

### 2. Wait 24 hours

- Step id `w1`, type `wait`
- Detail: Company's time zone
- Wait: Wait 24 hours (time zone: company)
- If it keeps failing: the run is held on this step (the run waits on it)

Next:
- always → step 3 (`c1`)

<details><summary>Full step definition</summary>

```json
{
  "id": "w1",
  "type": "wait",
  "rule": {
    "anchor": "now",
    "offset": "+24h",
    "tz": "company"
  }
}
```

</details>

### 3. Check they have not signed the agreement

- Step id `c1`, type `check`
- Detail: Otherwise the run stops: signed
- If it keeps failing: the run is held on this step (it decides whether the run goes on)

Next:
- always → step 4 (`v1`)

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
  "else_exit": "signed"
}
```

</details>

### 4. Remember nudge = 1

- Step id `v1`, type `set_var`
- If it keeps failing: the run is held on this step (later steps read what it remembers)

Next:
- always → step 5 (`n1`)

<details><summary>Full step definition</summary>

```json
{
  "id": "v1",
  "type": "set_var",
  "key": "nudge",
  "value": 1
}
```

</details>

### 5. DM the owner: still unsigned

- Step id `n1`, type `notify_owner`
- Engine description: Nudge the contact's owner
- Detail: Slack DM when the owner is in Slack, else the alerts channel with an @mention; CRM task “Chase the unsigned agreement: [full name]” due in 1 day
- Goes to: the contact's owner by Slack DM, else {{slack.channel.alerts}}; plus a CRM task
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Message to the owner:

```
*Agreement still unsigned* · <https://app.gohighlevel.com/v2/location/{{crm.location_id}}/contacts/detail/{{contact.ghl_contact_id | default:}}|{{contact.name | default:Unknown}}> paid ${{contact.cash_collected | money}} on {{contact.first_paid_at | date_company}} and has not signed the purchase agreement. Nudge {{vars.nudge}} of 3.
```

Task title:

```
Chase the unsigned agreement: {{contact.name | default:contact}}
```

Next:
- always → step 6 (`w2`)

<details><summary>Full step definition</summary>

```json
{
  "id": "n1",
  "title": "DM the owner: still unsigned",
  "type": "notify_owner",
  "template": "*Agreement still unsigned* · <https://app.gohighlevel.com/v2/location/{{crm.location_id}}/contacts/detail/{{contact.ghl_contact_id | default:}}|{{contact.name | default:Unknown}}> paid ${{contact.cash_collected | money}} on {{contact.first_paid_at | date_company}} and has not signed the purchase agreement. Nudge {{vars.nudge}} of 3.",
  "fallback_channel": "{{slack.channel.alerts}}",
  "task": {
    "title": "Chase the unsigned agreement: {{contact.name | default:contact}}",
    "due": "+1d"
  },
  "as": {
    "name": "Agreement unsigned",
    "icon": [
      ":warning:",
      ":memo:",
      ":hourglass_flowing_sand:"
    ]
  }
}
```

</details>

### 6. Wait 24 hours

- Step id `w2`, type `wait`
- Detail: Company's time zone
- Wait: Wait 24 hours (time zone: company)
- If it keeps failing: the run is held on this step (the run waits on it)

Next:
- always → step 7 (`c2`)

<details><summary>Full step definition</summary>

```json
{
  "id": "w2",
  "type": "wait",
  "rule": {
    "anchor": "now",
    "offset": "+24h",
    "tz": "company"
  }
}
```

</details>

### 7. Check they have not signed the agreement

- Step id `c2`, type `check`
- Detail: Otherwise the run stops: signed
- If it keeps failing: the run is held on this step (it decides whether the run goes on)

Next:
- always → step 8 (`v2`)

<details><summary>Full step definition</summary>

```json
{
  "id": "c2",
  "type": "check",
  "when": {
    "eq": [
      "{{contact.agreement_signed}}",
      false
    ]
  },
  "else_exit": "signed"
}
```

</details>

### 8. Remember nudge = 2

- Step id `v2`, type `set_var`
- If it keeps failing: the run is held on this step (later steps read what it remembers)

Next:
- always → step 9 (`n2`)

<details><summary>Full step definition</summary>

```json
{
  "id": "v2",
  "type": "set_var",
  "key": "nudge",
  "value": 2
}
```

</details>

### 9. DM the owner: still unsigned

- Step id `n2`, type `notify_owner`
- Engine description: Nudge the contact's owner
- Detail: Slack DM when the owner is in Slack, else the alerts channel with an @mention; CRM task “Chase the unsigned agreement: [full name]” due in 1 day
- Goes to: the contact's owner by Slack DM, else {{slack.channel.alerts}}; plus a CRM task
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Message to the owner:

```
*Agreement still unsigned* · <https://app.gohighlevel.com/v2/location/{{crm.location_id}}/contacts/detail/{{contact.ghl_contact_id | default:}}|{{contact.name | default:Unknown}}> paid ${{contact.cash_collected | money}} on {{contact.first_paid_at | date_company}} and has not signed the purchase agreement. Nudge {{vars.nudge}} of 3.
```

Task title:

```
Chase the unsigned agreement: {{contact.name | default:contact}}
```

Next:
- always → step 10 (`w3`)

<details><summary>Full step definition</summary>

```json
{
  "id": "n2",
  "title": "DM the owner: still unsigned",
  "type": "notify_owner",
  "template": "*Agreement still unsigned* · <https://app.gohighlevel.com/v2/location/{{crm.location_id}}/contacts/detail/{{contact.ghl_contact_id | default:}}|{{contact.name | default:Unknown}}> paid ${{contact.cash_collected | money}} on {{contact.first_paid_at | date_company}} and has not signed the purchase agreement. Nudge {{vars.nudge}} of 3.",
  "fallback_channel": "{{slack.channel.alerts}}",
  "task": {
    "title": "Chase the unsigned agreement: {{contact.name | default:contact}}",
    "due": "+1d"
  },
  "as": {
    "name": "Agreement unsigned",
    "icon": [
      ":warning:",
      ":memo:",
      ":hourglass_flowing_sand:"
    ]
  }
}
```

</details>

### 10. Wait 24 hours

- Step id `w3`, type `wait`
- Detail: Company's time zone
- Wait: Wait 24 hours (time zone: company)
- If it keeps failing: the run is held on this step (the run waits on it)

Next:
- always → step 11 (`c3`)

<details><summary>Full step definition</summary>

```json
{
  "id": "w3",
  "type": "wait",
  "rule": {
    "anchor": "now",
    "offset": "+24h",
    "tz": "company"
  }
}
```

</details>

### 11. Check they have not signed the agreement

- Step id `c3`, type `check`
- Detail: Otherwise the run stops: signed
- If it keeps failing: the run is held on this step (it decides whether the run goes on)

Next:
- always → step 12 (`v3`)

<details><summary>Full step definition</summary>

```json
{
  "id": "c3",
  "type": "check",
  "when": {
    "eq": [
      "{{contact.agreement_signed}}",
      false
    ]
  },
  "else_exit": "signed"
}
```

</details>

### 12. Remember nudge = 3

- Step id `v3`, type `set_var`
- If it keeps failing: the run is held on this step (later steps read what it remembers)

Next:
- always → step 13 (`n3`)

<details><summary>Full step definition</summary>

```json
{
  "id": "v3",
  "type": "set_var",
  "key": "nudge",
  "value": 3
}
```

</details>

### 13. DM the owner: still unsigned

- Step id `n3`, type `notify_owner`
- Engine description: Nudge the contact's owner
- Detail: Slack DM when the owner is in Slack, else the alerts channel with an @mention; CRM task “Chase the unsigned agreement: [full name]” due in 1 day
- Goes to: the contact's owner by Slack DM, else {{slack.channel.alerts}}; plus a CRM task
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Message to the owner:

```
*Agreement still unsigned* · <https://app.gohighlevel.com/v2/location/{{crm.location_id}}/contacts/detail/{{contact.ghl_contact_id | default:}}|{{contact.name | default:Unknown}}> paid ${{contact.cash_collected | money}} on {{contact.first_paid_at | date_company}} and has not signed the purchase agreement. Nudge {{vars.nudge}} of 3.
```

Task title:

```
Chase the unsigned agreement: {{contact.name | default:contact}}
```

Next:
- always → step 14 (`g1`)

<details><summary>Full step definition</summary>

```json
{
  "id": "n3",
  "title": "DM the owner: still unsigned",
  "type": "notify_owner",
  "template": "*Agreement still unsigned* · <https://app.gohighlevel.com/v2/location/{{crm.location_id}}/contacts/detail/{{contact.ghl_contact_id | default:}}|{{contact.name | default:Unknown}}> paid ${{contact.cash_collected | money}} on {{contact.first_paid_at | date_company}} and has not signed the purchase agreement. Nudge {{vars.nudge}} of 3.",
  "fallback_channel": "{{slack.channel.alerts}}",
  "task": {
    "title": "Chase the unsigned agreement: {{contact.name | default:contact}}",
    "due": "+1d"
  },
  "as": {
    "name": "Agreement unsigned",
    "icon": [
      ":warning:",
      ":memo:",
      ":hourglass_flowing_sand:"
    ]
  }
}
```

</details>

### 14. Add tag “stat-agreement-unsigned”

- Step id `g1`, type `set_tag`
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Next:
- always → step 15 (`s1`)

<details><summary>Full step definition</summary>

```json
{
  "id": "g1",
  "type": "set_tag",
  "tag": [
    "stat-agreement-unsigned"
  ]
}
```

</details>

### 15. Post unsigned alert in Slack

- Step id `s1`, type `slack_post`
- Engine description: Post to Slack (the alerts channel)
- Goes to: channel {{slack.channel.alerts}}; posted as "Agreement unsigned"
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Slack post:

```
*Agreement unsigned after 3 nudges:* <https://app.gohighlevel.com/v2/location/{{crm.location_id}}/contacts/detail/{{contact.ghl_contact_id | default:}}|{{contact.name | default:Unknown}}> · paid ${{contact.cash_collected | money}} · owner {{contact.owner.name | default:unassigned}}. Tagged stat-agreement-unsigned.
```

Next:
- always → step 16 (`x1`)

<details><summary>Full step definition</summary>

```json
{
  "id": "s1",
  "title": "Post unsigned alert in Slack",
  "type": "slack_post",
  "channel": "{{slack.channel.alerts}}",
  "template": "*Agreement unsigned after 3 nudges:* <https://app.gohighlevel.com/v2/location/{{crm.location_id}}/contacts/detail/{{contact.ghl_contact_id | default:}}|{{contact.name | default:Unknown}}> · paid ${{contact.cash_collected | money}} · owner {{contact.owner.name | default:unassigned}}. Tagged stat-agreement-unsigned.",
  "as": {
    "name": "Agreement unsigned",
    "icon": [
      ":warning:",
      ":memo:",
      ":hourglass_flowing_sand:"
    ]
  },
  "thread_only": false,
  "edit": false,
  "label": "mode"
}
```

</details>

### 16. Stop: unsigned after 3

- Step id `x1`, type `exit`

Next: the run ends here.

<details><summary>Full step definition</summary>

```json
{
  "id": "x1",
  "type": "exit",
  "reason": "unsigned_after_3"
}
```

</details>

## Settings this workflow reads

| Key | Kind | Required to enable | Value |
| --- | --- | --- | --- |
| `crm.location_id` | id | yes | `eLfhuKEaVMlrpLm2Fz8V` |
| `slack.channel.alerts` | channel | no | `C0CA0A5BTC5` |

## Engine rules that apply but are not steps

These act on every run of this workflow from engine code. They are not in the definition above.

- **Mode.** The workflow's own mode, else the offer's, decides what is real: ghost writes and sends nothing, test is real only for test contacts, quiet writes the CRM but reaches no contact, live is real. (platform/src/engine/mode.ts:23, platform/src/engine/mode.ts:55)
- **Runs again?** A run's key is built from the re-entry policy; a second trigger with the same key starts nothing. A run that stops at a gate does not count. (platform/src/engine/reentry.ts:6)
- **Premise re-check.** Before each step the engine reads the CRM live; when "contact exists" no longer holds, the run exits. (platform/src/engine/runner.ts:33)
- **Failures.** Errors are sorted into transient, auth, permanent and unknown. A step is retried after 1 and 5 minutes; then a non-blocking step is skipped and a blocking one is held and looked at again after 15 minutes, then hourly. An auth or permanent failure pauses the run until it is fixed. (platform/src/engine/failures.ts:19, platform/src/engine/failures.ts:21, platform/src/engine/blocking.ts:58)
- **Step cap.** At most 50 steps run in one go; a run past that fails. After an outage, at most 20 sends per offer per tick. (platform/src/engine/runner.ts:21, platform/src/engine/runner.ts:27)
- **CRM writes** without a natural key (notes, tasks, cards, records) are claimed once per run and step so a retry never writes twice. In ghost mode they are skipped. (platform/src/engine/effects.ts:13)
- **Slack before live.** Until the workflow is live, every post goes to the offer's test channel with a ghost/test label, unless `slack.live` is set. (platform/src/engine/mode.ts:32, platform/src/engine/mode.ts:34)
- **Waits** are stored on the run (`runs.next_run_at`, `wake_on_*`), not held in memory; a reply, tap or event wakes the run at once. (platform/src/engine/runner.ts:56)
