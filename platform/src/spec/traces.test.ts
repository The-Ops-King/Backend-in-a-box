import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { db } from "@/db/client";
import { migrate } from "@/db/migrate";
import { Scrubber } from "./scrub";
import { exportTraces } from "./traces";
import { loadDbOffers, readOnlySession } from "./sources";
import { renderWorkflow } from "./render";

describe("the scrubber", () => {
  it("gives the same value the same token and leaves no raw email, phone or name", () => {
    const s = new Scrubber();
    s.learn("contact", "Jordan Example"); s.learn("contact", "Jordan");
    const out = s.text("Hi Jordan Example (jordan@example.com, +1 (602) 555-0142), your closer is on U0123ABCDE; contact gA10c58jLJRYbNwC3apW. Jordan, see you.");
    expect(out).not.toMatch(/Jordan|example\.com|555-0142|U0123ABCDE|gA10c58jLJRYbNwC3apW/);
    expect(out).toContain("<contact-1>");
    expect(s.text("jordan@example.com")).toBe(s.text("JORDAN@example.com"));
  });
  it("turns a name field into a token whatever it says, and keeps numbers", () => {
    const s = new Scrubber();
    expect(s.value({ first_name: "Zed", amount: 500, nested: { closer_name: "Pat Doe" } })).toEqual({ first_name: "<contact-1>", amount: 500, nested: { closer_name: "<contact-2>" } });
  });
});

