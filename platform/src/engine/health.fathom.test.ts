/** D69: the Fathom key check says "rejected" only on a 401/403, re-asks a vendor that did not answer before saying anything, and names the status it got. */
import { describe, it, expect, beforeAll } from "vitest";
import { asOperator, one } from "@/db/client";
import { migrate } from "@/db/migrate";
import { installCompany } from "@/engine/install";
import { loadCompany } from "@/engine/context";
import { runHealthStep, setProbeRetryMs, type HealthProbes } from "@/engine/health";
import { fakeAdapters, fakeProbes } from "@/engine/test-install";

process.env.BINDINGS_KEY ??= Buffer.alloc(32, 7).toString("base64");
let companyId: string;
const fake = fakeAdapters();

describe.skipIf(!process.env.DATABASE_URL)("fathom key check (D69)", () => {
  beforeAll(async () => {
    await migrate(); setProbeRetryMs(0);
    await asOperator(async (c) => {
      const co = await one<{ id: string }>(c, "select id from companies where slug='fathomck'");
      if (co) {
        await c.query("delete from run_steps where run_id in (select id from runs where company_id=$1)", [co.id]); await c.query("delete from workflow_versions where workflow_id in (select id from workflows where company_id=$1)", [co.id]);
        for (const t of ["alerts", "audit_log", "health_checks", "sends", "events", "runs", "workflow_triggers", "workflows", "bindings", "company_terms", "users", "calendars", "poll_cursors"]) await c.query(`delete from ${t} where company_id=$1`, [co.id]);
        await c.query("delete from companies where id=$1", [co.id]);
      }
    });
    companyId = (await installCompany({ name: "Fathom Ck", slug: "fathomck", timezone: "America/Phoenix", locationId: "LOC", pit: "pit-fake", calendars: {}, templates: [], recording: { source: "fathom", webhookSecret: "whsec_x" } }, fake)).companyId;
    await asOperator((c) => c.query("insert into bindings (company_id, key, kind, value) values ($1,'secret.fathom_api_key','text',$2) on conflict (company_id, key) do update set value=excluded.value", [companyId, Buffer.from("k")]));
  });
  const sweep = (fathomPing: HealthProbes["fathomPing"]) => asOperator(async (c) => { const { row } = await loadCompany(c, companyId); return runHealthStep(c, row, fake, { ...fakeProbes, fathomPing }, { checks: { fathom_key: true }, min_slots: 0, slots_days: 7 } as never); });
  const finding = (r: Awaited<ReturnType<typeof sweep>>) => r.findings.find((f) => f.check === "fathom_key")!;

  it("a hiccup that clears on the second ask says nothing", async () => {
    let n = 0;
    const r = await sweep(async () => (++n === 1 ? { ok: false, status: 503, detail: "busy" } : true));
    expect(n).toBe(2); expect(finding(r)).toMatchObject({ ok: true });
  });
  it("three failed asks with a 429 are a warning that names the status, not 'rejected'", async () => {
    let n = 0;
    const r = await sweep(async () => { n++; return { ok: false, status: 429, detail: "slow down" }; });
    expect(n).toBe(3); expect(finding(r)).toMatchObject({ ok: false, level: "warning" }); expect(finding(r).text).toMatch(/did not answer the key check \(429: slow down\)/); expect(finding(r).text).not.toMatch(/rejected/);
  });
  it("a 401 is a rejected key at once, without re-asking", async () => {
    let n = 0;
    const r = await sweep(async () => { n++; return { ok: false, status: 401, detail: "invalid key" }; });
    expect(n).toBe(1); expect(finding(r)).toMatchObject({ ok: false, level: "error" }); expect(finding(r).text).toMatch(/rejected \(401\): invalid key/);
  });
});
