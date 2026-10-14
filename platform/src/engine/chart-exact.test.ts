/**
 * D111: a workflow is saved only when its page can draw it exactly, the save says which layout it gets, and the daily
 * health sweep holds every enabled workflow to the same check (an alert when none draws it, resolved when one does).
 */
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { DateTime } from "luxon";
import { asOperator, one } from "@/db/client";
import { migrate } from "@/db/migrate";
import { installTemplates } from "./install";
import { saveDefinition } from "./definitions";
import { saveStepEdit } from "./edits";
import { saveCopy } from "./copy";
import { loadCompany } from "./context";
import { runHealthStep, type Finding } from "./health";
import { openAlerts } from "./alerts";
import { encrypt } from "./crypto";
import { fakeAdapters, fakeProbes } from "./test-install";
import { setChartVerdict, definitionLayout } from "@/api/chart-verdict";
import { messy } from "@/chart/messy";
import { templates } from "@/templates";

process.env.BINDINGS_KEY ??= Buffer.alloc(32, 7).toString("base64");
let companyId: string; let wfId: string;
const never = async () => ({ layout: "list" as const, problems: ["step “Tag them” (a) is not drawn"] });
const wfRow = () => asOperator((c) => one<{ id: string; current_version: number }>(c, "select id, current_version from workflows where id=$1", [wfId]));
const sweep = (now: DateTime<true>) => asOperator(async (c) => { const { row } = await loadCompany(c, companyId); return runHealthStep(c, row, fakeAdapters(), fakeProbes, { checks: {}, min_slots: 0, slots_days: 7, channel: "CCHARTS", as_name: "Health check" }, now); });
const charts = (f: Finding[]) => f.filter((x) => x.check === "charts");
const chartAlerts = async () => (await asOperator((c) => openAlerts(c, companyId))).filter((a) => a.key.startsWith("health:charts"));

