import { z } from "zod";
import { Template } from "../primitives/common";
import { EventName } from "../primitives/trigger";
import { defineAction } from "./define";

/** The named read-only questions `facts.lookup` may ask, with the filters each takes (templates; a blank one is no filter). */
export const LOOKUP_QUERIES = {
  appointments_for_contact: ["booked_since", "booked_until", "starts_since", "starts_until", "kind", "source", "status", "status_not", "exclude", "order", "closer"],
  calls_for_contact: ["since", "until", "provider", "caller", "kind", "connected"],
  call_conversation: ["recording_id", "gap_min"],
  last_event: ["type", "since", "until", "about"],
} as const;
type LookupQuery = keyof typeof LOOKUP_QUERIES;

/** Our own facts and runs: nothing here leaves the platform. */
export const internalActions = [
  defineAction({
    verb: "facts.record",
    summary: "Appends a fact to the offer's event log, about this run's subjects (or the appointment named). `startsWorkflows`: workflows listening for it start, as if it had arrived from a vendor; this run's own workflow is never one of them unless `startsThisWorkflow` says so (a run handing its work on to a new run of itself, within the depth limit).",
    effect: "internal",
    params: z.object({
      type: EventName,
      data: z.record(Template),
      appointment: Template.optional(),
      startsWorkflows: z.boolean(),
      startsThisWorkflow: z.boolean().optional(),
    }).strict().refine((p) => !p.startsThisWorkflow || p.startsWorkflows, { message: "startsThisWorkflow goes with startsWorkflows: true", path: ["startsThisWorkflow"] }),
    returns: "none",
  }),
  defineAction({
    verb: "facts.lookup",
    summary: "Asks one of the named read-only questions of the facts and gives back the answer.",
    effect: "read",
    params: z.object({
      query: z.enum(Object.keys(LOOKUP_QUERIES) as [LookupQuery, ...LookupQuery[]]),
      params: z.record(Template),
    }).strict().superRefine((p, ctx) => {
      const allowed = LOOKUP_QUERIES[p.query] as readonly string[];
      for (const k of Object.keys(p.params)) if (!allowed.includes(k)) ctx.addIssue({ code: "custom", path: ["params", k], message: `${p.query} takes ${allowed.join(", ")}, not ${k}` });
    }),
    returns: "required",
  }),
  defineAction({
    verb: "facts.record_outcome",
    summary: "Records how a call went (showed, no-show, ...) as a fact: from what the engine saw, or a person's answer. It starts nothing by itself.",
    effect: "internal",
    params: z.object({
      appointment: Template.min(1),
      outcome: Template.min(1),
      callOutcome: Template.optional(),
      notes: Template.optional(),
      source: z.enum(["engine", "person"]),
      person: Template.optional(),
    }).strict(),
    returns: "none",
  }),
  defineAction({
    verb: "runs.pause_others",
    summary: "Pauses this contact's (or this appointment's) other active runs, in every workflow: a person took over.",
    effect: "internal",
    params: z.object({ scope: z.enum(["contact", "appointment"]) }).strict(),
    returns: "none",
  }),
];
