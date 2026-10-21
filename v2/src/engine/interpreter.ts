import { recordFact } from "@/projections/apply";
import { actionDef } from "@/workflow/actions/registry";
import { LOOKUP_QUERIES } from "@/workflow/actions/internal";
import { type Edge, type Node, RESUME, type Workflow } from "@/workflow/definition";
import type { RenderEnv } from "@/workflow/filters";
import { toText } from "@/workflow/filters";
import { holds, type Predicate } from "@/workflow/predicate";
import { PRIMITIVES, waitKind } from "@/workflow/primitives";
import type { Action1, Ask1, Call1, Message1, Wait1 } from "@/workflow/primitives";
import type { ContentRef, TimeRule } from "@/workflow/primitives/common";
import type { Value } from "@/workflow/primitives/flow";
import { OUTBOUND } from "@/workflow/primitives/spec";
import { type Blank, type Context, evaluateExpr, render, wholeExpr } from "@/workflow/template";
import { validateWorkflow } from "@/workflow/validate";
import { toMs } from "@/workflow/duration";
import { toInstant } from "@/workflow/dates";
import { type Subjects, buildContext, eventView, freshSubjects, mergeSubjects, nestSettings, snapshotOf } from "./context";
import type { Tx } from "./store";
import { answerLookup } from "@/projections/lookups";
import { renderReport } from "@/reports/render";
import type { VendorReads } from "./reads";
import { computeTimeRule, fitSendWindow, inWindow, nextOpen, windowZone } from "./time";
import type { EventRow, Listener, NewRun, OfferRow, RunContext, RunRow, StepRow, VersionRow, Wake, WorkflowRow } from "./types";

/**
 * The interpreter: walks a run through its pinned workflow version. It never calls a vendor. A step's effect on the
 * outside world is an outbox row written in the run's own transaction; the run then waits for the dispatcher to
 * settle it. Waits are data on the run (`wake`, `next_wake_at`), looked at again when they are due or when a fact about
 * the run's subjects arrives. The premise is checked again on every wake and before every step that reaches outside.
 */

/**
 * A stand-in for a report definition rendered (report@1): `{ answer }` to use it, undefined to render the offer's own
 * definition from the projections (src/reports/). The simulator stands in only where a scenario says so.
 */
export type ReportRenderer = (x: { offerId: string; report: string; period: string; params: Record<string, unknown>; now: Date }) => Promise<{ answer: unknown } | undefined>;

/**
 * A stand-in for a facts.lookup answer: `{ answer }` to use it, undefined to answer from the projections
 * (src/projections/lookups.ts). The simulator stands in only where a scenario says so.
 */
export type LookupResolver = (x: { offerId: string; query: string; params: Record<string, unknown>; contactId: string | null; appointmentId: string | null; now: Date }) => Promise<{ answer: unknown } | undefined>;

/** `depth`: how many call@1 steps deep this pass is, so a workflow that calls itself cannot recurse for ever. */
export type Deps = { tx: Tx; now: Date; reports?: ReportRenderer; lookup?: LookupResolver; reads?: VendorReads; depth?: number };

const MAX_CALL_DEPTH = 8;

const MAX_STEPS_PER_PASS = 200;
const IN_FLIGHT = ["active", "waiting", "paused"] as const;

// ---------------------------------------------------------------------------------------------------------------------
// Definitions

const definitions = new Map<string, { def: Workflow; secrets: string[] }>();

