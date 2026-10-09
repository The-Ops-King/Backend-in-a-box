import { describe, it, expect } from "vitest";
import { chartOf } from "./words";
import { parseDefinition } from "@/engine/definition";
import { templates } from "@/templates";

const company = { name: "Acme", timezone: "America/Chicago" };

describe("chartOf", () => {
  it("a filter (check) carries no else pill: what happens otherwise lives in its detail line only", () => {
    let checks = 0;
    for (const t of templates) {
      const chart = chartOf(parseDefinition(t.definition), company);
      for (const n of chart.nodes.filter((n) => n.kind === "check")) {
        checks++;
        expect(n).not.toHaveProperty("stop");
        expect(n.detail).toMatch(/Otherwise the run/);
      }
    }
    expect(checks).toBeGreaterThan(0);
  });
  it("a conditional (branch) keeps its 'otherwise' edge", () => {
    const elses = templates.flatMap((t) => chartOf(parseDefinition(t.definition), company).edges.filter((e) => e.else));
    expect(elses.length).toBeGreaterThan(0);
    for (const e of elses) { expect(e.else).toBe(true); expect(e.label.length).toBeGreaterThan(0); }
  });
});
