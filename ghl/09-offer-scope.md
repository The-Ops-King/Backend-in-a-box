# Sales Backend — what's included

A complete sales operating system installed in your GoHighLevel account. Every lead
tracked from first click to final payment, with no step depending on someone remembering
to do it.

---

## GoHighLevel build

| | |
|---|---|
| **Pipelines** | 2 — Setter (New Lead → Contacted → Qualified → Booked → Disqualified) and Closer (Booked → Showed → No Show → Follow Up → Closed Won → Closed Lost) |
| **Contact fields** | 32 — attribution, qualification verdicts, appointment state, speed-to-lead timestamps, reactivation ladder, payment health |
| **Sales Call object** | Dedicated record per closer call — 18 fields covering attendance, outcome, cash collected, contract value, payment terms, loss reason, DQ reason, notes. One record per call, linked to the contact, never overwritten. |
| **Calendars** | 3 — setter discovery, closer call (setter-booked), closer call (self-book), with assigned-user routing so setter credit and rep attribution never scramble |
| **Forms** | Intake, lead-magnet opt-in, qualification, and a conditional disposition form that never shows more than four fields at once |
| **Smart lists** | 10 — uncontacted past SLA, no-shows to rebook, callbacks due, follow-ups due, deposits open, behind on payment, cancelled plans, no attribution, disqualified this month |
| **Tags** | 32 — event triggers, state mirrors, system flags |
| **Attribution links** | Full UTM library per channel, plus per-rep links that route the booking to the rep who earned it |

## Automations — 14 core workflows

| Stage | What runs |
|---|---|
| **Lead arrives** | Attribution stamped write-once · opportunity created without duplicates · speed-to-lead alert with 5/15/30-minute escalation · same-day coverage sweep for overnight leads |
| **Call booked** | Confirmation immediately · 24-hour reminder from the closer · 1-hour reminder · all reminders die automatically if the call moves or cancels |
| **Call happens** | Recording detected → attendance and notes filled in automatically · otherwise the closer gets one Slack message with two links · end-of-day list of anything still open |
| **After the call** | Won, lost, deposit, follow-up, no-show, DQ each route the contact and opportunity correctly · no-show rebooking runs two touches then hands to a human · cancellations return to the setter queue |
| **Money** | Agreement and payment both tracked, deal closes when both land regardless of order · failed payments alert leadership and task the closer · cancelled plans pulled out of outstanding revenue |

Plus 7 empty extension points where anything client-specific plugs in without touching
the core.

## Software

| Tool | Role | Cost |
|---|---|---|
| GoHighLevel | CRM, calendars, forms, automation | Included in your build |
| Slack | Alerts and team routing | Free |
| Zapier | Cross-system glue | ~$69/mo |
| Fathom | Call recording, auto-disposition | $19/user |
| Aloware | Dialer, call tracking | $30/user |
| Whop | Payments | 2.7% + $0.30 |

*Typical client software cost: ~$150/month.*

## Slack

Four channels, each doubling as a role group — hiring is a membership change, never a
system change.

`#setters` speed-to-lead and rebooking queues · `#closers` disposition asks and
follow-ups due · `#leadership` escalations, payment problems, data hygiene (private) ·
`#wins` closed deals only

## Zaps

Recording → auto-disposition with AI-drafted notes · payment events → contact record ·
call activity → speed-to-lead timestamps. Slack alerts run natively in GoHighLevel, no Zap
required.

---

## What it gives you

Every lead attributed to the exact post, ad, or rep that produced it. Speed to lead
measured in minutes. No call ever undispositioned. Close rate, show rate, and set-to-close
honest enough to make decisions on. Payment health visible before a plan dies. And a
system that works identically whether you're running it alone or handing it to a team of
six.
