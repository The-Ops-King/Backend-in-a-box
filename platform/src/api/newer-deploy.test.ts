/** D113: an open dashboard tab learns a newer deploy is live from the API's x-build answer, and the middleware sends it. */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { isNewer } from "../../dashboard/src/build";

describe("a tab running code older than the live deploy (D113)", () => {
  beforeEach(() => { vi.resetModules(); vi.unstubAllGlobals(); });

  it("newer only when both sides name a deploy and they differ", () => {
    expect(isNewer("aaa111", "bbb222")).toBe(true);
    expect(isNewer("aaa111", "aaa111")).toBe(false);
    expect(isNewer("aaa111", null)).toBe(false);
    expect(isNewer("aaa111", "dev")).toBe(false);
    expect(isNewer("dev", "bbb222")).toBe(false);
  });

  it("the tab's flag turns on at the first newer answer and stays on; the bundle's own build is what the page was built with", async () => {
    vi.stubGlobal("__BUILD__", "aaa111");
    const b = await import("../../dashboard/src/build");
    expect(b.BUILD).toBe("aaa111");
    b.noteServerBuild(null); b.noteServerBuild("aaa111");
    expect(b.newerDeployLive()).toBe(false);
    b.noteServerBuild("bbb222");
    expect(b.newerDeployLive()).toBe(true);
    b.noteServerBuild("aaa111");
    expect(b.newerDeployLive()).toBe(true);
  });

  it("every answer through the middleware carries the deploy it came from", async () => {
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "ccc333");
    const { middleware } = await import("../../middleware");
    const { NextRequest } = await import("next/server");
    const r = await middleware(new NextRequest("http://x/api/health"));
    expect(r.headers.get("x-build")).toBe("ccc333");
    vi.unstubAllEnvs();
  });
});
