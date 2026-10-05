# What's missing for a complete backend

Three categories: built, buildable-but-not-yet, and holes in the spec itself.
The third category is the one that will bite.

---

## 1. Built and verified

| Asset | Count |
|---|---|
| Contact custom fields (Core System) | 30 |
| Sales Call object + fields + association | 1 / 18 / 1 |
| Pipelines + stages | 2 / 11 |
| Users | 3 |
| Calendar group + calendars | 1 / 3 |
| Tags (`sys-` / `seq-` / `stat-`) | 25 |
| Custom values (slots, mostly TODO) | 15 |
| Attribution link library | documented |

---

## 2. Still to build — UI only, no API path

| Asset | Count | Why it's manual |
|---|---|---|
| `[CORE]` workflows | 14 | `POST /workflows/` → 404 |
| `[STANDARD]` extension points (ship empty) | 7 | same |
| Forms — intake, opt-in, disposition | 3 | `formData` is accepted then discarded; no `PUT /forms/` |
| Email templates | ~9 bodies | shell creates; content unverifiable via API |
| Smart lists | 10 | no API endpoint |
| Agreement / contract document | 1 | `POST /proposals/*` → **401, PIT lacks the scope** |
| Calendar settings on Self Book | 3 | not in the calendar property set |
| Business hours | — | `PUT /locations/{id}` → 401 with a location PIT |

**Two of these are scope problems, not capability problems.** Documents and business hours
both return 401, not 404. A PIT with wider scope — or an agency token — may reach them.
Worth ten minutes before accepting them as hand work.

---

## 3. External to GHL, blocking

| Thing | Blocks |
|---|---|
| Slack workspace, 3 groups, webhook | Every alert. 4 custom values sit on TODO. |
| Privacy policy + terms page | A2P registration |
| A2P registration | All 6 SMS sends |
| Typeform + redirect | Step 2 qualification |
| Aloware vs GHL call routing | `[CORE] Log First Call`, all speed-to-lead measurement |
| The dashboard | Speed to lead, open dispositions, same-day contact rate |

---

## 4. Holes in the spec — undefined, not deferred

These are referenced by the design and never specified. Deferred items are tracked
elsewhere and are fine. These are different: the system assumes they exist.

### The one that worries me most

**How does disposition form data reach the Sales Call record?**

GHL forms write to *contact* fields. Sales Call fields are *object* fields. The spec says
the form triggers a contact workflow whose action is Create an Associated Record — but
never establishes whether that action can read form-submission values directly, or only
contact fields.

If only contact fields: every Sales Call field needs a matching contact staging field,
overwritten on each disposition. That's ~14 extra fields nobody has scoped, and it changes
the field layer that's already built.

§0 marked "can a form write directly to a custom object" as resolved — *"it does not need
to."* True, but the data still has to get there, and that path was never drawn. **This is
the highest-risk unverified assumption in the build, and it cannot be tested without
building a workflow.** Test it first, before the other ten.

### ~~Onboarding status field~~ — RESOLVED Sep 12

Dropped with the Clients pipeline. Client lifecycle tracking moved to v2. No field needed.

### Payment — MOSTLY RESOLVED Sep 12, see `06-payment.md`

Failed and cancelled are now designed, with three workflows and two extension points.
Two items remain open:

- **What sends the agreement and payment link** after a won or deposit disposition.
  Still unspecified.
- **The silent exit.** Signature lands, payment never does (or the reverse) — the deal
  sits in limbo with no nudge and no alert. `[CORE] Close Check` exits quietly on step 2
  by design. It is still the only failure path in the system that tells nobody.

Two new problems arrived with the payment delta — a cross-object comparison that cannot
be built as written, and an unverified Math Operation dependency. Both in `06-payment.md`.

### `fathom_link` has no source

The field exists on the Sales Call record. Nothing specifies how it gets populated —
manual paste, Zapier, or the Fathom API. Unspecified means manual by default.

### Unanswered questions from §0 that were never closed

- Do smart lists travel in snapshots? GHL's asset list doesn't mention them.
- Is Custom Webhook billed as a premium workflow action? Affects per-execution cost of
  every Slack alert.
- Can Typeform carry the GHL contact ID through the redirect as a hidden field? If not,
  matching falls back to email and a typo creates a second contact.

---

## 5. What remains — complete list

### Inside GHL, hand-built, then it travels

| # | Item | Count |
|---|---|---|
| 1 | `[CORE]` workflows | 14 |
| 2 | `[STANDARD]` extension points (ship empty) | 7 |
| 3 | Forms — intake, opt-in, disposition | 3 |
| 4 | Email templates | ~9 |
| 5 | Smart lists | 10 |
| 6 | Agreement document | 1 |
| 7 | Calendar settings on Self Book | 3 |
| 8 | Business hours | — |

### Snapshot hygiene — before the snapshot is taken

- `ZZ SCRATCH` object — undeletable via API, try the UI, otherwise deselect
- 3 GHL default tags: `follow-up`, `high priority`, `warm lead`
- 3 personal calendars auto-created with the users
- Any `sys-test` contacts

### Blocked on a decision or a verification

| Item | Consequence if wrong |
|---|---|
| Disposition form → Sales Call data path | Rewrites the field layer. **Test first.** |
| Math Operation availability + premium billing | All 3 payment workflows change shape |
| `contract_value` cross-object fix | Recommend stamping to contact; 1 field once decided |
| Aloware vs GHL call routing | `[CORE] Log First Call` cannot be written at all |
| Do smart lists travel in snapshots? | 10 items move from build-once to per-install |
| Is Custom Webhook a premium action? | Per-execution cost on every Slack alert |
| Typeform hidden contact ID on redirect? | Falls back to email match; typos create duplicates |

### External, not GHL

Slack workspace + 3 groups + webhook · privacy policy and terms page · A2P registration ·
Typeform · Whop · Fathom (`fathom_link` has no population path) · Aloware · the dashboard

### Copy

~9 message bodies plus the Slack alert formats. Written last, through the humanize pass —
prospects and closers read these, not the operator.

### Still undesigned

- What sends the agreement and payment link after a won or deposit disposition
- The silent exit: signature lands, payment never does, nobody is told
- Reactivation workflows (fields shipped, logic deferred by design)
- Three numbers: attempts before `unreachable`, days in `working` before `cold`,
  setter daily call target

### The step nobody has taken

**Take the snapshot and deploy it into a second location.** The entire premise of this
build is that it copies cleanly. That has never been tested. Every claim about what
travels — custom objects, associations, calendars, smart lists — is documentation until a
real deployment proves it.

Do this early, with a half-built system, not at the end with a finished one. A surprise
found now costs a rebuild of four assets. The same surprise found after the workflows
exist costs all fourteen.

Then seed demo data — never before the snapshot.
