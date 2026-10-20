import { asOperator, one } from "@/db/client";
import { randomUUID } from "node:crypto";

export const TICK_LEASE_SECONDS = 360;   // > the route's maxDuration (300s): a tick killed mid-flight frees the lock by expiry
/** The one lease every tick took before D98. Only `pnpm tick` takes it now, and an older deployment finishing its last tick during a rollout. */
export const LEGACY_LOCK = "tick_lock";
/** D98: one lease per company, so two pollers never work one company while different companies tick side by side. */
export const companyLock = (companyId: string) => `tick_lock:${companyId}`;
/** D98: the engine's own minute (retention, the engine's alerts, staleness, the scheduler's heartbeat). */
export const ENGINE_LOCK = "tick_lock:engine";

/**
 * At most one holder per lease key. Ticks arrive from the database scheduler, the Vercel daily sweep and operators by
 * hand, and two of them polling the same company at once insert the same contacts and cursors into each other. A lease
 * row in engine_state is pooler-safe (no session-level advisory lock) and self-healing (expiry). Returns null when busy.
 */
export async function acquireTickLock(leaseSeconds = TICK_LEASE_SECONDS, key = LEGACY_LOCK): Promise<string | null> {
  const owner = randomUUID();
  const row = await asOperator((c) => one<{ key: string }>(c, `
    insert into engine_state (key, value, updated_at) values ($2, $1, now())
    on conflict (key) do update set value = excluded.value, updated_at = now()
      where coalesce((engine_state.value->>'until')::timestamptz, 'epoch') < now()
    returning key`, [JSON.stringify({ owner, until: new Date(Date.now() + leaseSeconds * 1000).toISOString() }), key]));
  return row ? owner : null;
}

export async function releaseTickLock(owner: string, key = LEGACY_LOCK): Promise<void> {
  await asOperator((c) => c.query(`update engine_state set value = jsonb_build_object('owner', $1::text, 'until', 'epoch'::timestamptz), updated_at = now()
    where key=$2 and value->>'owner' = $1`, [owner, key]));
}

/** Keeps a lease its owner still holds from running out (a long holder renews; one that died lets it lapse). */
export async function renewTickLock(owner: string, key: string, leaseSeconds: number): Promise<void> {
  await asOperator((c) => c.query("update engine_state set value = jsonb_build_object('owner', $1::text, 'until', $3::timestamptz), updated_at = now() where key=$2 and value->>'owner' = $1",
    [owner, key, new Date(Date.now() + leaseSeconds * 1000).toISOString()]));
}

/** Is the lease under `key` held right now, by anyone. */
export async function tickLockHeld(key = LEGACY_LOCK): Promise<boolean> {
  return !!(await asOperator((c) => one(c, "select 1 from engine_state where key=$1 and coalesce((value->>'until')::timestamptz, 'epoch') >= now()", [key])));
}

export async function withTickLock<T>(fn: () => Promise<T>, key = LEGACY_LOCK, leaseSeconds = TICK_LEASE_SECONDS): Promise<{ busy: true } | { busy: false; result: T }> {
  const owner = await acquireTickLock(leaseSeconds, key);
  if (!owner) return { busy: true };
  try { return { busy: false, result: await fn() }; }
  finally { await releaseTickLock(owner, key).catch(() => {}); }
}