/** A version's definition, checked and with its defaults written out. Versions never change, so it is read once. */
export function definitionOf(v: VersionRow): { def: Workflow; secrets: string[] } {
  const hit = definitions.get(v.id);
  if (hit) return hit;
  const r = validateWorkflow(v.definition);
  if (!r.ok) throw new Error(`version ${v.id} does not validate: ${r.problems.map((p) => p.message).join("; ")}`);
  const out = { def: r.workflow, secrets: r.requires.secrets };
  definitions.set(v.id, out);
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// The pass: one run, worked on inside one transaction

type Pass = {
  deps: Deps; tx: Tx; now: Date;
  run: RunRow; def: Workflow; secrets: string[]; wf: WorkflowRow; offer: OfferRow; settings: Record<string, unknown>;
  byId: Map<string, Node>; outs: Map<string, Edge[]>;
  fresh?: Record<string, Record<string, unknown>>;
  /** What we last sent the run's contact (a text or an email that went out), read once a pass. */
  lastOut?: { found: Record<string, unknown> | null };
};

type Next =
  | { to: string }
  | { park: Wake; at: Date | null; status: "waiting" | "paused" }
  | { end: string; status: "completed" | "ended" | "failed" };

async function loadPass(deps: Deps, run: RunRow): Promise<Pass> {
  const { tx } = deps;
  const [version, wf, offer, settings] = await Promise.all([tx.version(run.versionId), tx.workflow(run.workflowId), tx.offer(run.offerId), tx.settings(run.offerId)]);
  if (!version || !wf || !offer) throw new Error(`run ${run.id}: its version, workflow or offer is gone`);
  const { def, secrets } = definitionOf(version);
  const outs = new Map<string, Edge[]>();
  for (const e of def.edges) outs.set(e.from, [...(outs.get(e.from) ?? []), e]);
  return { deps, tx, now: deps.now, run, def, secrets, wf, offer, settings, byId: new Map(def.nodes.map((n) => [n.id, n])), outs };
}

const subjectsOf = (r: Pick<RunRow, "contactId" | "appointmentId" | "dealId">): Subjects => ({ contactId: r.contactId, appointmentId: r.appointmentId, dealId: r.dealId });

/**
 * What we last sent this contact, from the outbox: the latest text or email (from any workflow) that went out, as
 * `reply.last_outbound` { body, channel, at, content_key }. A message held, suppressed or still queued is not one.
 */
async function lastOutbound(P: Pass): Promise<Record<string, unknown> | null> {
  if (!P.run.contactId) return null;
  const rows = (await P.tx.outboxRows({ offerId: P.offer.id, contactId: P.run.contactId, kinds: ["message.sms", "message.email"], statuses: ["sent"] }))
    .filter((r) => r.sentAt).sort((a, b) => b.sentAt!.getTime() - a.sentAt!.getTime() || b.id - a.id);
  const r = rows[0];
  if (!r) return null;
  const p = r.payload as { text?: string; channel?: string; contentKey?: string };
  return { body: p.text ?? "", channel: p.channel ?? (r.kind === "message.sms" ? "sms" : "email"), at: iso(r.sentAt!), content_key: p.contentKey ?? null };
}

/** What a step reads now: the subjects read fresh (once a pass, again after the run records a fact). */
async function view(P: Pass, extra?: Record<string, unknown>): Promise<{ ctx: Context; env: RenderEnv }> {
  P.fresh ??= await freshSubjects(P.tx, { offer: P.offer, settings: P.settings, subjects: subjectsOf(P.run), now: P.now, event: P.run.context.event });
  P.lastOut ??= { found: await lastOutbound(P) };
  const b = buildContext({ run: P.run, workflowKey: P.wf.key, offer: P.offer, settings: P.settings, subjects: P.fresh, now: P.now, secrets: P.secrets });
  if (P.lastOut.found) b.ctx.reply = { ...((b.ctx.reply as Record<string, unknown> | undefined) ?? {}), last_outbound: P.lastOut.found };
  return extra ? { ctx: { ...b.ctx, ...extra }, env: b.env } : b;
}

const iso = (d: Date) => d.toISOString();
const later = (a: Date | null, b: Date | null): Date | null => (a && b ? (a < b ? a : b) : a ?? b);

async function newStep(P: Pass, node: Node, visit: number): Promise<StepRow> {
  return P.tx.insertStep({ offerId: P.offer.id, runId: P.run.id, node: node.id, primitive: node.type, visit, status: "waiting", startedAt: P.now, finishedAt: null, result: {}, error: null });
}

/** Closes a step and follows its edge for `outcome`. */
async function leave(P: Pass, node: Node, step: StepRow, outcome = "next", result: Record<string, unknown> = {}, status: StepRow["status"] = "ok"): Promise<Next> {
  await P.tx.updateStep(step.id, { status, finishedAt: P.now, result: { ...step.result, ...result, outcome } });
  const edge = (P.outs.get(node.id) ?? []).find((e) => (e.on ?? "next") === outcome);
  if (!edge) return { end: `node ${node.id} has no way on for "${outcome}"`, status: "failed" };
  return { to: edge.to };
}

async function parkOn(P: Pass, step: StepRow, wake: Wake, at: Date | null, result: Record<string, unknown> = {}, status: "waiting" | "paused" = "waiting"): Promise<Next> {
  const s = await P.tx.step(step.id);
  const wakes = [...(((s?.result.wakes as unknown[]) ?? [])), ...(at ? [{ decided: iso(P.now), at: iso(at) }] : [])];
  await P.tx.updateStep(step.id, { status: status === "paused" ? "held" : "waiting", result: { ...s?.result, ...result, ...(at ? { wakeAt: iso(at), wakes } : {}) } });
  return { park: wake, at, status };
}

function premiseFails(P: Pass, ctx: Context, env: RenderEnv): boolean {
  return !!P.def.premise && !holds(P.def.premise.holds, ctx, env);
}

async function premiseEnd(P: Pass, step: StepRow | null): Promise<Next> {
  if (step) await P.tx.updateStep(step.id, { status: "skipped", finishedAt: P.now, result: { ...step.result, premise: "no longer holds" } });
  return { end: P.def.premise!.endReason, status: "ended" };
}

const isOutbound = (n: Node) => {
  const e = PRIMITIVES.get(n.type)?.effect?.(n);
  return !!e && OUTBOUND.has(e);
};

/** What a failed step does once it cannot be done: skip it, or hold the run on it for a person. */
function onFailureOf(n: Node): "skip" | "hold" {
  if (n.onFailure) return n.onFailure;
  if (["wait@1", "branch@1", "set@1", "call@1", "report@1", "trigger@1", "end@1"].includes(n.type)) return "hold";
  return (PRIMITIVES.get(n.type)?.produces?.(n).length ?? 0) > 0 ? "hold" : "skip";
}

async function failStep(P: Pass, node: Node, step: StepRow, why: string): Promise<Next> {
  if (onFailureOf(node) === "skip") {
    await P.tx.updateStep(step.id, { status: "skipped", finishedAt: P.now, error: why, result: { ...step.result, gaveUp: why } });
    const into = (node as { into?: string }).into;
    if (into) P.run.context.vars[into] = null;
    const edge = (P.outs.get(node.id) ?? []).find((e) => (e.on ?? "next") === "next");
    if (!edge) return { end: `node ${node.id} failed and has no way on: ${why}`, status: "failed" };
    return { to: edge.to };
  }
  await P.tx.raiseAlert({ offerId: P.offer.id, key: `run:${P.run.id}:held`, kind: "run_held", message: `A run of ${P.wf.name} is held on "${node.title}": ${why}`, detail: { node: node.id }, runId: P.run.id, outboxId: null, openedAt: P.now });
  await P.tx.updateStep(step.id, { error: why });
  return parkOn(P, step, { kind: "hold", node: node.id, step: step.id, why }, null, { held: why }, "paused");
}

// ---------------------------------------------------------------------------------------------------------------------
// Values and words

type Acc = { blanks: Blank[]; errors: string[] };

/** A value computed from the context: one whole {{…}} keeps its type, other text is rendered, $pick and $if choose. */
export function evalValue(v: Value | unknown, ctx: Context, env: RenderEnv, acc?: Acc): unknown {
  if (typeof v === "string") {
    const whole = wholeExpr(v);
    if (whole) {
      const r = evaluateExpr(whole, ctx, env);
      if (acc && r.inner) { acc.blanks.push(...r.inner.blanks); acc.errors.push(...r.inner.errors); }
      if (acc && r.blank) acc.blanks.push(r.blank);
      if (acc && r.error) acc.errors.push(r.error);
      return r.value;
    }
    if (!v.includes("{{")) return v;
    const r = render(v, ctx, env);
    acc?.blanks.push(...r.blanks);
    acc?.errors.push(...r.errors);
    return r.text;
  }
  if (Array.isArray(v)) return v.map((x) => evalValue(x, ctx, env, acc));
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    if ("$pick" in o) {
      const key = toText(evalValue(o.$pick, ctx, env));
      const cases = o.cases as Record<string, unknown>;
      return evalValue(Object.prototype.hasOwnProperty.call(cases, key) ? cases[key] : o.else, ctx, env, acc);
    }
    if ("$if" in o) return evalValue(holds(o.$if as Predicate, ctx, env) ? o.then : o.else, ctx, env, acc);
    return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, evalValue(x, ctx, env, acc)]));
  }
  return v;
}

const pickContent = (c: ContentRef, ctx: Context, env: RenderEnv): string => {
  if (typeof c === "string") return c;
  const key = toText(evalValue(c.pick, ctx, env));
  return Object.prototype.hasOwnProperty.call(c.cases, key) ? c.cases[key]! : c.else;
};

type Words = { key: string; text: string; subject?: string; as?: string; icons?: string[]; labels: Record<string, string>; missing: boolean; acc: Acc };

async function words(P: Pass, key: string, ctx: Context, env: RenderEnv): Promise<Words> {
  const row = await P.tx.content(P.offer.id, key);
  const acc: Acc = { blanks: [], errors: [] };
  if (!row) return { key, text: "", labels: {}, missing: true, acc };
  const body = render(row.body, ctx, env);
  acc.blanks.push(...body.blanks); acc.errors.push(...body.errors);
  let subject: string | undefined;
  if (row.subject) { const s = render(row.subject, ctx, env); acc.blanks.push(...s.blanks); acc.errors.push(...s.errors); subject = s.text; }
  // the Slack persona: its name and icons are templates like the words, so a value may choose them ({{event.as_name}})
  let as: string | undefined;
  if (row.extras?.as) { const r = render(row.extras.as, ctx, env); acc.blanks.push(...r.blanks); acc.errors.push(...r.errors); as = r.text; }
  const icons = (row.extras?.icons ?? []).flatMap((i) => {
    const v = evalValue(i, ctx, env, acc);
    return (Array.isArray(v) ? v : [v]).map(toText).filter((x) => x !== "");
  });
  return { key, text: body.text, ...(subject !== undefined ? { subject } : {}), ...(as ? { as } : {}), ...(icons.length ? { icons } : {}), labels: row.extras?.labels ?? {}, missing: false, acc };
}

// ---------------------------------------------------------------------------------------------------------------------
// Time

/** A deadline pinned when a wait or an ask begins: `timeout` from then, its `until` rule, whichever is first. */
function deadlineOf(P: Pass, n: { timeout?: string; until?: TimeRule; fitSendWindow?: boolean }, ctx: Context, env: RenderEnv, fit: boolean): Date | null {
  let d: Date | null = n.timeout ? new Date(P.now.getTime() + toMs(n.timeout)) : null;
  if (n.until) {
    const c = computeTimeRule(n.until, ctx, env, P.now);
    if (c) {
      const at = fit && P.def.sendWindow && n.fitSendWindow !== false ? fitSendWindow(c.at, P.def.sendWindow, windowZone(P.def.sendWindow, env)).at : c.at;
      d = later(d, at);
    }
  }
  return d;
}

// ---------------------------------------------------------------------------------------------------------------------
// Entering a node

