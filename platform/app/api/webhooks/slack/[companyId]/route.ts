import { NextResponse, after } from "next/server";
import { asOperator, one } from "@/db/client";
import { liveAdapters } from "@/adapters";
import { loadCompany } from "@/engine/context";
import { handleMessage } from "@/engine/bot";
import { parseSlackEvent, reactionArrived, verifySlackSignature } from "@/engine/webhooks/slack";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * Slack → the engine (D45): a team member's reaction on a post the engine remembered under a tag becomes a
 * `slack.reaction` event, which a workflow can start from and which wakes a run waiting on that very post (D53: a ✅ on
 * "unclear reply, please confirm" confirms that call). And the bot (D70): a mention, a DM, or a reply in a thread the bot
 * is in is acknowledged at once and answered after the response (Slack wants an answer within three seconds). Signature
 * verified with the company's signing secret; deliveries deduplicated; the bot's own messages and reactions are ignored.
 */
export async function POST(req: Request, { params }: { params: Promise<{ companyId: string }> }) {
  const { companyId } = await params;
  const raw = await req.text();
  const res = await asOperator(async (c) => {
    const { bindings } = await loadCompany(c, companyId);
    const secret = bindings["secret.slack_signing"];
    let body: unknown; try { body = JSON.parse(raw); } catch { return NextResponse.json({ error: "body is not JSON" }, { status: 400 }); }
    const ev = parseSlackEvent(body);
    // Slack's URL check is an echo and changes nothing, so it is answered even before the signing secret is stored: the
    // operator can finish the Slack side first. Every real event still needs the secret.
    if (ev.kind === "challenge" && !secret) return NextResponse.json({ challenge: ev.challenge });
    if (!secret) return NextResponse.json({ error: "Slack signing secret not bound for this company" }, { status: 401 });
    const v = verifySlackSignature(secret, { timestamp: req.headers.get("x-slack-request-timestamp"), signature: req.headers.get("x-slack-signature") }, raw);
    if (!v.ok) return NextResponse.json({ error: v.why }, { status: 401 });
    if (ev.kind === "challenge") return NextResponse.json({ challenge: ev.challenge });
    if (ev.kind === "ignored") return NextResponse.json({ ok: true, ignored: ev.type });
    const first = await one(c, "insert into webhook_deliveries (company_id, provider, delivery_id) values ($1,'slack',$2) on conflict do nothing returning delivery_id", [companyId, ev.eventId]);
    if (!first) return NextResponse.json({ ok: true, duplicate_delivery: true });
    if (ev.kind === "message") return { message: ev };
    const out = await reactionArrived(c, companyId, ev);
    return NextResponse.json("ignored" in out ? { ok: true, ignored: out.ignored } : { ok: true, ...out });
  });
  if (res instanceof Response) return res;
  after(() => handleMessage({ adapters: liveAdapters }, companyId, res.message).catch((e) => console.error("slack bot:", e)));
  return NextResponse.json({ ok: true, accepted: true });
}
