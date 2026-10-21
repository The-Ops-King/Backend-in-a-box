# One template for every sales process: what the three offers run, and how to build it (2026-10-21)

Tyler (2026-10-21): "write a template based on what currently exists on the 3 offers, PMU, Hair, Dating ... either one offer
template that we can just load up and adjust, OR multiple templates for different sales processes." Then: "sometimes there will
be setters, sometimes closers and setters, sometimes closers who set. sometimes there is no triage call, sometimes there is a
webinar, i want to prepare for all of them." `jtr` is ignored (the day-one bootstrap company, 11 stale workflows, see 01-open #26).

Source: `spec/{pmu,hair,dating-nelly}/`, generated from the live database on 2026-10-21 (`pnpm spec --from db`, `pnpm traces`),
compared step by step with `platform/src/templates/*.json` and `platform/src/playbooks/`. Read-only: nothing here changed an offer.

Every finding in section 3 is one offer's. Under CLAUDE.md none of them is fixed here; each waits for Tyler to name the offer and
the workflow, dry run first.

## 0. The answer

**Neither one template nor a list of playbooks: one set of modules, one per choice.** The choices multiply (3 team models x 5
ways in x 3 call structures x 2 board shapes x 5 money models, with or without an agreement: hundreds of combinations). Three
hand-built playbooks cannot cover that, and one template full of switches turns every workflow into a maze of branches. What the
code already half has is the right shape: an offer described by its **traits** (`src/playbooks/index.ts` `Traits`: boards,
booking, application, triage), the shipped templates as the base, and a build that edits copies of them. Today the traits are only
labels for the wizard; each playbook is a hand-written builder that ignores them. The work is to make the traits drive the build:
each value of each choice is a module that adds, drops or changes steps and workflows, and an offer's copies are the templates
with its modules applied in a fixed order.

What makes this safe to do, given three live offers are built by today's playbooks:
1. Close the three paths by which a playbook change can reach a live offer without a named dry run (section 3.1). First. Done (D208).
2. Freeze today's PMU and Dating builds as fixtures and require the new composer to reproduce them byte for byte; Hair stays
   "templates as shipped" (no copies).
3. Only new offers (and the template businesses, D178) are built by the composer. An existing offer moves only when Tyler names
   it, one workflow at a time, dry run first.

## 1. What the three offers run today

30 shipped templates. Hair runs them almost untouched (edited: Call booked and five team workflows); PMU runs 9 of them as its
`one-board` playbook's copies; Dating runs Deal closed and Setter call logged as copies plus 8 workflows of its own, which take
over Call booked and Pre-call sequence (`application-triage`).

Legend: **=** same steps as the template on every offer that runs it. **Shared** = belongs in every future offer's template.
**Choice** = varies with a sales-process choice (section 2). **Own** = one offer's words, names or settings.

