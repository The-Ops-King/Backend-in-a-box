# Dating, PMU and Hair: how each works, and what to make the same (2026-10-25)

Tyler: "I want all of the functionality even across all three. There are going to be different workflows on each, but the main
functionality I want to be the same across all of them ... if the end of day on PMU is based on the landing page, then I want all of
them to be based on the landing page."

Source: a read-only snapshot of each offer's live workflows (every definition, mode, version), GHL setup, calendars, roster and
terms, compared with the shipped templates. Nothing was changed by the comparison.

Where each stands: **Dating** quiet (Slack live), **PMU** ghost, **Hair** test. Dating's money workflows cannot start: Whop is not
connected there.

Fixed while comparing: the end-of-day post was broken on all three by today's D226 patch (its "not pitched" piece was not quoted
the way the per-call list needs, so the post would have printed raw template text). Saved fixed on all three (Dating v3, PMU v3,
Hair v7), each render-tested; no post went out in between.

## 1. Decisions for Tyler (each makes the offers differ today)

| # | What differs | Dating | PMU | Hair | Recommendation |
| --- | --- | --- | --- | --- | --- |
| A | No meeting link at booking | dropped (D208); its closing hour text can go out with a blank link | none | alerts at booking (note + alert channel) | one rule: alert at booking everywhere, and the hour text says "link coming" when there is none |
| B | Who says what a setter call achieved | the end of day (Jev reads, the setter files; D154/D156) | no setters | Jev's read writes the Discovery Call at once | Dating's model everywhere (the person is the truth); Hair needs its DQ / Not Interested setter stages first |
| C | A payment and the agreement | sends the one agreement automatically | Slack asks the closer to run /agreement (4 agreements, D214) | sends automatically | the template decides by the offer's list: one agreement, send it; more than one, ask the closer |
| D | GHL tasks (video task, rebook task, chase task) | off, yet the cancel post says "Rebook task: due in 1 day" | on | on | turn tasks on for Dating, or take the task words out of Dating's posts |
| E | The end-of-day page's look | not set | PMU's brand (D220) | not set | if "landing page" means this: set each offer's brand (name, logo, colour) |

## 2. Upgrades with no decision needed (behind the template; each a named change, dry run first)

**PMU**
- Call booked: find or create the contact in GHL before writing (D141: "Update, and if they don't exist, then create"); today it
  waits an hour and gives up. Add the ⚠️ "texts can't reach them" note (D188). Capture UTMs once PMU's GHL has the fields.
- Calendar availability (v1) and Health check (v2): the D189 alert steps; both together, Calendar availability first.
- Turn on: Unmatched recording (unlinked Fathom calls are raised nowhere), Agreement signed, Unsigned agreement chase (PMU sends
  no agreement on payment), Payment failed, Weekly leaderboard.
- Phone closing calls: a one-board copy of Setter call logged that reads the call and hands a closing call to Sales call recorded
  (no setter card, no Discovery Call). Today a closing call made on the dialer is never recorded.
- Sales call recorded and Call outcome filed: the closer and objection by the offer's options (today first name and a fixed list;
  PMU's objections setting is still Hair's list); the closing-call guard on Call outcome filed's triggers.
- Deal closed: its welcome email and text are **Hair's words** ("save your hair", Allan P.). Sends are locked and PMU is in ghost,
  so nothing went out; PMU needs its own welcome (Tyler's Deal closed rebuild) or the welcome off until then.
- Install files: payment-recorded and deal-closed in `installs/pmu/` are older than live; refresh so a re-install never undoes
  D214.

**Hair**
- Call booked: find or create the contact (as PMU); on a reschedule, move the card only from the stages a reschedule should
  (PMU and Dating already do: `from_stages`, keep the name); the Sales Call's call type.
- Wrap-ups (daily, weekly, monthly) and Weekly leaderboard: behind (no Deposits / Deposit cash rows, no quiet-when-empty, channel
  typed in instead of the setting). Re-save from the template with the channel as a setting.
- A test Slack channel: none, so its test-mode workflows post into the real channels marked 🧪.
- Send agreement manually: the /agreement trigger (template v4, as PMU). Today /agreement answers "no workflow on this offer takes
  /agreement yet".
- Its own GHL money flows (09 Send Agreement Manually, 10 Payment Received, 11 Agreement Signed, 13 Deal Closed, 14 Paid Not
  Signed) are published and not marked replaced/filtered/harmless: a double-message risk at go-live.

**Dating**
- Send agreement manually: the /agreement trigger (as Hair). `crm.agreement_sender` unset (bind Mitch).
- Closing pre-call: a "link coming" fallback on the hour text (see decision A).
- Its closing workflows trigger on the exact name "Closing call"; two other closing-type names exist ("Strategy session",
  "Consultation") that would start the cancel workflows but not the booked ones. No calendar uses them today: retire them.

**All three**
- No-show recovery (off everywhere): rebuild from the template before anyone turns it on (no closing-call guard on any copy).
- The end-of-day operator ping links each overdue day only on Dating (D207): move the wording into the template and to PMU and
  Hair.
- Pre-call: Dating's rules (evening reminders go earlier the same day, no day-before text when booked under 24 hours out, no hour
  text right after another text) are in no template. Put them in the template before PMU's and Hair's words are written (their
  9 messages are placeholders).
- Deal closed: only Dating's writes the deal value onto the won card; PMU's and Hair's leave it $0. Into the template.
- The Sales Call fields each offer's workflows write but its GHL object lacks are dropped silently: PMU lacks duration, transcript,
  next step date (it has follow-up date) and payment terms; Hair lacks next step, next step date and payment terms. Add them, or
  map PMU's to its follow-up date.
- MQL: only Hair defines what an MQL is, yet every wrap-up has an MQLs row (empty on Dating and PMU). Set Dating's and PMU's
  qualifying question, or drop the row there.

## 3. Already the same on all three

New lead, Speed to lead, Reactivation (off), Call cancelled's steps, Ledger drift, Fathom matching (D227), the AI call review and
scorecard, Card moved by hand, the end-of-day form (which calls it lists, GHL as the truth for what is owed), pitched (D226),
Unlinked payment's Link button, deposit detection, the alert buttons (Retry, Resolve, Pause).

## 4. Deliberately different (stays)

Dating's triage/closing split (its own booked, cancelled, pre-call and filed workflows, triage on the end of day, D143); PMU's one
board (no setter card anywhere); Dating's three-text pre-call (D208) against PMU's and Hair's longer sequence; each offer's
payment object and words; Hair's end-of-day reminder going to Tyler until launch.
