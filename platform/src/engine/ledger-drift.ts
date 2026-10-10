import type { PoolClient } from "pg";
import { DateTime } from "luxon";
import { many, one } from "@/db/client";
import type { Adapters, Company, ContactSnapshot } from "@/adapters/types";
import type { GhlReads } from "@/adapters/ghl/metrics";
import type { CompanyRow } from "./context";
import type { Finding } from "./health";
import { effectiveMode, testDomains } from "./mode";
import { claimEffect, markEffect, releasePending, PENDING_WHY } from "./effects";
import { salesCallConfig, salesCallsFor, type SalesCall, type SalesCallConfig } from "./ghl-metrics";

/**
 * D73. "Always GHL. It's the truth. If the two are different, that's an issue." And: "the engine is only the mirror of the
 * truth and it needs to stay updated with reality; if there are inconsistencies it needs updated, and the health check
 * should do that." Over the last week (minus the half hour the poll has not reached yet) the sweep compares GHL with the
 * ledger and repairs what it can:
 * - a contact GHL added that the ledger lacks is pulled in with the contacts poll's own upsert, and a record new to the
 *   engine fires lead.created once, as the poll would have;
 * - a ledger contact GHL confirms is gone is stamped gone (asked first, D69);
 * - a Sales Call the booking source cancelled before its start is set to cancelled in GHL (mode rules, D52; the effects
 *   ledger, D66, so the write is never made twice) and in the ledger;
 * - otherwise a filed Sales Call outcome wins over the ledger's.
 * Every repair is in the audit log and the sweep's result. What it cannot repair (an unmatched record, a cancel at an
 * unknown time, a write the mode holds back or the CRM refuses) is one alert naming the people, resolved by the sweep that
 * finds nothing left. A read that did not happen decides nothing: whatever was open stays open.
 */
export const DRIFT_DAYS = 7;
export const POLL_LAG_MIN = 30;
export const LATE_LEAD_MIN = 60;   // pulled in later than this after arriving: no lead workflows, a person is told
const NAMES = 10;

/** D69: ask the CRM before saying a record is gone. A "not found" in any shape is gone; anything else that fails is unknown. */
export async function crmPresence(get: (id: string) => Promise<ContactSnapshot | null>, ghlId: string): Promise<"present" | "gone" | "unknown"> {
  try { return (await get(ghlId)) ? "present" : "gone"; }
  catch (e) { return /\bcontact (with id \S+ )?not found\b/i.test(String((e as Error).message)) ? "gone" : "unknown"; }
}

const WORDS: Record<string, string> = { showed: "showed", noshow: "no-show", cancelled: "cancelled", rescheduled: "rescheduled" };
const snapName = (k: ContactSnapshot) => `${k.firstName ?? ""} ${k.lastName ?? ""}`.trim() || k.email || k.phone || k.id;
const why = (e: unknown) => String((e as Error).message).slice(0, 160);
/** "German Arellano, Mon Oct 5 at 10:00 AM": the record's own label carries the time after a dot; the person is what comes first. */
const callLabel = (k: SalesCall) => `${k.name.split(" · ")[0].trim() || k.name}, ${k.at.toFormat("ccc LLL d")}${k.at.hour || k.at.minute ? ` at ${k.at.toFormat("h:mm a")}` : ""}`;

