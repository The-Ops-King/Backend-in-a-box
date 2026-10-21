# Card moved by hand

Offer: **PMU** (`pmu`). Source: live database. Generated 2026-10-21.

| Setting | Value |
| --- | --- |
| Where this definition came from | live: version 2, saved 2026-10-13T21:44:55.235Z (PMU: a card moved by hand into No Show after the call started files a no-show) |
| Template | `card-moved` v1 |
| Edited since copied from the template | yes |
| Saved version | 2 |
| Enabled | on |
| Mode | follows the offer (ghost) |
| Send lock | locked: texts, emails, documents and webhooks reach only the operator's own addresses |
| Runs again for the same person | always |
| Re-checked before every step | nothing |
| Send window | 08:00 to 20:00, the contact's time zone |
| Steps | 10 |

## Steps

Every step, in the order a run meets it from the trigger. Steps that only assemble words (`set_var`) are listed too.

### 1. Someone moved a card by hand in GHL

- Step id `t1`, type `trigger`

Next:
- always → step 2 (`v_status`)

<details><summary>Full step definition</summary>

```json
{
  "id": "t1",
  "type": "trigger",
  "event": "card.moved"
}
```

</details>

### 2. Whether the status changed too

- Step id `v_status`, type `set_var`
- Engine description: Remember status part = and marked it [to status]
- Detail: When from status is not the to status; otherwise 
- If it keeps failing: the run is held on this step (later steps read what it remembers)

Next:
- always → step 3 (`v_line`)

<details><summary>Full step definition</summary>

```json
{
  "id": "v_status",
  "title": "Whether the status changed too",
  "type": "set_var",
  "key": "status_part",
  "value": " and marked it {{event.to_status}}",
  "when": {
    "neq": [
      "{{event.from_status}}",
      "{{event.to_status}}"
    ]
  },
  "else_value": ""
}
```

</details>

### 3. The thread line

- Step id `v_line`, type `set_var`
- Engine description: Remember line = 🗂️ [who moved it] moved the [which board] card to [the stage it went to][status part]
- Detail: When from stage is not the to stage; otherwise 🗂️ [who moved it] marked the [which board] card [to status]
- If it keeps failing: the run is held on this step (later steps read what it remembers)

Next:
- always → step 4 (`n_line`)

<details><summary>Full step definition</summary>

```json
{
  "id": "v_line",
  "title": "The thread line",
  "type": "set_var",
  "key": "line",
  "value": "🗂️ {{event.mover | default:someone}} moved the {{event.pipeline}} card to {{event.to_name}}{{vars.status_part}}",
  "when": {
    "neq": [
      "{{event.from_stage}}",
      "{{event.to_stage}}"
    ]
  },
  "else_value": "🗂️ {{event.mover | default:someone}} marked the {{event.pipeline}} card {{event.to_status}}"
}
```

</details>

### 4. Say who moved the card, in the booking post's thread

- Step id `n_line`, type `slack_post`
- Engine description: Reply in the thread of that Slack post
- Goes to: channel {{slack.channel.bookings}}; in the thread of tag:appointment:{{appointment.id}}; thread only; posted as "Card moved"
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Slack post:

```
{{vars.line}}
```

Next:
- always → step 5 (`b1`)

<details><summary>Full step definition</summary>

```json
{
  "id": "n_line",
  "title": "Say who moved the card, in the booking post's thread",
  "type": "slack_post",
  "channel": "{{slack.channel.bookings}}",
  "template": "{{vars.line}}",
  "as": {
    "name": "Card moved",
    "icon": ":card_index_dividers:"
  },
  "thread_of": "tag:appointment:{{appointment.id}}",
  "thread_only": true,
  "edit": false,
  "label": "mode"
}
```

</details>

### 5. Does the stage name an outcome for a call that has started?

- Step id `b1`, type `branch`
- Engine description: Which way?
- If it keeps failing: the run is held on this step (it decides where the run goes)

Next:
- into a no show stage (when appointment started and from stage is not the to stage and appointment outcome is not no-show and which board is “closer” and to stage is the No Show) → step 6 (`o_noshow`)
- into Lost (when appointment started and from stage is not the to stage and how the call went is not “lost” and which board is “closer” and to stage is the Lost) → step 7 (`o_lost`)
- into Disqualified (when appointment started and from stage is not the to stage and how the call went is not disqualified and which board is “closer” and to stage is the Disqualified) → step 8 (`o_dq`)
- any other stage, or nothing new to file: noted → step 9 (`x_noted`)

<details><summary>Full step definition</summary>

```json
{
  "id": "b1",
  "title": "Does the stage name an outcome for a call that has started?",
  "type": "branch"
}
```

</details>

### 6. File a no-show, as the form would

