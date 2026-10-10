import { DateTime } from "luxon";
import type { PoolClient } from "pg";
import { many } from "@/db/client";
import type { ContactSnapshot } from "@/adapters/types";
import type { GhlCard, GhlFieldDef, GhlObjectRecord, GhlReads } from "@/adapters/ghl/metrics";
import { loadCompany } from "./context";
import { dayBounds } from "./metrics";
import { isTestContact, testDomains } from "./mode";
import { GHL_SOURCE, callTime, ledgerFacts, paymentObject, paymentRecords, salesCallConfig, salesCallsFor, signed, type CallClass, type GhlCtx, type Payment } from "./ghl-metrics";
import { MetricError, type Period } from "./metric-registry";
import { contactSource, sourceFields } from "./lead-source";

/**
 * D75: the bot joins a person's GHL records live, in memory, for one answer, and stores nothing. A row is a lead (a contact
 * GHL added in the period), a call (a Sales Call whose time fell in the period and has passed, classified exactly as D73
 * does) or a close (distinct people with a won Closer-pipeline card in the period). Each row carries the records linked to
 * its person: the contact, their setter card, their Sales Calls, their closer card, their Payment records and their
 * Discovery Calls. Columns name those records' fields (`contact.<field name>`, `call.<prop>`, `closer_card.stage`…); an
 * analysis splits and filters rows by them and counts each unit's measures, says where a link is missing and where the
 * records disagree with each other. Test contacts are in no row.
 */
export type GraphUnit = "lead" | "call" | "close";
export const UNITS: GraphUnit[] = ["lead", "call", "close"];
export type Rate = "booked_rate" | "show_rate" | "close_rate";
export const RATES: Record<GraphUnit, Rate[]> = { lead: ["booked_rate", "show_rate", "close_rate"], call: ["show_rate", "close_rate"], close: [] };
export type Column = { column: string; name: string; type: "options" | "multi" | "text" | "number" | "money" | "date"; options?: string[] };
export const NO_ANSWER = "(no answer)";
const LIST_MAX = 100;
const NAMES = 40;
const PERMUTATIONS = 5000;
const MIN_N = 10;
const LINK_PROPS = ["contact_id", "opportunity_id", "external_id", "display_label"];

/** GHL reads remembered for one answer: the same records are never fetched twice while one question is answered. */
export function memoReads(r: GhlReads): GhlReads {
  const m = new Map<string, Promise<unknown>>();
  const once = <T>(k: string, f: () => Promise<T>): Promise<T> => {
    let p = m.get(k) as Promise<T> | undefined;
    if (!p) { p = f(); m.set(k, p); p.catch(() => m.delete(k)); }
    return p;
  };
  return {
    contactsAdded: (c, a, b) => once(`ca:${a.toISOString()}:${b.toISOString()}`, () => r.contactsAdded(c, a, b)),
    wonCards: (c, p) => once(`wc:${p}`, () => r.wonCards(c, p)),
    objectRecords: (c, k) => once(`or:${k}`, () => r.objectRecords(c, k)),
    getContact: (c, id) => once(`gc:${id}`, () => r.getContact(c, id)),
    fieldCatalog: (c) => once("fc", () => r.fieldCatalog(c)),
    recordContact: (c, id) => once(`rc:${id}`, () => r.recordContact(c, id)),
    cards: (c, p) => once(`cd:${p}`, () => r.cards(c, p)),
    pipelines: (c) => once("pl", () => r.pipelines(c)),
    users: (c) => once("us", () => r.users(c)),
  };
}

async function get<T>(what: string, f: () => Promise<T>): Promise<T> {
  try { return await f(); }
  catch (e) {
    if (e instanceof MetricError) throw e;
    const status = (e as { status?: number }).status;
    throw new MetricError(`GHL could not be read (${what}${status ? `, ${status}` : ""}): ${String((e as Error).message).slice(0, 200)}`);
  }
}
/** Five GHL requests at a time: the location's rate limit is shared with the engine's own polls. */
async function each<T>(items: T[], f: (x: T) => Promise<void>, n = 5): Promise<void> {
  for (let i = 0; i < items.length; i += n) await Promise.all(items.slice(i, i + n).map(f));
}
const lazy = <T>(f: () => Promise<T>) => { let p: Promise<T> | undefined; return () => (p ??= f()); };
const text = (v: unknown) => (typeof v === "string" ? v.trim() : typeof v === "number" || typeof v === "boolean" ? String(v) : "");
/** One stored value as the answers it holds: a multi-pick is several, an option key reads as its label. */
export function answers(v: unknown, def?: GhlFieldDef): string[] {
  const label = (x: string) => def?.options.find((o) => o.key === x)?.label ?? x;
  const parts = Array.isArray(v) ? v.map(text) : text(v) ? [text(v)] : [];
  return parts.filter(Boolean).map(label);
}
const personName = (k: ContactSnapshot) => `${k.firstName ?? ""} ${k.lastName ?? ""}`.trim() || k.email || k.phone || k.id;
const opts = (f: GhlFieldDef) => (f.options.length ? { options: f.options.map((o) => o.label), keys: Object.fromEntries(f.options.map((o) => [o.key.trim().toLowerCase(), o.label])) } : {});
const typeOf = (t: string): Column["type"] => (["CHECKBOX", "MULTIPLE_OPTIONS"].includes(t) ? "multi" : ["SINGLE_OPTIONS", "RADIO", "DROPDOWN"].includes(t) ? "options" : ["NUMERICAL", "MONETORY", "MONETARY"].includes(t) ? "number" : t === "DATE" ? "date" : "text");

