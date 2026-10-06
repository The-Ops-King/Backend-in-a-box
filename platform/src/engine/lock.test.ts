import { describe, it, expect, beforeAll } from "vitest";
import { asOperator } from "@/db/client";
import { migrate } from "@/db/migrate";
import { acquireTickLock, releaseTickLock, withTickLock } from "./lock";

describe.skipIf(!process.env.DATABASE_URL)("tick lock", () => {
  beforeAll(async () => { await migrate(); await asOperator((c) => c.query("delete from engine_state where key='tick_lock'")); });
  it("second acquirer is refused while the lease is held, admitted after release", async () => {
    const a = await acquireTickLock();
    expect(a).toBeTruthy();
    expect(await acquireTickLock()).toBeNull();
    await releaseTickLock("not-the-owner");
    expect(await acquireTickLock()).toBeNull();   // a stranger cannot release it
    await releaseTickLock(a!);
    const b = await acquireTickLock();
    expect(b).toBeTruthy();
    await releaseTickLock(b!);
  });
  it("an expired lease (tick killed mid-flight) is taken over", async () => {
    const a = await acquireTickLock(-1);
    expect(a).toBeTruthy();
    const b = await acquireTickLock();
    expect(b).toBeTruthy();
    await releaseTickLock(b!);
  });
  it("withTickLock reports busy instead of running twice, and releases even when the body throws", async () => {
    const held = await acquireTickLock();
    expect(await withTickLock(async () => "ran")).toEqual({ busy: true });
    await releaseTickLock(held!);
    await expect(withTickLock(async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(await withTickLock(async () => "ran")).toEqual({ busy: false, result: "ran" });
  });
});
