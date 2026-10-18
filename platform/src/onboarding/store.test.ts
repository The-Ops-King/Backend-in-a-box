/** D143: Add client makes an inert company (ghost, onboarding: nothing polls or ticks it) and its wizard; the offer step saves the answers, the playbook and the fit report. */
import { describe, it, expect, beforeAll } from "vitest";
import { asOperator, one } from "@/db/client";
import { migrate } from "@/db/migrate";
import { createClient, onboardingState, saveIntake, slugOf } from "@/onboarding/store";
import type { Intake } from "@/onboarding/intake";

const intake: Intake = { business: "Glow Co", price: "7500", deposits: true, payment_plans: false, lead_paths: ["ads_direct_book"], application: "none", setters: true, triage: false, boards: "one",
  journey: "Ads, they book, the closer closes.", crm: "ghl", booking: "calendly", payments: "whop", recording: "fathom", agreement: "ghl_documents", closers: "a@glow.co" };

async function wipe(slug: string) {
  await asOperator(async (c) => {
    const co = await one<{ id: string }>(c, "select id from companies where slug=$1", [slug]); if (!co) return;
    for (const t of ["onboarding", "audit_log"]) await c.query(`delete from ${t} where company_id=$1`, [co.id]);
    await c.query("delete from companies where id=$1", [co.id]);
  });
}

describe.skipIf(!process.env.DATABASE_URL)("D143: Add client and the offer step", () => {
  beforeAll(async () => { await migrate(); await wipe("glow-co"); });

  it("Add client: checked, made inert (ghost, onboarding), refused twice", async () => {
    expect(slugOf("Glow Co. — Skin!")).toBe("glow-co-skin");
    expect(await asOperator((c) => createClient(c, { name: "", timezone: "America/Phoenix" }))).toMatchObject({ ok: false, status: 400 });
    expect(await asOperator((c) => createClient(c, { name: "Glow Co", timezone: "Mars/Olympus" }))).toMatchObject({ ok: false, why: expect.stringMatching(/not a time zone/) });
    expect(await asOperator((c) => createClient(c, { name: "Glow Co", slug: "Glow Co", timezone: "America/Phoenix" }))).toMatchObject({ ok: false, why: expect.stringMatching(/lowercase/) });
    const r = await asOperator((c) => createClient(c, { name: "Glow Co", timezone: "America/Phoenix", kind: "takeover", by: "test" }));
    expect(r).toMatchObject({ ok: true, slug: "glow-co" });
    expect(await asOperator((c) => one(c, "select mode, status from companies where slug='glow-co'"))).toEqual({ mode: "ghost", status: "onboarding" });
    expect(await asOperator((c) => createClient(c, { name: "Glow Co", timezone: "America/Phoenix" }))).toMatchObject({ ok: false, status: 409 });
    const s = (await asOperator((c) => onboardingState(c, "glow-co")))!;
    expect(s).toMatchObject({ kind: "takeover", playbook: null, fit: null, intake: {} });
    expect(s.steps.map((x) => [x.id, x.done])).toEqual([["offer", null], ["connections", null], ["research", null], ["slack", null], ["crm", null], ["install", null], ["messages", null], ["test", null], ["filters", null], ["golive", null], ["live", null]]);
    expect(await asOperator((c) => onboardingState(c, "no-such"))).toBeNull();
  });

  it("the offer step: bad answers refused one by one, good ones saved with the playbook and the fit, the price set; a chosen playbook wins", async () => {
    const id = (await asOperator((c) => one<{ id: string }>(c, "select id from companies where slug='glow-co'")))!.id;
    const bad = await asOperator((c) => saveIntake(c, id, { intake: { ...intake, price: "lots" } }));
    expect(bad).toMatchObject({ ok: false, status: 422, problems: ["Program price ($): an amount in dollars, like 5000"] });
    const r = await asOperator((c) => saveIntake(c, id, { intake, by: "test" }));
    expect(r).toMatchObject({ ok: true, playbook: "one-board" });
    const s = (await asOperator((c) => onboardingState(c, "glow-co")))!;
    expect(s).toMatchObject({ playbook: "one-board", intake, fit: { playbook: "one-board", notes: [expect.stringMatching(/^A takeover/)] } });
    expect(s.steps[0].done).toMatchObject({ by: "test" });
    expect(await asOperator((c) => one(c, "select contract_value_default::text as v from companies where id=$1", [id]))).toEqual({ v: "7500.00" });
    const chosen = await asOperator((c) => saveIntake(c, id, { intake, playbook: "setter-closer" }));
    expect(chosen).toMatchObject({ ok: true, playbook: "setter-closer", fit: { notes: expect.arrayContaining([expect.stringMatching(/^Setter and closer, as chosen, differs/)]) } });
    expect(await asOperator((c) => saveIntake(c, id, { intake, playbook: "nope" }))).toMatchObject({ ok: false, status: 400 });
  });
});