/** A Sales Call's (or Discovery Call's) time as D73 reads it: the scheduled stamp or display text, else its call date. */
function callAt(p: Record<string, unknown>, tz: string): { at: DateTime; exact: boolean } | null {
  const day = /^\d{4}-\d{2}-\d{2}$/.test(String(p.call_date ?? "")) ? DateTime.fromISO(String(p.call_date), { zone: tz }) : null;
  const sched = callTime(p.scheduled_at, day, tz);
  return sched ? { at: sched, exact: true } : day ? { at: day, exact: false } : null;
}
const passed = (t: { at: DateTime; exact: boolean }, now: number) => (t.exact ? t.at.toMillis() < now : t.at.plus({ days: 1 }).toMillis() <= now);

type Call = { rec: GhlObjectRecord; at: DateTime | null; cls?: CallClass | "missing" };
type Row = {
  key: string; ghl: string; name: string; at: DateTime; contact: ContactSnapshot | null; test?: boolean;
  setter: GhlCard | null; closer: GhlCard | null; calls: Call[]; call: Call | null; due: Call[]; payments: Payment[]; discovery: GhlObjectRecord[];
  value: number; closedMark?: boolean; cashMark?: boolean; /** the UTM source of the person's latest booking, from the ledger */ utm?: string | null;
};
type ColDef = Column & { ns: string; get: (r: Row) => string[]; keys?: Record<string, string> };
/** Stage and user names, read only when a column asks for them, so a getter stays synchronous. */
type Names = { stages: Map<string, string>; users: Map<string, string> };

/** Everything one answer may join, each read at most once and only when a column or measure needs it. */
async function open(c: PoolClient, companyId: string, reads: GhlReads, now: Date) {
  const { row, adapterCompany: ac, bindings } = await loadCompany(c, companyId);
  if (!ac.pit || !ac.locationId) throw new MetricError("GHL is not connected for this company (no token or location bound), so its records cannot be read");
  const tz = row.timezone, domains = testDomains(bindings);
  const defs = lazy(() => get("field list", () => reads.fieldCatalog(ac)));
  const has = async (object: string) => (await defs()).some((f) => f.object === object);
  const stages = lazy(async () => new Map((await get("pipelines", () => reads.pipelines(ac))).flatMap((p) => p.stages.map((s) => [s.id, s.name] as [string, string]))));
  const users = lazy(async () => {
    const roster = await many<{ ghl_user_id: string; name: string }>(c, "select ghl_user_id, name from users where company_id=$1 and ghl_user_id is not null", [companyId]);
    const ghl = await get("users", () => reads.users(ac));
    return new Map([...roster.map((u) => [u.ghl_user_id, u.name] as [string, string]), ...ghl.map((u) => [u.id, u.name] as [string, string])]);
  });
  const board = (key: string) => lazy(async () => {
    const pipe = bindings[key];
    const by = new Map<string, GhlCard>();
    if (!pipe) return { bound: false, by, cards: [] as GhlCard[] };
    const cards = (await get(key === "crm.pipeline_setter" ? "setter cards" : "closer cards", () => reads.cards(ac, pipe))).filter((k) => k.pipelineId === pipe && k.contactId);
    // at most one per person; if GHL holds two, the won one, else the latest
    for (const k of cards) { const o = by.get(k.contactId); if (!o || (k.status === "won") > (o.status === "won") || ((k.status === "won") === (o.status === "won") && k.updatedAt > o.updatedAt)) by.set(k.contactId, k); }
    return { bound: true, by, cards };
  });
  const setters = board("crm.pipeline_setter"), closers = board("crm.pipeline_closer");
  /** an object's records grouped by their person; the contact_id property is a copy, GHL's association is read when it is empty */
  const linked = (object: string, what: string) => lazy(async () => {
    const by = new Map<string, GhlObjectRecord[]>();
    if (!object || !(await has(object))) return by;
    const recs = await get(`${what} records`, () => reads.objectRecords(ac, object));
    await each(recs.filter((r) => !text(r.properties.contact_id)), async (r) => { const id = await get(`a ${what}'s contact`, () => reads.recordContact(ac, r.id)); if (id) r.properties = { ...r.properties, contact_id: id }; });
    for (const r of recs) { const id = text(r.properties.contact_id); if (id) by.set(id, [...(by.get(id) ?? []), r]); }
    return by;
  });
  const scObject = bindings["crm.object_sales_call"] ?? "";
  const salesCalls = linked(scObject, "Sales Call");
  const discovery = linked(bindings["crm.object_discovery_call"] || "custom_objects.discovery_call", "Discovery Call");
  const payments = lazy(async () => {
    const key = paymentObject(bindings);
    if (!(await has(key))) return { exist: false, by: new Map<string, Payment[]>() };
    const all = await paymentRecords(reads, ac, bindings, tz);
    const by = new Map<string, Payment[]>();
    for (const p of all) if (p.ghl) by.set(p.ghl, [...(by.get(p.ghl) ?? []), p]);
    return { exist: all.length > 0, by };
  });
  const contacts = new Map<string, ContactSnapshot | null>();
  const fetchContacts = (ids: string[]) => each([...new Set(ids)].filter((id) => id && !contacts.has(id)), async (id) => { contacts.set(id, await get(`contact ${id}`, () => reads.getContact(ac, id))); });
  const ctx = (start: Date, end: Date): Omit<GhlCtx, "filters" | "memo"> => ({ c, companyId, ac, bindings, reads, tz, start, end, now, domains });
  return { c, companyId, ac, bindings, tz, domains, reads, now, defs, stages, users, setters, closers, salesCalls, discovery, payments, contacts, fetchContacts, ctx, scObject };
}
type Graph = Awaited<ReturnType<typeof open>>;

