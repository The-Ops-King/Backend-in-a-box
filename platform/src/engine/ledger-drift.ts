import type { PoolClient } from "pg";
import { DateTime } from "luxon";
import { many, one } from "@/db/client";
import type { Adapters, Company, ContactSnapshot } from "@/adapters/types";
import type { GhlReads } from "@/adapters/ghl/metrics";
import type { CompanyRow } from "./context";
import type { Finding } from "./health";
import { effectiveMode, handlerMode, isTestContact, testContactSql, testDomains } from "./mode";
import { paymentRecords, salesCallConfig, salesCallsFor, type Payment, type SalesCall } from "./ghl-metrics";
import { carriesTag, scopeTag } from "./scope";

/**
 * D73. "Always GHL. It's the truth. If the two are different, that's an issue." And: "the engine is only the mirror of the
 * truth and it needs to stay updated with reality; if there are inconsistencies it needs updated, and the health check
 * should do that." Over the last week (minus the half hour the poll has not reached yet) the sweep compares GHL with the
 * ledger and repairs what it can:
 * - a contact GHL added that the ledger lacks is pulled in with the contacts poll's own upsert, and a record new to the
 *   engine fires lead.created once, as the poll would have;
 * - a ledger contact GHL confirms is gone is stamped gone (asked first, D69);
 * - a Sales Call the booking source cancelled before its start is set to cancelled in the ledger, and in GHL by the Ledger
 *   drift workflow (D88: `drift.sales_call_cancelled`, once ever per record, under the mode rules, D52);
 * - a Sales Call missing its link to its contact or closer card is linked by the same workflow (`drift.sales_call_unlinked`);
 * - otherwise a filed Sales Call outcome wins over the ledger's.
 * Every repair is in the audit log and the sweep's result, and each kind of finding is one `drift.found` event a sweep
 * (`kind`, `items`). What it cannot repair is one alert, its questions as lists by kind in the alert's detail; the Health check
 * workflow words them (D88). A read that did not happen decides nothing: whatever was open stays open.
 */
/** The defaults of the health_check step's drift settings (D88): `drift_days` looked back over, `poll_lag_min` the poll has not reached. */
export const DRIFT_DAYS = 7;
export const POLL_LAG_MIN = 30;
const NAMES = 10;

/** D69: ask the CRM before saying a record is gone. A "not found" in any shape is gone; anything else that fails is unknown. */
export async function crmPresence(get: (id: string) => Promise<ContactSnapshot | null>, ghlId: string): Promise<"present" | "gone" | "unknown"> {
  try { return (await get(ghlId)) ? "present" : "gone"; }
  catch (e) { return /\bcontact (with id \S+ )?not found\b/i.test(String((e as Error).message)) ? "gone" : "unknown"; }
}

/** The categories' words, for the repair log and the questions' data (the questions themselves are worded by the workflow). */
const WORDS: Record<string, string> = { showed: "showed", noshow: "no-show", cancelled: "cancelled", rescheduled: "rescheduled" };
const RESULT_WORDS: Record<string, string> = { closed: "closed", deposit: "deposit", pending: "close pending", follow_up: "follow up", lost: "lost", unqualified: "DQ", qualified: "qualified" };
const snapName = (k: ContactSnapshot) => `${k.firstName ?? ""} ${k.lastName ?? ""}`.trim() || k.email || k.phone || k.id;
const why = (e: unknown) => String((e as Error).message).slice(0, 160);
/** "German Arellano, Mon Oct 5 at 10:00 AM": the record's own label carries the time after a dot; the person is what comes first. */
const callLabel = (k: SalesCall) => `${k.name.split(" · ")[0].trim() || k.name}, ${k.at.toFormat("ccc LLL d")}${k.at.hour || k.at.minute ? ` at ${k.at.toFormat("h:mm a")}` : ""}`;

