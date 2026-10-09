import { NextResponse } from "next/server";
import { asOperator, one } from "@/db/client";
import { loadCompany } from "@/engine/context";
import { dispatchEvent, emitEvent } from "@/engine/dispatch";
import { parseSlackEvent, verifySlackSignature } from "@/engine/webhooks/slack";
export const dynamic = "force-dynamic";

/**
 * Slack → the engine (D45): a team member's reaction on a post the engine remembered under a tag becomes a
 * `slack.reaction` event, which a workflow can start from (a ✅ on "unclear reply, please confirm" confirms the call).
 * Signature verified with the company's signing secret; the bot's own reactions and unknown posts are ignored.
 */
export async function POST(req: Request, { params }: { params: Promise<{ companyId: string }> }) {
  const { companyId } = await params;
  const raw = await req.text();
  return asOperator(async (c) => {
    const { bindings } = await loadCompany(c, companyId);
    const secret = bindings["secret.slack_signing"];
    if (!secret) return NextResponse.json({ error: "Slack signing secret not bound for this company" }, { status: 401 });
    const v = verifySlackSignature(secret, { timestamp: req.headers.get("x-slack-request-timestamp"), signature: req.headers.get("x-slack-signature") }, raw);
    if (!v.ok) return NextResponse.json({ error: v.why }, { status: 401 });
    let body: unknown; try { body = JSON.parse(raw); } catch { return NextResponse.json({ error: "body is not JSON" }, { status: 400 }); }
    const ev = parseSlackEvent(body);
    if (ev.kind === "challenge") return NextResponse.json({ challenge: ev.challenge });
    if (ev.kind === "ignored") return NextResponse.json({ ok: true, ignored: ev.type });
    const first = await one(c, "insert into webhook_deliveries (company_id, provider, delivery_id) values ($1,'slack',$2) on conflict do nothing returning delivery_id", [companyId, ev.eventId]);
    if (!first) return NextResponse.json({ ok: true, duplicate_delivery: true });
    if (ev.removed) return NextResponse.json({ ok: true, ignored: "reaction_removed" });
    const conn = await one<{ bot_user_id: string | null }>(c, "select bot_user_id from slack_connections where company_id=$1", [companyId]);
    if (conn?.bot_user_id && conn.bot_user_id === ev.user) return NextResponse.json({ ok: true, ignored: "own reaction" });
    const post = await one<{ tag: string; run_id: string | null }>(c, "select tag, run_id from slack_posts where company_id=$1 and channel=$2 and ts=$3", [companyId, ev.channel, ev.ts]);
    if (!post) return NextResponse.json({ ok: true, ignored: "not a post the engine remembers" });
    const run = post.run_id ? await one<{ contact_id: string | null; appointment_id: string | null; opportunity_id: string | null }>(c, "select contact_id, appointment_id, opportunity_id from runs where id=$1", [post.run_id]) : null;
    const who = await one<{ name: string }>(c, "select name from users where company_id=$1 and slack_user_id=$2", [companyId, ev.user]);
    const [kind, ...rest] = post.tag.split(":"); const ref = rest.join(":");
    const event = await emitEvent(c, { company_id: companyId, contact_id: run?.contact_id ?? null, opportunity_id: run?.opportunity_id ?? null, appointment_id: run?.appointment_id ?? null, event_type: "slack.reaction", source: "slack",
      data: { reaction: ev.reaction, user: ev.user, user_name: who?.name ?? "a team member", tag: post.tag, kind, ref, channel: ev.channel, ts: ev.ts } });
    const started = await dispatchEvent(c, event, { contact: run?.contact_id ? { id: run.contact_id } : undefined, appointment: run?.appointment_id ? { id: run.appointment_id } : undefined });
    return NextResponse.json({ ok: true, event: event.id, runs_started: started.length });
  });
}
