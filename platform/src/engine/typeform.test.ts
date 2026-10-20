/**
 * D122: Typeform straight into the engine. The engine registers its own signed webhook on each mapped form, the door takes a
 * signed delivery once (Typeform retries), finds the person in GHL by email then phone, writes them as the mode allows (shadow:
 * only the would-be write is recorded), and records form.submitted with the person in scope. D123: the tag and New lead are
 * the New from Typeform workflow's steps (Dating (Nelly)'s own, built by build-copies), New lead once a person. The importer
 * reads the old responses: a dry run writes nothing; apply writes each response once, and with newLead runs each new one
 * through the same workflow. The health sweep verifies the webhook and the fix puts it back.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHmac } from "node:crypto";
import { DateTime } from "luxon";
import { asOperator, many, one } from "@/db/client";
import { migrate } from "@/db/migrate";
import { installCompany } from "@/engine/install";
import { loadCompany } from "@/engine/context";
import { pollCompany } from "@/engine/poll";
import { normPhone } from "@/engine/identity";
import { inScope } from "@/engine/scope";
import { setBinding } from "@/engine/settings";
import { runHealthStep, setProbeRetryMs } from "@/engine/health";
import { fakeAdapters, fakeProbes } from "@/engine/test-install";
import { receiveTypeform, registerTypeform, verifyTypeformSignature, answerText, TF_SECRET_KEY, type TypeformFormMap } from "@/engine/typeform";
import { applyImport, dryRunImport } from "@/engine/typeform-import";
import { createCompanyWorkflow } from "@/engine/definitions";
import { dispatchEvent, emitEvent } from "@/engine/dispatch";
import { tick } from "@/engine/runner";
import fs from "node:fs";
import path from "node:path";
import type { Adapters, ContactSnapshot } from "@/adapters/types";
import type { TfResponse, TfWebhook, TypeformApi } from "@/adapters/typeform/client";

process.env.BINDINGS_KEY ??= Buffer.alloc(32, 7).toString("base64");
process.env.PUBLIC_URL = "https://engine.test";
const FORM = "FORM1";
const map: TypeformFormMap = {
  name: "VIP Matchmaking Application",
  answers: { r_first: "first_name", r_last: "last_name", r_phone: "phone", r_email: "email", r_age: "field_contact_app_age", r_status: "field_contact_app_relationship_status", r_kids: "field_contact_app_has_children", r_partner: "field_contact_app_ideal_partner", r_consent: "field_contact_app_consent" },
  hidden: { utm_source: "field_contact_utm_source", fbclid: "field_contact_fbclid" },
  submittedAt: "field_contact_app_submitted_at", responseId: "field_contact_app_response_id",
};
const NEW_FROM_TYPEFORM = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../installs/dating-nelly/new-from-typeform.json"), "utf8")) as { name: string; note: string; definition: unknown; create: { stage: string; sort: number } };
const crmIds = { pipeline_setter: "P-S", stage_setter_new_lead: "ST-NEW", field_contact_app_age: "F_AGE", field_contact_app_relationship_status: "F_STATUS", field_contact_app_has_children: "F_KIDS", field_contact_app_ideal_partner: "F_PARTNER", field_contact_app_consent: "F_CONSENT", field_contact_utm_source: "F_UTM", field_contact_fbclid: "F_FB", field_contact_app_submitted_at: "F_SUB", field_contact_app_response_id: "F_RID" };

// Typeform as the form has it: refs are what count; the question words below are not what the map reads
const hooks = new Map<string, TfWebhook>(), puts: { form: string; tag: string; url: string; secret: string }[] = [];
let history: TfResponse[] = [], partial: TfResponse[] = [];
const tf: TypeformApi = {
  getForm: async (_t, id) => ({ id, title: "VIP Matchmaking Application", hidden: ["utm_source", "fbclid"], fields: Object.keys(map.answers).map((ref, i) => ({ id: `q${i}`, ref, type: "short_text", title: `Question ${i}` })) }),
  responses: async (_t, _id, type) => (type === "completed" ? [...history].reverse() : type === "partial" ? partial : []),
  getWebhook: async (_t, form, tag) => { const h = hooks.get(`${form}:${tag}`); return h ? { ok: true, found: true, hook: h } : { ok: true, found: false }; },
  putWebhook: async (_t, form, tag, url, secret) => { puts.push({ form, tag, url, secret }); const h = { tag, url, enabled: true, event_types: { form_response: true } }; hooks.set(`${form}:${tag}`, h); return h; },
};

// GHL as the shared location holds it: another business's contacts the applicants may be
let n = 0;
const crm = new Map<string, ContactSnapshot>();
const writes: { op: string; id?: string; body: unknown }[] = [];
let updated: ContactSnapshot[] = [];
const now = () => DateTime.now().toUTC().toISO()!;
const base = fakeAdapters();
const fake: Adapters = { ...base,
  read: { ...base.read,
    findDuplicate: async (_c, by) => [...crm.values()].find((k) => ("email" in by ? k.email?.toLowerCase() === by.email.toLowerCase() : !!k.phone && normPhone(k.phone) === normPhone(by.phone))) ?? null,
    getContact: async (_c, id) => crm.get(id) ?? null,
    contactsChangedSince: async () => updated },
  write: { ...base.write,
    createContact: async (_c, input) => { const id = `G${++n}`; writes.push({ op: "create", id, body: input }); crm.set(id, { id, firstName: input.firstName, lastName: input.lastName, email: input.email, phone: input.phone, tags: input.tags ?? [], customFields: Object.fromEntries((input.customFields ?? []).map((f) => [f.id, f.field_value])), dateUpdated: now(), dateAdded: now() }); return { id }; },
    updateContact: async (_c, id, patch) => { writes.push({ op: "update", id, body: patch }); const k = crm.get(id)!; crm.set(id, { ...k, ...(patch.firstName ? { firstName: patch.firstName } : {}), ...(patch.lastName ? { lastName: patch.lastName } : {}), ...(patch.email ? { email: patch.email } : {}), ...(patch.phone ? { phone: patch.phone } : {}), customFields: { ...k.customFields, ...Object.fromEntries((patch.customFields ?? []).map((f) => [f.id, f.field_value])) }, dateUpdated: now() }); },
    addTag: async (_c, id, tag) => { writes.push({ op: "tag", id, body: tag }); const k = crm.get(id)!; crm.set(id, { ...k, tags: [...k.tags, tag] }); },
  },
};
const other = (id: string, o: Partial<ContactSnapshot>) => crm.set(id, { id, tags: ["hair-client"], customFields: { THEIRS: "kept" }, dateUpdated: now(), dateAdded: now(), ...o });

const response = (token: string, o: { first?: string; email?: string; phone?: string; age?: number; status?: string; partner?: string; utm?: string; at?: string; consent?: boolean } = {}): TfResponse => ({
  token, response_id: token, submitted_at: o.at ?? now(), landed_at: o.at ?? now(), hidden: { utm_source: o.utm ?? "", fbclid: "" },
  // in another order than the form, and with a question the map does not know: only the ref decides where an answer goes
  answers: [
    { field: { id: "x1", ref: "r_status", type: "multiple_choice" }, type: "choice", choice: { label: o.status ?? "Divorced" } },
    { field: { id: "x2", ref: "r_email", type: "email" }, type: "email", email: o.email ?? `${token}@x.com` },
    { field: { id: "x3", ref: "r_first", type: "short_text" }, type: "text", text: o.first ?? "Ann" },
    { field: { id: "x4", ref: "r_last", type: "short_text" }, type: "text", text: "Doe" },
    { field: { id: "x5", ref: "r_phone", type: "phone_number" }, type: "phone_number", phone_number: o.phone ?? `+1555${String(Math.floor(Math.random() * 1e7)).padStart(7, "0")}` },
    { field: { id: "x6", ref: "r_age", type: "number" }, type: "number", number: o.age ?? 41 },
    { field: { id: "x7", ref: "r_kids", type: "yes_no" }, type: "boolean", boolean: false },
    { field: { id: "x8", ref: "r_unmapped", type: "short_text" }, type: "text", text: "not mapped" },
    ...(o.partner === undefined ? [] : [{ field: { id: "x9", ref: "r_partner", type: "long_text" }, type: "text", text: o.partner }]),
    ...(o.consent ? [{ field: { id: "x10", ref: "r_consent", type: "checkbox" }, type: "choices", choices: { labels: ["I acknowledge and consent"] } }] : []),
  ],
});
const payload = (r: TfResponse) => JSON.stringify({ event_id: `ev-${r.token}`, event_type: "form_response", form_response: { form_id: FORM, ...r, definition: { id: FORM, title: "renamed", fields: [{ ref: "r_age", title: "A question reworded since" }] } } });

let companyId = "", slug = "", secret = "";
const sign = (raw: string, key = secret) => `sha256=${createHmac("sha256", key).update(raw).digest("base64")}`;
const deliver = (raw: string, sig: string | null = sign(raw)) => asOperator((c) => receiveTypeform(c, companyId, sig, raw, fake));
/** The runs the door's dispatch started: New from Typeform, and New lead after it. */
const settle = async () => { for (let i = 0; i < 3; i++) await tick(fake, DateTime.now() as DateTime<true>, companyId); };
const runsOf = (wf: string, contactId: string) => asOperator((c) => many<{ id: string; status: string }>(c, "select r.id, r.status from runs r join workflows w on w.id=r.workflow_id where r.company_id=$1 and w.name=$2 and r.contact_id=$3 order by r.started_at", [companyId, wf, contactId]));
const setMode = (mode: string) => asOperator((c) => c.query("update companies set mode=$2 where id=$1", [companyId, mode]));
const events = (type: string, contactId?: string) => asOperator((c) => many<{ contact_id: string | null; data: Record<string, unknown>; source: string }>(c, `select contact_id, data, source from events where company_id=$1 and event_type=$2 ${contactId ? "and contact_id=$3" : ""} order by id`, contactId ? [companyId, type, contactId] : [companyId, type]));
const ledger = (ghl: string) => asOperator((c) => one<{ id: string; tags: string[] }>(c, "select id, tags from contacts where company_id=$1 and ghl_contact_id=$2", [companyId, ghl]));
const byEmail = (email: string) => asOperator((c) => one<{ id: string; ghl_contact_id: string | null; tags: string[] }>(c, "select ct.id, ct.ghl_contact_id, ct.tags from contacts ct join contact_identifiers i on i.contact_id=ct.id where i.company_id=$1 and i.kind='email' and i.value=$2", [companyId, email]));

