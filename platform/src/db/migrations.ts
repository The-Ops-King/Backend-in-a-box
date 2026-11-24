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
  { id: "0008-appointment-pitched", run: async (c) => {
    // D226: whether the closer pitched them, from the end of day (null: the call did not happen, or nobody said)
    await c.query("alter table appointments add column if not exists pitched boolean");
  } },
  // D229, PMU's ledger, once (Tyler, 2026-10-23): the $250 Jennyfer Cantrell paid on 2026-10-22 was her deposit, bought on the main
  // product before a Deposit product existed, so the name rule could not tell; and the failed charges that matched nobody are not kept
  // ("non close failures is not important"). A database without PMU's rows (tests, an empty start) changes nothing.
  { id: "0009-pmu-ledger-fix", run: async (c) => asOperatorTx(c, async (t) => {
    const co = (await t.query<{ id: string }>("select id from companies where slug='pmu'")).rows[0];
    if (!co) return;
    const dep = await t.query("update payments set kind='deposit' where company_id=$1 and whop_payment_id='pay_nVLz7yWb9RcuFa' and link_status='linked' and status='succeeded' returning id", [co.id]);
    const gone = await t.query<{ whop_payment_id: string }>("delete from payments where company_id=$1 and status='failed' and link_status='unlinked' returning whop_payment_id", [co.id]);
    await t.query("insert into audit_log (company_id, action, target_type, target_id, after) values ($1,'payments.ledger_fix','company',$2,$3)",
      [co.id, co.id, { deposit: dep.rowCount, failed_unmatched_removed: gone.rows.map((r) => r.whop_payment_id) }]);
  }) },
  // D229, PMU once more: 0009 made Jennyfer Cantrell's $250 a deposit in the ledger, but her two payment events were written before it
  // and still read it as an installment (and her $9,750 as coming after $250 of non-deposit money). Payment recorded is about to run
  // for them for the first time (D232 replay), so they say what the ledger now says.
  { id: "0010-pmu-jennyfer-events", run: async (c) => asOperatorTx(c, async (t) => {
    const co = (await t.query<{ id: string }>("select id from companies where slug='pmu'")).rows[0];
    if (!co) return;
    const a = await t.query("update events set data = data || '{\"kind\":\"deposit\"}'::jsonb where company_id=$1 and event_type='payment.received' and data->>'provider_payment_id'='pay_nVLz7yWb9RcuFa' returning id", [co.id]);
    const b = await t.query("update events set data = data || '{\"prior_non_deposit_total\":0}'::jsonb where company_id=$1 and event_type='payment.received' and data->>'provider_payment_id'='pay_x8FSlakIYHNzDc' returning id", [co.id]);
    await t.query("insert into audit_log (company_id, action, target_type, target_id, after) values ($1,'events.ledger_fix','company',$2,$3)", [co.id, co.id, { deposit_event: a.rows.map((r) => r.id), balance_event: b.rows.map((r) => r.id) }]);
  }) },
  // D251: one shared Slack app installed in each workspace (an install link), next to the per-offer apps made by hand (D174). A
  // connection says which app it came through; the shared app's doors find the offer by its workspace, so one is looked up by team
  { id: "0011-slack-shared-app", run: async (c) => {
    await c.query("alter table slack_connections add column if not exists app text not null default 'own' check (app in ('own','shared'))");
    await c.query("create index if not exists slack_connections_team on slack_connections (team_id)");
  } },
  // D254: a call one closer hands another (Tyler: "if Jose wants to assign some of his calls to Minerva"). The booking keeps who has
  // it now, and since when, so the calendar's host never takes it back on a reschedule; a team member's own booking link for the
  // new closer's reschedule; the two events the doors and the workflows speak in
  { id: "0012-call-reassign", run: async (c) => {
    await c.query("alter table appointments add column if not exists reassigned_at timestamptz");
    await c.query("alter table appointments add column if not exists reassigned_by text");
    await c.query("alter table users add column if not exists booking_url text");
    await c.query("alter table recordings add column if not exists client_spoke boolean");   // null: no transcript said
    await c.query("insert into event_types values ('appointment.reassign_requested','appointment'), ('appointment.reassigned','appointment') on conflict do nothing");
  } },
  // D265: a call filed on the end of day the other way from the AI's read; the End of day disagrees with the AI workflow speaks it
  { id: "0013-eod-disagreement", run: async (c) => {
    await c.query("insert into event_types values ('eod.disagreement','report') on conflict do nothing");
  } },
  // D298: an offer paused (Tyler: "Hair is paused"): the engine runs nothing for it (no polls, schedules, runs, checks or alerts)
  { id: "0014-company-paused", run: async (c) => {
    await c.query("alter table companies drop constraint if exists companies_status_check");
    await c.query("alter table companies add constraint companies_status_check check (status in ('onboarding','active','hosted','archived','template','paused'))");
  } },
  // D322: where a deal's price came from (payment < eod < agreement_sent < agreement < operator): a weaker source never replaces a stronger one
  { id: "0015-deal-price-source", run: async (c) => {
    await c.query("alter table opportunities add column if not exists price_source text");
  } },
  // D342: a payment the processor accepted and has not collected (Whop's payment.pending), and the moment it cleared or failed
  { id: "0016-payment-pending", run: async (c) => {
    await c.query("insert into event_types values ('payment.pending','payment'), ('payment.pending_resolved','payment') on conflict do nothing");
  } },
  // D347: the price an agreement went out at, read from the contact once it was out; every agreement already held counts as read,
  // so only what is sent from now on is read and announced
  { id: "0017-agreement-price", run: async (c) => {
    await c.tx(async (t) => {
      await t.query("alter table agreements add column if not exists price numeric(12,2), add column if not exists price_read_at timestamptz");
      await t.query("update agreements set price_read_at = now() where price_read_at is null");
    });
  } },
  // D350: the CRM appointment the engine made for a booking from another source (Calendly), and what it last told the CRM
  { id: "0018-appointment-crm-copy", run: async (c) => {
    await c.query("alter table appointments add column if not exists crm_appointment_id text, add column if not exists crm_status text, add column if not exists crm_starts_at timestamptz");
  } },
  // D354: a person the operator enrolled in a workflow by hand (people already there when it was built: TRC's dial cadence)
  { id: "0019-operator-enrolled", run: async (c) => {
    await c.query("insert into event_types values ('operator.enrolled','crm') on conflict do nothing");
  } },
  // D358: a call that happened and whose booking then moved on (a closer setting the follow-up by moving it) is kept as its own row,
  // pointing at the booking it came from, so the end of day and the Sales Call for that slot still have it
  { id: "0020-held-call-kept", run: async (c) => {
    await c.tx(async (t) => {
      await t.query("alter table appointments add column if not exists held_from uuid references appointments(id)");
      await t.query("create index if not exists appointments_held_from_idx on appointments (held_from) where held_from is not null");
    });
    // D358: each closing call filed on the end of day, with what the closer answered (EOD: answers onto the Sales Call writes them)
    await c.query("insert into event_types values ('eod.call_answers','report') on conflict do nothing");
  } },
  // D358 data fix (Tyler, 2026-11-20), TRC only: the three calls Nick held and then moved before booking.keep_held_call existed get
  // their held rows, so the end of day carries them and their Sales Calls follow them: Razia's Nov 16 noon call (she closed; "she
  // closed on the 16th for half, then paid the rest the next day"), Pamela's Nov 17 call and Julie's Nov 19 call (recorded; left for
  // Nick to file: "leave them blank so they appear on the eod"). The bookings themselves lose the stale outcome a moved-away slot
  // gave them (D358's drift fix), except Razia's Nov 17 slot, which Nick filed as rescheduled. No-op where these bookings do not exist.
  { id: "0021-trc-held-calls", run: async (c) => {
    const held: Array<{ booking: string; slot: string; at: string; outcome: string | null; call: string | null; pitched: boolean | null; clear: boolean }> = [
      { booking: "1c4369a1-5cc4-49b6-94c5-88c05dc4539a", slot: "pkeC7HVL2O7tMd7s434b@2026-11-16T20:00:00.000Z", at: "2026-11-16T20:00:00.000Z", outcome: "showed", call: "closed", pitched: true, clear: false },
      { booking: "0d800df3-11c1-4171-8658-5c5ddf22b80d", slot: "FaKyg2ziENmzdPTuLeRY", at: "2026-11-17T20:00:00.000Z", outcome: null, call: null, pitched: null, clear: true },
      { booking: "d690e94e-7fe9-4674-9b32-7dc1e425b932", slot: "zKxulGK7HFJ8AF6lQuUn", at: "2026-11-19T22:00:00.000Z", outcome: "showed", call: null, pitched: null, clear: true },
    ];
    await c.tx(async (t) => {
      for (const h of held) {
        const b = (await t.query("select id, company_id, external_id from appointments where id=$1", [h.booking])).rows[0] as { id: string; company_id: string; external_id: string } | undefined;
        if (!b) continue;
        if ((await t.query("select 1 from appointments where held_from=$1 and slot_key=$2", [h.booking, h.slot])).rows.length) continue;
        const term = async (domain: string, cat: string | null) => cat ? ((await t.query("select id from company_terms where company_id=$1 and domain=$2 and category=$3 and active order by is_default desc, sort limit 1", [b.company_id, domain, cat])).rows[0] as { id: string } | undefined)?.id ?? null : null;
        const row = (await t.query(`insert into appointments (company_id, contact_id, opportunity_id, source, external_id, calendar_id, appointment_term, assigned_user_id, starts_at, ends_at, self_booked, set_by, answers, tracking,
            slot_key, meeting_key, meeting_url, booked_at, status, source_updated_at, outcome_term, call_outcome_term, dispositioned_at, pitched, held_from)
          select company_id, contact_id, opportunity_id, source, external_id || '#held@' || $3, calendar_id, appointment_term, assigned_user_id, $3::timestamptz, $3::timestamptz + interval '1 hour', self_booked, set_by, answers, tracking,
            $2, meeting_key, meeting_url, booked_at, 'confirmed', source_updated_at, $4, $5, case when $4::uuid is null then null else now() end, $6, id
          from appointments where id=$1 returning id`, [h.booking, h.slot, h.at, await term("appointment_outcome", h.outcome), await term("call_outcome", h.call), h.pitched])).rows[0] as { id: string };
        await t.query("update recordings set appointment_id=$2 where appointment_id=$1 and abs(extract(epoch from started_at - $3::timestamptz)) <= 5400", [h.booking, row.id, h.at]);
        if (h.call) await t.query("update appointments set call_outcome_term=null where id=$1", [h.booking]);
        if (h.clear) await t.query("update appointments set outcome_term=null, call_outcome_term=null, dispositioned_at=null, pitched=null where id=$1", [h.booking]);
        await t.query("insert into audit_log (company_id, action, target_type, target_id, after) values ($1,'appointment.held_kept','appointment',$2,$3)", [b.company_id, row.id, { held_from: h.booking, slot: h.slot, at: h.at, outcome: h.outcome, call_outcome: h.call, by: "migration 0021", why: "Tyler 2026-11-20: Nick's calls held and then moved before D358" }]);
      }
    });
  } },
  // D358 data fix, TRC only: Daneza Socarras's Nov 23 booking was given "rescheduled" at 15:01 UTC on 2026-11-20 by ledger drift from the
  // Sales Call of the Nov 20 slot it moved away from, just before D358's drift fix went out; her Nov 23 call would have read as filed and
  // never come to Nick's end of day. Cleared only while it is still the outcome that repair set (nobody has filed it since).
  { id: "0022-trc-stale-rescheduled", run: async (c) => {
    await c.tx(async (t) => {
      const a = (await t.query(`select a.id, a.company_id from appointments a join company_terms ot on ot.id=a.outcome_term
        where a.id='43b46256-665b-45a8-81fc-64149a99b641' and ot.category='rescheduled' and a.disposition_id is null and a.dispositioned_at is null`)).rows[0] as { id: string; company_id: string } | undefined;
      if (!a) return;
      await t.query("update appointments set outcome_term=null where id=$1", [a.id]);
      await t.query("insert into audit_log (company_id, action, target_type, target_id, before, after) values ($1,'appointment.outcome_cleared','appointment',$2,$3,$4)", [a.company_id, a.id, { outcome: "rescheduled", by: "ledger drift (ghl_outcome) from the Nov 20 slot's Sales Call" }, { outcome: null, by: "migration 0022", why: "a moved-away slot's outcome is not the booking's (D358)" }]);
    });
  } },
  // D358 data fix, TRC only (Tyler, 2026-11-20: "yes that's correct"): Razia Sultana's first call, Nov 13 at 10 AM Pacific, held on
  // Zoom before the engine wrote Sales Calls, is kept as its own row of her booking: showed, a follow-up (she closed on the Nov 16
  // follow-up), pitched. Its next step and date are Nick's to give on the end of day. Once, by booking id; a no-op elsewhere.
  { id: "0023-trc-razia-first-call", run: async (c) => {
    const booking = "1c4369a1-5cc4-49b6-94c5-88c05dc4539a", slot = "pkeC7HVL2O7tMd7s434b@2026-11-13T18:00:00.000Z", at = "2026-11-13T18:00:00.000Z";
    await c.tx(async (t) => {
      const b = (await t.query("select id, company_id from appointments where id=$1", [booking])).rows[0] as { id: string; company_id: string } | undefined;
      if (!b || (await t.query("select 1 from appointments where held_from=$1 and slot_key=$2", [booking, slot])).rows.length) return;
      const term = async (domain: string, cat: string) => ((await t.query("select id from company_terms where company_id=$1 and domain=$2 and category=$3 and active order by is_default desc, sort limit 1", [b.company_id, domain, cat])).rows[0] as { id: string } | undefined)?.id ?? null;
      const row = (await t.query(`insert into appointments (company_id, contact_id, opportunity_id, source, external_id, calendar_id, appointment_term, assigned_user_id, starts_at, ends_at, self_booked, set_by, answers, tracking,
          slot_key, meeting_key, meeting_url, booked_at, status, source_updated_at, outcome_term, call_outcome_term, dispositioned_at, pitched, held_from)
        select company_id, contact_id, opportunity_id, source, external_id || '#held@' || $3, calendar_id, appointment_term, assigned_user_id, $3::timestamptz, $3::timestamptz + interval '1 hour', self_booked, set_by, answers, tracking,
          $2, meeting_key, meeting_url, booked_at, 'confirmed', source_updated_at, $4, $5, now(), true, id
        from appointments where id=$1 returning id`, [booking, slot, at, await term("appointment_outcome", "showed"), await term("call_outcome", "follow_up")])).rows[0] as { id: string };
      await t.query("insert into audit_log (company_id, action, target_type, target_id, after) values ($1,'appointment.held_kept','appointment',$2,$3)", [b.company_id, row.id, { held_from: booking, slot, at, outcome: "showed", call_outcome: "follow_up", pitched: true, by: "migration 0023", why: "Tyler 2026-11-20: Razia's first call (Nov 13), before Sales Calls existed; she closed on the Nov 16 follow-up" }]);
    });
  } },
  // D358 data fix, TRC only: Liz Puga's Nov 19 11 AM slot, left when her booking moved to Nov 21 a day after it (nothing recorded, so
  // not seen as held before this change); kept as its own blank row so Nick files what happened. Once, by booking id; a no-op elsewhere.
  { id: "0024-trc-liz-nov19", run: async (c) => {
    const booking = "d36ff3b5-c3ef-468f-b3c7-6dfb7a2aa40d", slot = "H17kdNZcYJFV7HJiQjgp", at = "2026-11-19T19:00:00.000Z";
    await c.tx(async (t) => {
      const b = (await t.query("select id, company_id from appointments where id=$1", [booking])).rows[0] as { id: string; company_id: string } | undefined;
      if (!b || (await t.query("select 1 from appointments where held_from=$1 and slot_key=$2", [booking, slot])).rows.length) return;
      const row = (await t.query(`insert into appointments (company_id, contact_id, opportunity_id, source, external_id, calendar_id, appointment_term, assigned_user_id, starts_at, ends_at, self_booked, set_by, answers, tracking,
          slot_key, meeting_key, meeting_url, booked_at, status, source_updated_at, held_from)
        select company_id, contact_id, opportunity_id, source, external_id || '#held@' || $3, calendar_id, appointment_term, assigned_user_id, $3::timestamptz, $3::timestamptz + interval '1 hour', self_booked, set_by, answers, tracking,
          $2, meeting_key, meeting_url, booked_at, 'confirmed', source_updated_at, id
        from appointments where id=$1 returning id`, [booking, slot, at])).rows[0] as { id: string };
      await t.query("insert into audit_log (company_id, action, target_type, target_id, after) values ($1,'appointment.held_kept','appointment',$2,$3)", [b.company_id, row.id, { held_from: booking, slot, at, by: "migration 0024", why: "a slot left after its time is kept for the end of day (D358)" }]);
    });
  } },
  // D358 data fix, TRC only: the last two slots left after their time before the keep rule shipped (2026-11-20): Christy Ensley's 9 AM
  // (moved at 9:10) and Anthony Monreal's 11 AM (moved at 11:09), each kept as its own blank row for Nick to file. Once, by booking id.
  { id: "0025-trc-kept-nov20", run: async (c) => {
    const kept = [
      { booking: "91a9fdda-1398-40f5-832f-af10f5722df6", slot: "gOvOCVmV9mEHY7v4LgHh@2026-11-20T17:00:00.000Z", at: "2026-11-20T17:00:00.000Z" },
      { booking: "5cd05bac-751f-4997-b2b9-15f7455ff7cc", slot: "KrrmHjIitpImvwOwsMmY", at: "2026-11-20T19:00:00.000Z" },
    ];
    await c.tx(async (t) => {
      for (const k of kept) {
        const b = (await t.query("select id, company_id from appointments where id=$1", [k.booking])).rows[0] as { id: string; company_id: string } | undefined;
        if (!b || (await t.query("select 1 from appointments where held_from=$1 and slot_key=$2", [k.booking, k.slot])).rows.length) continue;
        const row = (await t.query(`insert into appointments (company_id, contact_id, opportunity_id, source, external_id, calendar_id, appointment_term, assigned_user_id, starts_at, ends_at, self_booked, set_by, answers, tracking,
            slot_key, meeting_key, meeting_url, booked_at, status, source_updated_at, held_from)
          select company_id, contact_id, opportunity_id, source, external_id || '#held@' || $3, calendar_id, appointment_term, assigned_user_id, $3::timestamptz, $3::timestamptz + interval '1 hour', self_booked, set_by, answers, tracking,
            $2, meeting_key, meeting_url, booked_at, 'confirmed', source_updated_at, id
          from appointments where id=$1 returning id`, [k.booking, k.slot, k.at])).rows[0] as { id: string };
        await t.query("insert into audit_log (company_id, action, target_type, target_id, after) values ($1,'appointment.held_kept','appointment',$2,$3)", [b.company_id, row.id, { held_from: k.booking, slot: k.slot, at: k.at, by: "migration 0025", why: "a slot left after its time is kept for the end of day (D358)" }]);
      }
    });
  } },
  // D365: every join and leave of an offer's Zoom meetings (its Webhook-only app), kept once, and the verdict event a meeting's end
  // fires for the booking it was for (held / no_show / unclear), so a missing recording is never taken for a no-show on its own
  { id: "0026-zoom-attendance", run: async (c) => {
    await c.query(`create table if not exists zoom_events (
      id bigserial primary key,
      company_id uuid not null references companies(id),
      meeting_id text not null,
      instance_uuid text not null,
      kind text not null check (kind in ('joined','left','ended')),
      participant_key text not null default '',
      email text, name text,
      at timestamptz not null,
      topic text, meeting_start timestamptz,
      received_at timestamptz not null default now(),
      unique (company_id, instance_uuid, kind, participant_key, at))`);
    await c.query("create index if not exists zoom_events_meeting_idx on zoom_events (company_id, meeting_id, at)");
    await c.query("insert into event_types values ('zoom.meeting_ended','call') on conflict do nothing");
  } },
];
