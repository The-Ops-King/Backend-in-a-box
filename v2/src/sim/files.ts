import fs from "node:fs";
import path from "node:path";
import type { ContentSeed } from "@/engine/testkit";
import { Scenario, type ScenarioInput } from "./scenario";

/** The words a scenario folder uses: its own content.json, else the nearest one above it (an offer's, two levels up). */
export function contentFileFor(dir: string): string {
  for (let d = dir, i = 0; i < 3; i++, d = path.dirname(d)) {
    const f = path.join(d, "content.json");
    if (fs.existsSync(f)) return f;
  }
  throw new Error(`no content.json in ${dir} or the two folders above it`);
}

/**
 * Scenario files on disk: one folder per workflow, holding one JSON file per scenario and `content.json` (the words by
 * key; keys starting with "_" are notes), or using the nearest content.json above it (an offer's own). Files starting
 * with "_" are notes about the folder, not scenarios.
 */
export function loadScenarioFolder(dir: string): { content: ContentSeed; reports?: Record<string, unknown>; scenarios: { file: string; scenario: ScenarioInput }[] } {
  const raw = JSON.parse(fs.readFileSync(contentFileFor(dir), "utf8")) as Record<string, unknown>;
  const content = Object.fromEntries(Object.entries(raw).filter(([k]) => !k.startsWith("_"))) as ContentSeed;
  const scenarios = fs.readdirSync(dir).filter((f) => f.endsWith(".json") && f !== "content.json" && !f.startsWith("_")).sort().map((f) => {
    const parsed = Scenario.safeParse(JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")));
    if (!parsed.success) throw new Error(`${f}: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
    return { file: f, scenario: JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as ScenarioInput };
  });
  // the report and metric definitions: the nearest reports.json, as for the words (an offer's own)
  let reports: Record<string, unknown> | undefined;
  for (let d = dir, i = 0; i < 3 && !reports; i++, d = path.dirname(d)) {
    const f = path.join(d, "reports.json");
    if (fs.existsSync(f)) reports = JSON.parse(fs.readFileSync(f, "utf8")) as Record<string, unknown>;
  }
  return { content, ...(reports ? { reports } : {}), scenarios };
}
