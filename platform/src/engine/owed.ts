import type { PoolClient } from "pg";
import { DateTime } from "luxon";
import { many } from "@/db/client";
import { liveGhlReads, type GhlReads } from "@/adapters/ghl/metrics";
import type { Adapters } from "@/adapters/types";
import { loadCompany, type CompanyRow } from "./context";
import { salesCallsFor } from "./ghl-metrics";
import { salesCallConfig } from "./ghl-metrics";
import { testDomains } from "./mode";
import { SETTING_DEFAULTS } from "./setting-defaults";

/**
 * D255 (Tyler, 2026-10-30: "the EOD should ONLY pull from the GHL sales calls ... everything pulls from GHL!"). What a person still
 * owes on their end of day is read live from GHL, never from what the engine stored: a Sales Call record whose call has passed with
 * no outcome (the very rule /weekly's "No EOD outcome yet" uses, `salesCallsFor`), and a Discovery Call record (a setter's triage
 * call) whose call has passed still "scheduled" or blank. Whose it is: the record's closer or setter, matched to the roster by name;
 * someone no longer on it (Carly) is still listed by the name GHL has, because GHL still has their unfiled calls. Test contacts are
 * left out as every number leaves them out. One list for `/missing-eod`, the wrap-up's missing lines, the dashboard and the
 * reminders, so they can never disagree with each other or with /weekly.
 */
export type Owed = { record_id: string; kind: "closing" | "triage"; name: string; at: DateTime; day: string; who: string; user_id: string | null };

const NOT_FILED = new Set(["", "scheduled"]);

export async function owedFromGhl(c: PoolClient, company: CompanyRow, now: DateTime, lookbackDays: number, reads: GhlReads = liveGhlReads): Promise<Owed[]> {
  const { adapterCompany: ac, bindings } = await loadCompany(c, company.id);
  const tz = company.timezone, local = now.setZone(tz);
  const start = local.minus({ days: lookbackDays }).startOf("day");
  const roster = await many<{ id: string; name: string }>(c, "select id::text as id, name from users where company_id=$1", [company.id]);
  const userOf = (name: string) => { const w = name.trim().toLowerCase(); const hit = roster.filter((u) => u.name.trim().toLowerCase() === w); return hit.length === 1 ? hit[0] : null; };
  const out: Owed[] = [];
  if (salesCallConfig(bindings)) {
    const calls = await salesCallsFor({ c, companyId: company.id, ac, bindings, reads, tz, start: start.toJSDate(), end: local.toJSDate(), now: local.toJSDate(), domains: testDomains(bindings) });
    for (const k of calls.filter((x) => x.cls === "missing" && !x.test)) {
      // the record's closer: a roster id when it is someone on the team, else the name as GHL has it
      const u = roster.find((r) => r.id === k.closer) ?? userOf(k.closer);
      out.push({ record_id: k.id, kind: "closing", name: k.name, at: k.at.setZone(tz), day: k.at.setZone(tz).toISODate()!, who: u?.name ?? (k.closer || "no closer named"), user_id: u?.id ?? null });
    }
  }
  const discovery = bindings["crm.object_discovery_call"] || SETTING_DEFAULTS["crm.object_discovery_call"].default;
  if (discovery) {
    let recs: Awaited<ReturnType<GhlReads["objectRecords"]>> = [];
    try { recs = await reads.objectRecords(ac, discovery); } catch { recs = []; }   // an offer with no Discovery Call object has no triage calls owed
    for (const r of recs) {
      const p = r.properties, outcome = String(p.outcome ?? "").trim().toLowerCase();
      if (!NOT_FILED.has(outcome)) continue;
      const at = triageTime(p, tz); if (!at || at < start || at > local) continue;
      const name = String(p.display_label ?? "").split(" — ")[0].trim() || r.id, setter = String(p.setter ?? "").trim(), u = userOf(setter);
      out.push({ record_id: r.id, kind: "triage", name, at, day: at.toISODate()!, who: u?.name ?? (setter || "no setter named"), user_id: u?.id ?? null });
    }
  }
  return out.sort((a, b) => a.at.toMillis() - b.at.toMillis());
}

/** GHL reads through an offer's adapters (the CRM's own records, as every step reads them); the rest as the metric layer reads GHL. */
export const readsFrom = (adapters: Adapters): GhlReads => ({ ...liveGhlReads, objectRecords: async (ac, object) => (await adapters.read.objectRecords(ac, object)).map((r) => ({ ...r, createdAt: (r as { createdAt?: string }).createdAt ?? "" })) });

/** A Discovery Call's time: the day its label carries ("Anna — 2026-11-17") at the clock time `occurred_at` says ("Tue Nov 17 · 12:00 PM PST"), in the offer's zone. */
export function triageTime(p: Record<string, unknown>, tz: string): DateTime | null {
  const day = /(\d{4}-\d{2}-\d{2})\s*$/.exec(String(p.display_label ?? ""))?.[1];
  if (!day) return null;
  const clock = /(\d{1,2}):(\d{2})\s*([AP]M)/i.exec(String(p.occurred_at ?? ""));
  const base = DateTime.fromISO(day, { zone: tz });
  if (!base.isValid) return null;
  if (!clock) return base.endOf("day");   // a day with no time is owed once the day is over
  const h = (Number(clock[1]) % 12) + (clock[3].toUpperCase() === "PM" ? 12 : 0);
  return base.set({ hour: h, minute: Number(clock[2]) });
}
