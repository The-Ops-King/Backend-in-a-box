import { NextResponse, after } from "next/server";
import { asOperator } from "@/db/client";
import { liveAdapters } from "@/adapters";
import { loadCompany } from "@/engine/context";
import { respondToSlack, verifySlackSignature } from "@/engine/webhooks/slack";
import { alertPressed, parseSlackInteraction, ONLY_MANAGERS, type SlackPress } from "@/engine/webhooks/slack-actions";
import { checkSubmit, LINK_ACTIONS, LINK_FORM, linkForm, linkSubmitted, parseMeta } from "@/engine/webhooks/slack-link";
import { one } from "@/db/client";
import { slackBot } from "@/engine/slack-conn";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * Slack interactivity (D93): the Retry and Resolve buttons on an alert's post. D193: "Link to a contact" on an unlinked payment or
 * recording opens its form here, inside the three seconds (views.open needs the press's trigger_id); the form's submit is checked
 * here too (an error goes back into the form) and the link itself is made after the answer. Form-encoded (`payload=` JSON), signed like the
 * events and commands doors. Slack wants an answer within three seconds and a retry can call the CRM, so the press is
 * acknowledged at once and handled after the response; what it did is said by editing the post, a thread line or a private note.
 * The Slack app's Interactivity & Shortcuts → Request URL is this path.
 */
export async function POST(req: Request, { params }: { params: Promise<{ companyId: string }> }) {
  const { companyId } = await params;
  const raw = await req.text();
  type Next = Response | { kind: "link"; user: string; meta: NonNullable<ReturnType<typeof parseMeta>>; contact: { id: string; name: string } } | { kind: "say"; url?: string; text: string } | { kind: "press"; press: SlackPress };
  const res = await asOperator(async (c): Promise<Next> => {
    const { bindings } = await loadCompany(c, companyId);
    const secret = bindings["secret.slack_signing"];
    if (!secret) return NextResponse.json({ error: "Slack signing secret not bound for this company" }, { status: 401 });
    const v = verifySlackSignature(secret, { timestamp: req.headers.get("x-slack-request-timestamp"), signature: req.headers.get("x-slack-signature") }, raw);
    if (!v.ok) return NextResponse.json({ error: v.why }, { status: 401 });
    const p = parseSlackInteraction(raw);
    if (p.kind === "ignored") return new Response(null, { status: 200 });
    const bot = await slackBot(c, companyId);
    if (!bot || (p.teamId && p.teamId !== bot.teamId)) return new Response(null, { status: 200 });
    if (p.kind === "submit") {
      const meta = p.callbackId === LINK_FORM ? parseMeta(p.meta) : null;
      if (!meta) return new Response(null, { status: 200 });
      const r = await checkSubmit(c, companyId, p.user, meta, p.values.who ?? "");
      if ("error" in r) return NextResponse.json({ response_action: "errors", errors: { who: r.error } });
      return { kind: "link", user: p.user, meta, contact: r.contact };
    }
    const kind = LINK_ACTIONS[p.action as keyof typeof LINK_ACTIONS];
    if (kind) {
      const allowed = await one(c, `select 1 where exists (select 1 from users where company_id=$1 and slack_user_id=$2 and active and role in ('owner','manager'))
        or exists (select 1 from bindings where company_id=$1 and key='bot.escalate_to' and convert_from(value,'utf8')=$2)`, [companyId, p.user]);
      if (!allowed) return { kind: "say", url: p.responseUrl, text: ONLY_MANAGERS };
      if (p.triggerId && liveAdapters.notifier.openView) await liveAdapters.notifier.openView(bot.token, p.triggerId, linkForm({ kind, id: p.value, channel: p.channel, ts: p.ts })).catch((e) => console.error("slack link form:", e));
      return new Response(null, { status: 200 });
    }
    return { kind: "press", press: p };
  });
  if (res instanceof Response) return res;
  if (res.kind === "link") { after(() => linkSubmitted(liveAdapters, companyId, res.user, res.meta, res.contact).then(() => undefined).catch((e) => console.error("slack link:", e))); return new Response(null, { status: 200 }); }
  if (res.kind === "say") { const url = res.url; if (url) after(() => respondToSlack(url, { response_type: "ephemeral", replace_original: false, text: res.text }).catch(() => {})); return new Response(null, { status: 200 }); }
  after(() => alertPressed({ adapters: liveAdapters, respond: respondToSlack }, companyId, res.press).catch((e) => console.error("slack press:", e)));
  return new Response(null, { status: 200 });
}
