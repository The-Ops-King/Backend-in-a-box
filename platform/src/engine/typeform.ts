import type { PoolClient } from "pg";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { one } from "@/db/client";
import type { Adapters, Company, ContactSnapshot } from "@/adapters/types";
import { formFields, liveTypeform, type TfAnswer, type TfResponse, type TypeformApi } from "@/adapters/typeform/client";
import { loadCompany, type CompanyRow } from "./context";
import { dispatchEvent, emitEvent } from "./dispatch";
import { effectiveMode, handlerMode } from "./mode";
import { carriesTag, scopeTag } from "./scope";
import { attachIdentifier, boundFieldIds, normName, normPhone, upsertContact } from "./poll";
import { normEmail } from "./payments";

/**
 * D122: a Typeform form is a door straight into the engine, no Zapier. The engine registers its own webhook on each form the
 * install maps (signed with a secret it makes), checks it every health sweep and puts it back with one click. A submission
 * finds the person in GHL (email, then phone), creates or updates them with the scope tag, the standard fields, the
 * application fields and the UTMs, as the company's mode allows (shadow: the would-be write is recorded, nothing written),
 * and records `form.submitted` with the person in scope. One response id is one submission, however often Typeform delivers it.
 * Answers are mapped by the question's `ref`, never its words. The importer (typeform-import.ts) writes the old responses
 * through this same path.
 */
export const TF_TOKEN_KEY = "secret.typeform_token";
export const TF_FORMS_KEY = "typeform.forms";
export const TF_SECRET_KEY = "secret.typeform_webhook";
export const TF_TAG_KEY = "typeform.webhook_tag";
/** Typeform's own delivery rows (`seen`) and the real GHL write of a response (`written`), in `webhook_deliveries`. */
export const SEEN = "typeform", WRITTEN = "typeform_ghl";

/** The CRM's own contact fields an answer can go to; anything else is a contact field binding (`field_contact_…`, as in the install's `crm`). */
export const STANDARD = { first_name: "firstName", last_name: "lastName", email: "email", phone: "phone" } as const;
type Std = keyof typeof STANDARD;
const isStd = (t: string): t is Std => t in STANDARD;

/**
 * One form's map, by the question's `ref`: `answers` (ref → `first_name` | `last_name` | `email` | `phone` | a contact field
 * binding), `hidden` (hidden field name → binding), and where the submission time and the response id go. `tags`: more tags
 * besides the scope tag.
 */
export type TypeformFormMap = { name?: string; answers: Record<string, string>; hidden?: Record<string, string>; submittedAt?: string; responseId?: string; tags?: string[] };
export type TypeformForms = Record<string, TypeformFormMap>;

export const formsOf = (bindings: Record<string, string>): TypeformForms => { try { return JSON.parse(bindings[TF_FORMS_KEY] ?? "{}") as TypeformForms; } catch { return {}; } };
const targetsOf = (f: TypeformFormMap) => [...Object.values(f.answers ?? {}), ...Object.values(f.hidden ?? {}), ...(f.submittedAt ? [f.submittedAt] : []), ...(f.responseId ? [f.responseId] : [])];

/** What is wrong with a map's shape (install refuses it). */
export function mapProblems(forms: unknown): string[] {
  if (!forms || typeof forms !== "object" || Array.isArray(forms)) return ["typeform.forms: { <form id>: { answers: { <ref>: <target> } } }"];
  const out: string[] = [];
  for (const [id, f] of Object.entries(forms as Record<string, TypeformFormMap>)) {
    if (!/^[A-Za-z0-9]+$/.test(id)) out.push(`${id}: not a Typeform form id`);
    if (!f || typeof f !== "object" || !f.answers || typeof f.answers !== "object" || !Object.keys(f.answers).length) { out.push(`${id}: answers is required (ref → target)`); continue; }
    for (const t of targetsOf(f)) if (typeof t !== "string" || !(isStd(t) || /^field_contact_[a-z0-9_]+$/.test(t))) out.push(`${id}: target "${String(t)}" is neither ${Object.keys(STANDARD).join(", ")} nor a field_contact_… binding`);
    if (Object.values(f.hidden ?? {}).some(isStd) || (f.submittedAt && isStd(f.submittedAt)) || (f.responseId && isStd(f.responseId))) out.push(`${id}: hidden fields, the submission time and the response id go to contact fields`);
  }
  return out;
}
/** The field bindings a map writes that the company has not bound (the door does not open until there are none). */
export const unboundOf = (f: TypeformFormMap, bindings: Record<string, string>) => [...new Set(targetsOf(f).filter((t) => !isStd(t) && !bindings[`crm.${t}`]))];

