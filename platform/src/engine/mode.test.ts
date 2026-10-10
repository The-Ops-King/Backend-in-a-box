/** The mode ladder (D52, addendum 2): in test everyone runs; a sys-test or test-domain contact gets writes and sends for real, anyone else runs as in shadow. */
import { describe, it, expect, beforeAll } from "vitest";
import { DateTime } from "luxon";
import { asOperator, one, many } from "@/db/client";
import { migrate } from "@/db/migrate";
import { installCompany } from "@/engine/install";
import { dispatchEvent, emitEvent } from "@/engine/dispatch";
import { tick } from "@/engine/runner";
import { contactPasses, effectiveMode } from "@/engine/mode";
import { fakeAdapters } from "@/engine/test-install";
import { parseDefinition, extractManifest } from "@/engine/definition";
import { syncTriggers } from "@/engine/install";
import { encrypt } from "@/engine/crypto";

process.env.BINDINGS_KEY ??= Buffer.alloc(32, 7).toString("base64");
let companyId: string;
const fake = fakeAdapters();
const crmTags: { to: string; tag: string }[] = [], crmCards: string[] = [], sent: { kind: string; to: string }[] = [];
const dms: { channel: string; text: string }[] = [];
fake.notifier.post = async (_t, channel, text) => { dms.push({ channel, text }); return { ts: `${dms.length}.0001` }; };
fake.write.addTag = async (_c, to, tag) => { crmTags.push({ to, tag }); };
fake.write.createOpportunity = async (_c, input) => { crmCards.push(input.contactId); return { id: `ghl-opp-${crmCards.length}` }; };
fake.sender.sendSms = async (_c, to) => { sent.push({ kind: "sms", to }); return { externalId: `s${sent.length}`, accepted: true }; };
fake.sender.sendEmail = async (_c, to) => { sent.push({ kind: "email", to }); return { externalId: `e${sent.length}`, accepted: true }; };
const lead = (ct: string) => asOperator(async (c) => dispatchEvent(c, await emitEvent(c, { company_id: companyId, contact_id: ct, opportunity_id: null, appointment_id: null, event_type: "lead.created", source: "test", data: {} }), { contact: { id: ct } }));
const setMode = (m: string) => asOperator((c) => c.query("update companies set mode=$2 where id=$1", [companyId, m]));
const contact = (ghl: string, email: string | null, tags: string[]) => asOperator(async (c) => {
  const id = (await one<{ id: string }>(c, "insert into contacts (company_id, ghl_contact_id, first_name, tags) values ($1,$2,'T',$3) returning id", [companyId, ghl, tags]))!.id;
  await c.query("insert into contact_identifiers (company_id, contact_id, kind, value) values ($1,$2,'phone',$3)", [companyId, id, `+1602555${ghl.slice(-4).padStart(4, "0")}`]);
  if (email) await c.query("insert into contact_identifiers (company_id, contact_id, kind, value) values ($1,$2,'email',$3)", [companyId, id, email]);
  return id;
});
const runsOf = (ct: string) => asOperator((c) => many<{ id: string; workflow: string; status: string; exit_reason: string | null; born_in: string; current_node: string | null }>(c, "select r.id, t.slug as workflow, r.status, r.exit_reason, r.born_in, r.current_node from runs r join workflows w on w.id=r.workflow_id join workflow_templates t on t.id=w.template_id where r.company_id=$1 and r.contact_id=$2 order by r.started_at", [companyId, ct]));
const stepsOf = (runId: string) => asOperator((c) => many<{ node_id: string; node_type: string; status: string; result: Record<string, unknown> }>(c, "select node_id, node_type, status, result from run_steps where run_id=$1 order by started_at, id", [runId]));
const sendsOf = (ct: string) => asOperator((c) => many<{ run_id: string; channel: string; status: string; suppressed_reason: string | null; rendered_body: string }>(c, "select run_id, channel, status, suppressed_reason, rendered_body from sends where company_id=$1 and contact_id=$2 and channel in ('sms','email') order by scheduled_for, channel", [companyId, ct]));
const localTags = async (ct: string) => (await asOperator((c) => one<{ tags: string[] }>(c, "select tags from contacts where id=$1", [ct])))?.tags ?? [];

