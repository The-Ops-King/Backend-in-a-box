# Weekly leaderboard

Offer: **PMU** (`pmu`). Source: live database. Generated 2026-10-21.

| Setting | Value |
| --- | --- |
| Where this definition came from | live: version 2, saved 2026-10-17T19:30:26.423Z (upgraded to template v2) |
| Template | `weekly-leaderboard` v2 |
| Edited since copied from the template | no |
| Saved version | 2 |
| Enabled | off |
| Mode | follows the offer (ghost) |
| Send lock | locked: texts, emails, documents and webhooks reach only the operator's own addresses |
| Runs again for the same person | always |
| Re-checked before every step | nothing |
| Send window | 08:00 to 20:00, the contact's time zone |
| Steps | 4 |

## Steps

Every step, in the order a run meets it from the trigger. Steps that only assemble words (`set_var`) are listed too.

### 1. On a schedule: at 9:00 AM on Mon

- Step id `t_weekly`, type `trigger`

Next:
- always → step 2 (`n_board`)

<details><summary>Full step definition</summary>

```json
{
  "id": "t_weekly",
  "type": "trigger",
  "event": "schedule",
  "schedule": {
    "at": "09:00",
    "days": [
      1
    ],
    "for": "company"
  }
}
```

</details>

### 2. Rank last week's closers by cash and setters by sets

- Step id `n_board`, type `leaderboard`
- Engine description: Build the leaderboard for last week
- Detail: Closers by cash collected (closes and close rate beside), setters by sets (the show rate of their sets beside); into board: body, closers, setters, period
- If it keeps failing: the run is held on this step (step n_post reads the leaderboard)

Next:
- always → step 3 (`n_post`)

<details><summary>Full step definition</summary>

```json
{
  "id": "n_board",
  "title": "Rank last week's closers by cash and setters by sets",
  "type": "leaderboard",
  "period": "last week",
  "into": "board"
}
```

</details>

### 3. Post the leaderboard in Slack

- Step id `n_post`, type `slack_post`
- Engine description: Post to Slack (the ops channel, else the reports channel)
- Goes to: channel {{slack.channel.ops}}; falls back to {{slack.channel.reports}}; posted as "Leaderboard"
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Slack post:

```
{{vars.board.body}}
_{{vars.board.period_name}} · {{vars.board.period_label}}_
```

Next:
- always → step 4 (`x_done`)

<details><summary>Full step definition</summary>

```json
{
  "id": "n_post",
  "title": "Post the leaderboard in Slack",
  "type": "slack_post",
  "channel": "{{slack.channel.ops}}",
  "fallback_channel": "{{slack.channel.reports}}",
  "template": "{{vars.board.body}}\n_{{vars.board.period_name}} · {{vars.board.period_label}}_",
  "as": {
    "name": "Leaderboard",
    "icon": ":trophy:"
  },
  "thread_only": false,
  "edit": false,
  "label": "mode",
  "quiet_when_empty": "vars.board.nothing"
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
| `crm.location_id` | id | yes | `gA10c58jLJRYbNwC3apW` |
| `slack.channel.ops` | channel | no | `C0C70J3TEF9` |
| `slack.channel.reports` | channel | no | `C0BSGCQS3RA` |

## Engine rules that apply but are not steps

These act on every run of this workflow from engine code. They are not in the definition above.

- **Mode.** The workflow's own mode, else the offer's, decides what is real: ghost writes and sends nothing, test is real only for test contacts, quiet writes the CRM but reaches no contact, live is real. (platform/src/engine/mode.ts:23, platform/src/engine/mode.ts:55)
- **Runs again?** A run's key is built from the re-entry policy; a second trigger with the same key starts nothing. A run that stops at a gate does not count. (platform/src/engine/reentry.ts:6)
- **Failures.** Errors are sorted into transient, auth, permanent and unknown. A step is retried after 1 and 5 minutes; then a non-blocking step is skipped and a blocking one is held and looked at again after 15 minutes, then hourly. An auth or permanent failure pauses the run until it is fixed. (platform/src/engine/failures.ts:19, platform/src/engine/failures.ts:21, platform/src/engine/blocking.ts:58)
- **Step cap.** At most 50 steps run in one go; a run past that fails. After an outage, at most 20 sends per offer per tick. (platform/src/engine/runner.ts:21, platform/src/engine/runner.ts:27)
- **Slack before live.** Until the workflow is live, every post goes to the offer's test channel with a ghost/test label, unless `slack.live` is set. (platform/src/engine/mode.ts:32, platform/src/engine/mode.ts:34)
