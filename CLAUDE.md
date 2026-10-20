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

## Slack works the same on every offer (Tyler, 2026-10-19)

"Again, i want this to be live on all accounts. not just nelly. Slack should work the same across all." How Slack behaves
(alert buttons such as Pause, slash commands, how alerts post and repeat) is the platform's, not one offer's: a Slack change
goes to every offer in the same pass, each offer's workflow saved by name with a dry run showing only the Slack part changes.
What an offer posts and where (its channels, its words) stays that offer's own.

## The send lock (Tyler, 2026-10-18)

"I want the SMS lock as well. I'm the only one who can unlock sends." Every workflow starts with its sends locked: a text, email
or agreement reaches only Tyler's own addresses, whatever the mode says. Unlock a workflow's sends only when Tyler names that
offer and that workflow in this chat and says to unlock it. Never on inference, never in bulk, never from the dashboard.

## Configurable, not written in

Tyler wants things like where an alert posts to be settings, not code ("I want you to remember that this should be
configurable"). The first case: where the one-time "this person doesn't have a link" tag goes (Dating: #dating-calls-booked).

## Schema changes are numbered migrations (D200)

`platform/src/db/baseline.ts` is frozen (its test fails if it changes): it already ran on production and never runs again. A new
table, column, constraint or data fix is a new entry at the end of `platform/src/db/migrations.ts` with the next number, run once and
recorded in `schema_migrations`; never edit one that has reached production. Write it through the migrator (`c.query`, and `c.tx`
for a group that must not be left half done, one table per group) so it gives way to the live engine. Keep `engine/schema.sql` in
step (`pnpm -s schema:sync`): it is what an empty database starts from.
