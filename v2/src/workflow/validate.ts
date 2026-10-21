import type { ZodIssue } from "zod";
import { Edge, Header, type Node, RESUME, type Workflow } from "./definition";
import { type Predicate, predicateParts } from "./predicate";
import { INTERRUPT_OUTCOMES, PRIMITIVES, PRIMITIVE_NAMES, parseType } from "./primitives";
import type { Value } from "./primitives/flow";
import type { PrimitiveSpec } from "./primitives/spec";
import { parseTemplate } from "./template";

export type ProblemCode =
  | "schema" | "unknown_primitive" | "unknown_version" | "unknown_action" | "action_params"
  | "duplicate_node_id" | "no_trigger" | "no_end" | "no_outgoing_edge" | "missing_outcome_edge" | "unknown_outcome"
  | "duplicate_outcome_edge" | "edge_unknown_node" | "edge_into_trigger" | "unreachable_node"
  | "branch_edge_needs_condition" | "branch_needs_one_else" | "else_not_last" | "condition_outside_branch"
  | "resume_outside_listener" | "unknown_node_ref" | "bad_template" | "unknown_var" | "secret_outside_http" | "no_send_window";

export type Problem = { code: ProblemCode; message: string; path: (string | number)[]; node?: string };

/** What the workflow needs from the offer before it can be enabled. Each list is sorted and has no repeats. */
export type Requires = {
  settings: string[];
  content: string[];
  reports: string[];
  forms: string[];
  /** Other workflows of this offer that `call` starts. */
  workflows: string[];
  secrets: string[];
};

export type Validation =
  | { ok: true; workflow: Workflow; problems: []; requires: Requires }
  | { ok: false; problems: Problem[]; requires: Requires };

const zodProblems = (issues: ZodIssue[], base: (string | number)[], node?: string): Problem[] =>
  issues.map((i) => {
    const marked = i.code === "custom" ? (i.params as { problem?: ProblemCode } | undefined)?.problem : undefined;
    return { code: marked ?? "schema", message: i.message, path: [...base, ...i.path], ...(node ? { node } : {}) };
  });

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Every string in a value, with where it sits. */
function* stringsIn(v: unknown, path: (string | number)[]): Generator<{ s: string; path: (string | number)[] }> {
  if (typeof v === "string") yield { s: v, path };
  else if (Array.isArray(v)) for (let i = 0; i < v.length; i++) yield* stringsIn(v[i], [...path, i]);
  else if (isObject(v)) for (const [k, x] of Object.entries(v)) yield* stringsIn(x, [...path, k]);
}

/** The conditions a node holds, which also test bare paths (`exists`). */
function predicatesOf(n: Node): Predicate[] {
  if (n.type === "trigger@1" && "event" in n.on && n.on.event && n.on.match) return [n.on.match];
  if (n.type === "wait@1" && n.event?.match) return [n.event.match];
  if (n.type === "set@1") {
    const out: Predicate[] = [];
    const walk = (v: Value): void => {
      if (Array.isArray(v)) return v.forEach(walk);
      if (!isObject(v)) return;
      if ("$if" in v) { out.push(v.$if as Predicate); walk(v.then as Value); walk(v.else as Value); return; }
      if ("$pick" in v) { Object.values(v.cases as Record<string, Value>).forEach(walk); walk(v.else as Value); return; }
      Object.values(v).forEach((x) => walk(x as Value));
    };
    walk(n.value);
    return out;
  }
  return [];
}

/** Paths a node names without braces: a time rule's anchor, what a message's validity is measured against. */
function barePathsOf(n: Node): string[] {
  const out: string[] = [];
  const rule = (r?: { anchor: string }) => { if (r && r.anchor !== "now") out.push(r.anchor); };
  if (n.type === "wait@1" || n.type === "ask@1") rule(n.until);
  if (n.type === "message@1" && n.validity) out.push("before" in n.validity ? n.validity.before : n.validity.after);
  return out;
}

/**
 * Checks a workflow definition and returns every problem in it, not just the first, with what it needs from the offer
 * (settings, content, reports, forms, other workflows, secrets) so enabling can be refused while one is missing.
 */
