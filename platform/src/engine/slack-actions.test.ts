/**
 * D93: Retry and Resolve on an alert's Slack post. Driven through the real runner, the Health check workflow and the
 * interactions door against Postgres, with fakes for GHL and Slack: the post carries the buttons, a manager's press retries
 * the step or resolves the alert and the post is settled in place, anyone else is told no, and a second press is harmless.
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
import { createHmac } from "node:crypto";
import { DateTime } from "luxon";
import { asOperator, one, many } from "@/db/client";
import { migrate } from "@/db/migrate";
import { encrypt } from "@/engine/crypto";
import { emitEvent, dispatchEvent } from "@/engine/dispatch";
import { tick } from "@/engine/runner";
import { tickAlerts, raise } from "@/engine/alerts";
import { fakeAdapters, installTemplateForTest } from "@/engine/test-install";
import { syncTriggers } from "@/engine/install";
import { parseDefinition, extractManifest } from "@/engine/definition";
import { GhlError } from "@/adapters/ghl/client";
import { alertPressed, parseSlackInteraction, ONLY_MANAGERS, type SlackPress } from "@/engine/webhooks/slack-actions";
import { sectionBlocks, withButtons } from "@/engine/slack-blocks";
import type { Adapters, SlackBlock, SlackPersona } from "@/adapters/types";

const HAS_DB = !!process.env.DATABASE_URL;
process.env.BINDINGS_KEY ??= Buffer.alloc(32, 7).toString("base64");
const pending: (() => Promise<unknown>)[] = [];
// the door hands the press to after(); here it is only collected (run, it would reach the live vendors)
vi.mock("next/server", async (orig) => ({ ...(await orig<typeof import("next/server")>()), after: (fn: () => Promise<unknown>) => { pending.push(fn); } }));

const SECRET = "press-me";
const TZ = "America/New_York";
const posts: { channel: string; text: string; as?: SlackPersona; threadTs?: string; blocks?: SlackBlock[] }[] = [];
const updates: { channel: string; ts: string; text: string; blocks?: SlackBlock[] }[] = [];
const said: { url: string; body: Record<string, unknown> }[] = [];
const tags: string[] = [];
let tagDown = true;
const base = fakeAdapters();
const fake: Adapters = {
  ...base,
  write: { ...base.write, addTag: async (_c, id, t) => { if (tagDown) throw new GhlError(503, "upstream connect error", `/contacts/${id}/tags`); tags.push(t); } },
  notifier: { ...base.notifier,
    post: async (_t, channel, text, as, threadTs, blocks) => { posts.push({ channel, text, as, threadTs, blocks }); return { ts: `9.${posts.length}`, channel }; },
    update: async (_t, channel, ts, text, blocks) => { updates.push({ channel, ts, text, blocks }); } },
};
const deps = { adapters: fake, respond: async (url: string, body: Record<string, unknown>) => { said.push({ url, body }); } };

let companyId: string, wfId: string;
const MANAGER = "U-MGR", CLOSER = "U-CLO", OPERATOR = "U-OP";
const alertOf = (id: string) => asOperator((c) => one<{ key: string; resolved_at: Date | null; text: string }>(c, "select key, resolved_at, text from alerts where id=$1", [id]));
const audits = (id: string) => asOperator((c) => many<{ after: Record<string, unknown> }>(c, "select after from audit_log where company_id=$1 and action='alert.resolved_by_operator' and target_id=$2", [companyId, id]));
const pollRep = { companies: 1, contacts: 0, appointmentsNew: 0, appointmentsChanged: 0, inbound: 0, calls: 0, agreements: 0, cardsMoved: 0, eventsDispatched: 0, baselined: 0, errors: [] };
const tickRep = { claimed: 0, completed: 0, waiting: 0, exited: 0, failed: 0, paused: 0, recovery: false, staleExits: 0, sends: 0 };
/** The engine hands what is due to Health check, and the next tick says it (D88). */
const alertsThenSay = async () => { await asOperator((c) => tickAlerts(c, fake, pollRep, tickRep, new Date(), companyId)); await tick(fake, undefined, companyId); };
/** A press as the door hands it on, on the post the Health check made for that alert. */
const press = (action: SlackPress["action"], value: string, user: string, post: { channel: string; text: string; blocks?: SlackBlock[] }, ts: string): SlackPress =>
  ({ kind: "press", teamId: "T-BTN", user, action, value, channel: post.channel, ts, responseUrl: "https://hooks.slack.com/actions/x", message: { text: post.text, blocks: post.blocks } });