export const publicBase = () => (process.env.PUBLIC_URL ?? process.env.TICK_URL ?? "").replace(/\/$/, "");
export const typeformWebhookUrl = (base: string, companyId: string) => `${base}/api/webhooks/typeform/${companyId}`;

/** `Typeform-Signature: sha256=<base64 of HMAC-SHA256(secret, the raw body)>` (typeform.com/developers, Secure your webhooks). */
export function verifyTypeformSignature(secret: string, header: string | null, raw: string): { ok: true } | { ok: false; why: string } {
  if (!header) return { ok: false, why: "no Typeform-Signature header" };
  const expected = `sha256=${createHmac("sha256", secret).update(raw, "utf8").digest("base64")}`;
  const a = Buffer.from(header.trim()), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b) ? { ok: true } : { ok: false, why: "signature mismatch" };
}

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
/** One answer as the words a TEXT field holds: a choice is its label (or what was typed under Other), several are joined, yes/no is Yes / No. */
export function answerText(a: TfAnswer): string | undefined {
  switch (a.type) {
    case "number": return typeof a.number === "number" ? String(a.number) : undefined;
    case "boolean": return a.boolean === true ? "Yes" : a.boolean === false ? "No" : undefined;
    case "choice": { const ch = (a.choice ?? {}) as { label?: unknown; other?: unknown }; return str(ch.label) ?? str(ch.other); }
    case "choices": { const ch = (a.choices ?? {}) as { labels?: unknown[]; other?: unknown }; const xs = [...(ch.labels ?? []), ch.other].map(str).filter((x): x is string => !!x); return xs.length ? xs.join(", ") : undefined; }
    default: { const v = a[a.type]; return typeof v === "number" ? String(v) : str(v); }
  }
}

export type Parsed = { responseId: string; submittedAt?: string; std: Partial<Record<Std, string>>; fields: { binding: string; id?: string; value: string }[]; unbound: string[]; filled: string[] };
/** A response read through the map: the person's standard fields, and every contact field the answers fill (by binding; `id` when bound). Unmapped questions and blank answers write nothing. */
export function parseResponse(form: TypeformFormMap, r: TfResponse, bindings: Record<string, string>): Parsed {
  const std: Parsed["std"] = {}, fields: Parsed["fields"] = [], filled: string[] = [];
  const put = (binding: string, value: string) => { fields.push({ binding, id: bindings[`crm.${binding}`] || undefined, value }); filled.push(binding); };
  for (const a of r.answers ?? []) {
    const target = form.answers[a.field?.ref]; if (!target) continue;
    const v = answerText(a); if (v === undefined) continue;
    if (isStd(target)) { std[target] = target === "email" ? v.toLowerCase() : v; filled.push(target); } else put(target, v);
  }
  for (const [name, target] of Object.entries(form.hidden ?? {})) { const v = str(r.hidden?.[name]); if (v) put(target, v); }
  const responseId = r.response_id ?? r.token;
  if (form.submittedAt && r.submitted_at) put(form.submittedAt, r.submitted_at);
  if (form.responseId) put(form.responseId, responseId);
  return { responseId, submittedAt: r.submitted_at, std, fields, unbound: [...new Set(fields.filter((f) => !f.id).map((f) => f.binding))], filled };
}

