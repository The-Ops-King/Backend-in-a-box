import type { Attribution, ContactSnapshot } from "@/adapters/types";

/**
 * D78: a person's lead source, read in one order everywhere (metrics, the joined analysis, the booking card, wrap-ups):
 * the company's lead-source field → the contact's UTM Source field → GHL's own attribution (first touch, then latest
 * touch) → the UTM source of their latest booking → GHL's attribution medium (how the record came in: zapier, manual…)
 * → "unknown". Values are kept as GHL has them, trimmed and lower-cased.
 */
export const UNKNOWN_SOURCE = "unknown";
export type SourceFields = { leadSource?: string; utmSource?: string };
export const sourceFields = (b: Record<string, string>): SourceFields => ({ leadSource: b["crm.field_contact_lead_source"] || undefined, utmSource: b["crm.field_contact_utm_source"] || undefined });

const clean = (v: unknown): string => (Array.isArray(v) ? v.map(String).join(", ") : typeof v === "string" || typeof v === "number" ? String(v) : "").trim().toLowerCase();

export type SourceInput = { fields?: Record<string, unknown> | null; attribution?: Attribution | null; bookingUtm?: string | null };
export function leadSource(p: SourceInput, f: SourceFields): string {
  const a = p.attribution ?? {};
  const field = (id?: string) => (id ? p.fields?.[id] : undefined);
  for (const v of [field(f.leadSource), field(f.utmSource), a.first?.utmSource, a.last?.utmSource, p.bookingUtm, a.first?.medium, a.last?.medium]) {
    const s = clean(v);
    if (s) return s;
  }
  return UNKNOWN_SOURCE;
}
export const contactSource = (k: Pick<ContactSnapshot, "customFields" | "attribution"> | null | undefined, f: SourceFields, bookingUtm?: string | null) =>
  leadSource({ fields: k?.customFields, attribution: k?.attribution, bookingUtm }, f);

/**
 * The same order over the ledger, for the ledger's metrics: `fields` is a text[] parameter holding [lead-source field id,
 * UTM Source field id] (either may be null), `ct` the contacts alias. The poll keeps GHL's attribution on `contacts.attribution`.
 */
export function leadSourceSql(ct: string, fields: string): string {
  const text = (expr: string) => `nullif(lower(trim(case when jsonb_typeof(${expr})='array' then (select string_agg(x, ', ') from jsonb_array_elements_text(${expr}) x) else (${expr})#>>'{}' end)),'')`;
  const booking = `(select nullif(lower(trim(sa.tracking->>'utm_source')),'') from appointments sa where sa.company_id=${ct}.company_id and sa.contact_id=${ct}.id and sa.source<>'test' and coalesce(trim(sa.tracking->>'utm_source'),'')<>'' order by sa.booked_at desc limit 1)`;
  return `coalesce(${text(`${ct}.ghl_fields->((${fields})::text[])[1]`)}, ${text(`${ct}.ghl_fields->((${fields})::text[])[2]`)}, ${text(`${ct}.attribution#>'{first,utmSource}'`)}, ${text(`${ct}.attribution#>'{last,utmSource}'`)}, ${booking}, ${text(`${ct}.attribution#>'{first,medium}'`)}, ${text(`${ct}.attribution#>'{last,medium}'`)}, '${UNKNOWN_SOURCE}')`;
}
export const sourceFieldsParam = (f: SourceFields): (string | null)[] => [f.leadSource ?? null, f.utmSource ?? null];

/** The order in words, for the bot's schema hint. */
export function sourceOrderWords(f: SourceFields): string {
  const field = (id?: string) => (id ? `contacts.ghl_fields->>'${id}'` : null);
  return [field(f.leadSource) && `the lead-source field ${field(f.leadSource)}`, field(f.utmSource) && `the UTM Source field ${field(f.utmSource)}`,
    "GHL's first-touch attribution contacts.attribution#>>'{first,utmSource}' (then '{last,utmSource}')", "the latest booking's tracking->>'utm_source'",
    "GHL's attribution medium contacts.attribution#>>'{first,medium}'", `'${UNKNOWN_SOURCE}'`].filter(Boolean).join(", else ") + "; lower-cased and trimmed";
}

