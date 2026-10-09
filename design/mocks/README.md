# UI mocks

Static HTML, one file per section of the workflow page, each with the options that were
on the table and the chosen one selected on load. They are the reference for the rebuild
(decision D37 in `engine/00-decisions.md`), not shipped code.

| File | Section | Chosen |
|---|---|---|
| `flow-chart.html` | The flow chart | Option 4, "Groups": vertical, one node per step, the branch as a fork, reminders as their own conditional nodes; wraps to two columns on a phone, never side-scrolls |
| `who-went-through-it.html` | The people who went through the workflow | Option 3, "Progress": one row per person, a strip across the row with one segment per step on that person's path; tap for the step list |

Colors are the "Slate" set defined at the top of each file (dark only). The strip and the step list are
built from the same list of steps, so a segment in the row always has a row in the detail.
