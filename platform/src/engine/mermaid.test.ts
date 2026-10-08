import { describe, it, expect } from "vitest";
import { toMermaid } from "./mermaid";
import { collapsePlumbing, exitWords } from "./describe";
import { parseDefinition } from "./definition";
import { templates } from "@/templates";
describe("toMermaid", () => {
  it("every template renders every node and edge", () => {
    for (const t of templates) {
      const def = parseDefinition(t.definition); const m = toMermaid(def);
      expect(m.startsWith("flowchart TD")).toBe(true);
      const done = (n: { type: string; reason?: string }) => n.type === "exit" && exitWords(n.reason ?? "").startsWith("Done");
      for (const n of def.nodes) if (n.type !== "set_var" && !done(n)) expect(m).toContain(`\n  ${n.id}`);   // plumbing and plain done-exits are left out of the chart
      for (const n of def.nodes) if (n.type === "set_var" || done(n)) expect(m).not.toContain(`\n  ${n.id}`);
      const c = collapsePlumbing(def); const doneIds = new Set(c.nodes.filter(done).map((n) => n.id));
      expect((m.match(/-->/g) ?? []).length).toBe(c.edges.filter((e) => !doneIds.has(e.to) && !doneIds.has(e.from)).length);
    }
  });
  it("a check's else-exit is drawn as a dashed edge to the exit node", () => {
    const def = parseDefinition(templates.find((t) => t.slug === "new-lead")!.definition);
    const m = toMermaid(def);
    expect(m).toMatch(/n1_else\(\(\("Stop: no phone number"\)\)\)/); expect(m).toMatch(/n1 -\.->\|if not\| n1_else/);
  });
  it("colors executed steps and outlines the current node", () => {
    const def = parseDefinition(templates[0].definition);
    const m = toMermaid(def, [{ node_id: "t1", status: "ok" }, { node_id: "n1", status: "failed" }], "n1");
    expect(m).toMatch(/class t1 ok/); expect(m).toMatch(/class n1 failed/); expect(m).toMatch(/class n1 here/);
  });
});