export function validateWorkflow(raw: unknown): Validation {
  const problems: Problem[] = [];
  const add = (code: ProblemCode, message: string, path: (string | number)[], node?: string) => problems.push({ code, message, path, ...(node ? { node } : {}) });
  const req = { settings: new Set<string>(), content: new Set<string>(), reports: new Set<string>(), forms: new Set<string>(), workflows: new Set<string>(), secrets: new Set<string>() };
  const requires = (): Requires => ({
    settings: [...req.settings].sort(), content: [...req.content].sort(), reports: [...req.reports].sort(),
    forms: [...req.forms].sort(), workflows: [...req.workflows].sort(), secrets: [...req.secrets].sort(),
  });

  if (!isObject(raw)) {
    add("schema", "a workflow definition is a JSON object", []);
    return { ok: false, problems, requires: requires() };
  }
  const { nodes: rawNodes, edges: rawEdges, ...rawHeader } = raw;

  // The workflow's own fields.
  const header = Header.safeParse(rawHeader);
  if (!header.success) problems.push(...zodProblems(header.error.issues, []));

  // Nodes: each by its own primitive's schema.
  const nodes: Node[] = [];
  const specOf = new Map<string, PrimitiveSpec>();
  const seenIds = new Set<string>();
  if (!Array.isArray(rawNodes) || rawNodes.length === 0) add("schema", "a workflow has a list of nodes", ["nodes"]);
  else rawNodes.forEach((rn, i) => {
    const path = ["nodes", i];
    if (!isObject(rn) || typeof rn.id !== "string" || typeof rn.type !== "string") return add("schema", "a node has a string id and a string type", path);
    const id = rn.id;
    if (seenIds.has(id)) add("duplicate_node_id", `two nodes have the id "${id}"`, [...path, "id"], id);
    seenIds.add(id);
    const t = parseType(rn.type);
    if (!t) return add("unknown_primitive", `"${rn.type}" is not a primitive and a version, such as "wait@1"`, [...path, "type"], id);
    if (!PRIMITIVE_NAMES.has(t.name)) return add("unknown_primitive", `there is no primitive "${t.name}" (${[...PRIMITIVE_NAMES].join(", ")})`, [...path, "type"], id);
    const spec = PRIMITIVES.get(rn.type);
    if (!spec) return add("unknown_version", `${t.name} has no version ${t.version}`, [...path, "type"], id);
    const parsed = spec.schema.safeParse(rn);
    if (!parsed.success) return void problems.push(...zodProblems(parsed.error.issues, path, id));
    if (!specOf.has(id)) { nodes.push(parsed.data as Node); specOf.set(id, spec); }
  });
  const nodeIndex = new Map(nodes.map((n) => [n.id, n]));
  const pathOf = (id: string): (string | number)[] => {
    const i = Array.isArray(rawNodes) ? rawNodes.findIndex((n) => isObject(n) && n.id === id) : -1;
    return ["nodes", i];
  };

  // Edges.
  const edges: { e: Edge; i: number }[] = [];
  if (!Array.isArray(rawEdges)) add("schema", "a workflow has a list of edges", ["edges"]);
  else rawEdges.forEach((re, i) => {
    const parsed = Edge.safeParse(re);
    if (!parsed.success) return void problems.push(...zodProblems(parsed.error.issues, ["edges", i]));
    const e = parsed.data;
    let known = true;
    for (const k of ["from", "to"] as const) {
      if (k === "to" && e.to === RESUME) continue;
      if (!seenIds.has(e[k])) { add("edge_unknown_node", `edge ${k} "${e[k]}" is not a node`, ["edges", i, k]); known = false; }
    }
    if (known) edges.push({ e, i });
  });
  const outOf = (id: string) => edges.filter(({ e }) => e.from === id);

  // A run starts at a trigger and finishes at an end.
  if (Array.isArray(rawNodes) && rawNodes.length > 0) {
    const types = rawNodes.map((n) => (isObject(n) && typeof n.type === "string" ? parseType(n.type)?.name : undefined));
    if (!types.includes("trigger")) add("no_trigger", "a workflow needs at least one trigger", ["nodes"]);
    if (!types.includes("end")) add("no_end", "a workflow needs at least one end", ["nodes"]);
  }

  // Each node's ways out.
  for (const n of nodes) {
    const spec = specOf.get(n.id)!;
    const outs = outOf(n.id);
    const { required, optional = [] } = spec.outcomes(n);
    const allowed = new Set([...required, ...optional]);
    if (n.type !== "end@1" && outs.length === 0) { add("no_outgoing_edge", `${n.id} has no way on`, pathOf(n.id), n.id); continue; }
    for (const { e, i } of outs) {
      const on = e.on ?? "next";
      if (!allowed.has(on)) add("unknown_outcome", n.type === "end@1" ? `${n.id} is an end: nothing leaves it` : `${n.id} (${n.type}) has no outcome "${on}" (it has ${[...allowed].join(", ")})`, ["edges", i, "on"], n.id);
      if ((e.when || e.else) && n.type !== "branch@1") add("condition_outside_branch", `only a branch's edges carry when or else; ${n.id} is ${n.type}`, ["edges", i], n.id);
    }
    for (const on of required) if (!outs.some(({ e }) => (e.on ?? "next") === on)) add("missing_outcome_edge", `${n.id} has no edge for "${on}"`, pathOf(n.id), n.id);
    if (n.type !== "branch@1") for (const on of allowed) {
      const same = outs.filter(({ e }) => (e.on ?? "next") === on);
      if (same.length > 1) add("duplicate_outcome_edge", `${n.id} has ${same.length} edges for "${on}"; a step goes one way`, ["edges", same[1]!.i], n.id);
    }
    if (n.type === "branch@1") {
      const elses = outs.filter(({ e }) => e.else);
      for (const { e, i } of outs) if (!e.when && !e.else) add("branch_edge_needs_condition", `every edge out of branch ${n.id} has when or else`, ["edges", i], n.id);
      if (elses.length !== 1) add("branch_needs_one_else", `branch ${n.id} needs exactly one else edge, it has ${elses.length}`, pathOf(n.id), n.id);
      else if (outs[outs.length - 1]!.e !== elses[0]!.e) add("else_not_last", `the else edge of branch ${n.id} must be its last: edges after it are never taken`, ["edges", elses[0]!.i], n.id);
    }
  }
  for (const { e, i } of edges) {
    if (e.to !== RESUME && nodeIndex.get(e.to)?.type === "trigger@1") add("edge_into_trigger", `nothing leads into trigger ${e.to}: a trigger is where a run starts`, ["edges", i, "to"]);
  }

  // Every node is reachable from a trigger.
  const reach = (starts: string[]) => {
    const seen = new Set<string>(starts), queue = [...starts];
    while (queue.length) { const id = queue.shift()!; for (const { e } of outOf(id)) if (e.to !== RESUME && !seen.has(e.to)) { seen.add(e.to); queue.push(e.to); } }
    return seen;
  };
  const fromTriggers = reach(nodes.filter((n) => n.type === "trigger@1").map((n) => n.id));
  if (nodes.some((n) => n.type === "trigger@1")) for (const n of nodes) if (!fromTriggers.has(n.id)) add("unreachable_node", `no trigger leads to ${n.id}`, pathOf(n.id), n.id);

  // "$resume" only ends a path a listening ask took the run along.
  const isInterruptEdge = (e: Edge) => {
    const from = nodeIndex.get(e.from);
    return from?.type === "ask@1" && from.then === "listen" && (INTERRUPT_OUTCOMES as readonly string[]).includes(e.on ?? "next");
  };
  const onInterruptPath = reach(edges.filter(({ e }) => isInterruptEdge(e) && e.to !== RESUME).map(({ e }) => e.to));
  for (const { e, i } of edges) if (e.to === RESUME && !onInterruptPath.has(e.from) && !isInterruptEdge(e)) add("resume_outside_listener", `${e.from} returns to "$resume", but no listening ask leads to it`, ["edges", i, "to"]);

  // References to other nodes.
  for (const n of nodes) {
    for (const ref of specOf.get(n.id)!.refs?.(n).nodes ?? []) {
      const target = nodeIndex.get(ref);
      const ok = n.type === "wait@1" ? target?.type === "ask@1" && target.then === "go_on" : target?.type === "ask@1" || (target?.type === "message@1" && "slack" in target.to);
      if (!ok) add("unknown_node_ref", n.type === "wait@1" ? `${n.id} waits for the answer to "${ref}", which is not an ask that goes on` : `${n.id} points at "${ref}", which is not a Slack post or ask in this workflow`, pathOf(n.id), n.id);
    }
  }

  // Templates, the variables they read, and what the workflow needs.
  const produced = new Set(nodes.flatMap((n) => specOf.get(n.id)!.produces?.(n) ?? []));
  const checkTemplate = (s: string, path: (string | number)[], node: string | undefined, secretsAllowed: boolean) => {
    const parsed = parseTemplate(s);
    for (const err of parsed.errors) add("bad_template", err, path, node);
    for (const { expr } of parsed.spans) {
      if (expr.root === "setting") req.settings.add(expr.path.slice("setting.".length));
      if (expr.root === "secret") {
        if (secretsAllowed) req.secrets.add(expr.path.slice("secret.".length));
        else add("secret_outside_http", `{{${expr.source}}}: a secret may only appear in an http.request's url, headers and body`, path, node);
      }
      if (expr.root === "vars") checkVar(expr.path, path, node);
    }
  };
  const checkVar = (p: string, path: (string | number)[], node?: string) => {
    const name = p.split(".")[1];
    if (name && !produced.has(name)) add("unknown_var", `vars.${name} is not set by any step`, path, node);
  };
  /** A bare path a condition tests (`exists`) is read like a whole {{path}}. */
  const checkPath = (p: string, path: (string | number)[], node: string | undefined) => checkTemplate(`{{${p}}}`, path, node, false);
  for (const n of nodes) {
    const base = pathOf(n.id);
    const secretsAllowed = n.type === "action@1" && n.action === "http.request";
    for (const { s, path } of stringsIn(n, base)) {
      if (path.length === base.length + 1 && (path[base.length] === "title" || path[base.length] === "type" || path[base.length] === "id")) continue;
      checkTemplate(s, path, n.id, secretsAllowed && path[base.length] === "params");
    }
    for (const p of predicatesOf(n)) for (const path of predicateParts(p).paths) checkPath(path, base, n.id);
    for (const path of barePathsOf(n)) checkPath(path, base, n.id);
    const refs = specOf.get(n.id)!.refs?.(n) ?? {};
    refs.content?.forEach((k) => req.content.add(k));
    refs.reports?.forEach((k) => req.reports.add(k));
    refs.forms?.forEach((k) => req.forms.add(k));
    refs.workflows?.forEach((k) => req.workflows.add(k));
  }
  for (const { e, i } of edges) if (e.when) {
    for (const t of predicateParts(e.when).templates) checkTemplate(t, ["edges", i, "when"], e.from, false);
    for (const path of predicateParts(e.when).paths) checkPath(path, ["edges", i, "when"], e.from);
  }
  if (isObject(rawHeader.premise) && header.success && header.data.premise) {
    const p = header.data.premise.holds;
    for (const t of predicateParts(p).templates) checkTemplate(t, ["premise", "holds"], undefined, false);
    for (const path of predicateParts(p).paths) checkPath(path, ["premise", "holds"], undefined);
  }
  if (header.success && header.data.reentry.key) checkTemplate(header.data.reentry.key, ["reentry", "key"], undefined, false);

  // A workflow that writes to the contact says when it may.
  if (header.success && !header.data.sendWindow) {
    const first = nodes.find((n) => n.type === "message@1" && "contact" in n.to);
    if (first) add("no_send_window", `${first.id} messages the contact, so the workflow needs a sendWindow`, ["sendWindow"], first.id);
  }

  if (problems.length > 0 || !header.success) return { ok: false, problems, requires: requires() };
  return { ok: true, workflow: { ...header.data, nodes, edges: edges.map(({ e }) => e) }, problems: [], requires: requires() };
}
