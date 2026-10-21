import { z } from "zod";
import { ClockTime, Duration } from "../duration";
import { Predicate } from "../predicate";
import { nodeBase } from "./common";
import { definePrimitive } from "./spec";

/** A canonical event name: "appointment.booked", "payment.failed". Vendors' own names never reach a workflow. */
export const EventName = z.string().regex(/^[a-z][a-z_]*(\.[a-z_]+)+$/, { message: 'an event is a canonical name such as "appointment.booked"' });

/**
 * The clock: every interval, or at a time of day on the offer's clock (on given weekdays, 1 Monday to 7 Sunday, or a
 * day of the month). `for` says what each run is about: the offer (one run), or each person with a role (one run each).
 */
export const Schedule = z.object({
  every: Duration.optional(),
  at: ClockTime.optional(),
  days: z.array(z.number().int().min(1).max(7)).min(1).optional(),
  dayOfMonth: z.number().int().min(1).max(28).optional(),
  for: z.union([z.literal("offer"), z.object({ role: z.string().regex(/^[a-z][a-z_]*$/) }).strict()]).default("offer"),
}).strict()
  .refine((s) => (s.every === undefined) !== (s.at === undefined), { message: "a schedule is either every <interval> or at <time>" })
  .refine((s) => s.at !== undefined || (s.days === undefined && s.dayOfMonth === undefined), { message: "days and dayOfMonth go with at, not every" });

const On = z.union([
  /** A fact arrived: "appointment.booked", narrowed by `match` over the event and its subjects. */
  z.object({ event: EventName, match: Predicate.optional() }).strict(),
  z.object({ schedule: Schedule }).strict(),
  /** Started by a person from the dashboard or Slack, about one subject. */
  z.object({ manual: z.object({ about: z.enum(["contact", "appointment", "deal", "offer"]) }).strict() }).strict(),
]);

export const Trigger1 = z.object({ ...nodeBase, type: z.literal("trigger@1"), on: On }).strict();
export type Trigger1 = z.infer<typeof Trigger1>;

export const trigger1 = definePrimitive({
  name: "trigger",
  version: 1,
  summary: "Starts a run: on an event, on the clock, or by hand. A workflow may have several.",
  schema: Trigger1,
  outcomes: () => ({ required: ["next"] }),
});
