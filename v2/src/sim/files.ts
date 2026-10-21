import fs from "node:fs";
import path from "node:path";
import type { ContentSeed } from "@/engine/testkit";
import { Scenario, type ScenarioInput } from "./scenario";

/**
 * Scenario files on disk: one folder per workflow, holding `content.json` (the words by key; keys starting with "_"
 * are notes) and one JSON file per scenario.
 */
export function loadScenarioFolder(dir: string): { content: ContentSeed; scenarios: { file: string; scenario: ScenarioInput }[] } {
  const raw = JSON.parse(fs.readFileSync(path.join(dir, "content.json"), "utf8")) as Record<string, unknown>;
  const content = Object.fromEntries(Object.entries(raw).filter(([k]) => !k.startsWith("_"))) as ContentSeed;
  const scenarios = fs.readdirSync(dir).filter((f) => f.endsWith(".json") && f !== "content.json").sort().map((f) => {
    const parsed = Scenario.safeParse(JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")));
    if (!parsed.success) throw new Error(`${f}: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
    return { file: f, scenario: JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as ScenarioInput };
  });
  return { content, scenarios };
}
