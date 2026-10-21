import { z } from "zod";
import { spanMs } from "@/engine/testkit";

/**
 * A scenario: what happens to one workflow, in order, on a fake clock. Times are ISO date-times or offsets from
 * `start` ("+0m", "+2h", "+2d3h30m"). Stored as JSON beside the workflow it exercises.
 */

const Rel = z.string().regex(/^(\+(\d+[wdhms])+|\d{4}-\d{2}-\d{2}T[\d:.]+(Z|[+-]\d\d:\d\d))$/, { message: 'a time is an ISO date-time or an offset from start: "+2h", "+2d3h"' });

const Contact = z.object({
  id: z.string().min(1),
  phone: z.string().nullable().optional(),
  email: z.string().nullable().optional(),
  timezone: z.string().nullable().optional(),
  dnd: z.object({ sms: z.boolean().optional(), email: z.boolean().optional(), all: z.boolean().optional() }).strict().optional(),
}).strict();

const EventStep = z.object({
  at: Rel,
  type: z.string().regex(/^[a-z][a-z_]*(\.[a-z_]+)+$/),
  contact: z.string().optional(),
  appointment: z.string().optional(),
  deal: z.string().optional(),
  payload: z.record(z.unknown()).default({}),
  dedupeKey: z.string().optional(),
  source: z.string().default("scenario"),
}).strict();

const ReplyStep = z.object({ at: Rel, reply: z.object({ contact: z.string(), channel: z.enum(["sms", "email"]), body: z.string() }).strict() }).strict();
const AnswerStep = z.object({
  at: Rel,
  answer: z.object({ node: z.string().optional(), tag: z.string().optional(), value: z.string(), person: z.string().default("U-operator") }).strict()
    .refine((a) => !!a.node !== !!a.tag, { message: "an answer names the node that asked or the tag, one of them" }),
}).strict();
const FailStep = z.object({
  at: Rel,
  fail: z.object({ port: z.enum(["crm", "messaging", "scheduling", "esign", "ai", "slack", "http"]), method: z.string().optional(), failure: z.enum(["transient", "auth", "permanent", "ambiguous"]), times: z.number().int().positive().default(1) }).strict(),
}).strict();
const OperatorStep = z.object({
  at: Rel,
  operator: z.union([z.object({ resume: z.enum(["resume", "retry", "skip"]) }).strict(), z.object({ end: z.string().regex(/^[a-z][a-z0-9_]*$/) }).strict()]),
}).strict();

/** The clock reaches a schedule trigger (by its node): one run for the offer, or one per person with the trigger's role. */
const ScheduleStep = z.object({ at: Rel, schedule: z.object({ node: z.string().min(1) }).strict() }).strict();

export const ScenarioStep = z.union([EventStep, ReplyStep, AnswerStep, FailStep, OperatorStep, ScheduleStep]);
export type ScenarioStep = z.infer<typeof ScenarioStep>;

export const Scenario = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  /** The workflow (its id) this scenario exercises: information, and a check that the right one was given. */
  workflow: z.string().min(1),
  start: z.string().datetime({ offset: true }),
  /** When to stop looking; unset, when no run is in flight (at most 60 days on). */
  until: Rel.optional(),
  offer: z.object({ zone: z.string(), settings: z.record(z.unknown()).default({}) }).strict(),
  /** What the workflow's delivery and CRM writes are set to while the scenario runs. */
  delivery: z.enum(["sandbox", "live"]).default("live"),
  crmWrites: z.enum(["dry", "real"]).default("real"),
  operator: z.object({ phones: z.array(z.string()).default([]), emails: z.array(z.string()).default([]) }).strict().default({}),
  contacts: z.array(Contact).default([]),
  /** Messages other workflows already sent these contacts, for the frequency cap. */
  priorSends: z.array(z.object({ contact: z.string(), at: Rel, channel: z.enum(["sms", "email"]).default("sms"), count: z.number().int().positive().default(1) }).strict()).default([]),
  /** The team, for schedules that run once per person with a role (each is that run's `person`). */
  people: z.array(z.object({ id: z.string().min(1), role: z.string().min(1) }).passthrough()).default([]),
  /**
   * What the parts not built yet answer, so a scenario can take every path: the facts.lookup queries that need the
   * projections (by query: one answer, or a list used in turn), the report definitions (by key: the rendered report, or a
   * list used in turn), and the AI port (classify answers and summarize results, used in turn; a classify answer is the
   * option, or { value, confidence, guesses? }).
   */
  fixtures: z.object({
    lookups: z.record(z.unknown()).default({}),
    reports: z.record(z.unknown()).default({}),
    classify: z.array(z.union([z.string(), z.object({
      value: z.string(), confidence: z.number().min(0).max(1),
      guesses: z.array(z.object({ value: z.string(), confidence: z.number().min(0).max(1) }).strict()).optional(),
    }).strict()])).default([]),
    summarize: z.array(z.unknown()).default([]),
  }).strict().default({}),
  steps: z.array(ScenarioStep).min(1),
  /** What must come out, checked after the run: the content keys that went out, in order, and how each run ended. */
  expect: z.object({
    sent: z.array(z.string()).optional(),
    held: z.array(z.string()).optional(),
    suppressed: z.array(z.string()).optional(),
    ends: z.array(z.string()).optional(),
    /**
     * Every outbox row in order, as "<time from start, no spaces> <status> <content key or kind>": "+1d2h sent
     * pre_call.reminder"; a Slack post said again in place ends " (edited)".
     */
    outbox: z.array(z.string()).optional(),
  }).strict().optional(),
}).strict();
export type Scenario = z.infer<typeof Scenario>;
export type ScenarioInput = z.input<typeof Scenario>;

/** A scenario time as an instant. */
export function timeOf(t: string, start: Date): Date {
  return t.startsWith("+") ? new Date(start.getTime() + spanMs(t.slice(1))) : new Date(t);
}

/** An instant as an offset from start: "+2d 3h 5m", "+0m", "-1h". */
export function relative(at: Date | string, start: Date): string {
  let ms = new Date(at).getTime() - start.getTime();
  const sign = ms < 0 ? "-" : "+";
  ms = Math.abs(ms);
  const d = Math.floor(ms / 86_400_000), h = Math.floor((ms % 86_400_000) / 3_600_000), m = Math.floor((ms % 3_600_000) / 60_000);
  const parts = [d ? `${d}d` : "", h ? `${h}h` : "", m || (!d && !h) ? `${m}m` : ""].filter(Boolean);
  return `${sign}${parts.join(" ")}`;
}
