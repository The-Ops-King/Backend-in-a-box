/** D366: a workflow off while the events it starts on keep happening is found; one its match would not take, or one off on purpose, is not. */
import { describe, it, expect, beforeAll } from "vitest";
import { asOperator } from "@/db/client";
import { migrate } from "@/db/migrate";
import { installCompany } from "@/engine/install";
import { emitEvent } from "@/engine/dispatch";
import { fakeAdapters } from "@/engine/test-install";
import { workflowsOffWithWork } from "./workflows-off";

process.env.BINDINGS_KEY ??= Buffer.alloc(32, 7).toString("base64");

describe.skipIf(!process.env.DATABASE_URL)("D366: workflows off with work to do", () => {
  let co = "";
  beforeAll(async () => {
    await migrate();
    // installed OFF, as TRC's Setter call logged was
    co = (await installCompany({ name: "Off With Work", slug: `d366-${Date.now()}`, timezone: "America/Los_Angeles", locationId: "LOC-D366", pit: "pit-fake", calendars: {}, templates: ["dial-cadence"] } as never, fakeAdapters())).companyId;
  }, 60_000);
  const tag = (t: string, daysAgo = 1) => asOperator(async (c) => emitEvent(c, { company_id: co, contact_id: null, opportunity_id: null, appointment_id: null, event_type: "tag.added", source: "test", data: { tag: t }, occurred_at: new Date(Date.now() - daysAgo * 86_400_000) }));

  it("an event its trigger would not take (another tag), or one older than 7 days, says nothing", async () => {
    await tag("someone-else"); await tag("leap-buyer", 9);
    expect(await asOperator((c) => workflowsOffWithWork(c, co, {}, new Date()))).toEqual([]);
  });

  it("events it would have started on: found, with how many and the last", async () => {
    await tag("leap-buyer", 2); await tag("leap-buyer", 1);
    const found = await asOperator((c) => workflowsOffWithWork(c, co, {}, new Date()));
    expect(found).toEqual([expect.objectContaining({ slug: "dial-cadence", name: "Dial cadence", events: 2, types: ["tag.added"] })]);
  });

  it("named in health.off_on_purpose (by slug or name, any case): never flagged", async () => {
    expect(await asOperator((c) => workflowsOffWithWork(c, co, { "health.off_on_purpose": "speed-to-lead, DIAL-CADENCE" }, new Date()))).toEqual([]);
    expect(await asOperator((c) => workflowsOffWithWork(c, co, { "health.off_on_purpose": "Dial cadence" }, new Date()))).toEqual([]);
  });
});
