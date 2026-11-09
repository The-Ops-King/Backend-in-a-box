/** D289: a workflow that relies on what another makes does not go live without it; going live clears its ghost runs' would-be records. */
import { describe, it, expect, beforeAll } from "vitest";
import { asOperator, many, one } from "@/db/client";
import { migrate } from "@/db/migrate";
import { installCompany } from "@/engine/install";
import { fakeAdapters } from "@/engine/test-install";
import { clearGhostRecords } from "@/engine/golive";
import { afterOwn, outsideOf, relianceBlockers } from "@/engine/golive-deps";
import { runMode, type Mode } from "@/engine/mode";

process.env.BINDINGS_KEY ??= Buffer.alloc(32, 7).toString("base64");
const HAS_DB = !!process.env.DATABASE_URL;
const SLUG = `d288-${Date.now()}`;
let co = "";
const id = (name: string) => asOperator(async (c) => (await one<{ id: string }>(c, "select id from workflows where company_id=$1 and name=$2", [co, name]))!.id);
const blockersFor = async (name: string, mode: Mode | null) => asOperator(async (c) => {
  const w = await id(name), company = (await one<{ mode: Mode }>(c, "select mode from companies where id=$1", [co]))!.mode;
  return relianceBlockers(c, co, [w], afterOwn(company, w, mode), "/app/c/x");
});

describe("D289: what a provider named outside the engine is", () => {
  it("a JSON list or words with commas, any case", () => {
    expect(outsideOf('["Call booked"]')).toEqual(["call booked"]);
    expect(outsideOf("call-booked, setter-call-logged")).toEqual(["call-booked", "setter-call-logged"]);
    expect(outsideOf("")).toEqual([]);
  });
});

describe.skipIf(!HAS_DB)("D289: going live checks what a workflow relies on", () => {
  beforeAll(async () => {
    await migrate();
    co = (await installCompany({ name: "D289", slug: SLUG, timezone: "America/New_York", locationId: "LOC", pit: "pit-fake", calendars: {}, templates: ["call-booked", "eod-reminder", "call-outcome"], enable: true }, fakeAdapters())).companyId;
    await asOperator(async (c) => { await c.query("update companies set mode='ghost' where id=$1", [co]); await c.query("update workflows set enabled=true where company_id=$1", [co]); });
  }, 180000);

  it("the end of day cannot go live while Call booked, which makes its Sales Calls, runs in ghost; it can once Call booked is live, or once the offer says the Sales Calls are made outside", async () => {
    const eod = (await asOperator((c) => one<{ name: string }>(c, "select w.name from workflows w join workflow_templates t on t.id=w.template_id where w.company_id=$1 and t.slug='eod-reminder'", [co])))!.name;
    const booked = (await asOperator((c) => one<{ name: string }>(c, "select w.name from workflows w join workflow_templates t on t.id=w.template_id where w.company_id=$1 and t.slug='call-booked'", [co])))!.name;
    const refused = await blockersFor(eod, "live");
    expect(refused).toEqual([expect.objectContaining({ level: "blocker", text: expect.stringContaining(`${eod} relies on the Sales Calls the end of day asks about, which ${booked} makes, and it runs in ghost`) })]);
    expect(await blockersFor(eod, "test")).toEqual([]);   // a rehearsal rung relies on nothing
    await asOperator((c) => c.query("insert into bindings (company_id,key,kind,value) values ($1,'golive.outside','text',$2)", [co, Buffer.from(booked)]));
    expect(await blockersFor(eod, "live")).toEqual([]);
    await asOperator((c) => c.query("delete from bindings where company_id=$1 and key='golive.outside'", [co]));
    const bookedId = await id(booked);
    await asOperator((c) => c.query("update workflows set mode='live' where id=$1", [bookedId]));
    expect(await blockersFor(eod, "live")).toEqual([]);
    await asOperator((c) => c.query("update workflows set enabled=false where id=$1", [bookedId]));
    expect((await blockersFor(eod, "live"))[0].text).toContain("and it is off");
    await asOperator((c) => c.query("update workflows set enabled=true, mode=null where id=$1", [bookedId]));
    void runMode;
  });

  it("going up clears the records its ghost runs would have made (no CRM id), of the objects it writes, and nothing else", async () => {
    const booked = (await asOperator((c) => one<{ id: string }>(c, "select w.id from workflows w join workflow_templates t on t.id=w.template_id where w.company_id=$1 and t.slug='call-booked'", [co])))!.id;
    await asOperator((c) => c.query(`insert into crm_records (company_id, object_key, record_key, ghl_record_id) values ($1,'custom_objects.sales_call','ghost-1',null),($1,'custom_objects.sales_call','real-1','GHL-1'),($1,'custom_objects.cash','ghost-cash',null)`, [co]));
    expect(await asOperator((c) => clearGhostRecords(c, co, booked))).toBe(1);
    expect((await asOperator((c) => many<{ record_key: string }>(c, "select record_key from crm_records where company_id=$1 order by record_key", [co]))).map((r) => r.record_key)).toEqual(["ghost-cash", "real-1"]);
  });
});