/** Every column a row of the unit carries, namespaced by the record it comes from. */
async function columnDefs(g: Graph, unit: GraphUnit, full: boolean, names: Names): Promise<ColDef[]> {
  const defs = await g.defs();
  const out: ColDef[] = [];
  const seen = new Set<string>();
  const add = (d: ColDef) => { let k = d.column; for (let i = 2; seen.has(k.toLowerCase()); i++) k = `${d.column} (${i})`; seen.add(k.toLowerCase()); out.push({ ...d, column: k }); };
  const sources = sourceFields(g.bindings);
  for (const f of defs.filter((x) => x.object === "contact")) add({ ns: "contact", column: `contact.${f.name}`, name: f.name, type: typeOf(f.type), ...opts(f), get: (r) => answers(r.contact?.customFields[f.prop], f) });
  add({ ns: "contact", column: "contact.source", name: "Source", type: "text", get: (r) => [contactSource(r.contact, sources, r.utm)] });
  add({ ns: "contact", column: "contact.tags", name: "Tags", type: "multi", get: (r) => r.contact?.tags ?? [] });
  const stageOpts = async (key: string) => { if (!full || !g.bindings[key]) return undefined; const pipes = await get("pipelines", () => g.reads.pipelines(g.ac)); return pipes.find((p) => p.id === g.bindings[key])?.stages.map((s) => s.name); };
  const userOpts = async () => (full ? [...new Set((await g.users()).values())].sort() : undefined);
  const stageName = (k: GhlCard | null) => (k ? [names.stages.get(k.stageId) ?? k.stageId] : []);
  const userName = (k: GhlCard | null) => (k?.assignedTo ? [names.users.get(k.assignedTo) ?? k.assignedTo] : []);
  for (const [ns, key, label] of [["setter_card", "crm.pipeline_setter", "Setter card"], ["closer_card", "crm.pipeline_closer", "Closer card"]] as const) {
    if (!g.bindings[key]) continue;
    const pick = (r: Row) => (ns === "setter_card" ? r.setter : r.closer);
    add({ ns, column: `${ns}.stage`, name: `${label} stage`, type: "options", options: await stageOpts(key), get: (r) => stageName(pick(r)) });
    add({ ns, column: `${ns}.status`, name: `${label} status`, type: "options", options: ["open", "won", "lost", "abandoned"], get: (r) => (pick(r) ? [pick(r)!.status] : []) });
    add({ ns, column: `${ns}.assigned`, name: `${label} owner`, type: "options", options: await userOpts(), get: (r) => userName(pick(r)) });
    if (ns === "closer_card") add({ ns, column: "closer_card.value", name: "Closer card value", type: "money", get: (r) => (r.closer?.monetaryValue !== undefined ? [String(r.closer.monetaryValue)] : []) });
  }
  const objDefs = (object: string) => defs.filter((f) => f.object === object && !LINK_PROPS.includes(f.prop));
  for (const f of objDefs(g.scObject)) add({ ns: "call", column: `call.${f.prop}`, name: `${f.objectLabel}: ${f.name}`, type: typeOf(f.type), ...opts(f), get: (r) => answers(r.call?.rec.properties[f.prop], f) });
  if (g.scObject) {
    add({ ns: "call", column: "call.result", name: "How the call went", type: "options", options: Object.values(CLASS_WORDS), get: (r) => (unit === "call" ? (r.call?.cls ? [CLASS_WORDS[r.call.cls]] : []) : r.due.length ? [CLASS_WORDS[r.due[r.due.length - 1].cls ?? "missing"]] : []) });
    if (unit !== "call") add({ ns: "call", column: "call.count", name: "Sales Calls booked", type: "number", get: (r) => [String(r.calls.length)] });
  }
  const payKey = paymentObject(g.bindings);
  if (defs.some((f) => f.object === payKey)) {
    add({ ns: "payment", column: "payment.total", name: "Payments total (net)", type: "money", get: (r) => (r.payments.length ? [String(net(r.payments))] : []) });
    add({ ns: "payment", column: "payment.count", name: "Payments", type: "number", get: (r) => (r.payments.length ? [String(r.payments.filter((p) => p.flow === "in").length)] : []) });
    add({ ns: "payment", column: "payment.first_date", name: "First payment", type: "date", get: (r) => { const t = r.payments.filter((p) => p.flow === "in").map((p) => p.at).sort((a, b) => a.toMillis() - b.toMillis())[0]; return t ? [t.toISODate()!] : []; } });
    for (const f of objDefs(payKey).filter((x) => !["amount", "occurred_at"].includes(x.prop)))
      add({ ns: "payment", column: f.prop === "type" ? "payment.types" : `payment.${f.prop}`, name: `Payment: ${f.name}`, type: "multi", ...opts(f), get: (r) => [...new Set(r.payments.flatMap((p) => answers(p.props[f.prop], f)))] });
  }
  const dcKey = g.bindings["crm.object_discovery_call"] || "custom_objects.discovery_call";
  if (defs.some((f) => f.object === dcKey)) {
    add({ ns: "discovery", column: "discovery.count", name: "Discovery Calls", type: "number", get: (r) => [String(r.discovery.length)] });
    for (const f of objDefs(dcKey)) add({ ns: "discovery", column: `discovery.${f.prop}`, name: `${f.objectLabel}: ${f.name}`, type: f.type === "DATE" ? "date" : "multi", ...opts(f), get: (r) => [...new Set(r.discovery.flatMap((d) => answers(d.properties[f.prop], f)))] });
  }
  return out;
}
const CLASS_WORDS: Record<CallClass | "missing", string> = { showed: "showed", noshow: "no-show", cancelled: "cancelled", rescheduled: "rescheduled", missing: "missing from EOD" };
const net = (ps: Payment[]) => ps.reduce((a, p) => a + signed(p), 0);

