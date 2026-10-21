# Calendar availability

Offer: **Save Your Hair (Parungao)** (`hair`). Source: live database. Generated 2026-10-21.

| Setting | Value |
| --- | --- |
| Where this definition came from | live: version 2, saved 2026-10-20T14:54:15.674Z (Port from Nelly (engine/13 B2/B3): Calendar availability says its own alerts; Health check then skips them (B2 first)) |
| Template | `calendar-availability` v2 |
| Edited since copied from the template | no |
| Saved version | 2 |
| Enabled | on |
| Mode | live |
| Send lock | locked: texts, emails, documents and webhooks reach only the operator's own addresses |
| Runs again for the same person | always |
| Re-checked before every step | nothing |
| Send window | 08:00 to 20:00, the contact's time zone; transactional messages may go at any hour |
| Steps | 18 |

## Steps

Every step, in the order a run meets it from the trigger. Steps that only assemble words (`set_var`) are listed too.

### 1. On a schedule: every hour

- Step id `t_hourly`, type `trigger`

Next:
- always → step 8 (`n1`)

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
- always → step 8 (`n1`)

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
- always → step 8 (`n1`)

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
- always → step 8 (`n1`)

<details><summary>Full step definition</summary>

```json
{
  "id": "t_status",
  "type": "trigger",
  "event": "appointment.status_changed"
}
```

</details>

### 5. A calendar has too few open times

- Step id `t_araised`, type `trigger`
- Engine description: An alert is raised: something broke — topic is “availability”

Next:
- always → step 9 (`a_mark`)

<details><summary>Full step definition</summary>

```json
{
  "id": "t_araised",
  "title": "A calendar has too few open times",
  "type": "trigger",
  "event": "alert.raised",
  "match": {
    "eq": [
      "{{event.topic}}",
      "availability"
    ]
  }
}
```

</details>

### 6. …still open

- Step id `t_arepeated`, type `trigger`
- Engine description: An alert is still open (said again every hour until it is fixed) — topic is “availability”

Next:
- always → step 9 (`a_mark`)

<details><summary>Full step definition</summary>

```json
{
  "id": "t_arepeated",
  "title": "…still open",
  "type": "trigger",
  "event": "alert.repeated",
  "match": {
    "eq": [
      "{{event.topic}}",
      "availability"
    ]
  }
}
```

</details>

### 7. …cleared

- Step id `t_aresolved`, type `trigger`
- Engine description: An alert is fixed (cleared) — topic is “availability”

Next:
- always → step 9 (`a_mark`)

<details><summary>Full step definition</summary>

```json
{
  "id": "t_aresolved",
  "title": "…cleared",
  "type": "trigger",
  "event": "alert.resolved",
  "match": {
    "eq": [
      "{{event.topic}}",
      "availability"
    ]
  }
}
```

</details>

### 8. Check bookable slots: fewer than 3 in the next 7 days is an alert

- Step id `n1`, type `availability_check`
- Detail: Every active calendar; in a run about a booking, that booking's calendar
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Next:
- always → step 10 (`x_done`)

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

### 9. The mark: red for an error, yellow for a warning

- Step id `a_mark`, type `set_var`
- Engine description: Remember mark, picked by [level]
- Detail: error → 🔴; warning → 🟡; otherwise 🟡
- If it keeps failing: the run is held on this step (later steps read what it remembers)

Next:
- always → step 11 (`a_icon`)

<details><summary>Full step definition</summary>

```json
{
  "id": "a_mark",
  "title": "The mark: red for an error, yellow for a warning",
  "type": "set_var",
  "key": "mark",
  "value": "{{event.level}}",
  "pick": {
    "error": "🔴",
    "warning": "🟡"
  },
  "else_value": "🟡"
}
```

</details>

### 10. Done

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

### 11. The face by level

- Step id `a_icon`, type `set_var`
- Engine description: Remember icon, picked by [level]
- Detail: error → :rotating_light:; warning → :warning:; otherwise :warning:
- If it keeps failing: the run is held on this step (later steps read what it remembers)

Next:
- always → step 12 (`a_icon2`)

<details><summary>Full step definition</summary>

```json
{
  "id": "a_icon",
  "title": "The face by level",
  "type": "set_var",
  "key": "icon",
  "value": "{{event.level}}",
  "pick": {
    "error": ":rotating_light:",
    "warning": ":warning:"
  },
  "else_value": ":warning:"
}
```

</details>

### 12. The company's own alert face, when it set one

