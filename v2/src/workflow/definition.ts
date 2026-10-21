import { z } from "zod";
import { ClockTime, Duration } from "./duration";
import { Predicate } from "./predicate";
import { NodeId, Template, Zone } from "./primitives/common";
import type { Action1, Ask1, Branch1, Call1, End1, Message1, Report1, Set1, Trigger1, Wait1 } from "./primitives";

/**
 * A workflow definition, stored as JSON: the offer's own, complete and self-contained. Reading it says everything the
 * workflow does; nothing is looked up from a template or filled in from code when it runs.
 *
 * Whether its sends are real (sandbox or live) and whether its CRM writes are real (dry or real) are not part of the
 * definition: they are set beside it, by Tyler only, so no edit to a definition can unlock a send.
 */

/** The edge target that returns a run to the step a listening `ask` took it from. */
export const RESUME = "$resume";

/**
 * A way from one node to another. `on` names which of the node's outcomes it is ("next" when unset; a wait for a reply
 * also has "arrived" and "timeout"). Edges from a `branch` carry `when` or, the last one, `else`: the first that holds
 * is taken. `label` is the words the chart shows on it.
 */
export const Edge = z.object({
  from: NodeId,
  to: z.union([NodeId, z.literal(RESUME)]),
  on: z.string().regex(/^[a-z][a-z_]*$/).optional(),
  when: Predicate.optional(),
  else: z.literal(true).optional(),
  label: z.string().min(1).max(120).optional(),
}).strict().refine((e) => !(e.when && e.else), { message: "an edge has when or else, not both" });
export type Edge = z.infer<typeof Edge>;

/**
 * Whether the same subject can go through again:
 * - once_per_contact, once_per_appointment, once_per_deal: once ever for that subject;
 * - once_per_contact_per_window: once per contact within `window` ("90d");
 * - always: every trigger is a run.
 * `key` (a template) refines the once: "{{appointment.starts_at}}" makes the same appointment at a new time a new run
 * once the earlier one has finished.
 */
export const Reentry = z.object({
  policy: z.enum(["once_per_contact", "once_per_appointment", "once_per_deal", "once_per_contact_per_window", "always"]),
  window: Duration.optional(),
  key: Template.min(1).optional(),
}).strict()
  .refine((r) => (r.policy === "once_per_contact_per_window") === (r.window !== undefined), { message: "window goes with once_per_contact_per_window, and only with it", path: ["window"] })
  .refine((r) => r.policy !== "always" || r.key === undefined, { message: "a key refines a once policy; always has nothing to refine", path: ["key"] });

/**
 * What must still be true for the run to go on ("the call is still on"). It is checked against freshly read facts
 * each time the run wakes from a wait and before each step that reaches outside; when it no longer holds, the run
 * ends with `endReason`.
 */
export const Premise = z.object({
  label: z.string().min(1).max(120),
  holds: Predicate,
  endReason: z.string().regex(/^[a-z][a-z0-9_]*$/),
}).strict();

/**
 * When human-sounding messages to the contact may go out, on the contact's clock or the offer's (1 Monday to 7 Sunday).
 *
 * A wait's `until` time that lands outside it (unless the wait sets fitSendWindow: false) is moved: before opening, to opening that day; after
 * closing, by `outside`: `earlier_same_day` moves it to just before closing that same day (a reminder before an
 * evening call still goes the right day, never the next morning), `next_open` to the next opening. A human message
 * reached outside the window waits for it to open. `transactional` says whether receipts may go at any hour.
 */
export const SendWindow = z.object({
  zone: Zone,
  opens: ClockTime,
  closes: ClockTime,
  days: z.array(z.number().int().min(1).max(7)).min(1).optional(),
  outside: z.enum(["earlier_same_day", "next_open"]),
  transactional: z.enum(["any_hour", "in_window"]),
}).strict().refine((w) => w.opens < w.closes, { message: "the window opens before it closes" });
export type SendWindow = z.infer<typeof SendWindow>;

/** What a message to the contact is when its step does not say: human or transactional, and what to do once stale. */
export const Delivery = z.object({
  kind: z.enum(["human", "transactional"]).default("human"),
  whenStale: z.literal("skip").default("skip"),
}).strict();

/** The workflow's own fields, everything but its graph. */
export const Header = z.object({
  schema: z.literal(2),
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/, { message: "a workflow id is lowercase letters, digits and -" }),
  name: z.string().min(1).max(120),
  description: z.string().max(2000).optional(),
  /** The template and version this was first copied from. Information only: nothing is ever read from it. */
  origin: z.object({ template: z.string().min(1), version: z.number().int().positive() }).strict().optional(),
  reentry: Reentry,
  premise: Premise.optional(),
  sendWindow: SendWindow.optional(),
  delivery: Delivery.default({}),
}).strict();

export type Node = Trigger1 | Wait1 | Branch1 | Set1 | Message1 | Ask1 | Action1 | Report1 | Call1 | End1;
export type Workflow = z.infer<typeof Header> & { nodes: Node[]; edges: Edge[] };
