/** D304: no shipped template reads a remembered value on a path that never sets it, so no offer is installed with that failure. */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { unsetReads } from "./unset-vars";
import type { Definition } from "./definition";

const DIR = path.resolve(__dirname, "../templates");
describe("D304: shipped templates", () => {
  for (const f of fs.readdirSync(DIR).filter((x) => x.endsWith(".json"))) {
    const j = JSON.parse(fs.readFileSync(path.join(DIR, f), "utf8"));
    if (!j.definition?.nodes) continue;
    it(f, () => expect(unsetReads(j.definition as Definition)).toEqual([]));
  }
});
