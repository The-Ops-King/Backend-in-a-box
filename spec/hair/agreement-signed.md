# Agreement signed

Offer: **Save Your Hair (Parungao)** (`hair`). Source: live database. Generated 2026-10-21.

| Setting | Value |
| --- | --- |
| Where this definition came from | live: version 6, saved 2026-10-12T01:13:45.550Z (upgraded to template v6) |
| Template | `agreement-signed` v6 |
| Edited since copied from the template | no |
| Saved version | 6 |
| Enabled | on |
| Mode | follows the offer (test) |
| Send lock | locked: texts, emails, documents and webhooks reach only the operator's own addresses |
| Runs again for the same person | always |
| Re-checked before every step | contact exists |
| Send window | 08:00 to 20:00, the contact's time zone; transactional messages may go at any hour |
| Steps | 5 |

## Steps

Every step, in the order a run meets it from the trigger. Steps that only assemble words (`set_var`) are listed too.

### 1. Agreement signed

- Step id `t1`, type `trigger`

Next:
- always → step 2 (`g1`)

<details><summary>Full step definition</summary>

```json
{
  "id": "t1",
  "type": "trigger",
  "event": "agreement.signed"
}
```

</details>

### 2. Tags “+stat-agreement-signed” “−stat-agreement-unsigned”

- Step id `g1`, type `tags`
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Next:
- always → step 3 (`m1`)

<details><summary>Full step definition</summary>

```json
{
  "id": "g1",
  "type": "tags",
  "add": [
    "stat-agreement-signed"
  ],
  "remove": [
    "stat-agreement-unsigned"
  ]
}
```

</details>

### 3. Leave an internal note

- Step id `m1`, type `note`
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

CRM note:

```
AGREEMENT SIGNED — {{agreement.signed_at | date_company}} · {{agreement.name | default:agreement}}
```

Next:
- always → step 4 (`s1`)

<details><summary>Full step definition</summary>

```json
{
  "id": "m1",
  "type": "note",
  "template": "AGREEMENT SIGNED — {{agreement.signed_at | date_company}} · {{agreement.name | default:agreement}}"
}
```

</details>

### 4. Post signed agreement in Slack

- Step id `s1`, type `slack_post`
- Engine description: Post to Slack (the deals channel)
- Goes to: channel {{slack.channel.deals}}; posted as "Agreement signed"
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Slack post:

```
*Agreement signed:*
*Name:* <https://app.gohighlevel.com/v2/location/{{crm.location_id}}/contacts/detail/{{contact.ghl_contact_id | default:}}|{{contact.name | default:Unknown}}>
```

Next:
- always → step 5 (`x1`)

<details><summary>Full step definition</summary>

```json
{
  "id": "s1",
  "title": "Post signed agreement in Slack",
  "type": "slack_post",
  "channel": "{{slack.channel.deals}}",
  "template": "*Agreement signed:*\n*Name:* <https://app.gohighlevel.com/v2/location/{{crm.location_id}}/contacts/detail/{{contact.ghl_contact_id | default:}}|{{contact.name | default:Unknown}}>",
  "as": {
    "name": "Agreement signed",
    "icon": [
      ":memo:",
      ":pencil:",
      ":page_with_curl:",
      ":lower_left_fountain_pen:"
    ]
  },
  "thread_only": false,
  "edit": false,
  "label": "mode"
}
```

</details>

### 5. Done: recorded

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
| `crm.location_id` | id | yes | `WUtLNZJFg8QbFWyQhlH1` |
| `slack.channel.deals` | channel | no | `C0C7QCTHL8L` |

## Engine rules that apply but are not steps

These act on every run of this workflow from engine code. They are not in the definition above.

- **Mode.** The workflow's own mode, else the offer's, decides what is real: ghost writes and sends nothing, test is real only for test contacts, quiet writes the CRM but reaches no contact, live is real. (platform/src/engine/mode.ts:23, platform/src/engine/mode.ts:55)
- **Runs again?** A run's key is built from the re-entry policy; a second trigger with the same key starts nothing. A run that stops at a gate does not count. (platform/src/engine/reentry.ts:6)
- **Premise re-check.** Before each step the engine reads the CRM live; when "contact exists" no longer holds, the run exits. (platform/src/engine/runner.ts:33)
- **Failures.** Errors are sorted into transient, auth, permanent and unknown. A step is retried after 1 and 5 minutes; then a non-blocking step is skipped and a blocking one is held and looked at again after 15 minutes, then hourly. An auth or permanent failure pauses the run until it is fixed. (platform/src/engine/failures.ts:19, platform/src/engine/failures.ts:21, platform/src/engine/blocking.ts:58)
- **Step cap.** At most 50 steps run in one go; a run past that fails. After an outage, at most 20 sends per offer per tick. (platform/src/engine/runner.ts:21, platform/src/engine/runner.ts:27)
- **CRM writes** without a natural key (notes, tasks, cards, records) are claimed once per run and step so a retry never writes twice. In ghost mode they are skipped. (platform/src/engine/effects.ts:13)
- **Slack before live.** Until the workflow is live, every post goes to the offer's test channel with a ghost/test label, unless `slack.live` is set. (platform/src/engine/mode.ts:32, platform/src/engine/mode.ts:34)
