import fs from "node:fs";
import path from "node:path";
import { loadScenarioFolder } from "./files";
import { simulate, timelineText } from "./simulate";

/**
 * pnpm sim <workflow.json> <scenario folder> [scenario file]: runs the scenarios and prints each timeline, with any
 * expectation that failed. Nothing leaves the process: the ports are fakes and the store is memory.
 */
const [defPath, dir, only] = process.argv.slice(2);
if (!defPath || !dir) {
  console.error("usage: pnpm sim <workflow.json> <scenario folder> [scenario file]");
  process.exit(2);
}
const definition = JSON.parse(fs.readFileSync(path.resolve(defPath), "utf8"));
const { content, reports, scenarios } = loadScenarioFolder(path.resolve(dir));
let failed = 0;
for (const { file, scenario } of scenarios.filter((s) => !only || s.file === only)) {
  const r = await simulate({ definition, scenario, content, ...(reports ? { reports } : {}) });
  console.log(`${timelineText(r)}\n`);
  if (!r.expectations.ok) { failed++; console.log(`  ✗ ${file}: ${r.expectations.failures.join("; ")}\n`); }
}
process.exit(failed ? 1 : 0);
