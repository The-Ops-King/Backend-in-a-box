import { NextResponse, after } from "next/server";
import { DateTime } from "luxon";
import { asOperator, one } from "@/db/client";
import { liveAdapters } from "@/adapters";
import { loadCompany } from "@/engine/context";
import { helpText, planCommand, runCommand, type SlashCommand } from "@/engine/bot";
import { respondToSlack, verifySlackSignature } from "@/engine/webhooks/slack";
import { openTicket, TICKET_COMMAND, TICKET_USAGE } from "@/engine/tickets";
import { TEAM_COMMAND, teamCommand } from "@/engine/team-command";
import { AGREEMENT_COMMAND, agreementForm, answerAgreementCommand, requestAgreement } from "@/engine/webhooks/agreement-request";
import { slackBot } from "@/engine/slack-conn";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * Slack slash commands (D70): /mtd, /weekly, /monthly, /show-rate, /close-rate, /cash, /availability, /leads, the help
 * command, /support (D152), /agreement (D202, opens a form) and /team (D203, the operator only), all to this one URL. Form-encoded, signed like the events door. Help and a period that cannot be read are
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
    // D202: /agreement opens the form (Slack allows three seconds for it, so it opens here, not after the answer)
    if (cmd.command.replace(/^\//, "").toLowerCase() === AGREEMENT_COMMAND) {
      const a = await answerAgreementCommand(c, companyId, cmd.userId, bindings, cmd.text);
      if (a.form) {
        const bot = await slackBot(c, companyId), trigger = f.get("trigger_id");
        if (!bot || !trigger || !liveAdapters.notifier.openView) return NextResponse.json({ response_type: "ephemeral", text: "Slack didn't give me a way to open the form; try again." });
        await liveAdapters.notifier.openView(bot.token, trigger, agreementForm(a.form, { channel: cmd.channelId }));
        return new Response(null, { status: 200 });
      }
      if (a.send) return { agreement: { ...a.send, user: cmd.userId, url: f.get("response_url") ?? "", say: a.say } };
      return NextResponse.json(a.say);
    }
    // D152: /support opens a ticket (the reply says it is in; the post and the operator's note follow)
    if (cmd.command.replace(/^\//, "").toLowerCase() === TICKET_COMMAND) return cmd.text.trim() ? { ticket: { cmd } } : NextResponse.json({ response_type: "ephemeral", text: TICKET_USAGE });
    // D203: /team (the operator only) answers privately, after the response: it reads GHL, Slack and the booking tool
    if (cmd.command.replace(/^\//, "").toLowerCase() === TEAM_COMMAND) return { team: { cmd } };
    const p = planCommand(cmd, row.timezone, DateTime.now());
    if ("help" in p) return NextResponse.json({ response_type: "ephemeral", text: helpText(conn.bot_user_id ? `<@${conn.bot_user_id}>` : "@bot") });
    if ("error" in p) return NextResponse.json({ response_type: "ephemeral", text: p.error });
    return { cmd, plan: p.plan };
  });
  if (res instanceof Response) return res;
  if ("agreement" in res && res.agreement) {   // D202: an exact /agreement: answered "Sending…", then the outcome in its place
    const g = res.agreement;
    after(() => requestAgreement(liveAdapters, companyId, g.user, g.contact, g.choice, g.by, (text) => respondToSlack(g.url, { response_type: "ephemeral", replace_original: true, text })).then(() => undefined).catch((e) => console.error("slack agreement:", e)));
    return NextResponse.json(g.say);
  }
  if ("ticket" in res && res.ticket) {
    const { cmd } = res.ticket;
    after(() => openTicket(liveAdapters, companyId, { text: cmd.text, slackUser: cmd.userId, channel: cmd.channelId }).catch((e) => console.error("ticket:", e)));
    return NextResponse.json({ response_type: "ephemeral", text: "Got it. It's being logged; it'll show here with its number in a moment." });
  }
  if ("team" in res && res.team) {
    const { cmd } = res.team;
    after(async () => {
      const text = await asOperator(async (c) => {
        const { adapterCompany, bindings } = await loadCompany(c, companyId);
        const bot = await slackBot(c, companyId);
        return teamCommand(c, { companyId, ac: adapterCompany, adapters: liveAdapters, slackToken: bot?.token ?? null, bindings, userId: cmd.userId, text: cmd.text });
      }).catch((e) => `Something went wrong: ${String((e as Error).message).slice(0, 200)}`);
      if (cmd.responseUrl) await respondToSlack(cmd.responseUrl, { response_type: "ephemeral", text });
    });
    return NextResponse.json({ response_type: "ephemeral", text: "Checking…" });
  }
  if (!("plan" in res) || !res.plan) return new Response(null, { status: 200 });
  after(() => runCommand({ adapters: liveAdapters, respond: respondToSlack }, companyId, res.cmd, res.plan).catch((e) => console.error("slack command:", e)));
  return new Response(null, { status: 200 });
}
