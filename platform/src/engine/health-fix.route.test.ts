/** D341: the Health page's "Register the Whop webhook" (POST /api/v1/companies/:slug/health/fix) makes the webhook and keeps it. */
import { describe, it, expect, beforeAll, vi } from "vitest";
import { asOperator, one } from "@/db/client";
import { migrate } from "@/db/migrate";
import { installCompany } from "@/engine/install";
import { setBinding } from "@/engine/settings";
import { fakeAdapters } from "@/engine/test-install";
import { loadCompany } from "@/engine/context";

vi.mock("@/adapters/whop/client", async (orig) => ({
  ...(await orig<typeof import("@/adapters/whop/client")>()),
  whopCreateWebhook: vi.fn(async (_key: string, url: string) => ({ id: "hook_d341", url, enabled: true, events: [], api_version: "v1", webhook_secret: "ws_d341" })),
}));
import { POST as fixRoute } from "../../app/api/v1/companies/[slug]/health/fix/route";

process.env.BINDINGS_KEY ??= Buffer.alloc(32, 7).toString("base64");
const SLUG = `d341-${Date.now()}`;
let co = "";

describe.skipIf(!process.env.DATABASE_URL)("D341: register the Whop webhook from the Health page", () => {
  beforeAll(async () => {
    await migrate();
    co = (await installCompany({ name: "Whop Key Only", slug: SLUG, timezone: "America/Phoenix", locationId: "LOC-D341", pit: "pit-fake", calendars: {}, templates: [] } as never, fakeAdapters())).companyId;
    await asOperator((c) => setBinding(c, co, "secret.whop_api_key", "secret", "apik_fake", "test"));
  });

  it("binds the new webhook's secret and id and audits it (a key with no webhook, as TRC had)", async () => {
    const res = await fixRoute(new Request(`http://x/api/v1/companies/${SLUG}/health/fix`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider: "whop" }) }), { params: Promise.resolve({ slug: SLUG }) });
    expect(res.status, await res.clone().text()).toBe(200);
    const { bindings } = await asOperator((c) => loadCompany(c, co));
    expect(bindings["secret.whop_webhook"]).toBe("ws_d341");
    expect(bindings["whop.webhook_id"]).toBe("hook_d341");
    const audit = await asOperator((c) => one<{ target_id: string }>(c, "select target_id from audit_log where company_id=$1 and action='webhook.reregistered'", [co]));
    expect(audit?.target_id).toBe(co);
  });
});
