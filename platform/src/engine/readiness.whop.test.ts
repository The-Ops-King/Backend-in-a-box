/** D128: a workflow that starts on a payment needs Whop connected, and says so (the dashboard's "needs Whop"), without being kept from being turned on: the harness stages payments to test it. */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { asOperator } from "@/db/client";
import { migrate } from "@/db/migrate";
import { installCompany } from "@/engine/install";
import { companyReadiness } from "@/engine/readiness";
import { setBinding } from "@/engine/settings";
import { fakeAdapters, fakeProbes } from "@/engine/test-install";
import { loadCompany } from "@/engine/context";
import { runHealthStep, setProbeRetryMs } from "@/engine/health";
import { POST as workflowsRoute } from "../../app/api/admin/workflows/route";

process.env.BINDINGS_KEY ??= Buffer.alloc(32, 7).toString("base64");
const KEY = "d128-operator-key", prev = process.env.CRON_SECRET, SLUG = `d128-${Date.now()}`;
let co = "";
const ready = () => asOperator((c) => companyReadiness(c, co, `/app/c/${SLUG}`));
const of = (r: Awaited<ReturnType<typeof ready>>, name: string) => r.workflows.find((w) => w.name === name)!;

describe.skipIf(!process.env.DATABASE_URL)("D128: payment workflows need Whop", () => {
  beforeAll(async () => {
    process.env.CRON_SECRET = KEY;
    await migrate();
    co = (await installCompany({ name: "Whop Less", slug: SLUG, timezone: "America/Phoenix", locationId: "LOC-D128", pit: "pit-fake", calendars: {}, templates: ["payment-failed", "payment-recorded", "deal-closed", "new-lead", "payment-pending"], crm: { agreement_template: "TPL1" } }, fakeAdapters())).companyId;
  });
  afterAll(() => { if (prev === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = prev; });

  it("with no Whop: every workflow a payment starts needs Whop and is not ready; one that no payment starts is untouched; the company-level note says it never starts", async () => {
    const r = await ready();
    for (const name of ["Payment failed", "Payment recorded", "Deal closed"]) expect(of(r, name), name).toMatchObject({ needs: ["Whop or Commas"], ready: false });
    expect(of(r, "Payment failed").missing).toEqual([]);
    expect(of(r, "New lead")).toMatchObject({ needs: [] });
    expect(r.issues.find((i) => i.text.startsWith("Payment failed"))).toMatchObject({ level: "warning", text: "Payment failed never starts until Whop or Commas is connected: what starts it comes from there." });
  });

  it("it can still be turned on (only a missing setting refuses), and then the note says it is on", async () => {
    const res = await workflowsRoute(new Request("http://x/api/admin/workflows", { method: "POST", headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" }, body: JSON.stringify({ company: SLUG, workflow: "payment-failed", enabled: true }) }));
    expect(res.status, await res.clone().text()).toBe(200);
    expect((await ready()).issues.find((i) => i.text.startsWith("Payment failed"))!.text).toBe("Payment failed is on but never starts until Whop or Commas is connected: what starts it comes from there.");
  });

  it("D141: on with no Whop, the hourly check says so (an alert): it never runs", async () => {
    setProbeRetryMs(0);
    const sweep = () => asOperator(async (c) => { const { row } = await loadCompany(c, co); return runHealthStep(c, row, fakeAdapters(), fakeProbes, { checks: {}, min_slots: 0, slots_days: 7 } as never); });
    const found = (await sweep()).findings.filter((f) => !f.ok && f.item?.startsWith("source:")).map((f) => f.text);
    expect(found).toEqual(['"Payment failed" is on and starts when a payment comes in, but Whop or Commas is not connected, so it never runs. Connect it, or turn the workflow off.']);   // the others are off
  });

  it("D319: a Commas API key connects it too", async () => {
    await asOperator((c) => setBinding(c, co, "secret.commas_api_key", "secret", "ck_fake", "test"));
    expect(of(await ready(), "Payment failed")).toMatchObject({ needs: [], ready: true });
    await asOperator((c) => c.query("delete from bindings where company_id=$1 and key='secret.commas_api_key'", [co]));
  });

  it("D340: an API key alone does not connect it, and the hourly check says the webhook is missing, with the button that makes it", async () => {
    await asOperator((c) => setBinding(c, co, "secret.whop_api_key", "secret", "apik_fake", "test"));
    expect(of(await ready(), "Deal closed").needs).toEqual(["Whop or Commas"]);
    setProbeRetryMs(0);
    const { findings } = await asOperator(async (c) => { const { row } = await loadCompany(c, co); return runHealthStep(c, row, fakeAdapters(), fakeProbes, { checks: {}, min_slots: 0, slots_days: 7 } as never); });
    expect(findings.find((f) => f.check === "whop_webhook")).toMatchObject({ ok: false, level: "error", text: "A Whop API key is saved but no payment webhook is registered: no payment reaches the engine.", fix: { action: "reregister_whop" } });
  });

  it("D342: with Payment pending on, a webhook that does not send payment.pending is an error with the fix; one that does is fine", async () => {
    await asOperator(async (c) => { await setBinding(c, co, "secret.whop_api_key", "secret", "apik_fake", "test"); await setBinding(c, co, "secret.whop_webhook", "secret", "ws_fake", "test"); await setBinding(c, co, "whop.webhook_id", "id", "hook_1", "test");
      await c.query("update workflows w set enabled=true from workflow_templates t where t.id=w.template_id and w.company_id=$1 and t.slug='payment-pending'", [co]); });
    setProbeRetryMs(0);
    const run = (events: string[]) => asOperator(async (c) => { const { row } = await loadCompany(c, co); return runHealthStep(c, row, fakeAdapters(), { ...fakeProbes, whopGetWebhook: async () => ({ ok: true as const, found: true, enabled: true, events }) }, { checks: {}, min_slots: 0, slots_days: 7 } as never); });
    const old = (await run(["payment.succeeded", "payment.failed", "refund.created"])).findings.find((f) => f.check === "whop_webhook");
    expect(old).toMatchObject({ ok: false, level: "error", text: "The Whop payment webhook does not send payment.pending, which a workflow that is on starts on.", fix: { action: "reregister_whop" } });
    expect((await run(["payment.succeeded", "payment.failed", "refund.created", "payment.pending"])).findings.find((f) => f.check === "whop_webhook")).toMatchObject({ ok: true });
    await asOperator(async (c) => { await c.query("update workflows w set enabled=false from workflow_templates t where t.id=w.template_id and w.company_id=$1 and t.slug='payment-pending'", [co]);
      await c.query("delete from bindings where company_id=$1 and key in ('secret.whop_webhook','secret.whop_api_key','whop.webhook_id')", [co]); });
  });

  it("a Whop webhook secret connects it, and with one bound the missing-webhook finding is gone", async () => {
    await asOperator((c) => setBinding(c, co, "secret.whop_webhook", "secret", "ws_fake", "test"));
    expect(of(await ready(), "Payment failed")).toMatchObject({ needs: [], ready: true });
    const { findings } = await asOperator(async (c) => { const { row } = await loadCompany(c, co); return runHealthStep(c, row, fakeAdapters(), fakeProbes, { checks: {}, min_slots: 0, slots_days: 7 } as never); });
    expect(findings.find((f) => f.check === "whop_webhook" && !f.ok)).toBeUndefined();
    await asOperator((c) => c.query("delete from bindings where company_id=$1 and key in ('secret.whop_webhook','secret.whop_api_key')", [co]));
  });
});