export type Found = { snap: ContactSnapshot; by: "email" | "phone" | "ledger" };
/** Tyler: the person in GHL by email, then by phone. Another business's contact may match: the same human, so the same record. */
export async function findInGhl(ac: Company, adapters: Adapters, email?: string, phone?: string): Promise<Found | null> {
  const dup = adapters.read.findDuplicate;
  if (!dup) throw new Error("the CRM adapter cannot look a contact up by email or phone");
  if (email) { const s = await dup(ac, { email }); if (s) return { snap: s, by: "email" }; }
  if (phone) { const s = await dup(ac, { phone }); if (s) return { snap: s, by: "phone" }; }
  return null;
}

export type WritePlan = { action: "create" | "update"; ghlContactId?: string; standard: Partial<Record<(typeof STANDARD)[Std], string>>; customFields: { id: string; field_value: string }[]; tags: string[]; source?: string; fields: string[]; kept: string[] };
/**
 * What the write is. A new contact gets everything. An existing one (maybe another business's in a shared location) gets the
 * application fields and UTMs, the tags it lacks (added one by one: a PUT's `tags` would replace them all), and only the
 * standard fields GHL has blank: a name, email or phone it already holds is never overwritten (`kept` says which differed).
 */
export function planWrite(p: Parsed, found: ContactSnapshot | null, tags: string[], source?: string): WritePlan {
  const standard: WritePlan["standard"] = {}, kept: string[] = [];
  for (const [k, v] of Object.entries(p.std) as [Std, string][]) {
    const key = STANDARD[k], have = found ? str((found as Record<string, unknown>)[key]) : undefined;
    if (!have) standard[key] = v;
    else if ((k === "email" ? have.toLowerCase() : k === "phone" ? normPhone(have) : have) !== (k === "phone" ? normPhone(v) : v)) kept.push(k);
  }
  const customFields = p.fields.filter((f) => f.id).map((f) => ({ id: f.id!, field_value: f.value }));
  const lacking = tags.filter((t) => !carriesTag(found?.tags, t.toLowerCase()));
  return { action: found ? "update" : "create", ...(found ? { ghlContactId: found.id } : {}), standard, customFields, tags: lacking, ...(found ? {} : source ? { source } : {}), fields: p.fields.filter((f) => f.id).map((f) => f.binding), kept };
}

/** The real write. A create GHL refuses as a duplicate (the location allows none; its search can lag a create) is found again and updated. */
export async function applyWrite(ac: Company, adapters: Adapters, plan: WritePlan, p: Parsed, retag: () => string[]): Promise<{ id: string; action: "create" | "update"; tagsAdded: string[] }> {
  if (plan.action === "create") {
    try {
      const { id } = await adapters.write.createContact(ac, { ...plan.standard, tags: plan.tags, customFields: plan.customFields, ...(plan.source ? { source: plan.source } : {}) });
      return { id, action: "create", tagsAdded: plan.tags };
    } catch (e) {
      if (!/duplicat/i.test(String((e as Error).message))) throw e;
      const again = await findInGhl(ac, adapters, p.std.email, p.std.phone);
      if (!again) throw e;
      return applyWrite(ac, adapters, planWrite(p, again.snap, retag(), plan.source), p, retag);
    }
  }
  const id = plan.ghlContactId!;
  if (Object.keys(plan.standard).length || plan.customFields.length) await adapters.write.updateContact(ac, id, { ...plan.standard, customFields: plan.customFields });
  for (const t of plan.tags) await adapters.write.addTag(ac, id, t);
  return { id, action: "update", tagsAdded: plan.tags };
}

