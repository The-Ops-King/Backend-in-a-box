# New from Typeform

Offer: **Dating (Nelly)** (`dating-nelly`). Source: **from repo, may differ from live**. Generated 2026-10-21.

| Setting | Value |
| --- | --- |
| Where this definition came from | the offer's own workflow: platform/installs/dating-nelly/new-from-typeform.json |
| Template | none (the offer's own workflow) |
| Edited since copied from the template | unknown (repo) |
| Saved version | unknown (repo) |
| Enabled | unknown (repo) |
| Mode | follows the offer (quiet) |
| Send lock | unknown (repo) |
| Runs again for the same person | always |
| Re-checked before every step | contact exists |
| Send window | the offer's (unknown in repo) |
| Steps | 4 |
| Note | dating-nelly: an application (form.submitted, D122) puts the person in the offer with the tag dating and starts New lead once, if they are not a lead yet (D123) |

## Steps

Every step, in the order a run meets it from the trigger. Steps that only assemble words (`set_var`) are listed too.

### 1. A form was submitted

- Step id `t1`, type `trigger`

Next:
- always → step 2 (`n1`)

<details><summary>Full step definition</summary>

```json
{
  "id": "t1",
  "type": "trigger",
  "event": "form.submitted"
}
```

</details>

### 2. Into the offer: the tag dating

- Step id `n1`, type `tags`
- Engine description: Tags “+dating”
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Next:
- always → step 3 (`n2`)

<details><summary>Full step definition</summary>

```json
{
  "id": "n1",
  "title": "Into the offer: the tag dating",
  "type": "tags",
  "add": [
    "dating"
  ]
}
```

</details>

### 3. Start New lead, once a person

- Step id `n2`, type `record`
- Engine description: Record: A new lead is added in GHL
- Detail: An event in the ledger with ghl contact id, form id, response id, by; it starts the workflows that listen for it (once)
- Runs only if: they are not a lead (otherwise skipped)
- If it keeps failing: the run is held on this step (it is the run's own ledger)

Next:
- always → step 4 (`x1`)

<details><summary>Full step definition</summary>

```json
{
  "id": "n2",
  "title": "Start New lead, once a person",
  "only_if": {
    "eq": [
      "{{contact.is_lead}}",
      false
    ]
  },
  "type": "record",
  "event": "lead.created",
  "data": {
    "ghl_contact_id": "{{contact.ghl_contact_id | default:}}",
    "form_id": "{{event.form_id}}",
    "response_id": "{{event.response_id}}",
    "by": "form"
  },
  "start": true
}
```

</details>

### 4. Done

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
| `crm.location_id` | id | yes | not read (repo) |

## Engine rules that apply but are not steps

These act on every run of this workflow from engine code. They are not in the definition above.

- **Mode.** The workflow's own mode, else the offer's, decides what is real: ghost writes and sends nothing, test is real only for test contacts, quiet writes the CRM but reaches no contact, live is real. (platform/src/engine/mode.ts:23, platform/src/engine/mode.ts:55)
- **Runs again?** A run's key is built from the re-entry policy; a second trigger with the same key starts nothing. A run that stops at a gate does not count. (platform/src/engine/reentry.ts:6)
- **Premise re-check.** Before each step the engine reads the CRM live; when "contact exists" no longer holds, the run exits. (platform/src/engine/runner.ts:33)
- **Failures.** Errors are sorted into transient, auth, permanent and unknown. A step is retried after 1 and 5 minutes; then a non-blocking step is skipped and a blocking one is held and looked at again after 15 minutes, then hourly. An auth or permanent failure pauses the run until it is fixed. (platform/src/engine/failures.ts:19, platform/src/engine/failures.ts:21, platform/src/engine/blocking.ts:58)
- **Step cap.** At most 50 steps run in one go; a run past that fails. After an outage, at most 20 sends per offer per tick. (platform/src/engine/runner.ts:21, platform/src/engine/runner.ts:27)
- **CRM writes** without a natural key (notes, tasks, cards, records) are claimed once per run and step so a retry never writes twice. In ghost mode they are skipped. (platform/src/engine/effects.ts:13)
