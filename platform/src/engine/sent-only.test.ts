/** D328: a step that records a send runs only when the send went out: held back by the mode, no "agreement sent". */
import { describe, it, expect, beforeAll } from "vitest";
import { asOperator, many, one } from "@/db/client";
import { migrate } from "@/db/migrate";
import { parseDefinition, extractManifest } from "./definition";
import { syncTriggers } from "./install";
import { fakeAdapters, unlockSendsForTest } from "./test-install";
import { tick } from "./runner";
import { dispatchEvent, emitEvent } from "./dispatch";

process.env.BINDINGS_KEY ??= Buffer.alloc(32, 7).toString("base64");
const docs: unknown[] = [];
const base = fakeAdapters();
const fake = { ...base, write: { ...base.write, sendDocumentTemplate: async (_c: unknown, x: unknown) => { docs.push(x); return { id: `DOC${docs.length}` }; } } } as typeof base;
const def = parseDefinition({ schema: 1, reentry: "always", nodes: [
  { id: "t1", type: "trigger", event: "payment.received" },
  { id: "a1", type: "send_document", template: "TPL" },
  { id: "a2", type: "set_tag", tag: ["stat-agreement-sent"], only_if: { eq: ["{{vars.sent.a1}}", true] } },
  { id: "x1", type: "exit", reason: "done" },
], edges: [{ from: "t1", to: "a1" }, { from: "a1", to: "a2" }, { from: "a2", to: "x1" }] });

const setup = async (slug: string, mode: string) => asOperator(async (c) => {
  const old = await one<{ id: string }>(c, "select id from companies where slug=$1", [slug]);
  if (old) { await c.query("delete from run_steps where run_id in (select id from runs where company_id=$1)", [old.id]); await c.query("delete from workflow_versions where workflow_id in (select id from workflows where company_id=$1)", [old.id]); for (const t of ["step_effects", "sends", "audit_log", "runs", "events", "workflow_triggers", "workflows", "contacts", "bindings"]) await c.query(`delete from ${t} where company_id=$1`, [old.id]); await c.query("delete from companies where id=$1", [old.id]); }
  const co = (await one<{ id: string }>(c, "insert into companies (name, slug, timezone, status, mode) values ($1,$1,'UTC','active',$2) returning id", [slug, mode]))!.id;
  const ct = (await one<{ id: string }>(c, "insert into contacts (company_id, ghl_contact_id, first_name) values ($1,'G1','Pat') returning id", [co]))!.id;
  const wf = (await one<{ id: string }>(c, "insert into workflows (company_id, name, reentry_policy, enabled) values ($1,'Payment recorded','always',true) returning id", [co]))!.id;
  await c.query("insert into workflow_versions (workflow_id, version, definition, manifest, note) values ($1,1,$2,$3,'test')", [wf, def, extractManifest(def)]);
  await syncTriggers(c, co, wf, def);
  return { co, ct };
});
const run = async (co: string, ct: string) => {
  const runs = await asOperator(async (c) => dispatchEvent(c, await emitEvent(c, { company_id: co, contact_id: ct, opportunity_id: null, appointment_id: null, event_type: "payment.received", source: "whop", data: { amount: 1 } }), { contact: { id: ct } }));
  await tick(fake, undefined, co);
  return Object.fromEntries((await asOperator((c) => many<{ node_id: string; status: string }>(c, "select node_id, status from run_steps where run_id=$1", [runs[0]]))).map((s) => [s.node_id, s.status]));
};

describe.skipIf(!process.env.DATABASE_URL)("D328: recorded as sent only when sent", () => {
  beforeAll(async () => { await migrate(); });

  it("quiet mode holds the agreement back: it is not tagged sent", async () => {
    const { co, ct } = await setup("sentonly-q", "quiet");
    expect(await run(co, ct)).toMatchObject({ a1: "ok", a2: "skipped" });
    expect(docs).toEqual([]);
  });

  it("live with sends unlocked: it goes out, and is tagged sent", async () => {
    const { co, ct } = await setup("sentonly-l", "live");
    await unlockSendsForTest(co);
    expect(await run(co, ct)).toMatchObject({ a1: "ok", a2: "ok" });
    expect(docs).toHaveLength(1);
  });
});
