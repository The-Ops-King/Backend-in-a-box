/** D304: a step that reads a remembered value some path to it never sets is found when the workflow is saved, not when a person books. */
import { describe, it, expect } from "vitest";
import { unsetReads } from "./unset-vars";
import type { Definition } from "./definition";

const def = (nodes: unknown[], edges: [string, string][]) => ({ nodes, edges: edges.map(([from, to]) => ({ from, to })) }) as unknown as Definition;
const T = { id: "t", type: "trigger", event: "appointment.booked" };
const post = (id: string, template: string) => ({ id, type: "slack_post", channel: "C1", template });

describe("D304: values read on a path that never sets them", () => {
  it("PMU's Call booked v15: the follow-up path reached the card without its headline; the main path is fine", () => {
    const d = def([T, { id: "h5", type: "set_var", key: "head", value: "New call" }, { id: "fu_v", type: "set_var", key: "card", value: "{}" }, { id: "b", type: "branch" }, post("n4", "*{{vars.head}}* {{contact.name}}")],
      [["t", "b"], ["b", "h5"], ["b", "fu_v"], ["h5", "n4"], ["fu_v", "n4"]]);
    expect(unsetReads(d)).toEqual([{ node: "n4", title: undefined, var: "head", missing_on: "fu_v" }]);
    const fixed = def([T, { id: "h5", type: "set_var", key: "head", value: "New call" }, { id: "fu_v", type: "set_var", key: "card", value: "{}" }, { id: "b", type: "branch" }, post("n4", "*{{vars.head}}*")],
      [["t", "b"], ["b", "fu_v"], ["fu_v", "h5"], ["b", "h5"], ["h5", "n4"]]);
    expect(unsetReads(fixed)).toEqual([]);
  });

  it("a fallback, a may-be-absent pipe, a condition, an exists guard or the step's own value is not a read", () => {
    const d = def([T,
      post("a", "{{vars.x | default:none}} {{vars.y | each:\"• {{item}}\"}}"),
      { id: "b", type: "check", when: { eq: ["{{vars.z}}", 1] }, else_exit: "no" },
      { ...post("c", "{{vars.w}}"), only_if: { exists: "vars.w" } },
      { id: "e", type: "wait_for_event", event: "appointment.booked", into: "late", match: { eq: ["{{vars.late.x}}", 1] } }],
      [["t", "a"], ["a", "b"], ["b", "c"], ["c", "e"]]);
    expect(unsetReads(d)).toEqual([]);
  });

  it("what an AI step, a dotted into, an ensure_contact or a loop sets counts; a loop back does not lose it", () => {
    const d = def([T, { id: "a1", type: "classify", into: "vars.classify.kind" }, { id: "c0", type: "ensure_contact" }, { id: "an", type: "analyze", into: ["notes", "rubric"] },
      post("p", "{{vars.classify.kind}} {{vars.c0.action}} {{vars.notes.summary}} {{vars.rubric.score}}"), { id: "w", type: "wait", duration: "1h" }],
      [["t", "a1"], ["a1", "c0"], ["c0", "an"], ["an", "p"], ["p", "w"], ["w", "p"]]);
    expect(unsetReads(d)).toEqual([]);
  });
});
