import { NextResponse } from "next/server";
import { asOperator, one } from "@/db/client";
import { decrypt } from "@/engine/crypto";
import { operatorAuthorized } from "@/engine/admin-auth";
export const dynamic = "force-dynamic";

/** GET ?company=<slug>: what Slack says about this company's bot — identity, granted scopes, and every channel it can see (with Slack's own error when it cannot). Bearer $CRON_SECRET. */
export async function GET(req: Request) {
  if (!operatorAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const slug = new URL(req.url).searchParams.get("company") ?? "";
  const tok = await asOperator(async (c) => { const co = await one<{ id: string }>(c, "select id from companies where slug=$1", [slug]); return co ? one<{ bot_token: Buffer; team_id: string }>(c, "select bot_token, team_id from slack_connections where company_id=$1", [co.id]) : null; });
  if (!tok) return NextResponse.json({ error: "no Slack connection for that company" }, { status: 404 });
  const token = decrypt(tok.bot_token);
  const auth = await fetch("https://slack.com/api/auth.test", { method: "POST", headers: { Authorization: `Bearer ${token}` } });
  const scopes = auth.headers.get("x-oauth-scopes");
  const who = (await auth.json()) as Record<string, unknown>;
  const out: Record<string, unknown> = { team_id: tok.team_id, bot: { user: who.user, user_id: who.user_id, bot_id: who.bot_id, team: who.team }, scopes: scopes?.split(",") ?? null, channels: {} as Record<string, unknown> };
  for (const types of ["public_channel", "private_channel"]) {
    const r = await fetch(`https://slack.com/api/conversations.list?types=${types}&exclude_archived=true&limit=200`, { headers: { Authorization: `Bearer ${token}` } });
    const d = (await r.json()) as { ok: boolean; error?: string; channels?: { id: string; name: string; is_member?: boolean }[] };
    (out.channels as Record<string, unknown>)[types] = d.ok ? d.channels!.map((c) => ({ id: c.id, name: c.name, member: c.is_member })) : { error: d.error };
  }
  return NextResponse.json(out);
}