/** The ledger's person for the submission: GHL's record when there is one (replicated as the poll would), else one the ledger knows by email or phone, else a new replica that waits for a GHL id. `isNew`: the ledger did not know them. */
async function ledgerPerson(c: PoolClient, co: CompanyRow, bindings: Record<string, string>, p: Parsed, found: Found | null): Promise<{ id: string; isNew: boolean }> {
  const email = normEmail(p.std.email), phone = normPhone(p.std.phone);
  const known = await one<{ contact_id: string }>(c, `select contact_id from contact_identifiers where company_id=$1 and retired_at is null
    and ((kind='ghl_contact' and value=$2) or (kind='email' and value=$3) or (kind='phone' and value=$4)) order by (kind='ghl_contact') desc limit 1`, [co.id, found?.snap.id ?? "", email ?? "", phone ?? ""]);
  if (found) return { id: (await upsertContact(c, co.id, co.timezone, found.snap, boundFieldIds(bindings))).id, isNew: !known };
  if (known) return { id: known.contact_id, isNew: false };
  const row = (await one<{ id: string }>(c, "insert into contacts (company_id, first_name, last_name, timezone, timezone_source) values ($1,$2,$3,$4,'company_default') returning id", [co.id, normName(p.std.first_name), normName(p.std.last_name), co.timezone]))!;
  if (email) await attachIdentifier(c, co.id, row.id, "email", email);
  if (phone) await attachIdentifier(c, co.id, row.id, "phone", phone);
  return { id: row.id, isNew: true };
}

export type Submitted =
  | { outcome: "duplicate" | "already_written"; responseId: string }
  | { outcome: "unidentified"; responseId: string }
  | { outcome: "recorded"; responseId: string; contactId: string; shadow: boolean; action: "create" | "update"; matched: Found["by"] | null; ghlContactId: string | null; lead: boolean; runsStarted: number };

/**
 * One submission, from the webhook or the importer. The webhook: a response already seen is a no-op (Typeform retries); the
 * write follows the mode (`effectiveMode` over the rung of what answers `form.submitted`, as D117's tag write); a person the
 * ledger did not know is a new lead (`lead.created`, as the contacts poll would make it, made here and once: the replica is
 * written first, so the poll sees no one new); `form.submitted` starts what listens. The importer (`real`): a deliberate real
 * write whatever the mode; a response already written is skipped; history starts nothing (no lead, no dispatch).
 */