/** `runId`: the health step's run, which the effects ledger records CRM writes against; without one, no CRM write is made. */
export async function ledgerDrift(c: PoolClient, company: CompanyRow, ac: Company, bindings: Record<string, string>, reads: GhlReads, adapters: Adapters, runId: string | undefined, now: DateTime = DateTime.now()): Promise<Finding[]> {
  const check = "ledger_drift";
  const from = now.minus({ days: DRIFT_DAYS }).toJSDate(), to = now.minus({ minutes: POLL_LAG_MIN }).toJSDate();
  const carry = async (reason: string): Promise<Finding[]> => {
    const open = await one<{ text: string; level: "error" | "warning"; detail: Record<string, unknown> }>(c, "select text, level, detail from alerts where company_id=$1 and key='health:ledger_drift' and resolved_at is null", [company.id]);
    return open ? [{ check, ok: false, level: open.level, text: open.text, detail: open.detail }] : [{ check, ok: true, level: "warning", text: `GHL could not be read to compare with the ledger (${reason}); compared again next sweep.` }];
  };
  const cfg = salesCallConfig(bindings);
  let ghl: ContactSnapshot[], calls: SalesCall[] = [];
  try {
    ghl = (await reads.contactsAdded(ac, from, to)).filter((k) => { const t = Date.parse(k.dateAdded); return t >= from.getTime() && t <= to.getTime(); });
    if (cfg && Object.keys(cfg.outcomes).length) calls = await salesCallsFor({ c, companyId: company.id, ac, bindings, reads, tz: company.timezone, start: from, end: now.toJSDate(), now: now.toJSDate(), sourceField: bindings["crm.field_contact_lead_source"] ?? "", domains: testDomains(bindings) });
  } catch (e) { return carry(why(e)); }

  const out: Finding[] = [];
  const left: string[] = [];
  const unrepaired: Record<string, unknown>[] = [];
  const audit = (target: string, id: string, before: unknown, after: Record<string, unknown>) =>
    c.query("insert into audit_log (company_id, action, target_type, target_id, before, after) values ($1,'health.repaired',$2,$3,$4,$5)", [company.id, target, id, before === null ? null : JSON.stringify(before), JSON.stringify(after)]);
  const fixedPeople = new Set<string>();
  const repaired = (item: string, text: string, detail: Record<string, unknown>, who?: string) => { fixedPeople.add(who ?? item); out.push({ check, item: `repair:${item}`, ok: true, level: "warning", text: `Repaired: ${text}.`, detail }); };
  const cannot = (text: string, detail: Record<string, unknown>) => { left.push(text); unrepaired.push(detail); };
  // one repair failing in the database must not undo the others
  const guarded = async (f: () => Promise<void>, onError: (e: unknown) => void) => {
    await c.query("savepoint drift_repair");
    try { await f(); await c.query("release savepoint drift_repair"); } catch (e) { await c.query("rollback to savepoint drift_repair"); onError(e); }
  };

  // 1. contacts GHL added that the ledger does not hold: pulled in as the poll would
  const known = new Set((await many<{ id: string }>(c, `select x.id from unnest($2::text[]) as x(id) where exists (select 1 from contacts ct where ct.company_id=$1 and ct.ghl_contact_id=x.id)
    or exists (select 1 from contact_identifiers i where i.company_id=$1 and i.kind='ghl_contact' and i.value=x.id)`, [company.id, ghl.map((k) => k.id)])).map((r) => r.id));
  const missing = ghl.filter((k) => !known.has(k.id));
  if (missing.length) {
    const { upsertContact, boundFieldIds } = await import("./poll");
    const { emitEvent, dispatchEvent } = await import("./dispatch");
    for (const s of missing) await guarded(async () => {
      const up = await upsertContact(c, company.id, company.timezone, s, boundFieldIds(bindings));
      // the record is new to the engine here, so the sweep is what makes it a lead: the poll will now see it as known and fire nothing.
      // A lead found long after it arrived does not start the lead workflows: a first text days late is worse than none, so a person is told instead.
      const late = up.isNew && now.toMillis() - Date.parse(s.dateAdded) > LATE_LEAD_MIN * 60_000;
      if (up.isNew && !late) await dispatchEvent(c, await emitEvent(c, { company_id: company.id, contact_id: up.id, opportunity_id: null, appointment_id: null, event_type: "lead.created", source: "ghl_poll", data: { ghl_contact_id: s.id, by: "health" } }), { contact: { id: up.id, ghl_contact_id: s.id, tags: s.tags } });
      await audit("contact", up.id, null, { repair: "pulled_in", ghl_contact_id: s.id, lead_created: up.isNew && !late, late });
      if (late) cannot(`${snapName(s)} came into GHL ${DateTime.fromISO(s.dateAdded).setZone(company.timezone).toFormat("ccc LLL d 'at' h:mma")} and the engine missed them until now. They're in now, but New lead and Speed to lead did NOT run. Can someone follow up by hand?`, { kind: "late_lead", ghl_contact_id: s.id, contact_id: up.id });
      else repaired(s.id, `${snapName(s)} was in GHL but not the ledger; pulled in${up.isNew ? " (New lead fired once)" : ""}`, { ghl_contact_id: s.id, contact_id: up.id }, s.id);
    }, (e) => cannot(`${snapName(s)} is in GHL but the engine couldn't pull them in (${why(e)}). I'll try again next hour.`, { kind: "missing", ghl_contact_id: s.id }));
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
    repaired(o.ghl_contact_id, `${o.name ?? o.ghl_contact_id} is gone from GHL; marked gone in the ledger`, { contact_id: o.id, ghl_contact_id: o.ghl_contact_id }, o.ghl_contact_id);
  }

  // 3. Sales Calls against the bookings they match
  const termOf = async (cat: string) => (await one<{ id: string }>(c, "select id from company_terms where company_id=$1 and domain='appointment_outcome' and category=$2 order by is_default desc limit 1", [company.id, cat]))?.id ?? null;
  const setLedgerOutcome = async (k: SalesCall, cat: string, reason: string) => {
    const term = await termOf(cat);
    if (!term) { cannot(`${callLabel(k)}: GHL says ${WORDS[cat] ?? cat}, but the engine has no "${cat}" outcome set up, so it can't follow. That's a setup fix on our side.`, { kind: "outcome_term", record_id: k.id }); return; }
    await c.query("update appointments set outcome_term=$2 where id=$1", [k.appt!.id, term]);
    await audit("appointment", k.appt!.id, { outcome: k.appt!.outcome }, { repair: reason, outcome: cat, sales_call: k.id });
    repaired(`${k.id}:ledger`, `${callLabel(k)}: the ledger said ${WORDS[k.appt!.outcome ?? ""] ?? "nothing"}, now ${WORDS[cat]} as ${reason === "booking_cancelled" ? `${k.booking_source} cancelled it before the call` : "GHL says"}`, { appointment_id: k.appt!.id, sales_call: k.id, outcome: cat }, k.ghl || k.id);
  };
  for (const k of calls) {
    const label = callLabel(k);
    if (k.match === "none") { cannot(`${label}: GHL has this Sales Call, but the engine has no booking for that person at that time. Was it booked outside ${k.booking_source || "the booking calendar"}, or moved?`, { kind: "unmatched", record_id: k.id }); continue; }
    if (k.match === "many") { cannot(`${label}: this Sales Call fits more than one booking in the engine, so I won't guess which. Which booking is it?`, { kind: "ambiguous", record_id: k.id }); continue; }
    const a = k.appt!;
    if (k.cancelUnknown && k.filed) { cannot(`${label}: ${k.booking_source} says cancelled, GHL says ${WORDS[k.filed]}, and I can't tell when it was cancelled. Which is right?`, { kind: "cancel_time_unknown", record_id: k.id }); continue; }
    const cancelWins = k.cls === "cancelled" && k.filed !== "cancelled" && a.status === "cancelled";
    if (cancelWins) {
      const r = await writeCancelled(c, company, ac, bindings, adapters, cfg!, runId, k);
      if (r === "written") {
        await audit("sales_call", k.id, { outcome: k.filed }, { repair: "booking_cancelled", outcome: cfg!.cancelledValue, appointment_id: a.id });
        repaired(`${k.id}:ghl`, `${label}: ${k.booking_source} cancelled it before the call; GHL said ${k.filed ? WORDS[k.filed] : "nothing"}, now cancelled`, { sales_call: k.id, outcome: cfg!.cancelledValue }, k.ghl || k.id);
      } else cannot(`${label}: ${k.booking_source} cancelled it before the call, but GHL still says ${k.filed ? WORDS[k.filed] : "nothing"} and I couldn't change it (${r}). Set it to cancelled in GHL?`, { kind: "cancel_not_written", record_id: k.id, why: r });
      if (a.outcome !== "cancelled") await guarded(() => setLedgerOutcome(k, "cancelled", "booking_cancelled"), (e) => cannot(`${label}: the engine couldn't record it as cancelled (${why(e)}). I'll try again next hour.`, { kind: "ledger_write", record_id: k.id }));
      continue;
    }
    if (k.filed && a.outcome !== k.filed) { await guarded(() => setLedgerOutcome(k, k.filed!, "ghl_outcome"), (e) => cannot(`${label}: the engine couldn't copy GHL's outcome (${why(e)}). I'll try again next hour.`, { kind: "ledger_write", record_id: k.id })); continue; }
    if (!k.filed && a.outcome && k.cls === "missing") cannot(`${label}: the engine has ${WORDS[a.outcome] ?? a.outcome} but GHL's Sales Call has no outcome. Should GHL say ${WORDS[a.outcome] ?? a.outcome}?`, { kind: "ghl_unfiled", record_id: k.id });
  }

  // repairs alone are logged, not announced; a person hears only when something needs them, with what was already fixed as context
  if (left.length) {
    const fixed = fixedPeople.size;
    const head = `${fixed ? `${fixed} ${fixed === 1 ? "record" : "records"} in the engine didn't match GHL over the last ${DRIFT_DAYS} days; ${fixed === 1 ? "it's" : "they've"} been updated from GHL.\n` : ""}${left.length === 1 ? (fixed ? "Except this one, which I have a question about:" : "One thing in the engine doesn't match GHL and I have a question about it:") : `${fixed ? "Except these" : `${left.length} things in the engine don't match GHL`}, which I have questions about:`}`;
    out.push({ check, ok: false, level: "warning", text: `${head}\n${left.slice(0, NAMES).map((x) => `• ${x}`).join("\n")}${left.length > NAMES ? `\n…and ${left.length - NAMES} more on the dashboard.` : ""}`, detail: { items: unrepaired, fixed } });
  }
  else if (!out.length) out.push({ check, ok: true, level: "warning", text: `${ghl.length} contact${ghl.length === 1 ? "" : "s"} added in GHL in the last ${DRIFT_DAYS} days, all in the ledger${cfg ? `; ${calls.length} Sales Call${calls.length === 1 ? "" : "s"} agree with the ledger` : ""}.` });
  return out;
}

