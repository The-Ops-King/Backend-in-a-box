import type { ContentSeed } from "@/engine/testkit";
import type { ScenarioInput } from "./scenario";
import { type SimResult, simulate } from "./simulate";

/**
 * The behavior diff between two versions of a workflow: both run through the same scenarios, and what each does is
 * compared as normalized actions (who it reaches, what kind of effect, which content, when relative to the scenario's
 * start, what the gate did), not as raw rows, so ids and row order never show up as a difference.
 */

/** One thing the workflow did. `at` orders the diff and is not compared (`rel` is). */
export type Action = { who: string; what: string; content: string | null; rel: string; status: string; why: string | null; at: string };
export type Change =
  | { kind: "added"; action: Action }
  | { kind: "removed"; action: Action }
  | { kind: "moved"; action: Action; from: string; to: string }
  | { kind: "status"; action: Action; from: string; to: string }
  | { kind: "end"; from: string[]; to: string[] };

export type ScenarioDiff = { scenario: string; same: boolean; changes: Change[]; lines: string[] };
export type BehaviorDiff = { same: boolean; scenarios: ScenarioDiff[]; text: string };

export const actionsOf = (r: SimResult): Action[] => r.outbox.map((o) => ({ who: o.to, what: o.kind, content: o.contentKey, rel: o.rel, status: o.status, why: o.why, at: o.at }));
const keyOf = (a: Action) => `${a.who}|${a.what}|${a.content ?? ""}`;
const name = (a: Action) => `${a.content ?? a.what} to ${a.who}`;

/** Compares two runs of one scenario: actions paired by who, what and content, in order. */
export function compare(scenario: string, before: SimResult, after: SimResult): ScenarioDiff {
  const changes: Change[] = [];
  const a = actionsOf(before), b = actionsOf(after);
  const groups = new Map<string, { a: Action[]; b: Action[] }>();
  for (const x of a) { const g = groups.get(keyOf(x)) ?? { a: [], b: [] }; g.a.push(x); groups.set(keyOf(x), g); }
  for (const x of b) { const g = groups.get(keyOf(x)) ?? { a: [], b: [] }; g.b.push(x); groups.set(keyOf(x), g); }
  for (const g of groups.values()) {
    const n = Math.max(g.a.length, g.b.length);
    for (let i = 0; i < n; i++) {
      const x = g.a[i], y = g.b[i];
      if (x && !y) changes.push({ kind: "removed", action: x });
      else if (!x && y) changes.push({ kind: "added", action: y });
      else if (x && y) {
        if (x.rel !== y.rel) changes.push({ kind: "moved", action: y, from: x.rel, to: y.rel });
        if (x.status !== y.status) changes.push({ kind: "status", action: y, from: x.status, to: y.status });
      }
    }
  }
  const endsA = before.runs.map((r) => r.endReason ?? r.status), endsB = after.runs.map((r) => r.endReason ?? r.status);
  if (JSON.stringify(endsA) !== JSON.stringify(endsB)) changes.push({ kind: "end", from: endsA, to: endsB });
  const order = (c: Change) => ("action" in c ? new Date(c.action.at).getTime() : Number.MAX_SAFE_INTEGER);
  changes.sort((p, q) => order(p) - order(q));
  const lines = changes.map((c) => {
    switch (c.kind) {
      case "added": return `+ ${name(c.action)} at ${c.action.rel}, ${c.action.status}${c.action.why ? ` (${c.action.why})` : ""}`;
      case "removed": return `- ${name(c.action)} at ${c.action.rel} no longer happens`;
      case "moved": return `~ ${name(c.action)} moves from ${c.from} to ${c.to}`;
      case "status": return `~ ${name(c.action)} at ${c.action.rel}: ${c.from} → ${c.to}${c.action.why ? ` (${c.action.why})` : ""}`;
      case "end": return `~ the run ends ${c.from.join(", ") || "(no run)"} → ${c.to.join(", ") || "(no run)"}`;
    }
  });
  return { scenario, same: changes.length === 0, changes, lines };
}

/** Runs every scenario on the old and the new version and says, scenario by scenario, what changes. */
export async function diffBehavior(before: unknown, after: unknown, scenarios: ScenarioInput[], content: ContentSeed, others?: unknown[]): Promise<BehaviorDiff> {
  const out: ScenarioDiff[] = [];
  for (const sc of scenarios) {
    const [x, y] = [await simulate({ definition: before, scenario: sc, content, ...(others ? { others } : {}) }), await simulate({ definition: after, scenario: sc, content, ...(others ? { others } : {}) })];
    out.push(compare(sc.name, x, y));
  }
  const same = out.every((d) => d.same);
  const text = same ? "No behavior changes in any scenario." : out.filter((d) => !d.same).map((d) => [`${d.scenario}:`, ...d.lines.map((l) => `  ${l}`)].join("\n")).join("\n");
  return { same, scenarios: out, text };
}