| Workflow | PMU | Hair | Dating | What the differences are |
| --- | --- | --- | --- | --- |
| New lead | copy | = | = | Choice (boards): which board the card lands on. Choice (way in): PMU accepts a VSL tag without a phone. |
| Speed to lead | = | = | = | Off everywhere. Assumes the lead books themself; a setter model needs "call them now", not a link. |
| New from Typeform | | | own | Choice (way in = application). Starts on any form: needs a `form_id` filter before a second form exists. |
| Call booked | copy v7 | edited | own x2 (triage, closing) | Choice (boards): setter card or not. Choice (calls): one workflow per call type. Shared: PMU and Dating both built a reschedule fork (keep the card's name, move only from pre-call stages) the template lacks. |
| Call cancelled | copy | = | = + own (triage) | Choice (boards), Choice (calls). |
| Cancellation rebook | = | = | = | Off everywhere. Links `calendar.closer_call`, not the cancelled call's own calendar. |
| Pre-call sequence | copy | = (off) | own x2 | PMU: card follows the reply (Confirmed / Unresponsive). Dating: three texts, plus the timing fixes D193/D194/D199 and the no-link handling, which are Shared and exist only in Dating's copies. PMU and Hair words are still `[placeholder]`. |
| Calendar availability | v1, off | = v2 | = v2 | PMU never got v2 (its own Slack alerts); see 3.2. |
| Sales call recorded | copy | = (older) | = | Choice (boards): setter card step. Shared: the configurable objection and closer options (v11) that Hair and PMU lack. |
| Setter call logged | = (off) | = | copy (46 of 79 steps) | Choice (team): Dating moves the setter's CRM writes to the end-of-day form (D154) and Setter call filed. PMU cannot enable it (needs a setter board), so PMU has no dialer-to-closing hand-off. |
| Setter call filed | | | own | Choice (team): the CRM half of a setter's call, filed at end of day. |
| Triage call filed | | | own | Choice (calls = triage then closing). |
| Call outcome filed | copy v8 | = | = | Choice (boards). PMU's copy lacks the closing-call condition (3.2). |
| Card moved by hand | copy | = | = | Choice (boards): which drags file a no-show. |
| No-show recovery | = | = | = | Off everywhere; all three are behind the template's closing-call condition (3.2). |
| Post-call follow-up | = | = | = | Off everywhere. No call-type condition even in the template. |
| Unmatched recording, Unlinked payment, Ledger drift, Health check | = | = | = | Platform. PMU's Health check still says availability alerts (3.2). |
| Payment recorded | copy | = | = | Choice (boards): card to Purchase vs Agreement Sent. Own: PMU's payment object is written into the step, not the setting. |
| Payment failed | = | = | = | Nothing goes to the customer; a closer owns collections. |
| Deal closed | copy | = | copy | Choice (boards): no setter card on PMU. Shared: Dating's won card carries the deal value (D130); Dating holds placeholder words so they never send. Bug: PMU's welcome is Hair's (3.2). |
| Agreement signed, Send agreement manually, Unsigned agreement chase | = | = | = | All three behind the template's `/agreement` trigger (D202). All assume pay first, sign after. |
| Reactivation | = | = | = | Off everywhere. Shared gap: no stop on reply or booking. |
| EOD reminder, EOD filed, Daily / Weekly / Monthly wrap-up, Weekly leaderboard | = | edited | edited | Own: schedules and words. |

## 2. The choices, and the module each value needs

Status: **exists** (built and running on an offer), **partial** (pieces exist, tied to one offer's playbook), **missing**.

### 2.1 Who works the lead (team)

| Value | Status | What the module does / what is missing |
| --- | --- | --- |
| Setter + closer | exists | Hair, Dating. Two flavours of the setter's CRM writes: on the call (template) or at end of day (Dating, D154/D156). That is a setting of this module, not a playbook. |
| Closer only (lead books themself) | partial | PMU drops the setter cards, but only because it is one board, and still requires setter settings to enable (Call booked). Needs: no setter path and no setter settings required; the dialer-to-closing hand-off split out of Setter call logged; booking-source tags that do not assume a setter. |
| Hybrid (one person sets and closes, separate calls) | missing | A person has one role (`users.role`, one row per email, schema.sql:31-39). Needs a numbered migration for more than one role per person, then the leaderboard sides, `/team` channels, setter links and closer options made role-aware; Set detected without a setter-link booking. |
| Outbound (closes on the dial) | missing | Separate strategy. Needs a Sales Call keyed by the conversation when there is no booking (today a phone closing call with no booking gets no record), outcome filing with no appointment, and a "set and closed on one call" read. |

### 2.2 How leads come in

| Value | Status | Module / gap |
| --- | --- | --- |
| Ad lead (GHL) | exists | New lead, Speed to lead. A lead needs a phone (waits 24h, then exits). |
| VSL / direct booking | partial | PMU's VSL tag rule lives in its playbook params. Needs: the lead rule as a setting; a "watched, didn't book" nurture; a booking made before the lead exists. |
| Application form | partial | Typeform only (`typeform.ts`); "GHL form" is a wizard answer with nothing behind it. Needs a `form_id` filter per form. |
| Webinar (live, evergreen) | missing | No event, no record, no workflow ("webinar" appears nowhere in src). Needs registered / attended / missed events per platform, a record that is not a calendar booking, a reminder sequence anchored to the webinar time, attended -> book the closing call, missed -> replay. Platform not chosen. |
| DM setting | missing | A GHL Instagram or Facebook message arrives labelled SMS (`adapters/ghl/read.ts:83-87`). Needs a DM channel, a lead without a phone, setter tasks instead of texts, the setter taken from the conversation's owner. |

### 2.3 The calls

| Value | Status | Module / gap |
| --- | --- | --- |
| One closing call | exists | The templates (trigger on `term.category = closing`). |
| Triage, then closing | partial | Dating's own workflows, matched by calendar name. Needs: call identity in the template (category vs name is inconsistent today), and every post-call workflow filtered by call type (No-show recovery, Post-call follow-up, Sales call recorded and Card moved are not). Risk: a second setter card (3.2). |
| Webinar, then closing | missing | See 2.2 webinar. |
| Follow-up / demo calls of the same category | partial | PMU's Follow-up calendar runs Call booked as a new booking (3.2). Needs a call kind per calendar (closing, follow-up, demo) that every booking workflow reads. |

### 2.4 Boards

| Value | Status | Module |
| --- | --- | --- |
| Setter board + closer board | exists | The templates. |
| One board | exists | `one-board.ts` (PMU): drops every setter-card step, its own stage map. Already split in `ghl-setup.ts` (D175). |

### 2.5 Money and agreement

| Value | Status | Module / gap |
| --- | --- | --- |
| Paid in full | exists | One price per offer (`contract_value`, else the offer default). Processor written in as Whop. |
| Deposit | exists | D119: a declared deposit product. Missing: Jev's "how did the call end?" read has no deposit answer. |
| Payment plan | partial | Installments recorded; what is due when is not tracked, no payment-due or overdue event, no customer-facing failed-payment sequence. |
| Financing partner | missing | Needs lender events (applied, approved, declined, funded), a payout kind that counts as paid, a way to link a payout the lender sends (today it would land as unlinked), contract value kept apart from net received, a financing-pending outcome and stage. |
| Trial (rare) | missing | A trial charge today reads as an installment and would win the deal and send the agreement. Needs a trial kind kept out of "paid beyond a deposit", as D119 did for deposits, and its own sequences. |
| Without an agreement | missing | Deal closed requires a signed agreement, so an offer without one never closes. Needs `agreement.required` (and before or after payment) read by Deal closed and Payment recorded. |

## 3. Findings

### 3.1 Platform: paths a playbook change can take to a live offer without a named dry run

These are engine code and admin API, so they are the platform's, not one offer's. They must be closed before any playbook code
is restructured.

**Closed 2026-10-21 (D208).** The route is a dry run unless `apply: true`, and a running offer takes one named `workflow`; install
refuses a second run or a company that is not onboarding; `fromTemplate` is refused (409) on a copy the kept playbook builds,
pointing at the playbooks route (refused rather than rebuilt, so the rebuild is its own named dry run). `setter_call.filed` is in
`engine/schema.sql`. Open caveat: the `fromTemplate` guard reads the company's `playbook` binding, which as far as the repo
shows PMU and Dating do not have (their copies were saved one at a time through the definition route, not by a playbook apply),
so it protects them only once their playbook is recorded, a separate change Tyler names per offer. Until then on those two, only
the named dry run's diff catches it.
The findings below are as they were found.

1. **`POST /api/admin/playbooks` writes unless told not to** (`app/api/admin/playbooks/route.ts:41`, `dryRun: body.dryRun === true`)
   and rewrites every copy at once (PMU 9 workflows; Dating every copy and own workflow). Hand edits to steps are overwritten
   (words are kept, D177; `apply.test.ts`). Against CLAUDE.md and D147. Fix: dry run unless `apply: true`, and refuse a company
   that is not new or a template business unless one workflow is named.
2. **Re-running the wizard's install step re-applies the playbook with no dry run** (`src/onboarding/install.ts:63`), and nothing
   refuses it once the company is active. Not checked: whether Hair, PMU or Dating have an onboarding row. Fix: refuse install on
   a company that has already been installed.
3. **`fromTemplate: true` on a playbook copy drops the playbook's changes** (`src/engine/definitions.ts:158-166`): on PMU's Call
   booked it would save the raw template. It is named and dry-run first, so only the diff catches it. Fix: for a playbook copy,
   rebuild through the playbook instead of the raw template.

Also: no frozen copy of today's PMU or Dating build exists. `playbooks.test.ts` compares the committed `installs/` files, and its
failure message says to rebuild them, so they move with the code. `engine/schema.sql` is missing the `setter_call.filed` event
type that `baseline.ts:245` has (an empty database would not accept it).

### 3.2 Per offer (each waits for Tyler to name it)

**PMU**
- Deal closed `e1`/`e2` send Hair's welcome (known, 13-port-nelly). Cause is upstream: the shipped `deal-closed.json` holds Hair's
  words and `one-board.ts` does not replace them, while `application-triage.ts:61-66` does. PMU runs in ghost with sends locked;
  nothing has gone out.
- Calendar availability is v1 and off; Health check still says availability alerts itself. Slack works the same on every offer
  (CLAUDE.md), so this is the outstanding part of 13-port-nelly B2/B3 for PMU. With the check off PMU raises no low-availability
  alert at all.
- Call booked lacks the template's `ensure_contact` (waits for GHL instead) and the DND / no-phone warning (D188).
- Call outcome filed (v8) has no closing-call condition on either trigger.
- Its "Follow-up call" calendar is closing-category: Call booked treats a follow-up as a new booking (card back to Booked Call,
  new video task, new Sales Call). Pre-call excludes it; Call booked does not. From the code; not seen in a trace.
- Setter call logged cannot be enabled (setter-board settings unbound), so a closing call made on the dialer never reaches Sales
  call recorded.
- Payment recorded writes `custom_objects.cash` in the step, not through `crm.object_payment`.
- Pre-call words are `[placeholder]` and the workflow is on (ghost).

**Hair**
- Call booked lacks `ensure_contact`; its booking card has Hair's intake fields written into the text instead of the
  `bookingCard` setting ("configurable, not written in").
- Sales call recorded and Setter call logged are behind on the configurable objection, closer and object settings (harmless today).
- No-show recovery lacks the closing-call condition (off).

**Dating**
- Possible second setter card: once Triage call filed marks the setter card won, Closing call booked and Call cancelled look for
  an open setter card, find none, and create one (`engine/cards.ts:57`). From the code; the one trace is a first-time contact.
- Speed to lead (off) would email "still want to talk?" to a lead who booked triage: its booked check counts closing calls only
  (`context.ts`), and Dating's booking link is the triage calendar.
- No-show recovery (off) lacks the closing-call condition, so a triage no-show would get the closer's rebook link.
- Post-call follow-up (off): a triage call filed "follow up" would get the text (no call-type condition, template included).
- No callback task anywhere for a setter's "follow up" (dropped with D154).
- A triage "set" ends at Showed (won), a setter-call "set" at Appointment Set: confirm which is meant.

**All three**
- Send agreement manually is behind the template's `/agreement` trigger (D202).
- Reactivation does not stop when the person replies or books.

## 4. Build plan

In order. Each step is reviewed before the next. Nothing here touches a live offer; the last step is the only one that can, and
only as Tyler names it.

1. **Close 3.1** (playbooks route dry run by default and one workflow for an existing offer; install refuses a second run;
   `fromTemplate` on a playbook copy rebuilds through the playbook). Sync `setter_call.filed` into `engine/schema.sql`. Tests.
   **Done 2026-10-21 (D208)**, with `fromTemplate` refused on a playbook copy (pointing at the playbooks route) rather than rebuilt.
   Still open: PMU and Dating have no `playbook` binding, so the `fromTemplate` guard does not cover them until Tyler names
   recording each one's playbook.
2. **Freeze today's builds**: copy the current PMU and Dating build output into `src/playbooks/fixtures/2026-10-21/` and a test that
   requires every future build of those two offers to equal it byte for byte, plus Hair's to stay empty.
3. **Shared lessons into the templates**, as new template versions (they reach no existing offer, D147): the reschedule fork,
   D193/D194/D199 timing, the no-link alert, the won card's value, placeholder holds, call-type conditions on every post-call
   workflow, Reactivation's stop, Deal closed's welcome as placeholders (not Hair's words).
4. **The composer**: `Traits` widened to the five choices in section 2 (team, ways in, calls, boards, money, agreement), each value
   a module (`src/playbooks/modules/`), applied in one fixed order over the shipped templates. The three playbooks become presets
   (a named set of trait values plus params). Gate: the step-2 fixtures pass unchanged.
5. **The wizard asks the choices** instead of picking the closest playbook, and the fit report names every value marked missing.
6. **Template businesses (D178)**: one per preset to start (setter-closer, one-board, application-triage), made, tested in the
   sandbox (D182) and published. New clients start there.
7. **Missing values, one at a time, as Tyler needs them**: closer only, then hybrid (needs the roles migration), webinar (needs
   the platform chosen), financing, DM setting, trial, outbound, without-agreement. Each is a module plus whatever events and
   records section 2 lists, with its own decision entry.
8. **Existing offers**: none moves to the composer on its own. Each fix in 3.2, and any move of an offer to a preset, is a named
   change, dry run first.

## 5. Open for Tyler

1. Order of step 7: which missing value first? (Recommendation: closer only. It is the smallest, and PMU-style offers already
   need it.)
2. Webinar platform, when there is one: it decides the events.
3. Dating: should a triage "set" end at Showed (won) or Appointment Set?
4. The 3.2 fixes: which offer and workflow first. PMU's Deal closed welcome and Calendar availability are the most visible.
5. jtr: leave it, or retire it as a separate, named change.
