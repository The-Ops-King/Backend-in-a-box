import type { PoolClient } from "pg";
import { DateTime } from "luxon";
import { many } from "@/db/client";
import type { GhlFieldDef, GhlReads } from "@/adapters/ghl/metrics";
import { loadCompany } from "./context";
import { dayBounds } from "./metrics";
import { isTestContact, testContactSql, testDomains } from "./mode";
import { GHL_SOURCE } from "./ghl-metrics";
import { MetricError, type Period } from "./metric-registry";

/**
 * Any GHL field, counted or listed (D74). The bot resolves the asker's words to a field from the catalogue itself and says
 * which field it used; only a tie or no match is asked. People are the leads GHL added in the period; an object's records
 * are those whose date (its one date property, else when the record was created) falls in it. Test contacts never count.
 */
export type FieldBreakdown = {
  metric: "field_breakdown"; source: string; period_label: string; period_name: string; timezone: string;
  object: string; object_label: string; field: string; field_name: string; basis: string; multi: boolean;
  total: number; answered: number; unanswered: number; rows: { value: string; count: number }[];
  list?: { name: string; value: string }[];
};
export const NO_ANSWER = "(no answer)";
const LIST_MAX = 100;

export type CatalogField = { object: string; object_label: string; field: string; name: string; type: string; options?: string[] };
export async function fieldCatalog(c: PoolClient, companyId: string, reads: GhlReads): Promise<CatalogField[]> {
  const { adapterCompany: ac } = await loadCompany(c, companyId);
  return (await reads.fieldCatalog(ac)).map((f) => ({ object: f.object, object_label: f.objectLabel, field: f.key, name: f.name, type: f.type, ...(f.options.length ? { options: f.options.map((o) => o.label) } : {}) }));
}

const text = (v: unknown) => (typeof v === "string" ? v.trim() : typeof v === "number" || typeof v === "boolean" ? String(v) : "");
/** One stored value as the answers it holds: a multi-pick is several, an option key reads as its label. */
function answers(v: unknown, def: GhlFieldDef): string[] {
  const label = (x: string) => def.options.find((o) => o.key === x)?.label ?? x;
  const parts = Array.isArray(v) ? v.map(text) : text(v) ? [text(v)] : [];
  return parts.filter(Boolean).map(label);
}

export async function fieldBreakdown(c: PoolClient, companyId: string, q: { object: string; field: string; period: Period; list: boolean }, reads: GhlReads): Promise<FieldBreakdown> {
  const { row, adapterCompany: ac, bindings } = await loadCompany(c, companyId);
  const tz = row.timezone, domains = testDomains(bindings);
  const want = q.field.trim().toLowerCase();
  const defs = await reads.fieldCatalog(ac).catch((e) => { throw new MetricError(`GHL could not be read (field list: ${String((e as Error).message).slice(0, 160)})`); });
  const def = defs.find((f) => f.object === q.object && [f.key, f.id, f.prop].some((k) => k.toLowerCase() === want));
  if (!def) throw new MetricError(`no ${q.object} field "${q.field}" in GHL; call list_fields and pass a field key exactly as listed`);
  const start = dayBounds(q.period.from, tz).start, end = dayBounds(q.period.to, tz).end;
  const people: { name: string; values: string[] }[] = [];
  let basis: string;
  if (def.object === "contact") {
    const got = await reads.contactsAdded(ac, start, end).catch((e) => { throw new MetricError(`GHL could not be read (contacts: ${String((e as Error).message).slice(0, 160)})`); });
    for (const k of got) {
      const t = Date.parse(k.dateAdded);
      if (t < start.getTime() || t >= end.getTime() || isTestContact({ tags: k.tags, emails: [k.email] }, domains)) continue;
      people.push({ name: `${k.firstName ?? ""} ${k.lastName ?? ""}`.trim() || k.email || k.phone || k.id, values: answers(k.customFields[def.prop], def) });
    }
    basis = "leads GHL added in the period";
  } else {
    const dates = defs.filter((f) => f.object === def.object && f.type === "DATE");
    const dateProp = dates.length === 1 ? dates[0] : null;
    const recs = await reads.objectRecords(ac, def.object).catch((e) => { throw new MetricError(`GHL could not be read (${def.objectLabel} records: ${String((e as Error).message).slice(0, 160)})`); });
    const test = new Set((await many<{ id: string }>(c, `select ct.ghl_contact_id as id from contacts ct where ct.company_id=$1 and ct.ghl_contact_id is not null and ${testContactSql("ct", "$2")}`, [companyId, domains])).map((r) => r.id));
    for (const r of recs) {
      const raw = dateProp ? text(r.properties[dateProp.prop]) : r.createdAt;
      const at = dateProp ? DateTime.fromISO(raw, { zone: tz }) : DateTime.fromISO(raw);
      if (!at.isValid || at.toMillis() < start.getTime() || at.toMillis() >= end.getTime()) continue;
      if (test.has(text(r.properties.contact_id))) continue;
      people.push({ name: text(r.properties.display_label) || r.id, values: answers(r.properties[def.prop], def) });
    }
    basis = `${def.objectLabel} records ${dateProp ? `with ${dateProp.name.toLowerCase()}` : "created"} in the period`;
  }
  const counts = new Map<string, number>();
  for (const p of people) for (const v of p.values.length ? p.values : [NO_ANSWER]) counts.set(v, (counts.get(v) ?? 0) + 1);
  const unanswered = counts.get(NO_ANSWER) ?? 0;
  const rank = (v: string) => { const i = def.options.findIndex((o) => o.label === v); return v === NO_ANSWER ? 1e6 : i < 0 ? 1e5 : i; };
  const rows = [...counts.entries()].map(([value, count]) => ({ value, count })).sort((a, b) => (def.options.length ? rank(a.value) - rank(b.value) : b.count - a.count || a.value.localeCompare(b.value)));
  return {
    metric: "field_breakdown", source: GHL_SOURCE, period_label: q.period.label, period_name: q.period.name, timezone: tz,
    object: def.object, object_label: def.objectLabel, field: def.key, field_name: def.name, basis, multi: def.type === "CHECKBOX" || def.type === "MULTIPLE_OPTIONS",
    total: people.length, answered: people.length - unanswered, unanswered, rows,
    ...(q.list ? { list: people.slice(0, LIST_MAX).map((p) => ({ name: p.name, value: p.values.join(", ") || NO_ANSWER })) } : {}),
  };
}

