import { describe, expect, it } from "vitest";
import type { Edge, Workflow } from "./definition";
import { EXAMPLES } from "./examples";
import type { RenderEnv } from "./filters";
import { holds } from "./predicate";
import { render } from "./template";
import { validateWorkflow } from "./validate";

const valid = (name: string): { workflow: Workflow; requires: ReturnType<typeof validateWorkflow>["requires"] } => {
  const r = validateWorkflow(EXAMPLES[name]);
  expect(r.problems).toEqual([]);
  if (!r.ok) throw new Error(`${name} does not validate`);
  return { workflow: r.workflow, requires: r.requires };
};

/** The way a branch takes: its first edge whose condition holds, else the else edge. */
const way = (w: Workflow, branchId: string, ctx: Record<string, unknown>, env: RenderEnv): string => {
  const out = w.edges.filter((e: Edge) => e.from === branchId);
  return (out.find((e) => e.when && holds(e.when, ctx, env)) ?? out.find((e) => e.else))!.to;
};

describe("payment-failed", () => {
  it("validates, and needs the payments channel and its one piece of content", () => {
    const { workflow, requires } = valid("payment-failed");
    expect(workflow.nodes.map((n) => n.type)).toEqual(["trigger@1", "message@1", "end@1"]);
    expect(requires.settings).toEqual(["slack.channel.payments"]);
    expect(requires.content).toEqual(["payment_failed.slack_alert"]);
  });

  // The words live in the offer's content, not the workflow: this is v1's copy written for the v2 renderer.
  const body = "*Payment failed:* ${{event.amount | money}}\n*Name:* <{{contact.crm_url}}|{{contact.name | default:Unknown}}>\n*Closer:* {{contact.closer.mention | default:unassigned}}, please follow up with them.{{contact.setter.name | line:\"*Setter:*\"}}";
  const env: RenderEnv = { now: new Date("2026-10-21T15:00:00Z"), offerZone: "America/Phoenix" };

  it("its content renders with a full context and nothing blank", () => {
    const r = render(body, { event: { amount: 1500 }, contact: { name: "Ana", crm_url: "https://crm.test/c/1", closer: { mention: "<@U1>" }, setter: { name: "Luis" } } }, env);
    expect(r.blanks).toEqual([]);
    expect(r.text).toBe("*Payment failed:* $1,500\n*Name:* <https://crm.test/c/1|Ana>\n*Closer:* <@U1>, please follow up with them.\n*Setter:* Luis");
  });

  it("holds the post when the amount is missing, and is fine without a setter or closer", () => {
    const r = render(body, { event: {}, contact: { name: "Ana", crm_url: "https://crm.test/c/1" } }, env);
    expect(r.blanks.map((b) => b.path)).toEqual(["event.amount"]);
    expect(r.text).toContain("*Closer:* unassigned");
  });
});

describe("pre-call-sequence (simplified)", () => {
  const { workflow, requires } = valid("pre-call-sequence");
  const env: RenderEnv = { now: new Date("2026-10-21T15:00:00Z"), contactZone: "America/Phoenix", offerZone: "America/Phoenix" };
  const booked = (hoursOut: number, extra: Record<string, unknown> = {}) => ({
    appointment: { status: "booked", call_type: "closing", starts_at: new Date(env.now.getTime() + hoursOut * 3_600_000).toISOString(), ...extra },
  });

  it("validates, and needs its four texts and no settings", () => {
    expect(requires.content).toEqual(["pre_call.booked", "pre_call.reminder_1h", "pre_call.reminder_1h_no_link", "pre_call.reminder_24h"]);
    expect(requires.settings).toEqual([]);
  });

  it("starts on a booking or a reschedule of a closing call, once per appointment and start time", () => {
    const triggers = workflow.nodes.filter((n) => n.type === "trigger@1");
    expect(triggers.map((t) => t.type === "trigger@1" && "event" in t.on && t.on.event)).toEqual(["appointment.booked", "appointment.rescheduled"]);
    expect(workflow.reentry).toEqual({ policy: "once_per_appointment", key: "{{appointment.starts_at}}" });
  });

  it("re-checks that the call is still on: not cancelled, still ahead", () => {
    const p = workflow.premise!.holds;
    expect(holds(p, booked(30), env)).toBe(true);
    expect(holds(p, booked(30, { status: "cancelled" }), env)).toBe(false);
    expect(holds(p, booked(-1), env)).toBe(false);
  });

  it("sends the booking text first, as a receipt, only while at least 15 minutes remain", () => {
    const first = workflow.edges.find((e) => e.from === "t_booked")!.to;
    const m = workflow.nodes.find((n) => n.id === first)!;
    expect(m).toMatchObject({ type: "message@1", to: { contact: "sms" }, content: "pre_call.booked", kind: "transactional", validity: { before: "appointment.starts_at", minLead: "15m" } });
  });

  it("skips the 24-hour reminder when booked less than a day out", () => {
    expect(way(workflow, "b_day_out", booked(30), env)).toBe("w_24h");
    expect(way(workflow, "b_day_out", booked(24), env)).toBe("w_24h");
    expect(way(workflow, "b_day_out", booked(23), env)).toBe("b_hour_out");
  });

  it("skips the 1-hour reminder when booked within the hour", () => {
    expect(way(workflow, "b_hour_out", booked(3), env)).toBe("w_1h");
    expect(way(workflow, "b_hour_out", booked(0.75), env)).toBe("x_done");
  });

  it("uses the no-link words for the 1-hour text when the booking has no meeting link", () => {
    expect(way(workflow, "b_link", booked(1, { meeting_url: "https://meet.test/x" }), env)).toBe("m_1h");
    expect(way(workflow, "b_link", booked(1), env)).toBe("m_1h_no_link");
    expect(way(workflow, "b_link", booked(1, { meeting_url: "" }), env)).toBe("m_1h_no_link");
  });

  it("moves a reminder that would land after the window closes to earlier that same day, never the next morning", () => {
    expect(workflow.sendWindow).toMatchObject({ zone: "contact", opens: "08:00", closes: "20:00", outside: "earlier_same_day" });
    const waits = workflow.nodes.filter((n) => n.type === "wait@1");
    expect(waits.map((w) => w.type === "wait@1" && w.until?.offset)).toEqual(["-24h", "-1h"]);
    expect(waits.every((w) => w.type === "wait@1" && w.fitSendWindow !== false)).toBe(true);
  });
});
