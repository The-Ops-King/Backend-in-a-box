import { Engine } from "@/engine/engine";
import { FakePorts } from "@/engine/fake-ports";
import { MemStore } from "@/engine/mem-store";
import { type ContentSeed, FakeClock, install, setupOffer } from "@/engine/testkit";
import type { GateDecision, OutboxRow, RunRow, StepRow } from "@/engine/types";
import type { Node } from "@/workflow/definition";
import { validateWorkflow } from "@/workflow/validate";
import { advanceTo, inFlight, nextDue } from "@/engine/drive";
import { Scenario, type ScenarioInput, relative, timeOf } from "./scenario";

/**
 * The simulator: the engine's own interpreter, gate and dispatcher, on a fake clock, with fake ports and an in-memory
 * store. It takes a workflow version and a scenario and gives back the exact timeline: every step, every outbox row
 * with its rendered words and gate decisions, every wait with its computed wake time, and how each run ended.
 */

export type SimOutbox = {
  at: string; rel: string; node: string; step: string; kind: string; to: string; contentKey: string | null; text: string | null; subject?: string;
  status: OutboxRow["status"]; gates: GateDecision[]; settledAt: string | null; relSettled: string | null; why: string | null;
};
export type SimWait = { node: string; title: string; reachedAt: string; rel: string; wakeAt: string | null; relWake: string | null; computed?: string; moved?: string; outcome: string | null; status: StepRow["status"] };
export type SimStep = { at: string; rel: string; node: string; title: string; primitive: string; status: StepRow["status"]; outcome: string | null; result: Record<string, unknown> };
export type SimRun = { id: string; workflow: string; status: RunRow["status"]; endReason: string | null; startedAt: string; finishedAt: string | null; relEnd: string | null };
export type TimelineEntry = { at: string; rel: string; what: string };

export type SimResult = {
  scenario: string; workflow: string; delivery: string; crmWrites: string; start: string;
  runs: SimRun[]; steps: SimStep[]; outbox: SimOutbox[]; waits: SimWait[]; alerts: { at: string; kind: string; message: string }[];
  timeline: TimelineEntry[];
  expectations: { ok: boolean; failures: string[] };
};

export type SimInput = {
  /** The workflow version under test. */
  definition: unknown;
  scenario: ScenarioInput;
  /** The words, by key. */
  content: ContentSeed;
  /** Other workflows of the offer the version may call. */
  others?: unknown[];
};

/** Who a step's effect reaches, as the definition says it (a setting stays a setting, so diffs do not depend on channel ids). */
export function whoOf(node: Node | undefined, row: Pick<OutboxRow, "kind" | "effect">): string {
  if (node?.type === "message@1") {
    if ("contact" in node.to) return `contact (${node.to.contact})`;
    const s = node.to.slack;
    return "channel" in s ? `slack ${s.channel}` : `slack dm ${s.dm}`;
  }
  if (node?.type === "ask@1") return "channel" in node.to ? `slack ${node.to.channel}` : `slack dm ${node.to.dm}`;
  return row.effect === "contact" ? "contact" : row.effect;
}

