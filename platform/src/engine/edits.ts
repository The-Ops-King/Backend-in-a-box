import type { PoolClient } from "pg";
import { one } from "@/db/client";
import { parseDefinition, type Definition, type Node } from "./definition";
import { validateCopy } from "./copy";

/**
 * GHL-style "set it on the automation": a company's copy of a workflow can carry literal ids on its steps (this pipeline,
 * that stage, this Slack channel, these tags) instead of a crm.* binding. Templates keep bindings so they stay portable;
 * a copy that was edited is diverged and left alone by template upgrades. Every edit is a new version, validated.
 */
export type StepEdit =
  | { type: "pipeline_card"; pipeline?: string; stage?: string; name?: string; assign_to?: string; status?: "" | "open" | "won" | "lost" | "abandoned"; if_missing?: "create" | "skip" }
  | { type: "slack_post"; channel?: string }
  | { type: "set_tag" | "remove_tag"; tags?: string[] }
  | { type: "update_contact"; assign_to?: string }
  | { type: "create_task"; assign_to?: string; due?: string };

export async function saveStepEdit(c: PoolClient, args: { workflowId: string; nodeId: string; edit: StepEdit; by?: string }): Promise<{ ok: true; version: number; changed: string[] } | { ok: false; why: string }> {
  const w = await one<{ id: string; company_id: string; current_version: number }>(c, "select id, company_id, current_version from workflows where id=$1", [args.workflowId]);
  if (!w) return { ok: false, why: "workflow not found" };
  const cur = await one<{ definition: Definition; manifest: unknown }>(c, "select definition, manifest from workflow_versions where workflow_id=$1 and version=$2", [w.id, w.current_version]);
  if (!cur) return { ok: false, why: "current version missing" };
  const def = JSON.parse(JSON.stringify(cur.definition)) as Definition;
  const node = def.nodes.find((n) => n.id === args.nodeId) as (Node & Record<string, unknown>) | undefined;
  if (!node) return { ok: false, why: "step not found" };
  if (node.type !== args.edit.type) return { ok: false, why: `step ${args.nodeId} is a ${node.type}, not a ${args.edit.type}` };
  const changed: string[] = [];
  const set = (field: string, value: unknown) => { if (value === undefined) return; if (JSON.stringify(node[field]) === JSON.stringify(value)) return; if (value === "" || (Array.isArray(value) && !value.length)) { if (field in node && !["pipeline", "stage", "channel", "tag"].includes(field)) { delete node[field]; changed.push(field); } return; } node[field] = value; changed.push(field); };
  const e = args.edit;
  if (e.type === "pipeline_card") {
    if (e.pipeline !== undefined && e.pipeline !== "") set("pipeline", e.pipeline);
    if (e.stage !== undefined && e.stage !== "") set("stage", e.stage);
    if (e.name !== undefined) { if (e.name) { const v = validateCopy(e.name); if (!v.ok) return v; } set("name", e.name); }
    if (e.assign_to !== undefined) set("assign_to", e.assign_to);
    if (e.status !== undefined) set("status", e.status);
    if (e.if_missing !== undefined) set("if_missing", e.if_missing);
  } else if (e.type === "slack_post") { if (e.channel) set("channel", e.channel); }
  else if (e.type === "set_tag" || e.type === "remove_tag") { if (e.tags) { const tags = e.tags.map((t) => t.trim()).filter(Boolean); if (!tags.length) return { ok: false, why: "at least one tag" }; set("tag", tags); } }
  else if (e.type === "update_contact") { if (e.assign_to !== undefined) { const setObj = { ...((node.set as Record<string, unknown>) ?? {}) }; if (e.assign_to) setObj.assign_to = e.assign_to; else delete setObj.assign_to; if (JSON.stringify(setObj) !== JSON.stringify(node.set)) { node.set = setObj; changed.push("assign_to"); } } }
  else if (e.type === "create_task") { if (e.assign_to !== undefined) set("assign_to", e.assign_to); if (e.due) set("due", e.due); }
  if (!changed.length) return { ok: true, version: w.current_version, changed };
  try { parseDefinition(def); } catch (err) { return { ok: false, why: `the change does not validate: ${String((err as Error).message).slice(0, 200)}` }; }
  const next = w.current_version + 1;
  await c.query("insert into workflow_versions (workflow_id, version, definition, manifest, note) values ($1,$2,$3,$4,$5)", [w.id, next, def, cur.manifest, `step edited: ${args.nodeId} (${changed.join(", ")})`]);
  await c.query("update workflows set current_version=$2, diverged=true, diverged_at=coalesce(diverged_at, now()) where id=$1", [w.id, next]);
  await c.query("insert into audit_log (company_id, action, target_type, target_id, after) values ($1,'workflow.step_edited','workflow',$2,$3)", [w.company_id, w.id, { node: args.nodeId, changed, version: next, by: args.by ?? "dashboard" }]);
  return { ok: true, version: next, changed };
}
