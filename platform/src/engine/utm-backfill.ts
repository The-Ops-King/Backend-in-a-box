import type { PoolClient } from "pg";
import { one } from "@/db/client";
import type { Adapters } from "@/adapters/types";
import { liveTypeform, type TfResponse, type TypeformApi } from "@/adapters/typeform/client";
import { loadCompany } from "./context";
import { personOf } from "./application-tags";
import { findInGhl, matchPolicy, TF_TOKEN_KEY } from "./typeform";

/**
 * D281 (Tyler, 2026-10-31: "can you backfill from typeform all the utm stuff?"). Each person who answered the offer's Typeform forms
 * gets the UTMs their first response carried (Typeform's hidden fields utm_source, utm_medium, utm_campaign, utm_content, utm_term):
 * where they first came from. The UTM fields and the lead-source field are the offer's (crm.field_contact_utm_*, _lead_source); the
 * lead source is the utm_source in the words `sourceNames` gives it (`{"fb": "Meta"}`), else as Typeform has it. Only an empty field
 * is filled: what the Zap or a person already wrote stays. A person GHL does not have is listed, not made. Dry run (the default) reads
 * only and lists every utm_source seen; apply re-reads each contact and writes only what it still lacks. Audited.
 */
export const UTM_KEYS = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"] as const;
type Utm = Partial<Record<(typeof UTM_KEYS)[number], string>>;
export type UtmChange = { who: string; ghl_contact_id: string; fields: Record<string, string> };

/** A response's UTMs, by Typeform's hidden field names (any case), blanks and unfilled placeholders ("{{…}}", "xxxxx") left out. */
export function utmOf(r: TfResponse): Utm {
  const h = Object.fromEntries(Object.entries(r.hidden ?? {}).map(([k, v]) => [k.toLowerCase(), String(v ?? "").trim()]));
  const out: Utm = {};
  for (const k of UTM_KEYS) { const v = h[k]; if (v && !/^\{\{.*\}\}$|^x+$/i.test(v)) out[k] = v; }
  return out;
}
/** The lead source a utm_source stands for, by the names given (any case), else the utm_source itself. */
export const sourceName = (utmSource: string, names: Record<string, string> = {}) => {
  const hit = Object.entries(names).find(([k]) => k.trim().toLowerCase() === utmSource.trim().toLowerCase());
  return hit ? hit[1] : utmSource;
};

export async function utmBackfill(c: PoolClient, adapters: Adapters, a: { company: string; forms: string[]; why: string; dryRun?: boolean; sourceNames?: Record<string, string>; skip?: string[]; tf?: TypeformApi }) {
  if (!a.forms?.length || !a.why?.trim()) return { ok: false as const, status: 400, error: "company, forms (Typeform form ids) and why are required" };
  const co = await one<{ id: string }>(c, "select id from companies where slug=$1", [a.company]); if (!co) return { ok: false as const, status: 404, error: "no such company" };
  const { adapterCompany: ac, bindings } = await loadCompany(c, co.id);
  const token = bindings[TF_TOKEN_KEY]; if (!token) return { ok: false as const, status: 400, error: `no Typeform token bound (${TF_TOKEN_KEY})` };
  const ids: Record<string, string | undefined> = { ...Object.fromEntries(UTM_KEYS.map((k) => [k, bindings[`crm.field_contact_${k}`]])), lead_source: bindings["crm.field_contact_lead_source"] };
  const unbound = Object.entries(ids).filter(([, v]) => !v).map(([k]) => `crm.field_contact_${k}`);
  if (unbound.length) return { ok: false as const, status: 400, error: `not bound for this offer: ${unbound.join(", ")}` };
  const tf = a.tf ?? liveTypeform, dryRun = a.dryRun !== false;

  // every response, oldest first: a person's first response that carries UTMs is where they came from
  const all: TfResponse[] = [];
  for (const id of a.forms) all.push(...(await tf.responses(token, id, "completed")), ...(await tf.responses(token, id, "partial")));
  const at = (r: TfResponse) => r.landed_at ?? r.submitted_at ?? "";
  const first = new Map<string, { email?: string; phone?: string; name?: string; utm: Utm }>();
  const sources: Record<string, number> = {};
  let noUtm = 0, unidentified = 0;
  for (const r of [...all].sort((x, y) => at(x).localeCompare(at(y)))) {
    const p = personOf(r), key = p.email ?? (p.phone ? `phone:${p.phone}` : undefined), utm = utmOf(r);
    if (!key) { unidentified++; continue; }
    if (!Object.keys(utm).length) { if (!first.has(key)) noUtm++; continue; }
    if (first.has(key)) continue;
    first.set(key, { ...p, utm });
    if (utm.utm_source) sources[utm.utm_source] = (sources[utm.utm_source] ?? 0) + 1;
  }

  const policy = matchPolicy(bindings);
  const changes: UtmChange[] = [], notInGhl: { email?: string; phone?: string; name?: string }[] = [], errors: { who: string; error: string }[] = [];
  let unchanged = 0;
  const want = (u: Utm): Record<string, string> => ({ ...Object.fromEntries(Object.entries(u)), ...(u.utm_source ? { lead_source: sourceName(u.utm_source, a.sourceNames) } : {}) });
  const missing = (have: Record<string, unknown>, w: Record<string, string>) => Object.fromEntries(Object.entries(w).filter(([k]) => { const v = have[ids[k]!]; return v === undefined || v === null || String(v).trim() === ""; }));
  for (const p of first.values()) {
    const who = p.name ?? p.email ?? p.phone ?? "?";
    try {
      const found = await findInGhl(ac, adapters, p.email, p.phone, policy);
      if (!found) { notInGhl.push({ email: p.email, phone: p.phone, name: p.name }); continue; }
      if (a.skip?.includes(found.snap.id)) continue;
      const name = [found.snap.firstName, found.snap.lastName].filter(Boolean).join(" ") || who;
      let fill = missing(found.snap.customFields ?? {}, want(p.utm));
      if (!Object.keys(fill).length) { unchanged++; continue; }
      if (!dryRun) {
        const live = await adapters.read.getContact(ac, found.snap.id);
        if (!live) { errors.push({ who: name, error: "gone from GHL" }); continue; }
        fill = missing(live.customFields ?? {}, want(p.utm));
        if (!Object.keys(fill).length) { unchanged++; continue; }
        await adapters.write.updateContact(ac, found.snap.id, { customFields: Object.entries(fill).map(([k, v]) => ({ id: ids[k]!, field_value: v })) });
        await c.query("update contacts set ghl_fields = coalesce(ghl_fields,'{}'::jsonb) || $3::jsonb, updated_at=now() where company_id=$1 and ghl_contact_id=$2", [co.id, found.snap.id, JSON.stringify(Object.fromEntries(Object.entries(fill).map(([k, v]) => [ids[k]!, v])))]);
      }
      changes.push({ who: name, ghl_contact_id: found.snap.id, fields: fill });
    } catch (e) { errors.push({ who, error: String((e as Error).message).slice(0, 200) }); }
  }
  changes.sort((x, y) => x.who.localeCompare(y.who));
  if (!dryRun && changes.length) await c.query("insert into audit_log (company_id, action, target_type, target_id, after) values ($1,'contact.utm_backfill','company',$2,$3)", [co.id, co.id, { forms: a.forms, why: a.why, sourceNames: a.sourceNames ?? {}, changes }]);
  return { ok: true as const, dryRun, responses: all.length, people: first.size, sources, noUtm, unidentified, changes, unchanged, notInGhl, errors };
}
