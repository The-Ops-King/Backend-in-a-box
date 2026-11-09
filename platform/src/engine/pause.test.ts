/** D298: an offer can be paused. Nothing runs, its alerts close quietly; unpausing reads GHL back as a silent baseline. */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { asOperator, many, one } from "@/db/client";
import { migrate } from "@/db/migrate";
import { fakeAdapters } from "@/engine/test-install";
import { raise } from "@/engine/alerts";
import { tickCompany } from "./ticks";
import { runningSql } from "./running";
import { setPaused } from "./pause";

process.env.BINDINGS_KEY ??= Buffer.alloc(32, 7).toString("base64");
let P: string;
const status = () => asOperator((c) => one<{ status: string }>(c, "select status from companies where id=$1", [P])).then((r) => r!.status);

describe.skipIf(!process.env.DATABASE_URL)("D298: pausing an offer", () => {
  beforeAll(async () => {
    await migrate();
    await asOperator(async (c) => {
      const old = await one<{ id: string }>(c, "select id from companies where slug='pausey'");
      if (old) { for (const t of ["alerts", "poll_cursors", "audit_log"]) await c.query(`delete from ${t} where company_id=$1`, [old.id]); await c.query("delete from companies where id=$1", [old.id]); }
      P = (await one<{ id: string }>(c, "insert into companies (name, slug, timezone, status) values ('Pausey','pausey','UTC','active') returning id"))!.id;
      await raise(c, { companyId: P, key: "health:x", level: "error", source: "health", text: "x" });
      await c.query("insert into poll_cursors (company_id, entity, cursor) values ($1,'contacts','2026-10-01T00:00:00Z')", [P]);
    });
  });
  afterAll(() => asOperator((c) => c.query("update companies set status='archived' where id=$1", [P])));

  it("needs a reason; a dry run changes nothing", async () => {
    expect(await asOperator((c) => setPaused(c, { company: "pausey", paused: true, why: " " }))).toMatchObject({ ok: false, status: 400 });
    expect(await asOperator((c) => setPaused(c, { company: "pausey", paused: true, why: "test" }))).toEqual({ ok: true, dryRun: true, company: "pausey", was: "active", now: "paused" });
    expect(await status()).toBe("active");
  });

  it("paused: not running, does not tick, its alerts closed quietly, audited", async () => {
    expect(await asOperator((c) => setPaused(c, { company: "pausey", paused: true, why: "test", dryRun: false }))).toMatchObject({ ok: true, now: "paused", alerts_closed: 1 });
    const a = await asOperator((c) => one<{ resolved_at: Date | null; resolved_announced: boolean }>(c, "select resolved_at, resolved_announced from alerts where company_id=$1", [P]));
    expect(a!.resolved_at).not.toBeNull(); expect(a!.resolved_announced).toBe(true);
    expect(await asOperator((c) => one(c, `select 1 from companies co where co.id=$1 and ${runningSql()}`, [P]))).toBeUndefined();
    expect(await tickCompany(fakeAdapters(), P)).toMatchObject({ busy: false, skipped: "company is not active" });
    expect(await asOperator((c) => setPaused(c, { company: "pausey", paused: true, why: "again", dryRun: false }))).toMatchObject({ ok: false, status: 400 });
  });

  it("unpaused: active again, poll cursors cleared so the first read is a baseline", async () => {
    expect(await asOperator((c) => setPaused(c, { company: "pausey", paused: false, why: "back", dryRun: false }))).toMatchObject({ ok: true, now: "active", cursors_cleared: 1 });
    expect(await status()).toBe("active");
    expect(await asOperator((c) => many(c, "select 1 from poll_cursors where company_id=$1", [P]))).toHaveLength(0);
    const audit = await asOperator((c) => many<{ action: string }>(c, "select action from audit_log where company_id=$1 order by id", [P]));
    expect(audit.map((r) => r.action)).toEqual(["company.paused", "company.unpaused"]);
  });
});
