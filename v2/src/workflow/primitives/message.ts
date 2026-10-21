import { z } from "zod";
import { Duration } from "../duration";
import { Predicate } from "../predicate";
import { ContentKey, ContentRef, PostRef, SlackTarget, Template, contentKeysOf, nodeBase } from "./common";
import { definePrimitive } from "./spec";

/** What a press on a Slack button does. These are the platform Slack app's own behaviors, the same on every offer. */
export const SLACK_BUTTON_ACTIONS = ["alert_retry", "alert_resolve", "alert_pause", "link_payment", "link_recording", "agreement_send", "agreement_cancel"] as const;

const ContactTo = z.object({ contact: z.enum(["sms", "email"]) }).strict();
const SlackTo = z.object({ slack: SlackTarget }).strict();

const DatePath = z.string().regex(/^[a-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)+$/, { message: 'a path such as "appointment.starts_at"' });

/**
 * When a message still makes sense: at least `minLead` before a time ("a reminder at least 15 minutes before the call"),
 * or within `maxLag` after one. Checked at the moment of sending.
 */
export const Validity = z.union([
  z.object({ before: DatePath, minLead: Duration }).strict(),
  z.object({ after: DatePath, maxLag: Duration }).strict(),
]);

/**
 * message@1: one message, by content key, to the run's contact (a text or an email) or to people in Slack (a channel or a
 * DM). The words are the content's; the step says only which, to whom and when it is still right to send.
 *
 * To the contact: `kind` human waits for the send window, transactional (a receipt) follows the workflow's rule for
 * receipts; `validity` and `whenStale` say what happens once it is too late (skip it, or send other content instead).
 * To Slack: `thread` replies under an earlier post (`threadOnly`: nothing when that post is not there), `remember`
 * keeps this post under a tag other runs can find, `buttons` are platform actions whose labels are in the content, each
 * shown only when its `when` holds.
 */
export const Message1 = z.object({
  ...nodeBase,
  type: z.literal("message@1"),
  to: z.union([ContactTo, SlackTo]),
  content: ContentRef,
  kind: z.enum(["human", "transactional"]).optional(),
  validity: Validity.optional(),
  whenStale: z.union([z.literal("skip"), z.object({ send: ContentKey }).strict()]).optional(),
  thread: PostRef.optional(),
  threadOnly: z.boolean().optional(),
  remember: Template.min(1).optional(),
  /** `when`: the button is shown only when this holds at the moment of posting ("Link the payment" only for an unlinked one). */
  buttons: z.array(z.object({ action: z.enum(SLACK_BUTTON_ACTIONS), value: Template.min(1), style: z.enum(["primary", "danger"]).optional(), when: Predicate.optional() }).strict()).min(1).max(5).optional(),
}).strict().superRefine((n, ctx) => {
  const toContact = "contact" in n.to;
  const only = (field: keyof typeof n, who: string) => { if (n[field] !== undefined) ctx.addIssue({ code: "custom", path: [field], message: `${field} is only for a message to ${who}` }); };
  if (toContact) (["thread", "threadOnly", "remember", "buttons"] as const).forEach((f) => only(f, "Slack"));
  else (["kind", "validity", "whenStale"] as const).forEach((f) => only(f, "the contact"));
  if (n.whenStale !== undefined && n.validity === undefined) ctx.addIssue({ code: "custom", path: ["whenStale"], message: "whenStale needs a validity to be stale against" });
  if (n.threadOnly && !n.thread) ctx.addIssue({ code: "custom", path: ["threadOnly"], message: "threadOnly needs a thread" });
});
export type Message1 = z.infer<typeof Message1>;

export const message1 = definePrimitive({
  name: "message",
  version: 1,
  summary: "Sends one message, by content key, to the contact (SMS or email) or to people in Slack (channel or DM).",
  schema: Message1,
  outcomes: () => ({ required: ["next"] }),
  refs: (n) => ({
    content: [...contentKeysOf(n.content), ...(n.whenStale && n.whenStale !== "skip" ? [n.whenStale.send] : [])],
    nodes: n.thread && "node" in n.thread ? [n.thread.node] : [],
  }),
  effect: (n) => ("contact" in n.to ? "contact" : "team"),
});
