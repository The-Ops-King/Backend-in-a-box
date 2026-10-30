/** D239: Setter call filed on an offer with no setter board (PMU's one board): the Discovery Call is filed, no card is touched. */
import { describe, it, expect, beforeAll } from "vitest";
import { asOperator, one, many } from "@/db/client";
import { migrate } from "@/db/migrate";
import { encrypt } from "@/engine/crypto";
import { installCompany } from "./install";
import { installTemplateForTest, fakeAdapters, fakeProbes } from "./test-install";
import { dispatchEvent, emitEvent } from "./dispatch";
import { tick } from "./runner";
import type { Adapters } from "@/adapters/types";

process.env.BINDINGS_KEY ??= Buffer.alloc(32, 7).toString("base64");
const SLUG = `d239-${Date.now()}`;
const writes: Record<string, unknown>[] = [], cards: Record<string, unknown>[] = [];
const base = fakeAdapters();
const fake: Adapters = { ...base,
  read: { ...base.read, objectFields: async () => ["display_label", "external_id", "contact_id", "occurred_at", "direction", "duration_sec", "setter", "outcome", "recording_url", "call_result", "dq_reason", "notes"].map((key) => ({ key })) },
  write: { ...base.write, createRecord: async (_c, o, p) => { writes.push({ op: "create", object: o, ...p }); return { id: `rec-${writes.length}` }; }, updateRecord: async (_c, o, id, p) => { writes.push({ op: "update", object: o, id, ...p }); },
    updateOpportunity: async (_c, id, p) => { cards.push({ id, ...p }); } } };
let co = "", ct = "";

describe.skipIf(!process.env.DATABASE_URL)("D239: a setting call filed on an offer with one board", () => {
  beforeAll(async () => {
    await migrate();
    co = (await installCompany({ name: "One Board", slug: SLUG, timezone: "America/New_York", locationId: "LOC", pit: "pit-fake", calendars: {}, templates: [], crm: { assoc_discovery_call_contact: "ASSOC-DC" }, slack: { setter_calls: "CSET" } }, fake)).companyId;
    await asOperator(async (c) => {
      await c.query("update companies set mode='live' where id=$1", [co]);
      await c.query("insert into slack_connections (company_id, team_id, bot_token, bot_user_id, channels) values ($1,'T1',$2,'UBOT','{}')", [co, encrypt("xoxb-fake")]);
      ct = (await one<{ id: string }>(c, "insert into contacts (company_id, ghl_contact_id, first_name, last_name) values ($1,'G1','Ana','Lead') returning id", [co]))!.id;
      await installTemplateForTest(c, co, "setter-call-filed");
    });
  });

  it("DQ: the Discovery Call gets showed, DQ and why; the setter card moves are skipped (no setter board), nothing fails", async () => {
    await asOperator(async (c) => {
      const ev = await emitEvent(c, { company_id: co, contact_id: ct, opportunity_id: null, appointment_id: null, event_type: "setter_call.filed", source: "user",
        data: { conversation: "dial-1", started_at: "2026-10-26T15:00:00Z", result: "dq", dq_reason: "Can't afford it right now", setter: "Carly Vu", setter_ghl_user_id: "GCARLY", recording_url: "https://ghl.test/dial-1" } });
      await dispatchEvent(c, ev, { contact: { id: ct } });
    });
    await tick(fake, undefined, co, fakeProbes);
    const run = (await asOperator((c) => one<{ id: string; status: string; exit_reason: string }>(c, "select id, status, exit_reason from runs where company_id=$1 and contact_id=$2", [co, ct])))!;
    expect(run).toMatchObject({ status: "completed", exit_reason: "filed" });
    expect(writes).toEqual([expect.objectContaining({ op: "create", external_id: "dial-1", outcome: "showed", call_result: "dq", dq_reason: "Can't afford it right now", setter: "Carly Vu" })]);
    const steps = await asOperator((c) => many<{ node_id: string; status: string }>(c, "select node_id, status from run_steps where run_id=$1", [run.id]));
    expect(steps.find((s) => s.node_id === "c_dq")).toMatchObject({ status: "skipped" });
    expect(cards).toEqual([]);
  });
});
