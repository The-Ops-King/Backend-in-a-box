/**
 * D68: the live contact is read before a run acts; the engine's copy is a cache. Driven through the real engine (the
 * poll, the dispatcher, the runner) against Postgres with a fake CRM the tests change behind the replica's back.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { DateTime } from "luxon";
import { asOperator, one, many } from "@/db/client";
import { migrate } from "@/db/migrate";
import { installCompany } from "@/engine/install";
import { pollAll } from "@/engine/poll";
import { tick } from "@/engine/runner";
import { fakeAdapters } from "@/engine/test-install";
import { runPage } from "@/api/data";
import type { Adapters, ContactSnapshot } from "@/adapters/types";

const HAS_DB = !!process.env.DATABASE_URL;
process.env.BINDINGS_KEY ??= Buffer.alloc(32, 7).toString("base64");
const TZ = "America/Phoenix";

// the fake CRM: what it holds (getContact), what the next poll delivers (contactsChangedSince), whether it answers at all
const crm = new Map<string, ContactSnapshot>();
const changed: ContactSnapshot[] = [];
const sent: { kind: string; to: string; body: string }[] = [];
let crmDown: string | null = null;
let opps = 0;
const base = fakeAdapters({ crm });
const fake: Adapters = {
  ...base,
  read: { ...base.read, listUsers: async () => [{ id: "U1", name: "Sam Closer", email: "sam@x.com" }],
    getContact: async (c, id) => { if (crmDown) throw new Error(crmDown); return base.read.getContact(c, id); },
    contactsChangedSince: async (c) => (c.id === companyId ? changed.splice(0) : []) },
  write: { ...base.write, createOpportunity: async () => ({ id: `ghl-opp-${++opps}` }), addTag: async (_c, id, t) => { const s = crm.get(id); if (s && !s.tags.includes(t)) s.tags = [...s.tags, t]; } },   // the shared fake's constant id would collide on the second person's card
  sender: { ...base.sender,
    sendSms: async (_c, to, body) => { sent.push({ kind: "sms", to, body }); return { externalId: `s${sent.length}`, accepted: true }; },
    sendEmail: async (_c, to, subject, html) => { sent.push({ kind: "email", to, body: `${subject}|${html}` }); return { externalId: `e${sent.length}`, accepted: true }; } },
};

const CRM = { pipeline_setter: "PIPE-SETTER", stage_setter_new_lead: "STAGE-NEW", field_opportunity_stage_entered: "CF-STAGE-DATE", pipeline_closer: "PIPE-CLOSER", stage_setter_direct_booked: "STAGE-DIRECT", stage_setter_appointment_set: "STAGE-SET", stage_closer_scheduled: "STAGE-SCHED", stage_setter_cancelled: "STAGE-S-CANCEL", stage_closer_cancelled: "STAGE-C-CANCEL", field_contact_appointment_date: "CF-APPT-DATE", field_contact_setter: "CF-SETTER", field_opportunity_setter_owner: "CF-SETTER-OWNER", default_closer: "U1" };
const TEMPLATES = ["new-lead", "speed-to-lead"];
const TABLES = ["alerts", "eod_reports", "slack_posts", "agreements", "sends", "runs", "events", "slack_connections", "workflow_triggers", "workflows", "messages", "crm_records", "webhook_deliveries", "payments", "recordings", "form_submissions", "forms", "appointments", "pipeline_cards", "opportunities", "calendars", "contact_identifiers", "intake", "contacts", "users", "company_terms", "bindings", "poll_cursors", "audit_log"];
let companyId: string;

const wipe = (slug: string) => asOperator(async (c) => {
  const co = await one<{ id: string }>(c, "select id from companies where slug=$1", [slug]); if (!co) return;
  await c.query("delete from run_steps where run_id in (select id from runs where company_id=$1)", [co.id]);
  await c.query("delete from workflow_versions where workflow_id in (select id from workflows where company_id=$1)", [co.id]);
  for (const t of TABLES) await c.query(`delete from ${t} where company_id=$1`, [co.id]);
  await c.query("delete from companies where id=$1", [co.id]);
});
type Run = { id: string; status: string; current_node: string | null; exit_reason: string | null; contact_id: string | null; context: Record<string, unknown> };
const runsOf = (slug: string, contactId: string) => asOperator((c) => many<Run>(c, "select r.id, r.status, r.current_node, r.exit_reason, r.contact_id, r.context from runs r join workflows w on w.id=r.workflow_id join workflow_templates t on t.id=w.template_id where w.company_id=$1 and t.slug=$2 and r.contact_id=$3 order by r.started_at, r.id", [companyId, slug, contactId]));
const runOf = async (slug: string, contactId: string) => (await runsOf(slug, contactId)).at(-1)!;
type Contact = { id: string; ghl_contact_id: string | null; first_name: string | null; last_name: string | null; gone_at: Date | null; tags: string[] };
const person = (ghlId: string) => asOperator((c) => one<Contact>(c, "select ct.id, ct.ghl_contact_id, ct.first_name, ct.last_name, ct.gone_at, ct.tags from contacts ct where ct.company_id=$1 and (ct.ghl_contact_id=$2 or exists (select 1 from contact_identifiers i where i.contact_id=ct.id and i.kind='ghl_contact' and i.value=$2))", [companyId, ghlId]));
const identifiers = (contactId: string, kind: string) => asOperator((c) => many<{ value: string; retired: boolean }>(c, "select value, retired_at is not null as retired from contact_identifiers where contact_id=$1 and kind=$2 order by created_at, value", [contactId, kind]));
const eventCount = (types: string[], source?: string) => asOperator(async (c) => (await one<{ n: number }>(c, "select count(*)::int as n from events where company_id=$1 and event_type = any($2::text[]) and ($3::text is null or source=$3)", [companyId, types, source ?? null]))!.n);
const inCrm = (id: string, over: Partial<ContactSnapshot> = {}): ContactSnapshot => { const s: ContactSnapshot = { id, tags: [], customFields: {}, dateUpdated: new Date().toISOString(), dateAdded: new Date().toISOString(), ...over }; crm.set(id, s); changed.push(s); return s; };
/** The CRM changed behind the replica's back: the poll has not delivered this yet. */
const crmNow = (id: string, over: Partial<ContactSnapshot>) => { crm.set(id, { ...crm.get(id)!, ...over, dateUpdated: new Date().toISOString() }); };
const expireReplyWait = (runId: string, nodeId: string) => asOperator((c) => c.query("update runs set next_run_at=now(), context = jsonb_set(context, $2::text[], to_jsonb($3::text), true) where id=$1", [runId, `{vars,__wait_for_reply,${nodeId},deadline}`, new Date(Date.now() - 60e3).toISOString()]));
const poll = () => pollAll(fake);
const run = () => tick(fake, undefined, companyId);

