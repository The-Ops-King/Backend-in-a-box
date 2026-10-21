import { z } from "zod";
import { actionDef } from "../actions/registry";
import { VarName, nodeBase } from "./common";
import { definePrimitive } from "./spec";

/**
 * action@1: one `connector.verb` with its params ("crm.add_tag", "scheduling.cancel", "ai.classify"). Which verbs exist,
 * and the params each takes, is the action registry. What it gives back is kept in `vars.<into>`.
 */
export const Action1 = z.object({
  ...nodeBase,
  type: z.literal("action@1"),
  action: z.string().regex(/^[a-z]+\.[a-z_]+$/, { message: 'an action is "connector.verb", such as "crm.add_tag"' }),
  params: z.record(z.unknown()),
  into: VarName.optional(),
}).strict().superRefine((n, ctx) => {
  const def = actionDef(n.action);
  if (!def) {
    ctx.addIssue({ code: "custom", path: ["action"], message: `unknown action "${n.action}"`, params: { problem: "unknown_action" } });
    return;
  }
  const parsed = def.params.safeParse(n.params);
  if (!parsed.success) for (const i of parsed.error.issues) ctx.addIssue({ code: "custom", path: ["params", ...i.path], message: `${n.action}: ${i.message}`, params: { problem: "action_params" } });
  if (def.returns === "none" && n.into) ctx.addIssue({ code: "custom", path: ["into"], message: `${n.action} gives nothing back to keep`, params: { problem: "action_params" } });
  if (def.returns === "required" && !n.into) ctx.addIssue({ code: "custom", path: ["into"], message: `${n.action} gives back an answer: name it with into`, params: { problem: "action_params" } });
});
export type Action1 = z.infer<typeof Action1>;

export const action1 = definePrimitive({
  name: "action",
  version: 1,
  summary: "Takes one connector action (connector.verb) with its params.",
  schema: Action1,
  outcomes: () => ({ required: ["next"] }),
  produces: (n) => (n.into ? [n.into] : []),
  refs: (n) => {
    const def = actionDef(n.action);
    const parsed = def?.params.safeParse(n.params);
    const nodes: string[] = [];
    const post = (n.params as { post?: { node?: unknown } }).post;
    if (post && typeof post.node === "string") nodes.push(post.node);
    return { content: def?.content && parsed?.success ? def.content(parsed.data) : [], nodes };
  },
  effect: (n) => actionDef(n.action)?.effect,
});