describe.skipIf(!process.env.DATABASE_URL)("mode ladder", () => {
  beforeAll(async () => {
    await migrate();
    await asOperator(async (c) => {
      const co = await one<{ id: string }>(c, "select id from companies where slug='ladder'");
      if (co) { await c.query("delete from run_steps where run_id in (select id from runs where company_id=$1)", [co.id]); await c.query("delete from workflow_versions where workflow_id in (select id from workflows where company_id=$1)", [co.id]);
        for (const t of ["sends", "runs", "events", "pipeline_cards", "opportunities", "contact_identifiers", "contacts", "slack_posts", "slack_connections", "workflow_triggers", "workflows", "users", "calendars", "company_terms", "bindings", "poll_cursors", "audit_log"]) await c.query(`delete from ${t} where company_id=$1`, [co.id]); await c.query("delete from companies where id=$1", [co.id]); }
    });
    companyId = (await installCompany({ name: "Ladder", slug: "ladder", timezone: "America/Phoenix", locationId: "LOC", pit: "pit-fake", calendars: { CAL: "closing" }, bookingCalendar: "CAL", templates: ["new-lead", "speed-to-lead"], crm: { pipeline_setter: "P", stage_setter_new_lead: "S", field_opportunity_stage_entered: "F" }, testDomains: ["@JTylerRay.com"], enable: true }, fake)).companyId;
    await asOperator((c) => c.query("update companies set send_window_start='00:00', send_window_end='23:59' where id=$1", [companyId]));   // the texts here are about the mode, not the hour
  });

  it("the domain binding is stored lower-case without the @", async () => {
    const v = await asOperator((c) => one<{ value: Buffer }>(c, "select value from bindings where company_id=$1 and key='test.domains'", [companyId]));
    expect(v?.value.toString("utf8")).toBe("jtylerray.com");
  });

  it("test: everyone's run starts, born in test; the tagged and the test-domain contact get it for real, the real contact gets it as in shadow", async () => {
    await setMode("test");
    const tagged = await contact("L1", "someone@gmail.com", ["sys-test"]);
    const domain = await contact("L2", "me@jtylerray.com", []);
    const real = await contact("L3", "client@gmail.com", ["stat-new-ish"]);
    for (const ct of [tagged, domain, real]) expect((await lead(ct)).length).toBe(2);   // new-lead and speed-to-lead, the real contact's too
    await tick(fake, undefined, companyId);
    for (const ct of [tagged, domain, real]) { const runs = await runsOf(ct); expect(runs).toHaveLength(2); expect(runs.every((r) => r.born_in === "test")).toBe(true); }

    // the test contacts: the CRM got the card and the tag, the sender got the email and the text
    for (const [ct, ghl] of [[tagged, "L1"], [domain, "L2"]] as const) {
      expect(crmTags).toContainEqual({ to: ghl, tag: "stat-new" }); expect(crmCards).toContain(ghl);
      expect(sent.filter((s) => s.to === ghl).map((s) => s.kind).sort()).toEqual(["email", "sms"]);
      expect((await sendsOf(ct)).map((s) => s.status)).toEqual(["sent", "sent"]);
      expect(await localTags(ct)).toContain("stat-new");
    }
    // the real contact: the same two runs went the same way, every step a would-have; nothing reached the CRM or the sender
    expect(crmTags.some((t) => t.to === "L3")).toBe(false); expect(crmCards).not.toContain("L3"); expect(sent.some((s) => s.to === "L3")).toBe(false);
    const runs = await runsOf(real); const newLead = runs.find((r) => r.workflow === "new-lead")!, speed = runs.find((r) => r.workflow === "speed-to-lead")!;
    expect(newLead).toMatchObject({ workflow: "new-lead", status: "completed", exit_reason: "done" });
    expect(speed).toMatchObject({ workflow: "speed-to-lead", status: "waiting", current_node: "n3" });   // parked for a reply as live would be
    const steps = await stepsOf(newLead.id);
    expect(steps.find((s) => s.node_type === "set_tag")).toMatchObject({ status: "ok", result: { shadow: true, would_tag: ["stat-new"] } });
    expect(steps.find((s) => s.node_type === "pipeline_card")).toMatchObject({ status: "ok", result: { shadow: true, card: "created" } });
    expect((await sendsOf(real))).toMatchObject([{ status: "shadow", suppressed_reason: null }, { status: "shadow", suppressed_reason: null }]);   // email and text, written down, not delivered
    expect(await localTags(real)).not.toContain("stat-new");   // like shadow: neither the CRM's tags nor our replica of them
    const logged = await asOperator((c) => one<{ data: { shadow?: boolean } }>(c, "select data from events where run_id=$1 and event_type='tag.added'", [newLead.id]));
    expect(logged?.data.shadow).toBe(true);
  });

  it("test: the tag comes off mid-run — the run keeps going, and from its next step behaves as in shadow", async () => {
    const tagged = (await asOperator((c) => one<{ id: string }>(c, "select id from contacts where company_id=$1 and ghl_contact_id='L1'", [companyId])))!.id;
    await asOperator((c) => c.query("update contacts set tags='{}' where id=$1", [tagged]));
    await asOperator((c) => c.query("update runs set next_run_at=now() - interval '1 minute' where company_id=$1 and contact_id=$2 and status='waiting'", [companyId, tagged]));
    const before = sent.filter((s) => s.to === "L1").length;
    await tick(fake, DateTime.now().plus({ hours: 3 }), companyId);   // the 2h reply wait times out → the follow-up email
    const speed = (await runsOf(tagged)).find((r) => r.workflow === "speed-to-lead")!;
    expect(speed).toMatchObject({ status: "completed", exit_reason: "no_reply" });   // not exited at a gate
    const ledger = await sendsOf(tagged);
    expect(ledger.map((s) => s.status)).toEqual(["sent", "sent", "shadow"]);   // the first two went for real while tagged; the follow-up is a would-send
    expect(sent.filter((s) => s.to === "L1").length).toBe(before);
    expect((await stepsOf(speed.id)).find((s) => s.node_id === "n5")).toMatchObject({ status: "ok", result: { shadow: true } });
  });

  it("test: a run born tagged whose tag comes off before its first step runs through as in shadow instead of exiting", async () => {
    const tagged = await contact("L4", "other@gmail.com", ["sys-test"]);
    expect((await lead(tagged)).length).toBe(2);   // started in test, not yet ticked
    await asOperator((c) => c.query("update contacts set tags='{}' where id=$1", [tagged]));   // the tag comes off before the first step
    await tick(fake, undefined, companyId);
    const runs = await runsOf(tagged);
    expect(runs.map((r) => r.born_in)).toEqual(["test", "test"]);
    expect(runs.find((r) => r.workflow === "new-lead")).toMatchObject({ status: "completed", exit_reason: "done" });
    expect((await stepsOf(runs.find((r) => r.workflow === "new-lead")!.id)).find((s) => s.node_type === "set_tag")).toMatchObject({ result: { shadow: true, would_tag: ["stat-new"] } });
    expect((await sendsOf(tagged)).map((s) => s.status)).toEqual(["shadow", "shadow"]);
    expect(crmTags.some((t) => t.to === "L4")).toBe(false); expect(sent.some((s) => s.to === "L4")).toBe(false);
    expect(await asOperator((c) => contactPasses(c, companyId, tagged, "test", { "test.domains": "jtylerray.com" }))).toMatchObject({ ok: false });
  });

  it("live and shadow: everyone passes; the effective mode is shadow only in shadow or for a non-test contact in test", async () => {
    const nobody = "00000000-0000-0000-0000-000000000000";
    for (const m of ["shadow", "live"] as const) expect(await asOperator((c) => contactPasses(c, companyId, nobody, m, {}))).toEqual({ ok: true });
    const real = (await asOperator((c) => one<{ id: string }>(c, "select id from contacts where company_id=$1 and ghl_contact_id='L3'", [companyId])))!.id;
    const domain = (await asOperator((c) => one<{ id: string }>(c, "select id from contacts where company_id=$1 and ghl_contact_id='L2'", [companyId])))!.id;
    const b = { "test.domains": "jtylerray.com" };
    await asOperator(async (c) => {
      expect(await effectiveMode(c, companyId, real, "shadow", b)).toBe("shadow"); expect(await effectiveMode(c, companyId, null, "shadow", b)).toBe("shadow");
      expect(await effectiveMode(c, companyId, real, "live", b)).toBe("real");
      expect(await effectiveMode(c, companyId, real, "test", b)).toBe("shadow"); expect(await effectiveMode(c, companyId, domain, "test", b)).toBe("real");
      expect(await effectiveMode(c, companyId, null, "test", b)).toBe("shadow");   // D76: a team-facing run (end of day, wrap-ups) reaches nobody until live
      expect(await effectiveMode(c, companyId, null, "live", b)).toBe("real");
    });
  });
  it("D76: until live a DM to a team member reaches the ops channel (else the operator) instead, marked who it was for; a run with no contact (the end-of-day reminder) is no exception; the operator's own DM about a test contact goes as is; live delivers it", async () => {
    await setMode("test");
    const probe = async (name: string, event: string, middle: Record<string, unknown>[]) => asOperator(async (c) => {
      const nodes = [{ id: "t1", type: "trigger", event }, ...middle, { id: "x1", type: "exit", reason: "done" }];
      const def = parseDefinition({ schema: 1, reentry: "always", premise: { check: "none" }, nodes, edges: nodes.slice(0, -1).map((n, i) => ({ from: n.id, to: nodes[i + 1].id })) });
      const wf = (await one<{ id: string }>(c, "insert into workflows (company_id, name, reentry_policy, enabled) values ($1,$2,'always',true) returning id", [companyId, name]))!;
      await c.query("insert into workflow_versions (workflow_id, version, definition, manifest, note) values ($1,1,$2,$3,'d76')", [wf.id, def, extractManifest(def)]);
      await syncTriggers(c, companyId, wf.id, def);
    });
    const james = await asOperator(async (c) => {
      await c.query("insert into slack_connections (company_id, team_id, bot_token, channels) values ($1,'T1',$2,'{}') on conflict do nothing", [companyId, encrypt("xoxb-fake")]);
      await c.query("insert into bindings (company_id,key,kind,value) values ($1,'bot.escalate_to','id',$2) on conflict (company_id,key) do update set value=excluded.value", [companyId, Buffer.from("UOP")]);
      await c.query("insert into users (company_id, email, name, role, ghl_user_id, slack_user_id) values ($1,'tyler@ladder.test','Tyler Op','staff','GOP','UOP')", [companyId]);
      return (await one<{ id: string }>(c, "insert into users (company_id, email, name, role, ghl_user_id, slack_user_id) values ($1,'james@ladder.test','James Closer','closer','GJ','UJAMES') returning id", [companyId]))!.id;
    });
    await probe("DM the closer", "eod.filed", [{ id: "n1", type: "slack_post", channel: "{{user.slack_user_id}}", template: "Your end of day, {{user.first_name}}" }]);
    await probe("DM the owner", "lead.created", [{ id: "n1", type: "notify_owner", template: "Look at {{contact.name}}" }, { id: "n2", type: "slack_post", channel: "UOP", template: "Operator: {{contact.name}}" }]);
    const filed = () => asOperator(async (c) => dispatchEvent(c, await emitEvent(c, { company_id: companyId, contact_id: null, opportunity_id: null, appointment_id: null, event_type: "eod.filed", source: "user", data: { user_id: james } }), { user: { id: james } }));
    const owned = async (ghl: string, email: string, tags: string[]) => { const id = await contact(ghl, email, tags); await asOperator((c) => c.query("update contacts set assigned_ghl_user_id='GJ', first_name='Pat' where id=$1", [id])); return id; };

    dms.length = 0;
    await filed(); await lead(await owned("D1", "real@gmail.com", [])); await lead(await owned("D2", "me2@jtylerray.com", []));
    await tick(fake, undefined, companyId);
    expect(dms.filter((m) => m.channel === "UJAMES")).toEqual([]);   // nothing reaches James before live
    const toOp = dms.filter((m) => m.channel === "UOP").map((m) => m.text.replace(/^🧪 \*\w+\* — /, ""));
    expect(toOp.filter((t) => t.startsWith("Would have sent to James Closer:\n"))).toHaveLength(3);   // the reminder-like DM, and the owner DM for each contact
    expect(toOp).toContain("Operator: Pat");   // the operator's own DM about the test contact goes as is
    expect(toOp).toContain("Would have sent to Tyler Op:\nOperator: Pat");   // about a real contact it is marked, as everything else is
    // live: the DM is the closer's
    dms.length = 0; await setMode("live");
    await filed(); await tick(fake, undefined, companyId);
    expect(dms.map((m) => [m.channel, m.text])).toEqual([["UJAMES", "Your end of day, James"]]);
    // the company's ops channel, when bound, is where held-back DMs go (the operator's DM is the fallback)
    await setMode("test"); await asOperator((c) => c.query("insert into bindings (company_id,key,kind,value) values ($1,'slack.channel.ops','channel',$2)", [companyId, Buffer.from("COPS")]));
    dms.length = 0; await filed(); await tick(fake, undefined, companyId);
    expect(dms.map((m) => [m.channel, m.text.replace(/^🧪 \*\w+\* — /, "")])).toEqual([["COPS", "Would have sent to James Closer:\nYour end of day, James"]]);
    // neither bound: held back, written down, posted nowhere
    await asOperator((c) => c.query("delete from bindings where company_id=$1 and key in ('bot.escalate_to','slack.channel.ops')", [companyId]));
    dms.length = 0; await filed(); await tick(fake, undefined, companyId);
    expect(dms).toEqual([]);
  });
});
