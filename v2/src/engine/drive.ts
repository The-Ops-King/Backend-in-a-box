import type { Engine } from "./engine";
import type { Store } from "./store";
import type { FakeClock } from "./testkit";

/** The next time anything is due after now: a waiting run's wake, a queued outbox row's next attempt. */
export async function nextDue(store: Store, now: Date): Promise<Date | undefined> {
  return store.tx(async (tx) => {
    const times = [
      ...(await tx.runs({ statuses: ["waiting"] })).map((r) => r.nextWakeAt),
      ...(await tx.outboxRows({ statuses: ["queued"] })).map((r) => r.nextAttemptAt),
    ].filter((t): t is Date => !!t && t.getTime() > now.getTime());
    return times.length ? new Date(Math.min(...times.map((t) => t.getTime()))) : undefined;
  });
}

/**
 * Moves the fake clock to `until`, stopping at every moment something is due on the way and doing it then, so every
 * wait wakes at its own minute.
 */
export async function advanceTo(engine: Engine, store: Store, clock: FakeClock, until: Date): Promise<void> {
  await engine.runDue();
  for (let i = 0; i < 10_000; i++) {
    const next = await nextDue(store, clock.now());
    if (!next || next.getTime() > until.getTime()) break;
    clock.set(next);
    await engine.runDue();
  }
  if (until.getTime() > clock.now().getTime()) clock.set(until);
  await engine.runDue();
}

/** Whether any run is still in flight (active, waiting, paused). */
export const inFlight = (store: Store) => store.tx(async (tx) => (await tx.runs({ statuses: ["active", "waiting", "paused"] })).length);
