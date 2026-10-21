import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadScenarioFolder } from "@/sim/files";
import { type SimResult, simulate } from "@/sim/simulate";
import { parseTemplate, settingsIn, settingsOf } from "@/workflow/template";
import { validateWorkflow } from "@/workflow/validate";
import type { Edge, Workflow } from "@/workflow/definition";
import { reportDef } from "@/reports/render";
import { factSettingsIn } from "@/projections/facts";
import { metricDef } from "@/reports/metrics";

/**
 * Every offer's own workflows (offers/<offer>/): each validates, everything it needs from the offer exists (content,
 * report definitions, settings listed for setup), every word parses, and every scenario replays in the simulator with
 * exactly the timeline it states. Together an offer's scenarios take every edge of every workflow at least once.
 */

const ROOT = path.resolve(__dirname, "../../offers");
const offers = fs.existsSync(ROOT) ? fs.readdirSync(ROOT).filter((d) => fs.statSync(path.join(ROOT, d)).isDirectory()).sort() : [];
const readJson = (f: string) => JSON.parse(fs.readFileSync(f, "utf8")) as unknown;

type Content = Record<string, { channel: string; body: string; subject?: string; as?: string; icons?: string[]; labels?: Record<string, string> }>;
type SettingsList = { settings: { key: string; requiredToEnable: boolean; optionalIn?: string[] }[] };

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
  const settingsList = (readJson(path.join(dir, "settings.required.json")) as SettingsList).settings;
  const settings = new Set(settingsList.map((s) => s.key));
  const files = fs.readdirSync(path.join(dir, "workflows")).filter((f) => f.endsWith(".json")).sort();
  const defs = new Map(files.map((f) => [f.replace(/\.json$/, ""), readJson(path.join(dir, "workflows", f))]));

  it("has workflows", () => expect(files.length).toBeGreaterThan(0));

  it("every report and metric definition validates, and every metric and word a report reads exists", () => {
    const metrics = (reports.metrics ?? {}) as Record<string, unknown>;
    const problems: string[] = [];
    const named = new Set<string>();
    for (const name of Object.keys(metrics).filter((k) => !k.startsWith("_"))) {
      try { const m = metricDef(metrics, name); if ("rate" in m) [m.rate.num, m.rate.den].forEach((x) => named.add(x)); } catch (e) { problems.push(String((e as Error).message)); }
    }
    for (const [key, raw] of Object.entries(reports)) {
      if (key.startsWith("_") || key === "metrics") continue;
      try {
        const d = reportDef(raw, key) as Record<string, unknown>;
        const uses = d.kind === "wrap_up" ? [...(d.metrics as string[]), ...Object.values((d.calls ?? {}) as Record<string, string>), ...Object.values((d.by ?? {}) as Record<string, Record<string, string>>).flatMap((x) => Object.values(x))]
          : d.kind === "leaderboard" ? [...Object.values(d.closers as Record<string, string>), ...Object.values(d.setters as Record<string, string>)] : [];
        for (const m of uses) { named.add(m); if (!metrics[m]) problems.push(`${key} reads the metric ${m}, which reports.json does not define`); }
        const layout = d.layout as { heading: Record<string, string>; empty: Record<string, string>; footer?: string; failed?: string; sections: { title: string; lines?: string[]; table?: [string, string][] }[] } | undefined;
        const words = layout ? [...Object.values(layout.heading), ...Object.values(layout.empty), layout.footer ?? "", layout.failed ?? "", ...layout.sections.flatMap((x) => [x.title, ...(x.lines ?? []), ...(x.table ?? []).flat()])] : [];
        for (const t of words) for (const e of parseTemplate(t, { extraRoots: ["report"] }).errors) problems.push(`${key}: ${e}`);
      } catch (e) { problems.push(String((e as Error).message)); }
    }
    for (const m of named) if (!metrics[m]) problems.push(`a rate reads ${m}, which is not defined`);
    expect(problems).toEqual([]);
  });

  it.each([...defs.keys()])("%s validates, and the offer has everything it needs", (slug) => {
    const v = validateWorkflow(defs.get(slug));
    expect(v.problems).toEqual([]);
    if (!v.ok) return;
    expect(v.workflow.id).toBe(slug);
    expect(v.requires.content.filter((k) => !content[k])).toEqual([]);
    expect(v.requires.reports.filter((k) => !reports[k])).toEqual([]);
    expect(v.requires.settings.filter((k) => !settings.has(k))).toEqual([]);
    expect(v.requires.optionalSettings.filter((k) => !settings.has(k))).toEqual([]);
    expect(v.requires.workflows.filter((w) => !defs.has(w))).toEqual([]);
  });

  it("every word parses, and every entry is used", () => {
    const used = new Set<string>();
    for (const d of defs.values()) { const v = validateWorkflow(d); for (const k of v.requires.content) used.add(k); }
    const problems: string[] = [];
    for (const [key, c] of Object.entries(content)) {
      if (key.startsWith("_")) continue;
      for (const t of [c.body, c.subject ?? "", c.as ?? "", ...(c.icons ?? []), ...Object.values(c.labels ?? {})]) {
        for (const e of parseTemplate(t).errors) problems.push(`${key}: ${e}`);
        for (const k of [...settingsIn(t), ...factSettingsIn(t).required, ...factSettingsIn(t).optional]) if (!settings.has(k)) problems.push(`${key}: reads the setting ${k}, which settings.required.json does not list`);
      }
      if (!used.has(key)) problems.push(`${key}: no workflow uses it`);
    }
    expect(problems).toEqual([]);
  });

  it("says which settings a workflow cannot be enabled without, and which it reads only as optional", () => {
    const required = new Set<string>(), optionalIn = new Map<string, Set<string>>();
    for (const [slug, d] of defs) {
      const v = validateWorkflow(d);
      const opt = new Set(v.requires.optionalSettings), req = new Set(v.requires.settings);
      for (const k of v.requires.content) {
        const c = content[k];
        if (c) for (const t of [c.body, c.subject ?? "", c.as ?? "", ...(c.icons ?? []), ...Object.values(c.labels ?? {})]) {
          const r = settingsOf(t), f = factSettingsIn(t);
          [...r.required, ...f.required].forEach((x) => req.add(x)); [...r.optional, ...f.optional].forEach((x) => opt.add(x));
        }
      }
      req.forEach((k) => required.add(k));
      for (const k of opt) if (!req.has(k)) optionalIn.set(k, (optionalIn.get(k) ?? new Set()).add(slug));
    }
    const wrong = settingsList.filter((s) => s.requiredToEnable !== required.has(s.key) || JSON.stringify(s.optionalIn ?? []) !== JSON.stringify([...(optionalIn.get(s.key) ?? [])].sort()));
    expect(wrong.map((s) => s.key)).toEqual([]);
  });

  describe.each([...defs.keys()])("%s scenarios", (slug) => {
    const sdir = path.join(dir, "scenarios", slug);
    const { scenarios } = fs.existsSync(sdir) ? loadScenarioFolder(sdir) : { scenarios: [] };
    const taken = new Set<number>();
    it("has scenarios", () => expect(scenarios.length).toBeGreaterThan(0));
    it.each(scenarios.map((s) => [s.file, s.scenario] as const))("%s", async (_f, scenario) => {
      expect(scenario.workflow).toBe(slug);
      // the offers' own scenarios stand in only for what a vendor answers: never for a projection's lookup or report
      expect(Object.keys((scenario.fixtures as { lookups?: object } | undefined)?.lookups ?? {}), "a lookup is answered by the projections, not a fixture").toEqual([]);
      for (const k of Object.keys((scenario.fixtures as { reports?: object } | undefined)?.reports ?? {})) expect(["availability", "health_check"], `${k} is rendered from the projections, not a fixture`).toContain((reports[k] as { kind?: string } | undefined)?.kind);
      const r = await simulate({ definition: defs.get(slug), scenario, content: content as never, reports });
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
