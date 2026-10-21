import { z } from "zod";
import { Predicate } from "../predicate";
import { wholeExpr } from "../template";
import { VarName, nodeBase } from "./common";
import { definePrimitive } from "./spec";

/**
 * branch@1: the question. Its outgoing edges are the answers, tried in order: each carries a `when` condition, and
 * exactly one, the last, is `else`. The first that holds is taken.
 */
export const Branch1 = z.object({ ...nodeBase, type: z.literal("branch@1") }).strict();
export type Branch1 = z.infer<typeof Branch1>;
export const branch1 = definePrimitive({
  name: "branch",
  version: 1,
  summary: "Chooses the way on: the first outgoing edge whose condition holds, else the else edge.",
  schema: Branch1,
  outcomes: () => ({ required: ["next"] }),
});

/**
 * A value `set` computes. A string may hold `{{…}}` (one whole `{{…}}` keeps its type). `$pick` looks a value up in
 * `cases` ("the face for each alert level"), `$if` chooses by a condition. Lists and objects are built of values.
 */
export type Value =
  | string | number | boolean | null
  | Value[]
  | { [key: string]: Value }
  | { $pick: string; cases: Record<string, Value>; else: Value }
  | { $if: Predicate; then: Value; else: Value };

export const Value: z.ZodType<Value> = z.lazy(() =>
  z.union([
    z.object({ $pick: z.string().refine((t) => !!wholeExpr(t), { message: "$pick is one {{…}} expression" }), cases: z.record(Value), else: Value }).strict(),
    z.object({ $if: Predicate, then: Value, else: Value }).strict(),
    z.string(), z.number(), z.boolean(), z.null(),
    z.array(Value),
    z.record(Value).refine((o) => !Object.keys(o).some((k) => k.startsWith("$")), { message: "an object's keys may not start with $ (only $pick and $if are operations)" }),
  ]),
);

/** set@1: computes one variable for later steps, `vars.<var>`. */
export const Set1 = z.object({ ...nodeBase, type: z.literal("set@1"), var: VarName, value: Value }).strict();
export type Set1 = z.infer<typeof Set1>;
export const set1 = definePrimitive({
  name: "set",
  version: 1,
  summary: "Computes one variable, vars.<var>, for later steps.",
  schema: Set1,
  outcomes: () => ({ required: ["next"] }),
  produces: (n) => [n.var],
});

/** call@1: starts another of this offer's workflows about the same subject; `with` is passed in as its `event`. */
export const Call1 = z.object({
  ...nodeBase,
  type: z.literal("call@1"),
  workflow: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, { message: "a workflow id is lowercase letters, digits and -" }),
  with: z.record(Value).optional(),
}).strict();
export type Call1 = z.infer<typeof Call1>;
export const call1 = definePrimitive({
  name: "call",
  version: 1,
  summary: "Starts another of this offer's workflows about the same subject, and goes on.",
  schema: Call1,
  outcomes: () => ({ required: ["next"] }),
  refs: (n) => ({ workflows: [n.workflow] }),
  effect: () => "internal",
});

/** end@1: the run is over, with a reason the dashboard shows ("done", "cancelled", "no_phone"). */
export const End1 = z.object({
  ...nodeBase,
  type: z.literal("end@1"),
  reason: z.string().regex(/^[a-z][a-z0-9_]*$/, { message: "a reason is a lowercase word with _" }),
}).strict();
export type End1 = z.infer<typeof End1>;
export const end1 = definePrimitive({
  name: "end",
  version: 1,
  summary: "Ends the run with a reason.",
  schema: End1,
  outcomes: () => ({ required: [] }),
});
