import { describe, it, expect } from "vitest";
import { installTickSchedule } from "./schedule";
describe("installTickSchedule input guards", () => {
  it("rejects a URL with a path or a non-https scheme before touching the database", async () => {
    await expect(installTickSchedule("http://x.test", "s")).rejects.toThrow(/https origin/);
    await expect(installTickSchedule("https://x.test/api/tick", "s")).rejects.toThrow(/https origin/);
    await expect(installTickSchedule("https://x.test", "s", 0)).rejects.toThrow(/1–59/);
  });
});
