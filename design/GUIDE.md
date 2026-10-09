# Design guide

How every page of the dashboard looks and behaves. Written from the decisions in `engine/00-decisions.md` (D32, D37,
D38) and the mocks under `design/mocks/`, so a new page comes out close to right the first time. When this guide and
a mock disagree, the mock is older: fix the mock.

The one idea: **simplicity, with the ability to go deep.** What is on the page at a glance is a name, a state and a
number. Everything else is one tap away, and it opens in place. Nothing is written on the page that the reader did
not ask for.

## 1. What the product is

An automations hub. It shows what the engine is doing to people and lets the operator turn things on and off. It is
not a CRM: no conversation log, no contact editing, no message history. The CRM's facts appear as chips; the CRM's
page is one button away ("Open in GHL").

The dashboard is read-only except for two things: a workflow's on/off switch and the company's "Go live" (D32).
Settings is the one page with forms, for company-wide things. Every other change goes through the chat.

## 2. Rules that never bend

1. **Dark only.** There is no light mode.
2. **Nothing scrolls sideways,** on any page, at any width, ever. A phone gets a narrower version, not a scrollbar.
3. **Flat.** No glass, no gradients, no shadows on resting surfaces. Depth is panel-on-panel (`--panel` on `--bg`,
   `--panel-2` on `--panel`). The only shadow is under a popover or a sheet.
4. **One color per meaning,** and no color means anything else:
   - green `--ok`: done
   - purple `--wait`: waiting (on a clock or a reply), and "where they are now"
   - orange `--warn`: failed
   - blue `--cond`: a condition said no (skipped on purpose), and conditional nodes on the chart
   - amber `--acc`: the trigger node, the brand accent, focus rings. Never a state.
   - grey `--fg-3`: still to come, off, not reached
5. **Blue is an icon, not a sentence.** A skipped step shows the blue icon and a "why" handle; the reason opens on
   tap. Same for a send's words. Nothing blue or quoted is on the page until asked.
6. **Hover on a mouse, tap on a phone.** A popover opens on hover where there is a pointer, on tap where there is
   not, closes on scroll, and flips upward when it would fall off the bottom. On a phone a detail is a bottom sheet.
7. **The switch is Zapier's:** a pill with a knob, green when on, no box or button around it, the word "On"/"Off"
   beside it only in a page header. Flipping it is optimistic: it moves first, the request follows, it moves back
   with a toast if the request fails.
8. **Counts on one line.** However many, whatever the width. Shorten the words before wrapping the line.
9. **No swimlanes, no side-by-side columns on a phone.** Two columns on a laptop stack on a phone with the more
   urgent column first.
10. **Dates as short as they can be:** "Today", "Yesterday", "Oct 8", "Thu Oct 9 · 2:00 PM". Never a full timestamp
    on the page; the raw timestamp lives in the folded "Advanced" row.

## 3. Tokens ("Slate")

```css
:root{
  --bg:#111214; --panel:#191a1d; --panel-2:#222327; --panel-3:#2b2c31;
  --fg:#f0f0f2; --fg-2:#a3a4ab; --fg-3:#6e6f76;
  --line:#2e2f36; --edge:#3a3b43;
  --acc:#f0b429; --acc-ink:#2a1e04;
  --ok:#5bd087; --ok-bg:#1a3b27;
  --warn:#ff8a5b; --warn-bg:#3f2316;
  --cond:#8fb7ff; --cond-bg:#1c2a44;
  --wait:#a78bfa; --wait-bg:#2a2340;
  color-scheme:dark;
}
```

- Font: Outfit (400, 500, 600, 700), system sans fallback. Tabular numerals wherever numbers line up.
- Type: page name 26px/700; section label 12px/700 uppercase, letter-spacing .06em, `--fg-3`; row title 14–14.5px/600;
  body 13.5px; small 12–12.5px `--fg-2` or `--fg-3`; tile number 22px/700.