/**
 * A contact field's answers against how their calls went (D74): each answer's calls, shows, no-shows, cancels and unfiled,
 * its show rate (shows ÷ calls booked, cancels in, D73) and its share of all shows. Whether the show rates differ by more
 * than chance would explain is a permutation test (deterministic), never the model's impression; with few answered calls
 * the verdict says so instead of claiming a pattern. A person with several calls counts once per call; a multi-pick counts
 * the call under each pick.
 */
export type FieldVsCalls = {
  metric: "field_vs_calls"; source: string; period_label: string; period_name: string; timezone: string;
  field: string; field_name: string; multi: boolean; calls: number; answered_calls: number; showed: number; show_rate: number | null;
  /** the booked calls whose person has no answer, by name and how they were booked: a gap to see, not to hide */
  unanswered: { name: string; booked: string; date: string }[];
  rows: { value: string; calls: number; showed: number; noshow: number; cancelled: number; missing: number; show_rate: number | null; share_of_shows: number | null }[];
  test: { p: number | null; verdict: string };
};
const PERMUTATIONS = 5000;
const MIN_CALLS = 10;

/** χ² of a 2×K table (showed / not, per answer) — the statistic the permutation test shuffles. */
function chi2(groups: { n: number; s: number }[]): number {
  const N = groups.reduce((a, g) => a + g.n, 0), S = groups.reduce((a, g) => a + g.s, 0);
  if (!N || !S || S === N) return 0;
  return groups.reduce((a, g) => { const es = (g.n * S) / N, en = g.n - es; return a + (es ? (g.s - es) ** 2 / es : 0) + (en ? (g.n - g.s - en) ** 2 / en : 0); }, 0);
}
export function permutationP(groups: { n: number; s: number }[]): number {
  const labels = groups.flatMap((g, i) => Array.from({ length: g.n }, () => i));
  const outcomes: number[] = groups.flatMap((g) => Array.from({ length: g.n }, (_, j) => (j < g.s ? 1 : 0)));
  const seen = chi2(groups);
  let seed = 0x9e3779b9, hits = 0;
  const rand = () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  for (let k = 0; k < PERMUTATIONS; k++) {
    for (let i = outcomes.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [outcomes[i], outcomes[j]] = [outcomes[j], outcomes[i]]; }
    const g = groups.map(() => ({ n: 0, s: 0 }));
    labels.forEach((l, i) => { g[l].n++; g[l].s += outcomes[i]; });
    if (chi2(g) >= seen - 1e-9) hits++;
  }
  return (hits + 1) / (PERMUTATIONS + 1);
}

