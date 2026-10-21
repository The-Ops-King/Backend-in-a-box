# Platform Slack App Spec (copy)

A copy of Tyler's doc "Platform Slack App Spec" (https://claude.ai/artifact/8aXAGSgSzRxet8xapYu1FW), taken 2026-10-21 at
revision 9. The doc is the source; this copy is so the design lives in the repo. Decisions made after it, which bind over it:

- Tyler owns the app.
- Slash commands keep their simple names, with no prefix (`/mtd`, `/cash`, ...). The open question below is settled that way.
- One distributed, unlisted app, installed through OAuth "Add to Slack".

---

2026-10-21 · Tyler

## Summary

One Slack app, owned by the platform and installed into each client workspace through an "Add to Slack" button, replaces the
per-offer apps built from pasted manifests. How Slack behaves is written once in platform code: buttons, modals, alert repeats,
slash commands and the bot. Where an offer posts and what it says is that offer's config.

| | Today | Rebuild |
| --- | --- | --- |
| Apps | One per offer, created by hand from a pasted manifest | One platform app, distributed (unlisted) |
| Install | Tyler pastes the bot token and signing secret | OAuth "Add to Slack"; tokens stored encrypted automatically |
| Request URLs | The company UUID baked into every URL | Fixed URLs; the offer is resolved from the workspace and channel |
| New slash command | Edit every manifest and reinstall every app | Update one manifest once and every workspace gets it |
| Two offers in one workspace | Slash commands go to whichever app was installed last | One app; the channel says which offer |
| Signing secret | One per offer, only shape-checked until the first event | One per platform, verified on every request |
| Behavior changes | Can drift per offer | The same everywhere by construction (the 2026-10-19 rule) |

The app needs no Slack Marketplace listing. Slack lets an unlisted app be installed into any workspace through its OAuth link
once public distribution is turned on in the app settings.

## Install and routing

An install connects a Slack workspace to the platform once. Each channel is then assigned to exactly one offer, which is how
every request finds its offer.

**Install flow**

1. In the offer's onboarding, Tyler clicks **Connect Slack**. The platform builds the OAuth link with a signed `state` naming
   the offer.
2. A workspace admin approves the scopes. Slack redirects to `/slack/oauth/callback`.
3. The platform verifies `state`, exchanges the code, and stores a `slack_workspaces` row: team id, bot user id, encrypted bot
   token, scopes granted, installer, installed at. If the workspace is already installed, it reuses that row and only links the
   offer.
4. Onboarding shows the channel picker: each slot (bookings, calls, deals, payments, eod, reports, alerts, ops) is a dropdown
   of the workspace's channels. Picking a private channel prompts "invite the bot", and the step stays red until the bot is a
   member.
5. People mapping: the platform reads Slack users by email and matches them to the offer's people. Tyler confirms each match,
   and no match is guessed.

**Routing**

| Request | How the offer is found |
| --- | --- |
| Event (reaction, message, mention) | The channel's mapping. A DM goes to the person's offers, and asks which one if there are more than one. |
| Button or modal | The offer id in the button's signed `value` or the modal's `private_metadata`, never read from free text |
| Slash command in a mapped channel | The channel's offer |
| Slash command in a DM or unmapped channel | `/mtd pmu` names it. Without a name, it uses the person's only offer, or replies with a picker. |

**Tables**

- `slack_workspaces(team_id, bot_user_id, bot_token_enc, scopes, installed_by, installed_at, revoked_at)`
- `slack_channels(team_id, channel_id, offer_id, slot, is_private, bot_member)`, with one offer per channel enforced by a
  unique key
- `person_identities(person_id, kind='slack', team_id, user_id)`

**Shared workspaces.** Tyler's own agency workspace can host several offers, each with its own channels. Client workspaces
normally host one offer. Both work with no special case.

## Manifest

One manifest is kept in the repo and applied to the one app. Every scope below has a named feature behind it. Nothing is
requested "just in case".

| Scope | Needed for |
| --- | --- |
| `chat:write` | Posting alerts, cards, wrap-ups, DMs |
| `chat:write.customize` | Per-offer persona (name, icon) on posts |
| `channels:read`, `groups:read` | Channel picker; detecting renames and archives |
| `channels:history`, `groups:history`, `im:history` | The bot reading the message it was asked in, and thread context |
| `app_mentions:read` | @mentions to the bot |
| `reactions:read`, `reactions:write` | Reaction taps as answers; the ✅ on resolve |
| `users:read`, `users:read.email` | Matching Slack users to people by email |
| `commands` | Slash commands |
| `im:write` | Opening a DM to a closer or setter who has never messaged the bot |

