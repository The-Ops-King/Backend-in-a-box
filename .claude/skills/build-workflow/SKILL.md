---
name: build-workflow
description: Build or change an engine workflow from a plain-English description. Use whenever Tyler describes an automation ("it would trigger on X and do Y, Z"), asks to change a workflow's steps, copy, timing, channels or triggers, or asks what a workflow would do. Reads engine/04-build-a-workflow.md first, asks only the blanks the description left (five at a time, with a recommendation each), raises the edge cases, then writes the template, the tests, installs it OFF and stages it.
---

# Build a workflow

1. Read `engine/04-build-a-workflow.md` end to end. It is the exact vocabulary: nodes and their fields, events, paths, filters, predicates, bindings, conventions. Never invent a node, field, path or event that is not in it; if the idea needs one, say so and propose the engine change first.
2. Read the company's settings (`/c/<slug>/settings`, or `loadCompany` bindings) and the installed templates before asking anything: calendars and their call types, pipelines and stages, channels, prompts, users. Do not ask what is already answered there.
3. From the description, fill the nine blanks in §6 of the reference. Ask only the open ones, at most five per message, each with a recommended answer. Then raise the edge cases in §6 that the description did not cover (night sends, reschedules mid-sequence, replies during waits, double bookings, empty setter, closer not in Slack, payment-before-agreement, refunds, no phone, vendor outage).
4. Write the template in `platform/src/templates/<slug>.json`, register it in `templates/index.ts`, add the scenario test and run the suites named in §7. Every Slack post gets a face (`as`); every time in copy uses `relative` or a date filter; human-sounding sends stay `human`.
5. Install it on the company OFF (`POST /api/admin/install` with `templates: [slug]`), stage it with `/api/admin/simulate`, read the run page, show Tyler the outline link and the staged run, then turn it on only when he says so.
6. Update `engine/04-build-a-workflow.md` in the same commit if the engine gained a node, field, filter, path or event.
