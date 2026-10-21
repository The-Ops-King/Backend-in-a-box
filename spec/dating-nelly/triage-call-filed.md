# Triage call filed

Offer: **Dating (Nelly)** (`dating-nelly`). Source: **from repo, may differ from live**. Generated 2026-10-21.

| Setting | Value |
| --- | --- |
| Where this definition came from | the offer's own workflow: platform/installs/dating-nelly/triage-call-filed.json |
| Template | none (the offer's own workflow) |
| Edited since copied from the template | unknown (repo) |
| Saved version | unknown (repo) |
| Enabled | unknown (repo) |
| Mode | follows the offer (quiet) |
| Send lock | unknown (repo) |
| Runs again for the same person | always |
| Re-checked before every step | contact exists |
| Send window | the offer's (unknown in repo) |
| Steps | 13 |
| Note | dating-nelly: a Triage call's outcome, filed on the end of day (or a no-show marked in the CRM): the Discovery Call record (showed or no-show, set / follow up / DQ / not interested), the setter card to Showed (won), DQ, Not Interested or Cancelled / No Show (lost), a line in the booking thread (D143) |

## Steps

Every step, in the order a run meets it from the trigger. Steps that only assemble words (`set_var`) are listed too.

### 1. A Triage call's outcome filed

- Step id `t1`, type `trigger`
- Engine description: The call's outcome is filed — the source is a closer's form and term name is “Triage call”

Next:
- always → step 3 (`v_att`)

<details><summary>Full step definition</summary>

```json
{
  "id": "t1",
  "title": "A Triage call's outcome filed",
  "type": "trigger",
  "event": "appointment.outcome",
  "match": {
    "and": [
      {
        "eq": [
          "{{event._source}}",
          "disposition"
        ]
      },
      {
        "eq": [
          "{{appointment.term.name}}",
          "Triage call"
        ]
      }
    ]
  }
}
```

</details>

### 2. A Triage call marked a no-show in the CRM

- Step id `t2`, type `trigger`
- Engine description: An appointment's status changed — new status is no-show and term name is “Triage call”

Next:
- always → step 3 (`v_att`)

<details><summary>Full step definition</summary>

```json
{
  "id": "t2",
  "title": "A Triage call marked a no-show in the CRM",
  "type": "trigger",
  "event": "appointment.status_changed",
  "match": {
    "and": [
      {
        "eq": [
          "{{event.status.to}}",
          "noshow"
        ]
      },
      {
        "eq": [
          "{{appointment.term.name}}",
          "Triage call"
        ]
      }
    ]
  }
}
```

</details>

### 3. Whether they came, in the record's words

- Step id `v_att`, type `set_var`
- Engine description: Remember att, picked by [outcome]
- Detail: showed → showed; noshow → no_show; rescheduled → rescheduled; otherwise 
- If it keeps failing: the run is held on this step (later steps read what it remembers)

Next:
- always → step 4 (`v_res`)

<details><summary>Full step definition</summary>

```json
{
  "id": "v_att",
  "title": "Whether they came, in the record's words",
  "type": "set_var",
  "key": "att",
  "value": "{{event.outcome | default:noshow}}",
  "pick": {
    "showed": "showed",
    "noshow": "no_show",
    "rescheduled": "rescheduled"
  },
  "else_value": ""
}
```

</details>

### 4. What came of it, in the record's words

- Step id `v_res`, type `set_var`
- Engine description: Remember res, picked by [how the call went]
- Detail: qualified → set; follow up → follow_up; unqualified → dq; lost → not_interested; otherwise 
- If it keeps failing: the run is held on this step (later steps read what it remembers)

Next:
- always → step 5 (`v_line`)

<details><summary>Full step definition</summary>

```json
{
  "id": "v_res",
  "title": "What came of it, in the record's words",
  "type": "set_var",
  "key": "res",
  "value": "{{appointment.call_outcome | default:}}",
  "pick": {
    "qualified": "set",
    "follow_up": "follow_up",
    "unqualified": "dq",
    "lost": "not_interested"
  },
  "else_value": ""
}
```

</details>

### 5. The thread line

- Step id `v_line`, type `set_var`
- Engine description: Remember line, picked by [att]:[res]
- Detail: showed:set → ✅ Triage: set; showed:follow up → 🔁 Triage: follow up; showed:dq → ⛔ Triage: DQ; showed:not interested → 👋 Triage: not interested; showed: → ✅ Triage: showed; no show: → 👻 Triage: no-show; rescheduled: → 🔁 Triage: rescheduled on the call; otherwise 
- If it keeps failing: the run is held on this step (later steps read what it remembers)

Next:
- always → step 6 (`d1`)

<details><summary>Full step definition</summary>

```json
{
  "id": "v_line",
  "title": "The thread line",
  "type": "set_var",
  "key": "line",
  "value": "{{vars.att}}:{{vars.res}}",
  "pick": {
    "showed:set": "✅ Triage: set",
    "showed:follow_up": "🔁 Triage: follow up",
    "showed:dq": "⛔ Triage: DQ",
    "showed:not_interested": "👋 Triage: not interested",
    "showed:": "✅ Triage: showed",
    "no_show:": "👻 Triage: no-show",
    "rescheduled:": "🔁 Triage: rescheduled on the call"
  },
  "else_value": ""
}
```

</details>

### 6. The Discovery Call record: showed or no-show, the result, why a DQ and the notes

- Step id `d1`, type `crm_record`
- Engine description: Update discovery call record
- Detail: Keyed by this booking; 4 fields; empties dq reason unless this answer sets them; only if the record already exists
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Next:
- always → step 7 (`b1`)

<details><summary>Full step definition</summary>

```json
{
  "id": "d1",
  "title": "The Discovery Call record: showed or no-show, the result, why a DQ and the notes",
  "type": "crm_record",
  "object": "{{crm.object_discovery_call | default:custom_objects.discovery_call}}",
  "key": "{{appointment.slot_key}}",
  "properties": {
    "outcome": "{{vars.att}}",
    "call_result": "{{vars.res}}",
    "dq_reason": "{{event.dq_reason | default:}}",
    "notes": "{{event.notes | default:}}"
  },
  "if_missing": "skip",
  "relate": [],
  "clear": [
    "dq_reason"
  ]
}
```

</details>

### 7. Where the setter card goes

- Step id `b1`, type `branch`
- Engine description: Which way?
- If it keeps failing: the run is held on this step (it decides where the run goes)

Next:
- no show (when att is “no show”) → step 8 (`c_ns`)
- DQ (when res is disqualified) → step 9 (`c_dq`)
- not interested (when res is “not interested”) → step 10 (`c_ni`)
- showed (when att is “showed”) → step 11 (`c_show`)
- rescheduled → step 12 (`n1`)

<details><summary>Full step definition</summary>

```json
{
  "id": "b1",
  "title": "Where the setter card goes",
  "type": "branch"
}
```

</details>

### 8. Setter card → Cancelled / No Show, marked lost

- Step id `c_ns`, type `pipeline_card`
- Engine description: Move pipeline card
- Detail: In the setter board, stage Cancelled; marked lost; only if the card already exists
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Next:
- always → step 12 (`n1`)

<details><summary>Full step definition</summary>

```json
{
  "id": "c_ns",
  "title": "Setter card → Cancelled / No Show, marked lost",
  "type": "pipeline_card",
  "pipeline": "{{crm.pipeline_setter}}",
  "stage": "{{crm.stage_setter_cancelled}}",
  "status": "lost",
  "if_missing": "skip",
  "pick": "latest",
  "fields": []
}
```

</details>

### 9. Setter card → DQ, marked lost

- Step id `c_dq`, type `pipeline_card`
- Engine description: Move pipeline card
- Detail: In the setter board, stage DQ; marked lost; only if the card already exists
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Next:
- always → step 12 (`n1`)

<details><summary>Full step definition</summary>

```json
{
  "id": "c_dq",
  "title": "Setter card → DQ, marked lost",
  "type": "pipeline_card",
  "pipeline": "{{crm.pipeline_setter}}",
  "stage": "{{crm.stage_setter_dq}}",
  "status": "lost",
  "if_missing": "skip",
  "pick": "latest",
  "fields": []
}
```

</details>

### 10. Setter card → Not Interested, marked lost

- Step id `c_ni`, type `pipeline_card`
- Engine description: Move pipeline card
- Detail: In the setter board, stage Not Interested; marked lost; only if the card already exists
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Next:
- always → step 12 (`n1`)

<details><summary>Full step definition</summary>

```json
{
  "id": "c_ni",
  "title": "Setter card → Not Interested, marked lost",
  "type": "pipeline_card",
  "pipeline": "{{crm.pipeline_setter}}",
  "stage": "{{crm.stage_setter_not_interested}}",
  "status": "lost",
  "if_missing": "skip",
  "pick": "latest",
  "fields": []
}
```

</details>

### 11. Setter card → Showed, won (set or follow up)

- Step id `c_show`, type `pipeline_card`
- Engine description: Move pipeline card
- Detail: In the setter board, stage Showed; marked won; only if the card already exists
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Next:
- always → step 12 (`n1`)

<details><summary>Full step definition</summary>

```json
{
  "id": "c_show",
  "title": "Setter card → Showed, won (set or follow up)",
  "type": "pipeline_card",
  "pipeline": "{{crm.pipeline_setter}}",
  "stage": "{{crm.stage_setter_showed}}",
  "status": "won",
  "if_missing": "skip",
  "pick": "latest",
  "fields": []
}
```

</details>

### 12. A line in the booking thread

- Step id `n1`, type `slack_post`
- Engine description: Reply in the thread of that Slack post
- Runs only if: line is not blank (otherwise skipped)
- Goes to: channel {{slack.channel.bookings}}; in the thread of tag:appointment:{{appointment.id}}; thread only; posted as "Triage call"
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Slack post:

```
{{vars.line}}
```

Next:
- always → step 13 (`x1`)

<details><summary>Full step definition</summary>

```json
{
  "id": "n1",
  "title": "A line in the booking thread",
  "only_if": {
    "neq": [
      "{{vars.line}}",
      ""
    ]
  },
  "type": "slack_post",
  "channel": "{{slack.channel.bookings}}",
  "template": "{{vars.line}}",
  "as": {
    "name": "Triage call",
    "icon": ":clipboard:"
  },
  "thread_of": "tag:appointment:{{appointment.id}}",
  "thread_only": true,
  "edit": false,
  "label": "mode"
}
```

</details>

### 13. Stop: filed

- Step id `x1`, type `exit`

Next: the run ends here.

<details><summary>Full step definition</summary>

```json
{
  "id": "x1",
  "type": "exit",
  "reason": "filed"
}
```

</details>

## Settings this workflow reads

| Key | Kind | Required to enable | Value |
| --- | --- | --- | --- |
| `crm.location_id` | id | yes | not read (repo) |
| `crm.object_discovery_call` | id | no | not read (repo) |
| `crm.pipeline_setter` | id | yes | not read (repo) |
| `crm.stage_setter_cancelled` | id | yes | not read (repo) |
| `crm.stage_setter_dq` | id | yes | not read (repo) |
| `crm.stage_setter_not_interested` | id | yes | not read (repo) |
| `crm.stage_setter_showed` | id | yes | not read (repo) |
| `slack.channel.bookings` | channel | no | not read (repo) |

## Engine rules that apply but are not steps

These act on every run of this workflow from engine code. They are not in the definition above.

- **Mode.** The workflow's own mode, else the offer's, decides what is real: ghost writes and sends nothing, test is real only for test contacts, quiet writes the CRM but reaches no contact, live is real. (platform/src/engine/mode.ts:23, platform/src/engine/mode.ts:55)
- **Runs again?** A run's key is built from the re-entry policy; a second trigger with the same key starts nothing. A run that stops at a gate does not count. (platform/src/engine/reentry.ts:6)
- **Premise re-check.** Before each step the engine reads the CRM live; when "contact exists" no longer holds, the run exits. (platform/src/engine/runner.ts:33)
- **Failures.** Errors are sorted into transient, auth, permanent and unknown. A step is retried after 1 and 5 minutes; then a non-blocking step is skipped and a blocking one is held and looked at again after 15 minutes, then hourly. An auth or permanent failure pauses the run until it is fixed. (platform/src/engine/failures.ts:19, platform/src/engine/failures.ts:21, platform/src/engine/blocking.ts:58)
- **Step cap.** At most 50 steps run in one go; a run past that fails. After an outage, at most 20 sends per offer per tick. (platform/src/engine/runner.ts:21, platform/src/engine/runner.ts:27)
- **CRM writes** without a natural key (notes, tasks, cards, records) are claimed once per run and step so a retry never writes twice. In ghost mode they are skipped. (platform/src/engine/effects.ts:13)
- **Slack before live.** Until the workflow is live, every post goes to the offer's test channel with a ghost/test label, unless `slack.live` is set. (platform/src/engine/mode.ts:32, platform/src/engine/mode.ts:34)
