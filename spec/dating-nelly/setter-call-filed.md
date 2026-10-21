# Setter call filed

Offer: **Dating (Nelly)** (`dating-nelly`). Source: live database. Generated 2026-10-21.

| Setting | Value |
| --- | --- |
| Where this definition came from | live: version 2, saved 2026-10-19T22:02:58.943Z (D186 (Tyler): the end of day's notes and why a DQ go on the Discovery Call record) |
| Template | none (the offer's own workflow) |
| Edited since copied from the template | yes |
| Saved version | 2 |
| Enabled | on |
| Mode | live |
| Send lock | locked: texts, emails, documents and webhooks reach only the operator's own addresses |
| Runs again for the same person | always |
| Re-checked before every step | contact exists |
| Send window | 08:00 to 20:00, the contact's time zone |
| Steps | 9 |

## Steps

Every step, in the order a run meets it from the trigger. Steps that only assemble words (`set_var`) are listed too.

### 1. An outbound call answered on the end of day

- Step id `t1`, type `trigger`
- Engine description: A setter answered an outbound call on their end of day

Next:
- always → step 2 (`v_line`)

<details><summary>Full step definition</summary>

```json
{
  "id": "t1",
  "title": "An outbound call answered on the end of day",
  "type": "trigger",
  "event": "setter_call.filed"
}
```

</details>

### 2. The thread line

- Step id `v_line`, type `set_var`
- Engine description: Remember line, picked by [result]
- Detail: dq → ⛔ End of day: DQ; set → ✅ End of day: set; follow up → 🔁 End of day: follow up; not interested → 👋 End of day: not interested; otherwise 
- If it keeps failing: the run is held on this step (later steps read what it remembers)

Next:
- always → step 3 (`d1`)

<details><summary>Full step definition</summary>

```json
{
  "id": "v_line",
  "title": "The thread line",
  "type": "set_var",
  "key": "line",
  "value": "{{event.result}}",
  "pick": {
    "dq": "⛔ End of day: DQ",
    "set": "✅ End of day: set",
    "follow_up": "🔁 End of day: follow up",
    "not_interested": "👋 End of day: not interested"
  },
  "else_value": ""
}
```

</details>

### 3. The call's Discovery Call record

- Step id `d1`, type `crm_record`
- Engine description: Write discovery call record
- Detail: Keyed by conversation; 12 fields; linked to 1 related record; empties dq reason unless this answer sets them
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Next:
- always → step 4 (`b1`)

<details><summary>Full step definition</summary>

```json
{
  "id": "d1",
  "title": "The call's Discovery Call record",
  "type": "crm_record",
  "object": "{{crm.object_discovery_call | default:custom_objects.discovery_call}}",
  "key": "{{event.conversation}}",
  "properties": {
    "notes": "{{event.note | default:}}",
    "setter": "{{event.setter | default:}}",
    "outcome": "showed",
    "direction": "{{event.direction | default:}}",
    "dq_reason": "{{event.dq_reason | default:}}",
    "contact_id": "{{contact.ghl_contact_id | default:}}",
    "call_result": "{{event.result}}",
    "external_id": "{{event.conversation}}",
    "occurred_at": "{{event.started_at | date_company}}",
    "duration_sec": "{{event.duration_sec | default:}}",
    "display_label": "{{contact.name | default:Unknown}} — {{event.started_at | date_company:yyyy-MM-dd}}",
    "recording_url": "{{event.recording_url | default:}}"
  },
  "owner": "{{event.setter_ghl_user_id | default:}}",
  "if_missing": "create",
  "relate": [
    {
      "association": "{{crm.assoc_discovery_call_contact}}",
      "first": "{{contact.ghl_contact_id | default:}}",
      "second": "{{record.id}}"
    }
  ],
  "clear": [
    "dq_reason"
  ]
}
```

</details>

### 4. Where the setter card goes

- Step id `b1`, type `branch`
- Engine description: Which way?
- If it keeps failing: the run is held on this step (it decides where the run goes)

Next:
- set (when result is “set”) → step 5 (`c_set`)
- DQ (when result is disqualified) → step 6 (`c_dq`)
- not interested (when result is “not interested”) → step 7 (`c_ni`)
- follow up → step 8 (`n1`)

<details><summary>Full step definition</summary>

```json
{
  "id": "b1",
  "title": "Where the setter card goes",
  "type": "branch"
}
```

</details>

### 5. Setter card → Appointment Set

- Step id `c_set`, type `pipeline_card`
- Engine description: Move pipeline card
- Detail: In the setter board, stage Appointment Set; only if the card already exists
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Next:
- always → step 8 (`n1`)

<details><summary>Full step definition</summary>

```json
{
  "id": "c_set",
  "title": "Setter card → Appointment Set",
  "type": "pipeline_card",
  "pipeline": "{{crm.pipeline_setter}}",
  "stage": "{{crm.stage_setter_appointment_set}}",
  "if_missing": "skip",
  "pick": "latest",
  "fields": []
}
```

</details>

### 6. Setter card → DQ, marked lost

- Step id `c_dq`, type `pipeline_card`
- Engine description: Move pipeline card
- Detail: In the setter board, stage DQ; marked lost; only if the card already exists
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Next:
- always → step 8 (`n1`)

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

### 7. Setter card → Not Interested, marked lost

- Step id `c_ni`, type `pipeline_card`
- Engine description: Move pipeline card
- Detail: In the setter board, stage Not Interested; marked lost; only if the card already exists
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Next:
- always → step 8 (`n1`)

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

### 8. A line under the call's post

- Step id `n1`, type `slack_post`
- Engine description: Reply in the thread of that Slack post
- Runs only if: line is not blank (otherwise skipped)
- Goes to: channel {{slack.channel.setter_calls}}; in the thread of tag:setter-call:{{event.conversation}}; thread only; posted as "Setter call"
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Slack post:

```
{{vars.line}}
```

Next:
- always → step 9 (`x1`)

<details><summary>Full step definition</summary>

```json
{
  "id": "n1",
  "title": "A line under the call's post",
  "only_if": {
    "neq": [
      "{{vars.line}}",
      ""
    ]
  },
  "type": "slack_post",
  "channel": "{{slack.channel.setter_calls}}",
  "template": "{{vars.line}}",
  "as": {
    "name": "Setter call",
    "icon": ":clipboard:"
  },
  "thread_of": "tag:setter-call:{{event.conversation}}",
  "thread_only": true,
  "edit": false,
  "label": "mode"
}
```

</details>

### 9. Stop: filed

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
| `crm.assoc_discovery_call_contact` | id | yes | `6ad17a5fceaa91122182cbe8` |
| `crm.location_id` | id | yes | `eLfhuKEaVMlrpLm2Fz8V` |
| `crm.object_discovery_call` | id | no | `custom_objects.dating_discovery` |
| `crm.pipeline_setter` | id | yes | `N59nJLRaspsNwiaPWtE8` |
| `crm.stage_setter_appointment_set` | id | yes | `cdecc4fc-3865-446b-b663-9f432a90323e` |
| `crm.stage_setter_dq` | id | yes | `49fa4f2a-b866-4850-9706-ee0ff63f7c15` |
| `crm.stage_setter_not_interested` | id | yes | `82b55b7f-f553-4de7-9441-2a431d65616d` |
| `slack.channel.setter_calls` | channel | no | `C0CB00CSDCG` |

## Engine rules that apply but are not steps

These act on every run of this workflow from engine code. They are not in the definition above.

- **Mode.** The workflow's own mode, else the offer's, decides what is real: ghost writes and sends nothing, test is real only for test contacts, quiet writes the CRM but reaches no contact, live is real. (platform/src/engine/mode.ts:23, platform/src/engine/mode.ts:55)
- **Runs again?** A run's key is built from the re-entry policy; a second trigger with the same key starts nothing. A run that stops at a gate does not count. (platform/src/engine/reentry.ts:6)
- **Premise re-check.** Before each step the engine reads the CRM live; when "contact exists" no longer holds, the run exits. (platform/src/engine/runner.ts:33)
- **Failures.** Errors are sorted into transient, auth, permanent and unknown. A step is retried after 1 and 5 minutes; then a non-blocking step is skipped and a blocking one is held and looked at again after 15 minutes, then hourly. An auth or permanent failure pauses the run until it is fixed. (platform/src/engine/failures.ts:19, platform/src/engine/failures.ts:21, platform/src/engine/blocking.ts:58)
- **Step cap.** At most 50 steps run in one go; a run past that fails. After an outage, at most 20 sends per offer per tick. (platform/src/engine/runner.ts:21, platform/src/engine/runner.ts:27)
- **CRM writes** without a natural key (notes, tasks, cards, records) are claimed once per run and step so a retry never writes twice. In ghost mode they are skipped. (platform/src/engine/effects.ts:13)
- **Slack before live.** Until the workflow is live, every post goes to the offer's test channel with a ghost/test label, unless `slack.live` is set. (platform/src/engine/mode.ts:32, platform/src/engine/mode.ts:34)