export async function simulate(input: SimInput): Promise<SimResult> {
  const sc = Scenario.parse(input.scenario);
  const v = validateWorkflow(input.definition);
  if (!v.ok) throw new Error(`the workflow does not validate: ${v.problems.map((p) => p.message).join("; ")}`);
  if (v.workflow.id !== sc.workflow) throw new Error(`scenario "${sc.name}" is for ${sc.workflow}, not ${v.workflow.id}`);
  const start = new Date(sc.start);
  const clock = new FakeClock(start);
  const store = new MemStore();
  const fp = new FakePorts(clock.now);
  for (const c of sc.contacts) fp.contacts.set(c.id, { id: c.id, phone: c.phone ?? null, email: c.email ?? null, timezone: c.timezone ?? null, dnd: c.dnd ?? {} });
  const offerId = await setupOffer(store, { slug: "sim", zone: sc.offer.zone, settings: sc.offer.settings, content: input.content, operator: sc.operator });
  for (const o of input.others ?? []) await install(store, offerId, o, { now: start, delivery: sc.delivery, crmWrites: sc.crmWrites });
  const wf = await install(store, offerId, input.definition, { now: start, delivery: sc.delivery, crmWrites: sc.crmWrites });
  await seedPriorSends(store, offerId, sc, start);
  const fx = sc.fixtures;
  const turn = <T>(v: unknown, used: Map<string, number>, key: string): T => {
    if (!Array.isArray(v)) return v as T;
    const i = used.get(key) ?? 0;
    used.set(key, i + 1);
    if (i >= v.length) throw new Error(`scenario "${sc.name}": the fixture ${key} has ${v.length} answers and a ${i + 1}th was asked for`);
    return v[i] as T;
  };
  const usedLookups = new Map<string, number>(), usedReports = new Map<string, number>();
  let classified = 0, summarized = 0;
  fp.classify = (p) => {
    const a = fx.classify[classified++];
    if (a === undefined) return { value: p.options[0]!, confidence: 1 };
    return typeof a === "string" ? { value: a, confidence: 1 } : a;
  };
  fp.summarize = () => (summarized < fx.summarize.length ? fx.summarize[summarized++] : {});
  const engine = new Engine({
    store, ports: fp.ports(), now: clock.now, random: () => 0.5, worker: "sim",
    lookup: async ({ query }) => {
      if (!(query in fx.lookups)) throw new Error(`facts.lookup ${query}: the scenario gives no answer for it (fixtures.lookups)`);
      return turn(fx.lookups[query], usedLookups, query);
    },
    reports: async ({ report }) => {
      if (!(report in fx.reports)) throw new Error(`report ${report}: the scenario gives no rendered report for it (fixtures.reports)`);
      return turn(fx.reports[report], usedReports, report);
    },
  });

  const steps = [...sc.steps].map((s, i) => ({ s, i, at: timeOf(s.at, start) })).sort((a, b) => a.at.getTime() - b.at.getTime() || a.i - b.i);
  for (const { s, i, at } of steps) {
    await advanceTo(engine, store, clock, at);
    if ("type" in s) {
      await engine.ingest({ offerId, type: s.type, source: s.source, dedupeKey: s.dedupeKey ?? `scenario:${i}`, contactId: s.contact ?? null, appointmentId: s.appointment ?? null, dealId: s.deal ?? null, payload: s.payload });
    } else if ("reply" in s) {
      await engine.ingest({ offerId, type: "message.received", source: "scenario", dedupeKey: `scenario:${i}`, contactId: s.reply.contact, payload: { channel: s.reply.channel, body: s.reply.body } });
    } else if ("answer" in s) {
      const a = s.answer;
      const post = await store.tx(async (tx) => (await tx.posts({ offerId, ...(a.node ? { node: a.node } : { tag: a.tag! }) }))[0]);
      if (!post) throw new Error(`scenario "${sc.name}" step ${i}: no question posted for ${a.node ?? a.tag}`);
      await engine.answer({ offerId, channel: post.channel, ts: post.ts, value: a.value, person: a.person });
    } else if ("fail" in s) {
      fp.failNext({ port: s.fail.port, failure: s.fail.failure, times: s.fail.times, ...(s.fail.method ? { method: s.fail.method } : {}) });
    } else if ("schedule" in s) {
      const node = v.workflow.nodes.find((n) => n.id === s.schedule.node);
      if (!node || node.type !== "trigger@1" || !("schedule" in node.on)) throw new Error(`scenario "${sc.name}" step ${i}: ${s.schedule.node} is not a schedule trigger`);
      const forWhom = node.on.schedule.for;
      if (forWhom === "offer") await engine.fireSchedule({ workflowId: wf.id, triggerNode: node.id, at });
      else for (const person of sc.people.filter((p) => p.role === forWhom.role)) await engine.fireSchedule({ workflowId: wf.id, triggerNode: node.id, at, person });
    } else if ("operator" in s) {
      const paused = await store.tx((tx) => tx.runs({ offerId, statuses: ["paused"] }));
      if (!paused[0]) throw new Error(`scenario "${sc.name}" step ${i}: no paused run for the operator`);
      if ("resume" in s.operator) await engine.resume(paused[0].id, s.operator.resume);
      else await engine.end(paused[0].id, s.operator.end);
    }
    await engine.runDue();
  }
  if (sc.until) await advanceTo(engine, store, clock, timeOf(sc.until, start));
  else {
    const limit = new Date(clock.now().getTime() + 60 * 86_400_000);
    while ((await inFlight(store)) > 0) {
      const next = await nextDue(store, clock.now());
      if (!next || next > limit) break;
      await advanceTo(engine, store, clock, next);
    }
  }
  return report(store, sc, wf.id, input.definition);
}

