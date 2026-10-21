import type { z } from "zod";
import type { Effect } from "../primitives/spec";

/** The port an action goes through. Workflows name the port, never the vendor behind it. */
export type Port = "crm" | "scheduling" | "esign" | "ai" | "slack" | "http" | "facts" | "runs";

/**
 * One `connector.verb` an `action` step can take, with the params it accepts. `effect` says what it reaches, so the
 * delivery gate knows which checks apply (an action that reaches the contact is behind the send lock like any text).
 */
export type ActionDef<P extends z.ZodTypeAny = z.ZodTypeAny> = {
  verb: `${Port}.${string}`;
  summary: string;
  effect: Effect;
  params: P;
  /** "none": the action gives nothing back; "optional": it may be kept with `into`; "required": it must be. */
  returns: "none" | "optional" | "required";
  /** Content keys the params name. */
  content?: (params: z.infer<P>) => string[];
};

/** Types an action's callbacks by its own params schema, then files it with the others: they only ever see params it parsed. */
export const defineAction = <P extends z.ZodTypeAny>(def: ActionDef<P>): ActionDef => def as unknown as ActionDef;
