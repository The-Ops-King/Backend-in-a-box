import { z } from "zod";
import { Duration } from "../duration";
import { Predicate } from "../predicate";
import { NodeId, Template, TimeRule, VarName, hasDeadline, nodeBase } from "./common";
import { definePrimitive } from "./spec";
import { EventName } from "./trigger";

/**
 * Parks the run. Exactly one of:
 * - `for`: a length of time ("2h");
 * - `until` alone: a time rule ("24 hours before the call");
 * - `event`: a fact about this run's contact or appointment, with an optional `timeout` and / or `until` deadline;
 * - `reply`: the contact's next inbound message, with a deadline;
 * - `answer`: the answer to an earlier `ask`: one this run made and went on from (`ask`: its node), or one any run
 *   made and remembered under a tag (`tag`, e.g. "decision:{{appointment.id}}"), with an optional deadline. For a tag,
 *   an answer given at or after `since` counts at once; unset, only an answer given after the step began;
 * - `check`: a condition, looked at again every `every` until it holds, up to a deadline it must have ("look again
 *   every hour for up to a day"): leaves by `arrived` once it holds, by `timeout` when the deadline comes first;
 * - `person`: an operator. The run is paused for a person (`reason` says why) and stays so until an operator resumes
 *   it (it leaves by `resumed`) or ends it.
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
  answer: z.union([
    z.object({ ask: NodeId }).strict(),
    z.object({ tag: Template.min(1), since: Template.min(1).optional() }).strict(),
  ]).optional(),
  check: z.object({ holds: Predicate, every: Duration }).strict().optional(),
  person: z.object({ reason: z.string().regex(/^[a-z][a-z0-9_]*$/, { message: "a reason is a lowercase word with _" }) }).strict().optional(),
  timeout: Duration.optional(),
  into: VarName.optional(),
  fitSendWindow: z.boolean().optional(),
}).strict().superRefine((n, ctx) => {
  const kinds = (["for", "event", "reply", "answer", "check", "person"] as const).filter((k) => n[k] !== undefined);
  if (kinds.length > 1) ctx.addIssue({ code: "custom", message: `a wait waits for one thing, not ${kinds.join(" and ")}` });
  const waitsForSomething = kinds.some((k) => k !== "for" && k !== "person");
  if (kinds.length === 0 && n.until === undefined) ctx.addIssue({ code: "custom", message: "a wait needs for, until, event, reply, answer, check or person" });
  if (n.person && n.until !== undefined) ctx.addIssue({ code: "custom", message: "a wait for a person has no deadline: an operator resumes or ends the run" });
  if (n.check && !hasDeadline(n)) ctx.addIssue({ code: "custom", message: "a wait that looks again needs a timeout or an until, so it stops" });
  if (n.check && n.into !== undefined) ctx.addIssue({ code: "custom", message: "into goes with event, reply or answer" });
  if (kinds.includes("for") && n.until !== undefined) ctx.addIssue({ code: "custom", message: "a wait is for a length of time or until a time, not both" });
  if (!waitsForSomething && n.timeout !== undefined) ctx.addIssue({ code: "custom", message: "timeout goes with event, reply, answer or check" });
  if (!waitsForSomething && n.into !== undefined) ctx.addIssue({ code: "custom", message: "into goes with event, reply or answer" });
  if (n.reply && !hasDeadline(n)) ctx.addIssue({ code: "custom", message: "a wait for a reply needs a timeout or an until" });
  if (n.fitSendWindow !== undefined && n.until === undefined) ctx.addIssue({ code: "custom", message: "fitSendWindow goes with until" });
});
export type Wait1 = z.infer<typeof Wait1>;

/** What the wait is for: a time, or something arriving. */
export const waitKind = (n: Wait1): "for" | "until" | "event" | "reply" | "answer" | "check" | "person" =>
  n.event ? "event" : n.reply ? "reply" : n.answer ? "answer" : n.check ? "check" : n.person ? "person" : n.for ? "for" : "until";

export const wait1 = definePrimitive({
  name: "wait",
  version: 1,
  summary: "Parks the run for a time, until a time, until an event, a reply or an answer arrives or a condition holds (with a deadline), or for a person.",
  schema: Wait1,
  outcomes: (n) => {
    const k = waitKind(n);
    if (k === "for" || k === "until") return { required: ["next"] };
    if (k === "person") return { required: ["resumed"] };
    return { required: hasDeadline(n) ? ["arrived", "timeout"] : ["arrived"] };
  },
  produces: (n) => (n.into ? [n.into] : []),
  refs: (n) => (n.answer && "ask" in n.answer ? { nodes: [n.answer.ask] } : {}),
});