**Events:** `app_mention`, `message.im`, `message.channels`, `message.groups`, `reaction_added`, `member_joined_channel` (marks
the bot as a channel member), `channel_rename`, `channel_archive` (flags a broken slot), `app_uninstalled` and `tokens_revoked`
(pause that workspace's Slack posts and alert Tyler).

**Interactivity:** `/slack/interactions` for buttons, modals and modal close. `/slack/options` loads dynamic menus, such as
the contact search in the Link modal.

**Slash commands** (one request URL, `/slack/commands`):

| Command | Does | Who |
| --- | --- | --- |
| `/mtd`, `/weekly`, `/monthly` | Numbers for the period | Team |
| `/show-rate`, `/close-rate`, `/cash`, `/leads`, `/closes` | One metric, with an optional `by closer` or `by source` | Team |
| `/leaderboard` | Current leaderboard | Team |
| `/availability` | Open slots per calendar for the next N days | Team |
| `/agreement` | Opens the agreement form, or sends one immediately with a contact | Owner, manager, closer |
| `/support` | Opens a ticket to Tyler | Team |
| `/team` | Lists people and roles, and adds or removes a person | Operator |
| `/help` | What each command does, for this offer | Team |

```yaml
display_information:
  name: Backend in a Box
features:
  bot_user: { display_name: bib, always_online: true }
  slash_commands:   # each: url https://<platform>/slack/commands
    - { command: /mtd, description: Month-to-date numbers }
    - { command: /weekly, description: Last week's numbers }
    # ...one entry per command in the table above
oauth_config:
  redirect_urls: [ https://<platform>/slack/oauth/callback ]
  scopes:
    bot: [ chat:write, chat:write.customize, channels:read, groups:read,
           channels:history, groups:history, im:history, im:write,
           app_mentions:read, reactions:read, reactions:write,
           users:read, users:read.email, commands ]
settings:
  event_subscriptions:
    request_url: https://<platform>/slack/events
    bot_events: [ app_mention, message.im, message.channels, message.groups,
                  reaction_added, member_joined_channel, channel_rename,
                  channel_archive, app_uninstalled, tokens_revoked ]
  interactivity:
    is_enabled: true
    request_url: https://<platform>/slack/interactions
    message_menu_options_url: https://<platform>/slack/options
  org_deploy_enabled: false
  token_rotation_enabled: true
```

Token rotation is on. Bot tokens refresh every 12 hours through the stored refresh token, so a leaked token expires on its own.

## Platform-wide behavior

Every item in this section works the same way on every offer. Changing one means one code change and one pass across all
offers, each with a dry run showing only the Slack part changes.

**Posting**

- All posts go through the outbox and the delivery gate, like any other effect. A workflow in sandbox posts to the offer's test
  channel with a "🧪 sandbox" prefix.
- Each post is recorded in `slack_messages` (offer, channel, ts, thread_ts, workflow, run, step, tag). Later steps can thread
  under it, edit it or react to it by tag.
- Slack rate limits (HTTP 429) are honored with `Retry-After`. Other failures retry with backoff 3 times, then raise an alert. A
  post is never silently dropped.
- Persona per post: name and icon come from the offer's settings, not code.

**Buttons and the `ask` step**

| Button | Effect | Who can press |
| --- | --- | --- |
| Confirm / Cancel / Reschedule (booking and pre-call cards) | Answers the waiting `ask` step; the run continues on that branch | Closer, setter, manager, owner |
| Retry / Resolve / Pause (alerts) | Re-runs the failed step, closes the alert, or stops repeats while it stays open | Manager, owner, operator |
| Link (unlinked payment or recording) | Opens a modal with a contact search; the choice links it and records who did it | Manager, owner, operator |
| Send / Cancel (agreement) | Sends the agreement or cancels the request | Owner, manager, closer on that deal |

- Every press is acked within 3 seconds. The work runs after the ack, and the original message is then edited to show who
  pressed what and when. The buttons are removed so they can't be pressed twice.
- The button value carries a signed payload (offer, run, step, choice). A press on a stale or already-answered step gets an
  ephemeral "already handled by X".
- Permission is checked against the person's role on that offer. A refusal is ephemeral and is recorded.

**Alerts**

- There is one open alert per offer and cause key. Raised means a post in the alerts channel. Repeated means a thread reply.
  Resolved means a thread reply plus a ✅ on the original.
- **Repeat rule:** every N minutes (default 60), only inside the operator's working hours. Before each repeat, the platform
  checks the cause is still true. Pause stops repeats, and the ✅ still posts on resolve. N and the hours are platform settings
  in the database, not constants in code.
- An alert the platform can't attribute to an offer (worker down, a vendor outage) goes to Tyler's operator channel.

**Formatting.** Messages are built with Block Kit from a small set of platform layouts: card, alert, report table and form
summary. A workflow picks a layout and supplies content, so no workflow carries raw Slack markup. That retires the 44 places
today where `slack_post` has Slack markup inside templates.

## What stays per offer

An offer controls where it posts, what it says, and who can do what. It never controls how Slack behaves. All of this is
config, edited one offer at a time and visible on the offer's Slack settings page.

| Setting | Example | Where it's used |
| --- | --- | --- |
| Channel slots | bookings = #pmu-bookings, alerts = #pmu-ops | Every post step names a slot, never a channel id |
| Test channel | #pmu-test | Sandbox posts |
| Persona | name "PMU Ops", icon | Every post |
| Content | The words of each card, alert and DM | By content key, with an approval hash like every message |
| People and roles | Carly = closer, Mitch = setter | Button permissions, DMs, mentions |
| Report layouts | Which metrics the daily wrap-up shows | `report` steps and slash commands |
| Commands enabled | `/agreement` on only where agreements are used | `/help` lists only what is enabled |
| One-time tags | The "this person doesn't have a link" tag goes to #dating-calls-booked | Config, per the CLAUDE.md rule |

A slot left empty blocks any workflow that posts to it from going live. Today some slots silently fall back to other channels
(D58). In the rebuild, a fallback has to be written as a setting so it is visible.

## The bot

The bot answers questions about one offer's numbers and journeys from the metric layer, the same definitions the wrap-ups use.
A Slack answer and the Sunday report can therefore never disagree.

- **Scope.** A question is about the channel's offer (or the offer picked in a DM). The bot's tools take that `offer_id` from
  the routing and never from the model, so it can't read another offer.
- **Tools:**
  - `metric(name, period, group_by)` over the metric definitions
  - `contact_journey(contact)` for one contact's events and runs
  - `workflow_explain(workflow)`, which reads the same spec as the UI
  - `open_alerts()`
  - `query_views(sql)` as a last resort: read-only SQL over per-offer views, 5-second timeout, every call recorded
- **Read-only.** The bot never changes config, never unlocks sends, and never sends to a contact. Changes happen in Tyler's
  chat or the dashboard editor, under the one-offer rules.
- **Answers show their working:** the metric used, the period and the filter, so a number can be checked.
- **Model and prompt** are platform settings. No offer's words, names or examples appear in the shared prompt. Offer-specific
  vocabulary comes from that offer's config at answer time.
- **Cost guard:** a per-offer daily token budget. When it's hit, the bot says so and alerts Tyler.

## Security, reliability and data stored

- **Request verification.** Every request to `/slack/*` is checked with the v0 signature and a 5-minute timestamp window
  before it's read. Failures are logged without the body.
- **Dedupe.** Each event's `event_id` and each interaction's trigger id go into `inbox` with a unique key. Slack retries
  (`X-Slack-Retry-Num`) are acked and dropped.
- **The 3-second rule.** Every endpoint acks immediately. Work runs as a job, and a slow vendor never causes a Slack timeout or
  a retry storm.
- **Tokens.** Bot tokens are encrypted at rest and rotate every 12 hours. An `app_uninstalled` or `tokens_revoked` event marks
  the workspace revoked, holds its Slack posts in the outbox, and alerts Tyler. Nothing is lost while it's reconnected.
- **Stored:** workspace, channel, people mappings, post references (`ts`, tag, run) and button answers with who pressed them.
  Message text the bot reads is used for the answer and then discarded, and nothing is stored beyond the thread reference.
- **Health check.** A daily job confirms each workspace token works, each mapped channel exists and the bot is in it. A failure
  is an alert on that offer, before a post fails.

## Migration and open questions

Moving an offer from its own app to the platform app is a Slack-only change. It runs the same way on every offer, one at a
time, with a dry run each.

1. Install the platform app into the offer's workspace. It posts nothing until its channels are mapped.
2. Map the offer's existing channels and people. The dry run lists every slot and person, old app against new app.
3. Switch the offer's Slack connection to the platform app. Open alerts and waiting buttons keep working, because old messages
   are recorded with their posting app and are answered through it until they close.
4. Once nothing open points at the old app, Tyler uninstalls it.

**Open questions**

- [ ] Should slash commands keep their short names (`/mtd`) or move under one prefix (`/bib mtd`)? Short names are what the
  team knows. A prefix can't collide with another app's commands in a client's workspace. I recommend the prefix, keeping the
  short names as aliases for one release. *(Settled since: simple names, no prefix.)*
- [ ] Who owns the Slack app account: Tyler's personal Slack, or a dedicated platform workspace? I recommend a dedicated
  workspace, so the app doesn't depend on any one client's or person's account. *(Settled since: Tyler owns the app.)*
- [ ] Should clients' managers get the bot's free-form SQL fallback, or only the operator?
