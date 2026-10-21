# The platform Slack app: creating it and installing it

One Slack app, owned by Tyler, distributed and unlisted. The design is `slack-app-spec.md`; the code is `src/slack/`.
These steps are for when the service runs on Railway at `https://<domain>`.

## 1. Create the app from the manifest
1. Open `slack-manifest.yml` and replace every `${BASE_URL}` with `https://<domain>` (no trailing slash).
2. At api.slack.com/apps, click **Create New App**, then **From an app manifest**, pick Tyler's workspace, and paste it.
3. Under **Basic Information**, copy the Client ID, the Client Secret and the Signing Secret.
4. Under **Manage Distribution**, turn on public distribution (the app stays unlisted: no Marketplace listing).
5. Slack checks the events URL when the manifest is saved. The service must be running with the variables below
   by then; if it was not, click **Retry** under **Event Subscriptions** once it is.

## 2. Set the service's variables (Railway)
- `BASE_URL`: `https://<domain>`
- `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, `SLACK_SIGNING_SECRET`: from step 1.3.
- `SLACK_STATE_SECRET`: 32 random bytes, for example `openssl rand -base64 32`. It signs the install link, button values
  and modal metadata; it never goes to Slack.
- `TOKEN_KEY` is already set (it seals the bot tokens, as it seals GHL's).

## 3. Install it into a workspace, for one offer
1. Make the offer's Connect Slack link: `installLink(env, offerId)` in `src/slack/oauth.ts` (the onboarding page will call
   it). It is good for one hour, once.
2. A workspace admin opens it and approves the scopes. Slack sends them back to `/slack/oauth/callback`, which keeps the
   workspace (its token sealed) and links the offer. A second offer in the same workspace gets its own link; the
   workspace row is reused.
3. Give each slot a channel (`mapChannel` in `src/slack/data.ts`): bookings, calls, deals, payments, eod, reports, alerts,
   ops, test. This also sets the offer's `slack.channel.<slot>` setting. A channel belongs to one offer. Invite the bot
   (`/invite @bib`) to private channels; `member_joined_channel` marks it there.
4. Confirm the people (`confirmIdentity`, or `/team add @person role` as the operator). No match is guessed.

Nothing posts until a workflow posts to a slot, and every workflow starts in sandbox: its posts go to the `test` slot,
marked "🧪 sandbox".

## 4. Platform settings (table `platform_settings`)
- `alerts.repeat_minutes` (60), `alerts.repeat_hours` ("07:00-17:00"), `alerts.repeat_zone` ("America/Phoenix"): set by
  migration 0004 from v1's values.
- `slack.operators`: `[{ "team_id": "T…", "user_id": "U…" }]`, Tyler's Slack users (the operator's presses and `/team`).
- `slack.operator_channel`: `{ "team_id": "T…", "channel": "C…" }`, where alerts of no offer and `/support` tickets go.
  The app must be installed in that workspace.
- `bot.model` (unset: the bot says it is not set up), `bot.prompt` (unset: the default in `src/slack/bot.ts`),
  `bot.daily_token_budget` (200000, an offer's own setting wins), `bot.query_views_roles` (unset: the operator only).

Per offer (settings): `slack.commands` (which commands are on and which metrics they read; see `CommandConfig` in
`src/slack/commands.ts`), `bot.vocabulary`, `bot.daily_token_budget`.

## 5. The worker
The doors only record and queue. The worker runs the Slack jobs beside the engine's: add `slackTaskList(app)`
(`src/slack/http.ts`) to its task list, and a cron item `* * * * * slack_alerts` for the alert sweep. The engine's Slack
port is `app.port` (`createSlackPortFor`). The worker's entry point comes with the first connectors.
