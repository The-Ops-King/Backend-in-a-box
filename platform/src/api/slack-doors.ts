import { NextResponse, after } from "next/server";
import { DateTime } from "luxon";
import type { PoolClient } from "pg";
import { asOperator, many, one } from "@/db/client";
import { liveAdapters } from "@/adapters";
import { loadCompany } from "@/engine/context";
import { decrypt } from "@/engine/crypto";
import { handleMessage, helpText, planCommand, runCommand, type SlashCommand } from "@/engine/bot";
import { parseSlackEvent, reactionArrived, respondToSlack, verifySlackSignature } from "@/engine/webhooks/slack";
import { alertPressed, parseSlackInteraction, ONLY_MANAGERS, type SlackPress } from "@/engine/webhooks/slack-actions";
import { checkSubmit, LINK_ACTIONS, LINK_FORM, linkForm, linkSubmitted, parseMeta } from "@/engine/webhooks/slack-link";
import { openTicket, TICKET_COMMAND, TICKET_USAGE } from "@/engine/tickets";
import { TEAM_COMMAND, teamCommand } from "@/engine/team-command";
import { REASSIGN_COMMAND, REASSIGN_PICK, REASSIGN_CALLS, reassignStart, reassignPicked, reassignChosen } from "@/engine/webhooks/reassign-command";
import { AGREEMENT_COMMAND, AGREEMENT_FORM, agreementForm, answerAgreementCommand, checkAgreementPress, checkAgreementSubmit, requestAgreement, type AgreementChoice, type Who } from "@/engine/webhooks/agreement-request";
import { slackBot } from "@/engine/slack-conn";
import { ambiguousWords, routeSlack, slackGone, type SharedApp, type SlackRoute, type SlackWho } from "@/engine/slack-app";
import { respondAndRun, runCompanyNow } from "@/api/run-soon";

/**
 * The three Slack doors (events, slash commands, interactivity), each reached two ways (D251): an offer's own app at
 * `/api/webhooks/slack/<companyId>/…` (D174), signed with that offer's signing secret, or the shared app at `/api/slack/…`,
 * signed with the server's, where the offer is the one the workspace (then channel, then person) belongs to. Past that, a request
 * is handled the same whichever app it came through. An offer that moved to the shared app no longer answers its own app.
 */
export type DoorKey = { companyId: string } | { shared: SharedApp };
const MOVED = "This offer's Slack runs on the shared app now; this app can be removed from the workspace.";
type Opened = { ok: true; companyId?: string } | { ok: false; moved: true } | { ok: false; status: 401; why: string };

const signingSecret = async (c: PoolClient, companyId: string) => (await loadCompany(c, companyId)).bindings["secret.slack_signing"];
async function verifyDoor(c: PoolClient, key: DoorKey, req: Request, raw: string): Promise<Opened> {
  const h = { timestamp: req.headers.get("x-slack-request-timestamp"), signature: req.headers.get("x-slack-signature") };
  if ("shared" in key) { const v = verifySlackSignature(key.shared.signingSecret, h, raw); return v.ok ? { ok: true } : { ok: false, status: 401, why: v.why }; }
  const conn = await one<{ app: string }>(c, "select app from slack_connections where company_id=$1", [key.companyId]);
  if (conn?.app === "shared") return { ok: false, moved: true };
  const secret = await signingSecret(c, key.companyId);
  if (!secret) return { ok: false, status: 401, why: "Slack signing secret not bound for this company" };
  const v = verifySlackSignature(secret, h, raw);
  return v.ok ? { ok: true, companyId: key.companyId } : { ok: false, status: 401, why: v.why };
}
// the own app's door already knows its offer; the shared app's asks which offer the workspace, channel or person belongs to
const resolve = async (c: PoolClient, v: { companyId?: string }, who: SlackWho): Promise<SlackRoute> => (v.companyId ? { companyId: v.companyId } : routeSlack(c, who));
const notRouted = (r: SlackRoute) => ambiguousWords("ambiguous" in r ? r.ambiguous : []);
// the shared app has one bot per workspace, whichever offer is asked, so any of its connections there can say "which offer?"
const workspaceBot = async (c: PoolClient, teamId: string) => {
  const r = (await many<{ bot_token: Buffer }>(c, "select bot_token from slack_connections where team_id=$1 and app='shared' limit 1", [teamId]))[0];
  return r ? decrypt(r.bot_token) : null;
};

