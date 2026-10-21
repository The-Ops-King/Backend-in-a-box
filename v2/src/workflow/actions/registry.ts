import { OUTBOUND } from "../primitives/spec";
import { crmActions } from "./crm";
import type { ActionDef } from "./define";
import { internalActions } from "./internal";
import { vendorActions } from "./vendors";

/** Every verb an `action` step can name. */
export const ACTIONS: ReadonlyMap<string, ActionDef> = new Map(
  [...crmActions, ...vendorActions, ...internalActions].map((a) => [a.verb, a]),
);

export const actionDef = (verb: string): ActionDef | undefined => ACTIONS.get(verb);

/** Whether the verb's effect leaves the platform, so the delivery gate checks it. */
export const isOutbound = (verb: string): boolean => {
  const a = ACTIONS.get(verb);
  return !!a && OUTBOUND.has(a.effect);
};

/** Whether the verb reaches the contact, so it is behind the send lock like a text. */
export const isContactFacing = (verb: string): boolean => ACTIONS.get(verb)?.effect === "contact";
