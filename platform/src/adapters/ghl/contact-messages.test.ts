/** D318: one contact's messages, newest first, with the workflow that sent each when GHL says. */
import { describe, it, expect, afterEach } from "vitest";
import { ghlRead } from "./read";

const was = globalThis.fetch;
afterEach(() => { globalThis.fetch = was; });
const company = { id: "co", pit: "pit", locationId: "LOC" } as Parameters<typeof ghlRead.inboundSince>[0];

describe("ghlRead.contactMessages", () => {
  it("reads the contact's threads and says which workflow sent each message", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input); urls.push(url);
      if (url.includes("/conversations/search")) return new Response(JSON.stringify({ conversations: [{ id: "cv1" }] }), { status: 200 });
      return new Response(JSON.stringify({ messages: { messages: [
        { id: "a", dateAdded: "2026-11-06T18:15:00Z", messageType: "TYPE_SMS", direction: "outbound", source: "workflow", meta: { workflowId: "WF01" }, body: "See you   soon" },
        { id: "b", dateAdded: "2026-11-06T18:20:00Z", messageType: "TYPE_EMAIL", direction: "outbound", source: "app", subject: "Hi", body: "x" },
      ] } }), { status: 200 });
    }) as typeof fetch;
    const out = await ghlRead.contactMessages!(company, "CT1", 10);
    expect(urls[0]).toContain("contactId=CT1");
    expect(out).toEqual([
      { id: "b", at: "2026-11-06T18:20:00Z", channel: "email", direction: "outbound", source: "app", workflow: null, subject: "Hi", body: "x" },
      { id: "a", at: "2026-11-06T18:15:00Z", channel: "sms", direction: "outbound", source: "workflow", workflow: "WF01", subject: null, body: "See you soon" },
    ]);
  });
});
