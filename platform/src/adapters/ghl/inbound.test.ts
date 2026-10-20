/** Audit risk 11: the inbound read walks every thread touched since the cursor, oldest first, and says where it stopped when a tick's share runs out. */
import { describe, it, expect, afterEach } from "vitest";
import { ghlRead } from "./read";

const was = globalThis.fetch;
afterEach(() => { globalThis.fetch = was; });
const company = { id: "co", pit: "pit", locationId: "LOC" } as Parameters<typeof ghlRead.inboundSince>[0];
const since = "2026-10-01T00:00:00.000Z", t0 = Date.parse(since);

function fakeGhl(threads: number) {
  const searches: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/conversations/search")) {
      searches.push(url);
      const after = Number(new URL(url).searchParams.get("startAfterDate")), limit = Number(new URL(url).searchParams.get("limit"));
      expect(new URL(url).searchParams.get("sort")).toBe("asc");
      const convs = Array.from({ length: threads }, (_, i) => ({ id: `cv${i}`, contactId: `ct${i}`, lastMessageDate: t0 + (i + 1) * 1000 })).filter((x) => x.lastMessageDate > after).slice(0, limit);
      return new Response(JSON.stringify({ conversations: convs }), { status: 200 });
    }
    const id = /conversations\/(cv\d+)\/messages/.exec(url)![1], i = Number(id.slice(2));
    return new Response(JSON.stringify({ messages: { messages: [{ id: `m${i}`, direction: "inbound", messageType: "TYPE_SMS", body: "hi", dateAdded: new Date(t0 + (i + 1) * 1000).toISOString() }, { id: `old${i}`, direction: "inbound", messageType: "TYPE_SMS", dateAdded: new Date(t0 - 1000).toISOString() }] } }), { status: 200 });
  }) as typeof fetch;
  return searches;
}

describe("ghlRead.inboundSince", () => {
  it("reads every thread past the old 50, oldest first, and only messages after the cursor", async () => {
    const searches = fakeGhl(120);
    const out = await ghlRead.inboundSince(company, since);
    expect(out.map((m) => m.id)).toEqual(Array.from({ length: 120 }, (_, i) => `m${i}`));
    expect(out.more).toBeUndefined();
    expect(searches).toHaveLength(3);
  });
  it("stops at its share for one tick and says where; the next tick starts after it", async () => {
    fakeGhl(400);
    const first = await ghlRead.inboundSince(company, since);
    expect(first).toHaveLength(150);
    expect(first.more).toBe(t0 + 150 * 1000);
    const next = await ghlRead.inboundSince(company, since, first.more);
    expect(next[0].id).toBe("m150");
  });
});
