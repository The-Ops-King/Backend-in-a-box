/** D345: many unmarked GHL workflows at once are one alert that names them; a few are each their own. */
import { describe, it, expect, beforeAll } from "vitest";
import { asOperator } from "@/db/client";
import { migrate } from "@/db/migrate";
import { installCompany } from "@/engine/install";
import { fakeAdapters, fakeProbes } from "@/engine/test-install";
import { loadCompany } from "@/engine/context";
import { sweep, THEIR_WORKFLOWS_EACH } from "@/engine/health";

process.env.BINDINGS_KEY ??= Buffer.alloc(32, 7).toString("base64");
const SLUG = `d345-${Date.now()}`;
let co = "";
const wf = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `wf${i}`, name: `Legacy ${i}`, status: "published" }));
const run = (list: ReturnType<typeof wf>) => asOperator(async (c) => { const { row } = await loadCompany(c, co); return sweep(c, row, fakeAdapters(), { ...fakeProbes, theirWorkflows: async () => list }, { checks: {}, min_slots: 0, slots_days: 7 } as never); });

describe.skipIf(!process.env.DATABASE_URL)("D345: their GHL workflows, many unmarked", () => {
  beforeAll(async () => {
    await migrate();
    co = (await installCompany({ name: "Many Workflows", slug: SLUG, timezone: "America/Phoenix", locationId: "LOC-D345", pit: "pit-fake", calendars: {}, templates: [] } as never, fakeAdapters())).companyId;
    // two marked (what woke the check on TRC)
    await asOperator((c) => c.query(`insert into onboarding (company_id, filters) values ($1, $2) on conflict (company_id) do update set filters=excluded.filters`, [co, { marks: { wfA: { mark: "harmless" }, wfB: { mark: "harmless" } } }]));
  });

  it("190 published and unmarked: one finding that names the first few and counts the rest, not 190", async () => {
    const found = (await run(wf(190))).filter((f) => f.check === "their_workflows" && !f.ok);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ item: "unmarked", level: "warning" });
    expect(found[0]!.text).toMatch(/^190 of their GHL workflows are published and not marked yet: .*"Legacy 0", .*, and 182 more\.$/);
  });

  it(`up to ${THEIR_WORKFLOWS_EACH} unmarked: each its own finding, as before`, async () => {
    const found = (await run(wf(THEIR_WORKFLOWS_EACH))).filter((f) => f.check === "their_workflows" && !f.ok);
    expect(found.map((f) => f.item)).toEqual(wf(THEIR_WORKFLOWS_EACH).map((w) => w.id));
  });
});
