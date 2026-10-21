import { action1 } from "./action";
import { ask1 } from "./ask";
import { branch1, call1, end1, set1 } from "./flow";
import { message1 } from "./message";
import { report1 } from "./report";
import type { PrimitiveSpec } from "./spec";
import { trigger1 } from "./trigger";
import { wait1 } from "./wait";

/**
 * Every primitive at every version, by the `type` a node names: "wait@1". A new version of a primitive is added beside
 * the old one, never in place of it.
 */
export const PRIMITIVES: ReadonlyMap<string, PrimitiveSpec> = new Map(
  [trigger1, wait1, branch1, set1, message1, ask1, action1, report1, call1, end1].map((p) => [`${p.name}@${p.version}`, p]),
);

export const PRIMITIVE_NAMES: ReadonlySet<string> = new Set([...PRIMITIVES.values()].map((p) => p.name));

/** "wait@1" → { name: "wait", version: 1 }; anything else → undefined. */
export function parseType(type: string): { name: string; version: number } | undefined {
  const m = /^([a-z]+)@([1-9]\d*)$/.exec(type);
  return m ? { name: m[1]!, version: Number(m[2]) } : undefined;
}

export { Action1 } from "./action";
export { Ask1, INTERRUPT_OUTCOMES } from "./ask";
export { Branch1, Call1, End1, Set1, Value } from "./flow";
export { Message1, SLACK_BUTTON_ACTIONS } from "./message";
export { Report1 } from "./report";
export { Trigger1 } from "./trigger";
export { Wait1, waitKind } from "./wait";
export type { Effect, PrimitiveSpec } from "./spec";
