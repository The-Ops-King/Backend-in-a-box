import { NextResponse, after } from "next/server";
import { asOperator } from "@/db/client";
import { liveAdapters } from "@/adapters";
import { loadCompany } from "@/engine/context";
import { respondToSlack, verifySlackSignature } from "@/engine/webhooks/slack";
import { alertPressed, parseSlackInteraction } from "@/engine/webhooks/slack-actions";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * Slack interactivity (D93): the Retry and Resolve buttons on an alert's post. Form-encoded (`payload=` JSON), signed like the
 * events and commands doors. Slack wants an answer within three seconds and a retry can call the CRM, so the press is
 * acknowledged at once and handled after the response; what it did is said by editing the post, a thread line or a private note.
 * The Slack app's Interactivity & Shortcuts → Request URL is this path.
 */
export async function POST(req: Request, { params }: { params: Promise<{ companyId: string }> }) {
  const { companyId } = await params;
  const raw = await req.text();
  const res = await asOperator(async (c) => {
    const { bindings } = await loadCompany(c, companyId);
    const secret = bindings["secret.slack_signing"];
    if (!secret) return NextResponse.json({ error: "Slack signing secret not bound for this company" }, { status: 401 });
    const v = verifySlackSignature(secret, { timestamp: req.headers.get("x-slack-request-timestamp"), signature: req.headers.get("x-slack-signature") }, raw);
    if (!v.ok) return NextResponse.json({ error: v.why }, { status: 401 });
    const p = parseSlackInteraction(raw);
    if (p.kind === "ignored") return new Response(null, { status: 200 });
    return { press: p };
  });
  if (res instanceof Response) return res;
  after(() => alertPressed({ adapters: liveAdapters, respond: respondToSlack }, companyId, res.press).catch((e) => console.error("slack press:", e)));
  return new Response(null, { status: 200 });
}
