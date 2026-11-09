/** D137: the operator's record repair never deletes a record GHL or a person made, adopts one it takes over, and keeps knowing its own. */
import { describe, it, expect, beforeAll } from "vitest";
import { asOperator, many } from "@/db/client";
import { migrate } from "@/db/migrate";
import { installCompany } from "@/engine/install";
import { repairRecord } from "@/engine/crm-repair";
import { fakeAdapters } from "@/engine/test-install";
import type { Adapters, ObjectRecord } from "@/adapters/types";

process.env.BINDINGS_KEY ??= Buffer.alloc(32, 7).toString("base64");
const SLUG = `d137-${Date.now()}`, OBJ = "custom_objects.sales_call";
const ghl = new Map<string, ObjectRecord>([["GHL-MADE", { id: "GHL-MADE", createdAt: "2026-10-09T14:17:19Z", properties: { contact_id: "GC", outcome: "" } }], ["OURS", { id: "OURS", createdAt: "2026-10-17T17:32:08Z", properties: { contact_id: "GC", outcome: "no_show" } }], ["LOST", { id: "LOST", createdAt: "2026-10-17T17:00:00Z", properties: {} }]]);
const deleted: string[] = [], updated: { id: string; props: Record<string, unknown> }[] = [];
const base = fakeAdapters();
const fake: Adapters = { ...base, read: { ...base.read, objectRecords: async () => [...ghl.values()] },
  write: { ...base.write, updateRecord: async (_c, _o, id, props) => { updated.push({ id, props }); }, deleteRecord: async (_c, _o, id) => { deleted.push(id); ghl.delete(id); } } };
let co = "";
const rows = () => asOperator((c) => many<{ record_key: string; ghl_record_id: string; adopted: boolean }>(c, "select record_key, ghl_record_id, adopted from crm_records where company_id=$1 order by record_key", [co]));
const repair = (b: Record<string, unknown>) => asOperator((c) => repairRecord(c, fake, { company: SLUG, object: OBJ, why: "test", dryRun: false, record_id: "", ...b }));

