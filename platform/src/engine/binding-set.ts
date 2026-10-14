import type { PoolClient } from "pg";
import { one } from "@/db/client";
import { settingsRows, setBinding } from "./settings";

/**
 * D109: one plain company setting set from outside, as the Settings page would (a channel, a stage id, a word): only a key the
 * company's workflows or the engine read, never a secret (those come through install, or a copy, D100). Audited as the
 * Settings page's are; the value it replaces is returned so the change can be undone.
 */
export type SetResult = { ok: true; key: string; kind: string; was: string | null; value: string } | { ok: false; status: number; error: string };

export async function setPlainBinding(c: PoolClient, args: { company: string; key: unknown; value: unknown; by?: string }): Promise<SetResult> {
  const key = typeof args.key === "string" ? args.key.trim() : "";
  const value = typeof args.value === "string" ? args.value.trim() : "";
  if (!key || !value) return { ok: false, status: 400, error: "key and value are required (an empty value is not a setting)" };
  if (key.startsWith("secret.")) return { ok: false, status: 400, error: `${key} is a secret: install sets it (or copy it between companies)` };
  const co = await one<{ id: string }>(c, "select id from companies where slug=$1", [args.company]);
  if (!co) return { ok: false, status: 404, error: `no such company: ${args.company}` };
  const row = (await settingsRows(c, co.id)).find((r) => r.key === key);
  if (!row) return { ok: false, status: 400, error: `${key} is not a setting this company's workflows or the engine read` };
  if (row.kind === "secret") return { ok: false, status: 400, error: `${key} is a secret: install sets it` };
  await setBinding(c, co.id, key, row.kind, value, args.by ?? "operator");
  return { ok: true, key, kind: row.kind, was: row.value, value };
}
