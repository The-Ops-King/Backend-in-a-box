import type { PoolClient } from "pg";
import { many, one } from "@/db/client";
import { decrypt, encrypt } from "./crypto";
import { vendorOfBinding, wakePausedOnAuth } from "./failures";

/**
 * D100: a key shared between companies without its value passing through anyone's hands: read and decrypted from one
 * company, encrypted and stored on the other, inside the engine. Only the AI keys a client may share: a CRM token, a booking or
 * payments key, a webhook signing secret is one company's own account, and a copy would point one client's engine at another's.
 * Values are never returned or audited; the audit row on the target names the keys and where they came from.
 */
export const SHAREABLE = ["secret.anthropic_key", "secret.jev_key"];

export type CopyResult =
  | { ok: true; from: string; to: string; copied: { key: string; was: "new" | "same" | "replaced" }[] }
  | { ok: false; status: number; error: string; keys?: string[] };

export async function copySecretBindings(c: PoolClient, args: { from: string; to: string; keys: unknown; by?: string }): Promise<CopyResult> {
  const keys = Array.isArray(args.keys) ? [...new Set(args.keys.map((k) => (typeof k === "string" ? k.trim() : "")))] : [];
  if (!keys.length || keys.some((k) => !k)) return { ok: false, status: 400, error: "keys must be a non-empty list of binding keys" };
  const own = keys.filter((k) => !SHAREABLE.includes(k));
  if (own.length) return { ok: false, status: 400, error: `only ${SHAREABLE.join(" and ")} can be copied between companies; ${own.join(", ")} ${own.length === 1 ? "belongs" : "belong"} to one company's own accounts, set by install`, keys: own };
  if (args.from === args.to) return { ok: false, status: 400, error: "from and to are the same company" };
  const src = await one<{ id: string }>(c, "select id from companies where slug=$1", [args.from]);
  if (!src) return { ok: false, status: 404, error: `no such company: ${args.from}` };
  const dst = await one<{ id: string }>(c, "select id from companies where slug=$1", [args.to]);
  if (!dst) return { ok: false, status: 404, error: `no such company: ${args.to}` };
  const rows = await many<{ key: string; kind: string; value: Buffer }>(c, "select key, kind, value from bindings where company_id=$1 and key = any($2::text[])", [src.id, keys]);
  const absent = keys.filter((k) => !rows.some((r) => r.key === k));
  if (absent.length) return { ok: false, status: 404, error: `${args.from} has no ${absent.join(", ")}: nothing was copied`, keys: absent };
  const notSecret = rows.filter((r) => r.kind !== "secret").map((r) => r.key);
  if (notSecret.length) return { ok: false, status: 400, error: `${notSecret.join(", ")} on ${args.from} ${notSecret.length === 1 ? "is not stored as a secret" : "are not stored as secrets"}: nothing was copied`, keys: notSecret };
  const copied: { key: string; was: "new" | "same" | "replaced" }[] = [];
  for (const k of keys) {
    const r = rows.find((x) => x.key === k)!;
    const value = decrypt(r.value);
    const prior = await one<{ kind: string; value: Buffer }>(c, "select kind, value from bindings where company_id=$1 and key=$2", [dst.id, k]);
    const priorPlain = prior ? (prior.kind === "secret" ? decrypt(prior.value) : prior.value.toString("utf8")) : null;
    await c.query("insert into bindings (company_id, key, kind, value) values ($1,$2,$3,$4) on conflict (company_id, key) do update set kind=excluded.kind, value=excluded.value, updated_at=now()", [dst.id, k, r.kind, encrypt(value)]);
    const was = priorPlain === null ? "new" : priorPlain === value ? "same" : "replaced";
    // as install does (D66): a new token wakes the target's runs paused on that vendor's auth
    const vendor = vendorOfBinding(k);
    if (vendor && was === "replaced") await wakePausedOnAuth(c, dst.id, vendor);
    copied.push({ key: k, was });
  }
  await c.query("insert into audit_log (company_id, action, target_type, target_id, after) values ($1,'binding.copied','company',$2,$3)", [dst.id, dst.id, { keys, from: args.from, by: args.by ?? "operator", copied }]);
  return { ok: true, from: args.from, to: args.to, copied };
}
