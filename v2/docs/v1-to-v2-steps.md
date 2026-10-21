# v1 steps in v2: how each is written (2026-10-21; Hair's translation added to it)

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
| `wait_for_reaction` `of: "tag:<tag>"` on a post another run made | `wait@1 answer: { tag: "decision:{{appointment.id}}", since? }`: the answer to an ask any run remembered under that tag (`remember`); leaves by `arrived` / `timeout`. Every answer is also a fact, `ask.answered` |
| `resume` | an edge to `"$resume"` at the end of a listener's path. v1's `resume` with nothing to return to follows its own edge; v2's `$resume` is only for a listener's path, so a step reached both ways is copied, one copy for each |
| `branch` | `branch@1` |
| `check` `{ when, else_exit }` | `branch@1` with a `when` edge on and an `else` edge to `end@1 { reason }` |
| `check` `else_pause` with `retry` | `wait@1 check` with the deadline; `timeout` → `wait@1 person`; `resumed` → a `branch` on the same condition (on: back to the person wait when it still does not hold) |
| `check` `retry: { every, for }` | `wait@1 check: { holds, every }` with `timeout: <for>` (or an `until`): looks again every `every`, leaves by `arrived` once it holds, by `timeout` when the deadline comes first; the `timeout` edge goes to the `end@1 { reason }`. Or a `wait@1` for the event that would make it true |
| `check` `else_pause` | a `branch@1` whose else edge goes to `wait@1 person: { reason }`: the run is paused for a person until an operator resumes it (`on: resumed`) or ends it |
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
| `slack_post` `offer` (reactions for people to tap) | `ask@1` `answers: { reactions }`; the post and the `wait_for_reaction` on it are one `ask@1` (`then: wait` for a blocking wait, `listen` for `blocking: false`) |
| `slack_post` `edit: true` (say it again by editing the earlier post) | **GAP 17** |
| `slack_post` `react` / `react_on` / `unreact` with an emoji from a value (`{{vars.x}}`) | a `branch` on that value, then one `slack.react` / `slack.unreact` per emoji it can be (emoji names are fixed). `react_on` a post this one is about to take the tag of goes before the post |
| `slack_post` `as` with a name or icon from a value | a `content: { pick }` of entries with the same words and each persona (**GAP 15** for icons and names that are free values) |
| `slack_post` `channel: "{{event.channel}}"` | **GAP 16** |
| `slack_post` `channel` a literal channel id | a setting, named for it |
| `slack_post` `channel: "{{user.slack_user_id}}"` / `"{{company.operator_slack_id}}"` | `to: { slack: { dm: "{{person.slack_user_id}}" } }` / `{ dm: "{{setting.bot.escalate_to}}" }` |
| `slack_post` `edit` | `action@1 slack.update_post` |
| `slack_post` `buttons` (alert_retry, alert_resolve, link_*, agreement_*) | `message@1` `buttons: [{ action, value, style, when? }]`; labels in the content; `only_if` per button is `when`, a condition checked at the moment of posting |
| `slack_post` `label` (mode marks) | none: the delivery gate marks and reroutes sandbox posts |
| `slack_post` `quiet_when_empty` | `branch@1` on `{{vars.<report>.empty}}` (and `{{setting.reports.quiet_when_empty}}`) before the `message` |
| `notify_owner` `{ template, fallback_channel, task, as }` | **split (H3)**: `message@1` to `{ slack: { dm: "{{contact.owner.slack_id}}", fallbackChannel } }`, then `action@1 crm.create_task` |
| `classify` `{ input, state, domain, threshold, criteria, ambiguity_max, into }` | `action@1 ai.classify` `{ input, context, prompt, options, threshold, ambiguityMax, unclear }`, `into`; the question and criteria words move into the prompt content, the options are the criteria's keys (v1 read them from `core_categories` by domain), and `vars.<into>` is `{ value, confidence, guesses }` (v1: the value at `into`, the confidence as a percentage in `reply.intent_confidence`) |
| `analyze` `{ prompt, input, into, format, max_tokens, optional }` | `action@1 ai.summarize` `{ prompt, input, format, maxTokens, optional }`, `into` (one variable; v1's list of keys is read as `vars.<into>.<key>`) |
| `tags` `{ add, remove, keep }` / `set_tag` / `remove_tag` | `action@1 crm.add_tag` then `action@1 crm.remove_tag`; `keep` is **GAP 8** |
| `update_contact` `{ set, fields, clear, if_empty }` | `action@1 crm.update_contact` `{ set: { <canonical field>: … }, ifEmpty, clear }`; `assign_to` → `set.owner`; CRM field ids → canonical names in the field map |
| `ensure_contact` `{ tags, scope_tag, source }` | **split (H4)**: `crm.find_or_create_contact` `{ match, create, fillBlank }`, then `crm.add_tag` (tags and `{{setting.scope.tag}}`) |
| `pipeline_card` `{ pipeline, stage, name, assign_to, if_missing, pick, from_stages, keep_name, value, fields }` | `action@1 crm.move_deal` with the same params (`assign_to` → `owner`) |
| `pipeline_card` `status` only | `action@1 crm.set_deal_status` |
| `pipeline_card` fields with no stage | `action@1 crm.update_deal` |
| `crm_record` `{ object, key, record_id, properties, owner, if_missing, clear, relate }` | `action@1 crm.upsert_record` (`into` keeps the record id), then one `crm.relate_records` per association (H13) |
| `record_outcome` | `action@1 facts.record_outcome`, then `facts.record appointment.outcome` (with the earlier answer, `outcome_source` and `via`) and, on a show, `facts.record call.held`, both with `startsWorkflows`: v1 dispatched both (H10) |
| `create_task` | `action@1 crm.create_task`, title and body as content keys; a `due` from a value is a `branch` to one task step per due time |
| `note` | `action@1 crm.add_note` with a content key |
| `update_appointment` `set.status: cancelled` | `action@1 scheduling.cancel`: effect contact, so behind the send lock (H1) |
| `update_appointment` other statuses | `action@1 scheduling.set_status` (confirmed, showed, noshow) |
| `update_appointment` `set.pending_read` | `action@1 facts.record` of a read-pending fact; reading it back as `appointment.pending_read` depends on the appointments projection (piece 3 onward) |
| `update_opportunity` `status` won / lost / open | v1's is our ledger's opportunity, not the CRM card (that is `card`), so: `facts.record deal.won` / `deal.lost` / `deal.reopened` with `startsWorkflows` (H9); `from` is a `branch` on `{{deal.status}}` first. Only `card` writes the CRM (`crm.move_deal` / `crm.set_deal_status`) |
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
| any node `blocking` | `onFailure: "skip" \| "hold"`; where v1's derived rule (the spec's "If it keeps failing") differs from v2's default, the step says it |
| `crm_record` `relate` after a write that failed | a `branch` on the write's id before the `crm.relate_records` steps (a failed v1 write took its links with it) |
| `set_var` `pick` on a key of several parts (`"{{a}}:{{b}}"`) | a `set@1` of the key first, then `$pick` on `{{vars.<key>_key}}` |
| `wait_for_event` `match` reading `vars.<into>.*` | the same paths under `event.*` (v2 matches the candidate event as `event`); `vars.<into>.matched` is a `set@1` after the wait (`exists vars.<into>.type`) |
| `wait` with `anchor: "now"` | the same; "now" is when the step was reached (fixed in piece 3: a wake no longer moves it) |