export async function listColumns(c: PoolClient, companyId: string, unit: GraphUnit, reads: GhlReads, now: Date = new Date()): Promise<Column[]> {
  const g = await open(c, companyId, reads, now);
  return (await columnDefs(g, unit, true, { stages: new Map(), users: new Map() })).map(({ column, name, type, options }) => ({ column, name, type, ...(options?.length ? { options } : {}) }));
}

function resolve(cols: ColDef[], want: string, defs: GhlFieldDef[]): ColDef {
  const w = want.trim().toLowerCase();
  const hit = cols.find((x) => x.column.toLowerCase() === w);
  if (hit) return hit;
  // a contact field named by its key or id, as D74 named fields
  const f = defs.find((d) => d.object === "contact" && [d.key, d.id, `contact.${d.prop}`].some((k) => k.toLowerCase() === w || `contact.${k.toLowerCase()}` === w));
  const byField = f ? cols.find((x) => x.column.toLowerCase() === `contact.${f.name.toLowerCase()}`) : undefined;
  if (byField) return byField;
  throw new MetricError(`no column "${want}"; call list_columns and pass a column exactly as listed`);
}

// ---- rows ---------------------------------------------------------------------------------------------------------------
async function rowsOf(g: Graph, unit: GraphUnit, period: Period, need: Set<string>): Promise<Row[]> {
  const start = dayBounds(period.from, g.tz).start, end = dayBounds(period.to, g.tz).end, now = g.now.getTime();
  const isTest = (k: ContactSnapshot | null | undefined) => !!k && isTestContact({ tags: k.tags, emails: [k.email] }, g.domains);
  let rows: Row[];
  const blank = (key: string, ghl: string, name: string, at: DateTime, contact: ContactSnapshot | null): Row => ({ key, ghl, name, at, contact, setter: null, closer: null, calls: [], call: null, due: [], payments: [], discovery: [], value: 0 });
  if (unit === "lead") {
    const got = await get("contacts", () => g.reads.contactsAdded(g.ac, start, new Date(end.getTime() - 1)));
    const inWindow = got.filter((k) => { const t = Date.parse(k.dateAdded); return t >= start.getTime() && t < end.getTime() && !isTest(k); });
    rows = inWindow.map((k) => blank(k.id, k.id, personName(k), DateTime.fromISO(k.dateAdded).setZone(g.tz), k));
    if (g.scObject && salesCallConfig(g.bindings) && Object.keys(salesCallConfig(g.bindings)!.outcomes).length && rows.length) {
      // a lead's calls since the period began, classified as D73 does; those the ledger says are the harness's are no one's
      const due = await salesCallsFor(g.ctx(start, g.now.getTime() > start.getTime() ? g.now : end));
      const byId = new Map(due.map((k) => [k.id, k]));
      const recs = await g.salesCalls();
      for (const r of rows) {
        const calls = (recs.get(r.ghl) ?? []).map((rec) => ({ rec, t: callAt(rec.properties, g.tz) }))
          .filter(({ rec, t }) => !(t && t.at.toMillis() >= start.getTime() && passed(t, now) && !byId.has(rec.id)));
        r.calls = calls.map(({ rec, t }) => ({ rec, at: t?.at ?? null, cls: byId.get(rec.id)?.cls })).sort(byTime);
        r.due = r.calls.filter((k) => byId.has(k.rec.id) && !byId.get(k.rec.id)!.test);
        r.call = r.calls[r.calls.length - 1] ?? null;
      }
    }
  } else if (unit === "call") {
    // D76: a slot the call was rescheduled away from is no call of its own
    const list = (await salesCallsFor(g.ctx(start, end))).filter((k) => !k.test && k.at.toMillis() <= now && k.cls !== "rescheduled");
    const recs = new Map((await get("Sales Call records", () => g.reads.objectRecords(g.ac, g.scObject))).map((r) => [r.id, r]));
    await g.fetchContacts(list.map((k) => k.ghl));
    rows = list.map((k) => {
      const ct = k.ghl ? g.contacts.get(k.ghl) ?? null : null;
      const r = blank(k.id, k.ghl, ct ? personName(ct) : k.name.split(" · ")[0].trim() || k.name, k.at, ct);
      r.test = isTest(ct);
      r.call = { rec: recs.get(k.id) ?? { id: k.id, createdAt: "", properties: {} }, at: k.at, cls: k.cls };
      return r;
    }).filter((r) => !r.test);
    const all = await g.salesCalls();
    for (const r of rows) r.calls = (all.get(r.ghl) ?? []).map((rec) => ({ rec, at: callAt(rec.properties, g.tz)?.at ?? null })).sort(byTime);
  } else {
    const b = await g.closers();
    if (!b.bound) throw new MetricError("closes are counted on the Closer pipeline, and none is bound (crm.pipeline_closer)");
    const won = b.cards.filter((k) => k.status === "won" && Date.parse(k.statusChangedAt) >= start.getTime() && Date.parse(k.statusChangedAt) < end.getTime() && !isTestContact({ tags: k.contactTags, emails: [k.contactEmail] }, g.domains))
      .sort((a, z) => Date.parse(a.statusChangedAt) - Date.parse(z.statusChangedAt));
    await g.fetchContacts(won.map((k) => k.contactId));
    const by = new Map<string, Row>();
    // a person with two won cards is one close; their value is every won card's (D73)
    for (const k of won) {
      const ct = g.contacts.get(k.contactId) ?? null, prev = by.get(k.contactId);
      const r = blank(k.contactId, k.contactId, ct ? personName(ct) : k.contactName || k.contactId, DateTime.fromISO(k.statusChangedAt).setZone(g.tz), ct);
      r.value = (prev?.value ?? 0) + (k.monetaryValue ?? 0); r.closer = k; r.test = isTest(ct);
      by.set(k.contactId, r);
    }
    rows = [...by.values()].filter((r) => !r.test);
    if (g.scObject) { const all = await g.salesCalls(); for (const r of rows) { r.calls = (all.get(r.ghl) ?? []).map((rec) => ({ rec, at: callAt(rec.properties, g.tz)?.at ?? null })).sort(byTime); r.call = r.calls[r.calls.length - 1] ?? null; } }
  }
  // the ledger's word that a person is the team's test contact counts too (D73)
  const facts = await ledgerFacts({ ...g.ctx(start, end), filters: {}, memo: { sources: new Map() } }, [...new Set(rows.map((r) => r.ghl).filter(Boolean))]);
  rows = rows.filter((r) => !facts.get(r.ghl)?.test);
  for (const r of rows) r.utm = facts.get(r.ghl)?.utm ?? null;
  if (unit !== "close") { const b = await g.closers(); for (const r of rows) r.closer = b.by.get(r.ghl) ?? null; }
  if (need.has("setter_card") || unit === "lead") { const b = await g.setters(); for (const r of rows) r.setter = b.by.get(r.ghl) ?? null; }
  if (need.has("discovery")) { const d = await g.discovery(); for (const r of rows) r.discovery = d.get(r.ghl) ?? []; }
  const pays = await g.payments();
  for (const r of rows) r.payments = pays.by.get(r.ghl) ?? [];
  if (unit === "call") {
    // a person's close and cash count once: on their latest showed call, else their latest call
    const byPerson = new Map<string, Row[]>();
    for (const r of rows) byPerson.set(r.ghl || r.key, [...(byPerson.get(r.ghl || r.key) ?? []), r]);
    for (const list of byPerson.values()) {
      const showed = list.filter((r) => r.call?.cls === "showed").sort((a, z) => a.at.toMillis() - z.at.toMillis());
      const last = showed[showed.length - 1];
      if (last && last.closer?.status === "won") last.closedMark = true;
      (last ?? [...list].sort((a, z) => a.at.toMillis() - z.at.toMillis())[list.length - 1]).cashMark = true;
    }
  }
  return rows;
}
const byTime = (a: { at: DateTime | null }, z: { at: DateTime | null }) => (a.at?.toMillis() ?? 0) - (z.at?.toMillis() ?? 0);

