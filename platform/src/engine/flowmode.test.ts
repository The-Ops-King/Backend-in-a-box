/** D92: a workflow can stand on its own rung (shadow, test, live); null follows the company. The switch-over moves one workflow live while the company stays in test. */
import { describe, it, expect, beforeAll } from "vitest";
import { asOperator, one, many } from "@/db/client";
import { migrate } from "@/db/migrate";
import { installCompany, syncTriggers } from "@/engine/install";
import { saveFromTemplate } from "@/engine/definitions";
import { dispatchEvent, emitEvent } from "@/engine/dispatch";
import { tick } from "@/engine/runner";
import { setWorkflowMode } from "@/engine/golive";
import { dispatchSchedules } from "@/engine/clock";
import { DateTime } from "luxon";
import { handlerMode, workflowMode, type Mode } from "@/engine/mode";
import { harnessRefusal } from "@/engine/simulate";
import { companyReadiness } from "@/engine/readiness";
import { fakeAdapters, freshGhlCheckForTest } from "@/engine/test-install";
import { parseDefinition, extractManifest } from "@/engine/definition";
import { encrypt } from "@/engine/crypto";

process.env.BINDINGS_KEY ??= Buffer.alloc(32, 7).toString("base64");
let companyId: string, newLead: string, speed: string;
const fake = fakeAdapters();
const crmTags: { to: string; tag: string }[] = [], crmCards: string[] = [], sent: { kind: string; to: string }[] = [];
const posts: { channel: string; text: string }[] = [];
fake.notifier.post = async (_t, channel, text) => { posts.push({ channel, text }); return { ts: `${posts.length}.0001` }; };
fake.write.addTag = async (_c, to, tag) => { crmTags.push({ to, tag }); };
fake.write.createOpportunity = async (_c, input) => { crmCards.push(input.contactId); return { id: `ghl-opp-${crmCards.length}` }; };
fake.sender.sendSms = async (_c, to) => { sent.push({ kind: "sms", to }); return { externalId: `s${sent.length}`, accepted: true }; };
fake.sender.sendEmail = async (_c, to) => { sent.push({ kind: "email", to }); return { externalId: `e${sent.length}`, accepted: true }; };
const input = { name: "Flow mode", slug: "flowmode", timezone: "America/Phoenix", locationId: "LOC", pit: "pit-fake", calendars: { CAL: "closing" }, bookingCalendar: "CAL", templates: ["new-lead", "speed-to-lead"], crm: { pipeline_setter: "P", stage_setter_new_lead: "S", field_opportunity_stage_entered: "F" }, testDomains: ["jtylerray.com"], enable: true, mode: "test" as const };
const lead = (ct: string) => asOperator(async (c) => dispatchEvent(c, await emitEvent(c, { company_id: companyId, contact_id: ct, opportunity_id: null, appointment_id: null, event_type: "lead.created", source: "test", data: {} }), { contact: { id: ct } }));
const setCompany = (m: Mode) => asOperator((c) => c.query("update companies set mode=$2 where id=$1", [companyId, m]));
const setFlow = (id: string, m: Mode | null) => asOperator(async (c) => { await freshGhlCheckForTest(c, companyId); return setWorkflowMode(c, id, m, "Tyler", "test"); });
const contact = (ghl: string, email: string, tags: string[] = []) => asOperator(async (c) => {
  const id = (await one<{ id: string }>(c, "insert into contacts (company_id, ghl_contact_id, first_name, tags) values ($1,$2,'Pat',$3) returning id", [companyId, ghl, tags]))!.id;
  await c.query("insert into contact_identifiers (company_id, contact_id, kind, value) values ($1,$2,'phone',$3),($1,$2,'email',$4)", [companyId, id, `+1602555${ghl.slice(-4).padStart(4, "0")}`, email]);
  return id;
});
const runsOf = (ct: string, wf: string) => asOperator((c) => many<{ id: string; status: string; born_in: string }>(c, "select id, status, born_in from runs where contact_id=$1 and workflow_id=$2 order by started_at", [ct, wf]));
const stepOf = (runId: string, type: string) => asOperator((c) => one<{ status: string; result: Record<string, unknown> }>(c, "select status, result from run_steps where run_id=$1 and node_type=$2 order by started_at limit 1", [runId, type]));
const sendsOf = (ct: string) => asOperator((c) => many<{ channel: string; status: string }>(c, "select channel, status from sends where contact_id=$1 and channel in ('sms','email') order by scheduled_for, channel", [ct]));
/** A small workflow of the company's own, for what the templates here do not do (post to Slack, run with no contact). */
const probe = (name: string, event: string, middle: Record<string, unknown>[]) => asOperator(async (c) => {
  const nodes = [{ id: "t1", type: "trigger", event }, ...middle, { id: "x1", type: "exit", reason: "done" }];
  const def = parseDefinition({ schema: 1, reentry: "always", premise: { check: "none" }, nodes, edges: nodes.slice(0, -1).map((n, i) => ({ from: n.id, to: nodes[i + 1].id })) });
  const wf = (await one<{ id: string }>(c, "insert into workflows (company_id, name, reentry_policy, enabled) values ($1,$2,'always',true) returning id", [companyId, name]))!;
  await c.query("insert into workflow_versions (workflow_id, version, definition, manifest, note) values ($1,1,$2,$3,'d92')", [wf.id, def, extractManifest(def)]);
  await syncTriggers(c, companyId, wf.id, def);
  return wf.id;
});