const buttonsOf = (blocks?: SlackBlock[]) => (blocks ?? []).filter((b) => b.type === "actions").flatMap((b) => (b.elements as { action_id: string; value: string; text: { text: string } }[]).map((e) => ({ action: e.action_id, value: e.value, text: e.text.text })));
/** The Health check post for an alert: the top-level post (no thread) that carries its id. */
const alertPost = (alertId: string) => { const i = posts.findIndex((p) => !p.threadTs && buttonsOf(p.blocks).some((b) => b.value === alertId)); return { post: posts[i], ts: `9.${i + 1}` }; };

describe.skipIf(!HAS_DB)("D93: Retry and Resolve in Slack", () => {
  beforeAll(async () => {
    await migrate().catch((e: Error) => { if (!/events_source_check/.test(e.message)) throw e; });
    await asOperator(async (c) => {
      const co = await one<{ id: string }>(c, "select id from companies where slug='slkbtn'");
      if (co) {
        await c.query("delete from run_steps where run_id in (select id from runs where company_id=$1)", [co.id]);
        await c.query("delete from workflow_versions where workflow_id in (select id from workflows where company_id=$1)", [co.id]);
        for (const t of ["alerts", "health_checks", "slack_posts", "sends", "step_effects", "runs", "events", "slack_connections", "workflow_triggers", "workflows", "contact_identifiers", "contacts", "users", "calendars", "company_terms", "bindings", "poll_cursors", "audit_log"]) await c.query(`delete from ${t} where company_id=$1`, [co.id]);
        await c.query("delete from companies where id=$1", [co.id]);
      }
      await c.query("insert into engine_state (key, value, updated_at) values ('alerts_cursor', $1, now()) on conflict (key) do update set value=$1", [{ since: new Date().toISOString() }]);
      companyId = (await one<{ id: string }>(c, "insert into companies (name, slug, timezone, mode, send_window_start, send_window_end) values ('Button Co','slkbtn',$1,'live','00:00','23:59') returning id", [TZ]))!.id;
      await c.query("insert into company_terms (company_id, domain, name, category, is_default, sort) select $1, domain, label, value, true, sort from core_categories", [companyId]);
      await c.query("insert into bindings (company_id,key,kind,value) values ($1,'crm.location_id','id',$2),($1,'secret.ghl_pit','secret',$3),($1,'alerts.slack_channel','channel',$4),($1,'bot.escalate_to','id',$5),($1,'bot.escalate_name','text',$6),($1,'secret.slack_signing','secret',$7)",
        [companyId, Buffer.from("LOC"), encrypt("p1"), Buffer.from("CALERTS"), Buffer.from(OPERATOR), Buffer.from("Tyler"), encrypt(SECRET)]);
      await c.query("insert into slack_connections (company_id, team_id, bot_token, channels) values ($1,'T-BTN',$2,'{}')", [companyId, encrypt("xoxb-fake")]);
      await c.query("insert into users (company_id, email, name, role, slack_user_id) values ($1,'mia@btn.test','Mia','manager',$2),($1,'cal@btn.test','Cal','closer',$3)", [companyId, MANAGER, CLOSER]);
      const def = parseDefinition({ schema: 1, reentry: "always", premise: { check: "contact_exists" },
        nodes: [{ id: "t1", type: "trigger", event: "tag.added" }, { id: "n1", type: "set_tag", tag: ["stat-x"] }, { id: "n2", type: "note", template: "Noted {{contact.first_name}}" }, { id: "x1", type: "exit", reason: "done" }],
        edges: [{ from: "t1", to: "n1" }, { from: "n1", to: "n2" }, { from: "n2", to: "x1" }] });
      wfId = (await one<{ id: string }>(c, "insert into workflows (company_id, name, reentry_policy, enabled) values ($1,'Tag then note','always',true) returning id", [companyId]))!.id;
      await c.query("insert into workflow_versions (workflow_id, version, definition, manifest, note) values ($1,1,$2,$3,'test')", [wfId, def, extractManifest(def)]);
      await syncTriggers(c, companyId, wfId, def);
      await installTemplateForTest(c, companyId, "health-check");
    });
  });

  it("the door: a forged or stale signature is refused and nothing is handed on; a signed press is acknowledged at once and handled after the response; Slack's payload is read", async () => {
    const { POST } = await import("../../app/api/webhooks/slack/[companyId]/interactions/route");
    const payload = { type: "block_actions", team: { id: "T-BTN" }, user: { id: MANAGER, username: "mia" }, response_url: "https://hooks.slack.com/actions/T/1/x",
      container: { type: "message", channel_id: "CALERTS", message_ts: "9.1" }, message: { ts: "9.1", text: "🔴 hi", blocks: [{ type: "section", text: { type: "mrkdwn", text: "🔴 hi" } }] },
      actions: [{ type: "button", action_id: "alert_resolve", value: "00000000-0000-0000-0000-000000000001" }] };
    const raw = new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
    const sign = (ts: string, secret = SECRET) => ({ "x-slack-request-timestamp": ts, "x-slack-signature": `v0=${createHmac("sha256", secret).update(`v0:${ts}:${raw}`).digest("hex")}`, "content-type": "application/x-www-form-urlencoded" });
    const now = String(Math.floor(Date.now() / 1000)), old = String(Math.floor(Date.now() / 1000) - 600);
    const send = (headers: Record<string, string>) => POST(new Request("http://x", { method: "POST", body: raw, headers }), { params: Promise.resolve({ companyId }) });
    expect((await send(sign(now, "not-the-secret"))).status).toBe(401);
    expect((await send(sign(old))).status).toBe(401);
    expect((await send({ "content-type": "application/x-www-form-urlencoded" })).status).toBe(401);
    expect(pending).toHaveLength(0);
    const okRes = await send(sign(now));
    expect(okRes.status).toBe(200); expect(pending).toHaveLength(1); pending.length = 0;
    expect(parseSlackInteraction(raw)).toEqual({ kind: "press", teamId: "T-BTN", user: MANAGER, userName: "mia", action: "alert_resolve", value: "00000000-0000-0000-0000-000000000001", channel: "CALERTS", ts: "9.1", responseUrl: "https://hooks.slack.com/actions/T/1/x", message: { text: "🔴 hi", blocks: payload.message.blocks } });
    expect(parseSlackInteraction(new URLSearchParams({ payload: JSON.stringify({ ...payload, actions: [{ action_id: "something_else", value: "x" }] }) }).toString())).toMatchObject({ kind: "ignored" });
    // Slack refuses a message whose buttons share an action_id: alike ones are told apart, a press reads the action before the ":"
    const ids = (withButtons("x", [{ text: "A", action: "agreement_send", value: "1" }, { text: "B", action: "agreement_send", value: "2" }, { text: "C", action: "agreement_cancel", value: "c" }]).at(-1)!.elements as { action_id: string }[]).map((e) => e.action_id);
    expect(ids).toEqual(["agreement_send:0", "agreement_send:1", "agreement_cancel"]);
    expect(parseSlackInteraction(new URLSearchParams({ payload: JSON.stringify({ ...payload, actions: [{ action_id: "alert_resolve:3", value: "v" }] }) }).toString())).toMatchObject({ kind: "press", action: "alert_resolve" });
    expect(parseSlackInteraction(new URLSearchParams({ payload: JSON.stringify({ type: "view_submission" }) }).toString())).toMatchObject({ kind: "ignored" });
    expect(parseSlackInteraction("nonsense")).toMatchObject({ kind: "ignored" });
  });

  it("a skipped step's alert carries Retry and Resolve under the same words; a closer is told no; a retry that fails again says so in the thread and keeps the buttons; one that passes resolves the alert and settles the post; a second press does nothing", async () => {
    const contactId = (await asOperator((c) => one<{ id: string }>(c, "insert into contacts (company_id, ghl_contact_id, first_name, last_name, timezone) values ($1,'GB1','Ben','Press',$2) returning id", [companyId, TZ])))!.id;
    const runId = (await asOperator(async (c) => dispatchEvent(c, await emitEvent(c, { company_id: companyId, contact_id: contactId, opportunity_id: null, appointment_id: null, event_type: "tag.added", source: "test", data: { tag: "x" } }), { contact: { id: contactId } })))[0];
    let at = DateTime.now();
    for (let i = 0; i < 4; i++) { await asOperator((c) => c.query("update runs set next_run_at=now() where id=$1", [runId])); await tick(fake, at as DateTime<true>, companyId); at = at.plus({ minutes: 10 }); }
    const key = `skipped:${wfId}:n1:${contactId}`;
    const alert = (await asOperator((c) => one<{ id: string }>(c, "select id from alerts where company_id=$1 and key=$2 and resolved_at is null", [companyId, key])))!;
    expect(alert).toBeTruthy();
    await alertsThenSay();
    const { post, ts } = alertPost(alert.id);
    expect(post.channel).toBe("CALERTS");
    expect(post.text).toMatch(/^🟡 \*Button Co · Step skipped\*\nCouldn't add the tag “stat-x” for Ben Press after 3 tries \(GHL says upstream connect error\); everything else in Tag then note ran\.\n<.*\|Open>/);   // the text stays the fallback
    expect(post.blocks!.filter((b) => b.type === "section").map((b) => (b.text as { text: string }).text).join("\n")).toBe(post.text);
    expect(buttonsOf(post.blocks)).toEqual([{ action: "alert_retry", value: alert.id, text: "Retry" }, { action: "alert_resolve", value: alert.id, text: "Resolve" }, { action: "alert_pause", value: alert.id, text: "Pause" }]);

    // a closer is not a manager: told so privately, nothing moves
    expect(await alertPressed(deps, companyId, press("alert_retry", alert.id, CLOSER, post, ts))).toEqual({ done: "denied" });
    expect(said.at(-1)).toEqual({ url: "https://hooks.slack.com/actions/x", body: { response_type: "ephemeral", replace_original: false, text: ONLY_MANAGERS } });
    expect(await alertPressed(deps, companyId, press("alert_resolve", alert.id, "U-STRANGER", post, ts))).toEqual({ done: "denied" });
    expect((await alertOf(alert.id))!.resolved_at).toBeNull(); expect(updates).toHaveLength(0); expect(tags).toHaveLength(0);

    // GHL still down: the retry fails, said in plain words in the alert's thread; the post keeps its buttons
    const before = posts.length;
    expect(await alertPressed(deps, companyId, press("alert_retry", alert.id, MANAGER, post, ts))).toMatchObject({ done: "failed" });
    expect(posts.slice(before)).toEqual([{ channel: "CALERTS", threadTs: ts, as: { name: "Engine alerts", icon: ":warning:" }, blocks: undefined,
      text: `Retry by <@${MANAGER}> didn't work: GHL says upstream connect error. The alert stays open; retry again once that's fixed, or press Resolve.` }]);
    expect(updates).toHaveLength(0); expect((await alertOf(alert.id))!.resolved_at).toBeNull();

    // GHL is back: the step runs once, the alert resolves, the post says who fixed it and loses its buttons
    tagDown = false;
    expect(await alertPressed(deps, companyId, press("alert_retry", alert.id, MANAGER, post, ts))).toEqual({ done: "retried" });
    expect(tags).toEqual(["stat-x"]);
    expect((await alertOf(alert.id))!.resolved_at).not.toBeNull();
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ channel: "CALERTS", ts, text: `${post.text}\n✅ Fixed — retried by <@${MANAGER}>` });
    expect(buttonsOf(updates[0].blocks)).toEqual([]);
    expect(updates[0].blocks!.at(-1)).toEqual({ type: "context", elements: [{ type: "mrkdwn", text: `✅ Fixed — retried by <@${MANAGER}>` }] });
    expect(await asOperator((c) => one(c, "select 1 from audit_log where company_id=$1 and action='run.step_retried' and target_id=$2 and after->>'by'='Mia in Slack' and after->>'ok'='true'", [companyId, runId]))).toBeTruthy();

    // a second press (the stale message, or a double tap): already done, nothing runs again, the post is not touched
    const n = said.length;
    expect(await alertPressed(deps, companyId, press("alert_retry", alert.id, MANAGER, post, ts))).toEqual({ done: "already" });
    expect(said.slice(n)).toEqual([{ url: "https://hooks.slack.com/actions/x", body: { response_type: "ephemeral", replace_original: false, text: "Already done: this alert is resolved." } }]);
    expect(tags).toEqual(["stat-x"]); expect(updates).toHaveLength(1);

    // the next tick says it resolved in the alert's thread, as any resolve
    await alertsThenSay();
    expect(posts.at(-1)).toMatchObject({ threadTs: ts, text: expect.stringMatching(/^✅ Resolved after/) });
  });

  it("D150 Pause: a manager's press stops the reminders, keeps the alert open and settles the post; a second press says it already is; a closer is told no", async () => {
    const a = await asOperator((c) => raise(c, { companyId, key: "health:steps:pause-me", level: "warning", source: "health", text: "Deal closed never starts until payments are connected." }));
    await alertsThenSay();
    const pa = alertPost(a.id);
    expect(await alertPressed(deps, companyId, press("alert_pause", a.id, "U-STRANGER", pa.post, pa.ts))).toEqual({ done: "denied" });
    expect(await alertPressed(deps, companyId, press("alert_pause", a.id, MANAGER, pa.post, pa.ts))).toEqual({ done: "paused" });
    const row = (await asOperator((c) => one<{ resolved_at: Date | null; paused_at: Date | null; paused_by: string | null }>(c, "select resolved_at, paused_at, paused_by from alerts where id=$1", [a.id])))!;
    expect(row.resolved_at).toBeNull(); expect(row.paused_at).not.toBeNull(); expect(row.paused_by).toBe("Mia in Slack");
    expect(updates.at(-1)).toMatchObject({ channel: "CALERTS", ts: pa.ts, text: `${pa.post.text}\n⏸️ Paused by <@${MANAGER}>: no more reminders. It still closes here once it's fixed.` });
    expect(buttonsOf(updates.at(-1)!.blocks)).toEqual([]);
    expect(await alertPressed(deps, companyId, press("alert_pause", a.id, MANAGER, pa.post, pa.ts))).toEqual({ done: "already" });
  });

  it("Resolve: a manager's press closes the alert with who and why in the audit log and settles the post; the operator may too; two presses at once resolve it once; an alert with no step to retry has no Retry button", async () => {
    const a = await asOperator((c) => raise(c, { companyId, key: "health:calendar:CAL9", level: "error", source: "health", text: "Closer C has no free slots in the next 7 days.", href: "/app/c/slkbtn/health" }));
    const b = await asOperator((c) => raise(c, { companyId, key: "health:calendar:CAL8", level: "warning", source: "health", text: "Closer D has two free slots in the next 7 days.", href: "/app/c/slkbtn/health" }));
    await alertsThenSay();
    const pa = alertPost(a.id), pb = alertPost(b.id);
    expect(buttonsOf(pa.post.blocks)).toEqual([{ action: "alert_resolve", value: a.id, text: "Resolve" }, { action: "alert_pause", value: a.id, text: "Pause" }]);   // not a skipped step: nothing to retry
    // Retry pressed on it anyway (an old post, a hand-made payload): refused in words, nothing changes
    expect(await alertPressed(deps, companyId, press("alert_retry", a.id, MANAGER, pa.post, pa.ts))).toMatchObject({ done: "refused" });
    expect((await alertOf(a.id))!.resolved_at).toBeNull();

    const u0 = updates.length;
    const both = await Promise.all([alertPressed(deps, companyId, press("alert_resolve", a.id, MANAGER, pa.post, pa.ts)), alertPressed(deps, companyId, press("alert_resolve", a.id, MANAGER, pa.post, pa.ts))]);
    expect(both.map((x) => x.done).sort()).toEqual(["already", "resolved"]);
    expect((await alertOf(a.id))!.resolved_at).not.toBeNull();
    expect(await audits(a.id)).toEqual([{ after: { why: "resolved in Slack by Mia", by: { slack_user_id: MANAGER, name: "Mia" } } }]);
    expect(updates.slice(u0)).toHaveLength(1);
    expect(updates.at(-1)).toMatchObject({ channel: "CALERTS", ts: pa.ts, text: `${pa.post.text}\n✅ Resolved by <@${MANAGER}>` });
    expect(buttonsOf(updates.at(-1)!.blocks)).toEqual([]);

    // the operator (bot.escalate_to) is not on the roster as a manager and may press too
    expect(await alertPressed(deps, companyId, press("alert_resolve", b.id, OPERATOR, pb.post, pb.ts))).toEqual({ done: "resolved" });
    expect(await audits(b.id)).toEqual([{ after: { why: "resolved in Slack by Tyler", by: { slack_user_id: OPERATOR, name: "Tyler" } } }]);
    // and a press from another workspace is not ours
    expect(await alertPressed(deps, companyId, { ...press("alert_resolve", b.id, OPERATOR, pb.post, pb.ts), teamId: "T-OTHER" })).toMatchObject({ done: "ignored" });
  });

  it("a long post is cut into sections Slack takes (3,000 characters at most), at line ends", () => {
    const text = Array.from({ length: 80 }, (_, i) => `• line ${i} ${"x".repeat(60)}`).join("\n");
    const s = sectionBlocks(text).map((b) => (b.text as { text: string }).text);
    expect(s.length).toBeGreaterThan(1); expect(s.every((t) => t.length <= 3000)).toBe(true); expect(s.join("\n")).toBe(text);
    expect(sectionBlocks("y".repeat(6500)).map((b) => (b.text as { text: string }).text.length)).toEqual([3000, 3000, 500]);
  });
});
