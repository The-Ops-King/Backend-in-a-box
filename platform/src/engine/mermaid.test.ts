import { describe, it, expect } from "vitest";
import { toMermaid } from "./mermaid";
import { parseDefinition } from "./definition";
import { templates } from "@/templates";
describe("toMermaid", () => {
  it("every template renders every node and edge", () => {
    for (const t of templates) {
      const def = parseDefinition(t.definition); const m = toMermaid(def);
      expect(m.startsWith("flowchart TD")).toBe(true);
      for (const n of def.nodes) expect(m).toContain(`\n  ${n.id}`);
      expect((m.match(/-->/g) ?? []).length).toBe(def.edges.length);
    }
  });
  it("colors executed steps and outlines the current node", () => {
    const def = parseDefinition(templates[0].definition);
    const m = toMermaid(def, [{ node_id: "t1", status: "ok" }, { node_id: "n1", status: "failed" }], "n1");
    expect(m).toMatch(/class t1 ok/); expect(m).toMatch(/class n1 failed/); expect(m).toMatch(/class n1 here/);
  });
});
