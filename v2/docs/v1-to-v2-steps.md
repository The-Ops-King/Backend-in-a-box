# v1 steps in v2: how each is written (2026-10-21)

How every behavior v1's workflow format can express (`platform/src/engine/definition.ts`, `engine/04-build-a-workflow.md`)
is written in v2's format (`src/workflow/`). Hidden effects from the engine-action inventory
(`docs/phase-1/engine-action-inventory.md`, E* and H*) are split into their own visible steps. Anything v2 cannot express yet
is marked **GAP** and collected at the end for Tyler.

v2 has ten primitives, each versioned (`wait@1`): `trigger`, `wait`, `branch`, `set`, `message`, `ask`, `action`, `report`,
`call`, `end`. Everything that reaches a vendor is an `action` with a `connector.verb` from the action registry
(`src/workflow/actions/`), whose params are checked per verb and whose effect (contact, team, crm, external, read,
internal) tells the delivery gate which checks apply.

Three rules change how things are written, everywhere:
- **Words are content, by key.** No message, note, task, prompt or Slack post carries its words in the workflow. Email
  subjects, Slack personas (`as`) and button labels belong to the content entry too.
- **Where something posts is a setting.** A Slack channel is exactly `{{setting.<key>}}`. v1 bindings (`crm.*`,
  `calendar.*`, `slack.channel.*`) become `{{setting.<key>}}`; v1 `prompt.*` become content keys; `secret.*` stays
  `{{secret.<key>}}`, allowed only inside `http.request`.
- **Only a branch decides.** v1's `only_if` on any node, and `check`, become a `branch` with labelled edges.

## Workflow-level fields

| v1 | v2 |
|---|---|
| `schema: 1` | `schema: 2`, plus `id`, `name`, optional `description` and `origin` (template and version, information only) |
| `reentry` + `reentry_window` + `reentry_key` | `reentry: { policy, window?, key? }`; `once_per_opportunity` is `once_per_deal` |
| `premise: { check: appointment_in_future \| appointment_exists \| opportunity_open \| contact_exists }` | `premise: { label, holds: <predicate>, endReason }`, e.g. not cancelled and `gt: ["{{appointment.starts_at}}", "{{now}}"]` |
| the offer's send window and `transactional` rule (code: `runner.ts`, per offer) | `sendWindow` per workflow: `zone` contact or offer, `opens`, `closes`, `days?`, `outside: earlier_same_day \| next_open`, `transactional: any_hour \| in_window` |
| wait rule `window: "before"` (D193) | `sendWindow.outside: "earlier_same_day"`, applied to every time wait with `fitSendWindow` (the default) |
| mode, workflow mode, send lock, slack.live, test channel | not in the definition. Delivery state (sandbox / live) and CRM writes (dry / real) are set beside it, by Tyler only |
| `nodes`, `edges` | `nodes`, `edges`; every node has `id`, `type` (`primitive@version`) and a required `title` |
| edge `label` doubling as `timeout` / `tap` / `until` / `event` | edge `on` names the outcome (`next`, `arrived`, `timeout`, `answered`, `expired`); `label` is display words only |
| edge `when` / `else` on a branch | the same; v2 also requires exactly one `else`, last |

## Node by node: all 39 v1 step types

