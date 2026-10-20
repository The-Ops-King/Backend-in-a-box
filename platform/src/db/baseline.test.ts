/** D200: migration 0001 is frozen. A change to it would never reach a database that already recorded it, so it is a new numbered migration instead. */
import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("the baseline migration", () => {
  it("is frozen: add a numbered migration to src/db/migrations.ts instead of editing src/db/baseline.ts", () => {
    const text = readFileSync(join(__dirname, "baseline.ts"), "utf8");
    expect(createHash("sha256").update(text).digest("hex")).toBe("03a2c5f703bba956e1e5b2d21575fdb65e4111cc850578ebfa9861e0675ecd1c");
  });
});