async function enter(P: Pass, node: Node): Promise<Next> {
  const c = P.run.context;
  const visit = (c.visits[node.id] ?? 0) + 1;
  c.visits[node.id] = visit;
  P.run.currentNode = node.id;
  const unset = (node.skipWhenUnset ?? []).filter((k) => { const v = P.settings[k]; return v === undefined || v === null || v === ""; });
  if (unset.length) {
    // a step that can do without a setting the offer left unset: skipped, never given a value from code
    const step = await newStep(P, node, visit);
    const into = (node as { into?: string }).into;
    if (into) c.vars[into] = null;
    return leave(P, node, step, "next", { skipped: `not set: ${unset.join(", ")}` }, "skipped");
  }
  if (isOutbound(node)) {
    const { ctx, env } = await view(P);
    if (premiseFails(P, ctx, env)) return premiseEnd(P, null);
  }
  const step = await newStep(P, node, visit);
  const runBefore = structuredClone(P.run);
  try {
    // a step that throws undoes only what it wrote; the run stays where it was and its failure rule applies
    return await P.tx.savepoint(() => execute(P, node, step, visit));
  } catch (e) {
    P.run = { ...runBefore, currentNode: node.id };
    P.fresh = undefined;
    return failStep(P, node, step, e instanceof Error ? e.message : String(e));
  }
}

