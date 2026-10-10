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