export async function submitApplication(c: PoolClient, co: CompanyRow, ac: Company, bindings: Record<string, string>, adapters: Adapters, formId: string, form: TypeformFormMap, r: TfResponse, opts: { via: "webhook" | "import"; real?: boolean }): Promise<Submitted> {
  const responseId = r.response_id ?? r.token, key = `${formId}:${responseId}`;
  const seen = !!(await one(c, `insert into webhook_deliveries (company_id, provider, delivery_id) values ($1,'${SEEN}',$2) on conflict do nothing returning delivery_id`, [co.id, key]));
  if (opts.via === "webhook" && !seen) return { outcome: "duplicate", responseId };
  if (opts.via === "import" && (await one(c, `select 1 from webhook_deliveries where company_id=$1 and provider='${WRITTEN}' and delivery_id=$2`, [co.id, key]))) return { outcome: "already_written", responseId };
  const p = parseResponse(form, r, bindings);
  const base = { company_id: co.id, opportunity_id: null, appointment_id: null, source: "form" } as const;
  const at = r.submitted_at ? new Date(r.submitted_at) : undefined;
  const about = { form_id: formId, form_name: form.name ?? null, response_id: responseId, submitted_at: r.submitted_at ?? null, via: opts.via };
  if (!p.std.email && !p.std.phone) {
    if (seen) await emitEvent(c, { ...base, contact_id: null, event_type: "form.submitted", occurred_at: at, data: { ...about, unidentified: true } });
    return { outcome: "unidentified", responseId };
  }
  let found = await findInGhl(ac, adapters, p.std.email, p.std.phone);
  if (!found) {
    // GHL's search can lag a contact made seconds ago (a second submission right after the first): the ledger's GHL id for them stands in
    const mine = await one<{ ghl: string }>(c, `select ct.ghl_contact_id as ghl from contact_identifiers i join contacts ct on ct.id=i.contact_id where i.company_id=$1 and i.retired_at is null and ct.ghl_contact_id is not null
      and ((i.kind='email' and i.value=$2) or (i.kind='phone' and i.value=$3)) limit 1`, [co.id, normEmail(p.std.email) ?? "", normPhone(p.std.phone) ?? ""]);
    const snap = mine ? await adapters.read.getContact(ac, mine.ghl) : null;
    if (snap) found = { snap, by: "ledger" };
  }
  const person = await ledgerPerson(c, co, bindings, p, found);
  const tags = [...new Set([scopeTag(bindings), ...(form.tags ?? [])].filter((t): t is string => !!t?.trim()).map((t) => t.trim().toLowerCase()))];
  const real = opts.real === true || (await effectiveMode(c, co.id, person.id, await handlerMode(c, co.id, "form.submitted"), bindings)) === "real";
  const plan = planWrite(p, found?.snap ?? null, tags, form.name ? `Typeform: ${form.name}` : "Typeform");
  let ghlId = found?.snap.id ?? null, action = plan.action, tagsDone = plan.tags;
  if (real) {
    const w = await applyWrite(ac, adapters, plan, p, () => tags);
    ghlId = w.id; action = w.action; tagsDone = w.tagsAdded;
    const after = await adapters.read.getContact(ac, w.id);
    if (after) await upsertContact(c, co.id, co.timezone, after, boundFieldIds(bindings));
    else {   // GHL does not show it yet: the replica takes the id and the tags it was written with, so the poll sees no one new
      await c.query("update contacts set ghl_contact_id=$2, tags=array(select distinct unnest(tags || $3::text[])), updated_at=now() where id=$1", [person.id, w.id, tags]);
      await attachIdentifier(c, co.id, person.id, "ghl_contact", w.id);
    }
    await c.query(`insert into webhook_deliveries (company_id, provider, delivery_id) values ($1,'${WRITTEN}',$2) on conflict do nothing`, [co.id, key]);
  }
  for (const tag of tagsDone) await emitEvent(c, { ...base, contact_id: person.id, event_type: "tag.added", occurred_at: at, data: { tag, by: "form", ...(real ? {} : { shadow: true }) } });
  const data = { ...about, matched: found?.by ?? null, ghl_contact_id: ghlId, action, shadow: !real, fields: plan.fields, ...(plan.kept.length ? { kept: plan.kept } : {}), ...(p.unbound.length ? { unbound: p.unbound } : {}),
    // in shadow the would-be write is the record, as a step's would-have is (D52): the values included
    ...(real ? {} : { would_write: { action: plan.action, ...(plan.ghlContactId ? { ghl_contact_id: plan.ghlContactId } : {}), standard: plan.standard, tags: plan.tags, fields: Object.fromEntries(p.fields.filter((f) => f.id).map((f) => [f.binding, f.value])) } }) };
  if (opts.via === "import") {
    if (seen) await emitEvent(c, { ...base, contact_id: person.id, event_type: "form.submitted", occurred_at: at, data });
    await c.query("insert into audit_log (company_id, action, target_type, target_id, after) values ($1,'typeform.imported','contact',$2,$3)", [co.id, person.id, { form_id: formId, response_id: responseId, action, ghl_contact_id: ghlId, matched: found?.by ?? null }]);
    return { outcome: "recorded", responseId, contactId: person.id, shadow: false, action, matched: found?.by ?? null, ghlContactId: ghlId, lead: false, runsStarted: 0 };
  }
  const ctx = { contact: { id: person.id, ghl_contact_id: ghlId, tags }, form: { id: formId, name: form.name ?? null, response_id: responseId } };
  let runs = 0;
  // D122: a person new to the company is a new lead, the way a newly tagged contact is (New lead fires once, here, not again from the poll)
  if (person.isNew) runs += (await dispatchEvent(c, await emitEvent(c, { ...base, contact_id: person.id, event_type: "lead.created", data: { ghl_contact_id: ghlId, form_id: formId, response_id: responseId, shadow: !real } }), ctx)).length;
  // the clean place for qualification (D73's `qualify`, not decided yet): a workflow on form.submitted reading the bound application field
  runs += (await dispatchEvent(c, await emitEvent(c, { ...base, contact_id: person.id, event_type: "form.submitted", occurred_at: at, data }), ctx)).length;
  return { outcome: "recorded", responseId, contactId: person.id, shadow: !real, action, matched: found?.by ?? null, ghlContactId: ghlId, lead: person.isNew, runsStarted: runs };
}

