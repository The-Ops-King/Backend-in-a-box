import type { PoolClient } from "pg";
import { fathomCreateWebhook, fathomDeleteWebhook, fathomPing } from "@/adapters/fathom/client";
import { setBinding } from "./settings";

/**
 * D336: put a new Fathom API key on one offer. A Fathom webhook belongs to the key (the Fathom user) that made it, so a key on its
 * own would leave recordings arriving through the old user's webhook, or none: the new key is tested, its own webhook made, the key,
 * the webhook's secret and id bound together, and only then the old webhook removed with the old key (no gap; an old delivery after
 * the switch fails its signature and Fathom stops once the webhook is gone). Dry run first. The key never comes back.
 */
export type FathomApi = { ping: typeof fathomPing; create: typeof fathomCreateWebhook; remove: typeof fathomDeleteWebhook };
const live: FathomApi = { ping: fathomPing, create: fathomCreateWebhook, remove: fathomDeleteWebhook };

export async function replaceFathomKey(c: PoolClient, companyId: string, bindings: Record<string, string>, newKey: string, baseUrl: string,
  opts: { dryRun?: boolean; by?: string } = {}, api: FathomApi = live) {
  const key = newKey.trim(); if (key.length < 16) throw new Error("paste the whole Fathom API key");
  const oldKey = bindings["secret.fathom_api_key"] ?? null, oldHook = bindings["fathom.webhook_id"] ?? null;
  if (oldKey === key) throw new Error("that is already this offer's Fathom key");
  const ping = await api.ping(key);
  if (ping !== true) throw new Error(`Fathom refused the key${ping && typeof ping === "object" ? ` (${ping.status ?? "no answer"}: ${ping.detail})` : ""}`);
  const url = `${baseUrl}/api/webhooks/fathom/${companyId}`;
  const plan = { key: `works, ends with ${key.slice(-4)}`, replaces: oldKey ? `key ending ${oldKey.slice(-4)}` : null, webhook: url, old_webhook: oldHook };
  if (opts.dryRun !== false) return { dryRun: true, ...plan, would: ["make a webhook on the new key", "bind the key, its webhook secret and id", oldHook ? "remove the old webhook with the old key" : "no old webhook to remove"] };
  const hook = await api.create(key, url);
  const by = opts.by ?? "fathom key";
  await setBinding(c, companyId, "secret.fathom_api_key", "secret", key, by);
  await setBinding(c, companyId, "secret.fathom_webhook", "secret", hook.secret, by);
  await setBinding(c, companyId, "fathom.webhook_id", "id", hook.id, by);
  let old: string | null = null;
  if (oldHook && oldKey) { try { old = await api.remove(oldKey, oldHook); } catch (e) { old = `not removed: ${String((e as Error).message).slice(0, 160)}`; } }
  else if (oldHook) old = "not removed: no old key to remove it with";
  await c.query("insert into audit_log (company_id, action, target_type, target_id, after) values ($1,'fathom.key_replaced','company',$3,$2)", [companyId, { ends_with: key.slice(-4), webhook: hook.id, old_webhook: oldHook, old_webhook_result: old, by }, companyId]);
  return { dryRun: false, ...plan, webhook_id: hook.id, old_webhook_result: old };
}
