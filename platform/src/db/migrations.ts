import type { Migrator } from "./migrator";
import { baseline } from "./baseline";

/**
 * D193 (audit risk 8): the schema's history, each step run once and recorded (`schema_migrations`), in order. A deploy with nothing
 * new runs none of them and takes no table lock. A new change is appended here with the next number and is never edited after it
 * has reached production; it runs through the migrator, so each statement gives way to the live engine (D151), and a group that must
 * not be left half done (a constraint dropped and added again) goes in `c.tx`, one table per group.
 */
export type Migration = { id: string; run: (c: Migrator) => Promise<void> };

export const MIGRATIONS: Migration[] = [
  { id: "0001-baseline", run: baseline },
  // D193.4: event types nothing emits; one an event or a trigger already names is kept
  { id: "0002-unemitted-event-types", run: async (c) => {
    await c.query(`delete from event_types t where t.name in ('contact.created','contact.merged','intake.recorded','stage.changed') and not exists (select 1 from events e where e.event_type=t.name) and not exists (select 1 from workflow_triggers w where w.event_type=t.name)`);
  } },
];
