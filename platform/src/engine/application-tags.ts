import type { PoolClient } from "pg";
import { one } from "@/db/client";
import type { Adapters, ContactSnapshot } from "@/adapters/types";
import { calendly } from "@/adapters/calendly/client";
import { liveTypeform, type TfAnswer, type TfResponse, type TypeformApi } from "@/adapters/typeform/client";
import { loadCompany } from "./context";
import { normEmail, normPhone } from "./identity";
import { findInGhl, matchPolicy, TF_TOKEN_KEY } from "./typeform";

/**
 * D250: the application and booking tags, written back over an offer's Typeform history (Tyler: "compare all of the ones in
 * type form. Anybody that has not booked a call, add that tag"; "we also want to add Application partial and application
 * complete tags"). Every person who reached the contact questions of the named forms, completed or partial, is found in GHL
 * (email, then phone, as the door finds them) and gets:
 *   - `stat-application-complete` when any response of theirs was submitted (and `stat-application-partial` comes off), else
 *     `stat-application-partial`;
 *   - `stat-call-not-booked` when they never booked a call, and it comes off when they did.
 * Booked at least once: a booking tag in GHL (BOOKED_TAGS), a booking in the ledger, or any Calendly booking under their email
 * (a cancelled one counts: they booked). The ledger only starts when the offer was installed, so Calendly is asked for the rest.
 * Nothing is created: a person GHL does not have is listed, not added. `skip` (GHL ids, Tyler: "skip clear tests") leaves those alone. Dry run (the default) reads only. Apply re-reads each
 * contact in GHL and writes only what it still lacks; the replica follows and one audit row says what changed.
 */
export const APP_COMPLETE = "stat-application-complete", APP_PARTIAL = "stat-application-partial", NOT_BOOKED = "stat-call-not-booked";
export const BOOKED_TAGS = ["stat-call-booked", "stat-booked-call", "stat-booked", "meta booked call"];

type Status = "complete" | "partial";
type Person = { key: string; email?: string; phone?: string; name?: string; status: Status; responses: number };
export type Change = { who: string; ghl_contact_id: string; status: Status; booked: string | null; add: string[]; remove: string[] };
export type AppTagsResult = {
  ok: true; dryRun: boolean; forms: { id: string; completed: number; partial: number }[];
  people: number; unidentified: number; changes: Change[]; unchanged: number; skipped: { who: string; ghl_contact_id: string }[];
  notInGhl: { name?: string; email?: string; phone?: string; status: Status }[];
  errors: { who: string; error: string }[];
  totals: Record<string, number>;
};
export type CalendlyLookup = (token: string, organization: string, email: string) => Promise<boolean>;
const liveCalendly: CalendlyLookup = async (token, organization, email) =>
  ((await calendly<{ collection?: unknown[] }>(token, `/scheduled_events?${new URLSearchParams({ organization, invitee_email: email, count: "1" })}`)).collection ?? []).length > 0;

const ofType = (r: TfResponse, type: string) => (r.answers ?? []).find((a: TfAnswer) => a.type === type);
const text = (a: TfAnswer | undefined) => (a && typeof a[a.type] === "string" ? String(a[a.type]).trim() : undefined);
/** A response's person: the email and phone questions by their type (no map needed), and the first short-text answers as a name hint. */
export function personOf(r: TfResponse): { email?: string; phone?: string; name?: string } {
  const email = normEmail(text(ofType(r, "email"))), phone = normPhone(text(ofType(r, "phone_number")));
  const name = (r.answers ?? []).filter((a) => a.type === "text").slice(0, 2).map(text).filter(Boolean).join(" ") || undefined;
  return { ...(email ? { email } : {}), ...(phone ? { phone } : {}), ...(name ? { name } : {}) };
}

/** Oldest first, so a person's latest response names them; one submitted response makes them complete. */
export function peopleOf(responses: { r: TfResponse; status: Status }[]): { people: Person[]; unidentified: number } {
  const by = new Map<string, Person>(); let unidentified = 0;
  const at = (r: TfResponse) => r.submitted_at ?? r.landed_at ?? "";
  for (const { r, status } of [...responses].sort((a, b) => at(a.r).localeCompare(at(b.r)))) {
    const p = personOf(r), key = p.email ?? (p.phone ? `phone:${p.phone}` : undefined);
    if (!key) { unidentified++; continue; }
    const cur = by.get(key);
    by.set(key, { key, email: p.email ?? cur?.email, phone: p.phone ?? cur?.phone, name: p.name ?? cur?.name, status: cur?.status === "complete" || status === "complete" ? "complete" : "partial", responses: (cur?.responses ?? 0) + 1 });
  }
  return { people: [...by.values()], unidentified };
}

/** What a person's tags should gain and lose. */
export function tagChange(tags: string[], status: Status, booked: boolean): { add: string[]; remove: string[] } {
  const has = (t: string) => tags.some((x) => x.toLowerCase() === t);
  const add: string[] = [], remove: string[] = [];
  if (status === "complete") { if (!has(APP_COMPLETE)) add.push(APP_COMPLETE); if (has(APP_PARTIAL)) remove.push(APP_PARTIAL); }
  else if (!has(APP_COMPLETE) && !has(APP_PARTIAL)) add.push(APP_PARTIAL);
  if (booked) { if (has(NOT_BOOKED)) remove.push(NOT_BOOKED); } else if (!has(NOT_BOOKED)) add.push(NOT_BOOKED);
  return { add, remove };
}

