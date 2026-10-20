/** D202: what an incoming event started runs at once, not on the next minute tick; the claim keeps it from ever running twice. */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { asOperator, many, one } from "@/db/client";
import { migrate } from "@/db/migrate";
import { installCompany, syncTriggers } from "@/engine/install";
import { dispatchEvent, emitEvent } from "@/engine/dispatch";
import { parseDefinition, extractManifest } from "@/engine/definition";
import { fakeAdapters } from "@/engine/test-install";
import { runNow } from "@/engine/runner";
import { zapierAuthorized } from "@/engine/inbound";

process.env.BINDINGS_KEY ??= Buffer.alloc(32, 7).toString("base64");
const SLUG = "d202-run-now";
let co = "";

const workflow = (c: import("pg").PoolClient, name: string, nodes: unknown[], edges: unknown[]) => (async () => {
  const def = parseDefinition({ schema: 1, reentry: "always", premise: { check: "none" }, nodes, edges });
  const wf = (await one<{ id: string }>(c, "insert into workflows (company_id, name, reentry_policy, enabled) values ($1,$2,'always',true) returning id", [co, name]))!;
  await c.query("insert into workflow_versions (workflow_id, version, definition, manifest) values ($1,1,$2,$3)", [wf.id, def, extractManifest(def)]);
  await syncTriggers(c, co, wf.id, def);
})();
const wipe = () => asOperator(async (c) => {
  const old = await one<{ id: string }>(c, "select id from companies where slug=$1", [SLUG]);
  if (!old) return;
  await c.query("delete from run_steps where run_id in (select id from runs where company_id=$1)", [old.id]);
  await c.query("delete from workflow_versions where workflow_id in (select id from workflows where company_id=$1)", [old.id]);
  for (const t of ["sends", "step_effects", "runs", "events", "workflow_triggers", "workflows", "contact_identifiers", "opportunities", "contacts", "users", "calendars", "company_terms", "bindings", "poll_cursors", "engine_state", "audit_log"]) {
    if (t === "engine_state") await c.query("delete from engine_state where key like $1", [`%${old.id}%`]);
    else await c.query(`delete from ${t} where company_id=$1`, [old.id]);
  }
  await c.query("delete from companies where id=$1", [old.id]);
});
const formIn = () => asOperator(async (c) => {
  const ct = (await one<{ id: string }>(c, "insert into contacts (company_id, ghl_contact_id, first_name) values ($1,$2,'Rae') returning id", [co, `G${Math.random()}`]))!.id;
  const ev = await emitEvent(c, { company_id: co, contact_id: ct, opportunity_id: null, appointment_id: null, event_type: "form.submitted", source: "engine", data: {} });
  await dispatchEvent(c, ev, { contact: { id: ct } });
  return ct;
});
const clockAt = (minutesAgo: number) => asOperator((c) => c.query("insert into engine_state (key, value, updated_at) values ($1, $2, now()) on conflict (key) do update set value=excluded.value", [`scheduler:${co}`, { last_tick: new Date(Date.now() - minutesAgo * 60e3).toISOString() }]));
const runsOf = (ct: string) => asOperator((c) => many<{ name: string; status: string }>(c, "select w.name, r.status from runs r join workflows w on w.id=r.workflow_id where r.contact_id=$1 order by w.name", [ct]));

describe.skipIf(!process.env.DATABASE_URL)("D202: runs started by an incoming event run at once", () => {
  beforeAll(async () => {
    await migrate();
    await wipe();
    co = (await installCompany({ name: "Run now", slug: SLUG, timezone: "America/Phoenix", locationId: "LOC-D202", pit: "pit-fake", calendars: {}, templates: [] }, fakeAdapters())).companyId;
    await asOperator(async (c) => {
      // a form starts Application, whose step starts New lead: the chain an event sets off runs in the same call
      await workflow(c, "Application", [{ id: "t1", type: "trigger", event: "form.submitted" }, { id: "r1", type: "record", event: "lead.created", start: true }, { id: "x1", type: "exit", reason: "done" }],
        [{ from: "t1", to: "r1" }, { from: "r1", to: "x1" }]);
      await workflow(c, "New lead", [{ id: "t1", type: "trigger", event: "lead.created" }, { id: "x1", type: "exit", reason: "done" }], [{ from: "t1", to: "x1" }]);
    });
  });
  afterAll(wipe);
  beforeEach(() => clockAt(0));   // the company's minute tick ran just now

  it("runs what the event started and what that started, without a tick, and leaves the tick's clock alone", async () => {
    const clock = () => asOperator((c) => many(c, "select key, value from engine_state where key like 'scheduler%' order by key"));
    const before = await clock();
    const ct = await formIn();
    expect(await runsOf(ct)).toEqual([{ name: "Application", status: "active" }]);
    const r = await runNow(fakeAdapters(), co);
    expect(r).toMatchObject({ completed: 2, failed: 0, recovery: false });
    expect(await runsOf(ct)).toEqual([{ name: "Application", status: "completed" }, { name: "New lead", status: "completed" }]);
    expect(await clock()).toEqual(before);
  });

  it("after a gap it leaves the backlog to the minute tick, which runs it as a recovery (sends capped, stale reminders exited)", async () => {
    await clockAt(15);
    const ct = await formIn();
    expect(await runNow(fakeAdapters(), co)).toMatchObject({ claimed: 0, recovery: true });
    expect(await runsOf(ct)).toEqual([{ name: "Application", status: "active" }]);
    await clockAt(0);
    expect(await runNow(fakeAdapters(), co)).toMatchObject({ completed: 2, recovery: false });
  });

  it("never runs a run another runner holds (the minute tick's claim), and finds nothing to do twice", async () => {
    const ct = await formIn();
    await asOperator((c) => c.query("update runs set claimed_at=now(), claimed_by='tick-test' where contact_id=$1", [ct]));
    expect(await runNow(fakeAdapters(), co)).toMatchObject({ claimed: 0 });
    expect(await runsOf(ct)).toEqual([{ name: "Application", status: "active" }]);
    await asOperator((c) => c.query("update runs set claimed_at=null, claimed_by=null where contact_id=$1", [ct]));
    const [a, b] = await Promise.all([runNow(fakeAdapters(), co), runNow(fakeAdapters(), co)]);
    expect(a.completed + b.completed).toBe(2);
    expect(await runsOf(ct)).toEqual([{ name: "Application", status: "completed" }, { name: "New lead", status: "completed" }]);
  });
});

