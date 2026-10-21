import { z } from "zod";
import { Duration } from "../duration";
import { Predicate } from "../predicate";
import { NodeId, TimeRule, VarName, hasDeadline, nodeBase } from "./common";
import { definePrimitive } from "./spec";
import { EventName } from "./trigger";

/**
 * Parks the run. Exactly one of:
 * - `for`: a length of time ("2h");
 * - `until` alone: a time rule ("24 hours before the call");
 * - `event`: a fact about this run's contact or appointment, with an optional `timeout` and / or `until` deadline;
 * - `reply`: the contact's next inbound message, with a deadline;
 * - `answer`: the answer to an earlier `ask` that went on without waiting, with an optional deadline.
 *
 * The premise is re-checked when the run wakes. An `until` time (a time wait's, or a deadline's) is moved into the
 * workflow's send window unless `fitSendWindow` is false. Waiting for something leaves by `arrived` or, at the
 * deadline, by `timeout`; what arrived is kept in `vars.<into>`.
 */
export const Wait1 = z.object({
  ...nodeBase,
  type: z.literal("wait@1"),
  for: Duration.optional(),
  until: TimeRule.optional(),
  event: z.object({
    type: EventName,
    match: Predicate.optional(),
    about: z.enum(["contact", "appointment"]),
    /** A time (template) after which an event that already happened counts at once; unset, only events after the step began. */
    since: z.string().optional(),
  }).strict().optional(),
  reply: z.object({
    channel: z.enum(["sms", "email", "any"]),
    /** After a reply, wait this long for the rest of what they are typing before going on. */
    settle: Duration.optional(),
  }).strict().optional(),
  answer: z.object({ ask: NodeId }).strict().optional(),
  timeout: Duration.optional(),
  into: VarName.optional(),
  fitSendWindow: z.boolean().optional(),
}).strict().superRefine((n, ctx) => {
  const kinds = (["for", "event", "reply", "answer"] as const).filter((k) => n[k] !== undefined);
  if (kinds.length > 1) ctx.addIssue({ code: "custom", message: `a wait waits for one thing, not ${kinds.join(" and ")}` });
  const waitsForSomething = kinds.some((k) => k !== "for");
  if (kinds.length === 0 && n.until === undefined) ctx.addIssue({ code: "custom", message: "a wait needs for, until, event, reply or answer" });
  if (kinds.includes("for") && n.until !== undefined) ctx.addIssue({ code: "custom", message: "a wait is for a length of time or until a time, not both" });
  if (!waitsForSomething && n.timeout !== undefined) ctx.addIssue({ code: "custom", message: "timeout goes with event, reply or answer" });
  if (!waitsForSomething && n.into !== undefined) ctx.addIssue({ code: "custom", message: "into goes with event, reply or answer" });
  if (n.reply && !hasDeadline(n)) ctx.addIssue({ code: "custom", message: "a wait for a reply needs a timeout or an until" });
  if (n.fitSendWindow !== undefined && n.until === undefined) ctx.addIssue({ code: "custom", message: "fitSendWindow goes with until" });
});
export type Wait1 = z.infer<typeof Wait1>;

/** What the wait is for: a time, or something arriving. */
export const waitKind = (n: Wait1): "for" | "until" | "event" | "reply" | "answer" =>
  n.event ? "event" : n.reply ? "reply" : n.answer ? "answer" : n.for ? "for" : "until";

export const wait1 = definePrimitive({
  name: "wait",
  version: 1,
  summary: "Parks the run for a time, until a time, or until an event, a reply or an answer arrives (with a deadline).",
  schema: Wait1,
  outcomes: (n) => {
    const k = waitKind(n);
    if (k === "for" || k === "until") return { required: ["next"] };
    return { required: hasDeadline(n) ? ["arrived", "timeout"] : ["arrived"] };
  },
  produces: (n) => (n.into ? [n.into] : []),
  refs: (n) => (n.answer ? { nodes: [n.answer.ask] } : {}),
});
