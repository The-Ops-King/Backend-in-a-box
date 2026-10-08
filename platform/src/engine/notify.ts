import type { PoolClient } from "pg";
import { randomUUID } from "node:crypto";
import { one } from "@/db/client";
import type { CompanyRow } from "./context";
import { decrypt } from "./crypto";
import { slackNotifier } from "@/adapters/slack/notifier";

/**
 * A message to the team (not to a contact) outside any run: unlinked payment, poll failure, anything an operator must
 * see. Channel is the binding slack.channel.<name>, falling back to slack.channel.bookings. Recorded in `sends` like
 * every other message; posted only when the company is live and Slack is connected.
 */
export async function notifyTeam(c: PoolClient, company: CompanyRow, bindings: Record<string, string>, channel: string, text: string): Promise<{ posted: boolean; why?: string }> {
  const channelId = bindings[`slack.channel.${channel}`] ?? bindings["slack.channel.bookings"];
  const conn = await one<{ bot_token: Buffer }>(c, "select bot_token from slack_connections where company_id=$1", [company.id]);
  const status = !(conn && channelId) ? "suppressed" : company.mode === "shadow" ? "shadow" : "sent";
  await c.query(`insert into sends (company_id, contact_id, run_id, channel, idempotency_key, rendered_body, status, suppressed_reason, scheduled_for, sent_at)
    values ($1, null, null, 'slack', $2, $3, $4, $5, now(), case when $4 in ('sent','shadow') then now() end)`,
    [company.id, `notify:${channel}:${randomUUID()}`, text, status, status === "suppressed" ? (conn ? "unbound: slack channel" : "unbound: slack") : null]);
  if (status === "suppressed") return { posted: false, why: status };
  await slackNotifier.post(decrypt(conn!.bot_token), channelId!, status === "shadow" ? `🧪 *shadow* — ${text}` : text);   // the team sees shadow posts, labelled (D31)
  return { posted: true, why: status === "shadow" ? "shadow" : undefined };
}