- Radii: page panel 14px; row hover and inner panels 8–12px; pills and buttons 999px; strip segments 3px.
- Spacing: page gutter 16px; panel padding 18px 16px; row padding 8–11px 0; gaps 10–14px. Sections are separated by
  a label, not a box.
- Surfaces: the page is one `--panel` card on `--bg`. Rows are flat with a 1px `--line` on top; a row hovers to
  `--panel-2`. Inner cards (tiles, folded bodies, sheets) are `--panel-2`; a third level is `--panel-3`.
- Pills: `--panel-2` on `--fg-2` by default; state pills use the state's `-bg` and color. Origin tags: "your spec"
  is `--cond-bg`/`--cond`, "default" is `--panel-3`/`--fg-2`, "shadow" is `--wait-bg`/`--wait`.

## 4. The pieces

Every page is built from these, and only these. New pieces get added here first.

**The way back.** A `‹ Company name` line at the top of every page under a company, 13px `--fg-3`. On a run page it
also carries the workflow: `‹ Save Your Hair / Pre-call sequence`. The company page's way back is the companies
list.

**The page name line.** The name at 26px, with the page's one control at the right of the same line, centred on the
name even when the name wraps: the switch on a workflow page, "Go live" on a company page, "Open the contact" on a
run page, "Open in GHL" on a contact page. Under it, the tags line (stage, origin, shadow, "last ran") and one line
of what the thing does.

**Count tiles.** Four `--panel-2` tiles in one row at every width: the number big, the word under it. people / in
flight / finished / failed. "In flight" is purple, "failed" is orange, only when non-zero.

**The row.** The unit of every list. Flat, a `--line` on top, hover to `--panel-2`. Left to right: an icon (22px)
when the row has a state; the name (600) with a small line under it (tags, when, a short note); the counts
(`--fg-3`, bold numbers) right-aligned; the control (switch) at the right edge; or the date (12.5px/600 `--fg-3`)
at the right edge when there is no control. On a phone the counts fold into the small line as a short note
("3 in flight · 1 failed") and the right edge keeps only the control or the date.

**The strip.** One segment per step on that person's actual path, full width of the row, 6px tall, 3px gaps, flex so
it always fits. Green done, purple where they are now, blue skipped by a condition, orange the step it failed on,
grey still to come. A branch that ends on purpose (cancelled, rescheduled) is a completion: a check and all green.
The strip and the step list are built from the same list, so every segment has a row.

**The step row.** Icon (check, clock, warning, blue skip, or nothing for not reached), the step's title ("Text · 24
hours before"), the time in `--fg-3` beside it, a handle ("the words", "why") when there is something folded, and a
small line for a fact ("No reply in 4 hours", "They replied at 2:31 PM"). Tap the row to open what is folded.

**The fold.** A `<details>` row with a `--fg-3` summary: "Earlier · 4", "Identifiers", "Advanced · raw steps and
context", "Test harness". Used for everything that must exist but should not be read by default.

**Tabs and filters.** Pills in a row, wrap on a phone. The active one is `--fg` on `--bg`. Tabs carry a count
("Workflows · 5"). Filters are "All / On / Off / Needs a look".

**Chips.** A fact as `label  value` in a `--panel-2` chip; the label `--fg-3`. Used for the CRM's intake answers.

**Buttons.** One style: outlined pill (`--edge` border, `--fg` text, hover `--panel-2`). There is no filled primary
button in the dashboard; the brand amber is for the trigger node and focus only.

**The popover / sheet.** 340px panel on a laptop, bottom sheet on a phone, `--panel-2`, 1px `--edge`, the one shadow.
Title, a `--fg-2` line, then the content: a step's words in a `--panel-3` block with an amber left edge, a state line.

## 5. The chart