describe.skipIf(!process.env.DATABASE_URL)("live per workflow (D92)", () => {
  beforeAll(async () => {
    await migrate();
    await asOperator(async (c) => {
      const co = await one<{ id: string }>(c, "select id from companies where slug='flowmode'");
      if (co) { await c.query("delete from run_steps where run_id in (select id from runs where company_id=$1)", [co.id]); await c.query("delete from workflow_versions where workflow_id in (select id from workflows where company_id=$1)", [co.id]);
        for (const t of ["sends", "runs", "events", "pipeline_cards", "opportunities", "contact_identifiers", "contacts", "slack_posts", "slack_connections", "workflow_triggers", "workflows", "users", "calendars", "company_terms", "bindings", "poll_cursors", "audit_log"]) await c.query(`delete from ${t} where company_id=$1`, [co.id]); await c.query("delete from companies where id=$1", [co.id]); }
    });
    companyId = (await installCompany(input, fake)).companyId;
    await asOperator((c) => c.query("update companies set send_window_start='00:00', send_window_end='23:59' where id=$1", [companyId]));
    const ids = await asOperator((c) => many<{ id: string; slug: string }>(c, "select w.id, t.slug from workflows w join workflow_templates t on t.id=w.template_id where w.company_id=$1", [companyId]));
    newLead = ids.find((w) => w.slug === "new-lead")!.id; speed = ids.find((w) => w.slug === "speed-to-lead")!.id;
  });

  it("going live is the company's gate narrowed to the workflow: one that posts to Slack is refused without it, one that does not goes live, clears only its own rehearsal runs, and is audited", async () => {
    const before = await contact("F0", "before@gmail.com");
    expect(await lead(before)).toHaveLength(2);
    await tick(fake, undefined, companyId);
    expect((await runsOf(before, newLead)).map((r) => r.born_in)).toEqual(["test"]);

    const refused = await setFlow(speed, "live");
    expect(refused.ok).toBe(false);
    if (!refused.ok) { expect(refused.status).toBe(409); expect(refused.error).toMatch(/Slack is not connected, and Speed to lead posts there/i); }
    expect((await asOperator((c) => workflowMode(c, speed)))).toEqual({ mode: "test", own: null, company: "test" });
    // the company could not go live today (Slack is a company blocker); New lead needs no Slack
    expect((await asOperator((c) => companyReadiness(c, companyId, "/c/flowmode"))).ready).toBe(false);

    const live = await setFlow(newLead, "live");
    expect(live).toMatchObject({ ok: true, changed: true, mode: "live", runs_in: "live", cleared: { runs: 1 } });
    expect(await runsOf(before, newLead)).toEqual([]);   // its rehearsal run is gone, as Go live clears (D51)
    expect(await runsOf(before, speed)).toHaveLength(1);   // the other workflow's is not
    expect(await setFlow(newLead, "live")).toMatchObject({ ok: true, changed: false });

    const audit = await asOperator((c) => many<{ target_id: string; before: Record<string, unknown>; after: Record<string, unknown>; at: Date | null }>(c, "select target_id, before, after, at from audit_log where company_id=$1 and action='workflow.mode' order by id", [companyId]));
    expect(audit).toHaveLength(1);   // the refusal and the no-op wrote nothing
    expect(audit[0]).toMatchObject({ target_id: newLead, before: { mode: null, runs_in: "test" }, after: { mode: "live", runs_in: "live", by: "Tyler", via: "test", cleared: { runs: 1 } } });
    expect(audit[0].at).toBeInstanceOf(Date);
  });

  it("a company in test with New lead live: New lead acts for real for a contact who is not a test contact, while Speed to lead's run for the same contact stays shadow", async () => {
    const real = await contact("F1", "client@gmail.com");
    expect(await lead(real)).toHaveLength(2);
    await tick(fake, undefined, companyId);
    const [nl] = await runsOf(real, newLead), [sp] = await runsOf(real, speed);
    expect([nl.born_in, sp.born_in]).toEqual(["live", "test"]);
    expect(crmTags).toContainEqual({ to: "F1", tag: "stat-new" }); expect(crmCards).toContain("F1");
    expect((await stepOf(nl.id, "set_tag"))?.result.ghost).toBeUndefined();
    // Speed to lead: the would-sends, nothing reached the sender
    expect(await sendsOf(real)).toEqual([{ channel: "email", status: "ghost" }, { channel: "sms", status: "ghost" }]);
    expect(sent.some((s) => s.to === "F1")).toBe(false);
    // the dashboard and the operator route say whose mode it is
    const r = await asOperator((c) => companyReadiness(c, companyId, "/c/flowmode"));
    expect(r.workflows.find((w) => w.id === newLead)).toMatchObject({ mode: "live", runsIn: "live" });
    expect(r.workflows.find((w) => w.id === speed)).toMatchObject({ mode: null, runsIn: "test" });
  });

  it("clearing the workflow's mode puts it back on the company's", async () => {
    const cleared = await setFlow(newLead, null);
    expect(cleared).toMatchObject({ ok: true, changed: true, mode: null, runs_in: "test" });
    expect((cleared as { cleared?: unknown }).cleared).toBeUndefined();   // leaving live clears nothing
    const real = await contact("F2", "other@gmail.com");
    await lead(real); await tick(fake, undefined, companyId);
    const [nl] = await runsOf(real, newLead);
    expect(nl.born_in).toBe("test");
    expect(crmTags.some((t) => t.to === "F2")).toBe(false); expect(crmCards).not.toContain("F2");
    expect((await stepOf(nl.id, "set_tag"))?.result).toMatchObject({ ghost: true, would_tag: ["stat-new", "stat-call-not-booked"] });
    const last = await asOperator((c) => one<{ before: unknown; after: unknown }>(c, "select before, after from audit_log where company_id=$1 and action='workflow.mode' order by id desc limit 1", [companyId]));
    expect(last).toMatchObject({ before: { mode: "live", runs_in: "live" }, after: { mode: null, runs_in: "test", by: "Tyler" } });
  });

  it("a run with no contact follows its workflow's mode: the Slack label and the DM held back until live go by the run, not the company", async () => {
    const james = await asOperator(async (c) => {
      await c.query("insert into slack_connections (company_id, team_id, bot_token, channels) values ($1,'T1',$2,'{}') on conflict do nothing", [companyId, encrypt("xoxb-fake")]);
      await c.query("insert into bindings (company_id,key,kind,value) values ($1,'bot.escalate_to','id',$2) on conflict (company_id,key) do update set value=excluded.value", [companyId, Buffer.from("UOP")]);
      await c.query("insert into users (company_id, email, name, role, ghl_user_id, slack_user_id) values ($1,'tyler@flowmode.test','Tyler Op','staff','GOP','UOP')", [companyId]);
      return (await one<{ id: string }>(c, "insert into users (company_id, email, name, role, ghl_user_id, slack_user_id) values ($1,'james@flowmode.test','James Closer','closer','GJ','UJAMES') returning id", [companyId]))!.id;
    });
    const team = await probe("Day filed", "eod.filed", [{ id: "n1", type: "slack_post", channel: "CTEAM", template: "Day filed by {{user.first_name}}" }, { id: "n2", type: "slack_post", channel: "{{user.slack_user_id}}", template: "Thanks, {{user.first_name}}" }]);
    const filed = async () => { posts.length = 0; await asOperator(async (c) => dispatchEvent(c, await emitEvent(c, { company_id: companyId, contact_id: null, opportunity_id: null, appointment_id: null, event_type: "eod.filed", source: "user", data: { user_id: james } }), { user: { id: james } })); await tick(fake, undefined, companyId); return posts.map((p) => [p.channel, p.text]); };

    // following the company (test): no contact is shadow (D76), the DM goes to the operator
    expect(await filed()).toEqual([["CTEAM", "🧪 *ghost* — Day filed by James"], ["UOP", "🧪 *ghost* — Would have sent to James Closer:\nThanks, James"]]);
    // this workflow live: real, unlabelled, and the DM is James's
    expect(await setFlow(team, "live")).toMatchObject({ ok: true, runs_in: "live" });
    expect(await filed()).toEqual([["CTEAM", "Day filed by James"], ["UJAMES", "Thanks, James"]]);
    expect((await asOperator((c) => one<{ born_in: string }>(c, "select born_in from runs where workflow_id=$1 order by started_at desc limit 1", [team])))?.born_in).toBe("live");
    // a live company with this workflow held in test: shadow again, the DM held back
    await setCompany("live"); await setFlow(team, "test");
    expect(await filed()).toEqual([["CTEAM", "🧪 *ghost* — Day filed by James"], ["UOP", "🧪 *ghost* — Would have sent to James Closer:\nThanks, James"]]);
    await setFlow(team, null);
    expect(await filed()).toEqual([["CTEAM", "Day filed by James"], ["UJAMES", "Thanks, James"]]);
    await setCompany("test");
  });

  it("the 🧪 label follows the run's mode for a contact too: test for a test contact on a test rung, shadow on a shadow rung whatever the company says", async () => {
    const wf = await probe("Lead post", "lead.created", [{ id: "n1", type: "slack_post", channel: "CTEAM", template: "New lead {{contact.first_name}}" }]);
    const mine = await contact("F3", "me@jtylerray.com"), real = await contact("F4", "client2@gmail.com");
    const said = async (ct: string) => { posts.length = 0; await lead(ct); await tick(fake, undefined, companyId); return posts.filter((p) => p.channel === "CTEAM").map((p) => p.text); };
    expect(await said(mine)).toEqual(["🧪 *test* — New lead Pat"]);
    expect(await said(real)).toEqual(["🧪 *ghost* — New lead Pat"]);
    await setFlow(wf, "ghost");
    expect(await said(mine)).toEqual(["🧪 *ghost* — New lead Pat"]);
    await setCompany("ghost"); await setFlow(wf, "test");
    expect(await said(mine)).toEqual(["🧪 *test* — New lead Pat"]);
    await setCompany("test"); await setFlow(wf, null);
  });

  it("D97: the test harness never stages a fact for a real person, in any mode; a test contact is fine, and a live company needs force", async () => {
    const real = await contact("F5", "client3@gmail.com"), mine = await contact("F6", "me6@jtylerray.com");
    const co = { id: companyId, mode: "test" as const };
    expect(await asOperator((c) => harnessRefusal(c, co, real))).toMatch(/^not a test contact/);   // test mode, nothing live: still no (Calvin, Oct 9)
    expect(await asOperator((c) => harnessRefusal(c, { ...co, mode: "ghost" }, real))).toMatch(/^not a test contact/);
    expect(await asOperator((c) => harnessRefusal(c, { ...co, mode: "live" }, real, true))).toMatch(/^not a test contact/);   // force never covers a real person
    await setFlow(newLead, "live");
    expect(await asOperator((c) => harnessRefusal(c, co, mine))).toBeNull();
    expect(await asOperator((c) => harnessRefusal(c, { ...co, mode: "live" }, mine))).toMatch(/^company is live/);
    expect(await asOperator((c) => harnessRefusal(c, { ...co, mode: "live" }, mine, true))).toBeNull();
  });

  it("the engine's hand-off to a workflow goes by that workflow's mode: the least real of those it starts, else the company's", async () => {
    await asOperator(async (c) => {
      expect(await handlerMode(c, companyId, "lead.created")).toBe("test");   // New lead live, Speed to lead and the probes on the company's test
      await c.query("update workflows set enabled=false where company_id=$1 and id<>$2", [companyId, newLead]);
      expect(await handlerMode(c, companyId, "lead.created")).toBe("live");
      expect(await handlerMode(c, companyId, "drift.sales_call_cancelled")).toBe("test");   // nobody starts on it: the company's
      await c.query("update workflows set enabled=true where company_id=$1", [companyId]);
    });
  });

  it("install and a save from the template never change a workflow's mode", async () => {
    await setFlow(speed, "ghost");
    await asOperator((c) => c.query("update workflows set template_version=0 where id=$1", [speed]));   // the template moved on
    const again = await installCompany(input, fake);
    expect(again.installed.find((s) => s.startsWith("speed-to-lead")) ?? "speed-to-lead (not named)").toMatch(/left as it is|not named/);
    await asOperator((c) => saveFromTemplate(c, { workflowId: speed, note: "bring the template", by: "Tyler" }));
    expect(await asOperator((c) => workflowMode(c, speed))).toEqual({ mode: "ghost", own: "ghost", company: "test" });
    expect(await asOperator((c) => workflowMode(c, newLead))).toEqual({ mode: "live", own: "live", company: "test" });
  });

  it("D201: a scheduled report that ran on a lower rung is not run again when its workflow goes up: its period stays run, its run closed out", async () => {
    const report = await probe("Report probe", "schedule", [{ id: "v1", type: "set_var", key: "x", value: "1" }]);
    await asOperator(async (c) => {   // the probe's trigger, scheduled for every day at midnight (so today's period has come)
      const v = (await one<{ definition: { nodes: Record<string, unknown>[] } }>(c, "select definition from workflow_versions where workflow_id=$1 and version=1", [report]))!.definition;
      v.nodes[0].schedule = { at: "00:00", for: "company" };
      const def = parseDefinition(v);
      await c.query("update workflow_versions set definition=$2 where workflow_id=$1 and version=1", [report, def]);
      await syncTriggers(c, companyId, report, def);
      await c.query("update workflows set enabled_at = now() - interval '1 day' where id=$1", [report]);   // D221: on since yesterday, so today's midnight slot is due
    });
    const now = DateTime.now();
    const first = await asOperator((c) => dispatchSchedules(c, now, companyId));
    expect(first.started.filter((s) => s.workflow === "Report probe")).toHaveLength(1);
    await tick(fake, undefined, companyId);
    const ran = await asOperator((c) => one<{ id: string; born_in: string; status: string }>(c, "select id, born_in, status from runs where workflow_id=$1", [report]));
    expect(ran).toMatchObject({ born_in: "test", status: "completed" });
    const up = await setFlow(report, "live");
    expect(up).toMatchObject({ ok: true, cleared: { runs: 0, periods: 1 } });
    // the period counts as run: the clock starts nothing more today
    expect((await asOperator((c) => dispatchSchedules(c, now.plus({ minutes: 1 }), companyId))).started.filter((s) => s.workflow === "Report probe")).toEqual([]);
    expect(await asOperator((c) => one(c, "select status, exit_reason, (select count(*)::int from run_steps s where s.run_id=r.id) as steps from runs r where id=$1", [ran!.id])))
      .toEqual({ status: "completed", exit_reason: "done", steps: 0 });   // it had finished: it keeps how it ended
    // one still going when the workflow goes up is closed out, not left to pick up halfway
    await setFlow(report, null);
    await asOperator((c) => c.query("update runs set status='waiting', exit_reason=null, born_in='test', next_run_at=now() + interval '1 hour', finished_at=null where id=$1", [ran!.id]));
    expect(await setFlow(report, "live")).toMatchObject({ ok: true, cleared: { runs: 0, periods: 1 } });
    expect(await asOperator((c) => one(c, "select status, exit_reason, next_run_at from runs where id=$1", [ran!.id])))
      .toEqual({ status: "exited", exit_reason: "cleared at the move up: its period ran on a lower rung", next_run_at: null });
    // a run that is not a schedule's is still deleted at the move up, as before
    const ct = await contact("D201", "d200@example.com");
    await lead(ct);
    expect((await runsOf(ct, speed)).length).toBeGreaterThan(0);
    await setFlow(speed, "live");
    expect(await runsOf(ct, speed)).toEqual([]);
  });
});