/** Messages other workflows already sent: rows of a stand-in workflow, sent, so the cap counts them. */
async function seedPriorSends(store: MemStore, offerId: string, sc: Scenario, start: Date) {
  if (!sc.priorSends.length) return;
  await store.tx(async (tx) => {
    const wf = await tx.insertWorkflow({ offerId, key: "other-workflows", name: "Other workflows (stand-in)" });
    const v = await tx.insertVersion({ offerId, workflowId: wf.id, version: 1, definition: { note: "a stand-in for what other workflows sent" }, createdBy: "sim", reason: "prior sends", createdAt: start });
    let n = 0;
    for (const p of sc.priorSends) {
      for (let k = 0; k < p.count; k++) {
        const at = timeOf(p.at, start);
        const run = (await tx.insertRun({ offerId, workflowId: wf.id, versionId: v.id, triggerNode: "t", status: "completed", currentNode: "t", context: { event: {}, subjects: {}, vars: {}, visits: {}, acted: true }, contactId: p.contact, appointmentId: null, dealId: null, reentryKey: `prior:${n}`, reentryBase: `prior:${n}`, nextWakeAt: null, wake: null, listeners: [], resume: null, pendingTriggers: [], startedAt: at, updatedAt: at }))!;
        const step = await tx.insertStep({ offerId, runId: run.id, node: "m", primitive: "message@1", visit: 1, status: "ok", startedAt: at, finishedAt: at, result: {}, error: null });
        const row = await tx.insertOutbox({ offerId, runId: run.id, stepId: step.id, node: "m", kind: `message.${p.channel}`, effect: "contact", idempotencyKey: `prior:${n++}`, payload: { contentKey: "other.message", text: "(another workflow's message)" }, contactId: p.contact, createdAt: at, nextAttemptAt: null });
        await tx.updateOutbox(row.id, { status: "sent", sentAt: at, settledAt: at });
      }
    }
  });
}

