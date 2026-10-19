/** Re-running install upgrades a company's untouched copy of a template whose definition changed; an edited copy is left alone; a stale copy is flagged and skipped, never fatal. */
import { loadCompany } from "@/engine/context";
import { qualifyConfig, salesCallConfig } from "@/engine/ghl-metrics";
import { describe, it, expect, beforeAll } from "vitest";
import { asOperator, one, many } from "@/db/client";
import { migrate } from "@/db/migrate";
import { installCompany, installTemplates } from "@/engine/install";
import { companyReadiness } from "@/engine/readiness";
import { dispatchEvent, emitEvent } from "@/engine/dispatch";
import { templates } from "@/templates";
import { saveCopy } from "@/engine/copy";
import { saveStepEdit } from "@/engine/edits";
import type { Adapters, BookingRead } from "@/adapters/types";

process.env.BINDINGS_KEY ??= Buffer.alloc(32, 7).toString("base64");
const fake: Adapters = {
  read: { contactsChangedSince: async () => [], openCards: async () => [], inboundSince: async () => [], messageBodies: async () => new Map(), callMedia: async () => null, contactsAddedBetween: async () => [], callsBetween: async () => [], wonOpportunities: async () => [], objectRecords: async () => [], documents: async () => [], opportunitiesSince: async () => [], pipelineCards: async () => [], getContact: async () => null, listUsers: async () => [] },
  booking: (() => { const b: BookingRead = { appointmentsInWindow: async () => [], getAppointment: async () => null, listCalendars: async () => [{ id: "CAL", name: "Closer", teamMemberIds: [] }] }; return { ghl: b, calendly: b }; })(),
  write: { createContact: async () => ({ id: "x" }), addTag: async () => {}, removeTag: async () => {}, addNote: async () => {}, updateAppointment: async () => {}, updateContact: async () => {}, createTask: async () => ({ id: "t" }), createRecord: async () => ({ id: "r" }), updateRecord: async () => {}, relateRecords: async () => {}, createOpportunity: async () => ({ id: "o" }), updateOpportunity: async () => {}, sendDocumentTemplate: async () => ({ id: "doc-x" }) },
  sender: { sendSms: async () => ({ externalId: "s", accepted: true }), sendEmail: async () => ({ externalId: "e", accepted: true }), deliveryStatus: async () => ({ status: "sent" }), sendEmailTemplate: async () => ({ externalId: "t", accepted: true }), smsTemplateBody: async () => null },
  classifier: { choice: async () => ({ value: "confirmed", confidence: 1, distribution: {}, unclear: false }) },
  notifier: { post: async () => ({ ts: "1" }), lookupUserByEmail: async () => null, react: async () => true, unreact: async () => true, authTest: async () => ({ ok: true }), channelInfo: async () => ({ ok: true, member: true }) },
  analyst: { analyze: async () => ({ text: "{}", parsed: {}, model: "fake", usage: { input: 0, output: 0, cacheRead: 0 } }) },
};
const base = { name: "Upgrade", slug: "upg", timezone: "America/Phoenix", locationId: "LOC", pit: "pit-fake", calendars: { CAL: "closing" }, templates: ["new-lead", "call-cancelled"], crm: { pipeline_setter: "P", stage_setter_new_lead: "S", field_opportunity_stage_entered: "F", pipeline_closer: "PC", stage_setter_cancelled: "SC", stage_closer_cancelled: "CC", field_contact_appointment_date: "AD" }, enable: true };
let companyId: string;

