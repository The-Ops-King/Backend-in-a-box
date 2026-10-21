# New lead

Offer: **Dating (Nelly)** (`dating-nelly`). Source: live database. Generated 2026-10-21.

| Setting | Value |
| --- | --- |
| Where this definition came from | live: version 1, saved 2026-10-16T01:31:32.059Z (installed from template) |
| Template | `new-lead` v3 |
| Edited since copied from the template | no |
| Saved version | 1 |
| Enabled | on |
| Mode | live |
| Send lock | locked: texts, emails, documents and webhooks reach only the operator's own addresses |
| Runs again for the same person | always |
| Re-checked before every step | contact exists |
| Send window | 08:00 to 20:00, the contact's time zone |
| Steps | 5 |

## Steps

Every step, in the order a run meets it from the trigger. Steps that only assemble words (`set_var`) are listed too.

### 1. A new lead is added in GHL

- Step id `t1`, type `trigger`

Next:
- always → step 2 (`n1`)

<details><summary>Full step definition</summary>

```json
{
  "id": "t1",
  "type": "trigger",
  "event": "lead.created"
}
```

</details>

### 2. Check there is a phone number

- Step id `n1`, type `check`
- Detail: Waits up to 24 hours for it, looking every 10 minutes. Otherwise the run stops: no phone number
- If it keeps failing: the run is held on this step (it decides whether the run goes on)

Next:
- always → step 3 (`n2`)

<details><summary>Full step definition</summary>

```json
{
  "id": "n1",
  "type": "check",
  "when": {
    "exists": "contact.phone"
  },
  "else_exit": "no_phone",
  "retry": {
    "every": "10m",
    "for": "24h"
  }
}
```

</details>

### 3. Create or move pipeline card “[full name] -- New”

- Step id `n2`, type `pipeline_card`
- Detail: In the setter board, stage New Lead; set stage entered = [today]
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Next:
- always → step 4 (`n3`)

<details><summary>Full step definition</summary>

```json
{
  "id": "n2",
  "type": "pipeline_card",
  "pipeline": "{{crm.pipeline_setter}}",
  "stage": "{{crm.stage_setter_new_lead}}",
  "name": "{{contact.name}} -- New",
  "if_missing": "create",
  "pick": "open",
  "fields": [
    {
      "id": "{{crm.field_opportunity_stage_entered}}",
      "value": "{{now | date:yyyy-MM-dd}}"
    }
  ]
}
```

</details>

### 4. Add tag “stat-new”

- Step id `n3`, type `set_tag`
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Next:
- always → step 5 (`x1`)

<details><summary>Full step definition</summary>

```json
{
  "id": "n3",
  "type": "set_tag",
  "tag": "stat-new"
}
```

</details>

### 5. Done

- Step id `x1`, type `exit`

Next: the run ends here.

<details><summary>Full step definition</summary>

```json
{
  "id": "x1",
  "type": "exit",
  "reason": "done"
}
```

</details>

## Settings this workflow reads

| Key | Kind | Required to enable | Value |
| --- | --- | --- | --- |
| `crm.field_opportunity_stage_entered` | id | yes | `pBQY7AMGMgjY8H3uibnE` |
| `crm.location_id` | id | yes | `eLfhuKEaVMlrpLm2Fz8V` |
| `crm.pipeline_setter` | id | yes | `N59nJLRaspsNwiaPWtE8` |
| `crm.stage_setter_new_lead` | id | yes | `e4044e0d-0622-45ff-83f0-13b1244b2aae` |

## Engine rules that apply but are not steps

These act on every run of this workflow from engine code. They are not in the definition above.

- **Mode.** The workflow's own mode, else the offer's, decides what is real: ghost writes and sends nothing, test is real only for test contacts, quiet writes the CRM but reaches no contact, live is real. (platform/src/engine/mode.ts:23, platform/src/engine/mode.ts:55)
- **Runs again?** A run's key is built from the re-entry policy; a second trigger with the same key starts nothing. A run that stops at a gate does not count. (platform/src/engine/reentry.ts:6)
- **Premise re-check.** Before each step the engine reads the CRM live; when "contact exists" no longer holds, the run exits. (platform/src/engine/runner.ts:33)
- **Failures.** Errors are sorted into transient, auth, permanent and unknown. A step is retried after 1 and 5 minutes; then a non-blocking step is skipped and a blocking one is held and looked at again after 15 minutes, then hourly. An auth or permanent failure pauses the run until it is fixed. (platform/src/engine/failures.ts:19, platform/src/engine/failures.ts:21, platform/src/engine/blocking.ts:58)
- **Step cap.** At most 50 steps run in one go; a run past that fails. After an outage, at most 20 sends per offer per tick. (platform/src/engine/runner.ts:21, platform/src/engine/runner.ts:27)
- **CRM writes** without a natural key (notes, tasks, cards, records) are claimed once per run and step so a retry never writes twice. In ghost mode they are skipped. (platform/src/engine/effects.ts:13)
