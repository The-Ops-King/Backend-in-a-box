import { z } from "zod";
import { ClockTime, Duration, Offset } from "../duration";
import { wholeExpr } from "../template";

/** A node's id: stable across versions, so runs, diffs and the dashboard can point at it. `$` is reserved for edge targets. */
export const NodeId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/, { message: "a node id is letters, digits, _ and -, starting with a letter or digit" });

/** Fields every node has, whatever its primitive. */
export const nodeBase = {
  id: NodeId,
  /** The words the dashboard shows for this step. */
  title: z.string().min(1).max(200),
  /**
   * What happens once a failing step's retries are spent: skip it and go on, or hold the run on it for a person.
   * Unset, the engine decides from whether anything later reads what the step produces.
   */
  onFailure: z.enum(["skip", "hold"]).optional(),
  /**
   * Settings this step can do without: when any of them has no value, the step is skipped and the run goes on by its
   * `next` edge (what it would have kept in `into` is null). They are listed as optional in what the workflow needs,
   * so enabling does not wait for them; nothing fills them in from code.
   */
  skipWhenUnset: z.array(z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$/, { message: 'a setting key, such as "crm.stage_setter_dq"' })).min(1).optional(),
};

/** Any text that may hold `{{…}}`. What is inside is checked by the validator, not here. */
export const Template = z.string();

/** A name inside the context: `vars.<name>`. */
export const VarName = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/, { message: "a variable name is lowercase letters, digits and _" });

/** A piece of approved content, by its key in the offer's content table: "pre_call.reminder_24h". Words never sit in a workflow. */
export const ContentKey = z.string().regex(/^[a-z0-9_]+(\.[a-z0-9_]+)*$/, { message: 'a content key is lowercase words joined by dots and underscores: "pre_call.reminder_24h"' });

/**
 * Which content a step uses: one key, or one of several keys chosen by a value ("the headline for each kind of alert").
 * Every key is written out, so the content a workflow needs is known before it runs.
 */
export const ContentRef = z.union([
  ContentKey,
  z.object({
    pick: Template.refine((t) => !!wholeExpr(t), { message: "pick is one {{…}} expression" }),
    cases: z.record(ContentKey).refine((c) => Object.keys(c).length > 0, { message: "pick needs at least one case" }),
    else: ContentKey,
  }).strict(),
]);
export type ContentRef = z.infer<typeof ContentRef>;
export const contentKeysOf = (c: ContentRef): string[] => (typeof c === "string" ? [c] : [...Object.values(c.cases), c.else]);

/** A template that is exactly one setting: where something posts is configured per offer, never written into a workflow. */
export const SettingTemplate = Template.refine((t) => wholeExpr(t)?.root === "setting" && wholeExpr(t)?.filters.length === 0, {
  message: 'this must be one setting, written "{{setting.<key>}}"',
});

/** One `{{event.<field>}}` and nothing else: a value the triggering fact carries. */
const FactValue = Template.refine((t) => wholeExpr(t)?.root === "event" && wholeExpr(t)?.path !== "event" && wholeExpr(t)?.filters.length === 0, {
  message: 'this must be one value of the triggering fact, written "{{event.<field>}}"',
});

/**
 * Slack: where a post goes.
 * - `channel`: one setting. With `fallbackChannel` (another setting), the first may be left unset by the offer, and the
 *   post goes to the fallback while it is (the first is then an optional setting).
 * - `channelFromFact`: the channel the triggering fact names ({{event.channel}}), taken only when, at the moment of
 *   sending, it is one of the offer's own Slack channel settings (slack.channel.*). Any other value is never posted to:
 *   the post is held with an alert. The fact chooses among the offer's settings; it never supplies a channel of its own.
 * - `dm`: a person's DM, with an optional fallback channel when they are not in Slack.
 */
export const SlackTarget = z.union([
  z.object({ channel: SettingTemplate, fallbackChannel: SettingTemplate.optional() }).strict(),
  z.object({ channelFromFact: FactValue }).strict(),
  z.object({ dm: Template.min(1), fallbackChannel: SettingTemplate.optional() }).strict(),
]);
export type SlackTarget = z.infer<typeof SlackTarget>;

/** An earlier Slack post: one this run made (by the node that made it) or one any run remembered under a tag. */
export const PostRef = z.union([z.object({ node: NodeId }).strict(), z.object({ tag: Template.min(1) }).strict()]);
export type PostRef = z.infer<typeof PostRef>;

const ANCHOR_PATH = /^[a-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)+$/;
/** One `{{…}}` and nothing around it; what is inside is checked by the validator like any template. */
const ONE_EXPR = /^\{\{(?:(?!\{\{|\}\}).)+\}\}$/;

/** "day_before@19:00", "day_of@08:00", "day_after@09:00": that clock time on the anchor's day, or the day either side. */
export const DayAt = z.string().regex(/^day_(before|of|after)@([01]\d|2[0-3]):[0-5]\d$/, { message: 'a day rule is "day_before@HH:MM", "day_of@HH:MM" or "day_after@HH:MM"' });

/** Whose clock a time is read on. */
export const Zone = z.enum(["contact", "offer"]);

/**
 * A point in time worked out from an anchor: "24 hours before the call", "7pm the day before the call", "2 hours from
 * now". It is recomputed whenever the anchor moves (a rescheduled call moves its reminders).
 */
export const TimeRule = z.object({
  /**
   * "now" (when the step is reached), the path of a date-time in the context ("appointment.starts_at"), or one whole
   * `{{…}}` expression that gives one, for time arithmetic: "{{appointment.booked_at | plus:5m}}".
   */
  anchor: z.string().refine((a) => a === "now" || ANCHOR_PATH.test(a) || ONE_EXPR.test(a), {
    message: 'anchor is "now", a path such as "appointment.starts_at", or one {{…}} expression',
  }),
  /** A shift from the anchor ("-24h") or a clock time on its day or a day either side ("day_before@19:00"). Unset: the anchor itself. */
  offset: z.union([Offset, DayAt]).optional(),
  /** Which zone clock times and earliest / latest are read in. */
  zone: Zone,
  /** A computed time before this clock time moves later to it, the same day ("not before 8am"). */
  earliest: ClockTime.optional(),
  /** A computed time after this clock time moves earlier to it, the same day ("not after 9pm"). */
  latest: ClockTime.optional(),
  /** When the anchor is closer than `minLead` once the step is reached, the time is `fallback` from then instead. */
  guard: z.object({ minLead: Duration, fallback: Offset.refine((o) => o.startsWith("+"), { message: "fallback is a time after now: +15m" }) }).strict().optional(),
}).strict().refine((r) => !(r.earliest && r.latest) || r.earliest < r.latest, { message: "earliest must be before latest" });
export type TimeRule = z.infer<typeof TimeRule>;

/** A deadline for something waited on: a length of time from when the step is reached, a time rule, or both (whichever comes first). */
export const deadline = { timeout: Duration.optional(), until: TimeRule.optional() };
export const hasDeadline = (n: { timeout?: string; until?: unknown }) => n.timeout !== undefined || n.until !== undefined;
