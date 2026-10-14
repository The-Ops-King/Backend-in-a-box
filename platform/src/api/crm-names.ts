import type { Catalog } from "@/adapters/ghl/catalog";
import { boardWords, humanWords, stageWords } from "@/engine/describe";

/**
 * D112: the CRM's own names for what a step points at (a board, a stage, a field, a custom object), so the chart says
 * "Booked Call" where PMU's GHL says so, not our binding key's "Scheduled". Read once per company and kept ten minutes
 * in memory (a failed read one minute); when the CRM cannot be read the key words stand in, marked, never as a guess.
 */
export type CrmNames = { read: boolean; pipelines: Record<string, string>; stages: Record<string, string>; fields: Record<string, string>; objects: Record<string, string> };
export const UNREAD = "name not read from GHL";
export const UNREAD_MANY = "names not read from GHL";
/** A name and whether it came from the CRM; a word that did not is shown with the marker. */
export type Named = { text: string; read: boolean };
export type Namer = { board(p: string): Named; stage(p: string): Named; stageId(id: string): Named; field(p: string): Named; object(o: string): Named };

export const NONE: CrmNames = { read: false, pipelines: {}, stages: {}, fields: {}, objects: {} };
export function namesOf(cat: Catalog): CrmNames {
  // a list the token could not read is left out, and so is marked where it is needed
  return { read: !cat.errors.some((e) => /^pipelines/.test(e)), pipelines: Object.fromEntries(cat.pipelines.map((p) => [p.id, p.name])), stages: Object.fromEntries(cat.pipelines.flatMap((p) => p.stages.map((s) => [s.id, s.name]))),
    fields: Object.fromEntries([...cat.contactFields, ...cat.opportunityFields].map((f) => [f.id, f.name])), objects: Object.fromEntries(cat.objects.map((o) => [o.key, o.label])) };
}

/**
 * Names for a company: a `{{crm.…}}` binding or a literal id resolved through `bindings` to the CRM's name. Without
 * `names` (a template with no company) the key words stand unmarked: there is no CRM to have read.
 */
export function namer(bindings: Record<string, string>, names?: CrmNames | null): Namer {
  const idOf = (p: string) => { const m = /^\{\{\s*([a-z0-9_.]+)/.exec(p.trim()); return m ? bindings[m[1]] : p.trim(); };
  const pick = (p: string, table: keyof Omit<CrmNames, "read">, words: string): Named => {
    if (!names) return { text: words, read: true };
    const id = idOf(p); const n = id ? names[table][id] : undefined;
    return n ? { text: n, read: true } : { text: words, read: false };
  };
  return {
    board: (p) => pick(p, "pipelines", boardWords(p).replace(/\b\w/g, (ch) => ch.toUpperCase())),
    stage: (p) => pick(p, "stages", stageWords(p)),
    stageId: (id) => names?.stages[id] ? { text: names.stages[id], read: true } : { text: id, read: false },
    field: (p) => pick(p, "fields", /crm\.field_(?:contact|opportunity)_([a-z0-9_]+)/.exec(p)?.[1].replace(/_/g, " ") ?? humanWords(p)),
    object: (o) => { const b = /^\{\{\s*crm\.object_([a-z0-9_]+)/.exec(o); const key = b ? idOf(o) || `custom_objects.${b[1]}` : o; const words = humanWords(key.replace(/^custom_objects\./, "")).replace(/\b\w/g, (ch) => ch.toUpperCase()); if (!names) return { text: words, read: true }; const n = names.objects[key]; return n ? { text: n, read: true } : { text: words, read: false }; },
  };
}
