import { describe, it, expect, beforeAll } from "vitest";
import { asOperator, one } from "@/db/client";
import { migrate } from "@/db/migrate";
import { saveStepEdit } from "./edits";

process.env.BINDINGS_KEY ??= Buffer.alloc(32, 7).toString("base64");
describe.skipIf(!process.env.DATABASE_URL)("step edits on a company's copy", () => {
  let wf: { id: string; current_version: number };
  beforeAll(async () => { await migrate(); wf = (await asOperator((c) => one<{ id: string; current_version: number }>(c, "select w.id, w.current_version from workflows w join workflow_templates t on t.id=w.template_id join companies co on co.id=w.company_id where co.slug='scn' and t.slug='call-booked'")))!; });
  it("a literal pipeline and stage replace the binding on the step; a wrong step type is refused; nothing changes when nothing changed", async () => {
    const r = await asOperator((c) => saveStepEdit(c, { workflowId: wf.id, nodeId: "s4", edit: { type: "pipeline_card", pipeline: "PIPE-X", stage: "STAGE-X", assign_to: "U1", status: "won" } }));
    expect(r).toMatchObject({ ok: true, version: wf.current_version + 1, changed: ["pipeline", "stage", "assign_to", "status"] });
    const def = await asOperator((c) => one<{ definition: { nodes: Record<string, unknown>[] } }>(c, "select definition from workflow_versions where workflow_id=$1 and version=$2", [wf.id, wf.current_version + 1]));
    expect(def!.definition.nodes.find((n) => n.id === "s4")).toMatchObject({ pipeline: "PIPE-X", stage: "STAGE-X", assign_to: "U1", status: "won" });
    expect(await asOperator((c) => saveStepEdit(c, { workflowId: wf.id, nodeId: "s4", edit: { type: "slack_post", channel: "C1" } }))).toMatchObject({ ok: false, why: /is a pipeline_card/ });
    expect(await asOperator((c) => saveStepEdit(c, { workflowId: wf.id, nodeId: "s4", edit: { type: "pipeline_card", pipeline: "PIPE-X", stage: "STAGE-X" } }))).toMatchObject({ ok: true, version: wf.current_version + 1, changed: [] });
    expect((await asOperator((c) => one<{ diverged: boolean }>(c, "select diverged from workflows where id=$1", [wf.id])))!.diverged).toBe(true);
  });
});
