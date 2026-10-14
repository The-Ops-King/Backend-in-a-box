/** D109: one plain company setting set from outside, as the Settings page would; never a secret, never an unknown key. */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { asOperator, one } from "@/db/client";
import { migrate } from "@/db/migrate";
import { encrypt } from "./crypto";
import { POST } from "../../app/api/admin/bindings/set/route";

process.env.BINDINGS_KEY ??= Buffer.alloc(32, 7).toString("base64");
const KEY = "bset-test-operator-key";
const prevSecret = process.env.CRON_SECRET;
const auth = { authorization: `Bearer ${KEY}`, "content-type": "application/json" };
const set = (body: unknown, headers: Record<string, string> = auth) => POST(new Request("http://x/api/admin/bindings/set", { method: "POST", headers, body: JSON.stringify(body) }));
let id = "";
const value = (key: string) => asOperator(async (c) => (await one<{ value: Buffer }>(c, "select value from bindings where company_id=$1 and key=$2", [id, key]))?.value.toString("utf8"));

describe.skipIf(!process.env.DATABASE_URL)("setting one plain company setting (D109)", () => {
  beforeAll(async () => {
    process.env.CRON_SECRET = KEY;
    await migrate();
    await asOperator(async (c) => {
      id = (await one<{ id: string }>(c, "insert into companies (name, slug, timezone, status) values ('bset','bset','UTC','onboarding') on conflict (slug) do update set status='onboarding' returning id"))!.id;
      for (const t of ["bindings", "audit_log"]) await c.query(`delete from ${t} where company_id=$1`, [id]);
      await c.query("insert into bindings (company_id,key,kind,value) values ($1,'alerts.slack_channel','channel',$2),($1,'secret.ghl_pit','secret',$3)", [id, Buffer.from("C-OLD"), encrypt("pit-value")]);
    });
  });
  afterAll(() => { if (prevSecret === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = prevSecret; });

  it("sets it, says what it replaced, and audits it", async () => {
    const r = await set({ company: "bset", key: "alerts.slack_channel", value: " C-NEW ", by: "tyler" });
    expect(await r.json()).toEqual({ ok: true, key: "alerts.slack_channel", kind: "channel", was: "C-OLD", value: "C-NEW" });
    expect(await value("alerts.slack_channel")).toBe("C-NEW");
    const a = await asOperator(async (c) => (await c.query("select after from audit_log where company_id=$1 and action='binding.set'", [id])).rows);
    expect(a).toEqual([{ after: { kind: "channel", value: "C-NEW", by: "tyler" } }]);
  });

  it("refuses a secret, an unknown key, an empty value, an unknown company and a caller without the key; nothing is written", async () => {
    expect((await set({ company: "bset", key: "secret.ghl_pit", value: "x" })).status).toBe(400);
    expect((await set({ company: "bset", key: "made.up_key", value: "x" })).status).toBe(400);
    expect((await set({ company: "bset", key: "alerts.slack_channel", value: "  " })).status).toBe(400);
    expect((await set({ company: "nope", key: "alerts.slack_channel", value: "x" })).status).toBe(404);
    expect((await set({ company: "bset", key: "alerts.slack_channel", value: "x" }, { "content-type": "application/json" })).status).toBe(401);
    expect(await value("alerts.slack_channel")).toBe("C-NEW");
    expect(await value("made.up_key")).toBeUndefined();
  });
});
