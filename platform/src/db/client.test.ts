import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { asCompany, asOperator, checkpoint, db, normalizeDatabaseUrl, one } from "./client";
describe("normalizeDatabaseUrl", () => {
  const sess = "postgresql://postgres.abc:pw@aws-0-us-east-1.pooler.supabase.com:5432/postgres";
  it("moves a Supabase session-mode pooler URL to transaction mode", () => {
    expect(normalizeDatabaseUrl(sess, {})).toBe("postgresql://postgres.abc:pw@aws-0-us-east-1.pooler.supabase.com:6543/postgres");
  });
  it("leaves transaction mode, direct connections and other hosts alone", () => {
    expect(normalizeDatabaseUrl(sess.replace("5432", "6543"), {})).toBe(sess.replace("5432", "6543"));
    expect(normalizeDatabaseUrl("postgresql://postgres:pw@db.abc.supabase.co:5432/postgres", {})).toBe("postgresql://postgres:pw@db.abc.supabase.co:5432/postgres");
    expect(normalizeDatabaseUrl("postgres://tyler@/model?host=/tmp&port=5499", {})).toBe("postgres://tyler@/model?host=/tmp&port=5499");
  });
  it("DB_POOLER_MODE=session opts out", () => { expect(normalizeDatabaseUrl(sess, { DB_POOLER_MODE: "session" })).toBe(sess); });
});

describe.skipIf(!process.env.DATABASE_URL)("checkpoint (D151)", () => {
  const T = "checkpoint_probe";
  beforeAll(async () => { await db().query(`create table if not exists ${T} (k text primary key)`); await db().query(`delete from ${T}`); });
  afterAll(async () => { await db().query(`drop table if exists ${T}`); });
  it("keeps what was done before it and what it wrote, though the transaction around it rolls back later", async () => {
    await expect(asOperator(async (c) => {
      await c.query(`insert into ${T} values ('before')`);
      await checkpoint(c, (o) => o.query(`insert into ${T} values ('ledger')`));
      await c.query(`insert into ${T} values ('after')`);
      throw new Error("the run fails after the vendor answered");
    })).rejects.toThrow(/run fails/);
    const rows = (await db().query<{ k: string }>(`select k from ${T} order by k`)).rows.map((r) => r.k);
    expect(rows).toEqual(["before", "ledger"]);
  });

  it("the transaction after it runs under the same scope", async () => {
    const co = "00000000-0000-0000-0000-00000000c0de";
    const seen = await asCompany(co, async (c) => { await checkpoint(c, async () => null); return one<{ co: string; role: string }>(c, "select current_setting('app.company_id', true) as co, current_setting('app.role', true) as role"); });
    expect(seen).toEqual({ co, role: "company" });
  });

  it("a write that fails inside it is undone alone; the run's transaction goes on", async () => {
    const out = await asOperator(async (c) => {
      await expect(checkpoint(c, (o) => o.query(`insert into ${T} values ('ledger')`))).rejects.toThrow(/duplicate key/);
      await c.query(`insert into ${T} values ('went on')`);
      return "ok";
    });
    expect(out).toBe("ok");
    expect((await db().query(`select 1 from ${T} where k='went on'`)).rowCount).toBe(1);
  });

  it("never calls a failed transaction committed", async () => {
    await expect(asOperator(async (c) => {
      await c.query("select 1/0").catch(() => {});   // swallowed, as careless code would
      await checkpoint(c, (o) => o.query(`insert into ${T} values ('lost')`));
    })).rejects.toThrow();
    expect((await db().query(`select 1 from ${T} where k='lost'`)).rowCount).toBe(0);
  });
});
