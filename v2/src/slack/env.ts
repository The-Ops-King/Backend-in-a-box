/**
 * The platform Slack app's own configuration, from the host's environment: one app for every offer, so one of each.
 * - SLACK_CLIENT_ID, SLACK_CLIENT_SECRET: the app's OAuth credentials (Basic Information).
 * - SLACK_SIGNING_SECRET: the app's signing secret; every request to /slack/* is checked with it.
 * - SLACK_STATE_SECRET: the platform's own key (32+ random bytes) that signs the install state, button values and modal
 *   metadata. Never sent to Slack.
 * - BASE_URL: where the platform is reached (https://<domain>), for the redirect URL and links.
 */
export type SlackEnv = { clientId: string; clientSecret: string; signingSecret: string; stateSecret: string; baseUrl: string };

export function slackEnv(env: Record<string, string | undefined> = process.env): SlackEnv {
  const need = (k: string) => {
    const v = env[k];
    if (!v) throw new Error(`${k} is not set`);
    return v;
  };
  return {
    clientId: need("SLACK_CLIENT_ID"), clientSecret: need("SLACK_CLIENT_SECRET"), signingSecret: need("SLACK_SIGNING_SECRET"),
    stateSecret: need("SLACK_STATE_SECRET"), baseUrl: need("BASE_URL").replace(/\/$/, ""),
  };
}

/** The bot scopes the app asks for, exactly as the manifest has them. Each one has a named feature behind it (the spec). */
export const BOT_SCOPES = [
  "chat:write", "chat:write.customize", "channels:read", "groups:read", "channels:history", "groups:history", "im:history", "im:write",
  "app_mentions:read", "reactions:read", "reactions:write", "users:read", "users:read.email", "commands",
] as const;

/** The events the app subscribes to, exactly as the manifest has them. */
export const BOT_EVENTS = [
  "app_mention", "message.im", "message.channels", "message.groups", "reaction_added", "member_joined_channel", "channel_rename",
  "channel_archive", "app_uninstalled", "tokens_revoked",
] as const;
