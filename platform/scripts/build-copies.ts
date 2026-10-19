/**
 * pnpm exec tsx scripts/build-copies.ts <company> [--check] — D148: builds a company's own workflow copies from the shipped
 * templates and its playbook (installs/<company>/playbook.json: which playbook, its params) into installs/<company>/<workflow>.json,
 * and anything the playbook writes into installs/<company>.json (D118: a dating company's call prompts). Each copy is saved with
 * POST /api/admin/workflows/definition { company, workflow, definition, note } (dryRun: true first); D123: a file with `name` and
 * `create` is the company's own workflow, made with the same call and its `create`. --check writes nothing and exits 1 when a file
 * is not what the build makes (a template changed since the copies were built: build, then save them). Nothing touches a
 * database or the CRM.
 */
import fs from "node:fs";
import path from "node:path";
import { companyBuild, INSTALLS } from "../src/playbooks/files";

const args = process.argv.slice(2);
const company = args.find((a) => !a.startsWith("--"));
const check = args.includes("--check");
if (!company) { console.error("usage: build-copies.ts <company> [--check]"); process.exit(2); }
if (!fs.existsSync(path.join(INSTALLS, company, "playbook.json"))) { console.error(`installs/${company}/playbook.json: no playbook for ${company}`); process.exit(2); }

const { playbook, files } = companyBuild(company);
console.log(`${company}: the ${playbook} playbook`);
let stale = 0;
for (const { file, text } of files) {
  const same = fs.existsSync(file) && fs.readFileSync(file, "utf8") === text;
  const rel = path.relative(path.dirname(INSTALLS), file);
  if (check) { if (!same) { stale++; console.log(`stale: ${rel}`); } continue; }
  if (!same) fs.writeFileSync(file, text);
  console.log(`${same ? "current" : "written"}: ${rel}`);
}
if (check) { console.log(stale ? `${stale} file(s) are not what the build makes` : "all current"); process.exit(stale ? 1 : 0); }
