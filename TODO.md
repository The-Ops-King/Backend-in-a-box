# Tyler's to-do

Things only Tyler can do or decide, that are holding up work. Claude adds to it; Tyler ticks things off.

## Every offer

- [ ] /support (D152): add it to each Slack app (Slash Commands → Create New Command, or paste the updated manifest for Dating
      and PMU), then reinstall the app. Request URL is the offer's own: `https://backend-in-a-box.vercel.app/api/webhooks/slack/<company id>/commands`.
- [ ] Before any offer moves up a rung (D151): read and mark its own GHL workflows with Claude. Hair first, before the switch-over.

- [ ] Instant contracts (D202), per offer, Hair first: in the offer's GHL, a new workflow: trigger "Documents & Contracts"
      (sent, and signed/completed), action "Webhook" to the URL on the dashboard's Setup page → Inbound doors → "GHL → documents".
      Publish it. Nothing else in GHL changes.
- [ ] Watchdog (D200): in Slack, make an incoming webhook to your own channel or DM (api.slack.com/apps → your ops app →
      Incoming Webhooks), put its URL in Vercel Production as `OPERATOR_WEBHOOK_URL`, then tell Claude to reinstall the scheduler
      (it also moves the operator key into Vault).
- [ ] Outside monitor (D200): a free UptimeRobot (or Better Stack) monitor on
      `https://backend-in-a-box.vercel.app/api/health?assert=fresh`, every 5 minutes, alerting you by Slack and email.

## Dating (Nelly)

- [x] The operator key, in the Claude environment as `CRON_SECRET` (2026-10-19; the one the Supabase scheduler sends, never a new one:
      a new key in Vercel would lock out the minute tick for every offer).
- [x] Calendly sends no reminders of its own on her two event types (Tyler, 2026-10-19).
- [x] Merge claude/dreamy-hypatia-y7gbtf to main, then apply steps 1–4 (engine/01-open.md item 54; done 2026-10-19).
- [ ] Check Triage pre-call, Closing pre-call and Setter call filed (made off), then say which to turn on in quiet (item 54 step 5).
- [ ] Slack: paste the Dating manifest and reinstall (/support); invite the bot to the six Dating channels.
- [ ] Mitch's setter link for the consultation (D153), ready once the engine change is live:
      `https://calendly.com/nellysudri/private-dating-consultation-with-nelly?utm_medium=setter&utm_content=mitch`
- [ ] Skool invite link and Nelly's 1:1 kickoff booking link, for the welcome text and email (Deal closed; waits on payments).
- [ ] Commas account and API access, for Deal closed and Payment recorded (both can never run until a payment source is connected).
- [ ] The real agreement, for Payment recorded.
- [x] Sending numbers (2026-10-19): one number, Nelly's; every text from her (D155).
- [x] Calendly's "Dating Consultation": shawnee's event type, not Nelly's; left out (D153).

## PMU

- [ ] Say go on the step 3 dry runs (re-saving Call booked, Call cancelled and Call recorded from the onboarding branch).

## Sandbox (template businesses, D183)

- [ ] Slack for the template tests, in Vercel (Production and Preview): `SANDBOX_SLACK_BOT_TOKEN`, `SANDBOX_SLACK_SIGNING_SECRET`,
      `SANDBOX_SLACK_CHANNEL` (your ops Slack app and its test channel's id), and `SANDBOX_TEST_EMAIL` = jt@jtylerray.com.
- [ ] Optional: `SANDBOX_AGREEMENT_TEMPLATE`, a GHL document template in the snapshot sub-account (else the agreement workflows
      stay off in the tests).
- [ ] `CRON_SECRET` in this Claude environment (title bar → environment → Edit), so Claude can run the sandbox tests.
- [ ] The snapshot sub-account needs at least one calendar and one user.
- [ ] Decide: give previews their own database. Every preview build runs the migration, today against the same database as
      production.