// ---- the analysis ---------------------------------------------------------------------------------------------------------
export type Group = {
  value: string; count: number; booked: number; calls: number; showed: number; noshow: number; cancelled: number; missing: number;
  closed: number; cash: number; card_value: number; days_to_close: number | null;
  booked_rate: number | null; show_rate: number | null; close_rate: number | null; share: number | null;
};
export type Mismatch = { kind: "won_no_payment" | "payment_no_won" | "cash_field"; name: string; date: string; contact_cash?: number; payments?: number };
export type Analysis = {
  metric: "analysis"; source: string; period_label: string; period_name: string; timezone: string;
  unit: GraphUnit; split: { column: string; name: string; multi: boolean } | null; filters: { column: string; name: string; equals: string }[];
  rate: Rate | null; total: Group; rows: Group[]; answered: number;
  /** rows with no answer to the split, by name: a gap to see, not to hide */
  unanswered: { name: string; date: string; booked: string }[];
  test: { p: number | null; verdict: string } | null;
  links: { what: string; linked: number; of: number; missing: string[] }[];
  mismatches: Mismatch[];
  payments: boolean;
  list?: { name: string; value: string; outcome: string }[];
};
export type AnalyzeQuery = { unit: GraphUnit; period: Period; split_by?: string; filter?: { column: string; equals: string }[]; list?: boolean; rate?: Rate };

