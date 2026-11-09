import { NextResponse } from "next/server";
import { asOperator, one } from "@/db/client";
import { liveAdapters } from "@/adapters";
import { operatorAuthorized } from "@/engine/admin-auth";
import { loadCompany } from "@/engine/context";
import { slackBot } from "@/engine/slack-conn";
import type { SlackPersona } from "@/adapters/types";
export const dynamic = "force-dynamic";

/**
 * D321: POST { company, channel: <a channel setting such as slack.channel.deals, or a channel id>, text, as?: { name, icon }, why,
 * dryRun = true }: one message posted to the offer's Slack as its bot, by the operator (a post a workflow got wrong, put right where
 * it belongs: Carmen Thomas's close, posted with the wrong numbers in the test channel). The dry run says where and what. Audited.
 * Authorization: Bearer $CRON_SECRET.
 */
export async function POST(req: Request) {
  if (!operatorAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const b = (await req.json().catch(() => null)) as { company?: string; channel?: string; text?: string; as?: SlackPersona; why?: string; dryRun?: boolean } | null;
  if (!b?.company || !b.channel || !b.text?.trim() || !b.why?.trim()) return NextResponse.json({ error: "company, channel, text and why are required" }, { status: 400 });
  return asOperator(async (c) => {
    const co = await one<{ id: string }>(c, "select id from companies where slug=$1", [b.company]); if (!co) return NextResponse.json({ error: "no such company" }, { status: 404 });
    const { bindings } = await loadCompany(c, co.id);
    const channel = b.channel!.startsWith("slack.channel.") ? bindings[b.channel!] : b.channel!;
    if (!channel) return NextResponse.json({ error: `${b.channel} is not set on this offer` }, { status: 400 });
    const bot = await slackBot(c, co.id); if (!bot) return NextResponse.json({ error: "this offer has no Slack connected" }, { status: 409 });
    if (b.dryRun !== false) return NextResponse.json({ ok: true, dryRun: true, channel, text: b.text, as: b.as ?? null });
    const r = await liveAdapters.notifier.post(bot.token, channel, b.text!, b.as);
    await c.query("insert into audit_log (company_id, action, target_type, target_id, after) values ($1,'slack.posted','channel',$2,$3)", [co.id, channel, { ts: r.ts, text: b.text, why: b.why!.trim() }]);
    return NextResponse.json({ ok: true, dryRun: false, channel, ts: r.ts });
  });
}