describe.skipIf(!process.env.DATABASE_URL)("D137: record repair", () => {
  beforeAll(async () => {
    await migrate();
    co = (await installCompany({ name: "Repair", slug: SLUG, timezone: "America/New_York", locationId: "LOC-D137", pit: "pit-fake", calendars: {}, templates: [] }, fake)).companyId;
    await asOperator((c) => c.query("insert into crm_records (company_id, object_key, record_key, ghl_record_id) values ($1,$2,'SLOT','OURS')", [co, OBJ]));
  });

  it("a dry run changes nothing; fields are set on any record; a record the engine never made is not deleted without force", async () => {
    expect(await repair({ record_id: "GHL-MADE", properties: { outcome: "no_show" }, dryRun: true })).toMatchObject({ ok: true, dryRun: true, record: { id: "GHL-MADE" } });
    expect(updated).toEqual([]);
    expect(await repair({ record_id: "GHL-MADE", properties: { outcome: "no_show" } })).toMatchObject({ ok: true, dryRun: false });
    expect(updated).toEqual([{ id: "GHL-MADE", props: { outcome: "no_show" } }]);
    expect(await repair({ record_id: "GHL-MADE", delete: true })).toMatchObject({ ok: false, status: 409 });
    expect(deleted).toEqual([]);
  });

  it("taking GHL's record for a booking adopts it (never deletable, even forced); the engine's own record it replaces stays known and can still be removed", async () => {
    expect(await repair({ record_id: "GHL-MADE", key: "SLOT" })).toMatchObject({ ok: true });
    expect(await rows()).toEqual([{ record_key: "SLOT", ghl_record_id: "GHL-MADE", adopted: true }, { record_key: "replaced:SLOT:OURS", ghl_record_id: "OURS", adopted: false }]);
    for (const force of [false, true]) expect(await repair({ record_id: "GHL-MADE", delete: true, force })).toMatchObject({ ok: false, status: 409, error: expect.stringMatching(/only took it over/) });
    expect(await repair({ record_id: "OURS", delete: true })).toMatchObject({ ok: true, change: { delete: true, record_key: "replaced:SLOT:OURS" } });
    expect(deleted).toEqual(["OURS"]);
    expect(await rows()).toEqual([{ record_key: "SLOT", ghl_record_id: "GHL-MADE", adopted: true }]);
  });

  it("force removes a record the engine has no row for (the operator's word, logged); every repair is audited", async () => {
    expect(await repair({ record_id: "LOST", delete: true, force: true })).toMatchObject({ ok: true, change: { delete: true, forced: true } });
    expect(deleted).toEqual(["OURS", "LOST"]);
    expect((await asOperator((c) => many(c, "select 1 from audit_log where company_id=$1 and action='crm_record.repair'", [co]))).length).toBe(4);
  });

  it("each value goes as its field's type wants it (money as { currency, value }); a field the object lacks is refused before anything is written; a GHL refusal is an answer, not a crash", async () => {
    const typed: Adapters = { ...fake, read: { ...fake.read, objectFields: async () => [{ key: "outcome", type: "SINGLE_OPTIONS" }, { key: "cash_collected", type: "MONETORY" }] as never } };
    const go = (b: Record<string, unknown>, a = typed) => asOperator((c) => repairRecord(c, a, { company: SLUG, object: OBJ, why: "test", dryRun: false, record_id: "GHL-MADE", ...b }));
    updated.length = 0;
    expect(await go({ properties: { cash_collected: 10000, outcome: "showed" } })).toMatchObject({ ok: true });
    expect(updated).toEqual([{ id: "GHL-MADE", props: { cash_collected: { currency: "default", value: 10000 }, outcome: "showed" } }]);
    expect(await go({ properties: { cash_collected: 1, payment_terms: "PIF" }, dryRun: true })).toEqual({ ok: false, status: 400, error: `${OBJ} has no field payment_terms: nothing was written` });
    const refusing: Adapters = { ...typed, write: { ...typed.write, updateRecord: async () => { throw new Error("ghl 422 bad value"); } } };
    expect(await go({ properties: { outcome: "showed" } }, refusing)).toEqual({ ok: false, status: 502, error: "GHL refused the write: ghl 422 bad value" });
  });

  it("D233: a record the engine should have made is made under its key, kept as the engine's and related; a second under the same key is refused", async () => {
    const made: Array<{ props: Record<string, unknown> }> = [], rel: string[][] = [];
    const typed: Adapters = { ...fake, read: { ...fake.read, objectFields: async () => [{ key: "amount", type: "NUMERICAL" }, { key: "type", type: "SINGLE_OPTIONS" }] as never },
      write: { ...fake.write, createRecord: async (_c, _o, props) => { made.push({ props }); return { id: "NEW-1" }; }, relateRecords: async (_c, a, f, s) => { rel.push([a, f, s]); } } };
    const go = (b: Record<string, unknown>) => asOperator((c) => repairRecord(c, typed, { company: SLUG, object: "custom_objects.cash", why: "test", dryRun: false, record_id: "", ...b }));
    const create = { key: "pay_250", relate: [{ association: "ASSOC-C", first: "GC" }] };
    expect(await go({ create, properties: { amount: 250, type: "deposit" }, dryRun: true })).toMatchObject({ ok: true, dryRun: true });
    expect(made).toEqual([]);
    expect(await go({ create, properties: { amount: 250, type: "deposit" } })).toMatchObject({ ok: true, record: { id: "NEW-1" } });
    expect(made).toEqual([{ props: { amount: 250, type: "deposit" } }]);
    expect(rel).toEqual([["ASSOC-C", "GC", "NEW-1"]]);
    expect(await asOperator((c) => many(c, "select record_key, ghl_record_id from crm_records where company_id=$1 and object_key='custom_objects.cash'", [co]))).toEqual([{ record_key: "pay_250", ghl_record_id: "NEW-1" }]);
    expect(await go({ create, properties: { amount: 250 } })).toMatchObject({ ok: false, status: 409 });
  });
  it("D288: a ghost run's would-be record (a row with no CRM id) does not block the record being made: the row takes the id", async () => {
    const typed: Adapters = { ...fake, read: { ...fake.read, objectFields: async () => [{ key: "outcome", type: "TEXT" }] as never }, write: { ...fake.write, createRecord: async () => ({ id: "NEW-GHOST" }), relateRecords: async () => {} } };
    await asOperator((c) => c.query("insert into crm_records (company_id, object_key, record_key, ghl_record_id) values ($1,'custom_objects.sales_call','slot-ghost',null)", [co]));
    expect(await asOperator((c) => repairRecord(c, typed, { company: SLUG, object: "custom_objects.sales_call", why: "test", dryRun: false, record_id: "", create: { key: "slot-ghost" }, properties: {} }))).toMatchObject({ ok: true, record: { id: "NEW-GHOST" } });
    expect(await asOperator((c) => many(c, "select ghl_record_id from crm_records where company_id=$1 and record_key='slot-ghost'", [co]))).toEqual([{ ghl_record_id: "NEW-GHOST" }]);
  });
});

