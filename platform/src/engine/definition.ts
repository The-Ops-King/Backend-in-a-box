import { z } from "zod";

// ---- predicate tree ---------------------------------------------------------
export type Predicate =
  | { eq: [unknown, unknown] } | { neq: [unknown, unknown] }
  | { gt: [unknown, unknown] } | { gte: [unknown, unknown] } | { lt: [unknown, unknown] } | { lte: [unknown, unknown] }
  | { in: [unknown, unknown[]] } | { exists: string }
  | { and: Predicate[] } | { or: Predicate[] } | { not: Predicate };
export const Predicate: z.ZodType<Predicate> = z.lazy(() =>
  z.union([
    z.object({ eq: z.tuple([z.unknown(), z.unknown()]) }), z.object({ neq: z.tuple([z.unknown(), z.unknown()]) }),
    z.object({ gt: z.tuple([z.unknown(), z.unknown()]) }), z.object({ gte: z.tuple([z.unknown(), z.unknown()]) }),
    z.object({ lt: z.tuple([z.unknown(), z.unknown()]) }), z.object({ lte: z.tuple([z.unknown(), z.unknown()]) }),
    z.object({ in: z.tuple([z.unknown(), z.array(z.unknown())]) }), z.object({ exists: z.string() }),
    z.object({ and: z.array(Predicate) }), z.object({ or: z.array(Predicate) }), z.object({ not: Predicate }),
  ]),
);

// ---- wait rule (D14) -----------------------------------------------------------
export const WaitRule = z.object({
  anchor: z.string(),                       // "now" | "appointment.starts_at" | any datetime path
  offset: z.string(),                       // "+4h" | "-1d" | "day_of@08:00" | "day_before@19:00" | "day_after@09:00"
  tz: z.enum(["contact", "company"]).default("contact"),
  guard: z.object({ min_lead: z.string(), fallback: z.string() }).optional(),
});
export type WaitRule = z.infer<typeof WaitRule>;

export const Validity = z.object({
  anchor: z.enum(["before_event", "after_event", "unanchored"]).default("unanchored"),
  min_lead: z.string().optional(),          // before_event: must send at least this long before starts_at
  max_lag: z.string().optional(),           // after_event: must send within this long after starts_at
});
export const OnStale = z.enum(["skip", "substitute", "escalate"]);

// ---- nodes (the instruction set, 02-data-model §10) ----------------------------
const base = { id: z.string().min(1) };
export const Node = z.discriminatedUnion("type", [
  z.object({ ...base, type: z.literal("trigger"), event: z.string(), match: Predicate.optional() }),
  z.object({ ...base, type: z.literal("wait"), rule: WaitRule }),
  // Waits for an inbound reply (woken the minute one arrives) or until `timeout`; follows the edge labeled "timeout" if none, else exits `no_reply`.
  z.object({ ...base, type: z.literal("wait_for_reply"), timeout: z.string(), channel: z.enum(["sms", "email", "any"]).default("any") }),
  z.object({ ...base, type: z.literal("send_sms"), template: z.string(), validity: Validity.optional(), on_stale: OnStale.default("skip"), substitute_template: z.string().optional() }),
  z.object({ ...base, type: z.literal("send_email"), subject: z.string(), template: z.string(), validity: Validity.optional(), on_stale: OnStale.default("skip"), substitute_template: z.string().optional() }),
  z.object({ ...base, type: z.literal("slack_post"), channel: z.string(), template: z.string() }),
  z.object({ ...base, type: z.literal("classify"), input: z.string(), state: z.string().optional(), domain: z.string(), threshold: z.number().min(0).max(1).default(0.8), into: z.string() }),
  z.object({ ...base, type: z.literal("branch"), on: z.string().optional() }),
  z.object({ ...base, type: z.literal("check"), when: Predicate, else_exit: z.string() }),
  z.object({ ...base, type: z.literal("set_tag"), tag: z.string() }),
  z.object({ ...base, type: z.literal("remove_tag"), tag: z.string() }),
  z.object({ ...base, type: z.literal("note"), template: z.string() }),
  z.object({ ...base, type: z.literal("update_appointment"), set: z.record(z.unknown()) }),
  z.object({ ...base, type: z.literal("update_opportunity"), set: z.record(z.unknown()) }),
  z.object({ ...base, type: z.literal("set_var"), key: z.string(), value: z.unknown() }),
  z.object({ ...base, type: z.literal("start_workflow"), workflow: z.string(), with: z.record(z.unknown()).optional() }),
  z.object({ ...base, type: z.literal("pause_runs"), scope: z.enum(["contact", "appointment"]).default("contact") }),
  z.object({ ...base, type: z.literal("exit"), reason: z.string() }),
]);
export type Node = z.infer<typeof Node>;

