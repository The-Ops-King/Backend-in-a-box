/** D98: the operator key can change without a pause: the previous key is accepted only while CRON_SECRET_PREVIOUS is set. */
import { describe, it, expect } from "vitest";
import { bearerMatches, operatorAuthorized, tickAuthorized } from "./admin-auth";

const req = (auth?: string) => new Request("https://x.test/api/tick", { headers: auth ? { authorization: auth } : {} });

describe("operator key", () => {
  it("only the current key, when no previous one is set", () => {
    const env = { CRON_SECRET: "new-key" };
    expect(operatorAuthorized(req("Bearer new-key"), env)).toBe(true);
    expect(operatorAuthorized(req("Bearer old-key"), env)).toBe(false);
    expect(operatorAuthorized(req("Bearer new-keyx"), env)).toBe(false);
    expect(operatorAuthorized(req("new-key"), env)).toBe(false);
    expect(operatorAuthorized(req(), env)).toBe(false);
    expect(tickAuthorized(req("Bearer old-key"), env)).toBe(false);
  });
  it("during a change both keys open, and nothing else does", () => {
    const env = { CRON_SECRET: "new-key", CRON_SECRET_PREVIOUS: "old-key" };
    for (const k of ["new-key", "old-key"]) { expect(operatorAuthorized(req(`Bearer ${k}`), env)).toBe(true); expect(tickAuthorized(req(`Bearer ${k}`), env)).toBe(true); }
    expect(operatorAuthorized(req("Bearer wrong"), env)).toBe(false);
    expect(operatorAuthorized(req("Bearer "), env)).toBe(false);
    expect(operatorAuthorized(req(), env)).toBe(false);
    expect(tickAuthorized(req("Bearer wrong"), env)).toBe(false);
  });
  it("an empty previous key opens nothing; without a current key the admin routes stay shut and the tick stays open (local development)", () => {
    expect(bearerMatches(req("Bearer "), { CRON_SECRET: "k", CRON_SECRET_PREVIOUS: "" })).toBe(false);
    expect(operatorAuthorized(req("Bearer old-key"), { CRON_SECRET_PREVIOUS: "old-key" })).toBe(false);
    expect(operatorAuthorized(req("Bearer x"), {})).toBe(false);
    expect(tickAuthorized(req(), {})).toBe(true);
  });
});
