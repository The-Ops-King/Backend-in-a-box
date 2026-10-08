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
import { sweepCompany, type HealthProbes, CHECKS } from "@/engine/health";
import type { Adapters, BookingRead, SlackPersona } from "@/adapters/types";

process.env.BINDINGS_KEY ??= Buffer.alloc(32, 7).toString("base64");
const posts: { channel: string; text: string; as?: SlackPersona; threadTs?: string }[] = [];
const reactions: { channel: string; ts: string; emoji: string }[] = [];
let tagFails = true;
const fake: Adapters = {
  read: { contactsChangedSince: async () => [], inboundSince: async () => [], callMedia: async () => null, contactsAddedBetween: async () => [], callsBetween: async () => [], wonOpportunities: async () => [], objectRecords: async () => [], documents: async () => [], opportunitiesSince: async () => [], getContact: async () => null, listUsers: async () => [] },
  booking: (() => { const b: BookingRead = { appointmentsInWindow: async () => [], getAppointment: async () => null, listCalendars: async () => [] }; return { ghl: b, calendly: b }; })(),
  write: { createContact: async () => ({ id: "x" }), addTag: async () => { if (tagFails) throw new Error("GHL 401 on /contacts/GC1/tags: Invalid Private Integration token"); }, removeTag: async () => {}, addNote: async () => {}, updateAppointment: async () => {}, updateContact: async () => {}, createTask: async () => ({ id: "t" }), createRecord: async () => ({ id: "r" }), updateRecord: async () => {}, relateRecords: async () => {}, createOpportunity: async () => ({ id: "o" }), updateOpportunity: async () => {}, sendDocumentTemplate: async () => ({ id: "d" }) },
  sender: { sendSms: async () => ({ externalId: "s", accepted: true }), sendEmail: async () => ({ externalId: "e", accepted: true }), deliveryStatus: async () => ({ status: "sent" }), sendEmailTemplate: async () => ({ externalId: "t", accepted: true }), smsTemplateBody: async () => null },
  classifier: { choice: async () => ({ value: "confirmed", confidence: 1, distribution: {}, unclear: false }) },
  notifier: { post: async (_t, channel, text, as, threadTs) => { posts.push({ channel, text, as, threadTs }); return { ts: `ts${posts.length}` }; }, lookupUserByEmail: async () => null, react: async (_t, channel, ts, emoji) => { reactions.push({ channel, ts, emoji }); return true; }, authTest: async () => ({ ok: true }), channelInfo: async (_t, id) => (id === "CGONE" ? { ok: false, error: "channel_not_found" } : { ok: true, name: id.toLowerCase(), member: id !== "CNOTIN" }) },
  analyst: { analyze: async () => ({ text: "{}", parsed: {}, model: "fake", usage: { input: 0, output: 0, cacheRead: 0 } }) },
};
const definition = { schema: 1, reentry: "always", premise: { check: "contact_exists" }, nodes: [{ id: "t1", type: "trigger", event: "tag.added" }, { id: "g1", type: "set_tag", tag: ["stat-x"] }, { id: "x1", type: "exit", reason: "done" }], edges: [{ from: "t1", to: "g1" }, { from: "g1", to: "x1" }] };
let companyId: string, contactId: string;
const pollRep = { companies: 1, contacts: 0, appointmentsNew: 0, appointmentsChanged: 0, inbound: 0, calls: 0, agreements: 0, eventsDispatched: 0, baselined: 0, errors: [] as { company: string; entity: string; error: string }[] };
const tickRep = { claimed: 0, completed: 0, waiting: 0, exited: 0, failed: 0, paused: 0, recovery: false, staleExits: 0, sends: 0 };
const fire = () => asOperator(async (c) => dispatchEvent(c, await emitEvent(c, { company_id: companyId, contact_id: contactId, opportunity_id: null, appointment_id: null, event_type: "tag.added", source: "test", data: { tag: "x" } }), { contact: { id: contactId } }));