/** χ² of a 2×K table (outcome yes / no, per answer): the statistic the permutation test shuffles. */
function chi2(groups: { n: number; s: number }[]): number {
  const N = groups.reduce((a, g) => a + g.n, 0), S = groups.reduce((a, g) => a + g.s, 0);
  if (!N || !S || S === N) return 0;
  return groups.reduce((a, g) => { const es = (g.n * S) / N, en = g.n - es; return a + (es ? (g.s - es) ** 2 / es : 0) + (en ? (g.n - g.s - en) ** 2 / en : 0); }, 0);
}
/** Whether the groups' rates differ by more than chance: 5,000 deterministic shuffles of the outcomes over the groups (D74). */
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

type Acc = { value: string; rows: Row[] };
function measure(unit: GraphUnit, a: Acc): Group & { showedPeople: number; closedOfShowed: number } {
  const g = { value: a.value, count: a.rows.length, booked: 0, calls: 0, showed: 0, noshow: 0, cancelled: 0, missing: 0, closed: 0, cash: 0, card_value: 0, days_to_close: null as number | null,
    booked_rate: null as number | null, show_rate: null as number | null, close_rate: null as number | null, share: null, showedPeople: 0, closedOfShowed: 0 };
  const days: number[] = [];
  // D76: a rescheduled slot is no call that could show; it is outside the show rate
  const tally = (cls: string | undefined) => { if (cls === "rescheduled") return; g.calls++; if (cls === "showed") g.showed++; else if (cls === "noshow") g.noshow++; else if (cls === "cancelled") g.cancelled++; else g.missing++; };
  for (const r of a.rows) {
    const won = r.closer?.status === "won";
    if (unit === "lead") {
      if (r.calls.length) g.booked++;
      for (const k of r.due) tally(k.cls);
      if (won) g.closed++;
      if (r.due.some((k) => k.cls === "showed")) { g.showedPeople++; if (won) g.closedOfShowed++; }
      g.cash += net(r.payments);
    } else if (unit === "call") {
      tally(r.call?.cls);
      if (r.closedMark) g.closed++;
      if (r.cashMark) g.cash += net(r.payments);
    } else {
      g.closed++; g.cash += net(r.payments); g.card_value += r.value;
      const first = r.calls.find((k) => k.at)?.at;
      if (first && r.at >= first) days.push(r.at.diff(first, "days").days);
    }
  }
  const div = (n: number, d: number) => (d ? n / d : null);
  g.booked_rate = unit === "lead" ? div(g.booked, g.count) : null;
  g.show_rate = unit === "close" ? null : div(g.showed, g.calls);
  g.close_rate = unit === "close" ? null : div(g.closed, g.showed);
  if (days.length) { const s = days.sort((x, y) => x - y), m = Math.floor(s.length / 2); g.days_to_close = s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }
  return g;
}
const shareOf = (unit: GraphUnit, rate: Rate | null, g: Group) => (unit === "close" ? g.count : rate === "booked_rate" ? g.booked : rate === "close_rate" ? g.closed : g.showed);
const RATE_WORDS: Record<Rate, { rates: string; of: string }> = { booked_rate: { rates: "booked rates", of: "leads" }, show_rate: { rates: "show rates", of: "calls" }, close_rate: { rates: "close rates", of: "people who showed" } };

