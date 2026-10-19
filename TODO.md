# Tyler's to-do

Things only Tyler can do or decide, that are holding up work. Claude adds to it; Tyler ticks things off.

## Dating (Nelly)

- [ ] Sending numbers: once Nelly is in the system, assign the automated number and Nelly's own number, then say which texts
      send from which (2026-10-18; the pre-call texts wait on it).
- [ ] Skool invite link, for the welcome text and email.
- [ ] Nelly's 1:1 kickoff booking link, for the welcome text and email.
- [ ] Commas account and API access, for Deal closed and Payment recorded (both can never run until a payment source is connected).
- [ ] The real agreement, for Payment recorded.
- [ ] Calendly's new "Dating Consultation" event type: is it triage or closing, or should it be left out?

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

