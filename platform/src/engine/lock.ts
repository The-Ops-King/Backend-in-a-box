import { asOperator, one } from "@/db/client";
import { randomUUID } from "node:crypto";

export const TICK_LEASE_SECONDS = 360;   // > the route's maxDuration (300s): a tick killed mid-flight frees the lock by expiry

/**
 * At most one tick at a time. Ticks arrive from GitHub Actions, the Vercel daily sweep and operators by hand, and two of
 * them polling the same company at once insert the same contacts and cursors into each other. A lease row in
 * engine_state is pooler-safe (no session-level advisory lock) and self-healing (expiry). Returns null when busy.
 */
export async function acquireTickLock(leaseSeconds = TICK_LEASE_SECONDS): Promise<string | null> {
  const owner = randomUUID();
  const row = await asOperator((c) => one<{ key: string }>(c, `
    insert into engine_state (key, value, updated_at) values ('tick_lock', $1, now())
    on conflict (key) do update set value = excluded.value, updated_at = now()
      where coalesce((engine_state.value->>'until')::timestamptz, 'epoch') < now()
    returning key`, [JSON.stringify({ owner, until: new Date(Date.now() + leaseSeconds * 1000).toISOString() })]));
  return row ? owner : null;
}

export async function releaseTickLock(owner: string): Promise<void> {
  await asOperator((c) => c.query(`update engine_state set value = jsonb_build_object('owner', $1::text, 'until', 'epoch'::timestamptz), updated_at = now()
    where key='tick_lock' and value->>'owner' = $1`, [owner]));
}

export async function withTickLock<T>(fn: () => Promise<T>): Promise<{ busy: true } | { busy: false; result: T }> {
  const owner = await acquireTickLock();
  if (!owner) return { busy: true };
  try { return { busy: false, result: await fn() }; }
  finally { await releaseTickLock(owner).catch(() => {}); }
}