## Templates and conditions

Conditions keep v1's shape: `eq`, `ne` (v1 `neq`), `gt`, `gte`, `lt`, `lte`, `in`, `has`, `exists`, `and`, `or`, `not`. Two
date-times now compare as instants. New in v2: `within: [a, b, tolerance]`, two numbers at most `tolerance` apart.
Filters are a fixed set of 20:

| v1 filter | v2 |
|---|---|
| `default`, `upper`, `lower`, `first_name`, `truncate`, `money`, `abs`, `join`, `oneof`, `prefix`, `line`, `link`, `relative`, `hours_until` | the same |
| `date:<luxon format>` | `date:<format name>`: long, medium, day, short_day, time, time_zone, weekday, iso_date (contact's zone). Arbitrary patterns are **GAP 10** |
| `date_company` | `offer_date:<format name>` |
| `date:HH` used in conditions | `hour` (a number) |
| (none: v1 had `timeParam` offsets inside a few step params) | `plus:<duration>` / `minus:<duration>`: a date-time moved, as an ISO time, anywhere a template goes (params, conditions, `since`, and a wait anchor written as one `{{…}}`) |
| `default:` (empty, "may be absent") | `optional` |
| `tz`, `words`, `json`, `lines`, `bullets`, `each`, `first`, `plural`, `nonzero`, `then`, `suffix`, `duration`, `fixed`, `option` | dropped; list layouts belong to report definitions. **GAP 11** for Slack posts that list things outside a report, and for `option` (per-offer picklist keys) |

v1 context paths, as v2 writes them:

| v1 | v2 |
|---|---|
| `crm.*`, `slack.channel.*`, `calendar.<x>.url`, a company switch (`setting.*`) | `setting.*` |
| `company.name` / `slug` / `timezone` / `base_url` / `operator_slack_id` | `offer.name` / `slug` / `zone`, `setting.platform.base_url`, `setting.bot.escalate_to` |
| `user.*` (a run about a person on the team) | `person.*` |
| `picklist.<list>.<meaning>` | `setting.picklist.<list>.<meaning>` |
| `records.<object>.*`, `cards.<board>.*`, `opportunity.*` | `contact.records.*`, `contact.cards.*`, `deal.*` (from the projections) |
| `reaction.reaction` / `reaction.user_name` | `vars.<ask into>.value` / `.person` (a Slack user id) |
| `reply.inbound_since_send` | `reply.body` |
| `event._type`, `event._source` (an outcome's source) | `event.type`, `event.outcome_source` |
| `record.id` inside a `crm_record`'s `relate` | `vars.<the write's into>.id` |
| `{{x \| default:}}` | `{{x \| optional}}`; a variable a step sets to `""` on purpose also reads `\| optional` |

A render reports every expression that came out blank (missing or empty) unless `optional`, `default`, `prefix`, `line` or
`link` says it may be, and every refused filter (a past time for `relative`), so the blank-variable hold can refuse to
send.

## Engine actions (inventory section 1) as steps

| # | v2 |
|---|---|
| E1 Typeform contact write | In "New from Typeform": `crm.find_or_create_contact`, then `crm.update_contact` (fields, UTMs) |
| E2 scope tag on a booking | In Call booked: `crm.add_tag` with `{{setting.scope.tag}}` |
| E3 setter-booked call with no setter | `branch` on the setter, then a `message` to the alerts channel setting |
| E4 setter attribution | `facts.lookup calls_for_contact` with `since: "{{appointment.booked_at \| minus:30m}}"`, `set`, `crm.update_contact`; the re-read every 5 minutes is a `wait@1 check` loop |
| E5 / E6 opportunity opened (with the default contract value) | `facts.record deal.opened` with `contract_value: "{{setting.deal.contract_value_default}}"` |
| E7 paid in full (within a cent) | a `branch` with `{ within: ["{{payment.total}}", "{{deal.contract_value}}", 0.01] }` (the running total comes from the payments projection), then `facts.record payment.paid_in_full` with `startsWorkflows` |
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

1. ~~**Waiting on another run's post**~~ Closed in piece 2: `wait@1 answer: { tag }`, and every answer is an
   `ask.answered` fact.
2. ~~**A bounded retry loop**~~ Closed in piece 2: `wait@1 check: { holds, every }` with a deadline.
3. ~~**Pause for a person**~~ Closed in piece 2: `wait@1 person: { reason }`, left by `resumed`.
4. **The CRM's own snippet wins** (`ghl_template`): not carried; copy is v2 content only.
5. **`on_stale: escalate`**: only skip and send-other-content exist.
6. **Fallback channel for an unbound channel**: v2 blocks enabling instead of falling back silently.
7. ~~**A button shown only when a condition holds**~~ Closed in piece 2: `buttons[].when`.
8. **`keep` on a tag step** (tags never removed even if named): write the remove list exactly instead.
9. **Health and drift repairs** (H5, H6): pulling contacts in, retiring duplicate ids, switching a primary id. They need
   verbs (or stay platform) by Tyler's call.
10. **Free date patterns**: only the eight named formats.
11. **List layouts in Slack posts** (`each`, `bullets`, `lines`, `plural`) outside a report definition, and per-offer
    picklist keys (`option`).
12. ~~**Time arithmetic in params**~~ Closed in piece 2: the `plus` / `minus` filters, and a wait anchor may be one
    `{{…}}` expression.
13. ~~**Arithmetic in conditions**~~ Closed in piece 2: `within: [a, b, tolerance]`.
14. **Relinking unlinked payments** (E8).

Found translating Hair (piece 3; `offers/hair/REVIEW.md` says where each one bites):

15. **A Slack persona from a value**: a name chosen by a value is a `pick` of content entries (done), but a free value
    (`{{event.as_name}}`) and every persona icon list are not carried (icons are kept in the content entry as `icons`,
    unused).
16. **A post whose channel the triggering fact names** (`{{event.channel}}`, the alert posts): a channel is always one
    setting.
17. **Edit an earlier post when there is one, else post** (`edit: true`): a second time posts again.
18. **A run starting its own workflow again from a fact it records** (`record` with `start: true`, Sales call recorded
    linking a call to the booking the team picked): v2 never starts a workflow from its own run's fact.
19. **What we last sent the contact** (`reply.last_outbound`) and the rest of v1's reply-derived context: no root yet.
20. **A fraction as a percentage** (a classifier's 0.92 written "92%"): no arithmetic filter.
21. **A list held in a variable as a list param** (`tags: ["{{vars.tags}}"]` is a list inside a list).
22. **A reply in a DM's thread**: the dispatcher threads only in a channel; a DM thread posts as a plain DM.
23. **An unbound setting a step may do without**: v1 skipped what an unbound `{{crm.x | default:}}` fed; v2 enables a
    workflow only when every setting it reads is set (GAP 6 again).

Not a format gap, a dependency: the facts v1 worked out for every run (the contact's payments, signature, owner, closer,
setter, next call, CRM record keys and cards; the appointment's outcome, pending read and whether it has started; a
recording's caller, Set window and transcript) are read from the projections (piece 3 onward). Until then the
simulator takes them from each fact's payload.
