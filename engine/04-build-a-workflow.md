# How to build a workflow (the reference the chat builds from)

Tyler, 2026-10-08: "I have this idea for a workflow. It would trigger on this, do this, do this. It should know how
to build it from the docs, not guess; ask me what I left out; think through the edge cases." This file is that
reference. It is kept exact: every node, field, filter, path and event below exists in the engine today
(`platform/src/engine/definition.ts`, `template.ts`, `context.ts`, `engine/schema.sql`). When the engine gains
something, this file gains it in the same commit, or `coverage.test` / `describe.test` will not know it.

## 0. The shape of a workflow

A workflow is a JSON template in `platform/src/templates/<slug>.json`, registered in `templates/index.ts`,
installed on a company (copied, versioned), turned on deliberately. It is a graph:

```json
{ "slug": "call-booked", "name": "Call booked", "category": "booking", "description": "one paragraph a client reads",
  "definition": {
    "schema": 1,
    "reentry": "once_per_appointment",              // once_per_contact | once_per_appointment | once_per_opportunity | once_per_contact_per_window (+ reentry_window "90d") | always
    "premise": { "check": "appointment_in_future" }, // none | appointment_in_future | appointment_exists | opportunity_open | contact_exists — re-checked at every wait; a dead premise exits the run
    "nodes": [ { "id": "t1", "type": "trigger", "event": "appointment.booked", "match": { "eq": ["{{appointment.term.category}}", "closing"] } }, … , { "id": "x1", "type": "exit", "reason": "done" } ],
    "edges": [ { "from": "t1", "to": "n1" }, { "from": "b1", "to": "n2", "when": { "eq": ["{{appointment.self_booked}}", true] }, "label": "self booked" }, { "from": "b1", "to": "n3", "else": true, "label": "setter booked" } ]
  } }
```

Rules the parser enforces: unique node ids, at least one trigger and one exit, every non-exit node has an outgoing
edge, every edge points at a node. A branch's edges carry `when` (a predicate) or `else`; the first matching edge
wins, in order. `label` is the words the chart and the outline show for that fork.

## 1. Triggers: what starts a run

`{ "type": "trigger", "event": "<event>", "match": <predicate, optional> }`. Several workflows may listen to the same
event; each runs on its own (call-booked, the pre-call sequence and the availability watch all start on a booking).
A workflow may have several triggers (deal-closed starts on a payment or a signature, either order).

Events the engine emits (`event_types`): `lead.created` `intake.recorded` `contact.merged` `opportunity.opened`
`opportunity.won` `opportunity.lost` `appointment.booked` `appointment.rescheduled` `appointment.status_changed`
`appointment.outcome` `call.held` `message.sent` `message.received` `reply.classified` `payment.received`
`payment.failed` `payment.paid_in_full` `payment.refunded` `payment.unlinked` `payment.linked` `recording.received`
`recording.unlinked` `recording.linked` `call.analyzed` `call.logged` `agreement.sent` `agreement.signed` `tag.added`
`tag.removed` `stage.changed` `run.started` `run.exited` `send.suppressed` `eod.filed` (a closer filed their day: the whole
report in `event`, the run is about that closer: `user.*`).

**The clock** is an event too: `{ "type": "trigger", "event": "schedule", "schedule": { "every": "60m" } }` or
`{ "at": "18:00", "days": [1,2,3,4,5], "for": "closer" }` (`every` m/h/d; `at` HH:MM company time with optional `days`
1..7 Mon..Sun or `day_of_month` 1..28; `for: company` = one run about the company, `for: closer` = one run per user with
role closer, about that person, with `user.*` in the context). Fires once per period per subject, whatever the reentry
policy says; a tick that is late still runs the period once; a day the engine was down is not made up. Several schedule
triggers on one workflow are fine (eod-reminder has an evening and a morning one; wrap-ups has three), each leading
through its own `set_var` into the shared steps.

