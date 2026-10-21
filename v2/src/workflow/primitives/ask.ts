import { z } from "zod";
import { ContentKey, ContentRef, PostRef, SlackTarget, Template, VarName, contentKeysOf, deadline, hasDeadline, nodeBase } from "./common";
import { definePrimitive } from "./spec";

const AnswerValue = z.string().regex(/^[a-z][a-z0-9_]*$/, { message: "an answer value is a lowercase word with _" });

/**
 * How people answer: buttons (their labels are in the content), reactions on the post (an emoji name each), or a form
 * in a Slack modal (a form definition, by key).
 */
const Answers = z.union([
  z.object({ buttons: z.array(z.object({ value: AnswerValue, style: z.enum(["primary", "danger"]).optional() }).strict()).min(1).max(5) }).strict(),
  z.object({ reactions: z.array(z.string().regex(/^[a-z0-9_+-]+$/, { message: "an emoji name without colons" })).min(1).max(10) }).strict(),
  z.object({ form: ContentKey }).strict(),
]);

/**
 * ask@1: asks people in Slack and takes their answer into `vars.<into>` ({ value, person, at }, or null when nobody
 * answered in time). `then` says what the run does meanwhile:
 * - `wait`: parks on the question; leaves by `answered`, or by `timeout` at the deadline;
 * - `go_on`: posts and goes on (`next`); a later `wait` for its answer picks it up;
 * - `listen`: posts and goes on (`next`) while it listens. When the answer comes, wherever the run is parked, the run
 *   is taken along `answered`; at the deadline with no answer, along `expired`. Those paths may end the run, or return
 *   it to where it was by an edge to "$resume".
 */
export const Ask1 = z.object({
  ...nodeBase,
  type: z.literal("ask@1"),
  to: SlackTarget,
  content: ContentRef,
  answers: Answers,
  into: VarName,
  then: z.enum(["wait", "go_on", "listen"]),
  ...deadline,
  thread: PostRef.optional(),
  remember: Template.min(1).optional(),
}).strict().superRefine((n, ctx) => {
  if (n.then === "go_on" && hasDeadline(n)) ctx.addIssue({ code: "custom", message: "an ask that goes on has no deadline of its own; the wait for its answer has one" });
  if ("buttons" in n.answers) {
    const values = n.answers.buttons.map((b) => b.value);
    if (new Set(values).size !== values.length) ctx.addIssue({ code: "custom", path: ["answers", "buttons"], message: "each button has its own value" });
  }
});
export type Ask1 = z.infer<typeof Ask1>;

/** Outcomes an ask in `listen` takes the run along from wherever it is parked. */
export const INTERRUPT_OUTCOMES = ["answered", "expired"] as const;

export const ask1 = definePrimitive({
  name: "ask",
  version: 1,
  summary: "Asks people in Slack (buttons, reactions or a form) and takes the answer: waiting for it, or listening while the run goes on.",
  schema: Ask1,
  outcomes: (n) => {
    if (n.then === "wait") return { required: hasDeadline(n) ? ["answered", "timeout"] : ["answered"] };
    if (n.then === "go_on") return { required: ["next"] };
    return { required: hasDeadline(n) ? ["next", "answered", "expired"] : ["next", "answered"] };
  },
  produces: (n) => [n.into],
  refs: (n) => ({
    content: contentKeysOf(n.content),
    forms: "form" in n.answers ? [n.answers.form] : [],
    nodes: n.thread && "node" in n.thread ? [n.thread.node] : [],
  }),
  effect: () => "team",
});
