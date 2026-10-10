/** Re-running install upgrades a company's untouched copy of a template whose definition changed; an edited copy is left alone; a stale copy is flagged and skipped, never fatal. */
import { loadCompany } from "@/engine/context";
import { qualifyConfig, salesCallConfig } from "@/engine/ghl-metrics";
import { describe, it, expect, beforeAll } from "vitest";
import { asOperator, one, many } from "@/db/client";
import { migrate } from "@/db/migrate";
import { installCompany } from "@/engine/install";
import { companyReadiness } from "@/engine/readiness";
import { dispatchEvent, emitEvent } from "@/engine/dispatch";
import { templates } from "@/templates";
import { saveCopy } from "@/engine/copy";
import type { Adapters, BookingRead } from "@/adapters/types";

process.env.BINDINGS_KEY ??= Buffer.alloc(32, 7).toString("base64");
const fake: Adapters = {
  read: { contactsChangedSince: async () => [], openCards: async () => [], inboundSince: async () => [], callMedia: async () => null, contactsAddedBetween: async () => [], callsBetween: async () => [], wonOpportunities: async () => [], objectRecords: async () => [], documents: async () => [], opportunitiesSince: async () => [], pipelineCards: async () => [], getContact: async () => null, listUsers: async () => [] },
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
    expect(salesCallConfig(bindings)).toEqual({ object: "custom_objects.sales_call", outcomes: { showed: "showed", no_show: "noshow", late_cancel: "cancelled" }, cancelledValue: "late_cancel", dqDispositions: ["dq"] });
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
  it("saving a message makes a new version of the company's copy, marks it edited, refuses unknown placeholders, and the next install leaves it alone", async () => {
    const co = (await asOperator((c) => one<{ id: string }>(c, "select id from companies where slug='upg'")))!;
    const wf = (await asOperator((c) => one<{ id: string; current_version: number }>(c, "select w.id, w.current_version from workflows w join workflow_templates t on t.id=w.template_id where w.company_id=$1 and t.slug='new-lead'", [co.id])))!;
    // new-lead has no message; use the Slack post on call-cancelled? it is diverged already — install speed-to-lead fresh for this
    await installCompany({ ...base, templates: ["speed-to-lead"] }, fake);
    const stl = (await asOperator((c) => one<{ id: string; current_version: number }>(c, "select w.id, w.current_version from workflows w join workflow_templates t on t.id=w.template_id where w.company_id=$1 and t.slug='speed-to-lead'", [co.id])))!;
    const bad = await asOperator((c) => saveCopy(c, { workflowId: stl.id, nodeId: "n1", field: "template", text: "<p>Hi {{lead.name}}</p>" }));
    expect(bad).toMatchObject({ ok: false, why: /unknown placeholder/ });
    const ok = await asOperator((c) => saveCopy(c, { workflowId: stl.id, nodeId: "n1", field: "template", text: "<p>Hey {{contact.first_name}}, grab a time: {{calendar.booking.url}}</p>" }));
    expect(ok).toEqual({ ok: true, version: stl.current_version + 1 });
    const after = await asOperator((c) => one<{ current_version: number; diverged: boolean }>(c, "select current_version, diverged from workflows where id=$1", [stl.id]));
    expect(after).toEqual({ current_version: stl.current_version + 1, diverged: true });
    const def = await asOperator((c) => one<{ definition: { nodes: { id: string; template?: string }[] } }>(c, "select definition from workflow_versions where workflow_id=$1 and version=$2", [stl.id, stl.current_version + 1]));
    expect(def!.definition.nodes.find((n) => n.id === "n1")!.template).toContain("grab a time");
    const r = await installCompany({ ...base, templates: ["speed-to-lead"] }, fake);
    expect(r.installed[0]).toMatch(/edited since install, left alone/);
    expect(wf.id).toBeTruthy();
  });
});
