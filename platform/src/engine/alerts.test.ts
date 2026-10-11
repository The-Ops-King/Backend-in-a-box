/** D33: the engine says what broke the minute it broke, once; repeats in the thread hourly; closes the thread with a ✅ when it clears. The sweep turns a failed probe into the same kind of alert. */
import { describe, it, expect, beforeAll } from "vitest";
import { DateTime } from "luxon";
import { asOperator, one, many } from "@/db/client";
import { migrate } from "@/db/migrate";
import { encrypt } from "@/engine/crypto";
import { parseDefinition, extractManifest, indexDefinition } from "@/engine/definition";
import { emitEvent, dispatchEvent } from "@/engine/dispatch";
import { tick } from "@/engine/runner";
import { tickAlerts, openAlerts, raise, resolve, announceDue } from "@/engine/alerts";
import { type HealthProbes, CHECKS, type Finding } from "@/engine/health";
import { fireNow } from "@/engine/clock";
import { installTemplateForTest, replicaSnapshot } from "@/engine/test-install";
import type { Adapters, BookingRead, SlackPersona } from "@/adapters/types";
import { setBinding } from "@/engine/settings";

process.env.BINDINGS_KEY ??= Buffer.alloc(32, 7).toString("base64");
const posts: { channel: string; text: string; as?: SlackPersona; threadTs?: string }[] = [];
const reactions: { channel: string; ts: string; emoji: string }[] = [];
let tagFails = true;
const fake: Adapters = {
  read: { contactsChangedSince: async () => [], openCards: async () => [], inboundSince: async () => [], callMedia: async () => null, contactsAddedBetween: async () => [], callsBetween: async () => [], wonOpportunities: async () => [], objectRecords: async () => [], documents: async () => [], opportunitiesSince: async () => [], pipelineCards: async () => [], getContact: async (c, id) => replicaSnapshot(c.id, id), listUsers: async () => [] },
  booking: (() => { const b: BookingRead = { appointmentsInWindow: async () => [], getAppointment: async () => null, listCalendars: async () => [] }; return { ghl: b, calendly: b }; })(),
  write: { createContact: async () => ({ id: "x" }), addTag: async () => { if (tagFails) throw new Error("GHL 401 on /contacts/GC1/tags: Invalid Private Integration token"); }, removeTag: async () => {}, addNote: async () => {}, updateAppointment: async () => {}, updateContact: async () => {}, createTask: async () => ({ id: "t" }), createRecord: async () => ({ id: "r" }), updateRecord: async () => {}, relateRecords: async () => {}, createOpportunity: async () => ({ id: "o" }), updateOpportunity: async () => {}, sendDocumentTemplate: async () => ({ id: "d" }) },
  sender: { sendSms: async () => ({ externalId: "s", accepted: true }), sendEmail: async () => ({ externalId: "e", accepted: true }), deliveryStatus: async () => ({ status: "sent" }), sendEmailTemplate: async () => ({ externalId: "t", accepted: true }), smsTemplateBody: async () => null },
  classifier: { choice: async () => ({ value: "confirmed", confidence: 1, distribution: {}, unclear: false }) },
  notifier: { post: async (_t, channel, text, as, threadTs) => { posts.push({ channel, text, as, threadTs }); return { ts: `ts${posts.length}` }; }, lookupUserByEmail: async () => null, react: async (_t, channel, ts, emoji) => { reactions.push({ channel, ts, emoji }); return true; }, unreact: async () => true, authTest: async () => ({ ok: true }), channelInfo: async (_t, id) => (id === "CGONE" ? { ok: false, error: "channel_not_found" } : { ok: true, name: id.toLowerCase(), member: id !== "CNOTIN" }) },
  analyst: { analyze: async () => ({ text: "{}", parsed: {}, model: "fake", usage: { input: 0, output: 0, cacheRead: 0 } }) },
};
const definition = { schema: 1, reentry: "always", premise: { check: "contact_exists" }, nodes: [{ id: "t1", type: "trigger", event: "tag.added" }, { id: "g1", type: "set_tag", tag: ["stat-x"] }, { id: "x1", type: "exit", reason: "done" }], edges: [{ from: "t1", to: "g1" }, { from: "g1", to: "x1" }] };
let companyId: string, contactId: string;
const pollRep = { companies: 1, contacts: 0, appointmentsNew: 0, appointmentsChanged: 0, inbound: 0, calls: 0, agreements: 0, cardsMoved: 0, eventsDispatched: 0, baselined: 0, errors: [] as { company: string; entity: string; error: string }[] };
const tickRep = { claimed: 0, completed: 0, waiting: 0, exited: 0, failed: 0, paused: 0, recovery: false, staleExits: 0, sends: 0 };
const fire = () => asOperator(async (c) => dispatchEvent(c, await emitEvent(c, { company_id: companyId, contact_id: contactId, opportunity_id: null, appointment_id: null, event_type: "tag.added", source: "test", data: { tag: "x" } }), { contact: { id: contactId } }));