describe.skipIf(!process.env.DATABASE_URL)("Typeform into the engine (D122)", () => {
  beforeAll(async () => {
    await migrate(); setProbeRetryMs(0);
    slug = `tf-${Date.now()}`;
    const r = await installCompany({ name: "Dating TF", slug, timezone: "UTC", locationId: "LOC", pit: "pit", calendars: {}, scopeTag: "dating", crm: crmIds, typeform: { token: "tf-token", forms: { [FORM]: map } }, templates: ["new-lead"], enable: true }, fake, tf);
    companyId = r.companyId;
    // D123: her own New from Typeform, as the definition route makes it, turned on
    const made = await asOperator((c) => createCompanyWorkflow(c, { companyId, name: NEW_FROM_TYPEFORM.name, definition: NEW_FROM_TYPEFORM.definition, note: NEW_FROM_TYPEFORM.note, ...NEW_FROM_TYPEFORM.create }));
    expect(made).toMatchObject({ ok: true, created: true, layout: "tidy" });
    await asOperator((c) => c.query("update workflows set enabled=true where company_id=$1 and name in ('New from Typeform', 'New lead')", [companyId]));
    expect(r.typeform).toEqual([`${FORM}: webhook "biab-${slug}" → https://engine.test/api/webhooks/typeform/${companyId}`]);
    secret = (await asOperator((c) => loadCompany(c, companyId))).bindings[TF_SECRET_KEY];
    await asOperator((c) => c.query("update companies set status='onboarding' where id=$1", [companyId]));
    await pollCompany(fake, companyId);   // the silent baseline
  }, 60_000);
  afterAll(async () => { if (companyId) await asOperator((c) => c.query("update runs set status='exited', next_run_at=null where company_id=$1", [companyId])); });

  it("install binds the token as a secret and the map, and registers one signed webhook per form; a re-install keeps the tag and the secret", async () => {
    const { bindings } = await asOperator((c) => loadCompany(c, companyId));
    const kinds = Object.fromEntries((await asOperator((c) => many<{ key: string; kind: string }>(c, "select key, kind from bindings where company_id=$1 and key like '%typeform%'", [companyId]))).map((b) => [b.key, b.kind]));
    expect(kinds).toEqual({ "secret.typeform_token": "secret", "typeform.forms": "text", "secret.typeform_webhook": "secret", "typeform.webhook_tag": "text" });
    expect(bindings["secret.typeform_token"]).toBe("tf-token");
    expect(secret).toMatch(/^tfwh_.{20,}/);
    expect(puts).toEqual([{ form: FORM, tag: `biab-${slug}`, url: `https://engine.test/api/webhooks/typeform/${companyId}`, secret }]);
    await installCompany({ name: "Dating TF", slug, timezone: "UTC", locationId: "LOC", typeform: { forms: { [FORM]: map } } }, fake, tf);
    expect(puts.at(-1)).toEqual(puts[0]);
    expect((await asOperator((c) => loadCompany(c, companyId))).bindings[TF_SECRET_KEY]).toBe(secret);
    // a ref the form does not have is refused at install; a field not bound yet keeps the door shut
    await expect(installCompany({ name: "Dating TF", slug, timezone: "UTC", locationId: "LOC", typeform: { token: "tf-token", forms: { [FORM]: { ...map, answers: { ...map.answers, r_gone: "field_contact_app_age" } } } } }, fake, tf)).rejects.toThrow(/no question has ref r_gone/);
    const lines = await registerTypeform(companyId, slug, { ...bindings, "typeform.forms": JSON.stringify({ [FORM]: { ...map, answers: { ...map.answers, r_age: "field_contact_app_unmade" } } }) }, async () => {}, tf);
    expect(lines).toEqual([`${FORM}: webhook NOT registered, not bound yet: field_contact_app_unmade`]);
  });

  it("the signature: Typeform's sha256= base64 HMAC of the raw body; a bad or missing one is refused and records nothing", async () => {
    const raw = payload(response("sig1"));
    expect(verifyTypeformSignature("k", sign(raw, "k"), raw)).toEqual({ ok: true });
    expect(verifyTypeformSignature("k", sign(raw, "other"), raw).ok).toBe(false);
    expect(await deliver(raw, sign(raw, "not-the-secret"))).toMatchObject({ status: 401 });
    expect(await deliver(raw, null)).toMatchObject({ status: 401 });
    expect(await deliver(raw.replace("Ann", "Bob"), sign(raw))).toMatchObject({ status: 401 });
    expect(await events("form.submitted")).toEqual([]);
    expect(await asOperator((c) => many(c, "select 1 from webhook_deliveries where company_id=$1", [companyId]))).toEqual([]);
  });

  it("shadow: nothing is written to GHL; the would-be write is recorded; the applicant is in scope untagged; New from Typeform records the tag and makes them a new lead once", async () => {
    await setMode("ghost");
    const r = response("sh1", { email: "Shadow@X.com", utm: "fb", partner: "Kind and steady." });
    const out = await deliver(payload(r));
    expect(out).toMatchObject({ status: 200, body: { outcome: "recorded", ghost: true, action: "create", matched: null } });
    expect(writes).toEqual([]);
    const p = await byEmail("shadow@x.com");
    expect(p).toMatchObject({ ghl_contact_id: null, tags: [] });
    const [ev] = await events("form.submitted", p!.id);
    expect(ev.source).toBe("form");
    expect(ev.data).toMatchObject({ form_id: FORM, response_id: "sh1", ghost: true, via: "webhook", would_write: { action: "create", standard: { firstName: "Ann", lastName: "Doe", email: "shadow@x.com" },
      fields: { field_contact_app_age: "41", field_contact_app_relationship_status: "Divorced", field_contact_app_has_children: "No", field_contact_app_ideal_partner: "Kind and steady.", field_contact_utm_source: "fb", field_contact_app_submitted_at: r.submitted_at, field_contact_app_response_id: "sh1" } } });
    expect(Object.keys((ev.data.would_write as { fields: object }).fields)).not.toContain("field_contact_fbclid");   // blank hidden field: nothing
    expect(ev.data.would_write).not.toHaveProperty("tags");   // D123: the door writes no tag
    // in scope by the submission alone, before anything has run, untagged (D117/D122)
    expect(await events("tag.added", p!.id)).toEqual([]);
    expect(await events("lead.created", p!.id)).toEqual([]);
    expect(await asOperator((c) => inScope(c, p!.id, "dating"))).toBe(true);
    await settle();
    expect(writes).toEqual([]);
    expect((await events("tag.added", p!.id)).filter((e) => e.data.tag === "dating")).toEqual([expect.objectContaining({ source: "engine", data: { tag: "dating", ghost: true } })]);
    expect(await events("lead.created", p!.id)).toEqual([expect.objectContaining({ source: "engine", data: expect.objectContaining({ form_id: FORM, response_id: "sh1", by: "form" }) })]);
    expect(await runsOf("New lead", p!.id)).toHaveLength(1);
    expect((await byEmail("shadow@x.com"))!.tags).toEqual([]);   // shadow: the replica keeps GHL's tags (none)
  });

  it("a retried delivery is one submission: the second answers duplicate and writes nothing", async () => {
    await setMode("live");
    const raw = payload(response("dup1", { email: "dup@x.com" }));
    expect((await deliver(raw)).body).toMatchObject({ outcome: "recorded", ghost: false, action: "create" });
    const w = writes.length;
    expect((await deliver(raw)).body).toMatchObject({ outcome: "duplicate", responseId: "dup1" });
    expect(writes.length).toBe(w);
    const p = await byEmail("dup@x.com");
    expect(await events("form.submitted", p!.id)).toHaveLength(1);
    await settle();
    expect(await events("lead.created", p!.id)).toHaveLength(1);
    expect(await runsOf("New from Typeform", p!.id)).toHaveLength(1);
  });

  it("live, a new person: one contact made with the standard fields and the application fields by ref; New from Typeform tags them and makes one lead; the poll makes no second", async () => {
    await setMode("live");
    writes.length = 0;
    const r = response("new1", { email: "new@x.com", phone: "+15550001111", utm: "ig", consent: true });
    expect((await deliver(payload(r))).body).toMatchObject({ outcome: "recorded", ghost: false, action: "create", runsStarted: 1 });
    expect(writes).toHaveLength(1);
    const made = writes[0] as { op: string; id: string; body: { tags: string[]; customFields: { id: string; field_value: string }[]; email: string; phone: string; firstName: string; source: string } };
    expect(made.op).toBe("create");
    expect(made.body).toMatchObject({ firstName: "Ann", lastName: "Doe", email: "new@x.com", phone: "+15550001111", tags: [], source: "Typeform: VIP Matchmaking Application" });
    expect(Object.fromEntries(made.body.customFields.map((f) => [f.id, f.field_value]))).toEqual({ F_AGE: "41", F_STATUS: "Divorced", F_KIDS: "No", F_CONSENT: "I acknowledge and consent", F_UTM: "ig", F_SUB: r.submitted_at, F_RID: "new1" });
    const p = await ledger(made.id);
    expect(p!.tags).toEqual([]);
    await settle();
    expect(writes.slice(1).filter((w) => w.body === "dating")).toEqual([{ op: "tag", id: made.id, body: "dating" }]);   // New lead's own stat-new follows
    expect((await ledger(made.id))!.tags).toContain("dating");
    expect(await events("lead.created", p!.id)).toHaveLength(1);
    // a real tag step records each tag it wrote (applyTags, D144), here New from Typeform's "dating"
    expect((await events("tag.added", p!.id)).filter((e) => JSON.stringify(e.data.tag).includes("dating"))).toEqual([expect.objectContaining({ source: "engine", data: { tag: "dating" } })]);
    updated = [crm.get(made.id)!];
    await pollCompany(fake, companyId);
    updated = [];
    expect(await events("lead.created", p!.id)).toHaveLength(1);
  });

  it("live, another business's contact matched by email: updated, never recreated; their own name and phone kept, blanks filled, the tag added on its own", async () => {
    await setMode("live");
    other("THEIRS1", { firstName: "Jen", email: "jen@x.com" });
    writes.length = 0;
    expect((await deliver(payload(response("em1", { first: "Jennifer", email: "JEN@x.com", phone: "+15550002222" })))).body).toMatchObject({ outcome: "recorded", action: "update", matched: "email", ghlContactId: "THEIRS1" });
    expect(writes.map((w) => w.op)).toEqual(["update"]);
    await settle();   // the tag is New from Typeform's, added on its own (New lead's stat-new after it)
    expect(writes.filter((w) => w.op !== "tag" || w.body === "dating").map((w) => w.op)).toEqual(["update", "tag"]);
    expect(writes[0].body).toMatchObject({ lastName: "Doe", phone: "+15550002222" });
    expect(writes[0].body).not.toHaveProperty("firstName");
    expect(writes[1]).toEqual({ op: "tag", id: "THEIRS1", body: "dating" });
    const k = crm.get("THEIRS1")!;
    expect(k).toMatchObject({ firstName: "Jen", tags: expect.arrayContaining(["hair-client", "dating"]) });
    expect(k.customFields).toMatchObject({ THEIRS: "kept", F_AGE: "41" });
    const [ev] = await events("form.submitted", (await ledger("THEIRS1"))!.id);
    expect(ev.data).toMatchObject({ matched: "email", action: "update", kept: ["first_name"] });
  });

  it("live, matched by phone when the email is new to GHL", async () => {
    await setMode("live");
    other("THEIRS2", { firstName: "Amy", email: "amy.old@x.com", phone: "(555) 000-3333" });
    writes.length = 0;
    expect((await deliver(payload(response("ph1", { first: "Amy", email: "amy.new@x.com", phone: "+15550003333" })))).body).toMatchObject({ outcome: "recorded", action: "update", matched: "phone", ghlContactId: "THEIRS2" });
    expect(writes.some((w) => w.op === "create")).toBe(false);
    expect(crm.get("THEIRS2")!.email).toBe("amy.old@x.com");
  });

  it("a second application from someone already a lead is no new lead: New from Typeform runs, its New lead step is skipped", async () => {
    await setMode("live");
    expect((await deliver(payload(response("new2", { email: "new@x.com", phone: "+15550001111", age: 42 })))).body).toMatchObject({ outcome: "recorded", action: "update" });
    await settle();
    const p = await byEmail("new@x.com");
    const [, second] = await runsOf("New from Typeform", p!.id);
    expect(await asOperator((c) => one(c, "select status, result from run_steps where run_id=$1 and node_id='n2'", [second.id]))).toMatchObject({ status: "skipped" });
    expect(await events("lead.created", p!.id)).toHaveLength(1);
    expect(await events("form.submitted", p!.id)).toHaveLength(2);
    expect(crm.get(p!.ghl_contact_id!)!.customFields.F_AGE).toBe("42");
  });

  it("answers become words: a choice its label, several joined, yes/no Yes or No, a number as written", () => {
    expect(answerText({ field: { ref: "a" }, type: "choice", choice: { label: "Single" } })).toBe("Single");
    expect(answerText({ field: { ref: "a" }, type: "choice", choice: { other: "Separated" } })).toBe("Separated");
    expect(answerText({ field: { ref: "a" }, type: "choices", choices: { labels: ["A", "B"], other: "C" } })).toBe("A, B, C");
    expect(answerText({ field: { ref: "a" }, type: "boolean", boolean: true })).toBe("Yes");
    expect(answerText({ field: { ref: "a" }, type: "number", number: 38 })).toBe("38");
    expect(answerText({ field: { ref: "a" }, type: "text", text: "  " })).toBeUndefined();
  });

  it("the importer's dry run reads Typeform and GHL and writes nothing; it counts creates, matches, duplicates, partials and fill rates", async () => {
    other("THEIRS3", { email: "beth@x.com" }); other("THEIRS4", { phone: "+15550004444" });
    history = [response("h1", { email: "cara@x.com", at: "2026-10-09T10:00:00Z", partner: "x" }), response("h2", { email: "beth@x.com", at: "2026-10-09T11:00:00Z" }),
      response("h3", { email: "dina@x.com", phone: "+15550004444", at: "2026-10-09T12:00:00Z" }), response("h4", { email: "Cara@x.com", age: 50, at: "2026-10-10T10:00:00Z", utm: "fb" })];
    partial = [response("p1")];
    writes.length = 0;
    const count = () => asOperator(async (c) => [(await one<{ n: number }>(c, "select count(*)::int as n from events where company_id=$1", [companyId]))!.n, (await one<{ n: number }>(c, "select count(*)::int as n from webhook_deliveries where company_id=$1", [companyId]))!.n, (await one<{ n: number }>(c, "select count(*)::int as n from contacts where company_id=$1", [companyId]))!.n]);
    const before = await count();
    const { bindings, adapterCompany } = await asOperator((c) => loadCompany(c, companyId));
    const d = await dryRunImport({ token: "tf-token", formId: FORM, form: map, bindings, ac: adapterCompany, adapters: fake, api: tf, retryMs: 0 });
    expect(writes).toEqual([]);
    expect(await count()).toEqual(before);
    expect(d.responses).toMatchObject({ completed: 4, partial: 1, started: 0, first: "2026-10-09T10:00:00Z", last: "2026-10-10T10:00:00Z" });
    expect(d).toMatchObject({ people: 3, unidentified: 0, duplicates: { emails: 1, responses: 1 }, ghl: { byEmail: 1, byPhone: 1, none: 1, readErrors: 0 }, wouldWrite: { creates: 1, updates: 3, tagAdds: 3, responses: 4 }, unbound: [] });
    expect(d.fill.find((f) => f.target === "field_contact_app_ideal_partner")).toMatchObject({ filled: 1, pct: 25 });
    expect(d.fill.find((f) => f.target === "field_contact_app_age")).toMatchObject({ filled: 4, pct: 100 });
    expect(d.hidden.find((h) => h.name === "utm_source")).toMatchObject({ filled: 1 });
  });

  it("apply writes each response once, oldest first, whatever the mode, and starts nothing; a re-run writes nothing; a response the door only shadowed is written, once", async () => {
    await setMode("ghost");
    const shadowed = response("h0", { email: "eve@x.com", at: "2026-10-09T09:00:00Z" });
    await deliver(payload(shadowed));
    history = [shadowed, ...history];
    writes.length = 0;
    const leads = (await events("lead.created")).length, submitted = (await events("form.submitted")).length;
    const r = await applyImport({ companyId, formId: FORM, adapters: fake, api: tf, limit: 3 });
    expect(r).toMatchObject({ written: 3, failed: [], remaining: 2 });
    const r2 = await applyImport({ companyId, formId: FORM, adapters: fake, api: tf });
    expect(r2).toMatchObject({ written: 2, skipped: 3, remaining: 0 });
    expect(writes.filter((w) => w.op === "create").map((w) => (w.body as { email: string }).email)).toEqual(["eve@x.com", "cara@x.com", "dina@x.com"].filter((e) => e !== "dina@x.com"));
    expect(writes.filter((w) => w.op === "update").map((w) => w.id)).toEqual(expect.arrayContaining(["THEIRS3", "THEIRS4"]));
    expect([...crm.values()].filter((k) => k.email === "cara@x.com")).toHaveLength(1);
    expect([...crm.values()].find((k) => k.email === "cara@x.com")!.customFields.F_AGE).toBe("50");   // the later answers win
    expect((await events("lead.created")).length).toBe(leads);
    expect((await events("form.submitted")).length).toBe(submitted + 4);   // the shadowed one was already recorded
    expect(await asOperator((c) => many(c, "select 1 from runs where company_id=$1 and started_at > now() - interval '1 minute' and contact_id in (select contact_id from events where company_id=$1 and data->>'via'='import')", [companyId]))).toEqual([]);
    writes.length = 0;
    expect(await applyImport({ companyId, formId: FORM, adapters: fake, api: tf })).toMatchObject({ written: 0, skipped: 5, remaining: 0 });
    expect(writes).toEqual([]);
    const eve = await byEmail("eve@x.com");
    expect(eve!.ghl_contact_id).toBeTruthy();
    expect(eve!.tags).toEqual(["dating"]);
  });

  it("D123: apply with newLead runs each new applicant through New from Typeform as the webhook would: tagged, one lead a person even when they applied twice; a response the door saw is not run again", async () => {
    await setMode("live");
    const seenByDoor = response("n0", { email: "gil@x.com", at: "2026-10-11T09:00:00Z" });
    await deliver(payload(seenByDoor));
    await settle();
    history = [seenByDoor, response("n1", { email: "hal@x.com", at: "2026-10-11T10:00:00Z" }), response("n2", { email: "Hal@x.com", at: "2026-10-11T11:00:00Z", age: 52 }), response("n3", { email: "ivy@x.com", at: "2026-10-11T12:00:00Z" })];
    const r = await applyImport({ companyId, formId: FORM, adapters: fake, api: tf, newLead: true });
    expect(r).toMatchObject({ written: 3, skipped: 1, failed: [], remaining: 0, runsStarted: 3 });
    await settle();
    const hal = (await byEmail("hal@x.com"))!, ivy = (await byEmail("ivy@x.com"))!, gil = (await byEmail("gil@x.com"))!;
    expect(await events("lead.created", hal.id)).toHaveLength(1);
    expect(await runsOf("New from Typeform", hal.id)).toHaveLength(2);
    expect(await runsOf("New lead", hal.id)).toHaveLength(1);
    expect(await events("lead.created", ivy.id)).toHaveLength(1);
    expect(await events("lead.created", gil.id)).toHaveLength(1);
    expect(await runsOf("New from Typeform", gil.id)).toHaveLength(1);
    expect(hal.tags).toContain("dating");
  });

  it("D123: an applicant the door made a lead in shadow (not in GHL) who turns up in GHL later, tagged, is the same lead, not a second", async () => {
    await setMode("ghost");
    await deliver(payload(response("pg1", { email: "kim@x.com", phone: "+15550009999" })));
    await settle();
    const p = (await byEmail("kim@x.com"))!;
    expect(p.ghl_contact_id).toBeNull();
    expect(await events("lead.created", p.id)).toHaveLength(1);
    other("KIM1", { email: "kim@x.com", tags: ["dating"] });
    updated = [crm.get("KIM1")!];
    await pollCompany(fake, companyId);
    updated = [];
    expect((await ledger("KIM1"))!.id).toBe(p.id);
    expect(await events("lead.created", p.id)).toHaveLength(1);
    expect(await runsOf("New lead", p.id)).toHaveLength(1);
  });

  it("D117/D123: a lead.created for someone out of scope starts nothing, whatever sent it; the same for someone tagged starts New lead", async () => {
    const lead = (tags: string[]) => asOperator(async (c) => {
      const id = (await one<{ id: string }>(c, "insert into contacts (company_id, first_name, timezone, tags) values ($1,'Out','UTC',$2) returning id", [companyId, tags]))!.id;
      return { id, started: await dispatchEvent(c, await emitEvent(c, { company_id: companyId, contact_id: id, opportunity_id: null, appointment_id: null, event_type: "lead.created", source: "engine", data: {} }), { contact: { id } }) };
    });
    const out = await lead(["hair-client"]);
    expect(out.started).toEqual([]);
    expect(await asOperator((c) => one(c, "select after from audit_log where company_id=$1 and action='scope.lead_refused' and target_id=$2", [companyId, out.id]))).toMatchObject({ after: { tag: "dating", source: "engine" } });
    expect((await lead(["dating"])).started).toHaveLength(1);
  });

  it("the health sweep: registered and pointing here is fine; gone, elsewhere or off is an error with a re-register button, which puts it back", async () => {
    const sweep = () => asOperator(async (c) => { const { row } = await loadCompany(c, companyId); return (await runHealthStep(c, row, fake, { ...fakeProbes, typeformGetWebhook: tf.getWebhook }, { checks: { typeform_webhook: true }, min_slots: 0, slots_days: 7 })).findings.filter((f) => f.check === "typeform_webhook"); });
    expect(await sweep()).toEqual([expect.objectContaining({ ok: true, item: FORM, text: `Webhook "biab-${slug}" on "VIP Matchmaking Application" (FORM1) is registered, on, and sends here.` })]);
    const key = `${FORM}:biab-${slug}`, good = hooks.get(key)!;
    hooks.set(key, { ...good, url: "https://hooks.zapier.com/x" });
    expect(await sweep()).toEqual([expect.objectContaining({ ok: false, level: "error", text: expect.stringContaining("sends to https://hooks.zapier.com/x, not to this engine"), fix: { label: "Re-register the Typeform webhook", action: "reregister_typeform" } })]);
    hooks.set(key, { ...good, enabled: false });
    expect((await sweep())[0]).toMatchObject({ ok: false, text: expect.stringContaining("is turned off") });
    hooks.delete(key);
    expect((await sweep())[0]).toMatchObject({ ok: false, level: "error", text: expect.stringContaining("is gone"), fix: { action: "reregister_typeform" } });
    const lines = await asOperator(async (c) => { const { bindings } = await loadCompany(c, companyId); return registerTypeform(companyId, slug, bindings, (k, kind, v) => setBinding(c, companyId, k, kind, v), tf); });
    expect(lines).toHaveLength(1);
    expect(puts.at(-1)).toEqual({ form: FORM, tag: `biab-${slug}`, url: `https://engine.test/api/webhooks/typeform/${companyId}`, secret });
    expect(await sweep()).toEqual([expect.objectContaining({ ok: true })]);
  });
});
