import { describe, it, expect } from "vitest";
import { DateTime } from "luxon";
import { projectRun } from "./project";
import { parseDefinition } from "./definition";
import { templates } from "@/templates";

const company = { timezone: "America/Phoenix", send_window_start: "08:00", send_window_end: "20:00", quiet_allow_transactional: false };
const def = parseDefinition(templates.find((t) => t.slug === "appointment-reminder")!.definition);

describe("what happens next", () => {
  it("a run parked on the day-of wait: the text goes at 8am the day of the call, then the reply wait, and the plan stops at the decision", () => {
    const start = DateTime.fromISO("2026-10-20T21:00:00Z");   // 2pm Phoenix
    const ctx = { contact: { timezone: "America/Phoenix" }, appointment: { starts_at: start.toISO() }, vars: {} };
    const now = DateTime.fromISO("2026-10-18T15:00:00Z");
    const plan = projectRun(def, { status: "waiting", current_node: "n1", next_run_at: new Date("2026-10-20T15:00:00Z"), context: { vars: {} } }, company, ctx, now);
    expect(plan[0]).toMatchObject({ kind: "wait", title: "Wait until 8:00 AM the day of the call" });
    expect(DateTime.fromISO(plan[0].at!).setZone("America/Phoenix").toFormat("yyyy-MM-dd HH:mm")).toBe("2026-10-20 08:00");
    expect(plan[1]).toMatchObject({ kind: "send", title: "Send text" }); expect(plan[1].at).toBe(plan[0].at);
    expect(plan.at(-1)!.kind).toMatch(/wait|decision/);
    expect(plan.some((p) => p.title.startsWith("Wait for"))).toBe(true);
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
