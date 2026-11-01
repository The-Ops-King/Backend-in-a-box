/** D296: every record the engine writes to the CRM is read straight back: a write that did not land as written is an engine fault, raised at once. */
import { describe, it, expect, beforeAll } from "vitest";
import { asOperator, many, one } from "@/db/client";
import { migrate } from "@/db/migrate";
import { installCompany, syncTriggers } from "@/engine/install";
import { emitEvent, dispatchEvent } from "@/engine/dispatch";
import { parseDefinition, extractManifest } from "@/engine/definition";
import { fakeAdapters } from "@/engine/test-install";
import { tick } from "@/engine/runner";
import type { Adapters, ObjectRecord } from "@/adapters/types";

process.env.BINDINGS_KEY ??= Buffer.alloc(32, 7).toString("base64");
const SLUG = `d296-${Date.now()}`;
let co = "";
const store = new Map<string, { object: string; properties: Record<string, unknown> }>();
let landIn: string | null = null;   // the object a write really lands in (null: where it was meant)
const base = fakeAdapters();
const fake: Adapters = { ...base,
  read: { ...base.read, objectFields: async () => [{ key: "external_id", type: "TEXT" }, { key: "outcome", type: "SINGLE_OPTIONS" }],
    objectRecord: async (_c, object, id) => { const r = store.get(id); return r && r.object === object ? ({ id, createdAt: new Date().toISOString(), properties: r.properties, owners: [] } as ObjectRecord & { owners: string[] }) : null; } },
  write: { ...base.write, createRecord: async (_c, object, properties) => { const id = `R${store.size + 1}`; store.set(id, { object: landIn ?? object, properties: { ...properties } }); return { id }; },
    updateRecord: async (_c, _o, id, properties) => { const r = store.get(id); if (r) Object.assign(r.properties, properties); } } };

describe.skipIf(!process.env.DATABASE_URL)("D296: a write to the CRM is read back", () => {
  beforeAll(async () => {
    await migrate();
    co = (await installCompany({ name: "Readback", slug: SLUG, timezone: "UTC", locationId: "LOC-D296", pit: "pit-fake", calendars: {}, templates: [] }, fake)).companyId;
    await asOperator(async (c) => {
      await c.query("update companies set mode='live' where id=$1", [co]);
      const nodes = [{ id: "t1", type: "trigger", event: "lead.created" }, { id: "r1", type: "crm_record", object: "custom_objects.sales_call", key: "{{event.k}}", if_missing: "create", properties: { external_id: "{{event.k}}", outcome: "{{event.outcome}}" } }, { id: "x1", type: "exit", reason: "done" }];
      const def = parseDefinition({ schema: 1, reentry: "always", premise: { check: "none" }, nodes, edges: [{ from: "t1", to: "r1" }, { from: "r1", to: "x1" }] });
      const wf = (await one<{ id: string }>(c, "insert into workflows (company_id, name, reentry_policy, enabled, mode) values ($1,'Writes a record','always',true,'live') returning id", [co]))!;
      await c.query("insert into workflow_versions (workflow_id, version, definition, manifest) values ($1,1,$2,$3)", [wf.id, def, extractManifest(def)]);
      await syncTriggers(c, co, wf.id, def);
    });
  });
  const fire = async (k: string) => { await asOperator(async (c) => dispatchEvent(c, await emitEvent(c, { company_id: co, contact_id: null, opportunity_id: null, appointment_id: null, event_type: "lead.created", source: "engine", data: { k, outcome: "scheduled" } }))); await tick(fake, undefined, co); };
  const step = (k: string) => asOperator((c) => one<{ result: Record<string, unknown> }>(c, "select s.result from run_steps s join runs r on r.id=s.run_id where r.company_id=$1 and s.node_id='r1' and r.context->'event'->>'k'=$2 order by s.started_at desc limit 1", [co, k]));
  const alert = () => asOperator((c) => one<{ text: string; resolved_at: Date | null }>(c, "select text, resolved_at from alerts where company_id=$1 and key like 'readback:%' order by last_seen desc limit 1", [co]));

  it("landed as written: verified, nothing raised; landed in another object: an engine fault at once, the run going on; the next good write clears it", async () => {
    await fire("A");
    expect((await step("A"))!.result).toMatchObject({ verified: true, record: "created" });
    expect(await alert()).toBeFalsy();
    landIn = "custom_objects.discovery_call";
    await fire("B");
    expect((await step("B"))!.result).toMatchObject({ verified: false, verify_failed: [expect.stringMatching(/GHL has no record R2 in custom_objects.sales_call/)] });
    expect(await alert()).toMatchObject({ resolved_at: null, text: expect.stringMatching(/did not land as written.*engine fault/) });
    expect(await asOperator((c) => many(c, "select 1 from runs where company_id=$1 and status='completed'", [co]))).toHaveLength(2);
    landIn = null;
    await fire("C");
    expect((await alert())!.resolved_at).not.toBeNull();
  });
});
