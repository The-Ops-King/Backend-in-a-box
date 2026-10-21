# EOD: post the closer's day

Offer: **Save Your Hair (Parungao)** (`hair`). Source: live database. Generated 2026-10-21.

| Setting | Value |
| --- | --- |
| Where this definition came from | live: version 5, saved 2026-10-12T01:23:16.723Z (upgraded to template v5) |
| Template | `eod-filed` v5 |
| Edited since copied from the template | no |
| Saved version | 5 |
| Enabled | on |
| Mode | live |
| Send lock | locked: texts, emails, documents and webhooks reach only the operator's own addresses |
| Runs again for the same person | always |
| Re-checked before every step | nothing |
| Send window | 08:00 to 20:00, the contact's time zone; transactional messages may go at any hour |
| Steps | 4 |

## Steps

Every step, in the order a run meets it from the trigger. Steps that only assemble words (`set_var`) are listed too.

### 1. A closer filed their end-of-day form

- Step id `t1`, type `trigger`

Next:
- always → step 2 (`n_summary`)

<details><summary>Full step definition</summary>

```json
{
  "id": "t1",
  "type": "trigger",
  "event": "eod.filed"
}
```

</details>

### 2. Post what happened on each call

- Step id `n_summary`, type `slack_post`
- Engine description: Post to Slack (the eod channel)
- Goes to: channel {{slack.channel.eod}}; edits the earlier post; posted as "End of day"; remembered as eod-summary:{{event.user_id}}:{{event.day}}
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Slack post:

```
📝 *{{user.name}}* filed {{event.day_label}}: {{event.totals_line}}.{{event.calls | each:"\n• {{item.contact}}: {{item.outcome_label | default:no answer}}{{item.cash | nonzero | then:\" · $\"}}{{item.cash | nonzero | money:0 | suffix:\" collected\"}}{{item.revenue | nonzero | then:\" · $\"}}{{item.revenue | nonzero | money:0 | suffix:\" revenue\"}}{{item.next_date | then:\" · next \"}}{{item.next_date | date:\"ccc LLL d\"}}{{item.dq_reason | then:\" · \"}}{{item.dq_reason}}{{item.lost_reason | then:\" · \"}}{{item.lost_reason}}" | join:""}}{{event.day_answers_lines | line}}
```

Next:
- always → step 3 (`n_ack`)

<details><summary>Full step definition</summary>

```json
{
  "id": "n_summary",
  "title": "Post what happened on each call",
  "type": "slack_post",
  "channel": "{{slack.channel.eod}}",
  "template": "📝 *{{user.name}}* filed {{event.day_label}}: {{event.totals_line}}.{{event.calls | each:\"\\n• {{item.contact}}: {{item.outcome_label | default:no answer}}{{item.cash | nonzero | then:\\\" · $\\\"}}{{item.cash | nonzero | money:0 | suffix:\\\" collected\\\"}}{{item.revenue | nonzero | then:\\\" · $\\\"}}{{item.revenue | nonzero | money:0 | suffix:\\\" revenue\\\"}}{{item.next_date | then:\\\" · next \\\"}}{{item.next_date | date:\\\"ccc LLL d\\\"}}{{item.dq_reason | then:\\\" · \\\"}}{{item.dq_reason}}{{item.lost_reason | then:\\\" · \\\"}}{{item.lost_reason}}\" | join:\"\"}}{{event.day_answers_lines | line}}",
  "as": {
    "name": "End of day",
    "icon": ":clipboard:"
  },
  "thread_only": false,
  "tag": "eod-summary:{{event.user_id}}:{{event.day}}",
  "edit": true,
  "label": "mode"
}
```

</details>

### 3. React ✅ on the reminder

- Step id `n_ack`, type `slack_post`
- Engine description: Reply in the thread of that Slack post
- Detail: reacts :white_check_mark: on it
- Goes to: channel {{user.slack_user_id}}; in the thread of tag:eod-reminder:{{event.user_id}}:{{event.day}}; edits the earlier post; posted as "End of day"; remembered as eod-ack:{{event.user_id}}:{{event.day}}
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Slack post:

```
✅ Got it. {{event.totals_line}}.
```

Next:
- always → step 4 (`x_done`)

<details><summary>Full step definition</summary>

```json
{
  "id": "n_ack",
  "title": "React ✅ on the reminder",
  "type": "slack_post",
  "channel": "{{user.slack_user_id}}",
  "template": "✅ Got it. {{event.totals_line}}.",
  "as": {
    "name": "End of day",
    "icon": ":clipboard:"
  },
  "thread_of": "tag:eod-reminder:{{event.user_id}}:{{event.day}}",
  "thread_only": false,
  "tag": "eod-ack:{{event.user_id}}:{{event.day}}",
  "edit": true,
  "react": "white_check_mark",
  "label": "mode"
}
```

</details>

### 4. Done

- Step id `x_done`, type `exit`

Next: the run ends here.

<details><summary>Full step definition</summary>

```json
{
  "id": "x_done",
  "type": "exit",
  "reason": "done"
}
```

</details>

## Settings this workflow reads

| Key | Kind | Required to enable | Value |
| --- | --- | --- | --- |
| `crm.location_id` | id | yes | `WUtLNZJFg8QbFWyQhlH1` |
| `slack.channel.eod` | channel | no | `C0C7QCTHL8L` |

## Engine rules that apply but are not steps

These act on every run of this workflow from engine code. They are not in the definition above.

- **Mode.** The workflow's own mode, else the offer's, decides what is real: ghost writes and sends nothing, test is real only for test contacts, quiet writes the CRM but reaches no contact, live is real. (platform/src/engine/mode.ts:23, platform/src/engine/mode.ts:55)
- **Runs again?** A run's key is built from the re-entry policy; a second trigger with the same key starts nothing. A run that stops at a gate does not count. (platform/src/engine/reentry.ts:6)
- **Failures.** Errors are sorted into transient, auth, permanent and unknown. A step is retried after 1 and 5 minutes; then a non-blocking step is skipped and a blocking one is held and looked at again after 15 minutes, then hourly. An auth or permanent failure pauses the run until it is fixed. (platform/src/engine/failures.ts:19, platform/src/engine/failures.ts:21, platform/src/engine/blocking.ts:58)
- **Step cap.** At most 50 steps run in one go; a run past that fails. After an outage, at most 20 sends per offer per tick. (platform/src/engine/runner.ts:21, platform/src/engine/runner.ts:27)
- **Slack before live.** Until the workflow is live, every post goes to the offer's test channel with a ghost/test label, unless `slack.live` is set. (platform/src/engine/mode.ts:32, platform/src/engine/mode.ts:34)