Drawn by us (SVG), not a library. One vertical spine, centred. One node per step, including every reminder. A node is
a rounded box (9px) in `--panel-2` with an `--edge` stroke; the trigger is amber; an end is an outlined pill; the
fork is `--panel-3`. A node that waits carries a small clock before its title; a node that only runs under a
condition carries the blue mark at its right. The fork's outcomes are labelled groups side by side ("Groups"), and
the groups that carry on curve back to the spine.

With a run shown, each node gets a small state badge at its top-right corner (green check, purple clock, orange
warning, blue skip) and nodes not reached are dimmed; the taken branch's group is outlined in amber.

On a phone the full chart does not fit without side-scroll, so a run page draws only the path that run took (spine,
the taken branch under its label, the reminders) and says "four other ways out of the fork are not drawn". The
workflow page's chart wraps its groups into two columns.

Tap a node for its popover: what it does, its condition in blue, the copy it sends, and its state on this run.

## 6. Page recipes

**Companies.** A list of rows: company name, "shadow"/"live" pill, counts, last tick.

**Company.** Name line with "Go live"; tags line ("shadow" with what it means, timezone); filters; then every
workflow down a rail: a 2px line on the left, a dot per stage lit green when something in it is on, the stage as the
section label. Rows: name, origin tag and "last ran", counts, the switch at the right edge. Journey order; Team and
Engine last; retired copies under "Other".

**Workflow.** Name line with the switch; tags; one line of what it does; four count tiles; the chart; then "Who went
through it": a row per person with icon, name, the strip, the current step in words, the date. Tap a row for the
sheet (the step list). The sheet's "Open this run" goes to the run page.

**Run.** Way back with the workflow; name line with "Open the contact"; state line (pill, shadow, started, the call
with the closer). "What happened": the feed of step rows with words and reasons folded. "What happens next": planned
steps with their times, or one line saying why there is nothing. "On the chart": the chart with the path lit and
"Open the workflow". "Advanced" folded.

**Contact.** Name line with "Open in GHL"; phone, email, timezone; tags as pills; the intake answers as chips. Tabs:
Workflows (every run, live first, tap for the run page) and Next. Identifiers and the test harness folded. Nothing
else.

**Closer's end-of-day.** Bare: no nav, no way back, no links out. One question first, then only the fields that
question needs. The closer sees their day and nothing else.

**Settings.** Forms, grouped by what they change (company, team, end-of-day form, retention). To be mocked; it keeps
the same rows, labels and switch.

**Health and wrap-ups.** Lists of rows under section labels, same pieces, "Sweep now" as the one outlined button.

## 7. Words

- Plain words, the way Tyler says them: "in flight", "finished", "failed", "went through", "didn't go out",
  "the words", "why", "last ran", "needs a look". No "runs", "nodes", "executions", "status".
- A skipped step's reason carries the numbers: "the call was 21 hours away when this came due; it needs more than 60".
- A failed step says what failed and what was done: "Slack rejected the post: channel not found. Alert raised".
- A state is one word in a pill: Finished, Waiting · Text · morning of, Failed at Tell the closers.
- Tags are lowercase: "your spec", "default", "shadow", "unconfirmed".
- One line per thing. If it needs two, the second is `--fg-2` and smaller, or folded.

## 8. Data on the page

What the page may show is what the hub stores (D38): the CRM's facts, events, runs, steps, and the engine's own sends
for 30 days. A send's words appear only inside its run, folded. A reply appears as a fact ("They replied at
2:31 PM"), not as a message. No page lists messages.

## 9. Before a page ships

- Opens on a 390px phone with no sideways scroll, and on a 1000px laptop.
- Every number on the page is on one line with its word.
- Nothing blue or quoted is visible before a tap.
- Every row that stands for a thing is a link to that thing: a person to the run, a run to the workflow, a workflow
  to the company.
- The one control on the page is on the name line, at the right.
- The page is `--panel` on `--bg`; rows are flat; the only shadow is a popover's.
- Dates are short; the raw ones are folded under Advanced.
- Words match §7.
