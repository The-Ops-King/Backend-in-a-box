import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadScenarioFolder } from "@/sim/files";
import { type SimResult, simulate } from "@/sim/simulate";
import { parseTemplate, settingsIn } from "@/workflow/template";
import { validateWorkflow } from "@/workflow/validate";
import type { Edge, Workflow } from "@/workflow/definition";

/**
 * Every offer's own workflows (offers/<offer>/): each validates, everything it needs from the offer exists (content,
 * report definitions, settings listed for setup), every word parses, and every scenario replays in the simulator with
 * exactly the timeline it states. Together an offer's scenarios take every edge of every workflow at least once.
 */

const ROOT = path.resolve(__dirname, "../../offers");
const offers = fs.existsSync(ROOT) ? fs.readdirSync(ROOT).filter((d) => fs.statSync(path.join(ROOT, d)).isDirectory()).sort() : [];
const readJson = (f: string) => JSON.parse(fs.readFileSync(f, "utf8")) as unknown;

type Content = Record<string, { channel: string; body: string; subject?: string; labels?: Record<string, string> }>;
type SettingsList = { settings: { key: string }[] };

/** Which edge each step of a run left by: a branch's chosen edge, else the edge for its outcome. */
export function edgesTaken(def: Workflow, r: SimResult): Set<number> {
  const outs = new Map<string, number[]>();
  def.edges.forEach((e, i) => outs.set(e.from, [...(outs.get(e.from) ?? []), i]));
  const taken = new Set<number>();
  for (const s of r.steps) {
    const mine = outs.get(s.node) ?? [];
    const res = s.result as { edge?: number; outcome?: string; interrupt?: string; gaveUp?: string };
    if (s.primitive === "branch@1") { if (typeof res.edge === "number" && mine[res.edge] !== undefined) taken.add(mine[res.edge]!); continue; }
    const on = res.outcome ?? res.interrupt ?? (res.gaveUp ? "next" : undefined);
    if (!on) continue;
    const i = mine.find((j) => (def.edges[j]!.on ?? "next") === on);
    if (i !== undefined) taken.add(i);
  }
  return taken;
}

const edgeName = (e: Edge) => `${e.from} → ${e.to}${e.on ? ` (${e.on})` : ""}${e.else ? " (else)" : e.when ? ` (when ${JSON.stringify(e.when)})` : ""}`;

describe.each(offers)("offer %s", (offer) => {
  const dir = path.join(ROOT, offer);
  const content = readJson(path.join(dir, "content.json")) as Content;
  const reports = fs.existsSync(path.join(dir, "reports.json")) ? (readJson(path.join(dir, "reports.json")) as Record<string, unknown>) : {};
  const settings = new Set((readJson(path.join(dir, "settings.required.json")) as SettingsList).settings.map((s) => s.key));
  const files = fs.readdirSync(path.join(dir, "workflows")).filter((f) => f.endsWith(".json")).sort();
  const defs = new Map(files.map((f) => [f.replace(/\.json$/, ""), readJson(path.join(dir, "workflows", f))]));

  it("has workflows", () => expect(files.length).toBeGreaterThan(0));

  it.each([...defs.keys()])("%s validates, and the offer has everything it needs", (slug) => {
    const v = validateWorkflow(defs.get(slug));
    expect(v.problems).toEqual([]);
    if (!v.ok) return;
    expect(v.workflow.id).toBe(slug);
    expect(v.requires.content.filter((k) => !content[k])).toEqual([]);
    expect(v.requires.reports.filter((k) => !reports[k])).toEqual([]);
    expect(v.requires.settings.filter((k) => !settings.has(k))).toEqual([]);
    expect(v.requires.workflows.filter((w) => !defs.has(w))).toEqual([]);
  });

  it("every word parses, and every entry is used", () => {
    const used = new Set<string>();
    for (const d of defs.values()) { const v = validateWorkflow(d); for (const k of v.requires.content) used.add(k); }
    const problems: string[] = [];
    for (const [key, c] of Object.entries(content)) {
      if (key.startsWith("_")) continue;
      for (const t of [c.body, c.subject ?? "", ...Object.values(c.labels ?? {})]) {
        for (const e of parseTemplate(t).errors) problems.push(`${key}: ${e}`);
        for (const k of settingsIn(t)) if (!settings.has(k)) problems.push(`${key}: reads the setting ${k}, which settings.required.json does not list`);
      }
      if (!used.has(key)) problems.push(`${key}: no workflow uses it`);
    }
    expect(problems).toEqual([]);
  });

  describe.each([...defs.keys()])("%s scenarios", (slug) => {
    const sdir = path.join(dir, "scenarios", slug);
    const { scenarios } = fs.existsSync(sdir) ? loadScenarioFolder(sdir) : { scenarios: [] };
    const taken = new Set<number>();
    it("has scenarios", () => expect(scenarios.length).toBeGreaterThan(0));
    it.each(scenarios.map((s) => [s.file, s.scenario] as const))("%s", async (_f, scenario) => {
      expect(scenario.workflow).toBe(slug);
      const r = await simulate({ definition: defs.get(slug), scenario, content: content as never });
      if (process.env.SIM_PRINT) console.log((await import("@/sim/simulate")).timelineText(r));
      expect(r.expectations.failures).toEqual([]);
      expect(scenario.expect?.outbox, "a scenario states its whole timeline (expect.outbox)").toBeDefined();
      expect(scenario.expect?.ends, "a scenario states how each run ends (expect.ends)").toBeDefined();
      const v = validateWorkflow(defs.get(slug));
      if (v.ok) for (const i of edgesTaken(v.workflow, r)) taken.add(i);
    });
    // an edge no run can take (its condition is the same as the one before it) is listed in _untakeable.json, with why
    const untakeable = fs.existsSync(path.join(sdir, "_untakeable.json")) ? (readJson(path.join(sdir, "_untakeable.json")) as { edges: { edge: string; why: string }[] }).edges : [];
    it("together take every edge", () => {
      const v = validateWorkflow(defs.get(slug));
      if (!v.ok || !scenarios.length) return;
      const names = v.workflow.edges.map(edgeName);
      expect(untakeable.filter((u) => !names.includes(u.edge) || !u.why)).toEqual([]);
      const missing = names.filter((n, i) => !taken.has(i) && !untakeable.some((u) => u.edge === n));
      expect(missing).toEqual([]);
      expect(untakeable.filter((u) => taken.has(names.indexOf(u.edge))).map((u) => u.edge)).toEqual([]);
    });
  });
});
