/**
 * pnpm exec tsx scripts/inventory.ts [--check]
 * D144: writes engine/inventory/{templates,triggers,steps}.md from the code (src/engine/inventory.ts). --check writes nothing and
 * exits 1 when a file is out of date.
 */
import fs from "node:fs";
import path from "node:path";
import { INVENTORY_FILES } from "../src/engine/inventory";

const root = path.resolve(__dirname, ".."), out = path.resolve(root, "../engine/inventory"), check = process.argv.includes("--check");
fs.mkdirSync(out, { recursive: true });
let stale = 0;
for (const [f, body] of Object.entries(INVENTORY_FILES(root))) {
  const p = path.join(out, f), was = fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "";
  if (was === body) { console.log(`current: engine/inventory/${f}`); continue; }
  if (check) { console.log(`stale: engine/inventory/${f}`); stale++; continue; }
  fs.writeFileSync(p, body); console.log(`written: engine/inventory/${f}`);
}
if (stale) process.exit(1);
