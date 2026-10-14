/** D112: each step on the workflow page's chart carries how many runs reached it in the last 7 days, shadow runs too. */
import { describe, it, expect, beforeAll } from "vitest";
import { asOperator, one } from "@/db/client";
import { migrate } from "@/db/migrate";
import { installCompany } from "@/engine/install";
import { fakeAdapters } from "@/engine/test-install";
import { stepCounts, workflowPage, companyBySlug } from "./data";
import { setCrmNamesReader } from "./crm-names-read";
import { UNREAD_MANY } from "./crm-names";
import type { Catalog } from "@/adapters/ghl/catalog";

process.env.BINDINGS_KEY ??= Buffer.alloc(32, 7).toString("base64");
let companyId = "", workflowId = "";

describe.skipIf(!process.env.DATABASE_URL)("run counts per step (D112)", () => {
  let reads = 0;
  const catalog: Catalog = { users: [], pipelines: [{ id: "P", name: "Setter Board", stages: [{ id: "S", name: "Fresh Lead" }] }], contactFields: [], opportunityFields: [{ id: "F", name: "Stage Entered On" }], associations: [], objects: [], tags: [], errors: [] };
  beforeAll(async () => {
    setCrmNamesReader(async () => { reads++; return catalog; });
    await migrate();
    await asOperator(async (c) => {
      const co = await one<{ id: string }>(c, "select id from companies where slug='stepcounts'");
      if (co) { await c.query("delete from run_steps where run_id in (select id from runs where company_id=$1)", [co.id]); await c.query("delete from workflow_versions where workflow_id in (select id from workflows where company_id=$1)", [co.id]);
        for (const t of ["sends", "runs", "events", "contact_identifiers", "contacts", "workflow_triggers", "workflows", "users", "calendars", "company_terms", "bindings", "poll_cursors", "audit_log"]) await c.query(`delete from ${t} where company_id=$1`, [co.id]); await c.query("delete from companies where id=$1", [co.id]); }
    });
    companyId = (await installCompany({ name: "Step counts", slug: "stepcounts", timezone: "America/Phoenix", locationId: "LOC", pit: "pit-fake", calendars: {}, templates: ["new-lead"], crm: { pipeline_setter: "P", stage_setter_new_lead: "S", field_opportunity_stage_entered: "F" }, enable: true }, fakeAdapters())).companyId;
    workflowId = (await asOperator((c) => one<{ id: string }>(c, "select id from workflows where company_id=$1", [companyId])))!.id;
    // runs over eight days: only the eight-day-old one reached Done; one skipped the card step
    await asOperator(async (c) => {
      const run = async (key: string, daysAgo: number, steps: [string, string][], opts: { finished?: boolean; contact?: boolean; born?: string } = {}) => {
        const ct = opts.contact === false ? null : (await one<{ id: string }>(c, "insert into contacts (company_id, first_name) values ($1,$2) returning id", [companyId, key]))!.id;
        const r = (await one<{ id: string }>(c, `insert into runs (company_id, workflow_id, workflow_version, contact_id, status, born_in, context, reentry_key, started_at, finished_at)
          values ($1,$2,1,$3,$4,$5,'{}',$6, now() - make_interval(days => $7), case when $8 then now() - make_interval(days => $7) + interval '1 minute' end) returning id`, [companyId, workflowId, ct, opts.finished === false ? "waiting" : "completed", opts.born ?? "shadow", key, daysAgo, opts.finished !== false]))!.id;
        for (const [node, status] of steps) await c.query("insert into run_steps (run_id, node_id, node_type, status, result, started_at) values ($1,$2,'x',$3,'{}', now() - make_interval(days => $4))", [r, node, status, daysAgo]);
      };
      await run("old", 8, [["t1", "ok"], ["n1", "ok"], ["n2", "ok"], ["n3", "ok"], ["x1", "ok"]]);
      await run("a", 6, [["t1", "ok"], ["n1", "ok"], ["n2", "ok"], ["n3", "ok"]]);
      await run("b", 2, [["t1", "ok"], ["n1", "ok"], ["n2", "skipped"], ["n3", "ok"]], { born: "live" });
      // a run parked on the phone check; it waited, then passed, two rows for one step and one run
      await run("c", 1, [["t1", "ok"], ["n1", "waiting"], ["n1", "ok"]], { finished: false });
      // a company-level run (no contact) counts like any other
      await run("d", 0, [["t1", "ok"]], { contact: false, finished: false });
    });
  });

  it("counts distinct runs per step over the last 7 days only; a run older than that is not counted", async () => {
    const by = await asOperator((c) => stepCounts(c, workflowId, 7));
    expect(by).toEqual({ t1: { went: 4, skipped: 0 }, n1: { went: 3, skipped: 0 }, n2: { went: 2, skipped: 1 }, n3: { went: 2, skipped: 0 } });
    // the eight-day-old run is there for a longer window
    expect((await asOperator((c) => stepCounts(c, workflowId, 10)))).toMatchObject({ n3: { went: 3, skipped: 0 }, x1: { went: 1, skipped: 0 } });
  });

  it("the workflow page's chart carries the counts, and a step nobody reached is 0", async () => {
    const page = await asOperator(async (c) => workflowPage(c, (await companyBySlug(c, "stepcounts"))!, workflowId));
    const chart = page!.chart!;
    expect(chart.counts?.days).toBe(7);
    expect(chart.counts?.by.n2).toEqual({ went: 2, skipped: 1 });
    // Done was reached only eight days ago: no count, which the chart draws as 0 on a node it still draws
    expect(chart.nodes.map((n) => n.id)).toContain("x1");
    expect(chart.counts?.by.x1).toBeUndefined();
    expect(page!.workflow.last_ran).not.toBeNull();
  });

  it("the chart names the board and stage as GHL does, read once for several page loads; unreadable, the key words are marked", async () => {
    const page = () => asOperator(async (c) => workflowPage(c, (await companyBySlug(c, "stepcounts"))!, workflowId));
    setCrmNamesReader(async () => { reads++; return catalog; }); reads = 0;
    const a = await page(); await page();
    expect(reads).toBe(1);
    expect(a!.chart!.nodes.find((n) => n.id === "n2")!.title).toBe("Move the card ‹Setter Board → Fresh Lead›");
    setCrmNamesReader(async () => { throw new Error("401"); });
    const b = await page();
    expect(b!.chart!.nodes.find((n) => n.id === "n2")).toMatchObject({ title: "Move the card ‹Setter → New Lead›", meta: expect.stringContaining(`Setter, New Lead: ${UNREAD_MANY}`) });
    setCrmNamesReader(null);
  });
});