/**
 * Slack → the engine (D45): a team member's reaction on a post the engine remembered under a tag becomes a
 * `slack.reaction` event, which a workflow can start from and which wakes a run waiting on that very post (D53: a ✅ on
 * "unclear reply, please confirm" confirms that call). And the bot (D70): a mention, a DM, or a reply in a thread the bot
 * is in is acknowledged at once and answered after the response (Slack wants an answer within three seconds). Signature
 * verified; deliveries deduplicated; the bot's own messages and reactions are ignored. The shared app is also told when it is
 * uninstalled or its token revoked: that workspace's offers lose their Slack (and say so).
 */
export async function eventsDoor(req: Request, key: DoorKey): Promise<Response> {
  const raw = await req.text();
  let body: { team_id?: unknown; event?: { type?: unknown; tokens?: { bot?: unknown[] } } };
  try { body = JSON.parse(raw); } catch { return NextResponse.json({ error: "body is not JSON" }, { status: 400 }); }
  const ev = parseSlackEvent(body);
  const teamId = typeof body.team_id === "string" ? body.team_id : null;
  const res = await asOperator(async (c) => {
    // Slack's URL check is an echo and changes nothing, so an own app's is answered even before its signing secret is stored: the
    // operator can finish the Slack side first. Every real event still needs the secret.
    if (ev.kind === "challenge" && "companyId" in key && !(await signingSecret(c, key.companyId))) return NextResponse.json({ challenge: ev.challenge });
    const v = await verifyDoor(c, key, req, raw);
    if (!v.ok) return "moved" in v ? NextResponse.json({ ok: true, ignored: MOVED }) : NextResponse.json({ error: v.why }, { status: v.status });
    if (ev.kind === "challenge") return NextResponse.json({ challenge: ev.challenge });
    const type = body.event?.type;
    if ("shared" in key && teamId && (type === "app_uninstalled" || (type === "tokens_revoked" && (body.event?.tokens?.bot?.length ?? 0) > 0)))
      return NextResponse.json({ ok: true, disconnected: await slackGone(c, teamId, type === "app_uninstalled" ? "uninstalled" : "token revoked") });
    if (ev.kind === "ignored") return NextResponse.json({ ok: true, ignored: ev.type });
    const r = await resolve(c, v, ev.kind === "reaction" ? { teamId, channel: ev.channel, ts: ev.ts, user: ev.user } : { teamId, channel: ev.channel, ts: ev.threadTs ?? ev.ts, user: ev.user });
    if (!("companyId" in r)) {
      // asked of the bot (a mention or a DM) and no telling which offer: said, in the thread; anything else is not the bot's to answer
      const asked = ev.kind === "message" && !ev.botId && (ev.type === "app_mention" || ev.channelType === "im");
      const token = asked && teamId ? await workspaceBot(c, teamId) : null;
      if (token && ev.kind === "message") return { unrouted: { token, channel: ev.channel, thread: ev.threadTs ?? ev.ts, text: notRouted(r) } };
      return NextResponse.json({ ok: true, ignored: "no offer for this" });
    }
    const companyId = r.companyId;
    const first = await one(c, "insert into webhook_deliveries (company_id, provider, delivery_id) values ($1,'slack',$2) on conflict do nothing returning delivery_id", [companyId, ev.eventId]);
    if (!first) return NextResponse.json({ ok: true, duplicate_delivery: true });
    if (ev.kind === "message") return { message: ev, companyId };
    const out = await reactionArrived(c, companyId, ev);
    return respondAndRun(companyId, "ignored" in out ? { ok: true, ignored: out.ignored } : { ok: true, ...out });   // a reaction can wake a run waiting on it (D58)
  });
  if (res instanceof Response) return res;
  if ("unrouted" in res && res.unrouted) {
    const u = res.unrouted;
    after(() => liveAdapters.notifier.post(u.token, u.channel, u.text, undefined, u.thread).then(() => undefined).catch((e) => console.error("slack which offer:", e)));
    return NextResponse.json({ ok: true, accepted: true });
  }
  after(() => handleMessage({ adapters: liveAdapters }, res.companyId, res.message).catch((e) => console.error("slack bot:", e)));
  return NextResponse.json({ ok: true, accepted: true });
}