| v1 type | v2 |
|---|---|
| `trigger` (event + `match`) | `trigger@1` `on: { event, match? }` |
| `trigger` `event: "schedule"` | `trigger@1` `on: { schedule: { every } \| { at, days?, dayOfMonth? }, for: "offer" \| { role } }` (`for: company` → `offer`, `for: closer` → `{ role: "closer" }`) |
| (none) | `trigger@1` `on: { manual: { about } }`: started by a person |
| `wait` `rule: { anchor, offset, tz, guard, earliest, latest, window }` | `wait@1` `until: { anchor, offset, zone, guard, earliest, latest }`; `tz` → `zone`, now required; `window` → workflow `sendWindow` |
| `wait_for_reply` `{ timeout, channel, settle, until }` | `wait@1` `reply: { channel, settle }`, `timeout`, `until`; leaves by `arrived` or `timeout` |
| `wait_for_event` `{ event, match, about, since, until, into, respect_send_window }` | `wait@1` `event: { type, match, about, since }`, `timeout?`, `until?`, `into`, `fitSendWindow`; leaves by `arrived` / `timeout` |
| `wait_for_reaction` blocking, on a post this run made | `ask@1` with `answers.reactions` (or `buttons`) and `then: "wait"`; or `ask@1 then: "go_on"` followed later by `wait@1 answer: { ask }` |
| `wait_for_reaction` `blocking: false` (the listener) + `until` | `ask@1 then: "listen"`, deadline `until`; `tap` edge → `on: "answered"`, `until` edge → `on: "expired"` |
| `wait_for_reaction` `of: "tag:<tag>"` on a post another run made | **GAP 1** |
| `resume` | an edge to `"$resume"` at the end of a listener's path |
| `branch` | `branch@1` |
| `check` `{ when, else_exit }` | `branch@1` with a `when` edge on and an `else` edge to `end@1 { reason }` |
| `check` `retry: { every, for }` | a `wait@1` for the event that would make it true, with a `timeout` (e.g. `event: contact.linked`, `timeout: 1h`); or a loop of `branch` → `wait for` back to the branch. A bounded retry count is **GAP 2** |
| `check` `else_pause` | **GAP 3** (no "pause for a person" end) |
| `set_var` `{ key, value }` | `set@1` `{ var, value }` |
| `set_var` `pick` / `when` + `else_value` | `set@1` value `{ $pick, cases, else }` / `{ $if, then, else }`. Words chosen this way move to `message` `content: { pick, cases, else }` so they stay approved content |
| `lookup` `{ query, params, into }` | `action@1 facts.lookup` `{ query, params }`, `into` |
| `send_sms` `{ template, kind, validity, on_stale, substitute_template }` | `message@1` `to: { contact: "sms" }`, `content`, `kind`, `validity: { before, minLead } \| { after, maxLag }`, `whenStale: "skip" \| { send: <content key> }` |
| `send_sms` / `send_email` `ghl_template` (the CRM's own copy wins) | **GAP 4** (deliberately not carried: copy is content) |
| `send_sms` `on_stale: escalate` | **GAP 5** |
| `send_email` `{ subject, template }` | `message@1` `to: { contact: "email" }`; subject and body are one content entry |
| `slack_post` `{ channel, template, as }` | `message@1` `to: { slack: { channel: "{{setting.…}}" } }`, `content`; `as` lives in the content entry |
| `slack_post` to a DM (`{{user.slack_user_id}}`) | `message@1` `to: { slack: { dm: "{{person.slack_id}}", fallbackChannel? } }` |
| `slack_post` `fallback_channel` for an unbound channel binding | **GAP 6** (v2 refuses to enable with an unbound setting instead of falling back) |
| `slack_post` `thread_of`, `thread_only`, `tag` | `thread: { node } \| { tag }`, `threadOnly`, `remember` |
| `slack_post` `react` (on the parent), `react_on`, `unreact` | separate steps: `action@1 slack.react` / `slack.unreact` with `post: { node } \| { tag }` |
| `slack_post` `offer` (reactions for people to tap) | `ask@1` `answers: { reactions }` |
| `slack_post` `edit` | `action@1 slack.update_post` |
| `slack_post` `buttons` (alert_retry, alert_resolve, link_*, agreement_*) | `message@1` `buttons: [{ action, value, style }]`; labels in the content; `only_if` per button is **GAP 7** |
| `slack_post` `label` (mode marks) | none: the delivery gate marks and reroutes sandbox posts |
| `slack_post` `quiet_when_empty` | `branch@1` on `{{vars.<report>.empty}}` (and `{{setting.reports.quiet_when_empty}}`) before the `message` |
| `notify_owner` `{ template, fallback_channel, task, as }` | **split (H3)**: `message@1` to `{ slack: { dm: "{{contact.owner.slack_id}}", fallbackChannel } }`, then `action@1 crm.create_task` |
| `classify` `{ input, state, domain, threshold, criteria, ambiguity_max, into }` | `action@1 ai.classify` `{ input, context, prompt, options, threshold, ambiguityMax, unclear }`, `into`; the criteria words move into the prompt content |
| `analyze` `{ prompt, input, into, format, max_tokens, optional }` | `action@1 ai.summarize` `{ prompt, input, format, maxTokens, optional }`, `into` (one variable; v1's list of keys is read as `vars.<into>.<key>`) |
| `tags` `{ add, remove, keep }` / `set_tag` / `remove_tag` | `action@1 crm.add_tag` then `action@1 crm.remove_tag`; `keep` is **GAP 8** |
| `update_contact` `{ set, fields, clear, if_empty }` | `action@1 crm.update_contact` `{ set: { <canonical field>: … }, ifEmpty, clear }`; `assign_to` → `set.owner`; CRM field ids → canonical names in the field map |
| `ensure_contact` `{ tags, scope_tag, source }` | **split (H4)**: `crm.find_or_create_contact` `{ match, create, fillBlank }`, then `crm.add_tag` (tags and `{{setting.scope.tag}}`) |
| `pipeline_card` `{ pipeline, stage, name, assign_to, if_missing, pick, from_stages, keep_name, value, fields }` | `action@1 crm.move_deal` with the same params (`assign_to` → `owner`) |
| `pipeline_card` `status` only | `action@1 crm.set_deal_status` |
| `pipeline_card` fields with no stage | `action@1 crm.update_deal` |
| `crm_record` `{ object, key, record_id, properties, owner, if_missing, clear, relate }` | `action@1 crm.upsert_record` (`into` keeps the record id), then one `crm.relate_records` per association (H13) |
| `record_outcome` | `action@1 facts.record_outcome`; the `call.held` that follows a show is its own `facts.record` (H10) |
| `create_task` | `action@1 crm.create_task`, title and body as content keys |
| `note` | `action@1 crm.add_note` with a content key |
| `update_appointment` `set.status: cancelled` | `action@1 scheduling.cancel`: effect contact, so behind the send lock (H1) |
| `update_appointment` other statuses | `action@1 scheduling.set_status` (confirmed, showed, noshow) |
| `update_appointment` `set.pending_read` | `action@1 facts.record` of a read-pending fact; reading it back as `appointment.pending_read` depends on the appointments projection (piece 3 onward) |
| `update_opportunity` `status` won / lost | `action@1 crm.set_deal_status`, plus `facts.record deal.won` / `deal.lost` with `startsWorkflows` where something listens (H9) |
| `update_opportunity` `set.contract_value` / `installments` | `action@1 facts.record` of the deal's terms; `card` → `crm.move_deal` |
| `send_document` | `action@1 esign.send` (effect contact) |
| `webhook` `{ url, method, headers, body, into, on_error }` | `action@1 http.request` (effect external, behind the send lock as v1 had it) |
| `health_check` | `report@1` of the health report, then a `message` per finding kind; its repairs are **GAP 9** |
| `availability_check` | `report@1` of the availability report with `params` (min slots, days) |
| `eod_due` | `report@1` of the closer's unfiled days |
| `report` `{ kind, breakdowns, sections, layout, period }` | `report@1` `{ report: <definition key>, period, params }`; layout and sections live in the report definition |
| `leaderboard` | `report@1` of the leaderboard definition |
| `record` `{ event, data, appointment, start }` | `action@1 facts.record` `{ type, data, appointment, startsWorkflows }` |
| `start_workflow` | `call@1` |
| `pause_runs` | `action@1 runs.pause_others` (H18, now visible) |
| `exit` | `end@1` |
| any node `only_if` | a `branch@1` before it |
| any node `title` | `title`, now required |
| any node `blocking` | `onFailure: "skip" \| "hold"` |

## Templates and conditions

Conditions keep v1's shape: `eq`, `ne` (v1 `neq`), `gt`, `gte`, `lt`, `lte`, `in`, `has`, `exists`, `and`, `or`, `not`. Two
date-times now compare as instants. Filters are a fixed set of 18:

| v1 filter | v2 |
|---|---|
| `default`, `upper`, `lower`, `first_name`, `truncate`, `money`, `abs`, `join`, `oneof`, `prefix`, `line`, `link`, `relative`, `hours_until` | the same |
| `date:<luxon format>` | `date:<format name>`: long, medium, day, short_day, time, time_zone, weekday, iso_date (contact's zone). Arbitrary patterns are **GAP 10** |
| `date_company` | `offer_date:<format name>` |
| `date:HH` used in conditions | `hour` (a number) |
| `default:` (empty, "may be absent") | `optional` |
| `tz`, `words`, `json`, `lines`, `bullets`, `each`, `first`, `plural`, `nonzero`, `then`, `suffix`, `duration`, `fixed`, `option` | dropped; list layouts belong to report definitions. **GAP 11** for Slack posts that list things outside a report, and for `option` (per-offer picklist keys) |

A render reports every expression that came out blank (missing or empty) unless `optional`, `default`, `prefix`, `line` or
`link` says it may be, and every refused filter (a past time for `relative`), so the blank-variable hold can refuse to
send.

## Engine actions (inventory section 1) as steps

| # | v2 |
|---|---|
| E1 Typeform contact write | In "New from Typeform": `crm.find_or_create_contact`, then `crm.update_contact` (fields, UTMs) |
| E2 scope tag on a booking | In Call booked: `crm.add_tag` with `{{setting.scope.tag}}` |
| E3 setter-booked call with no setter | `branch` on the setter, then a `message` to the alerts channel setting |
| E4 setter attribution | `facts.lookup calls_for_contact` within the window, `set`, `crm.update_contact`; the re-read every 5 minutes is a `wait for` loop. The window "booked minus N minutes" needs time arithmetic in params: **GAP 12** |
| E5 / E6 opportunity opened (with the default contract value) | `facts.record deal.opened` with `contract_value: "{{setting.deal.contract_value_default}}"` |
| E7 paid in full (within a cent) | a `branch` on the payment's running total against the contract value, then `facts.record payment.paid_in_full` with `startsWorkflows`. "Within a cent" needs arithmetic: **GAP 13** (or the payments projection gives `remaining`) |
| E8 relinking earlier unlinked payments | **GAP 14** (identity matching; for Tyler: platform or step) |
| E9 deposit names unchecked | `branch` on the payment's product names, then a `message` |
| E10 what counts as a new lead | the CRM port's `contact.created`, with a trigger `match`; the drift sweep no longer starts it silently |
| E11 contact gone | the CRM port's event, and `premise: { holds: { exists: "contact.id" } }` ends runs about them |
| E12 DND after a refused text | a workflow on the messaging port's `message.failed` that takes `crm.mark_dnd` |
| E13 a card moved by hand | a trigger on the CRM's `deal.stage_changed`; `facts.lookup appointments_for_contact` finds the latest closing call |
| E14 no `lead.created` without the scope tag | trigger `match: { has: ["{{contact.tags}}", "{{setting.scope.tag}}"] }` |
| E15 scope tag gone | a trigger on `tag.removed` with a match |
| E16, E17, E18 | platform (waking runs, engine alerts, vendor webhook setup) |

## Hidden effects (inventory section 2) as their own steps

H1 `scheduling.cancel` (effect contact: behind the send lock and the gate) · H2 the status fact via `facts.record`, the
start of cancellation workflows by the scheduling port's event (or `startsWorkflows`) · H3 `message` + `crm.create_task` ·
H4 `crm.find_or_create_contact` + `crm.add_tag` (repointing ids and attaching identifiers is platform identity) · H5 / H6
**GAP 9** · H7 alerts are platform · H8 `crm.move_deal` with `ifMissing`; card-move detection is a CRM event · H9
`facts.record deal.won/lost` · H10 `facts.record call.held` · H11 tag events come from the CRM port, never from our own write
· H12 the delivery gate (DND, no address, replays) and E12 · H13 `crm.relate_records` · H14 / H15 platform people
identities and the delivery gate · H18 `runs.pause_others`.

## Gaps for Tyler

1. **Waiting on another run's post** (`wait_for_reaction of: "tag:<tag>"`): an ask's answer is only readable by the
   workflow that asked. Proposal: the answer becomes a fact (`ask.answered`) that other workflows trigger on.
2. **A bounded retry loop** (`check` `retry: { every, for }`): a loop can be drawn, but there is no counter or time
   arithmetic to stop it after `for`. Waiting for the event with a timeout covers the known case (the CRM id).
3. **Pause for a person** (`check` `else_pause`): v2 has `end` but no "pause this run for a person" step.
4. **The CRM's own snippet wins** (`ghl_template`): not carried; copy is v2 content only.
5. **`on_stale: escalate`**: only skip and send-other-content exist.
6. **Fallback channel for an unbound channel**: v2 blocks enabling instead of falling back silently.
7. **A button shown only when a condition holds** (`buttons[].only_if`).
8. **`keep` on a tag step** (tags never removed even if named): write the remove list exactly instead.
9. **Health and drift repairs** (H5, H6): pulling contacts in, retiring duplicate ids, switching a primary id. They need
   verbs (or stay platform) by Tyler's call.
10. **Free date patterns**: only the eight named formats.
11. **List layouts in Slack posts** (`each`, `bullets`, `lines`, `plural`) outside a report definition, and per-offer
    picklist keys (`option`).
12. **Time arithmetic in params** ("the booking time minus 30 minutes" for a lookup window).
13. **Arithmetic in conditions** ("total within a cent of the contract value").
14. **Relinking unlinked payments** (E8).
