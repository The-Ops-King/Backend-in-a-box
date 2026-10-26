# What is hard-coded, and what the workflows decide (2026-10-26)

Tyler: "everything should use the workflows as the actual instructions. the hardcode just executes the workflows." And the goal:
"if i have another offer to stand up tomorrow i can just say 'build out the GHL for hybrid' or 'build it out for setter & closer'
and it will just build everything out."

Read-only audit of the engine code (27k lines), the playbooks, the install path and the three live offers' configuration. Four
reviews, spot-checked. File references are under `platform/src` unless marked. Most findings were a deliberate decision at the time
(the D-number is given); this lists them so they can be moved where they belong, not because they were mistakes.

## 1. Already done right (the model to copy)

- **The end of day never writes the CRM.** Filing emits events (`appointment.outcome`, `call.held`, `setter_call.filed`,
  `eod.filed`); Call outcome filed, Setter call filed and EOD filed do the writes and posts.
- **Alerts** are events (`alert.raised/repeated/resolved`); Health check and Calendar availability word and post them.
- **Ledger drift** hands its GHL repairs to the Ledger drift workflow under the mode guard.
- **Texts and emails** go out only from workflow steps (no send outside `executor.ts`).
- **Ingestion** (GHL/Calendly poll, Whop, Fathom, Zapier, Typeform parsers) normalises into the ledger and emits events.
- **Live workflow definitions carry no raw Slack ids, GHL ids, user ids or emails** on any offer: everything goes through settings.

## 2. Behaviour outside a workflow (the engine acts on its own)

| Where | What it does | Decision | Should be |
|---|---|---|---|
| `engine/scope.ts:65-82` (from `poll.ts:233`) | tags every new booker with the scope tag in GHL | D117 | a tag step in Call booked |
| `engine/typeform.ts:143-159, 212-219` | the Typeform door creates/updates the GHL contact and its fields | D122 | a contact step in New from Typeform |
| `engine/setter-missing.ts:42-87` | writes `set_by` from a dial in the Set window; composes the alert sentence | D121, D87 | a workflow step; the words in the workflow |
| `engine/webhooks/slack-actions.ts:75-108`, `slack-link.ts:47-65` | Retry/Resolve/Pause and Link buttons edit posts, react ✅, add thread lines | D93, D150 | acceptable as UI; could emit an event Health check words |
| `engine/sales-call-backfill.ts:642`, `recording-relink.ts`, `contact-ops.ts`, `crm-repair.ts` | operator tools write GHL directly (dry run, audited) | D115, D227… | fine as operator tools; property keys from settings |
| `engine/executor.ts:590-597, 824` | `analyze`/`classify` quietly copy their output onto the recording (`recordings.analysis`), which the end of day reads | none | the step declares what it keeps |

## 3. Business rules in engine code (no offer can change them)

| Where | Rule | Decision |
|---|---|---|
| `engine/payments.ts:40-47` | a payment's kind: deposit / installment / balance / paid in full ("short of the price is the first installment") | D119 |
| `engine/deposit-names.ts:13` | a product named "deposit" is a deposit when the offer declares none | D119 |
| `engine/recordings.ts:118-145` | a call no booking fits: client (cash or a filed close), held late (3 days), else follow-up; 14-day window | D236 |
| `engine/recordings.ts:44-47, 90-94` | a recording fits a booking: starts ≤20 min before, short call 15 min, 24 h window | D227 |
| `engine/recordings.ts:179, 310` | a call only the team spoke on is "internal": no event at all | D227 |
| `engine/eod.ts:197-222` | end-of-day prefill order: ledger, then payment, then a won card, then the AI (never pre-sets Closed) | D80, D119, D236 |
| `engine/eod.ts:243-257`, `executor.ts:899-965` | what is owed on the end of day and in the overdue ping (GHL "scheduled" = not answered, 2 days) | D88, D207 |
| `engine/eod.ts:323-346` | when a refiled answer is written again or held | D134, D136 |
| `engine/poll.ts:255-278` | a cancel after the call's start never overwrites a show/no-show | D73, D76 |
| `engine/poll.ts:182-189` | a setter link is `utm_medium=setter`; setter matched by name or email | D153 |
| `engine/disposition.ts:25` | a close or deposit means pitched | D226 |
| `engine/ledger-drift.ts:148-153` | GHL "pending" becomes closed / deposit / pending by cash | D236 |
| `engine/leaderboard.ts:27-119` | the leaderboard's ranking, sections and every word (the workflow only posts `{{vars.board.body}}`) | D94 |
| `engine/bot.ts:131-206` | the bot's picture of the funnel (setter board → Sales Call → closer board → Payment) and its shortcut metrics | D70 |
| `engine/executor.ts:658` | Calendly cancel reason "Cancelled by the team" (Calendly emails it to the contact) | none |

