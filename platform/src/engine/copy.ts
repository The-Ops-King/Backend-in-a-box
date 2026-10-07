import type { PoolClient } from "pg";
import { one } from "@/db/client";
import { parseDefinition, type Definition, type Node } from "./definition";
import { KNOWN_ROOTS, referencedPaths } from "./template";

/**
 * Editing the words of a message in a company's copy of a workflow: a new workflow version with only that text changed,
 * validated the way a save from the editor would be (every {{placeholder}} must be a root the engine knows). The copy
 * is then "diverged": template upgrades leave it alone and say so. Runs already in flight keep the version they started on.
 */
export type CopyField = "template" | "subject" | "substitute_template" | "title" | "body";
const EDITABLE: Record<string, CopyField[]> = { send_sms: ["template", "substitute_template"], send_email: ["subject", "template", "substitute_template"], slack_post: ["template"], note: ["template"], create_task: ["title", "body"] };

export function validateCopy(text: string): { ok: true } | { ok: false; why: string } {
  if (!text.trim()) return { ok: false, why: "the message is empty" };
  const bad = referencedPaths(text).filter((p) => !KNOWN_ROOTS.includes(p.split(".")[0]));
  if (bad.length) return { ok: false, why: `unknown placeholder${bad.length > 1 ? "s" : ""}: ${bad.map((b) => `{{${b}}}`).join(", ")}` };
  const open = (text.match(/\{\{/g) ?? []).length, close = (text.match(/\}\}/g) ?? []).length;
  if (open !== close) return { ok: false, why: "a {{placeholder}} is not closed" };
  return { ok: true };
}

export async function saveCopy(c: PoolClient, args: { workflowId: string; nodeId: string; field: CopyField; text: string; by?: string }): Promise<{ ok: true; version: number } | { ok: false; why: string }> {
  const v = validateCopy(args.text); if (!v.ok) return v;
  const w = await one<{ id: string; company_id: string; current_version: number }>(c, "select id, company_id, current_version from workflows where id=$1", [args.workflowId]);
  if (!w) return { ok: false, why: "workflow not found" };
  const cur = await one<{ definition: Definition; manifest: unknown }>(c, "select definition, manifest from workflow_versions where workflow_id=$1 and version=$2", [w.id, w.current_version]);
  if (!cur) return { ok: false, why: "current version missing" };
  const def = JSON.parse(JSON.stringify(cur.definition)) as Definition;
  const node = def.nodes.find((n) => n.id === args.nodeId) as (Node & Record<string, unknown>) | undefined;
  if (!node) return { ok: false, why: "step not found" };
  if (!EDITABLE[node.type]?.includes(args.field)) return { ok: false, why: `${args.field} is not editable on a ${node.type} step` };
  const before = node[args.field];
  if (before === args.text) return { ok: true, version: w.current_version };
  node[args.field] = args.text;
  try { parseDefinition(def); } catch (e) { return { ok: false, why: `the change does not validate: ${String((e as Error).message).slice(0, 200)}` }; }
  const next = w.current_version + 1;
  await c.query("insert into workflow_versions (workflow_id, version, definition, manifest, note) values ($1,$2,$3,$4,$5)", [w.id, next, def, cur.manifest, `copy edited: ${args.nodeId}.${args.field}`]);
  await c.query("update workflows set current_version=$2, diverged=true, diverged_at=coalesce(diverged_at, now()) where id=$1", [w.id, next]);
  await c.query("insert into audit_log (company_id, action, target_type, target_id, before, after) values ($1,'workflow.copy_edited','workflow',$2,$3,$4)", [w.company_id, w.id, { node: args.nodeId, field: args.field, text: before }, { node: args.nodeId, field: args.field, text: args.text, version: next, by: args.by ?? "dashboard" }]);
  return { ok: true, version: next };
}