/** `runId`: the health step's run, which the effects ledger records CRM writes against; without one, no CRM write is made. */
export async function ledgerDrift(c: PoolClient, company: CompanyRow, ac: Company, bindings: Record<string, string>, reads: GhlReads, _adapters: Adapters, _runId: string | undefined, now: DateTime = DateTime.now(), opts: { days?: number; pollLagMin?: number } = {}): Promise<Finding[]> {
  const check = "ledger_drift", days = opts.days ?? DRIFT_DAYS;
  const from = now.minus({ days }).toJSDate(), to = now.minus({ minutes: opts.pollLagMin ?? POLL_LAG_MIN }).toJSDate();
  const { emitEvent, dispatchEvent } = await import("./dispatch");
  const carry = async (reason: string): Promise<Finding[]> => {
    const open = await one<{ text: string; level: "error" | "warning"; detail: Record<string, unknown> }>(c, "select text, level, detail from alerts where company_id=$1 and key='health:ledger_drift' and resolved_at is null", [company.id]);
    return open ? [{ check, ok: false, level: open.level, text: open.text, detail: open.detail }] : [{ check, ok: true, level: "warning", text: `GHL could not be read to compare with the ledger (${reason}); compared again next sweep.` }];
  };
  const cfg = salesCallConfig(bindings);
  let ghl: ContactSnapshot[], calls: SalesCall[] = [];
  try {
    ghl = (await reads.contactsAdded(ac, from, to)).filter((k) => { const t = Date.parse(k.dateAdded); return t >= from.getTime() && t <= to.getTime(); });
    if (cfg && Object.keys(cfg.outcomes).length) calls = await salesCallsFor({ c, companyId: company.id, ac, bindings, reads, tz: company.timezone, start: from, end: now.toJSDate(), now: now.toJSDate(), domains: testDomains(bindings) });
  } catch (e) { return carry(why(e)); }

  const out: Finding[] = [];
  // D88: what the sweep cannot settle is a question, kept as data (kind + the facts); the Health check workflow words it
  const left: Record<string, unknown>[] = [];
  const found = new Map<string, Record<string, unknown>[]>();   // every finding by kind, for the drift.found events
  const note = (kind: string, item: Record<string, unknown>) => found.set(kind, [...(found.get(kind) ?? []), item]);
  const audit = (target: string, id: string, before: unknown, after: Record<string, unknown>) =>
    c.query("insert into audit_log (company_id, action, target_type, target_id, before, after) values ($1,'health.repaired',$2,$3,$4,$5)", [company.id, target, id, before === null ? null : JSON.stringify(before), JSON.stringify(after)]);
  const fixedPeople = new Set<string>();
  const repaired = (item: string, text: string, detail: Record<string, unknown>, who?: string, kind = "repaired") => { fixedPeople.add(who ?? item); out.push({ check, item: `repair:${item}`, ok: true, level: "warning", text: `Repaired: ${text}.`, detail }); note(kind, detail); };
  const ask = (kind: string, data: Record<string, unknown>) => { left.push({ kind, ...data }); note(kind, data); };
  /** A write the Ledger drift workflow is already making for this record (a run still going) is not asked for again. */
  const inFlight = async (type: string, recordId: string) => !!(await one(c, `select 1 from runs r join events e on e.id=r.triggered_by_event where r.company_id=$1 and e.event_type=$2 and e.data->>'record_id'=$3 and r.status in ('active','waiting','paused') limit 1`, [company.id, type, recordId]));
  /** One write for the Ledger drift workflow, about the person and their booking; false when no workflow took it. */
  const handOn = async (type: string, k: SalesCall, data: Record<string, unknown>) => {
    const ev = await emitEvent(c, { company_id: company.id, contact_id: k.appt!.contact_id, opportunity_id: null, appointment_id: k.appt!.id, event_type: type, source: "engine", data: { record_id: k.id, label: callLabel(k), ...data } });
    return (await dispatchEvent(c, ev, { contact: { id: k.appt!.contact_id }, appointment: { id: k.appt!.id } })).length > 0;
  };
  // one repair failing in the database must not undo the others
  const guarded = async (f: () => Promise<void>, onError: (e: unknown) => void) => {
    await c.query("savepoint drift_repair");
    try { await f(); await c.query("release savepoint drift_repair"); } catch (e) { await c.query("rollback to savepoint drift_repair"); onError(e); }
  };

  // 1. contacts GHL added that the ledger does not hold: pulled in as the poll would. D117: with a scope tag, only those carrying
  // it (a booker comes in with their booking); the location's other people are no drift. Presence (2) still reads every one
  const tag = scopeTag(bindings), mine = tag ? ghl.filter((k) => carriesTag(k.tags, tag)) : ghl;
  const known = new Set((await many<{ id: string }>(c, `select x.id from unnest($2::text[]) as x(id) where exists (select 1 from contacts ct where ct.company_id=$1 and ct.ghl_contact_id=x.id)
    or exists (select 1 from contact_identifiers i where i.company_id=$1 and i.kind='ghl_contact' and i.value=x.id)`, [company.id, mine.map((k) => k.id)])).map((r) => r.id));
  const missing = mine.filter((k) => !known.has(k.id));
  if (missing.length) {
    const { upsertContact, boundFieldIds, newLeadOnUpsert } = await import("./poll");
    for (const s of missing) await guarded(async () => {
      const up = await upsertContact(c, company.id, company.timezone, s, boundFieldIds(bindings));
      // the record is new to the engine here, so the sweep is what makes it a lead: the poll will now see it as known and fire nothing.
      // how late it is goes with the event: the lead workflows decide what a late lead gets (Speed to lead skips the first text and tells the team)
      const minutesLate = Math.max(0, Math.round((now.toMillis() - Date.parse(s.dateAdded)) / 60_000));
      const lead = await newLeadOnUpsert(c, company.id, up);
      if (lead) await dispatchEvent(c, await emitEvent(c, { company_id: company.id, contact_id: up.id, opportunity_id: null, appointment_id: null, event_type: "lead.created", source: "ghl_poll", data: { ghl_contact_id: s.id, by: "health", minutes_late: minutesLate } }), { contact: { id: up.id, ghl_contact_id: s.id, tags: s.tags } });
      await audit("contact", up.id, null, { repair: "pulled_in", ghl_contact_id: s.id, lead_created: lead, minutes_late: minutesLate });
      repaired(s.id, `${snapName(s)} was in GHL but not the ledger; pulled in${lead ? " (New lead fired once)" : ""}`, { ghl_contact_id: s.id, contact_id: up.id, name: snapName(s), lead_created: lead }, s.id, "pulled_in");
    }, (e) => ask("missing", { name: snapName(s), why: why(e), ghl_contact_id: s.id }));
  }

  // 2. ledger contacts of those days GHL no longer has: GHL is asked about each; only its own "gone" counts
  const inGhl = new Set(ghl.map((k) => k.id));
  const ours = await many<{ id: string; ghl_contact_id: string; name: string | null; ids: string[] }>(c, `select ct.id, ct.ghl_contact_id, nullif(trim(coalesce(ct.first_name,'')||' '||coalesce(ct.last_name,'')),'') as name,
      array(select value from contact_identifiers i where i.contact_id=ct.id and i.kind='ghl_contact') as ids
    from contacts ct where ct.company_id=$1 and ct.merged_into is null and ct.gone_at is null and ct.ghl_contact_id is not null and ct.ghl_added_at >= $2 and ct.ghl_added_at <= $3`, [company.id, from, to]);
  for (const o of ours) {
    if (inGhl.has(o.ghl_contact_id) || o.ids.some((i) => inGhl.has(i))) continue;
    if ((await crmPresence((id) => reads.getContact(ac, id), o.ghl_contact_id)) !== "gone") continue;
    await c.query("update contacts set gone_at=now(), updated_at=now() where id=$1 and gone_at is null", [o.id]);
    await audit("contact", o.id, { gone_at: null }, { repair: "marked_gone", ghl_contact_id: o.ghl_contact_id });
    repaired(o.ghl_contact_id, `${o.name ?? o.ghl_contact_id} is gone from GHL; marked gone in the ledger`, { contact_id: o.id, ghl_contact_id: o.ghl_contact_id, name: o.name ?? o.ghl_contact_id }, o.ghl_contact_id, "marked_gone");
  }

  // 3. Sales Calls against the bookings they match
  const termOf = async (cat: string) => (await one<{ id: string }>(c, "select id from company_terms where company_id=$1 and domain='appointment_outcome' and category=$2 order by is_default desc limit 1", [company.id, cat]))?.id ?? null;
  const setLedgerOutcome = async (k: SalesCall, cat: string, reason: string) => {
    const term = await termOf(cat);
    if (!term) { ask("setup", { label: callLabel(k), said: WORDS[cat] ?? cat, term: cat, record_id: k.id }); return; }
    await c.query("update appointments set outcome_term=$2 where id=$1", [k.appt!.id, term]);
    await audit("appointment", k.appt!.id, { outcome: k.appt!.outcome }, { repair: reason, outcome: cat, sales_call: k.id });
    repaired(`${k.id}:ledger`, `${callLabel(k)}: the ledger said ${WORDS[k.appt!.outcome ?? ""] ?? "nothing"}, now ${WORDS[cat]} as ${reason === "booking_cancelled" ? `${k.booking_source} cancelled it before the call` : "GHL says"}`, { appointment_id: k.appt!.id, sales_call: k.id, label: callLabel(k), from: k.appt!.outcome, outcome: cat, reason }, k.ghl || k.id, "attendance_changed");
  };
  // D83: GHL's outcome (the record's disposition) is copied the same way: a call that showed takes it; a call GHL says did
  // not happen (no-show, cancelled, rescheduled) has none. Nothing fires: the ledger only follows GHL
  const followResult = async (k: SalesCall, attended: string | null = k.filed) => {
    const label = callLabel(k), a = k.appt!;
    const held = await one<{ cat: string | null; name: string | null }>(c, "select t.category as cat, t.name from appointments a left join company_terms t on t.id=a.call_outcome_term where a.id=$1", [a.id]);
    const cur = held?.cat ?? null;
    if (attended && attended !== "showed") {
      if (!cur) return;
      await c.query("update appointments set call_outcome_term=null where id=$1", [a.id]);
      await audit("appointment", a.id, { call_outcome: cur }, { repair: "ghl_outcome", call_outcome: null, sales_call: k.id });
      repaired(`${k.id}:result`, `${label}: the ledger had ${RESULT_WORDS[cur] ?? cur}, but it was ${WORDS[attended]}; outcome cleared`, { appointment_id: a.id, sales_call: k.id, label, from: cur, call_outcome: null }, k.ghl || k.id, "outcome_changed");
      return;
    }
    if (!k.disposition.trim()) return;
    const mapped = cfg!.dispositions[k.disposition.trim().toLowerCase()];
    let meaning = mapped?.meaning;
    if (!mapped || !meaning) { ask("disposition_unmapped", { label, disposition: k.disposition, record_id: k.id }); return; }
    // pending is half a close and nothing else: paid or signed, not both (both is a close; neither is still a follow up)
    if (meaning === "pending") {
      const ev = await one<{ paid: boolean; signed: boolean }>(c, `select exists (select 1 from payments p where p.company_id=$1 and p.contact_id=$2 and p.status='succeeded') as paid,
          exists (select 1 from agreements g where g.company_id=$1 and g.contact_id=$2 and g.signed_at is not null) as signed`, [company.id, a.contact_id]);
      meaning = ev?.paid && ev.signed ? "closed" : ev?.paid || ev?.signed ? "pending" : "follow_up";
    }
    // before D119 the engine filed a deposit as closed won; a company that has not declared a deposit option of its own
    // (sales_call.dispositions) may hold that record so, and it says what GHL says
    const noDepositOption = !bindings["sales_call.dispositions"] || !Object.values(cfg!.dispositions).some((d) => d.meaning === "deposit");
    if ((cur === meaning && (!mapped.reason || held?.name === mapped.reason)) || (cur === "deposit" && meaning === "closed" && noDepositOption)) return;
    // the reason's own term when the company has it (Lost: Financing denied), else the meaning's default
    const term = (await one<{ id: string }>(c, "select id from company_terms where company_id=$1 and domain='call_outcome' and category=$2 and active order by (name = $3) desc, is_default desc, sort limit 1", [company.id, meaning, mapped.reason ?? ""]))?.id;
    if (!term) { ask("setup", { label, said: RESULT_WORDS[meaning] ?? meaning, term: meaning, record_id: k.id }); return; }
    await c.query("update appointments set call_outcome_term=$2 where id=$1", [a.id, term]);
    await audit("appointment", a.id, { call_outcome: cur }, { repair: "ghl_outcome", call_outcome: meaning, ...(mapped.reason ? { reason: mapped.reason } : {}), sales_call: k.id });
    repaired(`${k.id}:result`, `${label}: the ledger said ${cur ? RESULT_WORDS[cur] ?? cur : "no outcome"}, now ${RESULT_WORDS[meaning]}${mapped.reason ? ` (${mapped.reason})` : ""} as GHL says`, { appointment_id: a.id, sales_call: k.id, label, from: cur, call_outcome: meaning, ...(mapped.reason ? { reason: mapped.reason } : {}) }, k.ghl || k.id, "outcome_changed");
  };
  // D76: every Sales Call is linked to its contact and the closer card (fields and associations); when the one right card and contact
  // are certain, the Ledger drift workflow links it (D88: `drift.sales_call_unlinked`, crm_record by the record's id), else it is a question
  const linkRecord = async (k: SalesCall) => {
    if (!cfg) return;
    const label = callLabel(k), closerBoard = bindings["crm.pipeline_closer"];
    const needContact = !k.links.contact_field, needCard = !!closerBoard && !k.links.opportunity;
    if (!needContact && !needCard) return;
    const ghlContact = (await one<{ v: string | null }>(c, "select ghl_contact_id as v from contacts where id=$1", [k.appt!.contact_id]))?.v ?? null;
    if (!ghlContact) { ask("link_contact", { label, record_id: k.id }); return; }
    let card: string | null = null;
    if (needCard) {
      const cards = await many<{ v: string }>(c, "select ghl_opportunity_id as v from pipeline_cards where company_id=$1 and contact_id=$2 and ghl_pipeline_id=$3 and ghl_opportunity_id is not null and status<>'gone'", [company.id, k.appt!.contact_id, closerBoard]);
      if (cards.length !== 1) { ask("link_card", { label, record_id: k.id, cards: cards.length }); return; }
      card = cards[0].v;
    }
    // the mode decides, as for every repair (D52): a contact the company may not write to yet is linked once it may; the mode is the workflow's that writes it (D92)
    if ((await effectiveMode(c, company.id, k.appt!.contact_id, await handlerMode(c, company.id, "drift.sales_call_unlinked"), bindings)) === "ghost") return;
    if (await inFlight("drift.sales_call_unlinked", k.id)) return;
    const data = { object: cfg.object, ...(needContact ? { contact_field: ghlContact } : {}), ...(card ? { card_id: card } : {}), need_contact: needContact, need_card: !!card };
    if (!(await handOn("drift.sales_call_unlinked", k, data))) { ask("link_unhandled", { label, record_id: k.id }); return; }
    await audit("sales_call", k.id, null, { repair: "linked", by: "workflow", ...data });
    repaired(`${k.id}:links`, `${label}: the Ledger drift workflow links the Sales Call to ${[needContact ? "its contact" : "", card ? "the closer card" : ""].filter(Boolean).join(" and ")}`, { sales_call: k.id, label, ...data }, k.ghl || k.id, "link_requested");
  };
  for (const k of calls) {
    const label = callLabel(k);
    // D76: a slot a call moved away from keeps its own record, logged as rescheduled; it matches no booking by design
    if (k.match === "none" && k.filed === "rescheduled") continue;
    if (k.match === "none") { ask("unmatched", { label, booking_source: k.booking_source || null, record_id: k.id }); continue; }
    if (k.match === "many") { ask("ambiguous", { label, record_id: k.id }); continue; }
    const a = k.appt!;
    const ledgerFailed = (e: unknown) => ask("ledger_write", { label, why: why(e), record_id: k.id });
    await guarded(() => linkRecord(k), ledgerFailed);
    const ghlSaid = k.filed ? WORDS[k.filed] : "nothing";
    if (k.cancelUnknown && k.filed) { ask("cancel_time_unknown", { label, booking_source: k.booking_source, ghl_said: ghlSaid, record_id: k.id }); continue; }
    const cancelWins = k.cls === "cancelled" && k.filed !== "cancelled" && a.status === "cancelled";
    if (cancelWins) {
      const asked = { label, booking_source: k.booking_source, ghl_said: ghlSaid, record_id: k.id };
      await guarded(async () => {
        if (!cfg!.cancelledValue) return ask("cancel_no_value", asked);
        const mode = await handlerMode(c, company.id, "drift.sales_call_cancelled");
        if ((await effectiveMode(c, company.id, a.contact_id, mode, bindings)) === "ghost") return ask("cancel_held_back", { ...asked, mode, value: cfg!.cancelledValue });
        // a repair is made once, ever: a record GHL set back after the workflow wrote it is left for a person
        if (await one(c, "select 1 from crm_records where company_id=$1 and object_key=$2 and ghl_record_id=$3 and properties->>'outcome'=$4", [company.id, cfg!.object, k.id, cfg!.cancelledValue])) return ask("cancel_set_back", asked);
        if (await inFlight("drift.sales_call_cancelled", k.id)) return;
        if (!(await handOn("drift.sales_call_cancelled", k, { object: cfg!.object, cancelled_value: cfg!.cancelledValue, booking_source: k.booking_source, ghl_said: k.filed }))) return ask("cancel_unhandled", asked);
        await audit("sales_call", k.id, { outcome: k.filed }, { repair: "booking_cancelled", outcome: cfg!.cancelledValue, appointment_id: a.id, by: "workflow" });
        repaired(`${k.id}:ghl`, `${label}: ${k.booking_source} cancelled it before the call; GHL said ${ghlSaid}; the Ledger drift workflow sets it to cancelled`, { sales_call: k.id, label, outcome: cfg!.cancelledValue }, k.ghl || k.id, "cancel_requested");
      }, ledgerFailed);
      await guarded(() => followResult(k, "cancelled"), ledgerFailed);
      if (a.outcome !== "cancelled") await guarded(() => setLedgerOutcome(k, "cancelled", "booking_cancelled"), ledgerFailed);
      continue;
    }
    if (k.filed && a.outcome !== k.filed) { await guarded(() => setLedgerOutcome(k, k.filed!, "ghl_outcome"), ledgerFailed); }
    await guarded(() => followResult(k), ledgerFailed);
    if (!k.filed && a.outcome && k.cls === "missing") ask("ghl_unfiled", { label, has: WORDS[a.outcome] ?? a.outcome, record_id: k.id });
  }

  // 4. D75: a won closer card and the money GHL holds for that person should agree; asked only once Payment records exist at all
  if (bindings["crm.pipeline_closer"]) {
    let pays: Payment[] = [], won: Awaited<ReturnType<GhlReads["wonCards"]>> = [];
    try { pays = await paymentRecords(reads, ac, bindings, company.timezone); if (pays.length) won = (await reads.wonCards(ac, bindings["crm.pipeline_closer"])).filter((k) => k.status === "won" && k.pipelineId === bindings["crm.pipeline_closer"] && !!k.contactId); }
    catch { pays = []; }   // a read that did not happen decides nothing
    if (pays.length) {
      const domains = testDomains(bindings);
      const ids = [...new Set([...won.map((k) => k.contactId), ...pays.map((p) => p.ghl)].filter(Boolean))];
      const ledger = new Map((await many<{ ghl: string; name: string | null; test: boolean }>(c, `select x.ghl, (select nullif(trim(coalesce(ct.first_name,'')||' '||coalesce(ct.last_name,'')),'') from contacts ct where ct.company_id=$1 and ct.ghl_contact_id=x.ghl and ct.merged_into is null limit 1) as name,
          exists (select 1 from contacts ct where ct.company_id=$1 and ct.ghl_contact_id=x.ghl and ${testContactSql("ct", "$3")}) as test from unnest($2::text[]) as x(ghl)`, [company.id, ids, domains])).map((r) => [r.ghl, r]));
      const paid = new Set(pays.filter((p) => p.flow === "in" && p.ghl).map((p) => p.ghl)), wonBy = new Set(won.map((k) => k.contactId));
      const inWindow = (t: number) => t >= from.getTime() && t <= now.toMillis();
      const day = (t: DateTime) => t.setZone(company.timezone).toFormat("ccc LLL d");
      for (const k of won) {
        if (paid.has(k.contactId) || !inWindow(Date.parse(k.wonAt)) || ledger.get(k.contactId)?.test || isTestContact({ tags: k.contactTags, emails: [k.contactEmail] }, domains)) continue;
        ask("won_no_payment", { name: ledger.get(k.contactId)?.name ?? k.contactName ?? k.contactId, day: day(DateTime.fromISO(k.wonAt)), ghl_contact_id: k.contactId, card: k.id });
      }
      const asked = new Set<string>();
      for (const p of pays.filter((x) => x.flow === "in" && x.ghl && inWindow(x.at.toMillis())).sort((a, b) => a.at.toMillis() - b.at.toMillis())) {
        if (wonBy.has(p.ghl) || asked.has(p.ghl) || ledger.get(p.ghl)?.test) continue;
        asked.add(p.ghl);
        ask("payment_no_won", { name: ledger.get(p.ghl)?.name ?? (p.label || p.ghl), amount: Math.round(p.amount), day: day(p.at), ghl_contact_id: p.ghl, payment: p.id });
      }
    }
  }

  // D88: each kind of finding is one event a sweep, for any workflow that wants it (the questions are worded by Health check)
  for (const [kind, items] of found) await dispatchEvent(c, await emitEvent(c, { company_id: company.id, contact_id: null, opportunity_id: null, appointment_id: null, event_type: "drift.found", source: "engine", data: { kind, items, count: items.length } }), {});
  // repairs alone are logged, not announced; a person hears only when something needs them, with what was already fixed as context
  if (left.length) {
    const fixed = fixedPeople.size, shown = left.slice(0, NAMES);
    const q: Record<string, Record<string, unknown>[]> = {};
    for (const item of shown) (q[item.kind as string] ??= []).push(item);
    out.push({ check, ok: false, level: "warning", text: `${left.length} ${left.length === 1 ? "question" : "questions"} about records in the engine that don't match GHL${fixed ? ` (${fixed} more updated from GHL)` : ""}.`,
      detail: { items: left, q, fixed, count: left.length, more: Math.max(0, left.length - NAMES) || null, days, shape: fixed ? (left.length === 1 ? "fixed_one" : "fixed_many") : left.length === 1 ? "one" : "many" } });
  }
  else if (!out.length) out.push({ check, ok: true, level: "warning", text: `${mine.length} contact${mine.length === 1 ? "" : "s"}${tag ? ` tagged ${tag}` : ""} added in GHL in the last ${days} days, all in the ledger${cfg ? `; ${calls.length} Sales Call${calls.length === 1 ? "" : "s"} agree with the ledger` : ""}.` });
  return out;
}