describe.skipIf(!process.env.DATABASE_URL)("template upgrades on re-install", () => {
  beforeAll(async () => {
    await migrate();
    await asOperator(async (c) => {
      const co = await one<{ id: string }>(c, "select id from companies where slug='upg'");
      if (co) { await c.query("delete from run_steps where run_id in (select id from runs where company_id=$1)", [co.id]); await c.query("delete from workflow_versions where workflow_id in (select id from workflows where company_id=$1)", [co.id]);
        for (const t of ["sends", "runs", "events", "agreements", "recordings", "payments", "pipeline_cards", "appointments", "opportunities", "contact_identifiers", "contacts", "workflow_triggers", "workflows", "users", "calendars", "company_terms", "bindings", "poll_cursors", "audit_log"]) await c.query(`delete from ${t} where company_id=$1`, [co.id]); await c.query("delete from companies where id=$1", [co.id]); }
    });
    companyId = (await installCompany(base, fake)).companyId;
  });

  it("a stored copy on an old node vocabulary is flagged by readiness and skipped by dispatch instead of crashing the poll; re-install upgrades it", async () => {
    const wf = (await asOperator((c) => one<{ id: string; template_id: string }>(c, "select w.id, w.template_id from workflows w join workflow_templates t on t.id=w.template_id where w.company_id=$1 and t.slug='new-lead'", [companyId])))!;
    // what Hair had on 2026-10-07: the first new-lead template, with a node type the engine has since renamed
    const old = JSON.parse(JSON.stringify(templates.find((t) => t.slug === "new-lead")!.definition)) as { nodes: { type: string }[] };
    old.nodes.find((n) => n.type === "pipeline_card")!.type = "create_opportunity";
    await asOperator((c) => c.query("update workflow_versions set definition=$2 where workflow_id=$1 and version=1", [wf.id, old]));
    await asOperator((c) => c.query("update workflows set template_version=0 where id=$1", [wf.id]));
    const r = await asOperator((c) => companyReadiness(c, companyId, "/c/upg"));
    expect(r.issues.some((i) => i.level === "blocker" && /no longer runs/.test(i.text))).toBe(true);
    const ct = await asOperator(async (c) => { const id = (await one<{ id: string }>(c, "insert into contacts (company_id, ghl_contact_id, first_name) values ($1,'GU1','Up') returning id", [companyId]))!.id; await c.query("insert into contact_identifiers (company_id, contact_id, kind, value) values ($1,$2,'phone','+16025550001')", [companyId, id]); return id; });
    const started = await asOperator(async (c) => dispatchEvent(c, await emitEvent(c, { company_id: companyId, contact_id: ct, opportunity_id: null, appointment_id: null, event_type: "lead.created", source: "test", data: {} }), { contact: { id: ct } }));
    expect(started).toEqual([]);   // skipped, not thrown
    expect(await asOperator((c) => one(c, "select 1 from audit_log where company_id=$1 and action='workflow.unparseable' and target_id=$2", [companyId, wf.id]))).toBeTruthy();
    const again = await installCompany(base, fake);
    expect(again.installed.find((s) => s.startsWith("new-lead"))).toMatch(/upgraded v1→v2/);
    expect(again.installed.find((s) => s.startsWith("call-cancelled"))).toMatch(/already installed, current/);
    const w2 = await asOperator((c) => one<{ current_version: number; template_version: number; enabled: boolean }>(c, "select current_version, template_version, enabled from workflows where id=$1", [wf.id]));
    expect(w2).toMatchObject({ current_version: 2, enabled: true });
    expect((await asOperator((c) => companyReadiness(c, companyId, "/c/upg"))).issues.some((i) => /no longer runs/.test(i.text))).toBe(false);
    const started2 = await asOperator(async (c) => dispatchEvent(c, await emitEvent(c, { company_id: companyId, contact_id: ct, opportunity_id: null, appointment_id: null, event_type: "lead.created", source: "test", data: {} }), { contact: { id: ct } }));
    expect(started2).toHaveLength(1);
  });

  it("upgrading a workflow that already has runs keeps their trigger row (no FK failure, same trigger id)", async () => {
    const wf = (await asOperator((c) => one<{ id: string }>(c, "select w.id from workflows w join workflow_templates t on t.id=w.template_id where w.company_id=$1 and t.slug='new-lead'", [companyId])))!;
    const before = await asOperator((c) => one<{ id: string; n: string }>(c, "select t.id, count(r.id)::text as n from workflow_triggers t left join runs r on r.trigger_id=t.id where t.workflow_id=$1 group by t.id", [wf.id]));
    expect(Number(before!.n)).toBeGreaterThan(0);   // the previous test started a run on this trigger
    await asOperator((c) => c.query("update workflows set template_version=0 where id=$1", [wf.id]));   // pretend the template moved on again
    const again = await installCompany(base, fake);
    expect(again.installed.find((s) => s.startsWith("new-lead"))).toMatch(/upgraded/);
    const after = await asOperator((c) => one<{ id: string }>(c, "select id from workflow_triggers where workflow_id=$1", [wf.id]));
    expect(after!.id).toBe(before!.id);
  });

  it("a re-install without a pit keeps the stored token; a new company without one is refused", async () => {
    const { slug: _s, pit: _p, ...rest } = base;
    const again = await installCompany({ ...rest, slug: "upg" }, fake);
    expect(again.companyId).toBe(companyId);
    const stored = await asOperator((c) => one<{ value: Buffer }>(c, "select value from bindings where company_id=$1 and key='secret.ghl_pit'", [companyId]));
    expect((await import("@/engine/crypto")).decrypt(stored!.value)).toBe("pit-fake");
    await expect(installCompany({ ...rest, slug: "upg-nopit" }, fake)).rejects.toThrow(/pit is required/);
  });

  it("the bot's GHL config (D73): the work-situation answers and the Sales Call object are bindings the metrics read back", async () => {
    const { pit: _p, ...rest } = base;
    await installCompany({ ...rest, crm: { ...base.crm, field_contact_work_situation: "WS" }, qualify: { mqlAnswers: ["Employed full-time", " Investor "], dqAnswers: ["Currently between jobs"], unansweredIsMql: false },
      salesCall: { object: "custom_objects.sales_call", outcomes: { showed: "showed", no_show: "noshow", late_cancel: "cancelled" }, dqDispositions: ["dq"] } }, fake);
    const { bindings } = await asOperator((c) => loadCompany(c, companyId));
    expect(qualifyConfig(bindings)).toEqual({ field: "WS", mql: ["Employed full-time", "Investor"], dq: ["Currently between jobs"], unansweredIsMql: false });
    expect(salesCallConfig(bindings)).toEqual({ object: "custom_objects.sales_call", outcomes: { showed: "showed", no_show: "noshow", late_cancel: "cancelled" }, cancelledValue: "late_cancel", dqDispositions: ["dq"], dispositions: { closed_won: { meaning: "closed" }, deposit: { meaning: "deposit" }, follow_up: { meaning: "follow_up" }, lost: { meaning: "lost" }, dq: { meaning: "unqualified" } } });   // D119: the engine writes deposit for a deposit
  });

  it("D88: a template that carries what the engine did by itself comes in ON for a company that already existed, and OFF for a new one", async () => {
    const wipe = (slug: string) => asOperator(async (c) => {
      const co = await one<{ id: string }>(c, "select id from companies where slug=$1", [slug]); if (!co) return;
      await c.query("delete from workflow_versions where workflow_id in (select id from workflows where company_id=$1)", [co.id]);
      for (const t of ["workflow_triggers", "workflows", "users", "calendars", "company_terms", "bindings", "audit_log"]) await c.query(`delete from ${t} where company_id=$1`, [co.id]);
      await c.query("delete from companies where id=$1", [co.id]);
    });
    await wipe("upg-d88"); await wipe("upg-d88-new");
    const { pit: _p, enable: _e, ...rest } = base;
    await installCompany({ ...rest, pit: "pit-fake", slug: "upg-d88", templates: ["new-lead"] }, fake);
    const again = await installCompany({ ...rest, slug: "upg-d88", templates: ["new-lead", "payment-unlinked", "recording-unlinked", "card-moved"].filter((s) => templates.some((t) => t.slug === s)) }, fake);
    expect(again.installed.find((s) => s.startsWith("payment-unlinked"))).toMatch(/enabled \(it carries what the engine did before/);
    expect(again.installed.find((s) => s.startsWith("recording-unlinked"))).toMatch(/enabled/);
    const states = await asOperator((c) => many<{ slug: string; enabled: boolean }>(c, "select t.slug, w.enabled from workflows w join workflow_templates t on t.id=w.template_id join companies co on co.id=w.company_id where co.slug='upg-d88'"));
    expect(Object.fromEntries(states.map((r) => [r.slug, r.enabled]))).toMatchObject({ "new-lead": false, "payment-unlinked": true, "recording-unlinked": true });
    const fresh = await installCompany({ ...rest, pit: "pit-fake", slug: "upg-d88-new", templates: ["payment-unlinked"] }, fake);
    expect(fresh.installed[0]).toMatch(/installed OFF/);
    await wipe("upg-d88"); await wipe("upg-d88-new");
  });

  it("an edited copy is left alone when the template moves on", async () => {
    const wf = (await asOperator((c) => one<{ id: string }>(c, "select w.id from workflows w join workflow_templates t on t.id=w.template_id where w.company_id=$1 and t.slug='call-cancelled'", [companyId])))!;
    await asOperator((c) => c.query("update workflows set diverged=true, diverged_at=now(), template_version=0 where id=$1", [wf.id]));
    const r = await installCompany(base, fake);
    expect(r.installed.find((s) => s.startsWith("call-cancelled"))).toMatch(/edited since install, left alone/);
    expect((await asOperator((c) => one<{ current_version: number }>(c, "select current_version from workflows where id=$1", [wf.id])))!.current_version).toBe(1);
    const versions = await asOperator((c) => many(c, "select 1 from workflow_versions where workflow_id=$1", [wf.id]));
    expect(versions).toHaveLength(1);
  });
});

describe.skipIf(!process.env.DATABASE_URL)("editing copy", () => {
  it("D155: saving a message makes a new version and keeps the words apart; the copy is the offer's own (a template change never reaches it), as is a step edit", async () => {
    const co = (await asOperator((c) => one<{ id: string }>(c, "select id from companies where slug='upg'")))!;
    await installCompany({ ...base, templates: ["speed-to-lead"] }, fake);
    const stl = (await asOperator((c) => one<{ id: string; current_version: number }>(c, "select w.id, w.current_version from workflows w join workflow_templates t on t.id=w.template_id where w.company_id=$1 and t.slug='speed-to-lead'", [co.id])))!;
    const bad = await asOperator((c) => saveCopy(c, { workflowId: stl.id, nodeId: "n1", field: "template", text: "<p>Hi {{lead.name}}</p>" }));
    expect(bad).toMatchObject({ ok: false, why: /unknown placeholder/ });
    const WORDS = "<p>Hey {{contact.first_name}}, grab a time: {{calendar.booking.url}}</p>";
    const ok = await asOperator((c) => saveCopy(c, { workflowId: stl.id, nodeId: "n1", field: "template", text: WORDS }));
    expect(ok).toEqual({ ok: true, version: stl.current_version + 1, layout: "tidy" });
    const row = () => asOperator((c) => one<{ current_version: number; diverged: boolean; template_version: number }>(c, "select current_version, diverged, template_version from workflows where id=$1", [stl.id]));
    expect(await row()).toMatchObject({ current_version: stl.current_version + 1, diverged: true });
    const textNow = async () => (await asOperator((c) => one<{ definition: { nodes: { id: string; template?: string }[] } }>(c, "select v.definition from workflows w join workflow_versions v on v.workflow_id=w.id and v.version=w.current_version where w.id=$1", [stl.id])))!.definition.nodes.find((n) => n.id === "n1")!.template;
    expect(await textNow()).toBe(WORDS);
    expect(JSON.parse((await asOperator((c) => one<{ value: Buffer }>(c, "select value from bindings where company_id=$1 and key='copy.words'", [co.id])))!.value.toString())).toEqual({ "speed-to-lead": { n1: { template: WORDS } } });
    // the template moves on (as if a fix shipped): the offer's copy is left alone, its words with it (CLAUDE.md: never reaches an existing offer)
    await asOperator((c) => c.query("update workflows set template_version=0 where id=$1", [stl.id]));
    const r = await installCompany({ ...base, templates: ["speed-to-lead"] }, fake);
    expect(r.installed[0]).toMatch(/edited since install, left alone/);
    expect(await textNow()).toBe(WORDS);
    expect((await row())!.diverged).toBe(true);
    // a step changed by hand is the company's own: the copy is frozen, and its name still follows the template (D108)
    const smsId = templates.find((t) => t.slug === "speed-to-lead")!.definition.nodes.find((n) => n.type === "send_sms")!.id;
    expect(await asOperator((c) => saveStepEdit(c, { workflowId: stl.id, nodeId: smsId, edit: { type: "send_sms", ghl_template: "snip-1" } }))).toMatchObject({ ok: true });
    expect((await installCompany({ ...base, templates: ["speed-to-lead"] }, fake)).installed[0]).toMatch(/edited since install, left alone/);
    await asOperator((c) => c.query("update workflows set name='An old name' where id=$1", [stl.id]));
    await installCompany({ ...base, templates: ["speed-to-lead"] }, fake);
    expect((await asOperator((c) => one<{ name: string }>(c, "select name from workflows where id=$1", [stl.id])))!.name).toBe(templates.find((t) => t.slug === "speed-to-lead")!.name);
  });

  it("D96: the daily, weekly and monthly wrap-ups take over the one Wrap-ups as it stood (on, its mode), which goes off in the same install; an edited one is left alone and they install off", async () => {
    const wraps = ["daily-wrap-up", "weekly-wrap-up", "monthly-wrap-up"];
    const dropCopies = async (c: import("pg").PoolClient, slugs: string[]) => {
      const sel = "select w.id from workflows w join workflow_templates t on t.id=w.template_id where w.company_id=$1 and t.slug = any($2::text[])";
      for (const t of ["workflow_triggers", "workflow_versions"]) await c.query(`delete from ${t} where workflow_id in (${sel})`, [companyId, slugs]);
      await c.query(`delete from workflows where id in (${sel})`, [companyId, slugs]);
    };
    // the old combined copy, as Hair had it: on, following the company, then pinned to test
    const old = await asOperator(async (c) => {
      await dropCopies(c, [...wraps, "wrap-ups"]);
      const tpl = (await one<{ id: string }>(c, "insert into workflow_templates (slug, name, description, category, stage, sort, origin, definition, manifest, published_at) values ('wrap-ups','Wrap-ups','old','reports','team',30,'spec','{}','{}',now()) on conflict (slug) do update set name=excluded.name returning id"))!.id;
      return (await one<{ id: string }>(c, "insert into workflows (company_id, template_id, template_version, name, reentry_policy, enabled, mode) values ($1,$2,1,'Wrap-ups','always',true,'test') returning id", [companyId, tpl]))!.id;
    });
    const out = await asOperator((c) => installTemplates(c, companyId, wraps, { existed: true }));
    expect(out).toEqual(expect.arrayContaining([expect.stringMatching(/^daily-wrap-up → enabled \(takes over "Wrap-ups", test\)$/), "\"Wrap-ups\" → turned off, replaced by Daily wrap-up, Weekly wrap-up, Monthly wrap-up"]));
    const rows = await asOperator((c) => many<{ slug: string; enabled: boolean; mode: string | null }>(c, "select t.slug, w.enabled, w.mode from workflows w join workflow_templates t on t.id=w.template_id where w.company_id=$1 and t.slug = any($2::text[]) order by t.slug", [companyId, [...wraps, "wrap-ups"]]));
    expect(rows).toEqual([{ slug: "daily-wrap-up", enabled: true, mode: "test" }, { slug: "monthly-wrap-up", enabled: true, mode: "test" }, { slug: "weekly-wrap-up", enabled: true, mode: "test" }, { slug: "wrap-ups", enabled: false, mode: "test" }]);
    expect(await asOperator((c) => one(c, "select 1 from audit_log where company_id=$1 and action='workflow.replaced' and target_id=$2", [companyId, old]))).toBeTruthy();
    // a second run changes nothing: the old one stays off, the new ones are current
    expect(await asOperator((c) => installTemplates(c, companyId, wraps, { existed: true }))).toEqual(wraps.map((s) => `${s} (already installed, current)`));
    // an edited old copy is the company's: it stays on and the new ones install off, so nothing posts twice
    await asOperator(async (c) => {
      await dropCopies(c, wraps);
      await c.query("update workflows set enabled=true, diverged=true where id=$1", [old]);
    });
    const kept = await asOperator((c) => installTemplates(c, companyId, wraps, { existed: true }));
    expect(kept[0]).toBe('daily-wrap-up → installed OFF ("Wrap-ups" was edited and stays as it is; turn it off before turning this on)');
    expect(await asOperator((c) => many<{ enabled: boolean }>(c, "select w.enabled from workflows w join workflow_templates t on t.id=w.template_id where w.company_id=$1 and t.slug = any($2::text[]) order by t.slug", [companyId, [...wraps, "wrap-ups"]]))).toEqual([{ enabled: false }, { enabled: false }, { enabled: false }, { enabled: true }]);
  });

  it("D101: a calendar can be the company's own call type (\"Demo call\") under a core category; made once, the default type untouched", async () => {
    for (let i = 0; i < 2; i++) await installCompany({ ...base, calendars: { CAL: { term: "closing", name: "Demo call" } } }, fake);
    const terms = await asOperator((c) => many<{ name: string; category: string; is_default: boolean }>(c, "select name, category, is_default from company_terms where company_id=$1 and domain='appointment_type' and category='closing' order by is_default desc, name", [companyId]));
    expect(terms.filter((t) => t.name === "Demo call")).toEqual([{ name: "Demo call", category: "closing", is_default: false }]);   // once, however often install runs
    expect(terms.filter((t) => t.is_default)).toHaveLength(1);
    const cal = await asOperator((c) => one<{ name: string }>(c, "select t.name from calendars k join company_terms t on t.id=k.appointment_term where k.company_id=$1 and k.external_id='CAL'", [companyId]));
    expect(cal?.name).toBe("Demo call");
    await installCompany(base, fake);   // back to the plain mapping: the default type again
    expect((await asOperator((c) => one<{ is_default: boolean }>(c, "select t.is_default from calendars k join company_terms t on t.id=k.appointment_term where k.company_id=$1 and k.external_id='CAL'", [companyId])))?.is_default).toBe(true);
  });
});