/** The webhook door: signature first (401 makes Typeform retry, so a secret put back in place heals it), then one submission. */
export async function receiveTypeform(c: PoolClient, companyId: string, signature: string | null, raw: string, adapters: Adapters): Promise<{ status: number; body: Record<string, unknown> }> {
  const { row, adapterCompany, bindings } = await loadCompany(c, companyId);
  const secret = bindings[TF_SECRET_KEY];
  if (!secret) return { status: 401, body: { error: "typeform webhook secret not bound for this company" } };
  const v = verifyTypeformSignature(secret, signature, raw);
  if (!v.ok) return { status: 401, body: { error: v.why } };
  let body: { event_type?: string; form_response?: TfResponse & { form_id?: string } };
  try { body = JSON.parse(raw); } catch { return { status: 400, body: { error: "body is not JSON" } }; }
  if (body.event_type !== "form_response" || !body.form_response) return { status: 200, body: { ok: true, ignored: body.event_type ?? "no event type" } };
  const formId = body.form_response.form_id ?? "", form = formsOf(bindings)[formId];
  if (!form) return { status: 200, body: { ok: true, ignored: `form ${formId} is not mapped for this company` } };
  const r = await submitApplication(c, row, adapterCompany, bindings, adapters, formId, form, body.form_response, { via: "webhook" });
  return { status: 200, body: { ok: true, ...r } };
}

/**
 * Registers (or puts back) the engine's webhook on every mapped form: one tag and one secret per company, made once and
 * kept, so a re-install or a re-register changes nothing Typeform already has right. A form whose map writes a field the
 * company has not bound is not registered: the door opens only when every answer has somewhere to go.
 */
export async function registerTypeform(companyId: string, slug: string, bindings: Record<string, string>, bind: (key: string, kind: "secret" | "text", value: string) => Promise<void>, api: TypeformApi = liveTypeform, base = publicBase()): Promise<string[]> {
  const token = bindings[TF_TOKEN_KEY], forms = formsOf(bindings);
  if (!token) throw new Error("no Typeform token bound");
  if (!base) throw new Error("PUBLIC_URL is not set: cannot tell Typeform where to deliver");
  const tag = bindings[TF_TAG_KEY] || `biab-${slug}`, secret = bindings[TF_SECRET_KEY] || `tfwh_${randomBytes(24).toString("base64url")}`;
  if (!bindings[TF_TAG_KEY]) await bind(TF_TAG_KEY, "text", tag);
  if (!bindings[TF_SECRET_KEY]) await bind(TF_SECRET_KEY, "secret", secret);
  const url = typeformWebhookUrl(base, companyId), out: string[] = [];
  for (const [formId, f] of Object.entries(forms)) {
    const unbound = unboundOf(f, bindings);
    if (unbound.length) { out.push(`${formId}: webhook NOT registered, not bound yet: ${unbound.join(", ")}`); continue; }
    await api.putWebhook(token, formId, tag, url, secret);
    out.push(`${formId}: webhook "${tag}" → ${url}`);
  }
  return out;
}

/** Install's check of a map against the form itself (token given): every mapped ref is a question of the form, every hidden name one of its hidden fields. */
export async function checkMapAgainstForms(token: string, forms: TypeformForms, api: TypeformApi = liveTypeform): Promise<string[]> {
  const out: string[] = [];
  for (const [formId, f] of Object.entries(forms)) {
    let form; try { form = await api.getForm(token, formId); } catch (e) { out.push(`${formId}: the token cannot read the form (${String((e as Error).message).slice(0, 120)})`); continue; }
    const refs = new Set(formFields(form).map((x) => x.ref));
    for (const ref of Object.keys(f.answers)) if (!refs.has(ref)) out.push(`${formId}: no question has ref ${ref}`);
    for (const h of Object.keys(f.hidden ?? {})) if (!(form.hidden ?? []).includes(h)) out.push(`${formId}: no hidden field "${h}"`);
  }
  return out;
}