- Step id `a_icon2`, type `set_var`
- Engine description: Remember icon = [the company's own alert face]
- Detail: When there is a company's own alert face; otherwise [the alert's face]
- If it keeps failing: the run is held on this step (later steps read what it remembers)

Next:
- always → step 13 (`b_alert`)

<details><summary>Full step definition</summary>

```json
{
  "id": "a_icon2",
  "title": "The company's own alert face, when it set one",
  "type": "set_var",
  "key": "icon",
  "value": "{{event.as_icon}}",
  "when": {
    "exists": "event.as_icon"
  },
  "else_value": "{{vars.icon}}"
}
```

</details>

### 13. New, still open, or cleared?

- Step id `b_alert`, type `branch`
- Engine description: Which way?
- If it keeps failing: the run is held on this step (it decides where the run goes)

Next:
- new (when this is “alert raised”) → step 14 (`a_post`)
- still open (when this is “alert repeated”) → step 15 (`a_repeat`)
- cleared → step 16 (`a_resolve`)

<details><summary>Full step definition</summary>

```json
{
  "id": "b_alert",
  "title": "New, still open, or cleared?",
  "type": "branch"
}
```

</details>

### 14. Post it in the alerts channel, with Resolve and Pause

- Step id `a_post`, type `slack_post`
- Engine description: Post to Slack (Slack channel for the alert)
- Detail: with the buttons “Retry” (only if payment kind is “skipped”), “Resolve”, “Pause”
- Runs only if: there is a Slack channel for the alert (otherwise skipped)
- Goes to: channel {{event.channel}}; posted as "{{event.as_name | default:Engine alerts}}"; remembered as alert:{{event.alert_id}}
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Slack post:

```
{{vars.mark}} *{{event.company}} · Calendar availability*
{{event.text}}{{event.link | link:Open | line}}{{event.fix_link | each:" · <{{item}}|{{event.fix_label}}>"}}{{event.extra_link | each:"{{event.link | then:\" · \" | default:\"\\n\"}}<{{item}}|{{event.extra_label | default:Open}}>"}}
```

Button "Retry" (alert_retry, value):

```
{{event.alert_id}}
```

Button "Resolve" (alert_resolve, value):

```
{{event.alert_id}}
```

Button "Pause" (alert_pause, value):

```
{{event.alert_id}}
```

Next:
- always → step 17 (`a_thread`)

<details><summary>Full step definition</summary>

```json
{
  "id": "a_post",
  "title": "Post it in the alerts channel, with Resolve and Pause",
  "only_if": {
    "exists": "event.channel"
  },
  "type": "slack_post",
  "channel": "{{event.channel}}",
  "template": "{{vars.mark}} *{{event.company}} · Calendar availability*\n{{event.text}}{{event.link | link:Open | line}}{{event.fix_link | each:\" · <{{item}}|{{event.fix_label}}>\"}}{{event.extra_link | each:\"{{event.link | then:\\\" · \\\" | default:\\\"\\\\n\\\"}}<{{item}}|{{event.extra_label | default:Open}}>\"}}",
  "as": {
    "name": "{{event.as_name | default:Engine alerts}}",
    "icon": "{{vars.icon}}"
  },
  "thread_only": false,
  "tag": "alert:{{event.alert_id}}",
  "edit": false,
  "buttons": [
    {
      "text": "Retry",
      "action": "alert_retry",
      "value": "{{event.alert_id}}",
      "style": "primary",
      "only_if": {
        "eq": [
          "{{event.kind}}",
          "skipped"
        ]
      }
    },
    {
      "text": "Resolve",
      "action": "alert_resolve",
      "value": "{{event.alert_id}}"
    },
    {
      "text": "Pause",
      "action": "alert_pause",
      "value": "{{event.alert_id}}"
    }
  ],
  "label": "none"
}
```

</details>

### 15. Still open: a line in its thread

- Step id `a_repeat`, type `slack_post`
- Engine description: Reply in the thread of that Slack post
- Runs only if: there is a Slack channel for the alert (otherwise skipped)
- Goes to: channel {{event.channel}}; in the thread of tag:alert:{{event.alert_id}}; posted as "{{event.as_name | default:Engine alerts}}"
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Slack post:

```
{{vars.mark}} Still open after {{event.open_for}}: {{event.text | truncate:300}}{{event.thread | line}}
```

Next:
- always → step 18 (`x_alert`)

<details><summary>Full step definition</summary>

