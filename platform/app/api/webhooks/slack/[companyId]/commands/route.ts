import { NextResponse, after } from "next/server";
import { DateTime } from "luxon";
import { asOperator, one } from "@/db/client";
import { liveAdapters } from "@/adapters";
import { loadCompany } from "@/engine/context";
import { helpText, planCommand, runCommand, type SlashCommand } from "@/engine/bot";
import { verifySlackSignature } from "@/engine/webhooks/slack";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * Slack slash commands (D70): /mtd, /weekly, /monthly, /show-rate, /close-rate, /cash, /availability, /leads and the help
 * command, all to this one URL. Form-encoded, signed like the events door. Help and a period that cannot be read are
 * answered at once, privately; everything else is acknowledged within Slack's three seconds and posted after the response.
 */
export async function POST(req: Request, { params }: { params: Promise<{ companyId: string }> }) {
  const { companyId } = await params;
  const raw = await req.text();
  const res = await asOperator(async (c) => {
    const { bindings, row } = await loadCompany(c, companyId);
    const secret = bindings["secret.slack_signing"];
    if (!secret) return NextResponse.json({ error: "Slack signing secret not bound for this company" }, { status: 401 });
    const v = verifySlackSignature(secret, { timestamp: req.headers.get("x-slack-request-timestamp"), signature: req.headers.get("x-slack-signature") }, raw);
    if (!v.ok) return NextResponse.json({ error: v.why }, { status: 401 });
    const f = new URLSearchParams(raw);
    const cmd: SlashCommand = { command: f.get("command") ?? "", text: f.get("text") ?? "", userId: f.get("user_id") ?? "", channelId: f.get("channel_id") ?? "", channelName: f.get("channel_name") ?? undefined, teamId: f.get("team_id") ?? undefined, responseUrl: f.get("response_url") ?? undefined };
    const conn = await one<{ team_id: string; bot_user_id: string | null }>(c, "select team_id, bot_user_id from slack_connections where company_id=$1", [companyId]);
    if (!conn || (cmd.teamId && cmd.teamId !== conn.team_id)) return NextResponse.json({ response_type: "ephemeral", text: "This workspace is not connected to this company." });
    const p = planCommand(cmd, row.timezone, DateTime.now());
    if ("help" in p) return NextResponse.json({ response_type: "ephemeral", text: helpText(conn.bot_user_id ? `<@${conn.bot_user_id}>` : "@bot") });
    if ("error" in p) return NextResponse.json({ response_type: "ephemeral", text: p.error });
    return { cmd, plan: p.plan };
  });
  if (res instanceof Response) return res;
  after(() => runCommand({ adapters: liveAdapters, respond: postToResponseUrl }, companyId, res.cmd, res.plan).catch((e) => console.error("slack command:", e)));
  return new Response(null, { status: 200 });
}

async function postToResponseUrl(url: string, body: Record<string, unknown>): Promise<void> {
  // response_url is Slack's own; anything else is not followed
  if (!/^https:\/\/hooks\.slack\.com\//.test(url)) return;
  await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}
