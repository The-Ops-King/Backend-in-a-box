/**
 * pnpm exec tsx scripts/build-copies.ts <company> [--check] — D118: builds a dating company's own workflow copies from the
 * shipped templates and its words file (installs/<company>/words.json) into installs/<company>/<workflow>.json, and its call
 * prompts (from its salesCall.objections) into installs/<company>.json. Each copy is saved with
 * POST /api/admin/workflows/definition { company, workflow, definition, note } (dryRun: true first). --check writes nothing
 * and exits 1 when a file is not what the build makes. Nothing touches a database or the CRM.
 */
import fs from "node:fs";
import path from "node:path";
import { datingCopies, datingPrompts, type DatingWords } from "../installs/dating/copies";

const args = process.argv.slice(2);
const company = args.find((a) => !a.startsWith("--"));
const check = args.includes("--check");
if (!company) { console.error("usage: build-copies.ts <company> [--check]"); process.exit(2); }
const ROOT = path.resolve(__dirname, "..");
const dir = path.join(ROOT, "installs", company);
const installFile = path.join(ROOT, "installs", `${company}.json`);
const words = JSON.parse(fs.readFileSync(path.join(dir, "words.json"), "utf8")) as DatingWords;
const install = JSON.parse(fs.readFileSync(installFile, "utf8")) as { salesCall?: { objections?: string[] }; prompts?: Record<string, string> };
if (!install.salesCall?.objections?.length) throw new Error(`${installFile}: salesCall.objections is needed for the call prompts`);

const files: [string, string][] = datingCopies(company, words).map((c) => [path.join(dir, `${c.workflow}.json`), JSON.stringify(c, null, 1) + "\n"]);
files.push([installFile, JSON.stringify({ ...install, prompts: { ...(install.prompts ?? {}), ...datingPrompts(install.salesCall.objections) } }, null, 2) + "\n"]);

let stale = 0;
for (const [file, text] of files) {
  const same = fs.existsSync(file) && fs.readFileSync(file, "utf8") === text;
  if (check) { if (!same) { stale++; console.log(`stale: ${path.relative(ROOT, file)}`); } continue; }
  if (!same) fs.writeFileSync(file, text);
  console.log(`${same ? "current" : "written"}: ${path.relative(ROOT, file)}`);
}
if (check) { console.log(stale ? `${stale} file(s) are not what the build makes` : "all current"); process.exit(stale ? 1 : 0); }
