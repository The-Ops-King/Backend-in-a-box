/**
 * D84: a run keeps its own state (vars with its wait pins and listener, the reply, the event, a reaction, when the CRM was
 * last read), never a copy of the contact, the call or the booking. One workflow parks every way a run can (a pinned wait, a
 * non-blocking listener that fires and resumes, a reply wait, a blocking reaction wait, a step held on a vendor outage) and
 * still says, at its end, what it gathered on the way. The one-time cleanup for older rows is tested here too.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { asOperator, one, many } from "@/db/client";
import { migrate } from "@/db/migrate";
import { installCompany } from "@/engine/install";
import { emitEvent, startRun } from "@/engine/dispatch";
import { upsertContact } from "@/engine/poll";
import { tick } from "@/engine/runner";
import { buildContext, loadCompany, persistedContext, type RunRow } from "@/engine/context";
import { slimRunContexts } from "@/engine/retention";
import { parseDefinition, extractManifest } from "@/engine/definition";
import { encrypt } from "@/engine/crypto";
import { fakeAdapters, inboundForTest, unlockSendsForTest } from "@/engine/test-install";
import { GhlError } from "@/adapters/ghl/client";
import type { Adapters, ContactSnapshot } from "@/adapters/types";

const HAS_DB = !!process.env.DATABASE_URL;
process.env.BINDINGS_KEY ??= Buffer.alloc(32, 7).toString("base64");
const TZ = "America/Phoenix", SLUG = "slimctx", CHANNEL = "C-SLIM";
const PERSON: ContactSnapshot = { id: "SLIM1", firstName: "Dana", lastName: "Slimmer", email: "dana@slim.test", phone: "+16025559841", tags: [], customFields: {}, dateUpdated: new Date().toISOString(), dateAdded: new Date().toISOString() };
const TRANSCRIPT = "SLIM-TRANSCRIPT-LINE: we talked budget";
const PRIVATE = ["Dana", "Slimmer", "dana@slim.test", "+16025559841", "SLIM-TRANSCRIPT", "invitee@slim.test"];

const crm = new Map<string, ContactSnapshot>([[PERSON.id, PERSON]]);
const sms: string[] = [], posts: string[] = [];
let tagDown = false;
const base = fakeAdapters({ crm });
const fake: Adapters = {
  ...base,
  write: { ...base.write, addTag: async (_c, _id, tag) => { if (tagDown && tag === "slim-done") throw new GhlError(503, "Service Unavailable", "/contacts/tags"); } },
  sender: { ...base.sender, sendSms: async (_c, _to, body) => { sms.push(body); return { externalId: `s${sms.length}`, accepted: true }; } },
  notifier: { ...base.notifier, post: async (_t, _ch, text) => { posts.push(text); return { ts: `${posts.length}.000100`, channel: CHANNEL }; } },
};

const TABLES = ["alerts", "slack_posts", "sends", "runs", "events", "slack_connections", "workflow_triggers", "workflows", "messages", "recordings", "appointments", "pipeline_cards", "opportunities", "calendars", "contact_identifiers", "contacts", "users", "company_terms", "bindings", "poll_cursors", "audit_log"];
const wipe = () => asOperator(async (c) => {
  const co = await one<{ id: string }>(c, "select id from companies where slug=$1", [SLUG]); if (!co) return;
  await c.query("delete from run_steps where run_id in (select id from runs where company_id=$1)", [co.id]);
  await c.query("delete from workflow_versions where workflow_id in (select id from workflows where company_id=$1)", [co.id]);
  for (const t of TABLES) await c.query(`delete from ${t} where company_id=$1`, [co.id]);
  await c.query("delete from companies where id=$1", [co.id]);
});

let companyId = "", contactId = "", workflowId = "", recordingId = "";
type Run = { id: string; status: string; current_node: string | null; resume_node: string | null; wake_on_reply: boolean; wake_on_tag: string | null; step_held: boolean; next_run_at: Date | null; context: Record<string, unknown> };
const runRow = async (id: string) => (await asOperator((c) => one<Run>(c, "select id, status, current_node, resume_node, wake_on_reply, wake_on_tag, step_held, next_run_at, context from runs where id=$1", [id])))!;
const wake = (id: string) => asOperator((c) => c.query("update runs set next_run_at=now(), claimed_at=null where id=$1", [id]));
const tickOnce = () => tick(fake, undefined, companyId);
const tap = (reaction: string, user_name: string) => asOperator(async (c) => {
  const post = (await one<{ ts: string }>(c, "select ts from slack_posts where company_id=$1 and tag='slim:k1'", [companyId]))!;
  await emitEvent(c, { company_id: companyId, contact_id: null, opportunity_id: null, appointment_id: null, event_type: "slack.reaction", source: "slack", data: { channel: CHANNEL, ts: post.ts, reaction, user: `U-${user_name}`, user_name, tag: "slim:k1" } });
});
/** What a parked run stored: its own state only, nothing that names or quotes the person. */
/** `butReply`: the texts under reply (what they last said, what we last sent) are kept as they are for now; a later change decides them. */
const expectSlim = (ctx: Record<string, unknown>, butReply = false) => {
  expect(Object.keys(ctx).every((k) => ["vars", "reply", "event", "reaction", "contact"].includes(k))).toBe(true);
  expect(Object.keys((ctx.contact as Record<string, unknown>) ?? {}).every((k) => k === "fetched_at" || k === "stale")).toBe(true);
  const text = JSON.stringify(butReply ? { ...ctx, reply: undefined } : ctx);
  for (const p of PRIVATE) expect(text).not.toContain(p);
};

