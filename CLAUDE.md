# CLAUDE.md — backend-in-a-box

Binding rules for every Claude session in this repo.

## Every offer is its own offer (Tyler, 2026-10-18)

Tyler: "every offer is its own offer, and we only ever change one offer at a time on a set of workflows ... if we're talking
about one workflow and I say, 'Change this, update that,' we do not, under any circumstances, update all of the workflows,
unless I specifically say, 'Let's update all of the workflows that do this.' That's a bug in all of the workflows, in which case
we'll have to make sure that we're not messing anything existing up." Earlier: "I will only ever make changes to all from the
chat window here. This is a super dangerous situation which needs protections."

- A change Tyler asks for lands on the one offer and the workflows he is talking about. Nothing else.
- A change to every offer happens only when Tyler says so in those terms. Then: one offer at a time, a dry run shown for each,
  and a check that nothing already running there changes in a way he did not ask for.
- A template change or a code default never reaches an offer that already exists. Bringing it to an offer is a separate change
  Tyler asks for by name.
- A template change reaches an existing offer only through `POST /api/admin/workflows/definition` with `fromTemplate: true`,
  for the one workflow Tyler named, dry run first (D147). Install and `/api/admin/templates` never change, rename or upgrade a
  workflow an offer already has; they only add the templates they name.
- Engine code (how a step works) runs every offer. A change there must leave every existing offer's saved workflows doing what
  they did (hold them with frozen fixtures, as src/engine/fixtures/before-d141 does). If it cannot, tell Tyler before building it.
- The dashboard never changes more than one offer at a time.

## The send lock (Tyler, 2026-10-18)

"I want the SMS lock as well. I'm the only one who can unlock sends." Every workflow starts with its sends locked: a text, email
or agreement reaches only Tyler's own addresses, whatever the mode says. Unlock a workflow's sends only when Tyler names that
offer and that workflow in this chat and says to unlock it. Never on inference, never in bulk, never from the dashboard.

## Configurable, not written in

Tyler wants things like where an alert posts to be settings, not code ("I want you to remember that this should be
configurable"). The first case: where the one-time "this person doesn't have a link" tag goes (Dating: #dating-calls-booked).