describe("D202: the inbound key", () => {
  it("the inbound secret only in a header, compared whole", () => {
    const b = { "secret.zapier_inbound": "zi_secret" };
    expect(zapierAuthorized(new Request("https://x/h", { headers: { "x-engine-secret": "zi_secret" } }), b)).toBe(true);
    expect(zapierAuthorized(new Request("https://x/h", { headers: { authorization: "Bearer zi_secret" } }), b)).toBe(true);
    expect(zapierAuthorized(new Request("https://x/h?key=zi_secret"), b)).toBe(false);
    expect(zapierAuthorized(new Request("https://x/h", { headers: { "x-engine-secret": "zi_secreT" } }), b)).toBe(false);
    expect(zapierAuthorized(new Request("https://x/h", { headers: { "x-engine-secret": "zi_secret" } }), {})).toBe(false);
  });
});

describe.skipIf(!process.env.DATABASE_URL)("D202: which offers the ten-second documents job reads", () => {
  const W = "d202-waiting";
  let id = "", rae = "", cy = "";
  const waiting = () => asOperator(async (c) => (await many<{ company_id: string }>(c, "select company_id from bb_documents_waiting()")).some((r) => r.company_id === id));
  const clean = () => asOperator(async (c) => {
    const old = await one<{ id: string }>(c, "select id from companies where slug=$1", [W]); if (!old) return;
    for (const t of ["agreements", "payments", "contacts"]) await c.query(`delete from ${t} where company_id=$1`, [old.id]);
    await c.query("delete from companies where id=$1", [old.id]);
  });
  beforeAll(async () => {
    await migrate(); await clean();
    await asOperator(async (c) => {
      id = (await one<{ id: string }>(c, "insert into companies (name, slug, timezone, status) values ('Waiting', $1, 'UTC', 'active') returning id", [W]))!.id;
      rae = (await one<{ id: string }>(c, "insert into contacts (company_id, ghl_contact_id, first_name) values ($1,'GW1','Rae') returning id", [id]))!.id;
      cy = (await one<{ id: string }>(c, "insert into contacts (company_id, ghl_contact_id, first_name) values ($1,'GW2','Cy') returning id", [id]))!.id;
    });
  });
  afterAll(clean);

  it("a payment from someone with nothing signed, or an agreement sent and not signed, in the last 15 minutes: read it; otherwise not", async () => {
    expect(await waiting()).toBe(false);
    await asOperator((c) => c.query("insert into payments (company_id, contact_id, whop_payment_id, amount, status, paid_at) values ($1,$2,'pw-old',500,'succeeded',now() - interval '20 minutes')", [id, rae]));
    expect(await waiting()).toBe(false);   // too long ago: the minute poll's alone
    await asOperator((c) => c.query("insert into payments (company_id, contact_id, whop_payment_id, amount, status, paid_at) values ($1,$2,'pw-new',500,'succeeded',now() - interval '2 minutes')", [id, rae]));
    expect(await waiting()).toBe(true);
    await asOperator((c) => c.query("insert into agreements (company_id, contact_id, external_id, status, sent_at, signed_at) values ($1,$2,'dw-1','completed',now() - interval '1 minute',now())", [id, rae]));
    expect(await waiting()).toBe(false);   // signed: nothing to wait for
    await asOperator((c) => c.query("insert into agreements (company_id, contact_id, external_id, status, sent_at) values ($1,$2,'dw-2','sent',now() - interval '3 minutes')", [id, cy]));
    expect(await waiting()).toBe(true);    // sent to Cy, not signed
    await asOperator((c) => c.query("update agreements set sent_at = now() - interval '16 minutes' where external_id='dw-2' and company_id=$1", [id]));
    expect(await waiting()).toBe(false);
  });
});

