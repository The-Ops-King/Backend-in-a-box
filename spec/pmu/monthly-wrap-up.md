# Monthly wrap-up

Offer: **PMU** (`pmu`). Source: **from repo, may differ from live**. Generated 2026-10-21.

| Setting | Value |
| --- | --- |
| Where this definition came from | shipped template: platform/src/templates/monthly-wrap-up.json (the offer's words, if any, are applied at install) |
| Template | `monthly-wrap-up` |
| Edited since copied from the template | unknown (repo) |
| Saved version | unknown (repo) |
| Enabled | unknown (repo) |
| Mode | unknown (repo) |
| Send lock | unknown (repo) |
| Runs again for the same person | always |
| Re-checked before every step | nothing |
| Send window | the offer's (unknown in repo) |
| Steps | 4 |

## Steps

Every step, in the order a run meets it from the trigger. Steps that only assemble words (`set_var`) are listed too.

### 1. On a schedule: at 8:00 AM on day 1 of the month

- Step id `t_monthly`, type `trigger`

Next:
- always → step 2 (`n_build`)

<details><summary>Full step definition</summary>

```json
{
  "id": "t_monthly",
  "type": "trigger",
  "event": "schedule",
  "schedule": {
    "at": "08:00",
    "day_of_month": 1,
    "for": "company"
  }
}
```

</details>

### 2. Read the numbers and word the wrap-up (the layout: sections, lines, headings)

- Step id `n_build`, type `report`
- Engine description: Build the monthly wrap-up
- Detail: into report: body, period, numbers
- If it keeps failing: the run is held on this step (step n_post reads the wrap-up)

Layout:

```
{
  "heading": {
    "monthly": "📊 *{{report.start | date:\"LLLL yyyy\"}}*",
    "monthly_to_date": "📊 *{{report.start | date:\"LLLL\"}} so far*"
  },
  "sections": [
    {
      "title": "",
      "lines": [
        "{{report.calls.missing | each:\"⚠️ Calls with no EOD outcome: {{item}}\"}}"
      ],
      "table": [
        [
          "Leads",
          "{{report.n.leads | default:\"\"}}"
        ],
        [
          "MQLs",
          "{{report.n.mqls | default:\"\"}}"
        ],
        [
          "New bookings",
          "{{report.n.booked | default:\"\"}}"
        ],
        [
          "  by setters",
          "{{report.n.booked_set | default:\"\"}}"
        ],
        [
          "Calls due",
          "{{report.calls.booked | default:\"\"}}"
        ],
        [
          "Showed",
          "{{report.calls.showed | default:\"\"}}"
        ],
        [
          "No-shows",
          "{{report.calls.noshow | default:\"\"}}"
        ],
        [
          "Show rate",
          "{{report.rates.show_rate | suffix:%}}"
        ],
        [
          "Closes",
          "{{report.n.closes | default:\"\"}}"
        ],
        [
          "Close rate",
          "{{report.rates.close_rate | suffix:%}}"
        ],
        [
          "Deposits",
          "{{report.n.deposits | default:\"\"}}"
        ],
        [
          "Deposit cash",
          "{{report.n.deposit_cash | default:\"\" | then:\"$\"}}{{report.n.deposit_cash | default:\"\" | money:0}}"
        ],
        [
          "Revenue",
          "{{report.n.revenue | default:\"\" | then:\"$\"}}{{report.n.revenue | default:\"\" | money:0}}"
        ],
        [
          "Cash",
          "{{report.money_moved | then:\"$\"}}{{report.money_moved | each:\"{{report.raw.cash_collected | default:0 | money:0}}\"}}"
        ],
        [
          "Refunds",
          "{{report.n.refunds | default:\"\" | then:\"$\"}}{{report.n.refunds | default:\"\" | money:0}}"
        ],
        [
          "Dials",
          "{{report.n.dials | default:\"\"}}"
        ],
        [
          "Connected",
          "{{report.n.connected | default:\"\"}}"
        ],
        [
          "Speed to lead",
          "{{report.n.speed_to_lead | default:\"\" | duration}}"
        ]
      ]
    },
    {
      "title": "*What they said*",
      "lines": [
        "{{report.said | each:\"*{{item.label}}*{{item.top | each:\\\"\\\\n• {{item.count}} — {{item.answer}}\\\" | join:\\\"\\\"}}{{item.rest | nonzero | each:\\\"\\\\n• {{item}} — other answers\\\"}}\" | join:\"\\n\\n\"}}"
      ]
    },
    {
      "title": "*By closer*",
      "lines": [
        "{{report.by.closer | each:\"• {{item.name}}: {{item.values.showed | default:0}} showed · {{item.values.deals_won | default:0}} won · ${{item.values.revenue | default:0 | money:0}}\" | join:\"\\n\"}}"
      ]
    },
    {
      "title": "*By setter*",
      "lines": [
        "{{report.by.setter | each:\"• {{item.name}}: {{item.values.dials | default:0}} dials · {{item.values.calls_set | default:0}} set\" | join:\"\\n\"}}"
      ]
    }
  ],
  "empty": {
    "monthly": "Nothing last month: no leads, bookings, calls or payments.",
    "monthly_to_date": "Nothing this month: no leads, bookings, calls or payments."
  },
  "failed": "_couldn't read GHL: {{report.ghl_error}}_",
  "footer": "_From GHL and the engine, read {{report.read_at | date:\"h:mm a ZZZZ\"}}_"
}
```

Next:
- always → step 3 (`n_post`)

<details><summary>Full step definition</summary>

```json
{
  "id": "n_build",
  "title": "Read the numbers and word the wrap-up (the layout: sections, lines, headings)",
  "type": "report",
  "kind": "monthly",
  "breakdowns": [],
  "sections": {},
  "into": "report",
  "metrics": [
    "leads",
    "mqls",
    "booked",
    "booked_self",
    "booked_set",
    "reschedules",
    "dials",
    "connected",
    "speed_to_lead",
    "closes",
    "deposits",
    "deposit_cash",
    "revenue",
    "cash_collected",
    "cash_gross",
    "refunds"
  ],
  "layout": {
    "heading": {
      "monthly": "📊 *{{report.start | date:\"LLLL yyyy\"}}*",
      "monthly_to_date": "📊 *{{report.start | date:\"LLLL\"}} so far*"
    },
    "sections": [
      {
        "title": "",
        "lines": [
          "{{report.calls.missing | each:\"⚠️ Calls with no EOD outcome: {{item}}\"}}"
        ],
        "table": [
          [
            "Leads",
            "{{report.n.leads | default:\"\"}}"
          ],
          [
            "MQLs",
            "{{report.n.mqls | default:\"\"}}"
          ],
          [
            "New bookings",
            "{{report.n.booked | default:\"\"}}"
          ],
          [
            "  by setters",
            "{{report.n.booked_set | default:\"\"}}"
          ],
          [
            "Calls due",
            "{{report.calls.booked | default:\"\"}}"
          ],
          [
            "Showed",
            "{{report.calls.showed | default:\"\"}}"
          ],
          [
            "No-shows",
            "{{report.calls.noshow | default:\"\"}}"
          ],
          [
            "Show rate",
            "{{report.rates.show_rate | suffix:%}}"
          ],
          [
            "Closes",
            "{{report.n.closes | default:\"\"}}"
          ],
          [
            "Close rate",
            "{{report.rates.close_rate | suffix:%}}"
          ],
          [
            "Deposits",
            "{{report.n.deposits | default:\"\"}}"
          ],
          [
            "Deposit cash",
            "{{report.n.deposit_cash | default:\"\" | then:\"$\"}}{{report.n.deposit_cash | default:\"\" | money:0}}"
          ],
          [
            "Revenue",
            "{{report.n.revenue | default:\"\" | then:\"$\"}}{{report.n.revenue | default:\"\" | money:0}}"
          ],
          [
            "Cash",
            "{{report.money_moved | then:\"$\"}}{{report.money_moved | each:\"{{report.raw.cash_collected | default:0 | money:0}}\"}}"
          ],
          [
            "Refunds",
            "{{report.n.refunds | default:\"\" | then:\"$\"}}{{report.n.refunds | default:\"\" | money:0}}"
          ],
          [
            "Dials",
            "{{report.n.dials | default:\"\"}}"
          ],
          [
            "Connected",
            "{{report.n.connected | default:\"\"}}"
          ],
          [
            "Speed to lead",
            "{{report.n.speed_to_lead | default:\"\" | duration}}"
          ]
        ]
      },
      {
        "title": "*What they said*",
        "lines": [
          "{{report.said | each:\"*{{item.label}}*{{item.top | each:\\\"\\\\n• {{item.count}} — {{item.answer}}\\\" | join:\\\"\\\"}}{{item.rest | nonzero | each:\\\"\\\\n• {{item}} — other answers\\\"}}\" | join:\"\\n\\n\"}}"
        ]
      },
      {
        "title": "*By closer*",
        "lines": [
          "{{report.by.closer | each:\"• {{item.name}}: {{item.values.showed | default:0}} showed · {{item.values.deals_won | default:0}} won · ${{item.values.revenue | default:0 | money:0}}\" | join:\"\\n\"}}"
        ]
      },
      {
        "title": "*By setter*",
        "lines": [
          "{{report.by.setter | each:\"• {{item.name}}: {{item.values.dials | default:0}} dials · {{item.values.calls_set | default:0}} set\" | join:\"\\n\"}}"
        ]
      }
    ],
    "empty": {
      "monthly": "Nothing last month: no leads, bookings, calls or payments.",
      "monthly_to_date": "Nothing this month: no leads, bookings, calls or payments."
    },
    "failed": "_couldn't read GHL: {{report.ghl_error}}_",
    "footer": "_From GHL and the engine, read {{report.read_at | date:\"h:mm a ZZZZ\"}}_"
  }
}
```

</details>

### 3. Post the wrap-up in Slack

- Step id `n_post`, type `slack_post`
- Engine description: Post to Slack (the reports channel)
- Goes to: channel {{slack.channel.reports}}; posted as "Wrap-up"
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Slack post:

```
{{vars.report.body}}
```

Next:
- always → step 4 (`x_done`)

<details><summary>Full step definition</summary>

```json
{
  "id": "n_post",
  "title": "Post the wrap-up in Slack",
  "type": "slack_post",
  "channel": "{{slack.channel.reports}}",
  "template": "{{vars.report.body}}",
  "as": {
    "name": "Wrap-up",
    "icon": [
      ":bar_chart:",
      ":chart_with_upwards_trend:",
      ":clipboard:"
    ]
  },
  "thread_only": false,
  "edit": false,
  "label": "mode",
  "quiet_when_empty": "vars.report.nothing"
}
```

</details>

### 4. Done

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
| `crm.location_id` | id | yes | not read (repo) |
| `slack.channel.reports` | channel | no | not read (repo) |

## Engine rules that apply but are not steps

These act on every run of this workflow from engine code. They are not in the definition above.

- **Mode.** The workflow's own mode, else the offer's, decides what is real: ghost writes and sends nothing, test is real only for test contacts, quiet writes the CRM but reaches no contact, live is real. (platform/src/engine/mode.ts:23, platform/src/engine/mode.ts:55)
- **Runs again?** A run's key is built from the re-entry policy; a second trigger with the same key starts nothing. A run that stops at a gate does not count. (platform/src/engine/reentry.ts:6)
- **Failures.** Errors are sorted into transient, auth, permanent and unknown. A step is retried after 1 and 5 minutes; then a non-blocking step is skipped and a blocking one is held and looked at again after 15 minutes, then hourly. An auth or permanent failure pauses the run until it is fixed. (platform/src/engine/failures.ts:19, platform/src/engine/failures.ts:21, platform/src/engine/blocking.ts:58)
- **Step cap.** At most 50 steps run in one go; a run past that fails. After an outage, at most 20 sends per offer per tick. (platform/src/engine/runner.ts:21, platform/src/engine/runner.ts:27)
- **Slack before live.** Until the workflow is live, every post goes to the offer's test channel with a ghost/test label, unless `slack.live` is set. (platform/src/engine/mode.ts:32, platform/src/engine/mode.ts:34)