const hasDb = !!process.env.DATABASE_URL;
describe.skipIf(!hasDb)("golden traces and the spec from a database (read-only role)", () => {
  const slug = `trace-${Date.now()}`;
  const readerUrl = () => { const u = new URL(process.env.DATABASE_URL!); u.username = "spec_reader_test"; u.password = "reader"; return u.toString(); };

  beforeAll(async () => {
    await migrate();
    const c = await db().connect();
    try {
      await c.query("begin");
      await c.query("select set_config('app.role','operator',true)");
      const co = (await c.query("insert into companies (name, slug, timezone, mode) values ('Trace Co', $1, 'America/Phoenix', 'test') returning id", [slug])).rows[0].id;
      await c.query("insert into users (company_id, email, name, role, slack_user_id) values ($1, 'casey.closer@acme.test', 'Casey Closer', 'closer', 'U0CLOSER01')", [co]);
      const def = { schema: 1, reentry: "always", premise: { check: "none" }, nodes: [{ id: "t1", type: "trigger", event: "appointment.booked" }, { id: "s1", type: "send_sms", template: "Hi {{contact.first_name}}" }, { id: "x1", type: "exit", reason: "sent" }], edges: [{ from: "t1", to: "s1" }, { from: "s1", to: "x1" }] };
      const wf = (await c.query("insert into workflows (company_id, name, reentry_policy, enabled) values ($1, 'Booking text', 'always', true) returning id", [co])).rows[0].id;
      await c.query("insert into workflow_versions (workflow_id, version, definition, manifest) values ($1, 1, $2, '{}')", [wf, def]);
      await c.query("insert into bindings (company_id, key, kind, value) values ($1, 'slack.channel.bookings', 'channel', 'C1'), ($1, 'secret.ghl_pit', 'secret', 'not-really-encrypted')", [co]);
      const ct = (await c.query("insert into contacts (company_id, ghl_contact_id, first_name, last_name) values ($1, 'abcDEF1234567890ghij', 'Morgan', 'Testperson') returning id", [co])).rows[0].id;
      await c.query("insert into contact_identifiers (company_id, contact_id, kind, value) values ($1,$2,'email','morgan.testperson@mail.test'), ($1,$2,'phone','+16025550199')", [co, ct]);
      const ev = (await c.query("insert into events (company_id, contact_id, event_type, occurred_at, source, data) values ($1,$2,'appointment.booked', now() - interval '1 hour','engine', $3) returning id", [co, ct, { first_name: "Morgan", email: "morgan.testperson@mail.test", phone: "+1 602 555 0199" }])).rows[0].id;
      const run = (await c.query("insert into runs (company_id, workflow_id, workflow_version, contact_id, triggered_by_event, status, exit_reason, reentry_key, started_at, finished_at) values ($1,$2,1,$3,$4,'completed','sent','k1', now() - interval '1 hour', now() - interval '59 minutes') returning id", [co, wf, ct, ev])).rows[0].id;
      await c.query("insert into run_steps (run_id, node_id, node_type, status, started_at, result) values ($1,'t1','trigger','ok', now() - interval '1 hour', '{}'), ($1,'s1','send_sms','ok', now() - interval '3590 seconds', $2)", [run, { would_send: "Hi Morgan, Casey Closer will call +16025550199" }]);
      await c.query("insert into sends (company_id, run_id, contact_id, channel, idempotency_key, rendered_body, status, sent_at) values ($1,$2,$3,'sms',$4,'Hi Morgan Testperson, reply to morgan.testperson@mail.test or (602) 555-0199. Casey will call.','sent', now() - interval '3590 seconds')", [co, run, ct, `${run}:s1`]);
      await c.query("insert into slack_posts (company_id, tag, channel, ts, run_id) values ($1, 'booked:abcDEF1234567890ghij', 'C1', '1.1', $2)", [co, run]);
      await c.query("commit");
      await c.query("do $$ begin if not exists (select 1 from pg_roles where rolname = 'spec_reader_test') then create role spec_reader_test login password 'reader'; end if; end $$");
      await c.query("grant usage on schema public to spec_reader_test; grant select on all tables in schema public to spec_reader_test; alter role spec_reader_test set default_transaction_read_only = on");
    } catch (e) { await c.query("rollback"); throw e; } finally { c.release(); }
  });
  afterAll(async () => { await db().end(); });

  const asReader = async <T>(fn: (c: import("pg").PoolClient) => Promise<T>): Promise<T> => {
    const client = new Client({ connectionString: readerUrl() }); await client.connect();
    try { const c = client as unknown as import("pg").PoolClient; await readOnlySession(c); return await fn(c); } finally { await client.end(); }
  };

  it("exports the run with every person replaced", async () => {
    const [{ files }] = await asReader((c) => exportTraces(c, { offers: [slug] }));
    expect(files).toHaveLength(1);
    const text = JSON.stringify(files[0]);
    expect(text).not.toMatch(/Morgan|Testperson|morgan\.testperson|555-?0199|6025550199|Casey|abcDEF1234567890ghij/);
    const run = files[0].runs[0];
    expect(run.steps.map((s) => s.node)).toEqual(["t1", "s1"]);
    expect(run.steps[1].at_sec).toBe(10);
    expect(run.sends[0].body).toMatch(/^Hi <contact-\d+>, reply to <email-\d+> or <phone-\d+>\. <staff-\d+> will call\.$/);
    expect(files[0].paths).toEqual([{ status: "completed", exit_reason: "sent", runs: 1 }]);
    expect(files[0].note).toMatch(/30 days/);
  });

  it("reads the live definition, settings and state through the reader, never a secret's value", async () => {
    const offers = await asReader((c) => loadDbOffers(c));
    const mine = offers.find((o) => o.offer.slug === slug)!;
    expect(mine.rows).toHaveLength(1);
    const md = renderWorkflow(mine.offer, mine.rows[0].w, "2026-10-21");
    expect(md).toContain("Source: live database");
    expect(md).toContain("| Enabled | on |");
    expect(md).toContain("locked:");
    expect(JSON.stringify(mine.rows[0].w.bindings)).not.toContain("not-really-encrypted");
  });

  it("cannot write", async () => {
    await expect(asReader((c) => c.query("insert into companies (name, slug, timezone) values ('x','x-ro','UTC')"))).rejects.toThrow(/read-only/);
  });
});
