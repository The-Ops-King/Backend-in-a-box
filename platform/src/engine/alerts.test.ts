import { describe, it, expect, beforeAll } from "vitest";
import { asOperator } from "@/db/client";
import { migrate } from "@/db/migrate";
import { announce, type Problem } from "./alerts";

describe.skipIf(!process.env.DATABASE_URL)("operator alerts", () => {
  beforeAll(async () => { await migrate(); await asOperator((c) => c.query("delete from engine_state where key in ('alerts','problems')")); });
  it("says a problem once, repeats it after an hour, and stays quiet in between", async () => {
    const p: Problem[] = [{ key: "poll:x:contacts", level: "error", text: "boom" }];
    const t0 = new Date("2026-10-07T10:00:00Z");
    expect(await asOperator((c) => announce(c, p, t0))).toHaveLength(1);
    expect(await asOperator((c) => announce(c, p, new Date(t0.getTime() + 5 * 60e3)))).toHaveLength(0);
    expect(await asOperator((c) => announce(c, p, new Date(t0.getTime() + 61 * 60e3)))).toHaveLength(1);
    // a new problem alongside an old one: only the new one is announced
    const both = [...p, { key: "failed:x:wf", level: "error" as const, text: "run failed" }];
    const said = await asOperator((c) => announce(c, both, new Date(t0.getTime() + 62 * 60e3)));
    expect(said.map((s) => s.key)).toEqual(["failed:x:wf"]);
    // when a problem clears it is forgotten, so its return later is announced at once
    await asOperator((c) => announce(c, [], new Date(t0.getTime() + 70 * 60e3)));
    expect(await asOperator((c) => announce(c, p, new Date(t0.getTime() + 71 * 60e3)))).toHaveLength(1);
  });
});
