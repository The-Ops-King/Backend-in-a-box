import type { z } from "zod";

/** What a step's effect reaches, which decides the delivery gate's checks for it. */
export type Effect =
  | "contact"   // reaches the contact: a text, an email, an agreement, a cancellation the vendor emails them about
  | "team"      // a Slack post, reaction or edit
  | "crm"       // a write to the CRM
  | "external"  // a call to any other URL
  | "read"      // asks a vendor something and changes nothing (AI, lookups)
  | "internal"; // our own facts and runs

/** Effects that leave the platform and so pass the delivery gate. */
export const OUTBOUND: ReadonlySet<Effect> = new Set(["contact", "team", "crm", "external"]);

/** What a node points at outside itself, so enabling can be refused while one of them does not exist. */
export type NodeRefs = {
  content?: string[];
  reports?: string[];
  forms?: string[];
  workflows?: string[];
  /** Ids of other nodes this one names (a Slack post to thread under, an ask to wait on). */
  nodes?: string[];
};

/**
 * One primitive at one version. A change to how a primitive behaves ships as a new version beside the old one, so a
 * saved workflow keeps doing what it did until it is edited.
 */
export type PrimitiveSpec<S extends z.ZodTypeAny = z.ZodTypeAny> = {
  name: string;
  version: number;
  /** One line on what the primitive does. */
  summary: string;
  /** The whole node: the shared fields, `type`, and the primitive's own. Unknown fields are refused. */
  schema: S;
  /**
   * The ways a node can leave. Every required outcome needs an edge (`on`, default "next"); an edge naming an outcome the
   * node does not have is refused.
   */
  outcomes: (node: z.infer<S>) => { required: string[]; optional?: string[] };
  /** The `vars.<name>` the node writes. */
  produces?: (node: z.infer<S>) => string[];
  refs?: (node: z.infer<S>) => NodeRefs;
  /** What the node's effect reaches, when it has one. */
  effect?: (node: z.infer<S>) => Effect | undefined;
};

/** Types a primitive's callbacks by its own schema, then files it with the others: it is only ever called with a node its schema parsed. */
export const definePrimitive = <S extends z.ZodTypeAny>(spec: PrimitiveSpec<S>): PrimitiveSpec => spec as unknown as PrimitiveSpec;
