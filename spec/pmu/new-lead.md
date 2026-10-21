# New lead

Offer: **PMU** (`pmu`). Source: live database. Generated 2026-10-21.

| Setting | Value |
| --- | --- |
| Where this definition came from | live: version 2, saved 2026-10-13T21:44:57.674Z (PMU: one board. The card starts on Beauty Moguls at New Lead; a lead has a phone or a VSL tag (vsl a / vsl b); no stage-entered field) |
| Template | `new-lead` v3 |
| Edited since copied from the template | yes |
| Saved version | 2 |
| Enabled | on |
| Mode | follows the offer (ghost) |
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

### 2. A lead has a phone number or a VSL tag (vsl a, vsl b)

- Step id `n1`, type `check`
- Engine description: Check there is a phone number or tags include “vsl a” or tags include “vsl b”
- Detail: Waits up to 24 hours for it, looking every 10 minutes. Otherwise the run stops: no phone or vsl
- If it keeps failing: the run is held on this step (it decides whether the run goes on)

Next:
- always → step 3 (`n2`)

<details><summary>Full step definition</summary>

```json
{
  "id": "n1",
  "title": "A lead has a phone number or a VSL tag (vsl a, vsl b)",
  "type": "check",
  "when": {
    "or": [
      {
        "exists": "contact.phone"
      },
      {
        "has": [
          "{{contact.tags}}",
          "vsl a"
        ]
      },
      {
        "has": [
          "{{contact.tags}}",
          "vsl b"
        ]
      }
    ]
  },
  "else_exit": "no_phone_or_vsl",
  "retry": {
    "every": "10m",
    "for": "24h"
  }
}
```

</details>

### 3. Create or move pipeline card “[full name] -- New”

- Step id `n2`, type `pipeline_card`
- Detail: In the closer board, stage New Lead
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Next:
- always → step 4 (`n3`)

<details><summary>Full step definition</summary>

```json
{
  "id": "n2",
  "type": "pipeline_card",
  "pipeline": "{{crm.pipeline_closer}}",
  "stage": "{{crm.stage_closer_new_lead}}",
  "name": "{{contact.name}} -- New",
  "if_missing": "create",
  "pick": "open",
  "fields": []
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
| `crm.location_id` | id | yes | `gA10c58jLJRYbNwC3apW` |
| `crm.pipeline_closer` | id | yes | `1B37Vzv6euKMpWaFFuVW` |
| `crm.stage_closer_new_lead` | id | yes | `7dc8ac43-8b8a-4db7-bc13-ff73c7a326de` |

## Engine rules that apply but are not steps

These act on every run of this workflow from engine code. They are not in the definition above.

- **Mode.** The workflow's own mode, else the offer's, decides what is real: ghost writes and sends nothing, test is real only for test contacts, quiet writes the CRM but reaches no contact, live is real. (platform/src/engine/mode.ts:23, platform/src/engine/mode.ts:55)
- **Runs again?** A run's key is built from the re-entry policy; a second trigger with the same key starts nothing. A run that stops at a gate does not count. (platform/src/engine/reentry.ts:6)
- **Premise re-check.** Before each step the engine reads the CRM live; when "contact exists" no longer holds, the run exits. (platform/src/engine/runner.ts:33)
- **Failures.** Errors are sorted into transient, auth, permanent and unknown. A step is retried after 1 and 5 minutes; then a non-blocking step is skipped and a blocking one is held and looked at again after 15 minutes, then hourly. An auth or permanent failure pauses the run until it is fixed. (platform/src/engine/failures.ts:19, platform/src/engine/failures.ts:21, platform/src/engine/blocking.ts:58)
- **Step cap.** At most 50 steps run in one go; a run past that fails. After an outage, at most 20 sends per offer per tick. (platform/src/engine/runner.ts:21, platform/src/engine/runner.ts:27)
- **CRM writes** without a natural key (notes, tasks, cards, records) are claimed once per run and step so a retry never writes twice. In ghost mode they are skipped. (platform/src/engine/effects.ts:13)
