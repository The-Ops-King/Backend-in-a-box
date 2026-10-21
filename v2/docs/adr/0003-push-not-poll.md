# 0003. Vendors push; timers are jobs; we poll only for something we are waiting on

Date: 2026-10-21. Decided by Tyler.

**Decision.** There is no every-minute tick.
- **Events arrive by webhook:** GHL (through the Marketplace app), Whop, Fathom, Typeform, Calendly on a paid plan, and Slack.
- **Every timer is a job with an exact run time** on the worker.
- **A nightly reconcile per connector** compares the last 26 hours with what arrived and fills in what was missed, alerting
  when more than a handful were.

Polling is allowed only for one specific thing being waited on, never on a timer for no reason:
- **A sent GHL agreement.** GHL has no "signed" webhook. It is checked every 10 seconds for its first 60 minutes, then every 5
  minutes, up to 30 days. Checking stops when it is signed or voided. One request per location covers every agreement that
  location is waiting on, and it stays inside GHL's rate limit (100 requests per 10 seconds per location).
- **A call transcript** that is not ready yet, with back-off.
- **Calendly on a free plan.** A paid plan, which has webhooks, is required as the rule. A free account is polled only when
  one is onboarded as an exception.
- **A GHL offer past the 5-agency cap.** It runs on a private token with polling until the Security Review passes. Nothing
  above the connector knows which mode an offer uses.

**Consequences.** A booking reaches the engine in seconds, and a reminder fires at its minute. The polling that remains lives
inside connectors, where workflows never see it.
