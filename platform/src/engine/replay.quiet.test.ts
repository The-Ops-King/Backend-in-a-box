/** D326: a quiet replay writes what the workflow writes and tells nobody: its Slack and send steps are skipped; a plain replay posts. */
import { describe, it, expect, beforeAll, vi } from "vitest";
// the route hands follow-up work to Next's after(), which exists only inside a request: the test works the runs itself
vi.mock("next/server", async (orig) => ({ ...(await orig<typeof import("next/server")>()), after: () => undefined }));
import { asOperator, many, one } from "@/db/client";
import { migrate } from "@/db/migrate";
import { encrypt } from "./crypto";
import { parseDefinition, extractManifest } from "./definition";
import { syncTriggers } from "./install";
import { fakeAdapters } from "./test-install";
import { tick } from "./runner";
import { POST as replay } from "../../app/api/admin/events/replay/route";
import type { Adapters } from "@/adapters/types";

process.env.BINDINGS_KEY ??= Buffer.alloc(32, 7).toString("base64");
const KEY = "quiet-replay-key";
const posts: string[] = [];
const base = fakeAdapters();
const fake: Adapters = { ...base, notifier: { ...base.notifier, post: async (_t, _ch, text) => { posts.push(text); return { ts: `ts${posts.length}` }; } } };
const def = parseDefinition({ schema: 1, reentry: "always", nodes: [
  { id: "t1", type: "trigger", event: "payment.received" },
  { id: "s1", type: "slack_post", channel: "C1", template: "Paid {{event.amount}}" },
  { id: "g1", type: "set_tag", tag: ["paid"] },
  { id: "x1", type: "exit", reason: "done" },
], edges: [{ from: "t1", to: "s1" }, { from: "s1", to: "g1" }, { from: "g1", to: "x1" }] });
let co = "", wf = "", ct = "";
const event = () => asOperator(async (c) => (await one<{ id: string }>(c, "insert into events (company_id, contact_id, event_type, source, occurred_at, data) values ($1,$2,'payment.received','whop',now(),$3) returning id", [co, ct, { amount: 300 }]))!.id);
const call = (events: string[], quiet: boolean) => replay(new Request("http://x/api/admin/events/replay", { method: "POST", headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
  body: JSON.stringify({ company: "quietrep", workflow: wf, events: events.map(Number), dryRun: false, quiet }) }));
const steps = (runId: string) => asOperator((c) => many<{ node_id: string; status: string }>(c, "select node_id, status from run_steps where run_id=$1 order by started_at", [runId]));

describe.skipIf(!process.env.DATABASE_URL)("D326: a quiet replay", () => {
  beforeAll(async () => {
    process.env.CRON_SECRET = KEY;
    await migrate();
    await asOperator(async (c) => {
      const old = await one<{ id: string }>(c, "select id from companies where slug='quietrep'");
      if (old) { await c.query("delete from run_steps where run_id in (select id from runs where company_id=$1)", [old.id]); await c.query("delete from workflow_versions where workflow_id in (select id from workflows where company_id=$1)", [old.id]); for (const t of ["step_effects", "slack_posts", "audit_log", "runs", "events", "workflow_triggers", "workflows", "slack_connections", "contacts", "bindings"]) await c.query(`delete from ${t} where company_id=$1`, [old.id]); await c.query("delete from companies where id=$1", [old.id]); }
      co = (await one<{ id: string }>(c, "insert into companies (name, slug, timezone, status, mode) values ('Quiet','quietrep','UTC','active','live') returning id"))!.id;
      await c.query("insert into slack_connections (company_id, team_id, bot_token, channels) values ($1,'T1',$2,'{}')", [co, encrypt("xoxb")]);
      await c.query("insert into bindings (company_id,key,kind,value) values ($1,'slack.live','text',$2)", [co, Buffer.from("true")]);
      ct = (await one<{ id: string }>(c, "insert into contacts (company_id, ghl_contact_id, first_name) values ($1,'GQ','Quinn') returning id", [co]))!.id;
      wf = (await one<{ id: string }>(c, "insert into workflows (company_id, name, reentry_policy, enabled) values ($1,'Payment recorded','always',true) returning id", [co]))!.id;
      await c.query("insert into workflow_versions (workflow_id, version, definition, manifest, note) values ($1,1,$2,$3,'test')", [wf, def, extractManifest(def)]);
      await syncTriggers(c, co, wf, def);
    });
  });

  it("quiet: the run writes (the tag step runs) and its Slack step is skipped; nothing is posted", async () => {
    const res = await call([await event()], true);
    const body = await res.json() as { quiet: boolean; rows: { runs: string[] }[] };
    expect(body.quiet).toBe(true);
    await tick(fake, undefined, co);
    const s = await steps(body.rows[0].runs[0]);
    expect(Object.fromEntries(s.map((x) => [x.node_id, x.status]))).toMatchObject({ s1: "skipped", g1: "ok" });
    expect(posts).toEqual([]);
  });

  it("a plain replay posts as before", async () => {
    const res = await call([await event()], false);
    const body = await res.json() as { rows: { runs: string[] }[] };
    await tick(fake, undefined, co);
    expect(Object.fromEntries((await steps(body.rows[0].runs[0])).map((x) => [x.node_id, x.status]))).toMatchObject({ s1: "ok" });
    expect(posts).toEqual(["Paid 300"]);
  });
});
