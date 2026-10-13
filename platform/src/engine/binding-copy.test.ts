/** D100: a secret binding copied from one company to another inside the engine; the value never leaves it. */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { asOperator, one } from "@/db/client";
import { migrate } from "@/db/migrate";
import { decrypt, encrypt } from "./crypto";
import { POST } from "../../app/api/admin/bindings/copy/route";

process.env.BINDINGS_KEY ??= Buffer.alloc(32, 7).toString("base64");
const KEY = "bcopy-test-operator-key";
const prevSecret = process.env.CRON_SECRET;
const VALUE = "shared-key-value-9c1e";
const auth = { authorization: `Bearer ${KEY}`, "content-type": "application/json" };
const copy = (body: unknown, headers: Record<string, string> = auth) => POST(new Request("http://x/api/admin/bindings/copy", { method: "POST", headers, body: JSON.stringify(body) }));
const ids: Record<string, string> = {};
const binding = (slug: string, key: string) => asOperator((c) => one<{ kind: string; value: Buffer }>(c, "select kind, value from bindings where company_id=$1 and key=$2", [ids[slug], key]));
const audits = (slug: string) => asOperator(async (c) => (await c.query("select action, target_type, target_id, before, after from audit_log where company_id=$1 and action='binding.copied' order by id", [ids[slug]])).rows);

describe.skipIf(!process.env.DATABASE_URL)("copying a secret binding between companies (D100)", () => {
  beforeAll(async () => {
    process.env.CRON_SECRET = KEY;
    await migrate();
    await asOperator(async (c) => {
      for (const slug of ["bcopya", "bcopyb"]) {
        // kept between runs, not deleted (other suites leave rows on every company); onboarding, so no other suite's tick picks it up
        ids[slug] = (await one<{ id: string }>(c, "insert into companies (name, slug, timezone, status) values ($1,$1,'UTC','onboarding') on conflict (slug) do update set status='onboarding' returning id", [slug]))!.id;
        for (const t of ["bindings", "audit_log"]) await c.query(`delete from ${t} where company_id=$1`, [ids[slug]]);
      }
      await c.query("insert into bindings (company_id,key,kind,value) values ($1,'secret.anthropic_key','secret',$2),($1,'crm.location_id','id',$3)", [ids.bcopya, encrypt(VALUE), Buffer.from("LOC-A")]);
    });
  });
  afterAll(() => { if (prevSecret === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = prevSecret; });

  it("copies: the target decrypts to the same value; neither the response nor the audit carries it", async () => {
    const r = await copy({ from: "bcopya", to: "bcopyb", keys: ["secret.anthropic_key"], by: "tyler" });
    expect(r.status).toBe(200);
    const text = await r.text();
    expect(JSON.parse(text)).toEqual({ ok: true, from: "bcopya", to: "bcopyb", copied: [{ key: "secret.anthropic_key", was: "new" }] });
    expect(text).not.toContain(VALUE);
    const b = (await binding("bcopyb", "secret.anthropic_key"))!;
    expect(b.kind).toBe("secret");
    expect(b.value.toString("utf8")).not.toContain(VALUE);   // stored encrypted
    expect(decrypt(b.value)).toBe(VALUE);
    const a = await audits("bcopyb");
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ target_type: "company", after: { keys: ["secret.anthropic_key"], from: "bcopya", by: "tyler" } });
    expect(JSON.stringify(a)).not.toContain(VALUE);
    expect(await audits("bcopya")).toHaveLength(0);
    // again: the same value, said so
    expect(await (await copy({ from: "bcopya", to: "bcopyb", keys: ["secret.anthropic_key"] })).json()).toMatchObject({ copied: [{ key: "secret.anthropic_key", was: "same" }] });
  });

  it("refuses a key the source does not have, and copies nothing", async () => {
    const r = await copy({ from: "bcopya", to: "bcopyb", keys: ["secret.anthropic_key", "secret.jev_key"] });
    expect(r.status).toBe(404);
    expect(await r.json()).toMatchObject({ error: expect.stringMatching(/bcopya has no secret\.jev_key/), keys: ["secret.jev_key"] });
    expect(await binding("bcopyb", "secret.jev_key")).toBeUndefined();
    expect(await audits("bcopyb")).toHaveLength(2);
  });

  it("refuses a company's own key (a CRM token) and copies nothing", async () => {
    const r = await copy({ from: "bcopya", to: "bcopyb", keys: ["secret.anthropic_key", "secret.ghl_pit"] });
    expect(r.status).toBe(400);
    expect(await r.json()).toMatchObject({ error: expect.stringMatching(/secret\.ghl_pit belongs to one company's own accounts/), keys: ["secret.ghl_pit"] });
    expect(await binding("bcopyb", "secret.ghl_pit")).toBeUndefined();
  });

  it("refuses a key that is not a secret.* key, saying install sets those", async () => {
    const r = await copy({ from: "bcopya", to: "bcopyb", keys: ["crm.location_id"] });
    expect(r.status).toBe(400);
    const body = await r.json() as { error: string };
    expect(body.error).toMatch(/only secret\.anthropic_key and secret\.jev_key/);
    expect(body.error).toMatch(/set by install/);
    expect(await binding("bcopyb", "crm.location_id")).toBeUndefined();
  });

  it("needs the operator key, two different companies that exist, and a list of keys", async () => {
    expect((await copy({ from: "bcopya", to: "bcopyb", keys: ["secret.anthropic_key"] }, { "content-type": "application/json" })).status).toBe(401);
    expect((await copy({ from: "bcopya", to: "bcopya", keys: ["secret.anthropic_key"] })).status).toBe(400);
    expect((await copy({ from: "bcopya", to: "nope", keys: ["secret.anthropic_key"] })).status).toBe(404);
    expect((await copy({ from: "bcopya", to: "bcopyb" })).status).toBe(400);
  });
});
