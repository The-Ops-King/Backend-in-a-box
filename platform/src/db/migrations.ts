import type { Migrator } from "./migrator";
import { baseline } from "./baseline";
import { LEGACY_OBJECTIONS, writeDefaults } from "@/engine/setting-defaults";

/**
 * D200 (audit risk 8): the schema's history, each step run once and recorded (`schema_migrations`), in order. A deploy with nothing
 * new runs none of them and takes no table lock. A new change is appended here with the next number and is never edited after it
 * has reached production; it runs through the migrator, so each statement gives way to the live engine (D151), and a group that must
 * not be left half done (a constraint dropped and added again) goes in `c.tx`, one table per group.
 */
export type Migration = { id: string; run: (c: Migrator) => Promise<void> };
/** Tenant tables are under FORCE row-level security: a migration that reads or writes their rows does it as the operator, in one transaction. */
const asOperatorTx = (c: Migrator, fn: (c: Migrator) => Promise<void>) => c.tx(async (t) => { await t.query("select set_config('app.role', 'operator', true)"); await fn(t); });

export const MIGRATIONS: Migration[] = [
  { id: "0001-baseline", run: baseline },
  // D200.4: event types nothing emits; one an event or a trigger already names is kept
  { id: "0002-unemitted-event-types", run: async (c) => {
    await c.query(`delete from event_types t where t.name in ('contact.created','contact.merged','intake.recorded','stage.changed') and not exists (select 1 from events e where e.event_type=t.name) and not exists (select 1 from workflow_triggers w where w.event_type=t.name)`);
  } },
  // D200.12: MQL reads the offer's own qualifying question (qualify.field, worded as qualify.question), not a field named for Hair's
  // work-situation question. An offer that had that field keeps it as its qualifying question, word for word; others still have none.
  { id: "0003-qualify-field", run: (c) => asOperatorTx(c, async (t) => {
    const made = await t.query<{ company_id: string }>(`insert into bindings (company_id, key, kind, value) select company_id, 'qualify.field', 'id', value from bindings where key='crm.field_contact_work_situation' on conflict (company_id, key) do nothing returning company_id`);
    for (const r of made.rows) {
      await t.query("insert into bindings (company_id, key, kind, value) values ($1, 'qualify.question', 'text', convert_to($2, 'UTF8')) on conflict (company_id, key) do nothing", [r.company_id, "What best describes your current work situation?"]);
      await t.query("insert into audit_log (company_id, action, target_type, after) values ($1, 'binding.set', 'binding', $2)", [r.company_id, { keys: ["qualify.field", "qualify.question"], by: "migration 0003", from: "crm.field_contact_work_situation" }]);
    }
  }) },
  // D200.13 (open item 50 part 2; Tyler: yes, all three offers): each offer gets, as its own, every setting it was running on the
  // engine's fallback for, at exactly that value; a later change to a fallback then reaches only new offers.
  { id: "0004-settings-onto-offers", run: (c) => asOperatorTx(c, async (t) => {
    for (const co of (await t.query<{ id: string }>("select id from companies")).rows) {
      // the objections are the one setting whose fallback changed with it (Hair's list before, a neutral one for new offers)
      const keys = await writeDefaults(t, co.id, { "sales_call.objections": JSON.stringify(LEGACY_OBJECTIONS) });
      if (keys.length) await t.query("insert into audit_log (company_id, action, target_type, after) values ($1, 'binding.set', 'binding', $2)", [co.id, { keys, by: "migration 0004", why: "the offer's own copy of what it ran on" }]);
    }
  }) },
];
