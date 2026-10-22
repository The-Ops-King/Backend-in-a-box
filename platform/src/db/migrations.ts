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
  // D202: the offers waiting on a signature (a payment in the last `window_min` minutes from someone with nothing signed, or an
  // agreement sent in them and not signed), for the ten-second documents job; it reads tenant tables, so it runs as the operator
  { id: "0005-documents-waiting", run: async (c) => {
    // the operator role is taken at run time (set_config, as the app does): a function-level SET of app.role needs a superuser
    await c.query(`create or replace function bb_documents_waiting(window_min int default 15) returns table (company_id uuid)
      language plpgsql as $fn$
      begin
        perform set_config('app.role', 'operator', true);
        return query select co.id from companies co
        where (co.status in ('active','hosted') or (co.status='template' and exists (select 1 from bindings sb where sb.company_id=co.id and sb.key='sandbox.running')))
          and (exists (select 1 from agreements a where a.company_id=co.id and a.signed_at is null and a.sent_at > now() - make_interval(mins => window_min))
            or exists (select 1 from payments p where p.company_id=co.id and p.status='succeeded' and p.contact_id is not null and p.paid_at > now() - make_interval(mins => window_min)
              and not exists (select 1 from agreements g where g.company_id=co.id and g.contact_id=p.contact_id and g.signed_at is not null)));
      end $fn$`);
    // D202: a closer's /agreement in Slack asks for an agreement to be sent; the Send agreement workflow sends it
    await c.query(`insert into event_types values ('agreement.requested','agreement') on conflict do nothing`);
  } },
  { id: "0006-documents-waiting-30", run: async (c) => {
    // Tyler (2026-10-21): the ten-second check runs for 30 minutes after an agreement goes out or a payment comes in, not 15
    await c.query(`create or replace function bb_documents_waiting(window_min int default 30) returns table (company_id uuid)
      language plpgsql as $fn$
      begin
        perform set_config('app.role', 'operator', true);
        return query select co.id from companies co
        where (co.status in ('active','hosted') or (co.status='template' and exists (select 1 from bindings sb where sb.company_id=co.id and sb.key='sandbox.running')))
          and (exists (select 1 from agreements a where a.company_id=co.id and a.signed_at is null and a.sent_at > now() - make_interval(mins => window_min))
            or exists (select 1 from payments p where p.company_id=co.id and p.status='succeeded' and p.contact_id is not null and p.paid_at > now() - make_interval(mins => window_min)
              and not exists (select 1 from agreements g where g.company_id=co.id and g.contact_id=p.contact_id and g.signed_at is not null)));
      end $fn$`);
  } },
  // D221: when a workflow was last switched on, stamped by the database whichever path switched it (the admin door, the dashboard,
  // install), so the clock does not fire a fixed-time slot that had already passed before the workflow was on
  { id: "0007-workflow-enabled-at", run: async (c) => {
    await c.query("alter table workflows add column if not exists enabled_at timestamptz");
    await c.query(`create or replace function bb_workflow_enabled_at() returns trigger language plpgsql as $fn$
      begin
        if new.enabled and (tg_op = 'INSERT' or not old.enabled) then new.enabled_at := now(); end if;
        return new;
      end $fn$`);
    await c.query("drop trigger if exists workflows_enabled_at on workflows");
    await c.query("create trigger workflows_enabled_at before insert or update of enabled on workflows for each row execute function bb_workflow_enabled_at()");
  } },
];