/**
 * Slack slash commands (D70): /mtd, /weekly, /monthly, /show-rate, /close-rate, /cash, /availability, /leads, the help
 * command, /support (D152), /agreement (D202, opens a form) and /team (D203, the operator only), all to this one door. Form-encoded, signed like the events door.
 * Help and a period that cannot be read are answered at once, privately; everything else is acknowledged within Slack's three
 * seconds and posted after the response. Each answers for the one offer the command was sent from, never another in the workspace.
 */
export async function commandsDoor(req: Request, key: DoorKey): Promise<Response> {
  const raw = await req.text();
  const f = new URLSearchParams(raw);
  const cmd: SlashCommand = { command: f.get("command") ?? "", text: f.get("text") ?? "", userId: f.get("user_id") ?? "", channelId: f.get("channel_id") ?? "", channelName: f.get("channel_name") ?? undefined, teamId: f.get("team_id") ?? undefined, responseUrl: f.get("response_url") ?? undefined };
  const res = await asOperator(async (c) => {
    const v = await verifyDoor(c, key, req, raw);
    if (!v.ok) return "moved" in v ? NextResponse.json({ response_type: "ephemeral", text: MOVED }) : NextResponse.json({ error: v.why }, { status: v.status });
    const r = await resolve(c, v, { teamId: cmd.teamId, channel: cmd.channelId, user: cmd.userId });
    if (!("companyId" in r)) return NextResponse.json({ response_type: "ephemeral", text: notRouted(r) });
    const companyId = r.companyId;
    const { bindings, row } = await loadCompany(c, companyId);
    const conn = await one<{ team_id: string; bot_user_id: string | null }>(c, "select team_id, bot_user_id from slack_connections where company_id=$1", [companyId]);
    if (!conn || (cmd.teamId && cmd.teamId !== conn.team_id)) return NextResponse.json({ response_type: "ephemeral", text: "This workspace is not connected to this company." });
    const name = cmd.command.replace(/^\//, "").toLowerCase();
    // D202: /agreement opens the form (Slack allows three seconds for it, so it opens here, not after the answer)
    if (name === AGREEMENT_COMMAND) {
      const a = await answerAgreementCommand(c, companyId, cmd.userId, bindings, cmd.text);
      if (a.form) {
        const bot = await slackBot(c, companyId), trigger = f.get("trigger_id");
        if (!bot || !trigger || !liveAdapters.notifier.openView) return NextResponse.json({ response_type: "ephemeral", text: "Slack didn't give me a way to open the form; try again." });
        await liveAdapters.notifier.openView(bot.token, trigger, agreementForm(a.form, { channel: cmd.channelId }, a.picked));
        return new Response(null, { status: 200 });
      }
      if (a.send) return { companyId, agreement: { ...a.send, user: cmd.userId, url: f.get("response_url") ?? "", say: a.say } };
      return NextResponse.json(a.say);
    }
    // D253: /reassign opens its form here too (inside the three seconds)
    if (name === REASSIGN_COMMAND) {
      const a = await reassignStart(c, companyId, cmd.userId, row.timezone, cmd.channelId);
      if ("say" in a) return NextResponse.json({ response_type: "ephemeral", text: a.say });
      const bot = await slackBot(c, companyId), trigger = f.get("trigger_id");
      if (!bot || !trigger || !liveAdapters.notifier.openView) return NextResponse.json({ response_type: "ephemeral", text: "Slack didn't give me a way to open the form; try again." });
      await liveAdapters.notifier.openView(bot.token, trigger, a.view);
      return new Response(null, { status: 200 });
    }
    // D152: /support opens a ticket (the reply says it is in; the post and the operator's note follow)
    if (name === TICKET_COMMAND) return cmd.text.trim() ? { companyId, ticket: true } : NextResponse.json({ response_type: "ephemeral", text: TICKET_USAGE });
    // D203: /team (the operator only) answers privately, after the response: it reads GHL, Slack and the booking tool
    if (name === TEAM_COMMAND) return { companyId, team: true };
    const p = planCommand(cmd, row.timezone, DateTime.now());
    if ("help" in p) return NextResponse.json({ response_type: "ephemeral", text: helpText(conn.bot_user_id ? `<@${conn.bot_user_id}>` : "@bot") });
    if ("error" in p) return NextResponse.json({ response_type: "ephemeral", text: p.error });
    return { companyId, plan: p.plan };
  });
  if (res instanceof Response) return res;
  const companyId = res.companyId;
  if ("agreement" in res && res.agreement) {   // D202: an exact /agreement: answered "Sending…", then the outcome in its place
    const g = res.agreement;
    after(() => requestAgreement(liveAdapters, companyId, g.user, g.contact, g.choice, g.by, (text) => respondToSlack(g.url, { response_type: "ephemeral", replace_original: true, text })).then(() => undefined).catch((e) => console.error("slack agreement:", e)));
    return NextResponse.json(g.say);
  }
  if ("ticket" in res) {
    after(() => openTicket(liveAdapters, companyId, { text: cmd.text, slackUser: cmd.userId, channel: cmd.channelId }).catch((e) => console.error("ticket:", e)));
    return NextResponse.json({ response_type: "ephemeral", text: "Got it. It's being logged; it'll show here with its number in a moment." });
  }
  if ("team" in res) {
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
  const plan = res.plan;
  after(() => runCommand({ adapters: liveAdapters, respond: respondToSlack }, companyId, cmd, plan).catch((e) => console.error("slack command:", e)));
  return new Response(null, { status: 200 });
}

/**
 * Slack interactivity (D93): the Retry and Resolve buttons on an alert's post. D200: "Link to a contact" on an unlinked payment or
 * recording opens its form here, inside the three seconds (views.open needs the press's trigger_id); the form's submit is checked
 * here too (an error goes back into the form) and the link itself is made after the answer. Form-encoded (`payload=` JSON), signed like the
 * events and commands doors. Slack wants an answer within three seconds and a retry can call the CRM, so the press is
 * acknowledged at once and handled after the response; what it did is said by editing the post, a thread line or a private note.
 * The Slack app's Interactivity & Shortcuts → Request URL is this door. A form carries the channel it was opened from, which is how
 * the shared app knows its offer when one workspace runs several.
 */
export async function interactionsDoor(req: Request, key: DoorKey): Promise<Response> {
  const raw = await req.text();
  type Next = Response | ({ companyId: string } & ({ kind: "agreement"; user: string; contact: Who; choice: AgreementChoice; by: { name: string; ghl_user_id: string | null }; url?: string } | { kind: "link"; user: string; meta: NonNullable<ReturnType<typeof parseMeta>>; contact: { id: string; name: string } } | { kind: "say"; url?: string; text: string; replace?: boolean } | { kind: "press"; press: SlackPress }));
  const res = await asOperator(async (c): Promise<Next> => {
    const v = await verifyDoor(c, key, req, raw);
    if (!v.ok) return "moved" in v ? new Response(null, { status: 200 }) : NextResponse.json({ error: v.why }, { status: v.status });
    const p = parseSlackInteraction(raw);
    if (p.kind === "ignored") return new Response(null, { status: 200 });
    const formChannel = (() => { if (p.kind !== "submit" || !p.meta) return null; try { const m = JSON.parse(p.meta) as { channel?: unknown }; return typeof m.channel === "string" ? m.channel : null; } catch { return null; } })();
    const r = await resolve(c, v, p.kind === "press" ? { teamId: p.teamId, channel: p.channel, ts: p.ts, user: p.user } : { teamId: p.teamId, channel: formChannel, user: p.user });
    if (!("companyId" in r)) {
      if (p.kind === "submit") return NextResponse.json({ response_action: "errors", errors: { who: notRouted(r) } });
      const url = p.responseUrl;
      if (url) after(() => respondToSlack(url, { response_type: "ephemeral", text: notRouted(r) }).catch(() => {}));
      return new Response(null, { status: 200 });
    }
    const companyId = r.companyId;
    const { bindings } = await loadCompany(c, companyId);
    const bot = await slackBot(c, companyId);
    if (!bot || (p.teamId && p.teamId !== bot.teamId)) return new Response(null, { status: 200 });
    if (p.kind === "submit" && p.callbackId === AGREEMENT_FORM) {   // D202: /agreement's form
      const a = await checkAgreementSubmit(c, companyId, p.user, bindings, p.values.who ?? "", p.values.which ?? "");
      if ("errors" in a) return NextResponse.json({ response_action: "errors", errors: a.errors });
      return { companyId, kind: "agreement", user: p.user, ...a };
    }
    // D253: /reassign's two forms: the first is answered with the second in its place; the second hands the calls over now
    if (p.kind === "submit" && (p.callbackId === REASSIGN_PICK || p.callbackId === REASSIGN_CALLS)) {
      const { row } = await loadCompany(c, companyId);
      if (p.callbackId === REASSIGN_PICK) {
        const r = await reassignPicked(c, companyId, p.user, row.timezone, p.values, p.meta);
        return "errors" in r ? NextResponse.json({ response_action: "errors", errors: r.errors }) : NextResponse.json({ response_action: "update", view: r.view });
      }
      const r = await reassignChosen(c, companyId, p.user, row.timezone, p.values, p.meta);
      if ("errors" in r) return NextResponse.json({ response_action: "errors", errors: r.errors });
      const said = r.say, token = bot.token, user = p.user;
      after(() => liveAdapters.notifier.post(token, user, said).then(() => runCompanyNow(companyId)).catch((e) => console.error("slack reassign:", e)));
      return NextResponse.json({ response_action: "clear" });
    }
    if (p.kind === "submit") {
      const meta = p.callbackId === LINK_FORM ? parseMeta(p.meta) : null;
      if (!meta) return new Response(null, { status: 200 });
      const s = await checkSubmit(c, companyId, p.user, meta, p.values.who ?? "");
      if ("error" in s) return NextResponse.json({ response_action: "errors", errors: { who: s.error } });
      return { companyId, kind: "link", user: p.user, meta, contact: s.contact };
    }
    // D202: the Send / Cancel buttons under an /agreement answer
    if (p.action === "agreement_cancel") return { companyId, kind: "say", url: p.responseUrl, text: "Cancelled. Nothing sent.", replace: true };
    if (p.action === "agreement_send") {
      const a = await checkAgreementPress(c, companyId, p.user, bindings, p.value);
      return "say" in a ? { companyId, kind: "say", url: p.responseUrl, text: a.say, replace: true } : { companyId, kind: "agreement", user: p.user, ...a, url: p.responseUrl };
    }
    const kind = LINK_ACTIONS[p.action as keyof typeof LINK_ACTIONS];
    if (kind) {
      const allowed = await one(c, `select 1 where exists (select 1 from users where company_id=$1 and slack_user_id=$2 and active and role in ('owner','manager'))
        or exists (select 1 from bindings where company_id=$1 and key='bot.escalate_to' and convert_from(value,'utf8')=$2)`, [companyId, p.user]);
      if (!allowed) return { companyId, kind: "say", url: p.responseUrl, text: ONLY_MANAGERS };
      if (p.triggerId && liveAdapters.notifier.openView) await liveAdapters.notifier.openView(bot.token, p.triggerId, linkForm({ kind, id: p.value, channel: p.channel, ts: p.ts })).catch((e) => console.error("slack link form:", e));
      return new Response(null, { status: 200 });
    }
    return { companyId, kind: "press", press: p };
  });
  if (res instanceof Response) return res;
  const companyId = res.companyId;
  if (res.kind === "agreement") {   // from the form (said in a DM) or a Send button (said in place of the buttons)
    const url = res.url, reply = url ? (text: string) => respondToSlack(url, { response_type: "ephemeral", replace_original: true, text }) : undefined;
    after(async () => { if (reply) await reply(`Sending ${res.choice.label} to ${res.contact.name}…`).catch(() => {}); await requestAgreement(liveAdapters, companyId, res.user, res.contact, res.choice, res.by, reply).catch((e) => console.error("slack agreement:", e)); });
    return new Response(null, { status: 200 });
  }
  if (res.kind === "link") { after(() => linkSubmitted(liveAdapters, companyId, res.user, res.meta, res.contact).then(() => undefined).catch((e) => console.error("slack link:", e)).then(() => runCompanyNow(companyId))); return new Response(null, { status: 200 }); }
  if (res.kind === "say") { const url = res.url; if (url) after(() => respondToSlack(url, { response_type: "ephemeral", replace_original: !!res.replace, text: res.text }).catch(() => {})); return new Response(null, { status: 200 }); }
  const press = res.press;
  after(() => alertPressed({ adapters: liveAdapters, respond: respondToSlack }, companyId, press).catch((e) => console.error("slack press:", e)).then(() => runCompanyNow(companyId)));
  return new Response(null, { status: 200 });
}
