import { z } from "zod";
import { ContentKey, Template, VarName, nodeBase } from "./common";
import { definePrimitive } from "./spec";

/**
 * report@1: renders one of the offer's report definitions (a wrap-up, the leaderboard, the health findings, the closers'
 * unfiled days) into `vars.<into>` = { body, empty, numbers, period }. It posts nothing: a `message` after it does,
 * and a `branch` on `vars.<into>.empty` keeps a quiet day quiet.
 */
export const Report1 = z.object({
  ...nodeBase,
  type: z.literal("report@1"),
  report: ContentKey,
  /** just_ended: the period that just finished (yesterday, last week); in_progress: the period so far. */
  period: z.enum(["just_ended", "in_progress"]),
  params: z.record(Template).optional(),
  into: VarName,
}).strict();
export type Report1 = z.infer<typeof Report1>;

export const report1 = definePrimitive({
  name: "report",
  version: 1,
  summary: "Renders a report definition, by key, into a variable for a message to post.",
  schema: Report1,
  outcomes: () => ({ required: ["next"] }),
  produces: (n) => [n.into],
  refs: (n) => ({ reports: [n.report] }),
  effect: () => "read",
});
