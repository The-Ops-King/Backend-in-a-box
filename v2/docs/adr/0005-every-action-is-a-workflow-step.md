# 0005. Every action the engine takes is a workflow step

Date: 2026-10-21. Decided by Tyler: "every action the engine takes (bar the slack app) should be taken through the workflow
... so anything that we do can be adjusted at any time per client."

**Decision.**
- The core records facts and runs workflows. Every outbound effect is an outbox row: a text, an email, a CRM write, a Slack
  post, a calendar cancel, an agreement, an outbound webhook.
- Every outbox row carries the run and step that asked for it, and the database refuses a row without them.
- Code holds only platform behavior: the Slack app's buttons, modals, commands and alert repeats; the primitives; the
  connectors; the delivery gate.

**Consequences.** Today's hidden actions each become a visible step in a workflow. Two examples: cancelling a Calendly
booking inside a cancel step (old D196), and marking a contact DND when a text is refused (old D188). The full list comes from
the Phase 1 engine-action inventory.
