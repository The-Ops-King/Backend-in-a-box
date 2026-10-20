import type { PoolClient } from "pg";
import { asOperator, many, one } from "@/db/client";
import type { Adapters, SlackBlock } from "@/adapters/types";
import { alertKind, destinationsFor, pauseAlert, resolveByPerson, type AlertRow } from "../alerts";
import { retryStep } from "../hand";
import { classifyError, plainError } from "../failures";
import { settledMessage } from "../slack-blocks";
import { SLACK_ACTIONS } from "../definition";
import { slackBot } from "../slack-conn";

/**
 * D93: Retry and Resolve on an alert's Slack post. The Health check workflow puts the buttons on the post (slack_post `buttons`);
 * a press comes to the interactions door (`/api/webhooks/slack/<companyId>/interactions`), signed like the other Slack doors,
 * is acknowledged at once and handled here after the response. Only the company's owners and managers (users by slack_user_id)
 * and the operator (`bot.escalate_to`) may press; the alert row is locked for the press, so a second press waits for the first
 * and finds it done.
 */
export type SlackPress = { kind: "press"; teamId?: string; user: string; userName?: string; action: (typeof SLACK_ACTIONS)[number]; value: string; channel?: string; ts?: string; responseUrl?: string; triggerId?: string; message?: { text?: string; blocks?: SlackBlock[] } };
/** D200: a form of ours sent back (view_submission): which form, what it carried, what was typed (block id → value). */
export type SlackSubmit = { kind: "submit"; teamId?: string; user: string; callbackId: string; meta?: string; values: Record<string, string> };