/** The one CRM write a repair makes: the Sales Call's outcome set to cancelled, under the mode (D52) and the effects ledger (D66). */
async function writeCancelled(c: PoolClient, company: CompanyRow, ac: Company, bindings: Record<string, string>, adapters: Adapters, cfg: SalesCallConfig, runId: string | undefined, k: SalesCall): Promise<string> {
  if (!cfg.cancelledValue) return "no outcome value means cancelled (sales_call.outcomes)";
  if (!runId) return "no run to record the write against";
  if ((await effectiveMode(c, company.id, k.appt!.contact_id, company.mode, bindings)) === "shadow")
    return `${company.mode} mode: would set the outcome to "${cfg.cancelledValue}"; nothing is written to the CRM for this contact yet`;
  const node = `repair:${k.id}:outcome`;
  // a repair is made once, ever: a later sweep that finds its own earlier write never asks again
  const prior = await one<{ run_id: string; done_at: Date | null }>(c, "select run_id::text as run_id, done_at from step_effects where company_id=$1 and node_id=$2 and kind='record' order by created_at desc limit 1", [company.id, node]);
  if (prior?.done_at) return "it was set once already and GHL says otherwise again; left for a person";
  if (prior && prior.run_id !== runId) return PENDING_WHY;
  const cl = await claimEffect(c, company.id, runId, node, "record");
  if (!cl.fresh) return cl.done ? "it was set once already" : PENDING_WHY;
  try { await adapters.write.updateRecord(ac, cfg.object, k.id, { outcome: cfg.cancelledValue }); }
  catch (e) {
    // a CRM that answered with an error wrote nothing, so the claim comes off; one that never answered keeps it (D66)
    if ((e as { status?: number }).status) await releasePending(c, runId, node);
    return `GHL refused it (${why(e)})`;
  }
  await markEffect(c, runId, node, "record", k.id);
  return "written";
}