## 4. Offer-specific code (one client's names in the engine)

| Where | What | Decision |
|---|---|---|
| `engine/booking-card.ts:56-75` + `install.ts:129`, `db/migrate.ts:94` | Hair's intake lines (hair loss, noticing for…), backfilled on every install | D104 |
| `db/migrations.ts:88-104` (0009, 0010) | `slug='pmu'` with Whop payment ids: PMU's ledger fixed in the schema migrator | D229 |
| `db/migrations.ts:23-36`, `setting-defaults.ts:17` | Hair's work-situation question and Hair's objection list seeded onto every offer | D200 |
| `engine/eod.ts:151`, `db/baseline.ts:248` | `'dating_dq_reason'` in engine SQL and the schema seed | D154 |
| `templates/deal-closed.json` e1/e2 | **Hair's welcome email and text in the template**: every new offer inherits "save your hair", Allan's links; PMU's live copy sends them (PMU is in ghost, so none went out) | D118 |
| `onboarding/messages.ts:20` | a Hair-words detector (to catch Hair's copy in other offers) | fine |

## 5. Engine code coupled to one workflow's insides

| Where | Coupling | Breaks when |
|---|---|---|
| `engine/webhooks/agreement-request.ts:201` | reads the result of node `d1` of Send agreement manually | the node is renamed |
| `engine/executor.ts:1027-1031` | `start_workflow` finds its target by name, falls back to node `t1` | a workflow is renamed |
| `engine/eod.ts:142-156`, `setter-result.ts:69-84` | reads the fields Setter call logged's `record` step writes | that step's data changes |
| `engine/eod.ts:197-222` | reads `analysis.notes.{disposition, summary, pain, …}` from Sales call recorded's `a2` | the prompt's keys change |
| `engine/reports.ts:109-115` | imports the wrap-up template files for copies with no layout | — |
| `engine/sales-call-backfill.ts:111-131` | finds Call booked / Call recorded by slug and step shape | a playbook reshapes them |
| many: `executor.ts:1181-1288`, `eod.ts:84-92`, `ghl-metrics.ts`, `backfill.ts:88-99` | Sales Call / Discovery Call property keys (`external_id`, `contact_id`, `call_date`, `closer`, `setter`, `outcome`, `disposition`, `call_result`…) and value words ("showed", "no_show", "scheduled", "set"…) are literals; `discovery_call.results` exists but these paths ignore it | an offer's object uses other keys or options |
| `engine/context.ts:155-172`, `metric-registry.ts:187`, `ghl-metrics.ts:202-244` | "closer" = the closer board's card owner; closes = won cards on the closer board; setter = the setter board | an offer has one board and hybrid people |

## 6. Setting up an offer today

Two paths, neither one command. The wizard (`/api/v1/companies/[slug]/onboarding`: offer → connection → research → slack → crm →
install → messages → filters → test) builds boards, fields and objects but **no calendars**, and its triage playbook installs no
triage workflows. The repo path (how Dating and PMU were done) is hand-written `installs/<co>/ghl-setup.json`, provision, hand-merge
ids into `installs/<co>.json`, install, hand-written `playbook.json` (+ Dating's `words.json`, `copies.json`), `build-copies`, save
each copy. **Hair has no `installs/` record**: it cannot be rebuilt from the repo.

Playbooks are named after offers (setter-closer = Hair, one-board = PMU, application-triage = Dating), and two of them work by
TypeScript surgery on the templates (`playbooks/one-board.ts:157-244`, `playbooks/application-triage.ts:54-358`): dropping setter-card
steps, inserting a call-type step, writing whole workflows (Dating's triage filed), call types by **name** ("Triage call", "Closing
call", PMU's "Demo call", "Follow-up call"). There is no "hybrid" role (closer and setter are exclusive at install).

**The shipped templates handle closing calls only.** Call booked, Call cancelled, Call outcome filed, Pre-call and No-show recovery
all require category `closing`; triage (first_call) handling exists only as Dating's copies, and those move setter-board cards a
one-board GHL does not have. So a hybrid offer with an inbound triage call (PMU's Demo) cannot be built today without new code.

GHL shapes: `twoBoardSetup` / `oneBoardSetup` exist (`playbooks/ghl-setup.ts:88-108`) but are not canonical (Dating's hand-written
file differs) and do not build calendars, the calendar group or the team.

## 7. The three offers' data (unique, not explained by their process)

- **PMU**: "Demo call" and "Follow-up call" are category *closing* (Tyler: Demo is an inbound triage call); names patched around in
  `call-booked` (`v_type`) and `pre-call-sequence` (`neq "Follow-up call"`). No setter role though its people are hybrid. Objections
  16 in its playbook vs 8 in its setting; dispositions missing financing_denied and close_pending; `payment-recorded` writes
  `custom_objects.cash` literally; "vsl a"/"vsl b" tags literal in New lead; no UTM fields bound. 3 duplicate end-of-day form rows.
  Users duplicated (Makayla ×2, Trust Funnel ×4, reggie ×3, Jose P / Jose Perez).
- **Hair**: booking card lists Hair's intake fields literally (others use `contact.intake_lines`); end-of-day reminder DMs the operator
  "until launch"; `utm_source` and `lead_source` bound to the same GHL field; no `sales_call.closer_options`; dispositions lack
  `no_offer`; calendars carry no booking kind (setter vs self from the ledger only).
- **Dating**: triggers match call-type *names*; leaderboard/monthly schedules 08:01/08:02 vs 09:00/08:00 elsewhere; no
  `crm.agreement_sender`; Tyler is a round-robin host on both production calendars; Mitch's calendar email ≠ his roster email.
- **All**: objections written as fixed lists (`oneof:`) in Sales call recorded on PMU and Hair (Dating reads its setting); DQ reasons
  written into Setter call logged.

## 8. Their own GHL workflows (double-message risk at go-live)

PMU: 49 published and unmarked; its GHL workflow check has never run. Overlapping: Deal Closed (and the engine's `payment-received`
tag starts a GHL automation), WF01 Pre Call Reminders, Auto Sounding reminders, Follow up appointment reminders, Triage Call / iClosed
reminders, WF01b Calendly Cancel/Reschedule, Cancel Communication, Move Client through Client Pipeline. Hair: 25 unmarked, including
09 Send Agreement Manually, 10 Payment Received, 11 Agreement Signed, 13 Deal Closed, 14 Paid Not Signed, 08 Closer Stage Change, 04
Setter Confirmed, 06 No-show sweep. Dating: all 11 under one blanket mark; the check is stale (10-19).

## 9. The plan to "build it out for hybrid / setter & closer"

1. **Two shapes, as data**: `hybrid` (one board; people set and close) and `setter_closer` (two boards), each with options
   (application form, triage call). One canonical GHL spec per shape that also builds calendars per call type, the group and the
   team; a snapshot test per shape; one command that provisions GHL, installs, and writes `installs/<co>/` from the result.
2. **Templates that branch on call category, not name**: first_call (triage/discovery) paths in Call booked, Call cancelled, Call
   outcome filed and Pre-call, with setter-board steps gated on the offer having a setter board (as Setter call filed already is).
   Then Dating's and PMU's TypeScript surgery goes away; what is left is settings and words.
3. **Rules into settings or steps**: payment kinds, recording placement windows, the end of day's prefill/owed rules, the scope-tag
   and Typeform contact writes as steps; leaderboard words and the Calendly cancel reason into the workflow.
4. **Declared outputs instead of hidden couplings**: steps declare what they keep (`analyze` notes), events declare their fields,
   `start_workflow` targets by template, the agreement reply reads the run's own outcome; Sales Call / Discovery Call field keys
   and values from settings.
5. **Clean-ups**: Hair's welcome out of the Deal closed template (a words setting); Hair's intake, objections and DQ domain out of
   engine code and seeds; PMU's data migrations out of the migrator; Hair exported to `installs/hair`; the data list in section 7;
   mark or turn off the overlapping GHL workflows (section 8).