export async function fieldVsCalls(c: PoolClient, companyId: string, q: { field: string; period: Period; now: Date }, reads: GhlReads): Promise<FieldVsCalls> {
  const { row, adapterCompany: ac, bindings } = await loadCompany(c, companyId);
  const tz = row.timezone, domains = testDomains(bindings);
  const defs = await reads.fieldCatalog(ac).catch((e) => { throw new MetricError(`GHL could not be read (field list: ${String((e as Error).message).slice(0, 160)})`); });
  const want = q.field.trim().toLowerCase();
  const def = defs.find((f) => f.object === "contact" && [f.key, f.id, f.prop].some((k) => k.toLowerCase() === want));
  if (!def) throw new MetricError(`no contact field "${q.field}" in GHL; call list_fields and pass a contact field key exactly as listed`);
  const start = dayBounds(q.period.from, tz).start, end = dayBounds(q.period.to, tz).end;
  const { salesCallsFor } = await import("./ghl-metrics");
  const calls = (await salesCallsFor({ c, companyId, ac, bindings, reads, tz, start, end, now: q.now, sourceField: bindings["crm.field_contact_lead_source"] ?? "", domains }))
    .filter((k) => !k.test && k.at.toMillis() <= q.now.getTime());
  const people = new Map<string, string[]>();
  const ids = [...new Set(calls.map((k) => k.ghl).filter(Boolean))];
  for (let i = 0; i < ids.length; i += 5) await Promise.all(ids.slice(i, i + 5).map(async (id) => {
    const k = await reads.getContact(ac, id).catch((e) => { throw new MetricError(`GHL could not be read (contact ${id}: ${String((e as Error).message).slice(0, 120)})`); });
    people.set(id, k && !isTestContact({ tags: k.tags, emails: [k.email] }, domains) ? answers(k.customFields[def.prop], def) : []);
  }));
  const by = new Map<string, { calls: number; showed: number; noshow: number; cancelled: number; missing: number }>();
  const bookedDef = defs.find((f) => f.object !== "contact" && f.prop === "booking_source");
  const bookedAs = (v: string) => (v ? bookedDef?.options.find((o) => o.key === v)?.label ?? v : "");
  const unanswered = calls.filter((k) => !(people.get(k.ghl) ?? []).length).map((k) => ({ name: k.name.split(" · ")[0].trim() || k.name, booked: bookedAs(k.booked), date: k.at.toFormat("LLL d") }));
  for (const k of calls) for (const v of (people.get(k.ghl) ?? []).length ? people.get(k.ghl)! : [NO_ANSWER]) {
    const r = by.get(v) ?? { calls: 0, showed: 0, noshow: 0, cancelled: 0, missing: 0 }; by.set(v, r);
    r.calls++; if (k.cls === "showed") r.showed++; else if (k.cls === "noshow") r.noshow++; else if (k.cls === "cancelled" || k.cls === "rescheduled") r.cancelled++; else r.missing++;
  }
  const showed = calls.filter((k) => k.cls === "showed").length;
  const rank = (v: string) => { const i = def.options.findIndex((o) => o.label === v); return v === NO_ANSWER ? 1e6 : i < 0 ? 1e5 : i; };
  const rows = [...by.entries()].map(([value, r]) => ({ value, ...r, show_rate: r.calls ? r.showed / r.calls : null, share_of_shows: showed ? r.showed / showed : null }))
    .sort((a, b) => rank(a.value) - rank(b.value) || b.calls - a.calls);
  const answered = rows.filter((r) => r.value !== NO_ANSWER);
  const answeredCalls = answered.reduce((a, r) => a + r.calls, 0);
  let test: FieldVsCalls["test"];
  if (answered.length < 2) test = { p: null, verdict: "Fewer than two different answers among these calls, so there is nothing to compare." };
  else if (answeredCalls < MIN_CALLS) test = { p: null, verdict: `Only ${answeredCalls} calls have an answer to this question: too few to tell a pattern from chance.` };
  else {
    const p = permutationP(answered.map((r) => ({ n: r.calls, s: r.showed })));
    test = { p, verdict: p < 0.05 ? `The show rates differ by more than chance would explain (p = ${p.toFixed(3)}).` : `A difference this size could easily be chance (p = ${p.toFixed(2)}); not enough to call it a pattern yet.` };
  }
  return { metric: "field_vs_calls", source: GHL_SOURCE, period_label: q.period.label, period_name: q.period.name, timezone: tz, field: def.key, field_name: def.name,
    multi: def.type === "CHECKBOX" || def.type === "MULTIPLE_OPTIONS", calls: calls.length, answered_calls: answeredCalls, showed, show_rate: calls.length ? showed / calls.length : null, unanswered, rows, test };
}
