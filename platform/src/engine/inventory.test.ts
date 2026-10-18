/** D144: the three inventories in engine/inventory/ are what the code says today (regenerate: pnpm exec tsx scripts/inventory.ts). */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { INVENTORY_FILES } from "./inventory";

const root = path.resolve(__dirname, "../.."), dir = path.resolve(root, "../engine/inventory");
describe("inventories (D144)", () => {
  for (const [f, body] of Object.entries(INVENTORY_FILES(root))) it(`engine/inventory/${f} is current`, () => expect(fs.readFileSync(path.join(dir, f), "utf8")).toBe(body));
});
