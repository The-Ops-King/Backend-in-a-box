/** D128: a workflow that starts on a payment needs Whop connected, and says so (the dashboard's "needs Whop"), without being kept from being turned on: the harness stages payments to test it. */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { asOperator } from "@/db/client";
import { migrate } from "@/db/migrate";
import { installCompany } from "@/engine/install";
import { companyReadiness } from "@/engine/readiness";
import { setBinding } from "@/engine/settings";
import { fakeAdapters } from "@/engine/test-install";
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
    co = (await installCompany({ name: "Whop Less", slug: SLUG, timezone: "America/Phoenix", locationId: "LOC-D128", pit: "pit-fake", calendars: {}, templates: ["payment-failed", "payment-recorded", "deal-closed", "new-lead"], crm: { agreement_template: "TPL1" } }, fakeAdapters())).companyId;
  });
  afterAll(() => { if (prev === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = prev; });

  it("with no Whop: every workflow a payment starts needs Whop and is not ready; one that no payment starts is untouched; the company-level note says it never starts", async () => {
    const r = await ready();
    for (const name of ["Payment failed", "Payment recorded", "Deal closed"]) expect(of(r, name), name).toMatchObject({ needs: ["Whop"], ready: false });
    expect(of(r, "Payment failed").missing).toEqual([]);
    expect(of(r, "New lead")).toMatchObject({ needs: [] });
    expect(r.issues.find((i) => i.text.startsWith("Payment failed"))).toMatchObject({ level: "warning", text: "Payment failed never starts until Whop is connected: what starts it comes from there." });
  });

  it("it can still be turned on (only a missing setting refuses), and then the note says it is on", async () => {
    const res = await workflowsRoute(new Request("http://x/api/admin/workflows", { method: "POST", headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" }, body: JSON.stringify({ company: SLUG, workflow: "payment-failed", enabled: true }) }));
    expect(res.status, await res.clone().text()).toBe(200);
    expect((await ready()).issues.find((i) => i.text.startsWith("Payment failed"))!.text).toBe("Payment failed is on but never starts until Whop is connected: what starts it comes from there.");
  });

  it("a Whop webhook secret or an API key connects it", async () => {
    await asOperator((c) => setBinding(c, co, "secret.whop_webhook", "secret", "ws_fake", "test"));
    expect(of(await ready(), "Payment failed")).toMatchObject({ needs: [], ready: true });
    await asOperator((c) => c.query("delete from bindings where company_id=$1 and key='secret.whop_webhook'", [co]));
    await asOperator((c) => setBinding(c, co, "secret.whop_api_key", "secret", "apik_fake", "test"));
    expect(of(await ready(), "Deal closed").needs).toEqual([]);
  });
});