export async function analyze(c: PoolClient, companyId: string, q: AnalyzeQuery, reads: GhlReads, now: Date = new Date()): Promise<Analysis> {
  if (!UNITS.includes(q.unit)) throw new MetricError(`unit is one of ${UNITS.join(", ")}`);
  const g = await open(c, companyId, reads, now);
  const names: Names = { stages: new Map(), users: new Map() };
  const cols = await columnDefs(g, q.unit, false, names);
  const defs = await g.defs();
  const split = q.split_by?.trim() ? resolve(cols, q.split_by, defs) : null;
  const filters = (q.filter ?? []).filter((f) => f.column?.trim()).map((f) => ({ col: resolve(cols, f.column, defs), equals: String(f.equals ?? "").trim() }));
  const used = [split, ...filters.map((f) => f.col)].filter((x): x is ColDef => !!x);
  const need = new Set(used.map((x) => x.ns));
  if (used.some((x) => /\.stage$/.test(x.column))) names.stages = await g.stages();
  if (split && /_card\.stage$/.test(split.column)) split.options = [...names.stages.values()];   // rows in the pipeline's own order
  if (used.some((x) => /\.assigned$/.test(x.column))) names.users = await g.users();
  const rate: Rate | null = q.unit === "close" ? null : q.rate && RATES[q.unit].includes(q.rate) ? q.rate : q.unit === "lead" ? "booked_rate" : "show_rate";
  let rows = await rowsOf(g, q.unit, q.period, need);
  const norm = (s: string) => s.trim().toLowerCase();
  for (const f of filters) {
    const want = norm(f.equals), label = f.col.keys?.[want];
    rows = rows.filter((r) => { const v = f.col.get(r).map(norm); return want === norm(NO_ANSWER) ? !v.length : v.includes(want) || (!!label && v.includes(norm(label))); });
  }
  const pays = await g.payments();
  const groups = new Map<string, Acc>();
  const answeredRows = split ? rows.filter((r) => split.get(r).length) : rows;
  if (split) for (const r of rows) for (const v of split.get(r).length ? split.get(r) : [NO_ANSWER]) { const a = groups.get(v) ?? { value: v, rows: [] }; a.rows.push(r); groups.set(v, a); }
  const total = measure(q.unit, { value: "Total", rows });
  const tShare = shareOf(q.unit, rate, total);
  const rank = (v: string) => { const i = split?.options?.indexOf(v) ?? -1; return v === NO_ANSWER ? 1e6 : i < 0 ? 1e5 : i; };
  const out = [...groups.values()].map((a) => measure(q.unit, a)).map((x) => ({ ...x, share: tShare ? shareOf(q.unit, rate, x) / tShare : null }))
    .sort((a, z) => rank(a.value) - rank(z.value) || z.count - a.count || a.value.localeCompare(z.value));
  let test: Analysis["test"] = null;
  if (split && rate) {
    const answered = out.filter((x) => x.value !== NO_ANSWER);
    const pair = (x: (typeof out)[number]) => (rate === "booked_rate" ? { n: x.count, s: x.booked } : rate === "show_rate" ? { n: x.calls, s: x.showed } : q.unit === "lead" ? { n: x.showedPeople, s: x.closedOfShowed } : { n: x.showed, s: x.closed });
    const gs = answered.map(pair), n = gs.reduce((a, x) => a + x.n, 0), w = RATE_WORDS[rate];
    if (gs.filter((x) => x.n > 0).length < 2) test = { p: null, verdict: "Fewer than two different answers here, so there is nothing to compare." };
    else if (n < MIN_N) test = { p: null, verdict: `Only ${n} ${w.of} have an answer to this question: too few to tell a pattern from chance.` };
    else {
      const p = permutationP(gs);
      test = { p, verdict: p < 0.05 ? `The ${w.rates} differ by more than chance would explain (p = ${p.toFixed(3)}).` : `A difference this size could easily be chance (p = ${p.toFixed(2)}); not enough to call it a pattern yet.` };
    }
  }
  const day = (r: Row) => r.at.toFormat("LLL d");
  const gap = (what: string, ok: (r: Row) => boolean) => ({ what, linked: rows.filter(ok).length, of: rows.length, missing: rows.filter((r) => !ok(r)).slice(0, NAMES).map((r) => `${r.name} (${day(r)})`) });
  const links: Analysis["links"] = [];
  if (q.unit === "call") { links.push(gap("a contact", (r) => !!r.contact)); if (g.bindings["crm.pipeline_closer"]) links.push(gap("a closer card", (r) => !!r.closer)); }
  if ((q.unit === "lead" || need.has("setter_card")) && g.bindings["crm.pipeline_setter"]) links.push(gap("a setter card", (r) => !!r.setter));
  if (q.unit === "lead" && need.has("closer_card")) links.push(gap("a closer card", (r) => !!r.closer));
  if (q.unit === "close" && g.scObject) links.push(gap("a Sales Call", (r) => r.calls.length > 0));
  const mismatches: Mismatch[] = [];
  if (pays.exist) {
    const cashDef = defs.find((d) => d.object === "contact" && (d.prop === g.bindings["crm.field_contact_cash_collected"] || d.key === "contact.cash_collected"));
    const seen = new Set<string>();
    for (const r of [...rows].sort((a, z) => a.at.toMillis() - z.at.toMillis())) {
      if (!r.ghl || seen.has(r.ghl)) continue;
      seen.add(r.ghl);
      const paid = r.payments.some((p) => p.flow === "in"), won = r.closer?.status === "won";
      if (won && !paid) mismatches.push({ kind: "won_no_payment", name: r.name, date: DateTime.fromISO(r.closer!.statusChangedAt).setZone(g.tz).toFormat("LLL d") });
      if (paid && !won) mismatches.push({ kind: "payment_no_won", name: r.name, date: r.payments.filter((p) => p.flow === "in").map((p) => p.at).sort((a, z) => a.toMillis() - z.toMillis())[0].toFormat("LLL d"), payments: net(r.payments) });
      if (cashDef && r.payments.length && r.contact) {
        const field = Number(text(r.contact.customFields[cashDef.prop]).replace(/[$,\s]/g, "")) || 0, sum = net(r.payments);
        if (Math.abs(field - sum) >= 0.01) mismatches.push({ kind: "cash_field", name: r.name, date: day(r), contact_cash: field, payments: sum });
      }
    }
  }
  const bookedDef = defs.find((f) => f.object === g.scObject && f.prop === "booking_source");
  const bookedAs = (r: Row) => answers(r.call?.rec.properties.booking_source, bookedDef)[0] ?? "";
  const outcome = (r: Row) => q.unit === "call" ? `${CLASS_WORDS[r.call?.cls ?? "missing"]}${r.closedMark ? ", closed" : ""}`
    : q.unit === "lead" ? [r.calls.length ? "booked" : "not booked", ...(r.due.some((k) => k.cls === "showed") ? ["showed"] : []), ...(r.closer?.status === "won" ? ["closed"] : [])].join(", ")
    : pays.exist ? `$${Math.round(net(r.payments)).toLocaleString("en-US")} paid` : "won";
  const tz = g.tz;
  return {
    metric: "analysis", source: GHL_SOURCE, period_label: q.period.label, period_name: q.period.name, timezone: tz, unit: q.unit,
    split: split ? { column: split.column, name: split.name, multi: split.type === "multi" } : null, filters: filters.map((f) => ({ column: f.col.column, name: f.col.name, equals: f.equals })),
    rate, total: { ...strip(total), share: tShare ? 1 : null }, rows: out.map(strip), answered: answeredRows.length,
    unanswered: split ? rows.filter((r) => !split.get(r).length).map((r) => ({ name: r.name, date: day(r), booked: q.unit === "call" ? bookedAs(r) : "" })) : [],
    test, links, mismatches, payments: pays.exist,
    ...(q.list ? { list: rows.slice(0, LIST_MAX).map((r) => ({ name: r.name, value: split ? split.get(r).join(", ") || NO_ANSWER : "", outcome: outcome(r) })) } : {}),
  };
}
const strip = (x: Group & { showedPeople?: number; closedOfShowed?: number }): Group => { const { showedPeople: _a, closedOfShowed: _b, ...g } = x; void _a; void _b; return g; };