Which calendars count is a `match` on the appointment's facts, never a calendar id: `appointment.term.category`
(`first_call` | `qualifying` | `closing` | `follow_up`), `appointment.term.name` (the company's own word for it),
`appointment.self_booked`, `appointment.set_by`. The company maps each calendar to a call type at install or in
settings; the workflow page's trigger popover lists the calendars that match.

## 2. Nodes: what a step can do

| type | fields | what it does |
|---|---|---|
| `wait` | `rule: { anchor, offset, tz, guard?, earliest?, latest? }` | anchor `now` or a datetime path (`appointment.starts_at`); offset `+15m` `+2h` `-1d` or `day_of@08:00` `day_before@19:00` `day_after@09:00`; tz `contact` (default) or `company`; `guard: { min_lead: "2h", fallback: "+15m" }` when the anchor is too close. The premise is re-checked when it wakes. `earliest` / `latest` ("08:00", "21:00", that zone) move a computed time to a human hour the same day: four hours before a 7am call is 8am, not 3am. A reminder that lands too close to the call is the send step's business: `validity.min_lead` + `on_stale: skip`. |
| `wait_for_reply` | `timeout`, `channel: sms|email|any`, `settle?` (90s: after the newest reply, wait for the rest of what they are typing) | woken the minute a reply arrives; follows the edge labelled `timeout` if none, else exits `no_reply`. `reply.last_inbound.body` is then readable. |
| `wait_for_reaction` | `of` (the message: `"tag:<tag>"` as a `slack_post` remembered it, e.g. `tag:decision:{{appointment.id}}`, or the id of a `slack_post` in this run), `emojis` (the reactions that count), `timeout?`, `into?` (default `reaction`) | parks the run until a team member taps one of `emojis` on that very message (the Slack door wakes it; a tap on another post, or any other emoji, changes nothing) — so a ✅ on Jeremy's question marks Jeremy and nobody else (D53). The tap lands under `into` as `{ reaction, user, user_name, ts }`: branch on `{{reaction.reaction}}`, say who decided with `{{reaction.user_name}}`. With `timeout`, silence continues with `reaction` null so a branch's `else` can handle it; without one, it waits for the tap. Pair it with a `slack_post` carrying `tag` + `offer` before, and `unreact` on the posts after. |
| `send_sms` | `template`, `kind: human|transactional`, `ghl_template?`, `validity?: { min_lead }`, `on_stale: skip|substitute|pause`, `substitute_template?` | `human` always waits for the send window (dark hours); `transactional` (a receipt: "you're booked") may go out at any hour if the company allows. `ghl_template` = the CRM's own snippet id; its copy wins. `validity.min_lead` + `on_stale` decide what happens when the appointment is now too close for the message to make sense. |
| `send_email` | `subject`, `template` (HTML allowed), same options as sms | same rules. |
| `slack_post` | `channel` (`{{slack.channel.<name>}}`, or `{{user.slack_user_id}}` for a DM), `template`, `as: { name, icon | [icons] }`, `thread_of?` (`"<node id>"` or `"tag:<tag>"`), `thread_only?` (nothing when that post is not there), `tag?` (remember this post as `<tag>`), `react?` (emoji name, or several, added to the post replied to), `offer?` (reactions added to this post for a person to tap; the tap arrives as a `slack.reaction` event), `unreact?: { of, emojis }` (the bot's own reactions taken off that post) | posts even in shadow (labelled 🧪 shadow). `as` is the face: a name and an emoji or image URL, or a list of emoji one is picked from. `thread_of: "<node id>"` replies under that earlier post; `thread_of: "tag:<name>"` replies under a post another run remembered with `tag` (rendered, e.g. `eod-reminder:{{user.id}}:{{user.eod.day}}`), in that post's channel; `react` puts an emoji on the parent. |
| `notify_owner` | `template`, `fallback_channel?`, `task?: { title, due }`, `as?` | DM to the contact's owner (looked up in Slack by email), else the fallback channel with an @mention; optional CRM task. |
| `classify` | `input` (`{{reply.inbound_since_send}}`: everything since our last send), `state?`, `domain`, `threshold`, `into`, `criteria?` (what each option means), `ambiguity_max?` (0.8: a reply a careful person would doubt this much goes to a human) | the AI picks one option of a domain (`reply_intent`, `appointment_outcome`, `call_outcome`, `lost_reason`, `payment_plan`, `appointment_type`); below the threshold → `unclear`. Result under `vars.<into>` and `reply.intent`. |
| `analyze` | `prompt` (`{{prompt.<name>}}`), `input` (default the transcript), `into` (a var, or `["notes", "rubric"]`: the keys of one object the prompt returns, one read), `format: json|text`, `max_tokens?`, `optional?` | long-form read: notes, scorecard, a one-line cheer. `optional: true` = skipped quietly when the AI cannot run. Prompts are company bindings with defaults in `src/prompts`. |
| `branch` | — | the question; its outgoing edges are the answers. |
| `check` | `when`, `else_exit`, `retry?: { every, for }` | a gate: if false, exit with that reason; with `retry`, park on the step and look again every `every` for up to `for` first (a lead without a phone waits a day for one). A run that stops at a gate before doing anything releases its once-per key (D30). |
| `tags` | `add?` (tag or `[tags]`), `remove?` (tag or `[tags]`) | CRM tags, one step: `add` goes on, then `remove` comes off. Consecutive tag steps are always one `tags` node, never a run of them. `set_tag` / `remove_tag` (`tag` or `[tags]`) are the older one-direction forms and still run; use `tags` in anything new. |
| `update_contact` | `set: { first_name, last_name, phone, timezone, assign_to }`, `fields: [{ id, value }]`, `clear: [ids]` | empty rendered values are left alone. |
| `pipeline_card` | `pipeline`, `stage?`, `name?` (default the person's name), `assign_to?`, `status?: open|won|lost|abandoned`, `fields` | one open card per contact per pipeline; re-firing moves it. `if_missing: skip` = only if the card exists. |
| `crm_record` | `object`, `key`, `properties`, `owner?`, `relate: [{ association, first, second }]` | a record on a custom object (payment, sales call), upserted by our key. |
| `record_outcome` | `outcome`, `call_outcome?`, `notes?` | the appointment's outcome on our row (showed / noshow / …); `call.held` follows a show. |
| `create_task` | `title`, `body?`, `due`, `assign_to?` | a CRM to-do on the contact. |
| `note` | `template` | an internal note on the contact. |
| `update_appointment` / `update_opportunity` | `set` | status or fields. |
| `send_document` | `template`, `sender?`, `name?` | Documents & Contracts (needs the write scope). |
| `webhook` | `url`, `method` (POST), `headers`, `body` (string or JSON, every string a template), `into?`, `on_error: fail|skip` | an HTTP call out: Airtable, a Zap or Make scenario, Apps Script, anything with a URL. `{{secret.<key>}}` resolves in url, headers and body here and nowhere else, never written to the ledger. The reply (JSON when it is) lands in `vars.<into>`. Shadow: recorded as "would call". A non-2xx fails the run (an alert) unless `on_error: skip`. |
| `health_check` | `checks: { "<id>": false }`, `channel?`, `as?` | the hourly sweep as a step (D35): every check on, minus the ones turned off; failures are alerts that clear themselves. Belongs after a `schedule` trigger. |
| `availability_check` | `min_slots` (3), `days` (7) | bookable slots on every active calendar; in a run about a booking, that booking's calendar. Fewer than `min_slots` is a warning with the calendar link and the day-by-day in the thread. |
| `report` | `kind` (`daily|weekly|monthly`, may be `{{vars.kind}}`), `breakdowns`, `sections`, `into` (`report`) | renders the wrap-up for the period that just ended (the period so far when started by hand) into `vars.<into> = { body, period, numbers }` and keeps it in `wrapups`; a `slack_post` of `{{vars.report.body}}` sends it. |
| any node | `title?` (the dashboard's words for it), `only_if?` (a predicate; the step is skipped when it does not hold and the chart marks it as a sometimes-step) | |
| `set_var` | `key`, `value`, `when?`, `pick?`, `else_value?` | remember something for later steps (`vars.<key>`); with `when`, the value if it holds else `else_value` (a line of copy chosen by a fact, without a fork); with `pick`, `value` is rendered and looked up in it (`"{{reply.intent}}"` with `pick: { cancelled: "they want to cancel." }`), `else_value` when nothing matches. Plumbing, hidden from the outline. |
| `record` | `event`, `data: { <field>: template }` | one event of that type in the ledger, with `data` rendered (a whole `"{{path}}"` keeps its type, so a boolean stays a boolean; a path this run does not have lands as `null`, never a failure). The type must be in `event_types` (`schema.sql` + `migrate.ts`); the sweep says so when it is not. Ours, never the CRM: runs in shadow too, starts no workflow. Pre-call scores Jev with it (`intent.reviewed`, D55). |
| `start_workflow` | `workflow` (slug), `with?` | hand off. |
| `pause_runs` | `scope: contact|appointment` | a human took over: pause the contact's other runs. |
| `exit` | `reason` | done, with a reason the outline shows. |

Every CRM write (tags, cards, records, notes, documents, appointment updates) is a no-op in shadow, recorded as
"would have". Slack posts and AI steps run in shadow. Texts and emails are recorded as "would have sent".

## 3. Copy: templates, paths, filters

Templates are strings with `{{path | filter:arg | filter2}}`. Unknown paths are refused at save unless a `default:`,
`prefix:`, `line:`, `link:` or `bullets` pipe says the value may be absent. Roots: `contact` `appointment`
`opportunity` `company` `calendar` `slack` `reply` `event` `vars` `crm` `cards` `recording` `prompt` `agreement`
`records` `now`.

Paths worth knowing (full list: `context.ts`, `describe.ts` PATHS):
- `contact.first_name` `.name` `.phone` `.email` `.timezone` `.tags` `.fields.<name>` (custom fields bound as
  `crm.field_contact_<name>`), `.owner.{name,first_name,email,mention}`, `.closer.*` (the open closer card's owner,
  else the owner), `.setter.*` (the setter field matched to a team member; `.mention` is `<@U…>` when known),
  `.paid` `.payments_count` `.cash_collected` `.first_paid_at` `.agreement_signed` `.agreement_sent`
  `.first_booked_at` `.days_to_close` `.revenue` `.source`.
- `appointment.starts_at` `.ends_at` `.status` `.term.category` `.term.name` `.closer.{name,first_name}`
  `.self_booked` `.set_by` `.answers.<question name>` `.reschedule_url` `.cancel_url` `.cancelled_by`.
- `event.*`: what the trigger carried (`event.amount`, `event.kind`, `event.status.to`, `event.tag`, …).
- `recording.*`: title, duration_min, share_url, transcript_text, closer, kind (phone|meeting), connected, led_to_booking.
- `vars.<name>`: anything `set_var`, `classify` or `analyze` stored (`vars.notes.summary`, `vars.rubric.overall_score`).
- `cards.<pipeline>.{id,stage,name,owner}`; `calendar.<role>.url`; `slack.channel.<name>`; `crm.<binding>`;
  `agreement.{name,signed_at,sent_at}`; `records.<object>.key`.

Filters: `relative` (deliberately imprecise, recomputed at send time: "in about 45 minutes", "tomorrow at 2pm";
throws on a past target so a stale message never ships, which `on_stale` then handles), `date:<luxon fmt>`,
`date_company:<fmt>` (company zone), `tz:<zone>`, `upper` `lower` `first_name`, `default:<text>`, `prefix:<label>`,
`line:<label>` (its own line, only when present), `link:<label>` (a Slack link only when there is a URL), `money`,
`abs` (the number without its sign: a refund is stored negative, the template writes the minus), `bullets`, `lines` (an analysis object as labelled lines), `truncate:<n>`, `json`, `oneof:a,b,c` (a picklist guard: the value only when it is one of these, else nothing; the CRM drops an unknown option silently).

Predicates (triggers, checks, branch edges): `{ "eq": [a, b] }` `neq` `gt` `gte` `lt` `lte` `{ "in": [a, [..]] }`
`{ "has": [list, item] }` `{ "exists": "path" }` `{ "and": [...] }` `{ "or": [...] }` `{ "not": p }`. Left sides are
`{{paths}}`; right sides are literals (strings, numbers, booleans).

## 4. Bindings: what the company fills in

Anything a template reads under `crm.*`, `calendar.*`, `slack.channel.*`, `prompt.*`, `secret.*` becomes a binding
in the workflow's manifest, shown on the settings page with a live picker (pipelines, stages, fields, users,
channels). Naming: `crm.pipeline_<board>`, `crm.stage_<board>_<stage>`, `crm.field_contact_<name>`,
`crm.field_opportunity_<name>`, `crm.assoc_<name>`, `calendar.closer_call`, `calendar.booking`,
`slack.channel.<purpose>` (bookings, deals, calls, payments, alerts, setter_calls, closers, owner, reports),
`prompt.<name>`. Slack channel bindings are optional (an unbound one skips the post and says so); everything else
is required and the workflow cannot be turned on without it.

## 5. The conventions a new workflow follows

- **Shadow first.** It ships installed OFF, the company stays in shadow, the team reads the "would have" trail on the
  contact and run pages, then Go live and turn it on. Never the other way round.
- **Dark hours.** A human-sounding text or email waits for the company's send window. Say which messages are
  receipts (`transactional`) and whether the company lets receipts through at night.
- **Timing is recomputed when it fires.** "Your call is in an hour" is written as `{{appointment.starts_at | relative}}`
  and rendered at send time: a reschedule or a late tick changes the words, never a wrong number. A wait anchored on
  the appointment moves with it. `validity.min_lead` + `on_stale` say what to do when the call is now too close.
- **Re-entry is a decision.** once per contact, per appointment, per opportunity, or within a window; `always` for
  pure notifications. A gate exit does not spend the once.
- **One open card per contact per board, and the CRM is the truth about it (D41).** Before a card step the engine
  reads the contact's cards from the CRM and adopts any it did not make; a step with a stage moves that card or
  makes one when none is open; a status-only step (no stage) marks the open card and does nothing when there is none.
- **Everything the step depends on is listed by the engine** (`coverage.ts`) and verified by the hourly sweep.
  A new node type must declare what it needs (`NODE_NEEDS`) or the build fails.
- **Every Slack post has a face** (`as`) and links the contact; the close post @mentions people.
- **Idempotent sends.** The sends ledger refuses a duplicate of the same message to the same contact from the same
  step; retries are safe.
- **Copy lives in the template, prompts in bindings.** A company may edit its copy (versions kept); a template
  upgrade leaves an edited copy alone.

## 6. The questions to ask before building (and the edge cases to raise)

When a workflow is described in a sentence, these are the blanks. Ask the ones the description left open, five at a
time, each with a recommended answer. Do not ask what the codebase or the company's settings already answer.

1. **Trigger**: which event, and which calendars / pipelines / tags count (`match`)? Setter-booked, self-booked, both?
2. **Re-entry**: can the same contact go through twice? Per appointment? Within what window?
3. **Timing**: waits anchored on the appointment or on now? Contact's zone or company's? What if the call is closer
   than the wait (guard)? What if it is rescheduled or cancelled mid-sequence (premise)?
4. **Messages**: which are human-sounding (wait for daylight) and which are receipts? What if it would land in the
   middle of the night, or 10 minutes before the call (`validity`)? Reply handling: wait for a reply, how long, what
   each intent does (`classify` on `reply_intent`)?
5. **Slack**: which channel, what face, @mention whom, thread anything?
6. **CRM writes**: tags to add/remove, cards to move (which board, which stage, create or only move), fields to set,
   records to write, tasks to open and for whom.
7. **AI**: what to read (transcript, reply, intake), with which prompt, what the output is used for.
8. **Exits**: when does it stop early (no phone, no show, paid, cancelled) and what does the exit say?
9. **Shadow**: anything that must still happen in shadow (Slack, AI) vs stay dry (CRM, contact)?

Edge cases to raise unprompted, because the description usually forgets them: night-time sends; the appointment
moved after the wait was set; the contact replies while a wait is parked; the same contact books twice; the setter
field empty; the closer not in Slack; a channel the bot is not in; a payment before the agreement (either order);
a refund; a run started on a contact with no phone; a vendor outage mid-sequence (the alert and the resume).

## 7. Build, prove, install

1. Write the template; `pnpm exec vitest run src/engine/templates.test.ts` proves it parses and every path is known.
2. Add a scenario in `templates.scenarios.test.ts` (fire the trigger, tick, assert the ledger) and a describe check
   (`describe.test` refuses raw paths or ids in the outline words).
3. `coverage.test` passes when every dependency kind is verifiable; `mermaid.test` when the chart draws it.
4. Install on the company (`POST /api/admin/install` with `templates: [slug]`, no token needed on a re-install),
   leave it OFF, stage it with the harness (`/api/admin/simulate` actions: create, book, book-self, reschedule,
   cancel, pay, record, call, agreement, sign, reset), read the run page, then turn it on.

## 8. Where the intelligence lives, and where it is going

Today: `classify` picks intents, `analyze` writes notes, scorecards and lines of copy from a prompt the company
owns, and `relative` keeps every time accurate at the moment of sending. Planned: an `analyze` step whose output is
the message itself (read the intake, write the first text in the owner's voice, with the names and the history),
sent as-is or held for a human's tap; a setter's speed-to-lead call queue; agentic handoffs between steps. The
building blocks are the same nodes above, so a planned workflow is written now and the smart step swapped in later.