function report(store: MemStore, sc: Scenario, workflowId: string, definition: unknown): SimResult {
  const s = store.snapshot();
  const start = new Date(sc.start);
  const rel = (d: Date | string) => relative(d, start);
  const def = validateWorkflow(definition);
  const nodes = new Map((def.ok ? def.workflow.nodes : []).map((n) => [n.id, n]));
  const runs = s.runs.filter((r) => r.workflowId !== s.workflows.find((w) => w.key === "other-workflows")?.id);
  const runIds = new Set(runs.map((r) => r.id));
  const wfKey = (id: string) => s.workflows.find((w) => w.id === id)?.key ?? id;
  const steps = s.steps.filter((x) => runIds.has(x.runId)).sort((a, b) => a.id - b.id);
  const title = (node: string) => nodes.get(node)?.title ?? node;

  const outbox: SimOutbox[] = s.outbox.filter((o) => runIds.has(o.runId)).sort((a, b) => a.id - b.id).map((o) => {
    const p = o.payload as { contentKey?: string; text?: string; subject?: string };
    const decisive = o.gates.find((g) => g.result !== "pass" && g.result !== "not_applicable" && g.result !== "reroute");
    return {
      at: o.createdAt.toISOString(), rel: rel(o.createdAt), node: o.node, step: title(o.node), kind: o.kind, to: whoOf(nodes.get(o.node), o),
      contentKey: p.contentKey ?? null, text: p.text ?? null, ...(p.subject !== undefined ? { subject: p.subject } : {}), status: o.status, gates: o.gates,
      settledAt: o.settledAt?.toISOString() ?? null, relSettled: o.settledAt ? rel(o.settledAt) : null, why: decisive?.why ?? o.lastError ?? null,
    };
  });
  const waits: SimWait[] = steps.filter((x) => x.primitive === "wait@1" || x.result.window || x.result.wakeAt).map((x) => ({
    node: x.node, title: title(x.node), reachedAt: x.startedAt.toISOString(), rel: rel(x.startedAt),
    wakeAt: (x.result.wakeAt as string) ?? null, relWake: x.result.wakeAt ? rel(x.result.wakeAt as string) : null,
    ...(x.result.computed ? { computed: x.result.computed as string } : {}), ...(x.result.moved ? { moved: x.result.moved as string } : {}),
    outcome: (x.result.outcome as string) ?? null, status: x.status,
  }));
  const simSteps: SimStep[] = steps.map((x) => ({ at: x.startedAt.toISOString(), rel: rel(x.startedAt), node: x.node, title: title(x.node), primitive: x.primitive, status: x.status, outcome: (x.result.outcome as string) ?? null, result: x.result }));
  const simRuns: SimRun[] = runs.map((r) => ({ id: r.id, workflow: wfKey(r.workflowId), status: r.status, endReason: r.endReason, startedAt: r.startedAt.toISOString(), finishedAt: r.finishedAt?.toISOString() ?? null, relEnd: r.finishedAt ? rel(r.finishedAt) : null }));

  const timeline: (TimelineEntry & { t: number; o: number })[] = [];
  const push = (at: Date, o: number, what: string) => timeline.push({ at: at.toISOString(), rel: rel(at), what, t: at.getTime(), o });
  for (const e of s.events.filter((e) => e.runId === null || runIds.has(e.runId))) push(e.occurredAt, e.id, `fact ${e.type}${e.runId ? " (recorded by the run)" : ""}`);
  for (const r of runs) push(r.startedAt, 1e6, `run started (${wfKey(r.workflowId)})`);
  const MOVED: Record<string, string> = { to_opening: "to the window's opening", earlier_same_day: "to just before the window closes", next_open: "to the window's next opening" };
  for (const x of steps) {
    const res = x.result;
    const words = x.primitive === "wait@1"
      ? res.wakeAt ? `wait "${title(x.node)}": wakes ${rel(res.wakeAt as string)}${res.moved ? ` (moved ${MOVED[res.moved as string] ?? res.moved}, from ${rel(res.computed as string)})` : ""}` : res.passed ? `wait "${title(x.node)}": its time had already come` : `wait "${title(x.node)}"${res.deadline ? ` until at most ${rel(res.deadline as string)}` : ""}`
      : res.window ? `"${title(x.node)}": outside the send window, waits until ${rel(res.wakeAt as string)}`
        : res.stale ? `"${title(x.node)}": skipped, too late for it`
          : res.interrupt ? `"${title(x.node)}": ${res.interrupt}` : x.primitive === "branch@1" ? `branch "${title(x.node)}" → ${res.label ?? res.to}` : `${x.primitive.split("@")[0]} "${title(x.node)}"`;
    push(x.startedAt, 2e6 + x.id, words);
    if (x.finishedAt && x.primitive === "wait@1" && res.outcome) push(x.finishedAt, 2e6 + x.id + 0.5, `wait "${title(x.node)}" over: ${res.outcome}`);
  }
  const stepOf = new Map(s.outbox.map((o) => [o.id, o.stepId]));
  for (const [i, o] of outbox.entries()) {
    const settled = o.settledAt ? new Date(o.settledAt) : new Date(o.at);
    const rowId = s.outbox.filter((r) => runIds.has(r.runId)).sort((a, b) => a.id - b.id)[i]!.id;
    push(settled, 2e6 + (stepOf.get(rowId) ?? 0) + 0.6, `${o.kind} ${o.status}${o.contentKey ? ` [${o.contentKey}]` : ""} to ${o.to}${o.why ? `: ${o.why}` : ""}${o.text && o.status === "sent" ? ` — "${o.text}"` : ""}`);
  }
  for (const r of runs) if (r.finishedAt) push(r.finishedAt, 5e6, `run ${r.status}: ${r.endReason}`);
  for (const a of s.alerts) push(a.openedAt, 2e6 + (a.outboxId ? stepOf.get(a.outboxId) ?? 0 : 0) + 0.7, `alert ${a.kind}: ${a.message}`);
  timeline.sort((a, b) => a.t - b.t || a.o - b.o);

  const failures: string[] = [];
  const keysWith = (status: string) => outbox.filter((o) => o.status === status).map((o) => o.contentKey ?? o.kind);
  const same = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
  if (sc.expect?.sent && !same(keysWith("sent"), sc.expect.sent)) failures.push(`sent ${JSON.stringify(keysWith("sent"))}, expected ${JSON.stringify(sc.expect.sent)}`);
  if (sc.expect?.held && !same(keysWith("held"), sc.expect.held)) failures.push(`held ${JSON.stringify(keysWith("held"))}, expected ${JSON.stringify(sc.expect.held)}`);
  if (sc.expect?.suppressed && !same(keysWith("suppressed"), sc.expect.suppressed)) failures.push(`suppressed ${JSON.stringify(keysWith("suppressed"))}, expected ${JSON.stringify(sc.expect.suppressed)}`);
  const ends = simRuns.map((r) => r.endReason ?? r.status);
  if (sc.expect?.ends && !same(ends, sc.expect.ends)) failures.push(`runs ended ${JSON.stringify(ends)}, expected ${JSON.stringify(sc.expect.ends)}`);
  const rows = outbox.map((o) => `${o.rel.replace(/ /g, "")} ${o.status} ${o.contentKey ?? o.kind}`);
  const want = sc.expect?.outbox;
  if (want && !same(rows, want)) failures.push(`outbox ${JSON.stringify(rows)}, expected ${JSON.stringify(want)}`);

  return {
    scenario: sc.name, workflow: wfKey(workflowId), delivery: sc.delivery, crmWrites: sc.crmWrites, start: sc.start,
    runs: simRuns, steps: simSteps, outbox, waits, alerts: s.alerts.map((a) => ({ at: a.openedAt.toISOString(), kind: a.kind, message: a.message })),
    timeline: timeline.map(({ at, rel: r, what }) => ({ at, rel: r, what })),
    expectations: { ok: failures.length === 0, failures },
  };
}

/** The timeline as lines a person reads. */
export const timelineText = (r: SimResult): string =>
  [`${r.scenario} (${r.workflow}, delivery ${r.delivery}, CRM writes ${r.crmWrites}, from ${r.start})`, ...r.timeline.map((e) => `  ${e.rel.padEnd(12)} ${e.what}`)].join("\n");
