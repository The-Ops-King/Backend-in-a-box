import type { PoolClient } from "pg";
import { one } from "@/db/client";
import { decrypt } from "./crypto";

/** D193 (audit §3): the company's Slack bot, read in one place (the same query and decrypt were written out eleven times). */
export async function slackBot(c: PoolClient, companyId: string): Promise<{ token: string; teamId: string } | null> {
  const r = await one<{ team_id: string; bot_token: Buffer }>(c, "select team_id, bot_token from slack_connections where company_id=$1", [companyId]);
  return r ? { token: decrypt(r.bot_token), teamId: r.team_id } : null;
}