async function eachLimited<T>(xs: T[], n: number, fn: (x: T) => Promise<void>) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, xs.length) }, async () => { while (i < xs.length) await fn(xs[i++]); }));
}

export async function applicationTags(c: PoolClient, adapters: Adapters, a: { company: string; forms: string[]; why: string; dryRun?: boolean; skip?: string[]; tf?: TypeformApi; cal?: CalendlyLookup; concurrency?: number }): Promise<AppTagsResult | { ok: false; status: number; error: string }> {
  if (!a.forms?.length || !a.why?.trim()) return { ok: false, status: 400, error: "company, forms (Typeform form ids) and why are required" };
  const co = await one<{ id: string }>(c, "select id from companies where slug=$1", [a.company]); if (!co) return { ok: false, status: 404, error: "no such company" };
  const { adapterCompany: ac, bindings } = await loadCompany(c, co.id);
  const token = bindings[TF_TOKEN_KEY]; if (!token) return { ok: false, status: 400, error: `no Typeform token bound (${TF_TOKEN_KEY})` };
  const tf = a.tf ?? liveTypeform, cal = a.cal ?? liveCalendly, dryRun = a.dryRun !== false;
  const calendlyCfg = ac.booking.source === "calendly" && ac.booking.organization ? { token: ac.booking.token, organization: ac.booking.organization } : null;

  const all: { r: TfResponse; status: Status }[] = [], forms: AppTagsResult["forms"] = [];
  for (const id of a.forms) {
    const completed = await tf.responses(token, id, "completed"), partial = await tf.responses(token, id, "partial");
    forms.push({ id, completed: completed.length, partial: partial.length });
    all.push(...completed.map((r) => ({ r, status: "complete" as const })), ...partial.map((r) => ({ r, status: "partial" as const })));
  }
  const { people, unidentified } = peopleOf(all);
  const policy = matchPolicy(bindings);
  const skipped: AppTagsResult["skipped"] = [], changes: Change[] = [], notInGhl: AppTagsResult["notInGhl"] = [], errors: AppTagsResult["errors"] = [];
  let unchanged = 0;
  const ledgerBooked = async (ghlId: string) => !!(await one(c, "select 1 from appointments a join contacts ct on ct.id=a.contact_id where a.company_id=$1 and ct.ghl_contact_id=$2 limit 1", [co.id, ghlId]));

  await eachLimited(people, a.concurrency ?? 4, async (p) => {
    const who = p.name ?? p.email ?? p.phone ?? p.key;
    try {
      const found = await findInGhl(ac, adapters, p.email, p.phone, policy);
      if (!found) { notInGhl.push({ name: p.name, email: p.email, phone: p.phone, status: p.status }); return; }
      const snap: ContactSnapshot = found.snap;
      const name = [snap.firstName, snap.lastName].filter(Boolean).join(" ") || who;
      if (a.skip?.includes(snap.id)) { skipped.push({ who: name, ghl_contact_id: snap.id }); return; }
      const tagHit = BOOKED_TAGS.find((t) => snap.tags.some((x) => x.toLowerCase() === t));
      let booked: string | null = tagHit ? `tag ${tagHit}` : (await ledgerBooked(snap.id)) ? "a booking in the ledger" : null;
      if (!booked && calendlyCfg) for (const e of [...new Set([p.email, normEmail(snap.email)].filter((x): x is string => !!x))]) if (await cal(calendlyCfg.token, calendlyCfg.organization, e)) { booked = `Calendly (${e})`; break; }
      const { add, remove } = tagChange(snap.tags, p.status, !!booked);
      if (!add.length && !remove.length) { unchanged++; return; }
      if (!dryRun) {
        const live = await adapters.read.getContact(ac, snap.id);
        if (!live) { errors.push({ who: name, error: "gone from GHL" }); return; }
        const now = tagChange(live.tags, p.status, !!booked);
        for (const t of now.add) await adapters.write.addTag(ac, snap.id, t);
        for (const t of now.remove) await adapters.write.removeTag(ac, snap.id, t);
        await c.query("update contacts set tags = array(select distinct unnest(array_cat(array(select x from unnest(tags) x where not x = any($3::text[])), $2::text[]))), updated_at=now() where company_id=$1 and ghl_contact_id=$4", [co.id, now.add, now.remove, snap.id]);
        changes.push({ who: name, ghl_contact_id: snap.id, status: p.status, booked, add: now.add, remove: now.remove });
        return;
      }
      changes.push({ who: name, ghl_contact_id: snap.id, status: p.status, booked, add, remove });
    } catch (e) { errors.push({ who, error: String((e as Error).message).slice(0, 200) }); }
  });

  changes.sort((x, y) => x.who.localeCompare(y.who));
  const totals: Record<string, number> = {};
  for (const ch of changes) { for (const t of ch.add) totals[`+${t}`] = (totals[`+${t}`] ?? 0) + 1; for (const t of ch.remove) totals[`-${t}`] = (totals[`-${t}`] ?? 0) + 1; }
  if (!dryRun && changes.length) await c.query("insert into audit_log (company_id, action, target_type, target_id, after) values ($1,'contact.application_tags','company',$2,$3)", [co.id, co.id, { forms: a.forms, why: a.why, totals, skipped: a.skip ?? [], changes: changes.map((x) => ({ ghl_contact_id: x.ghl_contact_id, add: x.add, remove: x.remove })) }]);
  return { ok: true, dryRun, forms, people: people.length, unidentified, changes, unchanged, skipped, notInGhl, errors, totals };
}