```json
{
  "id": "a_repeat",
  "title": "Still open: a line in its thread",
  "only_if": {
    "exists": "event.channel"
  },
  "type": "slack_post",
  "channel": "{{event.channel}}",
  "template": "{{vars.mark}} Still open after {{event.open_for}}: {{event.text | truncate:300}}{{event.thread | line}}",
  "as": {
    "name": "{{event.as_name | default:Engine alerts}}",
    "icon": "{{vars.icon}}"
  },
  "thread_of": "tag:alert:{{event.alert_id}}",
  "thread_only": false,
  "edit": false,
  "label": "none"
}
```

</details>

### 16. Cleared: resolved in its thread, ✅ on the first post

- Step id `a_resolve`, type `slack_post`
- Engine description: Reply in the thread of that Slack post
- Detail: reacts :white_check_mark: on it
- Runs only if: there is a Slack channel for the alert (otherwise skipped)
- Goes to: channel {{event.channel}}; in the thread of tag:alert:{{event.alert_id}}; thread only; posted as "{{event.as_name | default:Engine alerts}}"
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Slack post:

```
✅ Resolved after {{event.open_for}}: {{event.text | truncate:200}}
```

Next:
- always → step 18 (`x_alert`)

<details><summary>Full step definition</summary>

```json
{
  "id": "a_resolve",
  "title": "Cleared: resolved in its thread, ✅ on the first post",
  "only_if": {
    "exists": "event.channel"
  },
  "type": "slack_post",
  "channel": "{{event.channel}}",
  "template": "✅ Resolved after {{event.open_for}}: {{event.text | truncate:200}}",
  "as": {
    "name": "{{event.as_name | default:Engine alerts}}",
    "icon": "{{vars.icon}}"
  },
  "thread_of": "tag:alert:{{event.alert_id}}",
  "thread_only": true,
  "edit": false,
  "react": "white_check_mark",
  "label": "none"
}
```

</details>

### 17. The next days' open times under it

- Step id `a_thread`, type `slack_post`
- Engine description: Reply in the thread of that Slack post
- Runs only if: there is a detail for its thread (otherwise skipped)
- Goes to: channel {{event.channel}}; in the thread of a_post; thread only; posted as "{{event.as_name | default:Engine alerts}}"
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Slack post:

```
{{event.thread}}
```

Next:
- always → step 18 (`x_alert`)

<details><summary>Full step definition</summary>

```json
{
  "id": "a_thread",
  "title": "The next days' open times under it",
  "only_if": {
    "exists": "event.thread"
  },
  "type": "slack_post",
  "channel": "{{event.channel}}",
  "template": "{{event.thread}}",
  "as": {
    "name": "{{event.as_name | default:Engine alerts}}",
    "icon": "{{vars.icon}}"
  },
  "thread_of": "a_post",
  "thread_only": true,
  "edit": false,
  "label": "none"
}
```

</details>

### 18. Stop: said

- Step id `x_alert`, type `exit`

Next: the run ends here.

<details><summary>Full step definition</summary>

```json
{
  "id": "x_alert",
  "type": "exit",
  "reason": "said"
}
```

</details>

## Settings this workflow reads

| Key | Kind | Required to enable | Value |
| --- | --- | --- | --- |
| `crm.location_id` | id | yes | `WUtLNZJFg8QbFWyQhlH1` |

## Engine rules that apply but are not steps

These act on every run of this workflow from engine code. They are not in the definition above.

- **Mode.** The workflow's own mode, else the offer's, decides what is real: ghost writes and sends nothing, test is real only for test contacts, quiet writes the CRM but reaches no contact, live is real. (platform/src/engine/mode.ts:23, platform/src/engine/mode.ts:55)
- **Runs again?** A run's key is built from the re-entry policy; a second trigger with the same key starts nothing. A run that stops at a gate does not count. (platform/src/engine/reentry.ts:6)
- **Failures.** Errors are sorted into transient, auth, permanent and unknown. A step is retried after 1 and 5 minutes; then a non-blocking step is skipped and a blocking one is held and looked at again after 15 minutes, then hourly. An auth or permanent failure pauses the run until it is fixed. (platform/src/engine/failures.ts:19, platform/src/engine/failures.ts:21, platform/src/engine/blocking.ts:58)
- **Step cap.** At most 50 steps run in one go; a run past that fails. After an outage, at most 20 sends per offer per tick. (platform/src/engine/runner.ts:21, platform/src/engine/runner.ts:27)
- **Slack before live.** Until the workflow is live, every post goes to the offer's test channel with a ghost/test label, unless `slack.live` is set. (platform/src/engine/mode.ts:32, platform/src/engine/mode.ts:34)
