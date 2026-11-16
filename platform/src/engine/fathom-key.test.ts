/** D336: a new Fathom key brings its own webhook; the old webhook goes, with the old key, only after the new one is bound. */
import { describe, it, expect, beforeAll } from "vitest";
import { asOperator, one } from "@/db/client";
import { migrate } from "@/db/migrate";
import { encrypt } from "./crypto";
import { loadCompany } from "./context";
import { replaceFathomKey, type FathomApi } from "./fathom-key";

process.env.BINDINGS_KEY ??= Buffer.alloc(32, 7).toString("base64");
let co: string;
const fake = (log: string[], o: Partial<FathomApi> = {}): FathomApi => ({
  ping: async (k) => (k.startsWith("good") ? true : { ok: false, status: 401, detail: "bad key" }),
  create: async (k, url) => { log.push(`create ${k} ${url}`); return { id: "wh_new", url, secret: "whsec_new", created_at: "", triggered_for: [] }; },
  remove: async (k, id) => { log.push(`remove ${k} ${id}`); return "deleted"; }, ...o });
const bindings = () => asOperator(async (c) => (await loadCompany(c, co)).bindings);

describe.skipIf(!process.env.DATABASE_URL)("D336: replacing an offer's Fathom key", () => {
  beforeAll(async () => {
    await migrate();
    await asOperator(async (c) => {
      const old = await one<{ id: string }>(c, "select id from companies where slug='fathomkeyco'");
      if (old) { for (const t of ["audit_log", "bindings"]) await c.query(`delete from ${t} where company_id=$1`, [old.id]); await c.query("delete from companies where id=$1", [old.id]); }
      co = (await one<{ id: string }>(c, "insert into companies (name, slug, timezone, status) values ('Fathom Key Co','fathomkeyco','UTC','active') returning id"))!.id;
      await c.query("insert into bindings (company_id,key,kind,value) values ($1,'secret.fathom_api_key','secret',$2),($1,'secret.fathom_webhook','secret',$3),($1,'fathom.webhook_id','id',$4)", [co, encrypt("old-key-0000000000"), encrypt("whsec_old"), Buffer.from("wh_old")]);
    });
  });

  it("a refused key, a short one or the same one changes nothing", async () => {
    const log: string[] = [];
    await expect(asOperator(async (c) => replaceFathomKey(c, co, await bindings(), "bad-key-0000000000", "https://x", { dryRun: false }, fake(log)))).rejects.toThrow(/refused the key \(401: bad key\)/);
    await expect(asOperator(async (c) => replaceFathomKey(c, co, await bindings(), "short", "https://x", { dryRun: false }, fake(log)))).rejects.toThrow(/whole Fathom API key/);
    await expect(asOperator(async (c) => replaceFathomKey(c, co, await bindings(), "old-key-0000000000", "https://x", { dryRun: false }, fake(log)))).rejects.toThrow(/already/);
    expect(log).toEqual([]);
    expect((await bindings())["secret.fathom_api_key"]).toBe("old-key-0000000000");
  });

  it("the dry run says what would happen and touches nothing", async () => {
    const log: string[] = [];
    const r = await asOperator(async (c) => replaceFathomKey(c, co, await bindings(), "good-key-1111111111", "https://x", {}, fake(log)));
    expect(r).toMatchObject({ dryRun: true, replaces: "key ending 0000", old_webhook: "wh_old", webhook: `https://x/api/webhooks/fathom/${co}` });
    expect(log).toEqual([]);
    expect((await bindings())["fathom.webhook_id"]).toBe("wh_old");
  });

  it("the new key, its webhook's secret and id are bound; the old webhook is removed with the old key, after", async () => {
    const log: string[] = [];
    const r = await asOperator(async (c) => replaceFathomKey(c, co, await bindings(), " good-key-1111111111 ", "https://x", { dryRun: false }, fake(log)));
    expect(r).toMatchObject({ dryRun: false, webhook_id: "wh_new", old_webhook_result: "deleted" });
    expect(log).toEqual([`create good-key-1111111111 https://x/api/webhooks/fathom/${co}`, "remove old-key-0000000000 wh_old"]);
    const b = await bindings();
    expect([b["secret.fathom_api_key"], b["secret.fathom_webhook"], b["fathom.webhook_id"]]).toEqual(["good-key-1111111111", "whsec_new", "wh_new"]);
    const a = await asOperator((c) => one<{ after: Record<string, unknown> }>(c, "select after from audit_log where company_id=$1 and action='fathom.key_replaced'", [co]));
    expect(a?.after).toMatchObject({ ends_with: "1111", webhook: "wh_new", old_webhook: "wh_old" });
    expect(JSON.stringify(a?.after)).not.toContain("good-key-1111111111");
  });

  it("an old webhook Fathom won't remove leaves the new key in place and says so", async () => {
    const log: string[] = [];
    const r = await asOperator(async (c) => replaceFathomKey(c, co, await bindings(), "good-key-2222222222", "https://x", { dryRun: false }, fake(log, { remove: async () => { throw new Error("fathom: delete webhook 500 boom"); } })));
    expect(r).toMatchObject({ old_webhook_result: expect.stringMatching(/^not removed: fathom: delete webhook 500/) });
    expect((await bindings())["secret.fathom_api_key"]).toBe("good-key-2222222222");
  });
});
