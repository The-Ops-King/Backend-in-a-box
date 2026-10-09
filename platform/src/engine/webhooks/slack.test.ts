import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { parseSlackEvent, verifySlackSignature } from "./slack";

const sign = (secret: string, ts: string, raw: string) => `v0=${createHmac("sha256", secret).update(`v0:${ts}:${raw}`).digest("hex")}`;

describe("the Slack door (D45)", () => {
  it("accepts Slack's signature inside the window and refuses a forged or stale one", () => {
    const raw = JSON.stringify({ type: "event_callback" }); const now = 1_800_000_000_000; const ts = String(Math.floor(now / 1000) - 10);
    expect(verifySlackSignature("s3cret", { timestamp: ts, signature: sign("s3cret", ts, raw) }, raw, now)).toEqual({ ok: true });
    expect(verifySlackSignature("s3cret", { timestamp: ts, signature: sign("other", ts, raw) }, raw, now)).toMatchObject({ ok: false, why: "signature mismatch" });
    const old = String(Math.floor(now / 1000) - 600);
    expect(verifySlackSignature("s3cret", { timestamp: old, signature: sign("s3cret", old, raw) }, raw, now)).toMatchObject({ ok: false });
    expect(verifySlackSignature("s3cret", { timestamp: null, signature: null }, raw, now)).toMatchObject({ ok: false });
  });
  it("answers the URL check, reads a reaction on a message, ignores the rest", () => {
    expect(parseSlackEvent({ type: "url_verification", challenge: "abc" })).toEqual({ kind: "challenge", challenge: "abc" });
    expect(parseSlackEvent({ type: "event_callback", event_id: "Ev1", event: { type: "reaction_added", user: "U1", reaction: "white_check_mark::skin-tone-2", item: { type: "message", channel: "C1", ts: "1.2" } } }))
      .toEqual({ kind: "reaction", eventId: "Ev1", user: "U1", reaction: "white_check_mark", channel: "C1", ts: "1.2", removed: false });
    expect(parseSlackEvent({ type: "event_callback", event: { type: "message" } })).toMatchObject({ kind: "ignored" });
    expect(parseSlackEvent({ type: "app_rate_limited" })).toMatchObject({ kind: "ignored" });
  });
});