describe.skipIf(!process.env.DATABASE_URL)("alerts (D33)", () => {
  beforeAll(async () => {
    await migrate();
    await asOperator(async (c) => {
      const co = await one<{ id: string }>(c, "select id from companies where slug='alrt'");
      if (co) { await c.query("delete from run_steps where run_id in (select id from runs where company_id=$1)", [co.id]); await c.query("delete from workflow_versions where workflow_id in (select id from workflows where company_id=$1)", [co.id]);
        for (const t of ["alerts", "health_checks", "sends", "runs", "events", "contact_identifiers", "contacts", "workflow_triggers", "workflows", "slack_connections", "users", "calendars", "company_terms", "bindings", "poll_cursors", "audit_log"]) await c.query(`delete from ${t} where company_id=$1`, [co.id]); await c.query("delete from companies where id=$1", [co.id]); }
      await c.query("delete from alerts where company_id is null"); await c.query("delete from engine_state where key='alerts_cursor'");
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

  it("a failed step is announced the minute it fails, once, with the step and the reason; a second failure stays in the thread; passing later resolves it with a ✅", async () => {
    await fire(); await tick(fake, undefined, companyId);
    let a = await asOperator((c) => tickAlerts(c, fake, pollRep, tickRep));
    expect(a, JSON.stringify({ a, posts })).toMatchObject({ raised: 1, posted: 1, repeated: 0 });
    expect(posts).toHaveLength(1);
    expect(posts[0].channel).toBe("CALERTS"); expect(posts[0].as).toMatchObject({ name: "Engine alerts", icon: ":rotating_light:" });
    expect(posts[0].text).toMatch(/🔴 \*Alert Co · Run failed\*\n"Tag it" failed at step g1 \(Add tag “stat-x”\) for Leo Ortiz: .*Invalid Private Integration token/);
    expect(posts[0].text).toMatch(/\/c\/alrt\/r\//);
    // minutes later it fails again for the same reason: nothing new is said
    await fire(); await tick(fake, undefined, companyId);
    a = await asOperator((c) => tickAlerts(c, fake, pollRep, tickRep));
    expect(a).toMatchObject({ raised: 0, posted: 0, repeated: 0 }); expect(posts).toHaveLength(1);
    // an hour on, still broken: one line in the thread
    await asOperator((c) => c.query("update alerts set announced_at = now() - interval '61 minutes', first_seen = first_seen - interval '61 minutes' where company_id=$1 and resolved_at is null", [companyId]));
    a = await asOperator((c) => tickAlerts(c, fake, pollRep, tickRep));
    expect(a).toMatchObject({ repeated: 1 }); expect(posts).toHaveLength(2); expect(posts[1].threadTs).toBe("ts1"); expect(posts[1].text).toMatch(/Still open after 1h/);
    // fixed: the next run gets past the step → resolved in the thread, ✅ on the first post
    tagFails = false; await fire(); await tick(fake, undefined, companyId);
    a = await asOperator((c) => tickAlerts(c, fake, pollRep, tickRep));
    expect(a).toMatchObject({ resolved: 1 });
    expect(posts).toHaveLength(3); expect(posts[2].threadTs).toBe("ts1"); expect(posts[2].text).toMatch(/^✅ Resolved after 1h/);
    expect(reactions).toEqual([{ channel: "CALERTS", ts: "ts1", emoji: "white_check_mark" }]);
    expect(await asOperator((c) => openAlerts(c, companyId))).toHaveLength(0);
  });

  it("polling that fails twice in a row is an alert; the engine's own recovery notice never gets a 'resolved' post", async () => {
    posts.length = 0;
    const t = new Date();
    await asOperator((c) => c.query("insert into poll_cursors (company_id, entity, cursor, consecutive_failures) values ($1,'contacts','0',2)", [companyId]));
    let a = await asOperator((c) => tickAlerts(c, fake, { ...pollRep, errors: [{ company: "alrt", entity: "contacts", error: "GHL 500" }] }, { ...tickRep, recovery: true, staleExits: 3 }, t));
    expect(a, JSON.stringify({ a, posts })).toMatchObject({ raised: 2, posted: 1 });   // the engine-wide notice has nowhere to go without an operator webhook; the company's poll alert is posted
    expect(posts[0].text).toMatch(/Polling\*\nPolling contacts has failed 2 times in a row: GHL 500/);
    await asOperator((c) => c.query("update poll_cursors set consecutive_failures=0 where company_id=$1", [companyId]));
    a = await asOperator((c) => tickAlerts(c, fake, pollRep, tickRep, new Date(t.getTime() + 60e3)));
    expect(a.resolved).toBe(2);
    expect(posts).toHaveLength(2); expect(posts[1].text).toMatch(/^✅ Resolved/);   // the poll alert closes in its thread; the recovery notice closes quietly
  });

  it("the sweep: a calendar with no free slots and a stage that no longer exists become alerts; the next clean sweep clears them in the thread; its own channel and face are used", async () => {
    posts.length = 0; reactions.length = 0;
    let slotsB = 0;
    const probes: HealthProbes = {
      ghlLocationOk: async () => ({ ok: true, name: "Alert Co" }),
      ghlFreeSlots: async (_p, cal) => ({ ok: true, slots: cal === "CAL2" ? slotsB : 12 }),
      ghlCatalog: async () => ({ users: [], pipelines: [{ id: "PIPE1", name: "Closer", stages: [{ id: "STAGE_OK", name: "Won" }] }], contactFields: [{ id: "FLD1", name: "Setter" }], opportunityFields: [], associations: [], objects: [], errors: [] }),
      calendlyWhoAmI: async () => { throw new Error("not used"); }, calendlyAvailableTimes: async () => ({ ok: true, slots: 1 }),
      whopPing: async () => true, whopGetWebhook: async () => ({ ok: true, found: true, enabled: true }), fathomPing: async () => true, fathomListWebhooks: async () => null, anthropicPing: async () => ({ ok: true }),
    };
    await asOperator((c) => c.query("insert into health_checks (company_id, channel, as_name, as_icon) values ($1,'CHEALTH','Health check',':stethoscope:') on conflict (company_id) do update set channel='CHEALTH', as_name='Health check', as_icon=':stethoscope:'", [companyId]));
    const r = await asOperator((c) => sweepCompany(c, companyId, fake, probes));
    const failing = r.findings.filter((f) => !f.ok);
    expect(failing.map((f) => `${f.check}${f.item ? `:${f.item}` : ""}`).sort()).toEqual(["ghl_calendars:CAL2", "ghl_pipelines:crm.stage_closer_won", "slack:CNOTIN"]);
    expect(failing.find((f) => f.item === "CAL2")!.text).toMatch(/"Closer B" has no bookable slot in the next 7 days/);
    expect(r.findings.filter((f) => f.ok).map((f) => f.check)).toEqual(expect.arrayContaining(["ghl_token", "ghl_calendars", "ghl_fields", "workflows"]));
    expect(CHECKS.map((c) => c.id)).toContain("anthropic");
    const ann = await asOperator((c) => announceDue(c, fake));
    expect(ann.posted).toBe(3);
    expect(posts.every((p) => p.channel === "CHEALTH" && p.as?.name === "Health check" && p.as?.icon === ":stethoscope:")).toBe(true);
    expect(posts.find((p) => /Closer B/.test(p.text))!.text).toMatch(/🟡 \*Alert Co · Health check\*/);
    expect(posts.find((p) => /stage that no longer exists/.test(p.text))!.text).toMatch(/^🔴/);
    // next hour: the calendar is bookable again and the stage was rebound; Slack membership still wrong
    slotsB = 9; await asOperator((c) => c.query("update bindings set value=$2 where company_id=$1 and key='crm.stage_closer_won'", [companyId, Buffer.from("STAGE_OK")]));
    await asOperator((c) => c.query("update alerts set announced_at = now() - interval '61 minutes' where company_id=$1 and resolved_at is null", [companyId]));
    const r2 = await asOperator((c) => sweepCompany(c, companyId, fake, probes));
    expect(r2.resolved).toBe(2); expect(r2.findings.filter((f) => !f.ok).map((f) => f.item)).toEqual(["CNOTIN"]);
    const ann2 = await asOperator((c) => announceDue(c, fake));
    expect(ann2, JSON.stringify({ ann2, posts })).toMatchObject({ resolved: 2, repeated: 1, posted: 0 });
    expect(reactions).toHaveLength(2);
    expect((await asOperator((c) => one<{ last_result: unknown[] }>(c, "select last_result from health_checks where company_id=$1", [companyId])))!.last_result.length).toBeGreaterThan(5);
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
