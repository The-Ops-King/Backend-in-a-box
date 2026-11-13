/** D334: with the wizard off, an offer installed by hand leaves onboarding the way the wizard's install step does. */
import { describe, it, expect, beforeAll } from "vitest";
import { asOperator, one } from "@/db/client";
import { migrate } from "@/db/migrate";
import { createClient } from "./store";
import { finishByHand } from "./install";

process.env.BINDINGS_KEY ??= Buffer.alloc(32, 7).toString("base64");
const SLUG = `byhand-${Date.now()}`;

describe.skipIf(!process.env.DATABASE_URL)("D334: an offer installed by hand", () => {
  beforeAll(async () => { await migrate(); });

  it("leaves onboarding once: active, still in ghost, the install step marked done and audited; an offer past onboarding is untouched", async () => {
    const made = await asOperator((c) => createClient(c, { name: "By Hand", slug: SLUG, timezone: "America/New_York", kind: "new" }));
    expect(made).toMatchObject({ ok: true });
    expect(await asOperator((c) => finishByHand(c, SLUG))).toBe(true);
    const co = await asOperator((c) => one<{ id: string; status: string; mode: string }>(c, "select id, status, mode from companies where slug=$1", [SLUG]));
    expect(co).toMatchObject({ status: "active", mode: "ghost" });
    expect(await asOperator((c) => one(c, "select steps->'install'->>'by' as by from onboarding where company_id=$1", [co!.id]))).toEqual({ by: "admin install" });
    expect(await asOperator((c) => one(c, "select count(*)::int as n from audit_log where company_id=$1 and action='onboarding.installed'", [co!.id]))).toEqual({ n: 1 });
    expect(await asOperator((c) => finishByHand(c, SLUG))).toBe(false);   // already active: nothing changes, nothing audited again
    expect(await asOperator((c) => one(c, "select count(*)::int as n from audit_log where company_id=$1 and action='onboarding.installed'", [co!.id]))).toEqual({ n: 1 });
  });
});
