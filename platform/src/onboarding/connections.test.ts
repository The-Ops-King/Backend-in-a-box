/**
 * D144: the connections step. The offer's answers say which keys are needed; a key is tested before it is kept, kept
 * encrypted, never given back; a shareable AI key can be copied from another company and the copy is undone when it fails; the
 * step is done only while every needed key has passed.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { asOperator, many, one } from "@/db/client";
import { migrate } from "@/db/migrate";
import { decrypt, encrypt } from "@/engine/crypto";
import { createClient, onboardingState, saveIntake } from "@/onboarding/store";
import { connect, connectionsState, type Probes } from "@/onboarding/connections";
import type { Intake } from "@/onboarding/intake";

process.env.BINDINGS_KEY ??= Buffer.alloc(32, 7).toString("base64");
const intake: Intake = { business: "Keys Co", price: "5000", deposits: false, payment_plans: false, lead_paths: ["ads_direct_book"], application: "none", setters: false, triage: false, boards: "one",
  journey: "They book, the closer closes.", crm: "ghl", booking: "calendly", payments: "whop", recording: "none", agreement: "ghl_documents" };
const GOOD = "pit-good-1234", seen: string[] = [];
const probes: Probes = {
  ghl: async (pit, loc) => { seen.push(`ghl ${loc}`); return pit === GOOD ? { ok: true, detail: `GHL location "Keys"` } : { ok: false, error: "401 Invalid JWT" }; },
  calendly: async () => ({ ok: true, detail: "Calendly: Keys (k@keys.co)" }),
  whop: async (k) => (k === "whop-good" ? { ok: true, detail: "Whop: reads payments" } : { ok: false, error: "Whop refused the key" }),
  fathom: async () => ({ ok: false, error: "not asked" }), typeform: async () => ({ ok: false, error: "not asked" }),
  anthropic: async (k) => (k === "sk-good" ? { ok: true, detail: "Anthropic: key works" } : { ok: false, error: "401" }),
  jev: async () => ({ ok: true, detail: "Jev: answers" }),
};
const slugs = ["keys-co", "keys-donor", "keys-bad-donor"];
async function wipe() {
  await asOperator(async (c) => { for (const s of slugs) { const co = await one<{ id: string }>(c, "select id from companies where slug=$1", [s]); if (!co) continue;
    for (const t of ["onboarding", "bindings", "audit_log"]) await c.query(`delete from ${t} where company_id=$1`, [co.id]); await c.query("delete from companies where id=$1", [co.id]); } });
}

describe.skipIf(!process.env.DATABASE_URL)("D144: the connections step", () => {
  let id: string;
  beforeAll(async () => {
    await migrate(); await wipe();
    id = (await asOperator((c) => createClient(c, { name: "Keys Co", timezone: "America/Phoenix" })) as { id: string }).id;
    for (const [s, key] of [["keys-donor", "sk-good"], ["keys-bad-donor", "sk-revoked"]]) {
      const d = (await asOperator((c) => createClient(c, { name: s, slug: s, timezone: "America/Phoenix" })) as { id: string }).id;
      await asOperator((c) => c.query("insert into bindings (company_id, key, kind, value) values ($1,'secret.anthropic_key','secret',$2)", [d, encrypt(key)]));
    }
  });

  it("before the offer is answered there is nothing to connect, and it says why", async () => {
    expect(await asOperator((c) => connect(c, id, { id: "ghl", values: { pit: GOOD, locationId: "L1" } }, probes))).toMatchObject({ ok: false, status: 400, why: expect.stringMatching(/^answer The offer first/) });
    await asOperator((c) => saveIntake(c, id, { intake }));
    const rows = (await asOperator((c) => connectionsState(c, id))).rows;
    expect(rows.map((r) => [r.id, r.why])).toEqual([["ghl", "the CRM: every workflow reads and writes it"], ["calendly", "bookings come from Calendly"], ["whop", "payments come from Whop"], ["anthropic", "call notes, scorecards and the Slack bot"], ["jev", "reads replies to texts and setter calls"]]);
    expect(rows.find((r) => r.id === "anthropic")!.copyFrom).toEqual(expect.arrayContaining(["keys-bad-donor", "keys-donor"]));
    expect(rows.find((r) => r.id === "anthropic")!.copyFrom).not.toContain("keys-co");
    expect(rows.find((r) => r.id === "ghl")!.copyFrom).toEqual([]);
    expect(await asOperator((c) => connect(c, id, { id: "fathom", values: { apiKey: "x" } }, probes))).toMatchObject({ ok: false, why: "fathom is not a connection this offer needs" });
  });

  it("a key that does not work is never kept; one that works is kept encrypted and shown only masked", async () => {
    const bad = await asOperator((c) => connect(c, id, { id: "ghl", values: { pit: "pit-wrong", locationId: "L1" } }, probes));
    expect(bad).toMatchObject({ ok: false, status: 422, why: "GoHighLevel did not accept it, so nothing was kept: 401 Invalid JWT", check: { ok: false } });
    expect(await asOperator((c) => many(c, "select key from bindings where company_id=$1", [id]))).toEqual([]);
    expect(await asOperator((c) => connect(c, id, { id: "ghl", values: { locationId: "L1" } }, probes))).toMatchObject({ ok: false, status: 400, why: "Private Integration token is required" });
    const good = await asOperator((c) => connect(c, id, { id: "ghl", values: { pit: ` ${GOOD} `, locationId: "L1" } }, probes));
    expect(good).toMatchObject({ ok: true, check: { ok: true, detail: `GHL location "Keys"` } });
    const pit = (await asOperator((c) => one<{ kind: string; value: Buffer }>(c, "select kind, value from bindings where company_id=$1 and key='secret.ghl_pit'", [id])))!;
    expect(pit.kind).toBe("secret"); expect(pit.value.toString("utf8")).not.toContain(GOOD); expect(decrypt(pit.value)).toBe(GOOD);
    const s = (await asOperator((c) => onboardingState(c, "keys-co")))!;
    expect(JSON.stringify(s)).not.toContain(GOOD);
    expect(s.connections.find((r) => r.id === "ghl")!.fields).toEqual([
      expect.objectContaining({ name: "locationId", set: true, shown: "L1" }), expect.objectContaining({ name: "pit", set: true, shown: "set · ends with 1234" })]);
    // a new location with the token left blank keeps the token
    seen.length = 0;
    expect(await asOperator((c) => connect(c, id, { id: "ghl", values: { locationId: "L2", pit: "" } }, probes))).toMatchObject({ ok: true });
    expect(seen).toEqual(["ghl L2"]);
  });

  it("an AI key copied from another company is kept only when it works; the step is done once every key passes, and undone by a failed retest", async () => {
    const bad = await asOperator((c) => connect(c, id, { id: "anthropic", copyFrom: "keys-bad-donor" }, probes));
    expect(bad).toMatchObject({ ok: false, why: "Anthropic did not accept it, so nothing was kept: 401" });
    expect(await asOperator((c) => one(c, "select 1 from bindings where company_id=$1 and key='secret.anthropic_key'", [id]))).toBeUndefined();
    expect(await asOperator((c) => connect(c, id, { id: "ghl", copyFrom: "keys-donor" }, probes))).toMatchObject({ ok: false, why: expect.stringMatching(/client's own account/) });
    expect(await asOperator((c) => connect(c, id, { id: "anthropic", copyFrom: "keys-donor" }, probes))).toMatchObject({ ok: true });
    for (const [cid, values] of [["calendly", { token: "cal" }], ["whop", { apiKey: "whop-good" }], ["jev", { apiKey: "jev" }]] as const)
      expect(await asOperator((c) => connect(c, id, { id: cid, values }, probes)), cid).toMatchObject({ ok: true });
    const done = (await asOperator((c) => onboardingState(c, "keys-co")))!;
    expect(done.steps.find((x) => x.id === "connections")!.done).toBeTruthy();
    // the client revokes the Whop key; a retest says so and the step is no longer done
    const broken: Probes = { ...probes, whop: async () => ({ ok: false, error: "Whop refused the key" }) };
    expect(await asOperator((c) => connect(c, id, { id: "whop" }, broken))).toMatchObject({ ok: false, status: 422, why: "Whop: Whop refused the key" });
    expect((await asOperator((c) => onboardingState(c, "keys-co")))!.steps.find((x) => x.id === "connections")!.done).toBeNull();
    expect(await asOperator((c) => one(c, "select 1 from bindings where company_id=$1 and key='secret.whop_api_key'", [id]))).toBeTruthy();   // a retest removes nothing
  });
});