describe.skipIf(!HAS_DB)("D84: a run keeps its own state, not a copy of the contact", () => {
  beforeAll(async () => {
    await migrate().catch((e: Error) => { if (!/events_source_check/.test(e.message)) throw e; });
    await wipe();
    companyId = (await installCompany({ name: "Slim Context", slug: SLUG, timezone: TZ, locationId: "LOC-SLIM", pit: "pit-fake", calendars: { CAL: "closing" }, enable: true, templates: ["new-lead"], slack: { bookings: CHANNEL } }, fake)).companyId;
    await unlockSendsForTest(companyId);   // D145
    await asOperator(async (c) => {
      await c.query("update companies set mode='live', send_window_start='00:00', send_window_end='23:59' where id=$1", [companyId]);
      await c.query("insert into slack_connections (company_id, team_id, bot_token, bot_user_id, channels) values ($1,'T1',$2,'UBOT','{}')", [companyId, encrypt("xoxb-fake")]);
      contactId = (await upsertContact(c, companyId, TZ, PERSON)).id;
      recordingId = (await one<{ id: string }>(c, `insert into recordings (company_id, contact_id, external_id, title, started_at, ended_at, invitees, transcript, summary, recorded_by_email)
        values ($1,$2,'REC-SLIM','Discovery with Dana',now()-interval '2 hours',now()-interval '1 hour',$3,$4,'Dana wants to start','sam@x.com') returning id`,
        [companyId, contactId, JSON.stringify([{ name: "Dana Slimmer", email: "invitee@slim.test", is_external: true }]), JSON.stringify([{ speaker: "Dana Slimmer", text: TRANSCRIPT, timestamp: "00:00:01" }])]))!.id;
      const nodes = [
        { id: "t1", type: "trigger", event: "lead.created" },
        { id: "v1", type: "set_var", key: "greeting", value: "{{event.key}}-ok" },
        { id: "p1", type: "slack_post", channel: "{{slack.channel.bookings}}", template: "New lead {{contact.name}} {{contact.phone}}: {{recording.transcript_text}}", tag: "slim:{{event.key}}" },
        { id: "l1", type: "wait_for_reaction", of: "p1", emojis: ["eyes"], blocking: false, into: "vars.seen" },
        { id: "k1", type: "set_tag", tag: "seen" },
        { id: "rs1", type: "resume" },
        { id: "w1", type: "wait", rule: { anchor: "now", offset: "+1h", tz: "company" } },
        { id: "r1", type: "wait_for_reply", timeout: "1d" },
        { id: "b1", type: "wait_for_reaction", of: "p1", emojis: ["white_check_mark"] },
        { id: "h1", type: "set_tag", tag: "slim-done", blocking: true },
        { id: "s1", type: "send_sms", template: "{{vars.greeting}} | {{reaction.reaction}} by {{reaction.user_name}} | {{vars.seen.reaction}} by {{vars.seen.user_name}} | {{reply.last_inbound.body}} | {{contact.first_name}}" },
        { id: "x1", type: "exit", reason: "done" },
      ];
      const edges = [{ from: "t1", to: "v1" }, { from: "v1", to: "p1" }, { from: "p1", to: "l1" }, { from: "l1", to: "w1" }, { from: "l1", to: "k1", label: "tap" }, { from: "k1", to: "rs1" }, { from: "rs1", to: "x1" },
        { from: "w1", to: "r1" }, { from: "r1", to: "b1" }, { from: "b1", to: "h1" }, { from: "h1", to: "s1" }, { from: "s1", to: "x1" }];
      const def = parseDefinition({ schema: 1, reentry: "always", premise: { check: "contact_exists" }, nodes, edges });
      workflowId = (await one<{ id: string }>(c, "insert into workflows (company_id, name, reentry_policy, enabled, sends_unlocked_at) values ($1,'Slim probe','always',true,now()) returning id", [companyId]))!.id;
      await c.query("insert into workflow_versions (workflow_id, version, definition, manifest, note) values ($1,1,$2,$3,'slim probe')", [workflowId, def, extractManifest(def)]);
    });
    await tickOnce();   // the scheduler's clock is shared with the other suites: one tick so the next is never "recovery"
  });

  it("parks on a pinned wait, a listener that fires and resumes, a reply wait, a reaction wait and a held step, and ends saying everything it gathered; no park stores the person", async () => {
    const id = await asOperator(async (c) => {
      const ev = await emitEvent(c, { company_id: companyId, contact_id: contactId, opportunity_id: null, appointment_id: null, event_type: "lead.created", source: "test", data: { key: "k1", recording_id: recordingId } });
      return (await startRun(c, { companyId, workflowId, triggerNodeId: "t1", event: ev, contactId }))!;
    });
    await tickOnce();
    // the post read the person and the call live; the run kept none of it
    expect(posts.at(-1)).toContain("Dana Slimmer"); expect(posts.at(-1)).toContain(TRANSCRIPT);
    let r = await runRow(id);
    expect(r).toMatchObject({ status: "waiting", current_node: "w1", wake_on_tag: "slim:k1" });
    expectSlim(r.context);
    const vars = r.context.vars as Record<string, any>;
    expect(vars.greeting).toBe("k1-ok"); expect(vars.__listen).toMatchObject({ node: "l1", tag: "slim:k1", into: "vars.seen" });
    const pinned = vars.__wait.w1.until as string; expect(typeof pinned).toBe("string");
    expect(r.context.event).toMatchObject({ key: "k1", recording_id: recordingId });
    expect(r.context.contact).toEqual({ fetched_at: expect.any(String) });
    await asOperator((c) => c.query("update runs set started_at=now()-interval '1 hour' where id=$1", [id]));   // so the reply below lands inside the run

    // the listener: a tap pulls the run to its tap path, and `resume` puts it back on the wait with the same pinned time
    await tap("eyes", "Ana"); await wake(id); await tickOnce();
    r = await runRow(id);
    expect(r).toMatchObject({ status: "waiting", current_node: "w1", resume_node: null });
    expect((r.context.vars as Record<string, any>).__wait.w1.until).toBe(pinned);
    expect((r.context.vars as Record<string, any>).seen).toMatchObject({ reaction: "eyes", user_name: "Ana" });
    expect((r.context.vars as Record<string, any>).__listen).toBeUndefined();
    expectSlim(r.context);

    // the wait is over: on to the reply wait, whose deadline is pinned
    await asOperator((c) => c.query("update runs set next_run_at=now(), context=jsonb_set(context, '{vars,__wait,w1,until}', to_jsonb(now()-interval '1 minute')) where id=$1", [id]));
    await tickOnce();
    r = await runRow(id);
    expect(r).toMatchObject({ status: "waiting", current_node: "r1", wake_on_reply: true });
    const deadline = (r.context.vars as Record<string, any>).__wait_for_reply.r1.deadline;
    expect(typeof deadline).toBe("string");
    expectSlim(r.context);
    await wake(id); await tickOnce();   // nothing yet: the same deadline stands
    expect((await runRow(id)).context.vars).toMatchObject({ __wait_for_reply: { r1: { deadline } } });

    // they reply: on to the blocking reaction wait
    await asOperator((c) => inboundForTest(c, companyId, contactId, "yes please", { id: "M-SLIM", at: new Date(Date.now() - 5 * 60e3) }));
    await wake(id); await tickOnce();
    r = await runRow(id);
    expect(r).toMatchObject({ status: "waiting", current_node: "b1", wake_on_tag: "slim:k1" });
    expect((r.context.reply as Record<string, any>).last_inbound).toMatchObject({ message_id: "M-SLIM" });   // D89: which message, never its words
    expect(JSON.stringify(r.context)).not.toContain("yes please");
    expectSlim(r.context);

    // the team taps ✅ while the CRM is down: the tag step is tried three times, then the run is held on it
    tagDown = true;
    await tap("white_check_mark", "Bo"); await wake(id); await tickOnce();
    r = await runRow(id);
    expect(r).toMatchObject({ status: "waiting", current_node: "h1" });
    expect(r.context.reaction).toMatchObject({ reaction: "white_check_mark", user_name: "Bo" });
    expectSlim(r.context);
    for (let i = 0; i < 4 && !(await runRow(id)).step_held; i++) { await wake(id); await tickOnce(); }
    r = await runRow(id);
    expect(r).toMatchObject({ status: "paused", current_node: "h1", step_held: true });
    expect(r.context.reaction).toMatchObject({ reaction: "white_check_mark", user_name: "Bo" });
    expectSlim(r.context);

    // the CRM is back: the held step passes on its re-check and the run says what it gathered across every park
    tagDown = false; const n = sms.length;
    await wake(id); await tickOnce();
    r = await runRow(id);
    expect(r.status).toBe("completed");
    expect(sms.slice(n)).toEqual(["k1-ok | white_check_mark by Bo | eyes by Ana | yes please | Dana"]);
    expect(Object.keys(r.context).sort()).toEqual(["contact", "event", "reaction", "reply", "vars"]);
  });

  it("persistedContext keeps the run's own keys as they are (nulls too) and only the read stamp of the contact", () => {
    const full = { vars: { a: 1, __listen: { node: "l" } }, reply: { intent: "yes", last_inbound: null }, event: { key: "e" }, reaction: null, now: "x",
      contact: { name: "N", phone: "+1", fetched_at: "2026-10-11T00:00:00Z", stale: undefined }, appointment: { id: "a" }, recording: { transcript_text: "t" }, cards: {}, user: { email: "u@x" } };
    expect(persistedContext(full)).toEqual({ vars: full.vars, reply: full.reply, event: full.event, reaction: null, contact: { fetched_at: "2026-10-11T00:00:00Z" } });
    expect(persistedContext({ vars: {}, contact: { name: "N" } })).toEqual({ vars: {} });
    expect(persistedContext(persistedContext(full))).toEqual(persistedContext(full));
  });

  it("the one-time cleanup: a dry run counts what would change and writes nothing; the real one slims old rows once and leaves slim ones alone", async () => {
    // an older run, saved the way runs used to be: the whole built context
    const ids = await asOperator(async (c) => {
      const out: string[] = [];
      const { row: company, bindings } = await loadCompany(c, companyId);
      for (const key of ["old1", "old2"]) {
        const ev = await emitEvent(c, { company_id: companyId, contact_id: contactId, opportunity_id: null, appointment_id: null, event_type: "lead.created", source: "test", data: { key, recording_id: recordingId } });
        const id = (await startRun(c, { companyId, workflowId, triggerNodeId: "t1", event: ev, contactId }))!;
        const run = (await one<RunRow>(c, "select * from runs where id=$1", [id]))!;
        const fat: Record<string, unknown> = { ...(await buildContext(c, run, company, bindings)), vars: { greeting: `${key}-ok`, __wait: { w1: { until: "2026-10-12T00:00:00.000Z" } } } };
        (fat.contact as Record<string, unknown>).fetched_at = "2026-10-11T00:00:00.000Z";
        (fat.recording as Record<string, unknown>).transcript_text = TRANSCRIPT;   // a row saved before D87 carried the call's transcript too
        await c.query("update runs set status='waiting', current_node='w1', next_run_at=now()+interval '1 day', context=$2 where id=$1", [id, fat]);
        out.push(id);
      }
      return out;
    });
    const before = await asOperator((c) => many<{ id: string; context: Record<string, unknown> }>(c, "select id, context from runs where id = any($1) order by id", [ids]));
    expect(JSON.stringify(before)).toContain(TRANSCRIPT); expect(JSON.stringify(before)).toContain("dana@slim.test");

    const dry = await slimRunContexts({ dryRun: true, companyId, batchSize: 1 });
    expect(dry).toMatchObject({ dryRun: true, changed: 2, scanned: 2, done: true, next: null });
    expect(dry.bytes_after).toBeLessThan(dry.bytes_before);
    expect(await asOperator((c) => many<{ id: string; context: Record<string, unknown> }>(c, "select id, context from runs where id = any($1) order by id", [ids]))).toEqual(before);

    const real = await slimRunContexts({ dryRun: false, companyId, batchSize: 1 });
    expect(real).toMatchObject({ dryRun: false, changed: 2, done: true, bytes_before: dry.bytes_before, bytes_after: dry.bytes_after });
    for (const row of await asOperator((c) => many<{ id: string; context: Record<string, unknown> }>(c, "select id, context from runs where id = any($1) order by id", [ids]))) {
      expectSlim(row.context, true);
      const old = before.find((b) => b.id === row.id)!.context;
      expect(row.context).toEqual({ vars: old.vars, reply: old.reply, event: old.event, contact: { fetched_at: "2026-10-11T00:00:00.000Z" } });
    }
    expect(await slimRunContexts({ dryRun: false, companyId })).toMatchObject({ scanned: 0, changed: 0, done: true });

    // a slimmed run still goes on from where it was parked
    await asOperator((c) => c.query("update runs set next_run_at=now(), context=jsonb_set(context, '{vars,__wait,w1,until}', to_jsonb(now()-interval '1 minute')) where id=$1", [ids[0]]));
    await tickOnce();
    expect(await runRow(ids[0])).toMatchObject({ status: "waiting", current_node: "r1", wake_on_reply: true });
  });
});
