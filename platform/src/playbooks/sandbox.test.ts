/**
 * D155: Claude sets a template business up in the sandbox from the deployment's settings: refused, naming each, while one is
 * missing; the wizard's research answers made from the sandbox (closer call, closer, setter, a triage calendar); and the client
 * gates (the check before a rung up, their GHL workflows before the test contact) do not apply to a template business.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { asOperator, one } from "@/db/client";
import { migrate } from "@/db/migrate";
import { fakeAdapters } from "@/engine/test-install";
import type { Research } from "@/onboarding/research";
import { useCheck } from "@/onboarding/filters";
import { createTestContact } from "@/onboarding/test-contact";
import { sandboxAnswers, sandboxEnv, setupSandbox } from "./sandbox";
import { ensureTemplateBusiness, templateSlug } from "./template-business";

const research = (cals: string[], users: number) => ({ calendars: cals.map((name, i) => ({ id: `k${i}`, name, teamMemberIds: [] })), users: Array.from({ length: users }, (_, i) => ({ id: `u${i}`, name: `U${i}`, email: `u${i}@x.co` })) }) as unknown as Research;

describe("D155: the research answers made from the sandbox", () => {
  it("one board: every calendar a closing call booked by the lead, the first the closer call; the first user closes, the next sets", () => {
    expect(sandboxAnswers(research(["Strategy call", "Other"], 3), "one-board")).toEqual({
      calendars: { k0: { call_type: "closing", booking: "question" }, k1: { call_type: "closing", booking: "question" } }, closerCall: "k0", bookingCalendar: "k0",
      team: { u0: "closer", u1: "setter", u2: "staff" } });
  });
  it("application and triage: a calendar named triage is the Triage call; what Claude passes wins", () => {
    const a = sandboxAnswers(research(["Triage", "Closing"], 1), "application-triage", { team: { u0: "manager" } });
    expect(a.calendars.k0).toEqual({ call_type: "qualifying", name: "Triage call", booking: "self" });
    expect(a.closerCall).toBe("k1");
    expect(a.team).toEqual({ u0: "manager" });
  });
  it("reads its settings from the environment", () => {
    expect(sandboxEnv({ SANDBOX_LOCATION_ID: "L", SANDBOX_GHL_PIT: "p", SANDBOX_TEST_EMAIL: "jt@jtylerray.com" } as NodeJS.ProcessEnv)).toMatchObject({ locationId: "L", pit: "p", testEmail: "jt@jtylerray.com" });
  });
});

describe.skipIf(!process.env.DATABASE_URL)("D155: setup, and the client gates a template business skips", () => {
  beforeAll(async () => { await migrate(); });

  it("is refused before anything is made while a setting is missing, naming each", async () => {
    const r = await setupSandbox(asOperator, fakeAdapters(), "one-board", { env: { locationId: "L", pit: "p" } });
    expect(r).toEqual({ ok: false, slug: templateSlug("one-board"), steps: [{ step: "settings", ok: false, detail: "set in the deployment's environment: SANDBOX_SLACK_BOT_TOKEN, SANDBOX_SLACK_SIGNING_SECRET, SANDBOX_SLACK_CHANNEL, SANDBOX_TEST_EMAIL" }] });
  });

  it("a template business needs no check before a rung up, and no marked GHL workflows before its test contact", async () => {
    const tb = await asOperator((c) => ensureTemplateBusiness(c, "setter-closer", "test"));
    if (!tb.ok) throw new Error(tb.why);
    expect(await asOperator((c) => useCheck(c, tb.id, "x"))).toBeNull();
    // past the step-8 gate: it stops where a template business without GHL would
    expect(await createTestContact(asOperator, fakeAdapters(), tb.id, { email: "jt@jtylerray.com" })).toMatchObject({ ok: false, why: "connect their GHL first" });
    expect(await asOperator((c) => one(c, "select status from companies where id=$1", [tb.id]))).toEqual({ status: "template" });
  });
});
