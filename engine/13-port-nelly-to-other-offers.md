# What changed for Nelly, and what it takes to bring it to another offer (2026-10-20)

From Nelly's go-live (item 54), D186 to D198. Every offer is its own offer: nothing in sections B to D reaches Hair or PMU until
Tyler names the offer and the workflow, and each one goes with a dry run first (`POST /api/admin/workflows/definition`,
`fromTemplate: true` for a template change, D147).

**Which offer is which:** production holds two offers, `dating-nelly` and `pmu`. The `pmu` install books through Save Your Hair
Today's Calendly. Confirm whether "Hair" and "PMU" are that one offer or two before anything is ported.

## A. Already on every offer (engine code, nothing to port)

| D | What | Note |
|---|---|---|
| D188 | Do Not Disturb: a text to a DND contact is skipped quietly (no alert); a GHL DND refusal marks the contact | The ⚠️ on the booking card is a template change (B1) |
| D191 | The EOD reminder counts setter dials owed, not only closer calls | Only where the EOD reminder is on |
| D192 | Go-live no longer waits on the GHL workflows check; Health check says a new or re-enabled GHL workflow once | |
| D196 | A workflow's cancel step cancels the Calendly booking (Calendly tells the invitee) | Held in quiet and ghost. Needs a Calendly token with write scope: check on the first real ❌ |
| D198 | A Calendly booking's phone is taken from any phone question | Hair's configured "Best number" still wins |
| D190 | Contacts matched by phone first (two people never share a number) | Off unless the offer's `contacts.match` setting is `phone` (D3) |
| D193 | Waits can pull a reminder earlier the same day instead of next morning | Used only where a workflow says `window: "before"` (C3) |
| D189 | Calendar alerts carry the topic `availability` | The old Health check still posts them, so nothing goes silent |
| Tools | Team (D197: add or remove a setter or closer), rename a workflow (D187), re-run upcoming bookings through one workflow at unlock (D195) | Admin API |

## B. Template changes (per workflow, dry run first)

1. **Call booked**: when texts can't reach the person (DND, or no phone on file), one ⚠️ and a line in the booking thread
   saying why, so the setter calls or emails instead. The card itself is unchanged byte for byte. PMU's Call booked is diverged
   (v7, its own edits), so the dry run has to show only the new steps change.
2. **Calendar availability**: says its own alerts, one step per thing (mark, post, thread, repeat, resolve) under "Calendar
   availability". PMU has v1, off.
3. **Health check**: skips the calendar alerts (B2 says them). **Order matters:** turn B2 on first, then B3. B3 alone would leave
   calendar alerts posted nowhere.

## C. Nelly-only today (her playbook); each is a choice for the other offer's Call booked or Pre-call sequence

1. **Unreadable reply → ask in the booking channel**: ✅ keep, ❌ cancel, 🔁 reschedule ("move it by hand; no text goes out"),
   quoting the last text sent (or "nothing yet: our booking text didn't go out").
2. **No meeting link**: one alert in the booking channel and one in the alerts channel at booking; the hour-before text says the
   link is coming instead of sending a blank one. Needs the two channel settings (D2) and the words.
3. **Evening calls**: the 24-hour and 1-hour reminders go earlier the same day when they'd land outside the send window.
4. **Short notice**: no ⏳ unconfirmed alert when the call is under 1.5 hours away; no hour-before text within an hour of the
   last text.
5. **Hour text says how long** ("we're on in 2 hours") rather than "in an hour".
6. **DQ reason and notes** from the EOD and the setter call land on the call record. Needs CRM fields (Dating's are `dq_reason`
   and `notes` on the Discovery object).

## D. Settings per offer

1. `contacts.match = phone` (D190).
2. `slack.channel.no_link` and `slack.channel.no_link_alerts` (C2).
3. `smsEnabled` in the install file matches the offer, so a re-install never turns texting back off.
4. Send lock: unchanged. Every workflow starts locked; only Tyler unlocks, by name.
5. No Calendly phone-question setting is needed any more (D198).
