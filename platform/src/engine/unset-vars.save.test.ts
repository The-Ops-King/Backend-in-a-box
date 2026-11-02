/** D304: a save that adds a read of a value some path never sets is refused, naming it; one the saved copy already had only warns. */
import { describe, it, expect, beforeAll } from "vitest";
import { asOperator } from "@/db/client";
import { migrate } from "@/db/migrate";
import { installCompany } from "./install";
import { fakeAdapters } from "./test-install";
import { one } from "@/db/client";
import { findCompanyWorkflow, saveDefinition } from "./definitions";

process.env.BINDINGS_KEY ??= Buffer.alloc(32, 7).toString("base64");
const SLUG = `d304-${Date.now()}`;
let co = "", wf = "";

describe.skipIf(!process.env.DATABASE_URL)("D304: saving refuses a new unset read", () => {
  beforeAll(async () => {
    await migrate();
    co = (await installCompany({ name: "D304", slug: SLUG, timezone: "America/New_York", locationId: "LOC", pit: "pit-fake", calendars: {}, templates: ["daily-wrap-up"] }, fakeAdapters())).companyId;
    await asOperator(async (c) => { const w = await findCompanyWorkflow(c, co, "daily-wrap-up"); if (!w.ok) throw new Error(w.why); wf = w.id; });
  }, 180000);

  it("a post that reads a var nothing sets is refused, dry run or not; the same post with a fallback saves", async () => {
    await asOperator(async (c) => {
      const cur = (await one<{ definition: unknown }>(c, "select v.definition from workflows w join workflow_versions v on v.workflow_id=w.id and v.version=w.current_version where w.id=$1", [wf]))!.definition as { nodes: { id: string; type: string; template?: string }[] };
      const bad = JSON.parse(JSON.stringify(cur)); const p = bad.nodes.find((n: { type: string }) => n.type === "slack_post");
      p.template = `${p.template}\n{{vars.never_set}}`;
      for (const dryRun of [true, false]) {
        const r = await saveDefinition(c, { workflowId: wf, definition: bad, note: "test", dryRun });
        expect(r).toMatchObject({ ok: false, status: 422, unset: [{ node: p.id, var: "never_set" }] });
      }
      p.template = p.template.replace("{{vars.never_set}}", "{{vars.never_set | default:}}");
      expect(await saveDefinition(c, { workflowId: wf, definition: bad, note: "test", dryRun: true })).toMatchObject({ ok: true });
    });
  });
});
