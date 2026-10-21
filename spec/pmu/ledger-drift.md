# Ledger drift

Offer: **PMU** (`pmu`). Source: live database. Generated 2026-10-21.

| Setting | Value |
| --- | --- |
| Where this definition came from | live: version 1, saved 2026-10-13T18:29:28.700Z (installed from template) |
| Template | `ledger-drift` v1 |
| Edited since copied from the template | no |
| Saved version | 1 |
| Enabled | off |
| Mode | follows the offer (ghost) |
| Send lock | locked: texts, emails, documents and webhooks reach only the operator's own addresses |
| Runs again for the same person | always |
| Re-checked before every step | nothing |
| Send window | 08:00 to 20:00, the contact's time zone |
| Steps | 6 |

## Steps

Every step, in the order a run meets it from the trigger. Steps that only assemble words (`set_var`) are listed too.

### 1. A Sales Call in GHL needs marking cancelled (its booking was cancelled)

- Step id `t_cancel`, type `trigger`

Next:
- always → step 3 (`b1`)

<details><summary>Full step definition</summary>

```json
{
  "id": "t_cancel",
  "type": "trigger",
  "event": "drift.sales_call_cancelled"
}
```

</details>

### 2. A Sales Call in GHL needs linking to its contact or closer card

- Step id `t_link`, type `trigger`

Next:
- always → step 3 (`b1`)

<details><summary>Full step definition</summary>

```json
{
  "id": "t_link",
  "type": "trigger",
  "event": "drift.sales_call_unlinked"
}
```

</details>

### 3. Which repair?

- Step id `b1`, type `branch`
- Engine description: Which way?
- If it keeps failing: the run is held on this step (it decides where the run goes)

Next:
- cancelled before the call (when this is “drift sales call cancelled”) → step 4 (`r_cancel`)
- not linked → step 5 (`r_link`)

<details><summary>Full step definition</summary>

```json
{
  "id": "b1",
  "title": "Which repair?",
  "type": "branch"
}
```

</details>

### 4. Set the Sales Call cancelled in GHL

- Step id `r_cancel`, type `crm_record`
- Engine description: Update sales call record
- Detail: The CRM's own record [the record the form names], made outside the engine; never creates one; 1 fields
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Next:
- always → step 6 (`x1`)

<details><summary>Full step definition</summary>

```json
{
  "id": "r_cancel",
  "title": "Set the Sales Call cancelled in GHL",
  "type": "crm_record",
  "object": "{{crm.object_sales_call}}",
  "record_id": "{{event.record_id}}",
  "properties": {
    "outcome": "{{event.cancelled_value}}"
  },
  "if_missing": "create",
  "relate": [],
  "clear": []
}
```

</details>

### 5. Link the Sales Call to its contact and closer card

- Step id `r_link`, type `crm_record`
- Engine description: Update sales call record
- Detail: The CRM's own record [the record the form names], made outside the engine; never creates one; 2 fields; linked to 2 related records
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Next:
- always → step 6 (`x1`)

<details><summary>Full step definition</summary>

```json
{
  "id": "r_link",
  "title": "Link the Sales Call to its contact and closer card",
  "type": "crm_record",
  "object": "{{crm.object_sales_call}}",
  "record_id": "{{event.record_id}}",
  "properties": {
    "contact_id": "{{event.contact_field | default:}}",
    "opportunity_id": "{{event.card_id | default:}}"
  },
  "if_missing": "create",
  "relate": [
    {
      "association": "{{crm.assoc_sales_call_contact | default:}}",
      "first": "{{event.contact_field | default:}}",
      "second": "{{event.record_id}}"
    },
    {
      "association": "{{crm.assoc_sales_call_opportunity | default:}}",
      "first": "{{event.record_id}}",
      "second": "{{event.card_id | default:}}"
    }
  ],
  "clear": []
}
```

</details>

### 6. Stop: repaired

- Step id `x1`, type `exit`

Next: the run ends here.

<details><summary>Full step definition</summary>

```json
{
  "id": "x1",
  "type": "exit",
  "reason": "repaired"
}
```

</details>

## Settings this workflow reads

| Key | Kind | Required to enable | Value |
| --- | --- | --- | --- |
| `crm.assoc_sales_call_contact` | id | no | `6ab44fe67f8a0a87bc8a542d` |
| `crm.assoc_sales_call_opportunity` | id | no | `6ace9cd588661082b9b4aa71` |
| `crm.location_id` | id | yes | `gA10c58jLJRYbNwC3apW` |
| `crm.object_sales_call` | id | yes | `custom_objects.sales_call` |

## Engine rules that apply but are not steps

These act on every run of this workflow from engine code. They are not in the definition above.

- **Mode.** The workflow's own mode, else the offer's, decides what is real: ghost writes and sends nothing, test is real only for test contacts, quiet writes the CRM but reaches no contact, live is real. (platform/src/engine/mode.ts:23, platform/src/engine/mode.ts:55)
- **Runs again?** A run's key is built from the re-entry policy; a second trigger with the same key starts nothing. A run that stops at a gate does not count. (platform/src/engine/reentry.ts:6)
- **Failures.** Errors are sorted into transient, auth, permanent and unknown. A step is retried after 1 and 5 minutes; then a non-blocking step is skipped and a blocking one is held and looked at again after 15 minutes, then hourly. An auth or permanent failure pauses the run until it is fixed. (platform/src/engine/failures.ts:19, platform/src/engine/failures.ts:21, platform/src/engine/blocking.ts:58)
- **Step cap.** At most 50 steps run in one go; a run past that fails. After an outage, at most 20 sends per offer per tick. (platform/src/engine/runner.ts:21, platform/src/engine/runner.ts:27)
- **CRM writes** without a natural key (notes, tasks, cards, records) are claimed once per run and step so a retry never writes twice. In ghost mode they are skipped. (platform/src/engine/effects.ts:13)
