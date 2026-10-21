import { recordFact } from "@/projections/apply";
import { deliver, dispatchDue, type DispatchDeps, reapStale } from "./dispatcher";
import { type Deps, type LookupResolver, type ReportRenderer, dispatchEvent, endRun, fireSchedule, nudge, resumeRun, startManual, wakeRun } from "./interpreter";
import type { Ports } from "./ports";
import type { VendorReads } from "./reads";
import { firePeriod, fireTimer } from "./schedule";
import type { Store, Tx } from "./store";
import type { EventRow, RunRow } from "./types";
import type { Subjects } from "./context";

/**
 * The engine's front door: facts in, answers in, a person's hand on a run, and `runDue`, which does everything due
 * now (wakes due runs, delivers due outbox rows) until nothing is left, deterministically. The job runner calls the
 * same `wake` and `deliver` one job at a time; tests and the simulator call `runDue`.
 */

export type EngineOptions = {
  store: Store;
  ports: Ports;
  /** The clock. The simulator's is fake. */
  now?: () => Date;
  /** A stand-in for a report definition's rendering (the simulator's, where a scenario gives one). */
  reports?: ReportRenderer;
  /** A stand-in for a facts.lookup answer (the simulator's, where a scenario gives one); else the projections answer. */
  lookup?: LookupResolver;
  /** What only a vendor can answer: transcripts, the CRM's blank Sales Calls, vendor reports. */
  reads?: VendorReads;
  /**
   * How schedule triggers fire: by their timers, when `runDue` (or the job runner) reaches their time; or only when a
   * caller says the clock reached one (`firePeriod`: the simulator, whose scenarios name each schedule step).
   */
  schedules?: "timers" | "by_hand";
  secret?: DispatchDeps["secret"];
  random?: () => number;
  worker?: string;
};

export type IncomingEvent = {
  offerId: string;
  type: string;
  occurredAt?: Date;
  source: string;
  /** The vendor's own id for this fact, or a hash of it: the same fact arriving twice is one row. */
  dedupeKey: string;
  contactId?: string | null;
  appointmentId?: string | null;
  dealId?: string | null;
  payload: Record<string, unknown>;
};

export type DueReport = { woken: number; delivered: number; reaped: number; rounds: number; fired: number };

export class Engine {
  readonly store: Store;
  readonly ports: Ports;
  readonly now: () => Date;
  private opts: EngineOptions;

  constructor(opts: EngineOptions) {
    this.opts = opts;
    this.store = opts.store;
    this.ports = opts.ports;
    this.now = opts.now ?? (() => new Date());
  }

  private deps(tx: Tx): Deps { return { tx, now: this.now(), ...(this.opts.reports ? { reports: this.opts.reports } : {}), ...(this.opts.lookup ? { lookup: this.opts.lookup } : {}), ...(this.opts.reads ? { reads: this.opts.reads } : {}) }; }
  private dispatchDeps(): DispatchDeps {
    return { store: this.store, ports: this.ports, now: this.now, ...(this.opts.secret ? { secret: this.opts.secret } : {}), ...(this.opts.random ? { random: this.opts.random } : {}), ...(this.opts.worker ? { worker: this.opts.worker } : {}) };
  }

  /** Records a fact. A new one starts the runs whose triggers match it and wakes the waiting runs about its subjects. */
  async ingest(e: IncomingEvent): Promise<{ event: EventRow; duplicate: boolean; started: string[] }> {
    return this.store.tx(async (tx) => {
      const d = this.deps(tx);
      const { event, inserted } = await recordFact(tx, {
        offerId: e.offerId, type: e.type, occurredAt: e.occurredAt ?? d.now, contactId: e.contactId ?? null, appointmentId: e.appointmentId ?? null,
        dealId: e.dealId ?? null, source: e.source, dedupeKey: e.dedupeKey, payload: e.payload, runId: null,
      });
      if (!inserted) return { event, duplicate: true, started: [] };
      await nudge(d, e.offerId, { contactId: event.contactId, appointmentId: event.appointmentId, dealId: event.dealId });
      const started = await dispatchEvent(d, event);
      return { event, duplicate: false, started };
    });
  }

