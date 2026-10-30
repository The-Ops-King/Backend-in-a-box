/** D238: the cancel post names the rebook task only when the offer makes GHL tasks (crm.tasks). */
import { describe, it, expect } from "vitest";
import { templates } from "@/templates";
import { parseDefinition } from "./definition";
import { evaluate } from "./predicate";
import { render } from "./template";
import { switchOn } from "./setting-defaults";

const def = parseDefinition(templates.find((t) => t.slug === "call-cancelled")!.definition);
const node = (id: string) => def.nodes.find((n) => n.id === id) as Record<string, unknown> & { type: string };

const post = (bindings: Record<string, string>) => {
  const ctx: Record<string, unknown> = { setting: { tasks: switchOn(bindings, "crm.tasks") }, crm: { location_id: "LOC" }, contact: { name: "Mina Lee", ghl_contact_id: "G1", phone: "+1" },
    appointment: { closer: { name: "Sam Closer" }, starts_at: "2026-10-27T22:00:00Z", cancelled_by: "contact", cancel_reason: "conflict" }, vars: {} };
  const env = { tz: "UTC", companyTz: "UTC" };
  const v = node("v_task") as unknown as { when: never; value: string; else_value: string; key: string };
  (ctx.vars as Record<string, unknown>)[v.key] = render(evaluate(v.when, ctx) ? v.value : v.else_value, ctx, env);   // as the executor's set_var
  return render(node("n7").template as string, ctx, env);
};

describe("D238: the rebook task line", () => {
  it("is on the cancel post when the offer makes tasks (the default), and gone when crm.tasks is off", () => {
    expect(def.edges.filter((e) => e.to === "n7").map((e) => e.from)).toEqual(["v_task"]);
    expect(post({})).toMatch(/\n\*Phone:\* \+1\n\*Rebook task:\* due in 1 day for Sam Closer$/);
    expect(post({ "crm.tasks": "off" })).toMatch(/\n\*Phone:\* \+1$/);
  });
});
