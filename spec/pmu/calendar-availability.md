# Calendar availability

Offer: **PMU** (`pmu`). Source: live database. Generated 2026-10-21.

| Setting | Value |
| --- | --- |
| Where this definition came from | live: version 1, saved 2026-10-13T18:29:28.700Z (installed from template) |
| Template | `calendar-availability` v1 |
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

### 1. On a schedule: every hour

- Step id `t_hourly`, type `trigger`

Next:
- always → step 5 (`n1`)

<details><summary>Full step definition</summary>

```json
{
  "id": "t_hourly",
  "type": "trigger",
  "event": "schedule",
  "schedule": {
    "every": "60m",
    "for": "company"
  }
}
```

</details>

### 2. Appointment booked

- Step id `t_booked`, type `trigger`

Next:
- always → step 5 (`n1`)

<details><summary>Full step definition</summary>

```json
{
  "id": "t_booked",
  "type": "trigger",
  "event": "appointment.booked"
}
```

</details>

### 3. Appointment rescheduled

- Step id `t_moved`, type `trigger`

Next:
- always → step 5 (`n1`)

<details><summary>Full step definition</summary>

```json
{
  "id": "t_moved",
  "type": "trigger",
  "event": "appointment.rescheduled"
}
```

</details>

### 4. An appointment's status changed

- Step id `t_status`, type `trigger`

Next:
- always → step 5 (`n1`)

<details><summary>Full step definition</summary>

```json
{
  "id": "t_status",
  "type": "trigger",
  "event": "appointment.status_changed"
}
```

</details>

### 5. Check bookable slots: fewer than 3 in the next 7 days is an alert

- Step id `n1`, type `availability_check`
- Detail: Every active calendar; in a run about a booking, that booking's calendar
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Next:
- always → step 6 (`x_done`)

<details><summary>Full step definition</summary>

```json
{
  "id": "n1",
  "type": "availability_check",
  "min_slots": 3,
  "days": 7
}
```

</details>

### 6. Done

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

## Engine rules that apply but are not steps

These act on every run of this workflow from engine code. They are not in the definition above.

- **Mode.** The workflow's own mode, else the offer's, decides what is real: ghost writes and sends nothing, test is real only for test contacts, quiet writes the CRM but reaches no contact, live is real. (platform/src/engine/mode.ts:23, platform/src/engine/mode.ts:55)
- **Runs again?** A run's key is built from the re-entry policy; a second trigger with the same key starts nothing. A run that stops at a gate does not count. (platform/src/engine/reentry.ts:6)
- **Failures.** Errors are sorted into transient, auth, permanent and unknown. A step is retried after 1 and 5 minutes; then a non-blocking step is skipped and a blocking one is held and looked at again after 15 minutes, then hourly. An auth or permanent failure pauses the run until it is fixed. (platform/src/engine/failures.ts:19, platform/src/engine/failures.ts:21, platform/src/engine/blocking.ts:58)
- **Step cap.** At most 50 steps run in one go; a run past that fails. After an outage, at most 20 sends per offer per tick. (platform/src/engine/runner.ts:21, platform/src/engine/runner.ts:27)
