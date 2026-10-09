import { describe, it, expect } from "vitest";
import { issueSession, verifySession, passwordMatches, openPath, readCookie } from "./session";

describe("operator session", () => {
  it("round-trips a signed token and rejects a forged or expired one", async () => {
    const t = await issueSession("s3cret", 1_000_000);
    expect(await verifySession(t, "s3cret", 1_000_001)).toBe(true);
    expect(await verifySession(t, "other", 1_000_001)).toBe(false);
    expect(await verifySession(t.replace(/.$/, "x"), "s3cret", 1_000_001)).toBe(false);
    expect(await verifySession(t, "s3cret", 1_000_000 + 31 * 86_400_000)).toBe(false);
    expect(await verifySession(undefined, "s3cret")).toBe(false);
    expect(await verifySession(t, "")).toBe(false);
  });
  it("compares passwords without leaking by length, reads a cookie, knows the open doors", () => {
    expect(passwordMatches("abc", "abc")).toBe(true); expect(passwordMatches("abd", "abc")).toBe(false); expect(passwordMatches("ab", "abc")).toBe(false); expect(passwordMatches("", "")).toBe(false);
    expect(readCookie("a=1; bib_session=x.y; z=3", "bib_session")).toBe("x.y");
    for (const p of ["/", "/app", "/app/c/hair", "/eod/er_x", "/api/eod/er_x", "/api/tick", "/api/admin/install", "/api/webhooks/whop/1", "/api/v1/session"]) expect(openPath(p)).toBe(true);
    for (const p of ["/api/v1/companies", "/c/hair", "/c/hair/settings"]) expect(openPath(p)).toBe(false);
  });
});
