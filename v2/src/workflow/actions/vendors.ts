import { z } from "zod";
import { ContentKey, PostRef, Template } from "../primitives/common";
import { defineAction } from "./define";

const Emojis = z.array(z.string().regex(/^[a-z0-9_+-]+$/, { message: "an emoji name without colons" })).min(1);

/** Scheduling, e-sign, AI, Slack and outbound HTTP actions. */
export const vendorActions = [
  defineAction({
    verb: "scheduling.cancel",
    summary: "Cancels a booking at the scheduling vendor. The vendor may email the invitee, so it reaches the contact and is behind the send lock.",
    effect: "contact",
    params: z.object({ appointment: Template.min(1), reason: Template.optional() }).strict(),
    returns: "none",
  }),
  defineAction({
    verb: "scheduling.set_status",
    summary: "Sets a booking's status at the scheduling vendor: confirmed, showed or no-show.",
    effect: "crm",
    params: z.object({ appointment: Template.min(1), status: z.enum(["confirmed", "showed", "noshow"]) }).strict(),
    returns: "none",
  }),
  defineAction({
    verb: "esign.send",
    summary: "Sends an agreement from an e-sign template to the contact. Gives back { id }.",
    effect: "contact",
    params: z.object({ template: Template.min(1), sender: Template.optional(), name: Template.optional() }).strict(),
    returns: "optional",
  }),
  defineAction({
    verb: "esign.void",
    summary: "Voids a sent agreement, which the vendor may tell the contact about.",
    effect: "contact",
    params: z.object({ agreement: Template.min(1) }).strict(),
    returns: "none",
  }),
  defineAction({
    verb: "ai.classify",
    summary: "Picks one of `options` for the input, by the prompt (content). Below `threshold`, or more doubtful than `ambiguityMax`, the answer is `unclear`. Gives back { value, confidence, guesses }.",
    effect: "read",
    params: z.object({
      input: Template.min(1),
      /** What it is read against (what we sent, for a reply). */
      context: Template.optional(),
      prompt: ContentKey,
      options: z.array(z.string().regex(/^[a-z][a-z0-9_]*$/)).min(2),
      threshold: z.number().min(0).max(1),
      ambiguityMax: z.number().min(0).max(1).optional(),
      unclear: z.string().regex(/^[a-z][a-z0-9_]*$/),
    }).strict().refine((p) => p.options.includes(p.unclear), { message: "unclear must be one of the options" }),
    returns: "required",
    content: (p) => [p.prompt],
  }),
  defineAction({
    verb: "ai.summarize",
    summary: "Reads a document (a transcript, an intake) against a prompt (content) and gives back its answer, as JSON or text. `optional`: when the AI cannot run, the step is skipped.",
    effect: "read",
    params: z.object({
      prompt: ContentKey,
      input: Template.min(1),
      format: z.enum(["json", "text"]),
      maxTokens: z.number().int().positive().optional(),
      optional: z.boolean().optional(),
    }).strict(),
    returns: "required",
    content: (p) => [p.prompt],
  }),
  defineAction({
    verb: "slack.react",
    summary: "Puts reactions on an earlier Slack post.",
    effect: "team",
    params: z.object({ post: PostRef, emojis: Emojis }).strict(),
    returns: "none",
  }),
  defineAction({
    verb: "slack.unreact",
    summary: "Takes the app's own reactions off an earlier Slack post.",
    effect: "team",
    params: z.object({ post: PostRef, emojis: Emojis }).strict(),
    returns: "none",
  }),
  defineAction({
    verb: "slack.update_post",
    summary: "Rewrites an earlier Slack post with other content.",
    effect: "team",
    params: z.object({ post: PostRef, content: ContentKey }).strict(),
    returns: "none",
    content: (p) => [p.content],
  }),
  defineAction({
    verb: "http.request",
    summary: "Calls a URL (a Zap, a Make scenario, Airtable). `{{secret.<key>}}` is allowed in its url, headers and body and nowhere else. Gives back the response.",
    effect: "external",
    params: z.object({
      url: Template.regex(/^(https:\/\/|\{\{)/, { message: "the url is https:// or comes from a setting" }),
      method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
      headers: z.record(Template).optional(),
      body: z.unknown().optional(),
      onError: z.enum(["fail", "skip"]),
    }).strict(),
    returns: "optional",
  }),
];