/** Slack posts an interaction form-encoded, the JSON in `payload`. A button of ours on a message is a press; a form of ours sent back, a submit. */
export function parseSlackInteraction(raw: string): SlackPress | SlackSubmit | { kind: "ignored"; type: string } {
  let p: Record<string, unknown>;
  try { p = JSON.parse(new URLSearchParams(raw).get("payload") ?? ""); } catch { return { kind: "ignored", type: "no payload" }; }
  if (p?.type === "view_submission") {
    const view = (p.view ?? {}) as { callback_id?: string; private_metadata?: string; state?: { values?: Record<string, Record<string, { value?: string | null; selected_option?: { value?: string } | null }>> } };
    const user = (p.user ?? {}) as Record<string, unknown>;
    if (typeof view.callback_id !== "string" || typeof user.id !== "string") return { kind: "ignored", type: "view_submission" };
    // a text box answers `value`, a dropdown `selected_option.value` (D202)
    const values = Object.fromEntries(Object.entries(view.state?.values ?? {}).map(([block, inputs]) => { const i = Object.values(inputs)[0]; return [block, String(i?.value ?? i?.selected_option?.value ?? "")]; }));
    return { kind: "submit", teamId: typeof (p.team as { id?: unknown } | undefined)?.id === "string" ? (p.team as { id: string }).id : undefined, user: user.id, callbackId: view.callback_id, meta: view.private_metadata, values };
  }
  if (p?.type !== "block_actions") return { kind: "ignored", type: String(p?.type ?? "?") };
  const a = ((p.actions as Record<string, unknown>[] | undefined) ?? [])[0] ?? {};
  const action = SLACK_ACTIONS.find((x) => x === a.action_id);
  const user = (p.user ?? {}) as Record<string, unknown>;
  if (!action || typeof a.value !== "string" || typeof user.id !== "string") return { kind: "ignored", type: `action ${String(a.action_id ?? "?")}` };
  const container = (p.container ?? {}) as Record<string, unknown>, message = (p.message ?? {}) as Record<string, unknown>, channel = (p.channel ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  return { kind: "press", teamId: str(((p.team ?? {}) as Record<string, unknown>).id), user: user.id, userName: str(user.name) ?? str(user.username), action, value: a.value,
    channel: str(container.channel_id) ?? str(channel.id), ts: str(container.message_ts) ?? str(message.ts), responseUrl: str(p.response_url), triggerId: str(p.trigger_id),
    message: { text: str(message.text), blocks: Array.isArray(message.blocks) ? (message.blocks as SlackBlock[]) : undefined } };
}

export type PressDeps = { adapters: Adapters; respond: (url: string, body: Record<string, unknown>) => Promise<void> };
export type PressOutcome = { done: "retried" | "resolved" | "paused" | "already" | "denied" | "failed" | "refused" | "ignored"; why?: string };
type Decision = { out: PressOutcome; say?: string; settle?: string; thread?: string; token?: string; at?: { channel: string; ts: string } | null; as?: { name: string; icon?: string } };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const ONLY_MANAGERS = "Only a manager can do that.";

/** Who pressed, and whether they may: an owner or manager on the roster by their Slack id, or the operator. */
async function presser(c: PoolClient, companyId: string, slackUser: string): Promise<{ allowed: boolean; name: string }> {
  const u = await one<{ name: string; role: string }>(c, "select name, role from users where company_id=$1 and slack_user_id=$2 and active order by (role in ('owner','manager')) desc limit 1", [companyId, slackUser]);
  const b = Object.fromEntries((await many<{ key: string; value: Buffer }>(c, "select key, value from bindings where company_id=$1 and key in ('bot.escalate_to','bot.escalate_name')", [companyId])).map((r) => [r.key, r.value.toString("utf8").trim()]));
  const operator = !!b["bot.escalate_to"] && b["bot.escalate_to"] === slackUser;
  return { allowed: operator || u?.role === "owner" || u?.role === "manager", name: u?.name || (operator ? b["bot.escalate_name"] : "") || slackUser };
}

async function decide(c: PoolClient, deps: PressDeps, companyId: string, p: SlackPress): Promise<Decision> {
  const bot = await slackBot(c, companyId);
  if (!bot || (p.teamId && p.teamId !== bot.teamId)) return { out: { done: "ignored", why: "another workspace" } };
  const who = await presser(c, companyId, p.user);
  if (!who.allowed) return { out: { done: "denied" }, say: ONLY_MANAGERS };
  if (!UUID.test(p.value)) return { out: { done: "ignored", why: "not an alert id" } };
  // locked for the press: a second press on the same alert waits here, then finds it resolved
  const a = await one<AlertRow>(c, "select * from alerts where id=$1 and company_id=$2 for update", [p.value, companyId]);
  if (!a) return { out: { done: "ignored", why: "no such alert" }, say: "I can't find that alert any more." };
  const token = bot.token;
  const at = p.channel && p.ts ? { channel: p.channel, ts: p.ts } : (await one<{ channel: string; ts: string }>(c, "select channel, ts from slack_posts where company_id=$1 and tag=$2", [companyId, `alert:${a.id}`])) ?? null;
  if (a.resolved_at) return { out: { done: "already" }, say: "Already done: this alert is resolved." };
  const mention = `<@${p.user}>`;
  if (p.action === "alert_resolve") {
    const done = await resolveByPerson(c, companyId, a, `resolved in Slack by ${who.name}`, { slack_user_id: p.user, name: who.name });
    return done ? { out: { done: "resolved" }, settle: `✅ Resolved by ${mention}`, token, at } : { out: { done: "already" }, say: "Already done: this alert is resolved." };
  }
  if (p.action === "alert_pause") {
    // D150: no reminders until it clears; the post keeps no buttons (Resolve stays on the dashboard and the admin route)
    const done = await pauseAlert(c, companyId, a, `${who.name} in Slack`);
    return done ? { out: { done: "paused" }, settle: `⏸️ Paused by ${mention}: no more reminders. It still closes here once it's fixed.`, token, at } : { out: { done: "already" }, say: "Already paused." };
  }
  const d = a.detail as { run_id?: string; node?: string };
  if (alertKind(a) !== "skipped" || !d.run_id || !d.node) return { out: { done: "refused", why: "not a skipped step" }, say: "This alert has no single step to retry. Open it on the dashboard, or press Resolve once it's fixed." };
  // D77's Retry this step: only that step runs, once, now; passing resolves its alert (runner.ts › rerunStep)
  const r = await retryStep(c, d.run_id, `${who.name} in Slack`, { node: d.node, adapters: deps.adapters });
  if (r.ok) return { out: { done: "retried" }, settle: `✅ Fixed — retried by ${mention}`, token, at };
  if (r.status === 409 && /already passed/.test(r.error)) return { out: { done: "already", why: r.error }, say: "Already done: that step passed on an earlier retry." };
  if (r.status !== 502) return { out: { done: "refused", why: r.error }, say: `Couldn't retry it: ${r.error}.` };
  const dest = await destinationsFor(c, companyId, a.source);   // the thread line wears the alert's face
  return { out: { done: "failed", why: r.error }, thread: `Retry by ${mention} didn't work: ${plainError(classifyError(r.error))}. The alert stays open; retry again once that's fixed, or press Resolve.`, token, at,
    as: { name: dest.as_name || "Engine alerts", icon: dest.as_icon || (a.level === "error" ? ":rotating_light:" : ":warning:") } };
}

/** One press, start to end: decided and written in one transaction, then Slack is told (the message settled in place, a thread line, or a private note). */
export async function alertPressed(deps: PressDeps, companyId: string, p: SlackPress): Promise<PressOutcome> {
  const d = await asOperator((c) => decide(c, deps, companyId, p));
  const notifier = deps.adapters.notifier;
  try {
    if (d.say && p.responseUrl) await deps.respond(p.responseUrl, { response_type: "ephemeral", replace_original: false, text: d.say });
    if (d.settle && d.token && d.at) {
      const m = settledMessage(p.message ?? {}, d.settle);
      if (notifier.update) await notifier.update(d.token, d.at.channel, d.at.ts, m.text, m.blocks);
      else if (p.responseUrl) await deps.respond(p.responseUrl, { replace_original: true, text: m.text, blocks: m.blocks });
    }
    if (d.thread && d.token && d.at) await notifier.post(d.token, d.at.channel, d.thread, d.as, d.at.ts);
  } catch (e) { console.error("slack press:", e); }   // the alert's state is already written; Slack being down only leaves the old message
  return d.out;
}