describe.skipIf(!process.env.DATABASE_URL)("alerts (D33)", () => {
  beforeAll(async () => {
    await migrate();
    await asOperator(async (c) => {
      const co = await one<{ id: string }>(c, "select id from companies where slug='alrt'");
      if (co) { await c.query("delete from run_steps where run_id in (select id from runs where company_id=$1)", [co.id]); await c.query("delete from workflow_versions where workflow_id in (select id from workflows where company_id=$1)", [co.id]);
        for (const t of ["alerts", "health_checks", "sends", "runs", "events", "appointments", "contact_identifiers", "contacts", "workflow_triggers", "workflows", "slack_connections", "users", "calendars", "company_terms", "bindings", "poll_cursors", "audit_log"]) await c.query(`delete from ${t} where company_id=$1`, [co.id]); await c.query("delete from companies where id=$1", [co.id]); }
      await c.query("delete from alerts where company_id is null");
      await c.query("insert into engine_state (key, value, updated_at) values ('alerts_cursor', $1, now()) on conflict (key) do update set value=$1", [{ since: new Date().toISOString() }]);   // other suites' failed runs are not this test's
      companyId = (await one<{ id: string }>(c, "insert into companies (name, slug, timezone, mode) values ('Alert Co','alrt','America/New_York','live') returning id"))!.id;
      await c.query("insert into company_terms (company_id, domain, name, category, is_default, sort) select $1, domain, label, value, true, sort from core_categories", [companyId]);
      await c.query("insert into bindings (company_id,key,kind,value) values ($1,'crm.location_id','id',$2),($1,'secret.ghl_pit','secret',$3),($1,'alerts.slack_channel','channel',$4),($1,'slack.channel.deals','channel',$5),($1,'crm.pipeline_closer','id',$6),($1,'crm.stage_closer_won','id',$7),($1,'crm.field_contact_setter','id',$8)",
        [companyId, Buffer.from("LOC"), encrypt("p"), Buffer.from("CALERTS"), Buffer.from("CNOTIN"), Buffer.from("PIPE1"), Buffer.from("STAGE_GONE"), Buffer.from("FLD1")]);
      await c.query("insert into slack_connections (company_id, team_id, bot_token, channels) values ($1,'T1',$2,'{}')", [companyId, encrypt("xoxb-fake")]);
      contactId = (await one<{ id: string }>(c, "insert into contacts (company_id, ghl_contact_id, first_name, last_name) values ($1,'GC1','Leo','Ortiz') returning id", [companyId]))!.id;
      const term = (await one<{ id: string }>(c, "select id from company_terms where company_id=$1 and domain='appointment_type' and category='closing'", [companyId]))!.id;
      await c.query("insert into calendars (company_id, external_id, name, appointment_term, active) values ($1,'CAL1','Closer A',$2,true),($1,'CAL2','Closer B',$2,true)", [companyId, term]);
      const def = parseDefinition(definition), manifest = extractManifest(def);
      const wf = (await one<{ id: string }>(c, "insert into workflows (company_id, name, reentry_policy, enabled) values ($1,'Tag it','always',true) returning id", [companyId]))!;
      await c.query("insert into workflow_versions (workflow_id, version, definition, manifest) values ($1,1,$2,$3)", [wf.id, definition, manifest]);
      for (const trig of indexDefinition(def).triggers) await c.query("insert into workflow_triggers (company_id, workflow_id, node_id, event_type, match) values ($1,$2,$3,$4,$5)", [companyId, wf.id, trig.id, trig.event, trig.match ?? {}]);
    });
  });

  it("a dead token pauses the run at once and is announced the minute it happens, once per vendor, with the step and the reason; a second run pauses quietly; an hour on, one line in the thread; a new token wakes the runs, the step passes and the thread closes with a ✅ (D33, D66)", async () => {
    await fire(); const t = await tick(fake, undefined, companyId);
    expect(t).toMatchObject({ paused: 1, failed: 0 });
    let a = await asOperator((c) => tickAlerts(c, fake, pollRep, tickRep, new Date(), companyId));
    // counts are engine-wide and other suites run alongside, so the assertions are on this company's posts and open alerts
    expect(a.posted, JSON.stringify({ a, posts })).toBe(1); expect(a.repeated).toBe(0);
    expect(posts).toHaveLength(1);
    expect(posts[0].channel).toBe("CALERTS"); expect(posts[0].as).toMatchObject({ name: "Engine alerts", icon: ":rotating_light:" });
    expect(posts[0].text).toMatch(/🔴 \*Alert Co · Token rejected\*\nGHL rejected the company's token: runs that reach it pause until the token is replaced in settings\. First seen when Tag it couldn't add the tag “.*” for Leo Ortiz: GHL says invalid Private Integration token\.\n/);
    expect(posts[0].text).toMatch(/\/c\/alrt\/r\//);
    // minutes later a second run hits the same dead token: it pauses too, and nothing new is said
    await fire(); await tick(fake, undefined, companyId);
    a = await asOperator((c) => tickAlerts(c, fake, pollRep, tickRep, new Date(), companyId));
    expect(a.posted).toBe(0); expect(a.repeated).toBe(0); expect(posts).toHaveLength(1);
    expect(await asOperator((c) => openAlerts(c, companyId))).toHaveLength(1);
    expect(await asOperator((c) => many(c, "select 1 from runs where company_id=$1 and status='paused'", [companyId]))).toHaveLength(2);
    // an hour on, still broken: one line in the thread
    await asOperator((c) => c.query("update alerts set announced_at = now() - interval '61 minutes', first_seen = first_seen - interval '61 minutes' where company_id=$1 and resolved_at is null", [companyId]));
    a = await asOperator((c) => tickAlerts(c, fake, pollRep, tickRep, new Date(), companyId));
    expect(a.repeated).toBe(1); expect(posts).toHaveLength(2); expect(posts[1].threadTs).toBe("ts1"); expect(posts[1].text).toMatch(/Still open after 1h/);
    // fixed: a new token in settings wakes both paused runs for one more try of their step; the alert closes in the thread, ✅ on the first post
    tagFails = false; await asOperator((c) => setBinding(c, companyId, "secret.ghl_pit", "secret", "p-new", "test"));
    expect(await asOperator((c) => many(c, "select 1 from runs where company_id=$1 and status='waiting'", [companyId]))).toHaveLength(2);
    await tick(fake, undefined, companyId);
    expect(await asOperator((c) => many(c, "select 1 from runs where company_id=$1 and status='completed'", [companyId]))).toHaveLength(2);
    a = await asOperator((c) => tickAlerts(c, fake, pollRep, tickRep, new Date(), companyId));
    expect(a.closed).toBeGreaterThanOrEqual(1);
    expect(posts).toHaveLength(3); expect(posts[2].threadTs).toBe("ts1"); expect(posts[2].text).toMatch(/^✅ Resolved after 1h/);
    expect(reactions).toEqual([{ channel: "CALERTS", ts: "ts1", emoji: "white_check_mark" }]);
    expect(await asOperator((c) => openAlerts(c, companyId))).toHaveLength(0);
  });

  it("polling that fails twice in a row is an alert; the engine's own recovery notice never gets a 'resolved' post", async () => {
    posts.length = 0;
    const t = new Date();
    await asOperator((c) => c.query("insert into poll_cursors (company_id, entity, cursor, consecutive_failures) values ($1,'contacts','0',2)", [companyId]));
    let a = await asOperator((c) => tickAlerts(c, fake, { ...pollRep, errors: [{ company: "alrt", entity: "contacts", error: "GHL 500" }] }, { ...tickRep, recovery: true, staleExits: 3 }, t, companyId));
    expect(a.posted, JSON.stringify({ a, posts })).toBe(1);   // the engine-wide notice has nowhere to go without an operator webhook; the company's poll alert is posted
    expect((await asOperator((c) => openAlerts(c, companyId))).map((x) => x.key)).toEqual(["poll:contacts"]);
    expect((await asOperator((c) => openAlerts(c, null))).map((x) => x.key)).toEqual(["engine:recovery"]);
    expect(posts[0].text).toMatch(/Polling\*\nPolling contacts has failed 2 times in a row: GHL 500/);
    await asOperator((c) => c.query("update poll_cursors set consecutive_failures=0 where company_id=$1", [companyId]));
    a = await asOperator((c) => tickAlerts(c, fake, pollRep, tickRep, new Date(), companyId));   // real time: a cursor a minute ahead would hide the next test's steps
    expect(a.resolved).toBeGreaterThanOrEqual(2);
    expect(await asOperator((c) => openAlerts(c, companyId))).toHaveLength(0); expect(await asOperator((c) => openAlerts(c, null))).toHaveLength(0);
    expect(posts).toHaveLength(2); expect(posts[1].text).toMatch(/^✅ Resolved/);   // the poll alert closes in its thread; the recovery notice closes quietly
  });

  it("the sweep: a calendar with no free slots and a stage that no longer exists become alerts; the next clean sweep clears them in the thread; its own channel and face are used", async () => {
    posts.length = 0; reactions.length = 0;
    let slotsB = 0;
    const probes: HealthProbes = {
      ghlLocationOk: async () => ({ ok: true, name: "Alert Co" }),
      ghlFreeSlots: async (_p, cal, from) => { const n = cal === "CAL2" ? slotsB : 12; const times = Array.from({ length: n }, (_, i) => new Date(from.getTime() + (i % 7) * 864e5 + (9 + Math.floor(i / 7)) * 36e5).toISOString()); return { ok: true, slots: n, times }; },
      ghlCalendarTeam: async (_p, cal) => ({ ok: true, userIds: [cal === "CAL2" ? "GB" : "GA"] }),
      calendlyEventTypeHosts: async () => { throw new Error("not used"); }, calendlyEventTypeSchedules: async () => { throw new Error("not used"); }, calendlyBusyTimes: async () => { throw new Error("not used"); },
      ghlCatalog: async () => ({ users: [{ id: "GA", name: "Ann Able" }, { id: "GB", name: "Ben Baker" }], pipelines: [{ id: "PIPE1", name: "Closer", stages: [{ id: "STAGE_OK", name: "Won" }] }], contactFields: [{ id: "FLD1", name: "Setter" }], opportunityFields: [], associations: [], objects: [], tags: [], errors: [] }),
      calendlyWhoAmI: async () => { throw new Error("not used"); }, calendlyAvailableTimes: async () => ({ ok: true, slots: 1, times: [] }),
      whopPing: async () => true, whopGetWebhook: async () => ({ ok: true, found: true, enabled: true }), fathomPing: async () => true, fathomListWebhooks: async () => null, anthropicPing: async () => ({ ok: true }), urlOk: async () => ({ ok: true, status: 200 }),
    };
    // the sweep and the availability watch are workflows: this company's copies post as "Health check" in CHEALTH and alert under 10 slots
    const healthWf = await asOperator((c) => installTemplateForTest(c, companyId, "health-check", { patch: (d) => { const n = d.nodes.find((x) => x.type === "health_check"); if (n && n.type === "health_check") { n.channel = "CHEALTH"; n.as = { name: "Health check", icon: ":stethoscope:" }; } } }));
    const availWf = await asOperator((c) => installTemplateForTest(c, companyId, "calendar-availability", { patch: (d) => { const n = d.nodes.find((x) => x.type === "availability_check"); if (n && n.type === "availability_check") n.min_slots = 10; } }));
    // one "sweep" = both workflows fired now and run; what they found is on the health row, raised/resolved on their steps
    const sweep = async () => {
      const at = DateTime.now();
      await asOperator(async (c) => { await fireNow(c, companyId, healthWf, undefined, at); await fireNow(c, companyId, availWf, undefined, at); });
      await tick(fake, at, companyId, probes);
      const steps = await asOperator((c) => many<{ result: { raised: number; resolved: number } }>(c, "select s.result from run_steps s join runs r on r.id=s.run_id where r.company_id=$1 and s.node_type in ('health_check','availability_check') and s.started_at >= $2", [companyId, at.minus({ seconds: 1 }).toJSDate()]));
      const findings = (await asOperator((c) => one<{ last_result: Finding[] }>(c, "select last_result from health_checks where company_id=$1", [companyId])))!.last_result;
      return { findings, raised: steps.reduce((n, x) => n + (x.result.raised ?? 0), 0), resolved: steps.reduce((n, x) => n + (x.result.resolved ?? 0), 0), steps: steps.length };
    };
    const r = await sweep(); expect(r.steps).toBe(2);
    const failing = r.findings.filter((f) => !f.ok);
    expect(failing.map((f) => `${f.check}${f.item ? `:${f.item}` : ""}`).sort()).toEqual(["ghl_calendars:CAL2", "ghl_pipelines:crm.stage_closer_won", "slack:CNOTIN"]);
    expect(failing.find((f) => f.item === "CAL2")!.text).toMatch(/"Closer B" has no bookable slot in the next 7 days/);
    expect(r.findings.filter((f) => f.ok).map((f) => f.check)).toEqual(expect.arrayContaining(["ghl_token", "ghl_calendars", "ghl_fields", "steps", "urls"]));
    expect(CHECKS.map((c) => c.id)).toContain("anthropic");
    const ann = await asOperator((c) => announceDue(c, fake, new Date(), companyId));
    expect(ann.posted).toBe(3);
    expect(posts.every((p) => p.channel === "CHEALTH" && p.as?.name === "Health check" && p.as?.icon === ":stethoscope:")).toBe(true);
    expect(posts.find((p) => /Closer B/.test(p.text))!.text).toMatch(/🟡 \*Alert Co · Health check\*/);
    expect(posts.find((p) => /stage that no longer exists/.test(p.text))!.text).toMatch(/^🔴/);
    // next hour: the calendar is bookable again and the stage was rebound; Slack membership still wrong
    slotsB = 9; await asOperator((c) => c.query("update bindings set value=$2 where company_id=$1 and key='crm.stage_closer_won'", [companyId, Buffer.from("STAGE_OK")]));
    await asOperator((c) => c.query("update alerts set announced_at = now() - interval '61 minutes' where company_id=$1 and resolved_at is null", [companyId]));
    const r2 = await sweep();
    expect(r2.resolved).toBe(2); expect(r2.findings.filter((f) => !f.ok).map((f) => `${f.check}:${f.item}`).sort()).toEqual(["availability:CAL2", "slack:CNOTIN"]);   // 9 slots is bookable, but under the company's threshold of 10
    expect(r2.findings.find((f) => f.check === "availability")!.text).toMatch(/"Closer B" has only 9 bookable slots in the next 7 days \(alert below 10\)/);
    const ann2 = await asOperator((c) => announceDue(c, fake, new Date(), companyId));
    expect(ann2, JSON.stringify({ ann2, posts })).toMatchObject({ resolved: 2, repeated: 1, posted: 1 });   // the low-availability warning is new
    expect(reactions).toHaveLength(2);
    expect((await asOperator((c) => one<{ last_result: unknown[] }>(c, "select last_result from health_checks where company_id=$1", [companyId])))!.last_result.length).toBeGreaterThan(5);
    // the low-availability alert carries a link to the calendar
    const lowPost = posts.find((p) => /has only 9 bookable slots/.test(p.text))!;
    expect(lowPost.text).toMatch(/<https:\/\/api\.leadconnectorhq\.com\/widget\/booking\/CAL2\|Open the calendar>/);
    // and under it, in the thread, the same per-closer table /availability answers with (D72): a day per row, a column per closer, a total row
    const breakdown = posts.find((p) => p.threadTs === `ts${posts.indexOf(lowPost) + 1}` && /next 7 days/.test(p.text))!;
    const bl = breakdown.text.split("\n");
    expect(bl[0]).toMatch(/^\*Open slots, next 7 days: \d+\*  · _from GHL, read just now_$/);
    expect(bl[3]).toMatch(/^Day +Ann Open +Ben Open +Total Open$/); expect(bl.slice(4, 11).every((l) => /^\w{3} \w{3} \d{1,2} +\d+ +\d+ +\d+$/.test(l))).toBe(true);
    expect(bl[11]).toMatch(/^Total +\d+ +\d+ +\d+$/); expect(bl[bl.length - 1]).toMatch(/^_Period: .* read just now \(America\/New_York\)_$/);
    // a booking lands on Closer B: the availability workflow's booking trigger reads that calendar now, not at the next hour; availability moved above the threshold → resolved now
    slotsB = 20;
    const bookedAt = DateTime.now();
    await asOperator(async (c) => {
      const term = (await one<{ id: string }>(c, "select id from company_terms where company_id=$1 and domain='appointment_type' and category='closing'", [companyId]))!.id;
      const appt = (await one<{ id: string }>(c, "insert into appointments (company_id, contact_id, calendar_id, external_id, starts_at, ends_at, booked_at, status, appointment_term) select $1,$2,id,'A-B1',now() + interval '2 days',now() + interval '2 days 45 minutes',now(),'confirmed',$3 from calendars where company_id=$1 and external_id='CAL2' returning id", [companyId, contactId, term]))!.id;
      const ev = await emitEvent(c, { company_id: companyId, contact_id: contactId, opportunity_id: null, appointment_id: appt, event_type: "appointment.booked", source: "test", data: {} });
      expect((await dispatchEvent(c, ev, { contact: { id: contactId }, appointment: { id: appt, term: { category: "closing" } } })).length).toBeGreaterThanOrEqual(1);
    });
    await tick(fake, bookedAt, companyId, probes);
    const bookedStep = await asOperator((c) => one<{ result: { only?: string; raised: number; resolved: number } }>(c, "select s.result from run_steps s join runs r on r.id=s.run_id where r.company_id=$1 and r.appointment_id is not null and s.node_type='availability_check' order by s.started_at desc limit 1", [companyId]));
    expect(bookedStep?.result).toMatchObject({ only: "CAL2", raised: 0, resolved: 1 });
    expect((await asOperator((c) => openAlerts(c, companyId))).filter((x) => x.key.startsWith("health:availability"))).toHaveLength(0);
    const stored = (await asOperator((c) => one<{ last_result: { check: string; item?: string; ok: boolean; href?: string }[] }>(c, "select last_result from health_checks where company_id=$1", [companyId])))!.last_result;
    expect(stored.find((f) => f.check === "availability" && f.item === "CAL2")).toMatchObject({ ok: true, href: "https://api.leadconnectorhq.com/widget/booking/CAL2" });
    // nothing moved since on this company: nothing re-read for it
  });

  it("a step that could not run (Slack channel not bound) is a warning the minute it happens, labelled so, and clears when a later run posts", async () => {
    posts.length = 0;
    const def = { schema: 1, reentry: "always", premise: { check: "contact_exists" }, nodes: [{ id: "t1", type: "trigger", event: "tag.removed" }, { id: "s1", type: "slack_post", channel: "{{slack.channel.nope}}", template: "hi" }, { id: "x1", type: "exit", reason: "done" }], edges: [{ from: "t1", to: "s1" }, { from: "s1", to: "x1" }] };
    const wfId = await asOperator(async (c) => {
      const d = parseDefinition(def), m = extractManifest(d);
      const wf = (await one<{ id: string }>(c, "insert into workflows (company_id, name, reentry_policy, enabled) values ($1,'Say hi','always',true) returning id", [companyId]))!;
      await c.query("insert into workflow_versions (workflow_id, version, definition, manifest) values ($1,1,$2,$3)", [wf.id, def, m]);
      for (const trig of indexDefinition(d).triggers) await c.query("insert into workflow_triggers (company_id, workflow_id, node_id, event_type, match) values ($1,$2,$3,$4,$5)", [companyId, wf.id, trig.id, trig.event, trig.match ?? {}]);
      return wf.id;
    });
    const fireRemove = () => asOperator(async (c) => dispatchEvent(c, await emitEvent(c, { company_id: companyId, contact_id: contactId, opportunity_id: null, appointment_id: null, event_type: "tag.removed", source: "test", data: { tag: "x" } }), { contact: { id: contactId } }));
    await fireRemove(); const t = await tick(fake, undefined, companyId);
    expect(t.failed).toBe(0); expect(t.completed).toBe(1);   // the run completes: the post was skipped, not fatal
    expect((await asOperator((c) => one<{ result: { kind: string } }>(c, "select result from run_steps s join runs r on r.id=s.run_id where r.workflow_id=$1 and s.node_id='s1'", [wfId])))!.result.kind).toBe("blocked");
    const a = await asOperator((c) => tickAlerts(c, fake, pollRep, tickRep, new Date(), companyId));
    expect(a.posted).toBe(1);
    expect(posts.at(-1)!.text).toMatch(/🟡 \*Alert Co · Step could not run\*\nSay hi couldn't post to Slack \(channel nope\) for Leo Ortiz: slack channel not bound\. The run went on without it\./);
    await asOperator((c) => c.query("insert into bindings (company_id,key,kind,value) values ($1,'slack.channel.nope','channel',$2)", [companyId, Buffer.from("CNOPE")]));
    await fireRemove(); await tick(fake, undefined, companyId);
    const a2 = await asOperator((c) => tickAlerts(c, fake, pollRep, tickRep, new Date(), companyId));
    expect(a2.resolved).toBeGreaterThanOrEqual(1); expect(posts.at(-1)!.text).toMatch(/^✅ Resolved/);
    expect((await asOperator((c) => openAlerts(c, companyId))).filter((x) => x.key.startsWith("blocked:"))).toHaveLength(0);
  });

  it("raise/resolve are idempotent per open key", async () => {
    const t = new Date();
    expect((await asOperator((c) => raise(c, { companyId, key: "x:1", level: "warning", source: "engine", text: "a" }, t))).isNew).toBe(true);
    expect((await asOperator((c) => raise(c, { companyId, key: "x:1", level: "warning", source: "engine", text: "b" }, t))).isNew).toBe(false);
    expect(await asOperator((c) => many(c, "select text from alerts where company_id=$1 and key='x:1'", [companyId]))).toEqual([{ text: "b" }]);
    expect(await asOperator((c) => resolve(c, companyId, "x:1", t))).toBe(true);
    expect(await asOperator((c) => resolve(c, companyId, "x:1", t))).toBe(false);
  });
});
