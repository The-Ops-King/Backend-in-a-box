import { PortError } from "@/engine/ports";
import type { FieldMapRow, J } from "./types";

/**
 * An offer's field map for one provider, as data: a workflow writes `lead_source`, the connector writes the CRM's own
 * field. A canonical field with no row is refused (permanent: a person adds the row), never guessed. Reading goes the
 * other way: a provider field the map knows comes back under its canonical name; one it does not know is left out.
 */
export class FieldMap {
  constructor(private rows: FieldMapRow[]) {}

  has(object: string, canonical: string): boolean { return !!this.row(object, canonical); }
  row(object: string, canonical: string): FieldMapRow | undefined { return this.rows.find((r) => r.object === object && r.canonicalField === canonical); }
  byProviderId(object: string, providerFieldId: string): FieldMapRow | undefined { return this.rows.find((r) => r.object === object && r.providerFieldId === providerFieldId); }

  /** The provider's field id for a canonical field, or a permanent refusal naming what is missing. */
  idOf(object: string, canonical: string): string {
    const r = this.row(object, canonical);
    if (!r) throw new PortError("permanent", `the field map has no ${object} field for "${canonical}"; add it to the offer's field map`);
    return r.providerFieldId;
  }

  /** Canonical fields and values, as the provider's field ids and values in its own types. */
  write(object: string, fields: J): { id: string; value: unknown; row: FieldMapRow }[] {
    return Object.entries(fields).map(([k, v]) => { const row = this.row(object, k); if (!row) this.idOf(object, k); return { id: row!.providerFieldId, value: formatValue(row!, v), row: row! }; });
  }

  /** The provider's fields (id → value), as canonical fields. */
  read(object: string, provider: Record<string, unknown>): J {
    const out: J = {};
    for (const [id, v] of Object.entries(provider)) { const r = this.byProviderId(object, id); if (r) out[r.canonicalField] = v; }
    return out;
  }

  /** A calendar's call type (rows on object "calendar": the call type, and the calendar id it is). */
  calendarKind(calendarId: string | null | undefined): string | undefined { return calendarId ? this.byProviderId("calendar", calendarId)?.canonicalField : undefined; }
}

const dayIn = (d: Date, zone: string) => new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);

/**
 * A value in the provider field's own type. A DATE field keeps no time (GHL drops it silently), so an instant is sent as
 * its day in the field's zone (`options.zone`, else UTC) and the time is never pretended to be kept.
 */
export function formatValue(row: Pick<FieldMapRow, "valueType" | "options">, v: unknown): unknown {
  if (v === null || v === undefined) return v;
  switch (row.valueType) {
    case "date": {
      const s = String(v);
      if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
      const t = new Date(s);
      if (Number.isNaN(t.getTime())) throw new PortError("permanent", `"${s}" is not a date`);
      return dayIn(t, typeof row.options.zone === "string" ? row.options.zone : "UTC");
    }
    case "datetime": { const t = new Date(String(v)); return Number.isNaN(t.getTime()) ? String(v) : t.toISOString(); }
    case "number": case "money": {
      const cleaned = String(v).replace(/[^0-9.-]/g, "");
      const n = typeof v === "number" ? v : cleaned === "" ? NaN : Number(cleaned);
      if (!Number.isFinite(n)) throw new PortError("permanent", `"${String(v)}" is not a number`);
      return n;
    }
    case "checkbox": case "options": return Array.isArray(v) ? v.map(String) : row.valueType === "checkbox" ? [String(v)] : String(v);
    default: return typeof v === "string" ? v : typeof v === "number" || typeof v === "boolean" ? String(v) : JSON.stringify(v);
  }
}