  /**
   * Someone answered a Slack question (a button, a reaction, a form). The answer becomes a fact, `ask.answered`, with
   * the post's tag, so the run that asked and any run waiting on that tag see it. The first answer is the one that counts.
   */
  async answer(x: { offerId: string; channel: string; ts: string; value: unknown; person: string; at?: Date; dedupeKey?: string }): Promise<{ event: EventRow; duplicate: boolean }> {
    return this.store.tx(async (tx) => {
      const d = this.deps(tx);
      const [post] = await tx.posts({ offerId: x.offerId, channel: x.channel, ts: x.ts });
      if (!post) throw new Error("no such post");
      const row = (await tx.outboxRow(post.outboxId))!;
      if (row.kind !== "slack.ask") throw new Error("that post is not a question");
      const answers = row.payload.answers as { buttons?: { value: string }[]; reactions?: string[]; form?: string };
      const allowed = answers.buttons?.map((b) => b.value) ?? answers.reactions;
      if (allowed && !allowed.includes(String(x.value))) throw new Error(`"${String(x.value)}" is not one of this question's answers`);
      const run = (await tx.run(post.runId))!;
      const at = x.at ?? d.now;
      const { event, inserted } = await recordFact(tx, {
        offerId: x.offerId, type: "ask.answered", occurredAt: at, contactId: run.contactId, appointmentId: run.appointmentId, dealId: run.dealId, source: "slack",
        dedupeKey: x.dedupeKey ?? `answer:${post.id}:${x.person}:${String(x.value)}:${at.toISOString()}`,
        payload: { run_id: run.id, node: post.node, tag: post.tag, value: x.value as never, person: x.person, channel: post.channel, ts: post.ts }, runId: null,
      });
      if (!inserted) return { event, duplicate: true };
      const wake = async (r: RunRow) => { if (r.status === "waiting") { await tx.updateRun(r.id, { nextWakeAt: d.now }); await tx.schedule({ kind: "run", id: r.id, at: d.now }); } };
      await wake(run);
      if (post.tag) for (const r of await tx.runs({ offerId: x.offerId, statuses: ["waiting"], waitingOnTag: post.tag })) if (r.id !== run.id) await wake(r);
      return { event, duplicate: false };
    });
  }

  /** Wakes one run if it is due (a job's work). */
  wake(runId: string): Promise<boolean> { return this.store.tx((tx) => wakeRun(this.deps(tx), runId)); }

  /** Delivers one outbox row if it is due (a job's work). */
  deliver(outboxId: number): Promise<boolean> { return deliver(this.dispatchDeps(), outboxId); }

  /** Rows left mid-call by a dispatcher that stopped: unknown, never re-sent. */
  reap(): Promise<number> { return reapStale(this.dispatchDeps()); }

  /**
   * Everything due now, until nothing is: due runs woken (oldest first), due outbox rows delivered, again, until a
   * round does nothing. Deterministic for a fixed clock.
   */
  async runDue(maxRounds = 1000): Promise<DueReport> {
    const report: DueReport = { woken: 0, delivered: 0, reaped: await this.reap(), rounds: 0, fired: 0 };
    for (; report.rounds < maxRounds; report.rounds++) {
      let did = 0;
      if (this.opts.schedules !== "by_hand") {
        const timers = await this.store.tx((tx) => tx.scheduleTimers({ dueBy: this.now() }));
        for (const t of timers) { const r = await this.fireTimer(t.workflowId, t.node); if (r.fired) report.fired++; did++; }
      }
      const due = await this.store.tx((tx) => tx.runs({ statuses: ["waiting"], dueBy: this.now(), limit: 500 }));
      for (const r of due) if (await this.wake(r.id)) { did++; report.woken++; }
      const sent = await dispatchDue(this.dispatchDeps());
      did += sent;
      report.delivered += sent;
      if (!did) return report;
    }
    throw new Error(`runDue did not settle after ${maxRounds} rounds`);
  }

  resume(runId: string, how: "resume" | "retry" | "skip" = "resume"): Promise<RunRow> { return this.store.tx((tx) => resumeRun(this.deps(tx), runId, how)); }
  end(runId: string, reason?: string): Promise<void> { return this.store.tx((tx) => endRun(this.deps(tx), runId, reason)); }
  startManual(x: { workflowId: string; subjects: Subjects; by: string; data?: Record<string, unknown> }): Promise<string | null> { return this.store.tx((tx) => startManual(this.deps(tx), x)); }
  fireSchedule(x: { workflowId: string; triggerNode: string; at: Date; person?: Record<string, unknown> & { id: string }; period?: string }): Promise<string | null> { return this.store.tx((tx) => fireSchedule(this.deps(tx), x)); }
  /** The clock reached a schedule trigger: its runs for that moment (one for the offer, or one per person with its role). */
  firePeriod(x: { workflowId: string; node: string; at: Date; period?: string }): Promise<string[]> { return this.store.tx((tx) => firePeriod(this.deps(tx), x)); }
  /** A schedule timer's job: fires its period once if it is due, and sets its next time. */
  fireTimer(workflowId: string, node: string): Promise<{ fired: boolean; started: string[] }> { return this.store.tx((tx) => fireTimer(this.deps(tx), workflowId, node)); }
}
