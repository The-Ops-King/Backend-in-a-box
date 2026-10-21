import { PRIMITIVES } from "@/workflow/primitives";
import { OUTBOUND } from "@/workflow/primitives/spec";
import { type Requires, validateWorkflow, type Problem } from "@/workflow/validate";
import type { Tx } from "./store";
import type { CrmWrites, Delivery, VersionRow, WorkflowRow } from "./types";

/**
 * Changing an offer's configuration: saving a workflow version, enabling it, and the two switches beside the
 * definition (delivery and CRM writes). Each call is about one offer and one workflow, never a list.
 */

const stable = (v: unknown): string =>
  Array.isArray(v) ? `[${v.map(stable).join(",")}]`
    : v && typeof v === "object" ? `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`).join(",")}}`
      : JSON.stringify(v);

type RawDef = { nodes?: { id: string; type: string }[]; edges?: { from: string; to: string }[]; sendWindow?: unknown; delivery?: unknown };

/**
 * What a live delivery state vouches for: every step that reaches outside (its words by key, its conditions, where it
 * goes), the edges into and out of them, and the workflow's send window and delivery defaults.
 */
export function outboundShape(def: unknown): string {
  const d = (def ?? {}) as RawDef;
  const nodes = (d.nodes ?? []).filter((n) => {
    const spec = PRIMITIVES.get(n.type);
    if (!spec) return true;
    const parsed = spec.schema.safeParse(n);
    const effect = parsed.success ? spec.effect?.(parsed.data) : undefined;
    return parsed.success ? !!effect && OUTBOUND.has(effect) : true;
  });
  const ids = new Set(nodes.map((n) => n.id));
  return stable({
    nodes: [...nodes].sort((a, b) => a.id.localeCompare(b.id)),
    edges: (d.edges ?? []).filter((e) => ids.has(e.from) || ids.has(e.to)).map(stable).sort(),
    sendWindow: d.sendWindow ?? null,
    delivery: d.delivery ?? null,
  });
}

export type SaveResult =
  | { ok: true; workflow: WorkflowRow; version: VersionRow; requires: Requires; backToSandbox: boolean }
  | { ok: false; problems: Problem[] };

/**
 * Saves a new version of one workflow (making the workflow, sandbox and dry, the first time). Versions are never
 * changed: this always writes a new one, with who and why. A version that changes any step that reaches outside drops
 * a live workflow back to sandbox.
 */
export async function saveVersion(tx: Tx, x: { offerId: string; definition: unknown; by: string; why: string; now: Date }): Promise<SaveResult> {
  const v = validateWorkflow(x.definition);
  if (!v.ok) return { ok: false, problems: v.problems };
  let wf = await tx.workflowByKey(x.offerId, v.workflow.id);
  if (!wf) wf = await tx.insertWorkflow({ offerId: x.offerId, key: v.workflow.id, name: v.workflow.name });
  const prior = await tx.latestVersion(wf.id);
  const version = await tx.insertVersion({ offerId: x.offerId, workflowId: wf.id, version: (prior?.version ?? 0) + 1, definition: x.definition, createdBy: x.by, reason: x.why, createdAt: x.now });
  const changed = !!prior && outboundShape(prior.definition) !== outboundShape(x.definition);
  const backToSandbox = changed && wf.delivery === "live";
  await tx.updateWorkflow(wf.id, {
    currentVersionId: version.id, name: v.workflow.name,
    ...(backToSandbox ? { delivery: "sandbox" as Delivery, deliverySetBy: "engine", deliverySetAt: x.now, deliveryNote: `version ${version.version} changed a step that reaches outside` } : {}),
  });
  return { ok: true, workflow: (await tx.workflow(wf.id))!, version, requires: v.requires, backToSandbox };
}

/** What a workflow still needs from its offer before it may run: settings with no value, content not written. */
export async function missingFor(tx: Tx, wf: WorkflowRow): Promise<{ settings: string[]; content: string[]; workflows: string[] }> {
  const version = wf.currentVersionId ? await tx.version(wf.currentVersionId) : undefined;
  if (!version) return { settings: ["(no version saved)"], content: [], workflows: [] };
  const v = validateWorkflow(version.definition);
  if (!v.ok) return { settings: ["(the version does not validate)"], content: [], workflows: [] };
  const settings = await tx.settings(wf.offerId);
  const content = new Set(await tx.contentKeys(wf.offerId));
  const others = new Set((await tx.workflows(wf.offerId)).map((w) => w.key));
  const empty = (x: unknown) => x === undefined || x === null || x === "";
  return {
    settings: v.requires.settings.filter((k) => empty(settings[k])),
    content: v.requires.content.filter((k) => !content.has(k)),
    workflows: v.requires.workflows.filter((k) => !others.has(k)),
  };
}

/** Turns a workflow on, refused while a setting it reads has no value or content it names is not written. */
export async function enableWorkflow(tx: Tx, workflowId: string): Promise<{ ok: true } | { ok: false; missing: { settings: string[]; content: string[]; workflows: string[] } }> {
  const wf = await tx.workflow(workflowId);
  if (!wf) throw new Error("no such workflow");
  const missing = await missingFor(tx, wf);
  if (missing.settings.length || missing.content.length || missing.workflows.length) return { ok: false, missing };
  await tx.updateWorkflow(wf.id, { enabled: true });
  return { ok: true };
}

export async function disableWorkflow(tx: Tx, workflowId: string): Promise<void> { await tx.updateWorkflow(workflowId, { enabled: false }); }

/**
 * Sets one workflow's delivery state. Going live needs `confirm` to repeat "<offer slug>/<workflow id>" exactly and a
 * `by`: it is never a by-product of another call, and never more than one workflow. Going back to sandbox needs only `by`.
 */
export async function setDelivery(tx: Tx, x: { workflowId: string; delivery: Delivery; by: string; confirm?: string; now: Date }): Promise<{ ok: true } | { ok: false; error: string }> {
  const wf = await tx.workflow(x.workflowId);
  if (!wf) return { ok: false, error: "no such workflow" };
  if (!x.by.trim()) return { ok: false, error: "by is required (who said to)" };
  const offer = (await tx.offer(wf.offerId))!;
  if (x.delivery === "live" && x.confirm !== `${offer.slug}/${wf.key}`) return { ok: false, error: `confirm must be exactly "${offer.slug}/${wf.key}"` };
  await tx.updateWorkflow(wf.id, { delivery: x.delivery, deliverySetBy: x.by.trim(), deliverySetAt: x.now, deliveryNote: null });
  return { ok: true };
}

/** Sets one workflow's CRM writes, dry or real, with the same confirmation as delivery. */
export async function setCrmWrites(tx: Tx, x: { workflowId: string; crmWrites: CrmWrites; by: string; confirm?: string; now: Date }): Promise<{ ok: true } | { ok: false; error: string }> {
  const wf = await tx.workflow(x.workflowId);
  if (!wf) return { ok: false, error: "no such workflow" };
  if (!x.by.trim()) return { ok: false, error: "by is required (who said to)" };
  const offer = (await tx.offer(wf.offerId))!;
  if (x.crmWrites === "real" && x.confirm !== `${offer.slug}/${wf.key}`) return { ok: false, error: `confirm must be exactly "${offer.slug}/${wf.key}"` };
  await tx.updateWorkflow(wf.id, { crmWrites: x.crmWrites, crmWritesSetBy: x.by.trim(), crmWritesSetAt: x.now });
  return { ok: true };
}