async function execute(P: Pass, node: Node, step: StepRow, visit: number): Promise<Next> {
  switch (node.type) {
    case "trigger@1": return leave(P, node, step);
    case "branch@1": {
      const { ctx, env } = await view(P);
      const edges = P.outs.get(node.id) ?? [];
      const i = edges.findIndex((e) => e.else || (e.when && holds(e.when, ctx, env)));
      if (i < 0) throw new Error(`branch ${node.id}: no edge holds and there is no else`);
      await P.tx.updateStep(step.id, { status: "ok", finishedAt: P.now, result: { edge: i, to: edges[i]!.to, ...(edges[i]!.label ? { label: edges[i]!.label } : {}) } });
      return { to: edges[i]!.to };
    }
    case "set@1": {
      const { ctx, env } = await view(P);
      const value = evalValue(node.value, ctx, env);
      P.run.context.vars[node.var] = value as never;
      return leave(P, node, step, "next", { var: node.var, value });
    }
    case "end@1": {
      const expiring = P.run.listeners.find((l) => (P.outs.get(l.node) ?? []).some((e) => e.on === "expired"));
      if (expiring) return interrupt(P, expiring, "expired", null, { node: node.id, wake: null });
      await P.tx.updateStep(step.id, { status: "ok", finishedAt: P.now, result: { reason: node.reason } });
      return { end: node.reason, status: "completed" };
    }
    case "call@1": return callWorkflow(P, node, step, visit);
    case "wait@1": return enterWait(P, node, step);
    case "message@1": return message(P, node, step, visit);
    case "ask@1": return ask(P, node, step, visit);
    case "action@1": return action(P, node, step, visit);
    case "report@1": {
      const { ctx, env } = await view(P);
      const params = evalValue(node.params ?? {}, ctx, env) as Record<string, unknown>;
      const standIn = await P.deps.reports?.({ offerId: P.offer.id, report: node.report, period: node.period, params, now: P.now });
      const out = standIn ? standIn.answer : await renderReport({ tx: P.tx, offer: P.offer, settings: P.settings, now: P.now, ...(P.deps.reads ? { reads: P.deps.reads } : {}) }, { key: node.report, period: node.period, params, ctx });
      P.run.context.vars[node.into] = out as never;
      return leave(P, node, step, "next", { report: node.report });
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// call@1

async function callWorkflow(P: Pass, node: Call1, step: StepRow, visit: number): Promise<Next> {
  if ((P.deps.depth ?? 0) >= MAX_CALL_DEPTH) throw new Error(`calls nested more than ${MAX_CALL_DEPTH} deep`);
  const target = await P.tx.workflowByKey(P.offer.id, node.workflow);
  if (!target?.enabled || !target.currentVersionId) throw new Error(`workflow ${node.workflow} is not enabled`);
  const version = (await P.tx.version(target.currentVersionId))!;
  const { def } = definitionOf(version);
  const triggers = def.nodes.filter((n) => n.type === "trigger@1");
  const trigger = triggers.find((n) => n.type === "trigger@1" && "manual" in n.on) ?? triggers[0]!;
  const { ctx, env } = await view(P);
  const withValues = (evalValue(node.with ?? {}, ctx, env) ?? {}) as Record<string, unknown>;
  P.run.context.acted = true;
  const started = await startRun({ ...P.deps, depth: (P.deps.depth ?? 0) + 1 }, {
    offer: P.offer, workflow: target, version, triggerNode: trigger.id, event: null,
    eventView: { ...withValues, type: "workflow.called", occurred_at: iso(P.now), source: "workflow", called_by: P.run.id },
    eventKey: `call:${P.run.id}:${node.id}:${visit}`, subjects: subjectsOf(P.run), snapshot: P.run.context.subjects,
  });
  return leave(P, node, step, "next", { workflow: node.workflow, started });
}

// ---------------------------------------------------------------------------------------------------------------------
// wait@1

async function enterWait(P: Pass, node: Wait1, step: StepRow): Promise<Next> {
  const { ctx, env } = await view(P);
  const k = waitKind(node);
  const base = { node: node.id, step: step.id };
  const since = iso(P.now);
  switch (k) {
    case "for": {
      const at = new Date(P.now.getTime() + toMs(node.for!));
      return parkOn(P, step, { ...base, kind: "time", at: iso(at), reached: since }, at);
    }
    case "until": return timeWait(P, node, step, { ...base, kind: "time", at: since, reached: since, rule: node.until! });
    case "person":
      return parkOn(P, step, { ...base, kind: "person", reason: node.person!.reason }, null, { person: node.person!.reason }, "paused");
    default: break;
  }
  const deadline = deadlineOf(P, node, ctx, env, true);
  const dl = deadline ? { deadline: iso(deadline) } : {};
  let wake: Wake;
  if (k === "event") {
    const e = node.event!;
    const subject = e.about === "contact" ? P.run.contactId : P.run.appointmentId;
    const from = e.since ? toInstant(evalValue(e.since, ctx, env)) : undefined;
    wake = { ...base, kind: "event", type: e.type, about: e.about, subject, ...(e.match ? { match: e.match } : {}), since: iso(from ?? P.now), ...(from ? {} : { strict: true }), ...dl };
  } else if (k === "reply") {
    wake = { ...base, kind: "reply", channel: node.reply!.channel, since, strict: true, ...(node.reply!.settle ? { settleMs: toMs(node.reply!.settle) } : {}), ...dl };
  } else if (k === "answer") {
    const a = node.answer!;
    if ("ask" in a) wake = { ...base, kind: "answer", ask: a.ask, since, ...dl };
    else {
      const tag = toText(evalValue(a.tag, ctx, env));
      const from = a.since ? toInstant(evalValue(a.since, ctx, env)) : undefined;
      wake = { ...base, kind: "answer", tag, since: iso(from ?? P.now), ...(from ? {} : { strict: true }), ...dl };
    }
  } else {
    wake = { ...base, kind: "check", everyMs: toMs(node.check!.every), deadline: iso(deadline!) };
  }
  await P.tx.updateStep(step.id, { result: { ...(deadline ? { deadline: iso(deadline) } : {}) } });
  step.result = { ...(deadline ? { deadline: iso(deadline) } : {}) };
  return evaluate(P, node, step, wake);
}

/** A time wait: the rule worked out again (the anchor may have moved), fitted into the send window, gone on when due. */
async function timeWait(P: Pass, node: Wait1, step: StepRow, wake: Extract<Wake, { kind: "time" }>): Promise<Next> {
  if (!wake.rule) {
    const at = new Date(wake.at);
    return at > P.now ? { park: wake, at, status: "waiting" } : leave(P, node, step, "next", { wokeAt: iso(P.now) });
  }
  const { ctx, env } = await view(P);
  const c = computeTimeRule(wake.rule, ctx, env, new Date(wake.reached));
  if (!c) throw new Error(`the wait's anchor ${wake.rule.anchor} is not a date-time`);
  const fit = P.def.sendWindow && node.fitSendWindow !== false ? fitSendWindow(c.at, P.def.sendWindow, windowZone(P.def.sendWindow, env)) : { at: c.at, moved: "no" as const };
  const detail = { computed: iso(c.at), ...(fit.moved !== "no" ? { moved: fit.moved, fitted: iso(fit.at) } : {}), ...(c.usedFallback ? { fallback: true } : {}), ...(c.clamped !== "no" ? { clamped: c.clamped } : {}) };
  if (fit.at.getTime() <= P.now.getTime()) {
    return leave(P, node, step, "next", { ...detail, ...(step.result.wakeAt ? { wokeAt: iso(P.now) } : { passed: "the time had already come when the wait began" }) });
  }
  const prior = wake.at;
  const next = { ...wake, at: iso(fit.at) };
  if (prior === next.at && step.result.wakeAt === next.at) return { park: next, at: fit.at, status: "waiting" };
  return parkOn(P, step, next, fit.at, detail);
}

const outcomeArrived = (P: Pass, node: string) => (P.byId.get(node)?.type === "ask@1" ? "answered" : "arrived");

/** Looks at what a wait is waiting for: gone on when it is there, by timeout at the deadline, else parked again. */
async function evaluate(P: Pass, node: Node, step: StepRow, wake: Wake): Promise<Next> {
  const deadline = "deadline" in wake && wake.deadline ? new Date(wake.deadline) : null;
  const into = (node as { into?: string }).into;
  const arrived = async (value: unknown, extra: Record<string, unknown> = {}) => {
    if (into) P.run.context.vars[into] = value as never;
    return leave(P, node, step, outcomeArrived(P, wake.node), extra);
  };
  const timedOut = async () => {
    if (into) P.run.context.vars[into] = null;
    return leave(P, node, step, "timeout", { timedOutAt: iso(P.now) });
  };
  const after = (e: { occurredAt: Date }) => !("strict" in wake && wake.strict) || e.occurredAt.getTime() > new Date((wake as { since: string }).since).getTime();
  const again = (at: Date | null) => (step.result.wakeAt === (at ? iso(at) : undefined) ? Promise.resolve<Next>({ park: wake, at, status: "waiting" }) : parkOn(P, step, wake, at));

  switch (wake.kind) {
    case "event": {
      if (wake.subject) {
        const rows = await P.tx.events({ offerId: P.offer.id, types: [wake.type], ...(wake.about === "contact" ? { contactId: wake.subject } : { appointmentId: wake.subject }), since: new Date(wake.since) });
        for (const e of rows.filter(after)) {
          const ev = eventView(e);
          if (wake.match) {
            const { ctx, env } = await view(P, { event: ev });
            if (!holds(wake.match, ctx, env)) continue;
          }
          return arrived(ev, { event: e.id });
        }
      }
      break;
    }
    case "reply": {
      if (P.run.contactId) {
        const rows = (await P.tx.events({ offerId: P.offer.id, types: ["message.received"], contactId: P.run.contactId, since: new Date(wake.since) }))
          .filter((e) => after(e) && (wake.channel === "any" || e.payload.channel === wake.channel));
        if (rows.length) {
          const last = rows[rows.length - 1]!.occurredAt;
          if (wake.settleMs && P.now.getTime() < last.getTime() + wake.settleMs) return again(new Date(last.getTime() + wake.settleMs));
          const reply = { body: rows.map((e) => toText(e.payload.body)).join("\n"), channel: rows[rows.length - 1]!.payload.channel ?? null, at: iso(last), messages: rows.map((e) => ({ body: e.payload.body ?? "", at: iso(e.occurredAt) })) };
          P.run.context.reply = reply;
          return arrived(reply, { replies: rows.length });
        }
      }
      break;
    }
    case "answer": {
      const q = wake.ask ? { runId: P.run.id, node: wake.ask } : { tag: wake.tag!, since: new Date(wake.since) };
      const [first] = (await P.tx.events({ offerId: P.offer.id, types: ["ask.answered"], ...q })).filter(after);
      if (first) return arrived({ value: first.payload.value ?? null, person: first.payload.person ?? null, at: iso(first.occurredAt) }, { answer: first.id });
      break;
    }
    case "check": {
      const { ctx, env } = await view(P);
      const w = node as Wait1;
      if (holds(w.check!.holds, ctx, env)) return arrived(undefined, { checks: ((step.result.checks as number) ?? 0) + 1 });
      if (deadline && P.now >= deadline) return timedOut();
      await P.tx.updateStep(step.id, { result: { ...step.result, checks: ((step.result.checks as number) ?? 0) + 1 } });
      step.result.checks = ((step.result.checks as number) ?? 0) + 1;
      const at = new Date(Math.min(P.now.getTime() + wake.everyMs, deadline!.getTime()));
      return parkOn(P, step, wake, at);
    }
    default: throw new Error(`evaluate: ${wake.kind} is not waited on here`);
  }
  if (deadline && P.now >= deadline) return timedOut();
  return again(deadline);
}

// ---------------------------------------------------------------------------------------------------------------------
// message@1 and ask@1

const writeEffect = async (P: Pass, node: Node, step: StepRow, visit: number, x: { kind: string; effect: "contact" | "team" | "crm" | "external" | "read"; payload: Record<string, unknown> }, then?: "ask"): Promise<Next> => {
  const row = await P.tx.insertOutbox({
    offerId: P.offer.id, runId: P.run.id, stepId: step.id, node: node.id, kind: x.kind, effect: x.effect, idempotencyKey: `${P.run.id}:${node.id}:${visit}`,
    payload: x.payload, contactId: P.run.contactId, createdAt: P.now, nextAttemptAt: P.now,
  });
  P.run.context.acted = true;
  await P.tx.schedule({ kind: "outbox", id: row.id, at: P.now });
  return parkOn(P, step, { kind: "effect", node: node.id, step: step.id, outboxId: row.id, ...(then ? { then } : {}) }, null, { outbox: row.id });
};

async function message(P: Pass, node: Message1, step: StepRow, visit: number): Promise<Next> {
  const { ctx, env } = await view(P);
  if ("contact" in node.to) {
    const kind = node.kind ?? P.def.delivery.kind;
    let key = pickContent(node.content, ctx, env);
    let notAfter: Date | undefined;
    if (node.validity) {
      const v = node.validity;
      const t = toInstant(evalValue(`{{${"before" in v ? v.before : v.after}}}`, ctx, env));
      if (t) notAfter = "before" in v ? new Date(t.getTime() - toMs(v.minLead)) : new Date(t.getTime() + toMs(v.maxLag));
      if (notAfter && P.now > notAfter) {
        const ws = node.whenStale ?? P.def.delivery.whenStale;
        if (ws === "skip") return leave(P, node, step, "next", { stale: "too late for this message: skipped" }, "skipped");
        key = ws.send;
        notAfter = undefined;
      }
    }
    const w = P.def.sendWindow;
    if (w && (kind === "human" || w.transactional === "in_window")) {
      const zone = windowZone(w, env);
      if (!inWindow(P.now, w, zone)) {
        const at = nextOpen(P.now, w, zone);
        return parkOn(P, step, { kind: "window", node: node.id, step: step.id, at: iso(at) }, at, { window: `outside the send window: waits for ${iso(at)}` });
      }
    }
    const wd = await words(P, key, ctx, env);
    return writeEffect(P, node, step, visit, {
      kind: node.to.contact === "sms" ? "message.sms" : "message.email", effect: "contact",
      payload: {
        channel: node.to.contact, contentKey: wd.key, text: wd.text, ...(wd.subject !== undefined ? { subject: wd.subject } : {}), kind,
        ...(notAfter ? { notAfter: iso(notAfter) } : {}), render: wd.acc, ...(wd.missing ? { missingContent: [wd.key] } : {}),
        ...(P.run.contactId ? {} : { noContact: true }),
      },
    });
  }
  return slackPost(P, node, step, visit, pickContent(node.content, ctx, env), ctx, env);
}

async function slackTarget(P: Pass, to: Message1["to"] & { slack: unknown } | Ask1["to"] | { slack: Ask1["to"] }, ctx: Context, env: RenderEnv, acc: Acc): Promise<{ channel?: string; dm?: string; fromFact?: true }> {
  const t = ("slack" in to ? to.slack : to) as Ask1["to"];
  if ("channelFromFact" in t) return { channel: toText(evalValue(t.channelFromFact, ctx, env, acc)), fromFact: true };
  if ("channel" in t) {
    if (!t.fallbackChannel) return { channel: toText(evalValue(t.channel, ctx, env, acc)) };
    const first = toText(evalValue(t.channel, ctx, env));
    return { channel: first || toText(evalValue(t.fallbackChannel, ctx, env, acc)) };
  }
  const dm = toText(evalValue(t.dm, ctx, env));
  if (dm) return { dm };
  if (t.fallbackChannel) return { channel: toText(evalValue(t.fallbackChannel, ctx, env, acc)) };
  acc.blanks.push({ expr: t.dm, path: t.dm, reason: "missing" });
  return {};
}

async function slackPost(P: Pass, node: Message1, step: StepRow, visit: number, key: string, ctx: Context, env: RenderEnv): Promise<Next> {
  const wd = await words(P, key, ctx, env);
  const acc = wd.acc;
  const target = await slackTarget(P, node.to as Message1["to"] & { slack: unknown }, ctx, env, acc);
  const missing = wd.missing ? [wd.key] : [];
  const buttons = (node.buttons ?? []).filter((b) => !b.when || holds(b.when, ctx, env)).map((b) => {
    const label = wd.labels[b.action];
    if (!label && !wd.missing) missing.push(`${wd.key} (label for ${b.action})`);
    return { action: b.action, value: toText(evalValue(b.value, ctx, env, acc)), ...(b.style ? { style: b.style } : {}), label: label ?? "" };
  });
  return writeEffect(P, node, step, visit, {
    kind: "message.slack", effect: "team",
    payload: {
      ...target, contentKey: wd.key, text: wd.text, ...(wd.as ? { as: wd.as } : {}), ...(wd.icons ? { icons: wd.icons } : {}), buttons, render: acc,
      ...(node.thread ? { thread: "node" in node.thread ? { node: node.thread.node } : { tag: toText(evalValue(node.thread.tag, ctx, env)) } } : {}),
      ...(node.threadOnly ? { threadOnly: true } : {}),
      ...(node.remember ? { remember: toText(evalValue(node.remember, ctx, env)) } : {}),
      ...(node.edit ? { edit: true } : {}),
      ...(missing.length ? { missingContent: missing } : {}),
    },
  });
}

async function ask(P: Pass, node: Ask1, step: StepRow, visit: number): Promise<Next> {
  const { ctx, env } = await view(P);
  const wd = await words(P, pickContent(node.content, ctx, env), ctx, env);
  const acc = wd.acc;
  const target = await slackTarget(P, node.to, ctx, env, acc);
  const missing = wd.missing ? [wd.key] : [];
  let answers: Record<string, unknown>;
  if ("buttons" in node.answers) {
    answers = { buttons: node.answers.buttons.map((b) => {
      const label = wd.labels[b.value];
      if (!label && !wd.missing) missing.push(`${wd.key} (label for ${b.value})`);
      return { value: b.value, ...(b.style ? { style: b.style } : {}), label: label ?? "" };
    }) };
  } else answers = node.answers;
  const deadline = deadlineOf(P, node, ctx, env, false);
  await P.tx.updateStep(step.id, { result: { ...(deadline ? { deadline: iso(deadline) } : {}) } });
  step.result = deadline ? { deadline: iso(deadline) } : {};
  return writeEffect(P, node, step, visit, {
    kind: "slack.ask", effect: "team",
    payload: {
      ...target, contentKey: wd.key, text: wd.text, ...(wd.as ? { as: wd.as } : {}), ...(wd.icons ? { icons: wd.icons } : {}), answers, render: acc,
      ...(node.thread ? { thread: "node" in node.thread ? { node: node.thread.node } : { tag: toText(evalValue(node.thread.tag, ctx, env)) } } : {}),
      ...(node.remember ? { remember: toText(evalValue(node.remember, ctx, env)) } : {}),
      ...(missing.length ? { missingContent: missing } : {}),
    },
  }, "ask");
}

/** After an ask's post is settled: wait for its answer, go on, or go on listening. */
async function afterAsk(P: Pass, node: Ask1, step: StepRow, posted: boolean): Promise<Next> {
  const deadline = typeof step.result.deadline === "string" ? step.result.deadline : undefined;
  if (node.then === "go_on") return leave(P, node, step, "next", { posted });
  if (node.then === "listen") {
    P.run.listeners = [...P.run.listeners, { node: node.id, ...(deadline ? { deadline } : {}) }];
    return leave(P, node, step, "next", { posted, listening: true });
  }
  if (!posted && !deadline) return failStepHold(P, node, step, "the question was not posted, and nothing would end the wait for its answer");
  return evaluate(P, node, step, { kind: "answer", node: node.id, step: step.id, ask: node.id, since: iso(P.now), ...(deadline ? { deadline } : {}) });
}

async function failStepHold(P: Pass, node: Node, step: StepRow, why: string): Promise<Next> {
  return failStep(P, { ...node, onFailure: "hold" } as Node, step, why);
}

// ---------------------------------------------------------------------------------------------------------------------
// action@1

const CRM_MAPS = ["set", "fields", "fillBlank", "properties"];

/** Tags as one flat list of words: lists inside the list (a list held in a variable) flattened, empty ones dropped, each once. */
const tagList = (v: unknown): string[] => [...new Set((Array.isArray(v) ? v.flat(Infinity) : [v]).map(toText).map((t) => t.trim()).filter((t) => t !== ""))];

async function action(P: Pass, node: Action1, step: StepRow, visit: number): Promise<Next> {
  const def = actionDef(node.action)!;
  const { ctx, env } = await view(P);
  if (def.effect === "internal" || node.action === "facts.lookup") return internal(P, node, step, visit, ctx, env);
  const acc: Acc = { blanks: [], errors: [] };
  const params = evalValue(node.params, ctx, env, acc) as Record<string, unknown>;
  if (node.action === "crm.add_tag" || node.action === "crm.remove_tag") {
    // a list held in a variable is its tags, flattened; `keep` takes its tags out of what is removed
    params.tags = tagList(params.tags);
    if (params.keep !== undefined) {
      const keep = new Set(tagList(params.keep));
      params.kept = (params.tags as string[]).filter((t) => keep.has(t));
      params.tags = (params.tags as string[]).filter((t) => !keep.has(t));
      delete params.keep;
    }
  }
  const leftAlone: string[] = [];
  if (def.effect === "crm") {
    // a value that renders empty is left alone in the CRM, never blanked: `clear` is the one way to empty a field
    for (const m of CRM_MAPS) {
      const map = params[m];
      if (map && typeof map === "object" && !Array.isArray(map)) {
        for (const [k, v] of Object.entries(map as Record<string, unknown>)) if (v === "" || v === null || v === undefined) { delete (map as Record<string, unknown>)[k]; leftAlone.push(`${m}.${k}`); }
      }
    }
  }
  const content: Record<string, { text: string; subject?: string }> = {};
  const missing: string[] = [];
  for (const key of def.content?.(node.params) ?? []) {
    const wd = await words(P, key, ctx, env);
    if (wd.missing) missing.push(key);
    acc.blanks.push(...wd.acc.blanks); acc.errors.push(...wd.acc.errors);
    content[key] = { text: wd.text, ...(wd.subject !== undefined ? { subject: wd.subject } : {}) };
  }
  return writeEffect(P, node, step, visit, {
    kind: node.action, effect: def.effect as "contact" | "team" | "crm" | "external" | "read",
    payload: {
      params, render: acc, ...(Object.keys(content).length ? { content } : {}), ...(leftAlone.length ? { leftAlone } : {}),
      ...(missing.length ? { missingContent: missing } : {}), ...(P.run.appointmentId ? { appointmentId: P.run.appointmentId } : {}),
    },
  });
}

async function internal(P: Pass, node: Action1, step: StepRow, visit: number, ctx: Context, env: RenderEnv): Promise<Next> {
  const params = evalValue(node.params, ctx, env) as Record<string, unknown>;
  switch (node.action) {
    case "facts.record":
    case "facts.record_outcome": {
      const outcome = node.action === "facts.record_outcome";
      const type = outcome ? "appointment.outcome_recorded" : String(params.type);
      const data = outcome ? { outcome: params.outcome, call_outcome: params.callOutcome ?? null, notes: params.notes ?? null, source: params.source, person: params.person ?? null } : (params.data as Record<string, unknown>);
      const appointment = toText(params.appointment) || P.run.appointmentId;
      const { event, inserted } = await recordFact(P.tx, {
        offerId: P.offer.id, type, occurredAt: P.now, contactId: P.run.contactId, appointmentId: appointment || null, dealId: P.run.dealId,
        source: "workflow", dedupeKey: `run:${P.run.id}:${node.id}:${visit}`, payload: data, runId: P.run.id,
      });
      P.run.context.acted = true;
      P.fresh = undefined;
      if (inserted && !outcome && params.startsWorkflows) {
        if ((P.deps.depth ?? 0) >= MAX_CALL_DEPTH) throw new Error(`facts recorded by runs started by facts, more than ${MAX_CALL_DEPTH} deep`);
        await dispatchEvent({ ...P.deps, depth: (P.deps.depth ?? 0) + 1 }, event, { alsoOwn: params.startsThisWorkflow === true });
      }
      if (inserted) await nudge(P.deps, P.offer.id, { contactId: event.contactId, appointmentId: event.appointmentId, dealId: event.dealId }, P.run.id);
      return leave(P, node, step, "next", { event: event.id, type });
    }
    case "facts.lookup": {
      const query = params.query as keyof typeof LOOKUP_QUERIES;
      const q = params.params as Record<string, unknown>;
      if (query !== "last_event") {
        const standIn = await P.deps.lookup?.({ offerId: P.offer.id, query, params: q, contactId: P.run.contactId, appointmentId: P.run.appointmentId, now: P.now });
        const answer = standIn ? standIn.answer : await answerLookup({ tx: P.tx, offerId: P.offer.id, contactId: P.run.contactId, appointmentId: P.run.appointmentId, now: P.now, ...(P.deps.reads?.transcripts ? { transcripts: P.deps.reads.transcripts } : {}) }, query, q);
        if (node.into) P.run.context.vars[node.into] = (answer ?? null) as never;
        return leave(P, node, step, "next", { found: answer === undefined || answer === null ? null : query });
      }
      const about = toText(q.about) || "contact";
      const since = toInstant(q.since), until = toInstant(q.until);
      const subject = about === "appointment" ? { appointmentId: P.run.appointmentId ?? "" } : { contactId: P.run.contactId ?? "" };
      const [e] = await P.tx.events({ offerId: P.offer.id, types: [toText(q.type)], ...subject, ...(since ? { since } : {}), ...(until ? { until } : {}), order: "desc", limit: 1 });
      if (node.into) P.run.context.vars[node.into] = (e ? eventView(e) : null) as never;
      return leave(P, node, step, "next", { found: e?.id ?? null });
    }
    case "runs.pause_others": {
      const about = params.scope === "appointment" ? { appointmentId: P.run.appointmentId } : { contactId: P.run.contactId };
      const others = (await P.tx.runs({ offerId: P.offer.id, statuses: ["waiting"], about })).filter((r) => r.id !== P.run.id);
      for (const r of others) {
        await P.tx.updateRun(r.id, { status: "paused", wake: { kind: "paused_by_run", node: r.currentNode, step: r.wake?.step ?? 0, by: P.run.id, prior: r.wake, priorAt: r.nextWakeAt ? iso(r.nextWakeAt) : null, priorStatus: r.status }, nextWakeAt: null, updatedAt: P.now });
      }
      P.run.context.acted = true;
      return leave(P, node, step, "next", { paused: others.map((r) => r.id) });
    }
    default: throw new Error(`${node.action} is not an internal action`);
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Listeners and $resume

/** Takes the run along a listening ask's `answered` or `expired` path, remembering where to come back to. */
async function interrupt(P: Pass, l: Listener, outcome: "answered" | "expired", value: unknown, back: { node: string; wake: Wake | null }): Promise<Next> {
  const askNode = P.byId.get(l.node) as Ask1;
  P.run.listeners = P.run.listeners.filter((x) => x.node !== l.node);
  P.run.context.vars[askNode.into] = value as never;
  const edge = (P.outs.get(l.node) ?? []).find((e) => e.on === outcome);
  const step = await newStep(P, askNode, P.run.context.visits[l.node] ?? 1);
  await P.tx.updateStep(step.id, { status: "ok", finishedAt: P.now, result: { interrupt: outcome, from: back.node, ...(value ? { answer: value } : {}) } });
  if (!edge) return back.wake ? { park: back.wake, at: P.now, status: "waiting" } : { to: back.node };
  P.run.resume = { node: back.node, wake: back.wake, at: back.wake ? iso(P.now) : null };
  return { to: edge.to };
}

/** An armed listener that has its answer, or whose deadline has come, takes the run off where it is parked. */
async function listenerFires(P: Pass, parked: Wake): Promise<Next | undefined> {
  for (const l of P.run.listeners) {
    const [a] = await P.tx.events({ offerId: P.offer.id, types: ["ask.answered"], runId: P.run.id, node: l.node, limit: 1 });
    if (a) return interrupt(P, l, "answered", { value: a.payload.value ?? null, person: a.payload.person ?? null, at: iso(a.occurredAt) }, { node: parked.node, wake: parked });
    if (l.deadline && new Date(l.deadline) <= P.now) return interrupt(P, l, "expired", null, { node: parked.node, wake: parked });
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------------------------------------
// Driving a run

async function drive(P: Pass, first: Next): Promise<void> {
  let next = first;
  for (let i = 0; i < MAX_STEPS_PER_PASS; i++) {
    if ("end" in next) return finish(P, next);
    if ("park" in next) {
      if (next.status === "waiting" && P.run.listeners.length) {
        const fired = await listenerFires(P, next.park);
        if (fired) { next = fired; continue; }
      }
      return park(P, next);
    }
    if (next.to === RESUME) {
      const r = P.run.resume;
      P.run.resume = null;
      if (!r) { next = { end: "nothing to resume to", status: "failed" }; continue; }
      next = r.wake ? { park: r.wake, at: P.now, status: "waiting" } : { to: r.node };
      continue;
    }
    const node = P.byId.get(next.to);
    if (!node) { next = { end: `the version has no node ${next.to}`, status: "failed" }; continue; }
    next = await enter(P, node);
  }
  return finish(P, { end: `more than ${MAX_STEPS_PER_PASS} steps without a wait`, status: "failed" });
}

async function park(P: Pass, n: Extract<Next, { park: Wake }>): Promise<void> {
  let at = n.at;
  if (n.status === "waiting") for (const l of P.run.listeners) if (l.deadline) at = later(at, new Date(l.deadline));
  await P.tx.updateRun(P.run.id, {
    status: n.status, currentNode: n.park.node, wake: n.park, nextWakeAt: n.status === "waiting" ? at : null, context: P.run.context,
    listeners: P.run.listeners, resume: P.run.resume, updatedAt: P.now, leaseOwner: null, leaseUntil: null,
  });
  if (n.status === "waiting" && at) await P.tx.schedule({ kind: "run", id: P.run.id, at });
}

async function finish(P: Pass, n: Extract<Next, { end: string }>): Promise<void> {
  for (const st of await P.tx.steps(P.run.id)) if (st.status === "waiting") await P.tx.updateStep(st.id, { status: "skipped", finishedAt: P.now, result: { ...st.result, unfinished: `the run ended (${n.end}) while this step waited` } });
  const release = !P.run.context.acted && n.status !== "failed";
  await P.tx.updateRun(P.run.id, {
    status: n.status, endReason: n.end, wake: null, nextWakeAt: null, listeners: [], resume: null, context: P.run.context, currentNode: P.run.currentNode,
    updatedAt: P.now, finishedAt: P.now, leaseOwner: null, leaseUntil: null,
    // a run that stopped before doing anything does not count toward "once per …": its key is released
    ...(release ? { reentryKey: `${P.run.reentryKey}~released~${P.run.id}` } : {}),
  });
  if (release) {
    for (const p of P.run.pendingTriggers) {
      const e = await P.tx.event(p.eventId);
      if (e) await startForTrigger(P.deps, e, P.wf, p.triggerNode);
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Starting runs

export type StartArgs = {
  offer: OfferRow; workflow: WorkflowRow; version: VersionRow; triggerNode: string;
  event: EventRow | null; eventView: Record<string, unknown>; eventKey: string; subjects: Subjects; snapshot: Record<string, unknown>;
  /** A schedule's period: one run per period whatever the policy. */
  period?: string;
};

/** Starts a run unless the reentry policy says this subject already has one. Gives back the run's id, or null. */
export async function startRun(deps: Deps, a: StartArgs): Promise<string | null> {
  const { tx, now } = deps;
  const { def } = definitionOf(a.version);
  const s = a.subjects;
  const who = s.contactId ? `contact:${s.contactId}` : `event:${a.eventKey}`;
  const policy = def.reentry.policy;
  let base = a.period ? `schedule:${a.triggerNode}:${a.period}` : policy === "once_per_contact" || policy === "once_per_contact_per_window" ? who
    : policy === "once_per_appointment" ? (s.appointmentId ? `appointment:${s.appointmentId}` : who)
    : policy === "once_per_deal" ? (s.dealId ? `deal:${s.dealId}` : who) : `event:${a.eventKey}`;
  const remember = async (holder: RunRow | undefined) => {
    if (holder && a.event && (IN_FLIGHT as readonly string[]).includes(holder.status) && !holder.pendingTriggers.some((p) => p.eventId === a.event!.id)) {
      await tx.updateRun(holder.id, { pendingTriggers: [...holder.pendingTriggers, { eventId: a.event.id, triggerNode: a.triggerNode }] });
    }
    return null;
  };
  if (policy === "once_per_contact_per_window" && s.contactId && !a.period) {
    const recent = await tx.runs({ workflowId: a.workflow.id, about: { contactId: s.contactId }, startedSince: new Date(now.getTime() - toMs(def.reentry.window!)) });
    if (recent.some((r) => r.contactId === s.contactId)) return null;
    base = `${who}:${now.getTime()}`;
  }
  let key = base;
  const settings = await tx.settings(a.offer.id);
  const fresh = await freshSubjects(tx, { offer: a.offer, settings, subjects: s, now, event: a.eventView });
  const pre: RunContext = { event: a.eventView, subjects: a.snapshot, vars: {}, visits: {}, acted: false };
  if (def.reentry.key && !a.period) {
    const b = buildContext({ run: { id: "", startedAt: now, context: pre }, workflowKey: a.workflow.key, offer: a.offer, settings, subjects: fresh, now });
    const suffix = render(def.reentry.key, b.ctx, b.env);
    if (suffix.text && !suffix.blanks.length && !suffix.errors.length) {
      key = `${base}@${suffix.text}`;
      // a run still in flight for this subject owns it (its waits follow the moved time); this trigger is remembered on it
      const inflight = (await tx.runs({ workflowId: a.workflow.id, reentryBase: base, statuses: [...IN_FLIGHT] }))[0];
      if (inflight) return remember(inflight);
    }
  }
  const row: NewRun = {
    offerId: a.offer.id, workflowId: a.workflow.id, versionId: a.version.id, triggerNode: a.triggerNode, status: "active", currentNode: a.triggerNode,
    context: pre, contactId: s.contactId, appointmentId: s.appointmentId, dealId: s.dealId, reentryKey: key, reentryBase: base,
    nextWakeAt: null, wake: null, listeners: [], resume: null, pendingTriggers: [], startedAt: now, updatedAt: now,
  };
  const run = await tx.insertRun(row);
  if (!run) {
    const holder = (await tx.runs({ workflowId: a.workflow.id, reentryBase: base })).find((r) => r.reentryKey === key);
    return remember(holder);
  }
  const P = await loadPass(deps, run);
  await drive(P, { to: a.triggerNode });
  return run.id;
}

async function startForTrigger(deps: Deps, e: EventRow, wf: WorkflowRow, triggerNode: string): Promise<string | null> {
  if (!wf.currentVersionId) return null;
  const [version, offer] = await Promise.all([deps.tx.version(wf.currentVersionId), deps.tx.offer(e.offerId)]);
  return startRun(deps, {
    offer: offer!, workflow: wf, version: version!, triggerNode, event: e, eventView: eventView(e), eventKey: String(e.id),
    subjects: { contactId: e.contactId, appointmentId: e.appointmentId, dealId: e.dealId }, snapshot: snapshotOf(e.payload),
  });
}

/**
 * A fact arrived: every enabled workflow with a trigger on it (whose match holds) starts a run, subject to reentry. A
 * fact a run recorded never starts that run's own workflow again, unless the step said so (`alsoOwn`).
 */
export async function dispatchEvent(deps: Deps, e: EventRow, o: { alsoOwn?: boolean } = {}): Promise<string[]> {
  const { tx, now } = deps;
  const offer = (await tx.offer(e.offerId))!;
  const settings = await tx.settings(e.offerId);
  const own = e.runId && !o.alsoOwn ? (await tx.run(e.runId))?.workflowId : undefined;
  const started: string[] = [];
  const subjects = await freshSubjects(tx, { offer, settings, subjects: { contactId: e.contactId, appointmentId: e.appointmentId, dealId: e.dealId }, now, event: eventView(e) });
  for (const wf of await tx.workflows(e.offerId)) {
    if (!wf.enabled || !wf.currentVersionId || wf.id === own) continue;
    const version = (await tx.version(wf.currentVersionId))!;
    const { def } = definitionOf(version);
    const ctx: Context = { ...mergeSubjects(snapshotOf(e.payload), subjects), event: eventView(e), setting: nestSettings(settings), offer: { id: offer.id, slug: offer.slug, name: offer.name, zone: offer.zone } };
    const env = buildContext({ run: { id: "", startedAt: now, context: { event: {}, subjects: {}, vars: {}, visits: {}, acted: false } }, workflowKey: wf.key, offer, settings, subjects, now }).env;
    const trigger = def.nodes.find((n) => n.type === "trigger@1" && "event" in n.on && n.on.event === e.type && (!n.on.match || holds(n.on.match, ctx, env)));
    if (!trigger) continue;
    const id = await startForTrigger(deps, e, wf, trigger.id);
    if (id) started.push(id);
  }
  return started;
}

/** Waiting runs about these subjects look again now: a fact about them may be what they wait for, or end them. */
export async function nudge(deps: Deps, offerId: string, about: { contactId: string | null; appointmentId: string | null; dealId: string | null }, except?: string): Promise<void> {
  if (!about.contactId && !about.appointmentId && !about.dealId) return;
  for (const r of await deps.tx.runs({ offerId, statuses: ["waiting"], about })) {
    if (r.id === except) continue;
    await deps.tx.updateRun(r.id, { nextWakeAt: deps.now });
    await deps.tx.schedule({ kind: "run", id: r.id, at: deps.now });
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Waking runs

/**
 * A due run looks at what it waits on. First the premise (a run whose premise no longer holds ends there), then an
 * armed listener (an answer, or its deadline), then the wait itself. Gives back whether the run was worked on (false: not due, not waiting, or held by another worker).
 */
export async function wakeRun(deps: Deps, runId: string): Promise<boolean> {
  const run = await deps.tx.run(runId, "skip");
  if (!run || run.status !== "waiting" || !run.nextWakeAt || run.nextWakeAt > deps.now || !run.wake) return false;
  const P = await loadPass(deps, run);
  const wake = run.wake;
  await deps.tx.updateRun(run.id, { leaseOwner: "engine", leaseUntil: new Date(deps.now.getTime() + 60_000) });
  const node = P.byId.get(wake.node);
  const step = await deps.tx.step(wake.step);
  if (!node || !step) { await drive(P, { end: `the run is parked on ${wake.node}, which is gone`, status: "failed" }); return true; }
  if (P.def.premise) {
    const { ctx, env } = await view(P);
    if (premiseFails(P, ctx, env)) { await drive(P, await premiseEnd(P, step)); return true; }
  }
  const fired = await listenerFires(P, wake);
  if (fired) { await drive(P, fired); return true; }
  let next: Next;
  const runBefore = structuredClone(P.run);
  try {
    next = await P.tx.savepoint(() => evaluateWake(P, node, step, wake));
  } catch (e) {
    P.run = runBefore;
    P.fresh = undefined;
    next = await failStep(P, node, step, e instanceof Error ? e.message : String(e));
  }
  await drive(P, next);
  return true;
}

async function evaluateWake(P: Pass, node: Node, step: StepRow, wake: Wake): Promise<Next> {
  switch (wake.kind) {
    case "time": return timeWait(P, node as Wait1, step, wake);
    case "window": return message(P, node as Message1, step, P.run.context.visits[node.id] ?? 1);
    case "effect": return settle(P, node, step, wake);
    case "event": case "reply": case "answer": case "check": return evaluate(P, node, step, wake);
    default: return { park: wake, at: null, status: "paused" };
  }
}

/** The dispatcher settled the step's outbox row: go on (sent, suppressed, held), or apply the step's failure rule. */
async function settle(P: Pass, node: Node, step: StepRow, wake: Extract<Wake, { kind: "effect" }>): Promise<Next> {
  const row = await P.tx.outboxRow(wake.outboxId);
  if (!row || row.status === "queued" || row.status === "sending") return { park: wake, at: null, status: "waiting" };
  const into = (node as { into?: string }).into;
  if (row.status === "failed" || row.status === "unknown") {
    const why = row.status === "unknown" ? `the result is unknown, so it is never sent again: ${row.lastError ?? ""}`.trim() : `${row.errorClass ?? "failed"}: ${row.lastError ?? ""}`.trim();
    return failStep(P, node, { ...step, result: { ...step.result, outboxStatus: row.status } }, why);
  }
  if (wake.then === "ask") return afterAsk(P, node as Ask1, { ...step, result: { ...step.result, outboxStatus: row.status } }, row.status === "sent");
  if (into) P.run.context.vars[into] = (row.status === "sent" ? row.result : null) as never;
  return leave(P, node, step, "next", { outboxStatus: row.status });
}

// ---------------------------------------------------------------------------------------------------------------------
// A person's hand on a run

/**
 * An operator resumes a paused run: a wait for a person leaves by `resumed`; a step held after failing is tried again
 * (`retry`) or skipped (`skip`); a run another run paused goes back to what it was waiting on.
 */
export async function resumeRun(deps: Deps, runId: string, how: "resume" | "retry" | "skip" = "resume"): Promise<RunRow> {
  const run = await deps.tx.run(runId, "wait");
  if (!run || run.status !== "paused" || !run.wake) throw new Error(`run ${runId} is not paused`);
  const P = await loadPass(deps, run);
  const wake = run.wake;
  const node = P.byId.get(wake.node)!;
  const step = (await deps.tx.step(wake.step))!;
  await deps.tx.resolveAlert(`run:${run.id}:held`, deps.now);
  if (wake.kind === "person") await drive(P, await leave(P, node, step, "resumed", { resumedAt: iso(deps.now) }));
  else if (wake.kind === "paused_by_run") {
    await deps.tx.updateRun(run.id, { status: wake.priorStatus === "paused" ? "paused" : "waiting", wake: wake.prior, nextWakeAt: wake.prior ? deps.now : null, updatedAt: deps.now });
    if (wake.prior) await deps.tx.schedule({ kind: "run", id: run.id, at: deps.now });
  } else if (wake.kind === "hold") {
    if (how === "skip") {
      await deps.tx.updateStep(step.id, { status: "skipped", finishedAt: deps.now, result: { ...step.result, skippedBy: "operator" } });
      const edge = (P.outs.get(node.id) ?? []).find((e) => (e.on ?? "next") === "next");
      await drive(P, edge ? { to: edge.to } : { end: `step ${node.id} was skipped and has no plain way on`, status: "failed" });
    } else {
      await deps.tx.updateStep(step.id, { status: "failed", finishedAt: deps.now });
      await drive(P, { to: node.id });
    }
  } else throw new Error(`run ${runId} is paused on ${wake.kind}, which an operator does not resume`);
  return (await deps.tx.run(runId))!;
}

/** An operator ends a run where it is. */
export async function endRun(deps: Deps, runId: string, reason = "ended_by_operator"): Promise<void> {
  const run = await deps.tx.run(runId, "wait");
  if (!run || !(IN_FLIGHT as readonly string[]).includes(run.status)) throw new Error(`run ${runId} is not in flight`);
  if (run.wake) await deps.tx.updateStep(run.wake.step, { status: "skipped", finishedAt: deps.now });
  await deps.tx.updateRun(run.id, { status: "ended", endReason: reason, wake: null, nextWakeAt: null, listeners: [], finishedAt: deps.now, updatedAt: deps.now });
  await deps.tx.resolveAlert(`run:${run.id}:held`, deps.now);
}

/** A person starts a workflow by hand (a manual trigger) about one subject. */
export async function startManual(deps: Deps, x: { workflowId: string; subjects: Subjects; by: string; data?: Record<string, unknown> }): Promise<string | null> {
  const wf = await deps.tx.workflow(x.workflowId);
  if (!wf?.enabled || !wf.currentVersionId) throw new Error("the workflow is not enabled");
  const version = (await deps.tx.version(wf.currentVersionId))!;
  const { def } = definitionOf(version);
  const trigger = def.nodes.find((n) => n.type === "trigger@1" && "manual" in n.on);
  if (!trigger) throw new Error(`${wf.key} has no manual trigger`);
  const offer = (await deps.tx.offer(wf.offerId))!;
  const key = `manual:${x.by}:${deps.now.getTime()}`;
  return startRun(deps, { offer, workflow: wf, version, triggerNode: trigger.id, event: null, eventView: { ...(x.data ?? {}), type: "workflow.started_by_hand", by: x.by, occurred_at: iso(deps.now) }, eventKey: key, subjects: x.subjects, snapshot: {} });
}

/**
 * A schedule trigger's time came: one run for the offer for that period, or, for a schedule `for` a role, one run for
 * the person given (carried as the run's `person`). `period` names the period (the job runner's: the local date, or
 * the interval's bucket); without it the moment itself is the period. Once per period per subject, by the reentry key.
 * `firePeriod` (schedule.ts) fires one for each person with the role.
 */
export async function fireSchedule(deps: Deps, x: { workflowId: string; triggerNode: string; at: Date; person?: Record<string, unknown> & { id: string }; period?: string }): Promise<string | null> {
  const wf = await deps.tx.workflow(x.workflowId);
  if (!wf?.enabled || !wf.currentVersionId) return null;
  const version = (await deps.tx.version(wf.currentVersionId))!;
  const { def } = definitionOf(version);
  const t = def.nodes.find((n) => n.id === x.triggerNode);
  if (!t || t.type !== "trigger@1" || !("schedule" in t.on)) throw new Error(`${x.triggerNode} is not a schedule trigger`);
  const forRole = t.on.schedule.for !== "offer";
  if (forRole && !x.person) throw new Error("a schedule for each person with a role runs once per person: name the person (firePeriod finds them)");
  if (!forRole && x.person) throw new Error(`${x.triggerNode} is a schedule for the offer, not for a person`);
  const offer = (await deps.tx.offer(wf.offerId))!;
  const base = x.period ?? iso(x.at);
  const period = x.person ? `${base}:${x.person.id}` : base;
  return startRun(deps, { offer, workflow: wf, version, triggerNode: t.id, event: null, eventView: { type: "schedule", occurred_at: iso(x.at), ...(x.period ? { period: x.period } : {}) }, eventKey: `schedule:${period}`, subjects: { contactId: null, appointmentId: null, dealId: null }, snapshot: x.person ? { person: x.person } : {}, period });
}