- Step id `o_noshow`, type `record_outcome`
- Engine description: Record the appointment as no-show
- Detail: On our record of the appointment; a show also fires “call held”
- If it keeps failing: the run is held on this step (it is the run's own ledger)

Next:
- always → step 10 (`x_filed`)

<details><summary>Full step definition</summary>

```json
{
  "id": "o_noshow",
  "title": "File a no-show, as the form would",
  "type": "record_outcome",
  "outcome": "noshow",
  "notes": "Card moved to {{event.to_name}} in the CRM by {{event.mover | default:someone}}",
  "source": "disposition",
  "user": "{{event.mover_id | default:}}",
  "via": "card_moved"
}
```

</details>

### 7. File a show that was lost, as the form would

- Step id `o_lost`, type `record_outcome`
- Engine description: Record the appointment as “showed”
- Detail: Call outcome “lost”
- If it keeps failing: the run is held on this step (it is the run's own ledger)

Next:
- always → step 10 (`x_filed`)

<details><summary>Full step definition</summary>

```json
{
  "id": "o_lost",
  "title": "File a show that was lost, as the form would",
  "type": "record_outcome",
  "outcome": "showed",
  "call_outcome": "lost",
  "notes": "Card moved to {{event.to_name}} in the CRM by {{event.mover | default:someone}}",
  "source": "disposition",
  "user": "{{event.mover_id | default:}}",
  "via": "card_moved"
}
```

</details>

### 8. File a show that was disqualified, as the form would

- Step id `o_dq`, type `record_outcome`
- Engine description: Record the appointment as “showed”
- Detail: Call outcome disqualified
- If it keeps failing: the run is held on this step (it is the run's own ledger)

Next:
- always → step 10 (`x_filed`)

<details><summary>Full step definition</summary>

```json
{
  "id": "o_dq",
  "title": "File a show that was disqualified, as the form would",
  "type": "record_outcome",
  "outcome": "showed",
  "call_outcome": "unqualified",
  "notes": "Card moved to {{event.to_name}} in the CRM by {{event.mover | default:someone}}",
  "source": "disposition",
  "user": "{{event.mover_id | default:}}",
  "via": "card_moved"
}
```

</details>

### 9. Stop: noted

- Step id `x_noted`, type `exit`

Next: the run ends here.

<details><summary>Full step definition</summary>

```json
{
  "id": "x_noted",
  "type": "exit",
  "reason": "noted"
}
```

</details>

### 10. Stop: filed

- Step id `x_filed`, type `exit`

Next: the run ends here.

<details><summary>Full step definition</summary>

```json
{
  "id": "x_filed",
  "type": "exit",
  "reason": "filed"
}
```

</details>

## Settings this workflow reads

| Key | Kind | Required to enable | Value |
| --- | --- | --- | --- |
| `crm.location_id` | id | yes | `gA10c58jLJRYbNwC3apW` |
| `crm.stage_closer_disqualified` | id | no | `cc2af88d-e569-41c2-982c-5eeef6c89b0f` |
| `crm.stage_closer_lost` | id | no | `e9005f4d-8345-47da-9ef6-b2ad69c55127` |
| `crm.stage_closer_no_show` | id | no | `89d423f9-38f0-4e51-87e5-ce007c9c5de7` |
| `slack.channel.bookings` | channel | no | `C0BSCMB813L` |

## Engine rules that apply but are not steps

These act on every run of this workflow from engine code. They are not in the definition above.

- **Mode.** The workflow's own mode, else the offer's, decides what is real: ghost writes and sends nothing, test is real only for test contacts, quiet writes the CRM but reaches no contact, live is real. (platform/src/engine/mode.ts:23, platform/src/engine/mode.ts:55)
- **Runs again?** A run's key is built from the re-entry policy; a second trigger with the same key starts nothing. A run that stops at a gate does not count. (platform/src/engine/reentry.ts:6)
- **Failures.** Errors are sorted into transient, auth, permanent and unknown. A step is retried after 1 and 5 minutes; then a non-blocking step is skipped and a blocking one is held and looked at again after 15 minutes, then hourly. An auth or permanent failure pauses the run until it is fixed. (platform/src/engine/failures.ts:19, platform/src/engine/failures.ts:21, platform/src/engine/blocking.ts:58)
- **Step cap.** At most 50 steps run in one go; a run past that fails. After an outage, at most 20 sends per offer per tick. (platform/src/engine/runner.ts:21, platform/src/engine/runner.ts:27)
- **CRM writes** without a natural key (notes, tasks, cards, records) are claimed once per run and step so a retry never writes twice. In ghost mode they are skipped. (platform/src/engine/effects.ts:13)
- **Slack before live.** Until the workflow is live, every post goes to the offer's test channel with a ghost/test label, unless `slack.live` is set. (platform/src/engine/mode.ts:32, platform/src/engine/mode.ts:34)
