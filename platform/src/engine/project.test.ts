import { describe, it, expect } from "vitest";
import { DateTime } from "luxon";
import { projectRun } from "./project";
import { parseDefinition } from "./definition";
import { templates } from "@/templates";

const company = { timezone: "America/Phoenix", send_window_start: "08:00", send_window_end: "20:00", quiet_allow_transactional: false };
const def = parseDefinition(templates.find((t) => t.slug === "pre-call-sequence")!.definition);

describe("what happens next", () => {
  it("a run parked on the 1-hour wait: the text goes an hour before a 2pm call, then the 10-minute wait and text, then done", () => {
    const start = DateTime.fromISO("2026-10-20T21:00:00Z");   // 2pm Phoenix
    const ctx = { contact: { timezone: "America/Phoenix" }, appointment: { starts_at: start.toISO() }, vars: {} };
    const now = DateTime.fromISO("2026-10-20T15:00:00Z");
    const plan = projectRun(def, { status: "waiting", current_node: "r1", next_run_at: new Date("2026-10-20T20:00:00Z"), context: { vars: {} } }, company, ctx, now);
    expect(plan[0]).toMatchObject({ kind: "wait", title: expect.stringMatching(/^Wait until .*hour before the call \(not before 7:00 AM\)$/) });
    expect(DateTime.fromISO(plan[0].at!).setZone("America/Phoenix").toFormat("yyyy-MM-dd HH:mm")).toBe("2026-10-20 13:00");
    expect(plan[1]).toMatchObject({ kind: "send", title: "Send text" }); expect(plan[1].at).toBe(plan[0].at);
    expect(plan[2]).toMatchObject({ kind: "wait", title: expect.stringMatching(/^Wait until 10 min.* before the call$/) });
    expect(DateTime.fromISO(plan[2].at!).setZone("America/Phoenix").toFormat("HH:mm")).toBe("13:50");
    expect(plan.at(-1)!.kind).toBe("exit");
  });
  it("the booking text's reply wait stops the plan at the decision", () => {
    const start = DateTime.fromISO("2026-10-20T21:00:00Z");
    const plan = projectRun(def, { status: "waiting", current_node: "w1", next_run_at: new Date("2026-10-18T19:00:00Z"), context: { vars: {} } }, company, { contact: { timezone: "America/Phoenix" }, appointment: { starts_at: start.toISO() }, vars: {} }, DateTime.fromISO("2026-10-18T15:00:00Z"));
    expect(plan[0].title.startsWith("Wait for")).toBe(true); expect(plan).toHaveLength(1);
  });
  it("a send due in the dark is shown at the next window opening; a finished run has no plan", () => {
    const stl = parseDefinition(templates.find((t) => t.slug === "speed-to-lead")!.definition);
    const now = DateTime.fromISO("2026-10-18T05:00:00Z");   // 10pm Phoenix the night before
    const plan = projectRun(stl, { status: "active", current_node: "n1", next_run_at: null, context: { vars: {} } }, company, { contact: { timezone: "America/Phoenix" }, vars: {} }, now);
    expect(plan[0]).toMatchObject({ kind: "send", note: "held until the send window opens" });
    expect(DateTime.fromISO(plan[0].at!).setZone("America/Phoenix").toFormat("HH:mm")).toBe("08:00");
    expect(projectRun(stl, { status: "completed", current_node: "x1", next_run_at: null, context: {} }, company, {}, now)).toEqual([]);
  });
});