describe.skipIf(!process.env.DATABASE_URL)("D111: every save and the daily sweep hold the chart to the workflow", () => {
  beforeAll(async () => {
    await migrate();
    await asOperator(async (c) => {
      companyId = (await one<{ id: string }>(c, "insert into companies (name, slug, timezone, status) values ('Chart Co','chartsave','UTC','onboarding') on conflict (slug) do update set status='onboarding' returning id"))!.id;
      for (const t of ["alerts", "health_checks"]) await c.query(`delete from ${t} where company_id=$1`, [companyId]);
      await c.query("delete from runs where company_id=$1", [companyId]);
      await c.query("delete from workflow_triggers where company_id=$1", [companyId]);
      await c.query("delete from workflow_versions where workflow_id in (select id from workflows where company_id=$1)", [companyId]);
      for (const t of ["workflows", "bindings", "audit_log"]) await c.query(`delete from ${t} where company_id=$1`, [companyId]);
      await c.query("insert into bindings (company_id,key,kind,value) values ($1,'crm.location_id','id',$2),($1,'secret.ghl_pit','secret',$3)", [companyId, Buffer.from("LOC"), encrypt("p")]);
      await installTemplates(c, companyId, ["call-cancelled"], { existed: false });
      wfId = (await one<{ id: string }>(c, "select id from workflows where company_id=$1", [companyId]))!.id;
    });
  });
  afterEach(() => setChartVerdict());

  it("a shipped template saves as the tidy chart; a shape beyond it saves and says it is drawn as a plain graph", async () => {
    const tidy = await asOperator((c) => saveDefinition(c, { workflowId: wfId, definition: templates.find((t) => t.slug === "call-cancelled")!.definition, note: "as shipped", dryRun: true }));
    expect(tidy).toMatchObject({ ok: true, layout: "tidy" });
    const r = await asOperator((c) => saveDefinition(c, { workflowId: wfId, definition: messy(), note: "a messy shape" }));
    expect(r).toMatchObject({ ok: true, saved: true, layout: "graph" });
    expect(await definitionLayout(messy())).toEqual({ layout: "graph", problems: [] });
  });

  it("refused (422, with the problems) only when neither layout draws it exactly, and nothing is saved", async () => {
    const before = (await wfRow())!.current_version;
    setChartVerdict(never);
    const def = structuredClone(messy()); def.nodes.find((n) => n.id === "a")!.title = "Tag them";
    const r = await asOperator((c) => saveDefinition(c, { workflowId: wfId, definition: def, note: "cannot be drawn" }));
    expect(r).toMatchObject({ ok: false, status: 422, problems: ["step “Tag them” (a) is not drawn"] });
    expect(!r.ok && r.why).toMatch(/its chart cannot be drawn exactly/);
    expect((await wfRow())!.current_version).toBe(before);
  });

  it("a step edit and a copy edit are held to it too, and say which layout they leave", async () => {
    await asOperator((c) => installTemplates(c, companyId, ["speed-to-lead"], { existed: true }));
    const id = (await asOperator((c) => one<{ id: string }>(c, "select w.id from workflows w join workflow_templates t on t.id=w.template_id where w.company_id=$1 and t.slug='speed-to-lead'", [companyId])))!.id;
    const sms = templates.find((t) => t.slug === "speed-to-lead")!.definition.nodes.find((n) => n.type === "send_sms")!.id;
    expect(await asOperator((c) => saveCopy(c, { workflowId: id, nodeId: sms, field: "template", text: "Hi {{contact.first_name}}, thanks for reaching out." }))).toMatchObject({ ok: true, layout: "tidy" });
    setChartVerdict(never);
    expect(await asOperator((c) => saveCopy(c, { workflowId: id, nodeId: sms, field: "template", text: "Hi again {{contact.first_name}}." }))).toMatchObject({ ok: false, why: expect.stringMatching(/its chart cannot be drawn exactly/) });
    expect(await asOperator((c) => saveStepEdit(c, { workflowId: id, nodeId: sms, edit: { type: "send_sms", ghl_template: "snip-1" } }))).toMatchObject({ ok: false, why: expect.stringMatching(/its chart cannot be drawn exactly/) });
  });

  it("a template no layout draws is not installed", async () => {
    setChartVerdict(never);
    const out = await asOperator((c) => installTemplates(c, companyId, ["payment-failed"], { existed: true }));
    expect(out).toEqual([expect.stringMatching(/^payment-failed → refused: its chart cannot be drawn exactly \(1 problem\)/)]);
    expect(await asOperator((c) => one(c, "select 1 from workflows w join workflow_templates t on t.id=w.template_id where w.company_id=$1 and t.slug='payment-failed'", [companyId]))).toBeFalsy();
  });

  it("the sweep: once a day, sooner when a workflow changed; an alert while none draws it, resolved when one does", async () => {
    await asOperator((c) => c.query("update workflows set enabled=(id=$1) where company_id=$2", [wfId, companyId]));
    const t0 = DateTime.fromISO("2026-10-14T12:00:00Z") as DateTime<true>;
    let r = await sweep(t0);
    expect(charts(r.findings)).toEqual([expect.objectContaining({ ok: true, item: "checked", text: "1 of 1 workflow charts drawn exactly, 1 as a plain graph." })]);
    expect(await chartAlerts()).toEqual([]);

    // the same workflows within the day: not looked at again, the last findings stand
    setChartVerdict(never);
    r = await sweep(t0.plus({ hours: 1 }));
    expect(charts(r.findings).every((f) => f.ok)).toBe(true);

    // a day on: looked at, an alert that posts like every health finding, with the workflow's page
    r = await sweep(t0.plus({ hours: 25 }));
    const bad = charts(r.findings).filter((f) => !f.ok);
    expect(bad).toEqual([expect.objectContaining({ item: wfId, level: "error", page: `/app/c/chartsave/w/${wfId}`, text: expect.stringMatching(/^"[^"]+": its chart cannot be drawn exactly, so its page lists the steps instead: step “Tag them” \(a\) is not drawn\.$/) })]);
    expect((await chartAlerts()).map((a) => a.key)).toEqual([`health:charts:${wfId}`]);
    // the next hours keep it open without looking again
    r = await sweep(t0.plus({ hours: 26 }));
    expect(r.resolved).toBe(0); expect((await chartAlerts()).length).toBe(1);

    // fixed by a save (a new version): the next hour looks again and the alert resolves
    setChartVerdict();
    await asOperator((c) => c.query("update workflows set enabled=false where id=$1", [wfId]));   // call-cancelled needs bindings this company lacks: saved off, turned on again
    const saved = await asOperator((c) => saveDefinition(c, { workflowId: wfId, definition: templates.find((t) => t.slug === "call-cancelled")!.definition, note: "back to the template" }));
    expect(saved).toMatchObject({ ok: true, saved: true, layout: "tidy" });
    await asOperator((c) => c.query("update workflows set enabled=true where id=$1", [wfId]));
    r = await sweep(t0.plus({ hours: 27 }));
    expect(charts(r.findings)).toEqual([expect.objectContaining({ ok: true, text: "1 of 1 workflow charts drawn exactly." })]);
    expect(await chartAlerts()).toEqual([]);
  });
});
