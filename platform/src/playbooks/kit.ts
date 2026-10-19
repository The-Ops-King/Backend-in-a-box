/**
 * D147: the tools a playbook builds a company's copies with: a fresh copy of a shipped template's definition, and the two
 * edits every copy so far is made of (take a step out, put one in after another). A copy is always rebuilt from the template
 * it changes, so a template's fix reaches every company on the next build.
 */
import { templates } from "@/templates";

export type Node = { id: string; type: string; [k: string]: unknown };
export type Edge = { from: string; to: string; label?: string; when?: unknown; else?: boolean };
export type Def = { nodes: Node[]; edges: Edge[] };
/** A copy of a template's workflow the company already has (saved over it), or (D123) the company's own workflow, made with `create`. */
export type Copy = { workflow: string; note: string; definition: Record<string, unknown>; name?: string; create?: { stage: string; sort: number; takesOver?: string } };

export const template = (slug: string) => { const t = templates.find((x) => x.slug === slug); if (!t) throw new Error(`no shipped template ${slug}`); return t; };
/** The template's definition, to change freely. */
export const load = (slug: string): Def => structuredClone(template(slug).definition) as unknown as Def;
export const node = (d: Def, id: string) => { const n = d.nodes.find((x) => x.id === id); if (!n) throw new Error(`no node ${id}`); return n; };
/** Removes node `id`, joining the edges into it to its one way on. */
export const drop = (d: Def, id: string) => {
  const outs = d.edges.filter((e) => e.from === id);
  if (outs.length !== 1) throw new Error(`${id} has ${outs.length} ways on`);
  for (const e of d.edges) if (e.to === id) e.to = outs[0].to;
  d.edges = d.edges.filter((e) => e.from !== id); d.nodes = d.nodes.filter((n) => n.id !== id);
};
/** Puts node `n` right after `prev` (which has one way on), in the line and in the node list. */
export const after = (d: Def, prev: string, n: Node) => {
  const outs = d.edges.filter((e) => e.from === prev);
  if (outs.length !== 1) throw new Error(`${prev} has ${outs.length} ways on`);
  d.nodes.splice(d.nodes.findIndex((x) => x.id === prev) + 1, 0, n);
  d.edges.push({ from: n.id, to: outs[0].to }); outs[0].to = n.id;
};
export const RESCHEDULE = { eq: ["{{event._type}}", "appointment.rescheduled"] };
export const asCopy = (workflow: string, d: Def, note: string): Copy => ({ workflow, note, definition: d as unknown as Record<string, unknown> });
