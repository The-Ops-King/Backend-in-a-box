# EOD: remind closers to file

Offer: **Dating (Nelly)** (`dating-nelly`). Source: **from repo, may differ from live**. Generated 2026-10-21.

| Setting | Value |
| --- | --- |
| Where this definition came from | shipped template: platform/src/templates/eod-reminder.json (the offer's words, if any, are applied at install) |
| Template | `eod-reminder` |
| Edited since copied from the template | unknown (repo) |
| Saved version | unknown (repo) |
| Enabled | unknown (repo) |
| Mode | follows the offer (quiet) |
| Send lock | unknown (repo) |
| Runs again for the same person | always |
| Re-checked before every step | nothing |
| Send window | the offer's (unknown in repo) |
| Steps | 9 |

## Steps

Every step, in the order a run meets it from the trigger. Steps that only assemble words (`set_var`) are listed too.

### 1. On a schedule: at 6:00 PM every day, one run per closer

- Step id `t_evening`, type `trigger`

Next:
- always → step 3 (`v_evening`)

<details><summary>Full step definition</summary>

```json
{
  "id": "t_evening",
  "type": "trigger",
  "event": "schedule",
  "schedule": {
    "at": "18:00",
    "for": "closer"
  }
}
```

</details>

### 2. On a schedule: at 9:00 AM every day, one run per closer

- Step id `t_morning`, type `trigger`

Next:
- always → step 4 (`v_morning`)

<details><summary>Full step definition</summary>

```json
{
  "id": "t_morning",
  "type": "trigger",
  "event": "schedule",
  "schedule": {
    "at": "09:00",
    "for": "closer"
  }
}
```

</details>

### 3. Today and every earlier day still to file (the ledger and GHL's Sales Calls)

- Step id `v_evening`, type `eod_due`
- Engine description: What the closer still has to file (today and earlier)
- Detail: Days with calls and no end-of-day report, and days whose Sales Calls in GHL still have no outcome; blank for two days or more, the operator is told too
- If it keeps failing: the run is held on this step (step c_due reads the days still to file)

Next:
- always → step 5 (`c_due`)

<details><summary>Full step definition</summary>

```json
{
  "id": "v_evening",
  "title": "Today and every earlier day still to file (the ledger and GHL's Sales Calls)",
  "type": "eod_due",
  "period": "evening",
  "into": "due",
  "lookback_days": 7,
  "include_today": true,
  "overdue_after_days": 2
}
```

</details>

### 4. Every earlier day still to file

- Step id `v_morning`, type `eod_due`
- Engine description: What the closer still has to file (earlier days)
- Detail: Days with calls and no end-of-day report, and days whose Sales Calls in GHL still have no outcome; blank for two days or more, the operator is told too
- If it keeps failing: the run is held on this step (step c_due reads the days still to file)

Next:
- always → step 5 (`c_due`)

<details><summary>Full step definition</summary>

```json
{
  "id": "v_morning",
  "title": "Every earlier day still to file",
  "type": "eod_due",
  "period": "morning",
  "into": "due",
  "lookback_days": 7,
  "include_today": false,
  "overdue_after_days": null
}
```

</details>

### 5. Check there are days still to file

- Step id `c_due`, type `check`
- Detail: Otherwise the run stops: nothing to file
- If it keeps failing: the run is held on this step (it decides whether the run goes on)

Next:
- always → step 6 (`n_dm`)

<details><summary>Full step definition</summary>

```json
{
  "id": "c_due",
  "type": "check",
  "when": {
    "gt": [
      "{{vars.due.count}}",
      0
    ]
  },
  "else_exit": "nothing_to_file"
}
```

</details>

### 6. DM the closer their link

- Step id `n_dm`, type `slack_post`
- Engine description: Post to Slack (the closer's Slack DM)
- Goes to: channel {{user.slack_user_id}}; posted as "End of day"; remembered as eod-reminder:{{user.id}}:{{user.eod.day}}
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Slack post:

```
Hey {{user.first_name}}, your end-of-day is waiting:
{{vars.due.days | each:"• <{{item.url}}|{{item.when}}>: {{item.calls | nonzero | plural:call}}{{item.both | then:\", \"}}{{item.ghl_blank | nonzero | plural:call | suffix:\" with no outcome in GHL\"}}" | join:"\n"}}
It's prefilled from your calendar and the day's calls. Fix anything that's off and hit submit.
```

Next:
- always → step 7 (`n_op`)

<details><summary>Full step definition</summary>

```json
{
  "id": "n_dm",
  "title": "DM the closer their link",
  "type": "slack_post",
  "channel": "{{user.slack_user_id}}",
  "template": "Hey {{user.first_name}}, your end-of-day is waiting:\n{{vars.due.days | each:\"• <{{item.url}}|{{item.when}}>: {{item.calls | nonzero | plural:call}}{{item.both | then:\\\", \\\"}}{{item.ghl_blank | nonzero | plural:call | suffix:\\\" with no outcome in GHL\\\"}}\" | join:\"\\n\"}}\nIt's prefilled from your calendar and the day's calls. Fix anything that's off and hit submit.",
  "as": {
    "name": "End of day",
    "icon": ":clipboard:"
  },
  "thread_only": false,
  "tag": "eod-reminder:{{user.id}}:{{user.eod.day}}",
  "edit": false,
  "label": "mode"
}
```

</details>

### 7. Tell the operator about calls blank for two days

- Step id `n_op`, type `slack_post`
- Engine description: Post to Slack (Slack id for the operator)
- Runs only if: there is a Slack id for the operator and the number of calls blank for two days is more than 0 (otherwise skipped)
- Goes to: channel {{company.operator_slack_id}}; posted as "End of day"
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Slack post:

```
{{user.name}} still has Sales Calls with no outcome in GHL after two days:
{{vars.due.overdue | each:"• {{item.label}}: {{item.names | join}}" | join:"\n"}}
```

Next:
- always → step 8 (`x_done`)

<details><summary>Full step definition</summary>

```json
{
  "id": "n_op",
  "title": "Tell the operator about calls blank for two days",
  "only_if": {
    "and": [
      {
        "exists": "company.operator_slack_id"
      },
      {
        "gt": [
          "{{vars.due.overdue_count}}",
          0
        ]
      }
    ]
  },
  "type": "slack_post",
  "channel": "{{company.operator_slack_id}}",
  "template": "{{user.name}} still has Sales Calls with no outcome in GHL after two days:\n{{vars.due.overdue | each:\"• {{item.label}}: {{item.names | join}}\" | join:\"\\n\"}}",
  "as": {
    "name": "End of day",
    "icon": ":clipboard:"
  },
  "thread_only": false,
  "edit": false,
  "label": "mode"
}
```

</details>

### 8. Done

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

### 9. Stop: nothing to file

- Step id `x_nothing`, type `exit`

Next: the run ends here.

<details><summary>Full step definition</summary>

```json
{
  "id": "x_nothing",
  "type": "exit",
  "reason": "nothing_to_file"
}
```

</details>

## Settings this workflow reads

| Key | Kind | Required to enable | Value |
| --- | --- | --- | --- |
| `crm.location_id` | id | yes | not read (repo) |

## Engine rules that apply but are not steps

These act on every run of this workflow from engine code. They are not in the definition above.

- **Mode.** The workflow's own mode, else the offer's, decides what is real: ghost writes and sends nothing, test is real only for test contacts, quiet writes the CRM but reaches no contact, live is real. (platform/src/engine/mode.ts:23, platform/src/engine/mode.ts:55)
- **Runs again?** A run's key is built from the re-entry policy; a second trigger with the same key starts nothing. A run that stops at a gate does not count. (platform/src/engine/reentry.ts:6)
- **Failures.** Errors are sorted into transient, auth, permanent and unknown. A step is retried after 1 and 5 minutes; then a non-blocking step is skipped and a blocking one is held and looked at again after 15 minutes, then hourly. An auth or permanent failure pauses the run until it is fixed. (platform/src/engine/failures.ts:19, platform/src/engine/failures.ts:21, platform/src/engine/blocking.ts:58)
- **Step cap.** At most 50 steps run in one go; a run past that fails. After an outage, at most 20 sends per offer per tick. (platform/src/engine/runner.ts:21, platform/src/engine/runner.ts:27)
- **Slack before live.** Until the workflow is live, every post goes to the offer's test channel with a ghost/test label, unless `slack.live` is set. (platform/src/engine/mode.ts:32, platform/src/engine/mode.ts:34)
