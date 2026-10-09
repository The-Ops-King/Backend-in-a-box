# UI mocks

Static HTML, one file per section of the workflow page, each with the options that were
on the table and the chosen one selected on load. They are the reference for the rebuild
(decision D37 in `engine/00-decisions.md`), not shipped code.

| File | Section | Chosen |
|---|---|---|
| `flow-chart.html` | The flow chart | Option 4, "Groups": vertical, one node per step, the branch as a fork, reminders as their own conditional nodes; wraps to two columns on a phone, never side-scrolls |
| `company-page.html` | A company's page: every workflow it has | Option 7, "Rail, flat rows": a line down the left with a dot per stage (lit when something in it is on), the stage as the section label, flat rows with the name and its tags, the counts then the on/off switch at the right edge, filters (all, on, off, needs a look) on top; the company header carries the shadow tag and the one Go live button |
| `page-header.html` | The top of the workflow page | Option 3, "Numbers": the way back on its own line, the name with the on/off switch at the right of the same line, the tags (stage, origin, shadow) with when it last ran, the description, then four count tiles on one line at every width |
| `who-went-through-it.html` | The people who went through the workflow | Option 3, "Progress": one row per person, a strip across the row with one segment per step on that person's path; tap for the step list |

Colors are the "Slate" set defined at the top of each file (dark only). The strip and the step list are
built from the same list of steps, so a segment in the row always has a row in the detail.
