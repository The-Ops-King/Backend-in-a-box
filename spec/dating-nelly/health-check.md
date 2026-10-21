# Health check

Offer: **Dating (Nelly)** (`dating-nelly`). Source: **from repo, may differ from live**. Generated 2026-10-21.

| Setting | Value |
| --- | --- |
| Where this definition came from | shipped template: platform/src/templates/health-check.json (the offer's words, if any, are applied at install) |
| Template | `health-check` |
| Edited since copied from the template | unknown (repo) |
| Saved version | unknown (repo) |
| Enabled | unknown (repo) |
| Mode | follows the offer (quiet) |
| Send lock | unknown (repo) |
| Runs again for the same person | always |
| Re-checked before every step | nothing |
| Send window | the offer's (unknown in repo) |
| Steps | 19 |

## Steps

Every step, in the order a run meets it from the trigger. Steps that only assemble words (`set_var`) are listed too.

### 1. On a schedule: every hour

- Step id `t1`, type `trigger`

Next:
- always → step 5 (`n1`)

<details><summary>Full step definition</summary>

```json
{
  "id": "t1",
  "type": "trigger",
  "event": "schedule",
  "schedule": {
    "every": "60m",
    "for": "company"
  }
}
```

</details>

### 2. An alert is raised: something broke — topic is not “availability”

- Step id `t_raised`, type `trigger`

Next:
- always → step 6 (`a_mark`)

<details><summary>Full step definition</summary>

```json
{
  "id": "t_raised",
  "type": "trigger",
  "event": "alert.raised",
  "match": {
    "neq": [
      "{{event.topic}}",
      "availability"
    ]
  }
}
```

</details>

### 3. An alert is still open (said again every hour until it is fixed) — topic is not “availability”

- Step id `t_repeated`, type `trigger`

Next:
- always → step 6 (`a_mark`)

<details><summary>Full step definition</summary>

```json
{
  "id": "t_repeated",
  "type": "trigger",
  "event": "alert.repeated",
  "match": {
    "neq": [
      "{{event.topic}}",
      "availability"
    ]
  }
}
```

</details>

### 4. An alert is fixed (cleared) — topic is not “availability”

- Step id `t_resolved`, type `trigger`

Next:
- always → step 6 (`a_mark`)

<details><summary>Full step definition</summary>

```json
{
  "id": "t_resolved",
  "type": "trigger",
  "event": "alert.resolved",
  "match": {
    "neq": [
      "{{event.topic}}",
      "availability"
    ]
  }
}
```

</details>

### 5. Run the health checks

- Step id `n1`, type `health_check`
- Detail: Every check; failures become alerts
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Next:
- always → step 7 (`x_done`)

<details><summary>Full step definition</summary>

```json
{
  "id": "n1",
  "type": "health_check",
  "checks": {},
  "slots_days": 7,
  "fathom_silent_days": 14,
  "drift_days": 7,
  "poll_lag_min": 30
}
```

</details>

### 6. The mark: red for an error, yellow for a warning

- Step id `a_mark`, type `set_var`
- Engine description: Remember mark, picked by [level]
- Detail: error → 🔴; warning → 🟡; otherwise 🟡
- If it keeps failing: the run is held on this step (later steps read what it remembers)

Next:
- always → step 8 (`a_icon`)

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

### 7. Done

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

### 8. The face by level

- Step id `a_icon`, type `set_var`
- Engine description: Remember icon, picked by [level]
- Detail: error → :rotating_light:; warning → :warning:; otherwise :warning:
- If it keeps failing: the run is held on this step (later steps read what it remembers)

Next:
- always → step 9 (`a_icon2`)

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

### 9. The company's own alert face, when it set one

- Step id `a_icon2`, type `set_var`
- Engine description: Remember icon = [the company's own alert face]
- Detail: When there is a company's own alert face; otherwise [the alert's face]
- If it keeps failing: the run is held on this step (later steps read what it remembers)

Next:
- always → step 10 (`a_head`)

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

### 10. The headline for each kind of alert

- Step id `a_head`, type `set_var`
- Engine description: Remember head, picked by [payment kind]
- Detail: blocked → Step could not run; skipped → Step skipped; held → Run paused on a step; paused → Run needs a hand; auth → Token rejected; failed → Run failed; health → Health check; poll → Polling; engine → Engine; otherwise Engine
- If it keeps failing: the run is held on this step (later steps read what it remembers)

Next:
- always → step 11 (`a_were`)

<details><summary>Full step definition</summary>

```json
{
  "id": "a_head",
  "title": "The headline for each kind of alert",
  "type": "set_var",
  "key": "head",
  "value": "{{event.kind}}",
  "pick": {
    "blocked": "Step could not run",
    "skipped": "Step skipped",
    "held": "Run paused on a step",
    "paused": "Run needs a hand",
    "auth": "Token rejected",
    "failed": "Run failed",
    "health": "Health check",
    "poll": "Polling",
    "engine": "Engine"
  },
  "else_value": "Engine"
}
```

</details>

### 11. Ledger drift: one record fixed or several

- Step id `a_were`, type `set_var`
- Engine description: Remember drift were, picked by [detail fixed]
- Detail: 1 → it's; otherwise they've
- Runs only if: key is “health:ledger drift” (otherwise skipped)
- If it keeps failing: the run is held on this step (later steps read what it remembers)

Next:
- always → step 12 (`a_dhead`)

<details><summary>Full step definition</summary>

```json
{
  "id": "a_were",
  "title": "Ledger drift: one record fixed or several",
  "only_if": {
    "eq": [
      "{{event.key}}",
      "health:ledger_drift"
    ]
  },
  "type": "set_var",
  "key": "drift_were",
  "value": "{{event.detail.fixed}}",
  "pick": {
    "1": "it's"
  },
  "else_value": "they've"
}
```

</details>

### 12. Ledger drift: how the questions start

- Step id `a_dhead`, type `set_var`
- Engine description: Remember drift head, picked by [detail shape]
- Detail: fixed one → [detail fixed] in the engine didn't match GHL over the last [detail days] days; [the drift line's verb (it's or they've)] been updated from GHL. Except this one, which I have a question about:; fixed many → [detail fixed] in the engine didn't match GHL over the last [detail days] days; [the drift line's verb (it's or they've)] been updated from GHL. Except these, which I have questions about:; one → One thing in the engine doesn't match GHL and I have a question about it:; many → [detail count] things in the engine don't match GHL, which I have questions about:; otherwise 
- Runs only if: key is “health:ledger drift” (otherwise skipped)
- If it keeps failing: the run is held on this step (later steps read what it remembers)