export const Edge = z.object({ from: z.string(), to: z.string(), when: Predicate.optional(), else: z.boolean().optional(), label: z.string().optional() });
export type Edge = z.infer<typeof Edge>;

export const Premise = z.object({
  check: z.enum(["none", "appointment_in_future", "appointment_exists", "opportunity_open", "contact_exists"]).default("none"),
});

export const Definition = z.object({
  schema: z.literal(1),
  reentry: z.enum(["once_per_contact", "once_per_appointment", "once_per_opportunity", "once_per_contact_per_window", "always"]),
  reentry_window: z.string().optional(),
  premise: Premise.default({ check: "none" }),
  nodes: z.array(Node).min(1),
  edges: z.array(Edge),
}).superRefine((d, ctx) => {
  const ids = new Set<string>();
  for (const n of d.nodes) { if (ids.has(n.id)) ctx.addIssue({ code: "custom", message: `duplicate node id ${n.id}` }); ids.add(n.id); }
  for (const e of d.edges) for (const k of ["from", "to"] as const)
    if (!ids.has(e[k])) ctx.addIssue({ code: "custom", message: `edge ${k} ${e[k]} is not a node` });
  if (!d.nodes.some((n) => n.type === "trigger")) ctx.addIssue({ code: "custom", message: "a workflow needs at least one trigger" });
  if (!d.nodes.some((n) => n.type === "exit")) ctx.addIssue({ code: "custom", message: "a workflow needs at least one exit" });
  const hasOut = new Set(d.edges.map((e) => e.from));
  for (const n of d.nodes) if (n.type !== "exit" && !hasOut.has(n.id)) ctx.addIssue({ code: "custom", message: `node ${n.id} (${n.type}) has no outgoing edge` });
});
export type Definition = z.infer<typeof Definition>;

// ---- manifest: every {{binding}} the definition references (D3) --------------------
export type ManifestEntry = { key: string; kind: "secret" | "id" | "text" | "channel" | "number"; required: boolean; resolves?: string };
const BINDING_PREFIXES: Record<string, ManifestEntry["kind"]> = { "crm.": "id", "calendar.": "id", "slack.channel.": "channel", "secret.": "secret" };

export function extractManifest(def: Definition): { bindings: ManifestEntry[] } {
  const refs = new Set<string>();
  const walk = (v: unknown) => {
    if (typeof v === "string") for (const m of v.matchAll(/\{\{\s*([a-zA-Z0-9_.]+)/g)) refs.add(m[1]);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(def.nodes); walk(def.edges);
  const out = new Map<string, ManifestEntry>();
  for (const ref of refs) {
    for (const [prefix, kind] of Object.entries(BINDING_PREFIXES)) {
      if (!ref.startsWith(prefix)) continue;
      // calendar.closer_call.url → binding key calendar.closer_call
      const key = prefix === "calendar." ? ref.split(".").slice(0, 2).join(".") : prefix === "slack.channel." ? ref.split(".").slice(0, 3).join(".") : ref;
      const required = kind !== "channel";
      out.set(key, { key, kind, required, ...(prefix === "calendar." ? { resolves: "calendars" } : {}) });
    }
  }
  if (!out.has("crm.location_id")) out.set("crm.location_id", { key: "crm.location_id", kind: "id", required: true });
  return { bindings: [...out.values()].sort((a, b) => a.key.localeCompare(b.key)) };
}

export function parseDefinition(raw: unknown): Definition {
  return Definition.parse(raw);
}
export function indexDefinition(def: Definition) {
  const nodes = new Map(def.nodes.map((n) => [n.id, n]));
  const out = new Map<string, Edge[]>();
  for (const e of def.edges) out.set(e.from, [...(out.get(e.from) ?? []), e]);
  return { nodes, edgesFrom: (id: string) => out.get(id) ?? [], triggers: def.nodes.filter((n): n is Extract<Node, { type: "trigger" }> => n.type === "trigger") };
}
