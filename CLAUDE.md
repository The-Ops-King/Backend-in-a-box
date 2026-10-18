# CLAUDE.md — backend-in-a-box

Binding rules for every Claude session in this repo.

## Live offers are locked (Tyler, 2026-10-18)

Tyler: "If I click live it's locked in. Updating the default doesn't do anything to existing offers. Nothing does anything to
existing offers unless I say so. I will only ever make changes to all from the chat window here. This is a super dangerous
situation which needs protections."

- An offer's workflows and settings change only when Tyler asks for that change, for that offer, in this chat.
- A change to a template or to a code default never reaches an offer that already exists. It applies to offers set up after it.
  Bringing it to an existing offer is a separate change Tyler asks for by name.
- "Every offer" changes happen only when Tyler says, in this chat, that it is for every offer. Even then: one offer at a time,
  a dry run shown for each, then the real call.
- Never re-run `/api/admin/install` or `/api/admin/templates` on an existing offer to pick up a template change. Both upgrade an
  untouched copy to the newest template today (`installTemplates`, src/engine/install.ts) until open item 50 is built.
- Engine code (how a step works) runs every offer. A change there must leave every existing offer's saved workflows doing what
  they did (hold them with frozen fixtures, as src/engine/fixtures/before-d141 does). If it cannot, tell Tyler before building it.
- The dashboard never changes more than one offer at a time.

Until open item 50 (engine/01-open.md) is built, this file is the only guard. Treat it as one.
