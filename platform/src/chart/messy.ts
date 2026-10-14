import { parseDefinition, type Definition } from "@/engine/definition";

/**
 * A test and screenshot fixture (D111), the shape the tidy layout cannot draw: a cross-link from inside one branch into the
 * middle of another branch's chain, a loop back to an earlier step, branches five deep, and a step nothing leads to.
 */
export function messy(): Definition {
  const tag = (id: string, title: string) => ({ id, type: "tags", title, add: [id] });
  const when = (t: string) => ({ eq: ["{{contact.source}}", t] });
  const nodes: unknown[] = [{ id: "t", type: "trigger", event: "appointment.booked" }, tag("a", "Tag them as booked"), { id: "f1", type: "branch", title: "Where did they come from?" },
    { id: "x1", type: "branch", title: "Already a customer?" }, tag("x2", "Tag them as a new customer"), tag("y1", "Thank the referrer"), tag("y2", "Tag them as a referral"), tag("y3", "Note who referred them"), { id: "lb", type: "branch", title: "Try the booking again?" },
    tag("orphan", "A step nothing leads to"), { id: "done", type: "exit", reason: "done" }];
  const edges: unknown[] = [{ from: "t", to: "a" }, { from: "a", to: "f1" },
    { from: "f1", to: "x1", label: "ads", when: when("ads") }, { from: "f1", to: "y1", label: "referral", when: when("referral") }, { from: "f1", to: "n1", label: "somewhere else", else: true },
    { from: "x1", to: "y2", label: "a customer", when: when("customer") }, { from: "x1", to: "x2", else: true }, { from: "x2", to: "done" },
    { from: "y1", to: "y2" }, { from: "y2", to: "y3" }, { from: "y3", to: "lb" },
    { from: "lb", to: "a", label: "try again", when: when("again") }, { from: "lb", to: "done", else: true },
    { from: "orphan", to: "done" }];
  for (let i = 1; i <= 5; i++) {
    nodes.push({ id: `n${i}`, type: "branch", title: `Level ${i}: go deeper?` }, tag(`s${i}`, `Tag them level ${i}`), { id: `x_${i}`, type: "exit", reason: "done" });
    edges.push({ from: `n${i}`, to: i < 5 ? `n${i + 1}` : "done", label: `deeper than ${i}`, when: when(`d${i}`) }, { from: `n${i}`, to: `s${i}`, else: true }, { from: `s${i}`, to: `x_${i}` });
  }
  return parseDefinition({ schema: 1, reentry: "always", nodes, edges } as unknown as Definition);
}
