import type { PoolClient } from "pg";
import { KNOWN_ROOTS, referencedPaths } from "./template";
import type { Layout } from "@/api/chart-verdict";

/**
 * Editing the words of a message in a company's copy of a workflow: a new workflow version with only that text changed,
 * validated the way a save from the editor would be (every {{placeholder}} must be a root the engine knows). D177: the words are
 * kept apart and laid over every build, so the copy stays untouched and keeps its template's upgrades. Runs already in flight
 * keep the version they started on.
 */
export type CopyField = "template" | "subject" | "substitute_template" | "title" | "body";
export const EDITABLE: Record<string, CopyField[]> = { send_sms: ["template", "substitute_template"], send_email: ["subject", "template", "substitute_template"], slack_post: ["template"], note: ["template"], create_task: ["title", "body"] };

export function validateCopy(text: string): { ok: true } | { ok: false; why: string } {
  if (!text.trim()) return { ok: false, why: "the message is empty" };
  const bad = referencedPaths(text).filter((p) => !KNOWN_ROOTS.includes(p.split(".")[0]));
  if (bad.length) return { ok: false, why: `unknown placeholder${bad.length > 1 ? "s" : ""}: ${bad.map((b) => `{{${b}}}`).join(", ")}` };
  const open = (text.match(/\{\{/g) ?? []).length, close = (text.match(/\}\}/g) ?? []).length;
  if (open !== close) return { ok: false, why: "a {{placeholder}} is not closed" };
  return { ok: true };
}

/** D177: a word edit is kept in the company's words (src/engine/words.ts) and laid on the workflow; it no longer freezes the copy. */
export async function saveCopy(c: PoolClient, args: { workflowId: string; nodeId: string; field: CopyField; text: string; by?: string }): Promise<{ ok: true; version: number; layout?: Layout } | { ok: false; why: string }> {
  const { setWord } = await import("./words");
  return setWord(c, args);
}