Next:
- always → step 13 (`a_body`)

<details><summary>Full step definition</summary>

```json
{
  "id": "a_dhead",
  "title": "Ledger drift: how the questions start",
  "only_if": {
    "eq": [
      "{{event.key}}",
      "health:ledger_drift"
    ]
  },
  "type": "set_var",
  "key": "drift_head",
  "value": "{{event.detail.shape}}",
  "pick": {
    "fixed_one": "{{event.detail.fixed | plural:record}} in the engine didn't match GHL over the last {{event.detail.days}} days; {{vars.drift_were}} been updated from GHL.\nExcept this one, which I have a question about:",
    "fixed_many": "{{event.detail.fixed | plural:record}} in the engine didn't match GHL over the last {{event.detail.days}} days; {{vars.drift_were}} been updated from GHL.\nExcept these, which I have questions about:",
    "one": "One thing in the engine doesn't match GHL and I have a question about it:",
    "many": "{{event.detail.count}} things in the engine don't match GHL, which I have questions about:"
  },
  "else_value": ""
}
```

</details>

### 13. What the alert says (the ledger drift questions, worded here)

- Step id `a_body`, type `set_var`
- Engine description: Remember body = [the alert's text]
- Detail: When key is not “health:ledger drift”; otherwise [how the drift questions start][detail q missing, one line each][detail q setup, one line each][detail q disposition unmapped, one line each][detail q link contact, one line each][detail q link card, one line each][detail q link unhandled, one line each][detail q unmatched, one line each][detail q ambiguous, one line each][detail q cancel time unknown, one line each][detail q cancel held back, one line each][detail q cancel set back, one line each][detail q cancel no value, one line each][detail q cancel unhandled, one line each][detail q ledger write, one line each][detail q ghl unfiled, one line each][detail q won no payment, one line each][detail q payment no won, one line each][detail more, one line each]
- If it keeps failing: the run is held on this step (later steps read what it remembers)

Next:
- always → step 14 (`b_alert`)

<details><summary>Full step definition</summary>

```json
{
  "id": "a_body",
  "title": "What the alert says (the ledger drift questions, worded here)",
  "type": "set_var",
  "key": "body",
  "value": "{{event.text}}",
  "when": {
    "neq": [
      "{{event.key}}",
      "health:ledger_drift"
    ]
  },
  "else_value": "{{vars.drift_head}}{{event.detail.q.missing | each:\"\\n• {{item.name}} is in GHL but the engine couldn't pull them in ({{item.why}}). I'll try again next hour.\" | join:\"\"}}{{event.detail.q.setup | each:\"\\n• {{item.label}}: GHL says {{item.said}}, but the engine has no \\\"{{item.term}}\\\" outcome set up, so it can't follow. That's a setup fix on our side.\" | join:\"\"}}{{event.detail.q.disposition_unmapped | each:\"\\n• {{item.label}}: GHL's outcome is \\\"{{item.disposition}}\\\", and the engine hasn't been told what that means yet. That's a setup fix on our side.\" | join:\"\"}}{{event.detail.q.link_contact | each:\"\\n• {{item.label}}: this Sales Call isn't linked to its contact, and the engine doesn't know the person's GHL id. Who is it?\" | join:\"\"}}{{event.detail.q.link_card | each:\"\\n• {{item.label}}: this Sales Call isn't linked to a closer card, and the person has {{item.cards | nonzero | plural:\\\"closer card\\\" | default:none}}. Which card is it?\" | join:\"\"}}{{event.detail.q.link_unhandled | each:\"\\n• {{item.label}}: this Sales Call isn't linked to its contact or closer card, and no workflow is on to link it. Turn on Ledger drift, or link it in GHL?\" | join:\"\"}}{{event.detail.q.unmatched | each:\"\\n• {{item.label}}: GHL has this Sales Call, but the engine has no booking for that person at that time. Was it booked outside {{item.booking_source | default:the booking calendar}}, or moved?\" | join:\"\"}}{{event.detail.q.ambiguous | each:\"\\n• {{item.label}}: this Sales Call fits more than one booking in the engine, so I won't guess which. Which booking is it?\" | join:\"\"}}{{event.detail.q.cancel_time_unknown | each:\"\\n• {{item.label}}: {{item.booking_source}} says cancelled, GHL says {{item.ghl_said}}, and I can't tell when it was cancelled. Which is right?\" | join:\"\"}}{{event.detail.q.cancel_held_back | each:\"\\n• {{item.label}}: {{item.booking_source}} cancelled it before the call, but GHL still says {{item.ghl_said}} and I couldn't change it ({{item.mode}} mode: would set the outcome to \\\"{{item.value}}\\\"; nothing is written to the CRM for this contact yet). Set it to cancelled in GHL?\" | join:\"\"}}{{event.detail.q.cancel_set_back | each:\"\\n• {{item.label}}: {{item.booking_source}} cancelled it before the call, but GHL still says {{item.ghl_said}} and I couldn't change it (it was set once already and GHL says otherwise again; left for a person). Set it to cancelled in GHL?\" | join:\"\"}}{{event.detail.q.cancel_no_value | each:\"\\n• {{item.label}}: {{item.booking_source}} cancelled it before the call, but GHL still says {{item.ghl_said}} and I couldn't change it (no outcome value means cancelled (sales_call.outcomes)). Set it to cancelled in GHL?\" | join:\"\"}}{{event.detail.q.cancel_unhandled | each:\"\\n• {{item.label}}: {{item.booking_source}} cancelled it before the call, but GHL still says {{item.ghl_said}} and I couldn't change it (no workflow is on to write it). Set it to cancelled in GHL?\" | join:\"\"}}{{event.detail.q.ledger_write | each:\"\\n• {{item.label}}: the engine couldn't update the ledger ({{item.why}}). I'll try again next hour.\" | join:\"\"}}{{event.detail.q.ghl_unfiled | each:\"\\n• {{item.label}}: the engine has {{item.has}} but GHL's Sales Call has no outcome. Should GHL say {{item.has}}?\" | join:\"\"}}{{event.detail.q.won_no_payment | each:\"\\n• {{item.name}}: their closer card was won {{item.day}}, but GHL has no payment for them. Did they pay, or should the card not be won?\" | join:\"\"}}{{event.detail.q.payment_no_won | each:\"\\n• {{item.name}}: GHL has a ${{item.amount | money}} payment from {{item.day}} but no won closer card. Should their closer card be won?\" | join:\"\"}}{{event.detail.more | each:\"\\n…and {{item}} more on the dashboard.\"}}"
}
```

</details>

### 14. New, still open, or cleared?

- Step id `b_alert`, type `branch`
- Engine description: Which way?
- If it keeps failing: the run is held on this step (it decides where the run goes)

Next:
- new (when this is “alert raised”) → step 15 (`a_post`)
- still open (when this is “alert repeated”) → step 16 (`a_repeat`)
- cleared → step 17 (`a_resolve`)

<details><summary>Full step definition</summary>

```json
{
  "id": "b_alert",
  "title": "New, still open, or cleared?",
  "type": "branch"
}
```

</details>

### 15. Post the alert

- Step id `a_post`, type `slack_post`
- Engine description: Post to Slack (Slack channel for the alert)
- Detail: with the buttons “Retry” (only if payment kind is “skipped”), “Resolve”, “Pause”
- Runs only if: there is a Slack channel for the alert (otherwise skipped)
- Goes to: channel {{event.channel}}; posted as "{{event.as_name | default:Engine alerts}}"; remembered as alert:{{event.alert_id}}
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Slack post:

```
{{vars.mark}} *{{event.company}} · {{vars.head}}*
{{vars.body}}{{event.link | link:Open | line}}{{event.fix_link | each:" · <{{item}}|{{event.fix_label}}>"}}{{event.extra_link | each:"{{event.link | then:\" · \" | default:\"\\n\"}}<{{item}}|{{event.extra_label | default:Open}}>"}}
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
- always → step 18 (`a_thread`)

<details><summary>Full step definition</summary>

```json
{
  "id": "a_post",
  "title": "Post the alert",
  "only_if": {
    "exists": "event.channel"
  },
  "type": "slack_post",
  "channel": "{{event.channel}}",
  "template": "{{vars.mark}} *{{event.company}} · {{vars.head}}*\n{{vars.body}}{{event.link | link:Open | line}}{{event.fix_link | each:\" · <{{item}}|{{event.fix_label}}>\"}}{{event.extra_link | each:\"{{event.link | then:\\\" · \\\" | default:\\\"\\\\n\\\"}}<{{item}}|{{event.extra_label | default:Open}}>\"}}",
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

### 16. Still open: a line in its thread

- Step id `a_repeat`, type `slack_post`
- Engine description: Reply in the thread of that Slack post
- Runs only if: there is a Slack channel for the alert (otherwise skipped)
- Goes to: channel {{event.channel}}; in the thread of tag:alert:{{event.alert_id}}; posted as "{{event.as_name | default:Engine alerts}}"
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Slack post:

```
{{vars.mark}} Still open after {{event.open_for}}: {{vars.body | truncate:300}}{{event.thread | line}}
```

Next:
- always → step 19 (`x_alert`)

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
  "template": "{{vars.mark}} Still open after {{event.open_for}}: {{vars.body | truncate:300}}{{event.thread | line}}",
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

### 17. Cleared: resolved in its thread, ✅ on the first post

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
- always → step 19 (`x_alert`)

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

### 18. The detail under it (the next days' availability)

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
- always → step 19 (`x_alert`)

<details><summary>Full step definition</summary>

```json
{
  "id": "a_thread",
  "title": "The detail under it (the next days' availability)",
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

### 19. Stop: said

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
| `crm.location_id` | id | yes | not read (repo) |

## Engine rules that apply but are not steps

These act on every run of this workflow from engine code. They are not in the definition above.

- **Mode.** The workflow's own mode, else the offer's, decides what is real: ghost writes and sends nothing, test is real only for test contacts, quiet writes the CRM but reaches no contact, live is real. (platform/src/engine/mode.ts:23, platform/src/engine/mode.ts:55)
- **Runs again?** A run's key is built from the re-entry policy; a second trigger with the same key starts nothing. A run that stops at a gate does not count. (platform/src/engine/reentry.ts:6)
- **Failures.** Errors are sorted into transient, auth, permanent and unknown. A step is retried after 1 and 5 minutes; then a non-blocking step is skipped and a blocking one is held and looked at again after 15 minutes, then hourly. An auth or permanent failure pauses the run until it is fixed. (platform/src/engine/failures.ts:19, platform/src/engine/failures.ts:21, platform/src/engine/blocking.ts:58)
- **Step cap.** At most 50 steps run in one go; a run past that fails. After an outage, at most 20 sends per offer per tick. (platform/src/engine/runner.ts:21, platform/src/engine/runner.ts:27)
- **Slack before live.** Until the workflow is live, every post goes to the offer's test channel with a ghost/test label, unless `slack.live` is set. (platform/src/engine/mode.ts:32, platform/src/engine/mode.ts:34)