describe.skipIf(!HAS_DB)("the live contact is read before a run acts (D68)", () => {
  beforeAll(async () => {
    await migrate().catch((e: Error) => { if (!/events_source_check/.test(e.message)) throw e; });
    await wipe("truth");
    const r = await installCompany({ name: "Truth", slug: "truth", timezone: TZ, locationId: "LOC-TRUTH", pit: "pit-fake", calendars: { CAL: "closing" }, enable: true, templates: TEMPLATES, crm: CRM, anthropicKey: "sk-fake", contractValueDefault: 2999 }, fake);
    companyId = r.companyId;
    expect(r.installed.filter((s) => s.endsWith("enabled"))).toHaveLength(TEMPLATES.length);
    await asOperator(async (c) => {
      await c.query("update companies set mode='live', send_window_start='00:00', send_window_end='23:59' where id=$1", [companyId]);
      const since = DateTime.now().minus({ days: 1 }).toISO()!;
      for (const entity of ["contacts", "conversations"]) await c.query("insert into poll_cursors (company_id, entity, cursor, last_polled_at, last_success_at) values ($1,$2,$3,now(),now())", [companyId, entity, since]);
    });
    await run();   // the scheduler's clock is shared with the other suites: one tick so the next is never "recovery"
  });

  it("a run claimed after the CRM renamed the contact and changed the phone greets the new name and carries the new number; the old number is retired", async () => {
    inCrm("T1", { firstName: "Olivia", lastName: "Old", email: "t1@x.com", phone: "+16025550301" });
    await poll();
    const ct = (await person("T1"))!; expect(ct.first_name).toBe("Olivia");
    crmNow("T1", { firstName: "Liv", phone: "+16025550302" });   // renamed and renumbered in the CRM since the poll
    const n = sent.length; await run();
    const stl = await runOf("speed-to-lead", ct.id);
    expect(stl).toMatchObject({ status: "waiting", current_node: "n3" });
    const texts = sent.slice(n).filter((s) => s.to === "T1");
    expect(texts.map((s) => s.kind).sort()).toEqual(["email", "sms"]);
    for (const s of texts) { expect(s.body).toContain("Hey Liv,"); expect(s.body).not.toContain("Olivia"); }
    expect((await person("T1"))!).toMatchObject({ first_name: "Liv", last_name: "Old", gone_at: null });
    expect(await identifiers(ct.id, "phone")).toEqual([{ value: "+16025550301", retired: true }, { value: "+16025550302", retired: false }]);
    const contact = stl.context.contact as Record<string, unknown>;
    expect(contact).toMatchObject({ first_name: "Liv", name: "Liv Old", phone: "+16025550302", email: "t1@x.com" });
    expect(contact.stale).toBeUndefined(); expect(typeof contact.fetched_at).toBe("string");
    const page = await asOperator((c) => runPage(c, stl.id));
    expect(page!.run.contact_truth).toEqual({ fetched_at: contact.fetched_at, stale: null });
  });

  it("the CRM answers 404: the run exits moot once, gone_at is set, one alert is raised, nothing is sent", async () => {
    inCrm("T2", { firstName: "Gone", lastName: "Soon", email: "t2@x.com", phone: "+16025550311" });
    await poll();
    const ct = (await person("T2"))!;
    crm.delete("T2");   // deleted in the CRM before the run ever acted
    const n = sent.length; await run();
    expect(await runOf("speed-to-lead", ct.id)).toMatchObject({ status: "exited", exit_reason: expect.stringMatching(/contact gone$/) });
    expect(await runOf("new-lead", ct.id)).toMatchObject({ status: "exited", exit_reason: expect.stringMatching(/contact gone$/) });
    expect(sent.slice(n).filter((s) => s.to === "T2")).toEqual([]);
    expect((await person("T2"))!.gone_at).toEqual(expect.any(Date));
    const alerts = await asOperator((c) => many<{ key: string; level: string }>(c, "select key, level from alerts where company_id=$1 and key=$2 and resolved_at is null", [companyId, `contact:gone:${ct.id}`]));
    expect(alerts).toEqual([{ key: `contact:gone:${ct.id}`, level: "warning" }]);
    await run();   // nothing left to look at
    expect(await runsOf("speed-to-lead", ct.id)).toHaveLength(1);
    expect(sent.slice(n).filter((s) => s.to === "T2")).toEqual([]);
  });

  it("the CRM throws (503): the run acts on the engine's copy, says so, and is not failed", async () => {
    inCrm("T3", { firstName: "Cached", lastName: "Copy", email: "t3@x.com", phone: "+16025550321" });
    await poll();
    const ct = (await person("T3"))!;
    crmNow("T3", { firstName: "Unseen" });   // the CRM has a newer name, but cannot be asked
    crmDown = "GHL 503 Service Unavailable";
    const n = sent.length;
    try { await run(); } finally { crmDown = null; }
    const stl = await runOf("speed-to-lead", ct.id);
    expect(stl).toMatchObject({ status: "waiting", current_node: "n3" });
    const texts = sent.slice(n).filter((s) => s.to === "T3");
    expect(texts).toHaveLength(2);
    for (const s of texts) expect(s.body).toContain("Hey Cached,");   // the copy, since the CRM did not answer
    expect((await person("T3"))!).toMatchObject({ first_name: "Cached", gone_at: null });
    expect(stl.context.contact).toMatchObject({ stale: expect.stringMatching(/503/) });
    expect((stl.context.contact as Record<string, unknown>).fetched_at).toBeUndefined();
    const page = await asOperator((c) => runPage(c, stl.id));
    expect(page!.run.contact_truth).toEqual({ fetched_at: null, stale: expect.stringMatching(/503/) });
    // the next look reads the CRM again and the copy catches up
    await asOperator((c) => c.query("update runs set next_run_at=now() where id=$1", [stl.id]));
    await run();
    expect((await person("T3"))!.first_name).toBe("Unseen");
    const caught = (await runOf("speed-to-lead", ct.id)).context.contact as Record<string, unknown>;
    expect(caught).toMatchObject({ fetched_at: expect.any(String) }); expect(caught.stale).toBeUndefined();
  });

  it("the primary id answers 404 but another current id answers: the primary moves, the dead id is retired, the run goes on", async () => {
    inCrm("T4A", { firstName: "Two", lastName: "Records", email: "t4@x.com", phone: "+16025550331" });
    await poll(); await run();   // the first record's runs are done with their sends
    const ct = (await person("T4A"))!; expect(ct.ghl_contact_id).toBe("T4A");
    inCrm("T4B", { firstName: "Two", lastName: "Records", email: "t4@x.com", phone: "+16025550331" });   // the CRM made a second record for the same person (D65: it is the primary now)
    await poll();
    expect((await person("T4B"))!).toMatchObject({ id: ct.id, ghl_contact_id: "T4B" });
    crm.delete("T4B");   // and then dropped it (a merge, a test cleanup); the first record still exists
    const stl = await runOf("speed-to-lead", ct.id); expect(stl).toMatchObject({ status: "waiting", current_node: "n3" });
    await expireReplyWait(stl.id, "n3");   // the parked run wakes: silence → the follow-up email
    const n = sent.length; await run();
    expect((await person("T4A"))!).toMatchObject({ id: ct.id, ghl_contact_id: "T4A", gone_at: null });
    expect(await identifiers(ct.id, "ghl_contact")).toEqual([{ value: "T4A", retired: false }, { value: "T4B", retired: true }]);
    expect(await runOf("speed-to-lead", ct.id)).toMatchObject({ status: "completed", current_node: "x2" });
    expect(sent.slice(n).map((s) => [s.kind, s.to])).toEqual([["email", "T4A"]]);   // to the record the CRM still has
    const runs = await asOperator((c) => many<{ status: string; exit_reason: string | null }>(c, "select status, exit_reason from runs where company_id=$1 and contact_id=$2", [companyId, ct.id]));
    expect(runs.filter((r) => /contact gone/.test(r.exit_reason ?? "") || r.status === "failed")).toEqual([]);
  });

  it("a refresh never emits lead.created or tag.added; the poll still sees the tag it left in place", async () => {
    inCrm("T5", { firstName: "Quiet", email: "t5@x.com", phone: "+16025550351" });
    await poll(); await run();   // New lead tags them stat-new (the engine's own tag.added, source engine)
    const ct = (await person("T5"))!; expect(ct.tags).toEqual(["stat-new"]);
    crmNow("T5", { firstName: "Louder", tags: ["hot", "stat-new"] });   // a tag added by hand in the CRM since the poll
    const polls = () => eventCount(["lead.created", "tag.added", "tag.removed"], "ghl_poll");
    const before = await polls();
    const stl = await runOf("speed-to-lead", ct.id); await expireReplyWait(stl.id, "n3"); await run();
    expect(await polls()).toBe(before);
    expect((await person("T5"))!).toMatchObject({ first_name: "Louder", tags: ["stat-new"] });   // the name followed the CRM; the tags are the poll's to deliver
    changed.push(crm.get("T5")!); await poll();   // the poll delivers the same snapshot and the delta is still seen, once
    expect(await polls()).toBe(before + 1);
    expect([...(await person("T5"))!.tags].sort()).toEqual(["hot", "stat-new"]);
    const tagEvents = await asOperator((c) => many<{ data: { tag: string } }>(c, "select data from events where company_id=$1 and contact_id=$2 and event_type='tag.added' and source='ghl_poll'", [companyId, ct.id]));
    expect(tagEvents.map((e) => e.data.tag)).toEqual(["hot"]);
  });
});
