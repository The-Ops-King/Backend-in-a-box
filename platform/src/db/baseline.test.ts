/** D193: migration 0001 is frozen. A change to it would never reach a database that already recorded it, so it is a new numbered migration instead. */
import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("the baseline migration", () => {
  it("is frozen: add a numbered migration to src/db/migrations.ts instead of editing src/db/baseline.ts", () => {
    const text = readFileSync(join(__dirname, "baseline.ts"), "utf8");
    expect(createHash("sha256").update(text).digest("hex")).toBe("3c858aa8735a4f00a3a9981c3e0d5df8d4bb2bed533c12e2958bbbdbc1d3aa19");
  });
});
