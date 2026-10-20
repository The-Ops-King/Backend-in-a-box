/**
 * D125: the operator's full synthetic journey for a Calendly company with two mapped calendars and a Typeform door (Dating
 * (Nelly)). `form` stages an application through the door's own function: the person need not exist, New from Typeform and
 * New lead run once, the GHL write follows the mode (real for a test-domain contact in test, nothing in shadow), one synthetic
 * response id is one application, and `reset` clears it. `calendar` says which calendar a booking is on: the Triage call
 * runs Triage call booked, the Closing call Closing call booked, never both. Every other action works on a contact `form` made.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { DateTime } from "luxon";
import { asOperator, many, one } from "@/db/client";
import { migrate } from "@/db/migrate";
import { installCompany, type InstallInput } from "./install";
import { loadCompany } from "./context";
import { createCompanyWorkflow } from "./definitions";
import { normPhone } from "./identity";
import { tick } from "./runner";
import { fakeAdapters } from "./test-install";
import { simulate, simulateForm, type SimAction, type FormInput } from "./simulate";
import { templates } from "@/templates";
import { DEFAULT_SCRIPTS, harnessProblem, type HarnessTranscripts } from "./harness-scripts";
import type { Adapters, ContactSnapshot } from "@/adapters/types";
import { POST as simulateRoute } from "../../app/api/admin/simulate/route";

process.env.BINDINGS_KEY ??= Buffer.alloc(32, 7).toString("base64");
const KEY = "d125-operator-key", prevSecret = process.env.CRON_SECRET;
const NELLY = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../installs/dating-nelly.json"), "utf8")) as InstallInput & { typeform: { forms: Record<string, { answers: Record<string, string> }> }; harness: HarnessTranscripts };
const own = (slug: string) => JSON.parse(fs.readFileSync(path.resolve(__dirname, `../../installs/dating-nelly/${slug}.json`), "utf8")) as { name: string; note: string; definition: unknown; create: { stage: string; sort: number; takesOver?: string } };
const FORM = "AjY7UfXZ", STRATEGY = "86985d27-22e5-4b6b-ab66-8e68e9ee8e30", CONSULT = "80955126-29fe-48ea-a85e-ba4bcd145790", TZ = "America/Los_Angeles";
const REF = Object.fromEntries(Object.entries(NELLY.typeform.forms[FORM].answers).map(([ref, t]) => [t, ref]));

// GHL as the location holds it
let n = 0;
const ghl = new Map<string, ContactSnapshot>();
const writes: { op: string; id?: string; body: unknown }[] = [];
const now = () => DateTime.now().toUTC().toISO()!;
const base = fakeAdapters();
const cals = [{ id: STRATEGY, name: "Complimentary Dating Strategy Session ♡", teamMemberIds: [] }, { id: CONSULT, name: "Private Dating Consultation with Nelly", teamMemberIds: [] }];
const fake: Adapters = { ...base,
  booking: (() => { const b = { appointmentsInWindow: async () => [], listCalendars: async () => cals, getAppointment: async () => null }; return { ghl: b, calendly: b }; })(),
  read: { ...base.read, listUsers: async () => [{ id: "U-NELLY", name: "Nelly S.", email: "nellysudri@d125.test" }, { id: "U-MITCH", name: "Mitch Sapoff", email: "mitch@revsignals.io" }],
    findDuplicate: async (_c, by) => [...ghl.values()].find((k) => ("email" in by ? k.email?.toLowerCase() === by.email.toLowerCase() : !!k.phone && normPhone(k.phone) === normPhone(by.phone))) ?? null,
    getContact: async (_c, id) => ghl.get(id) ?? null },
  write: { ...base.write,
    createContact: async (_c, input) => { const id = `G${++n}`; writes.push({ op: "create", id, body: input }); ghl.set(id, { id, firstName: input.firstName, lastName: input.lastName, email: input.email, phone: input.phone, tags: input.tags ?? [], customFields: Object.fromEntries((input.customFields ?? []).map((f) => [f.id, f.field_value])), dateUpdated: now(), dateAdded: now() }); return { id }; },
    updateContact: async (_c, id, patch) => { writes.push({ op: "update", id, body: patch }); },
    addTag: async (_c, id, tag) => { writes.push({ op: "tag", id, body: tag }); const k = ghl.get(id); if (k) ghl.set(id, { ...k, tags: [...k.tags, tag] }); },
    createRecord: async (_c, object, properties) => { writes.push({ op: "record", body: { object, properties } }); return { id: `R${++n}` }; } },
};

const SLUG = `d125-${Date.now()}`;
let co = "";
const settle = async () => { for (let i = 0; i < 3; i++) await tick(fake, DateTime.now() as DateTime<true>, co); };
const form = (email: string, o: FormInput & { force?: boolean } = {}) => asOperator(async (c) => { const { row } = await loadCompany(c, co); return simulateForm({ c, company: row, adapters: fake, email, ...o }); });
const sim = (contactId: string, action: SimAction, o: Partial<Parameters<typeof simulate>[0]> = {}) => asOperator(async (c) => { const { row } = await loadCompany(c, co); return simulate({ c, company: row, contactId, adapters: fake, ...o }, action); });
const byEmail = (email: string) => asOperator((c) => one<{ id: string; ghl_contact_id: string | null }>(c, "select ct.id, ct.ghl_contact_id from contacts ct join contact_identifiers i on i.contact_id=ct.id where i.company_id=$1 and i.kind='email' and i.value=$2", [co, email]));
const runs = (contactId: string) => asOperator(async (c) => (await many<{ name: string }>(c, "select w.name from runs r join workflows w on w.id=r.workflow_id where r.company_id=$1 and r.contact_id=$2 order by r.started_at, w.name", [co, contactId])).map((r) => r.name));
const count = (list: string[], name: string) => list.filter((x) => x === name).length;
const events = (contactId: string, type: string) => asOperator((c) => many<{ source: string; data: Record<string, unknown> }>(c, "select source, data from events where company_id=$1 and contact_id=$2 and event_type=$3 order by id", [co, contactId, type]));
const setMode = (mode: string) => asOperator((c) => c.query("update companies set mode=$2 where id=$1", [co, mode]));

describe.skipIf(!process.env.DATABASE_URL)("D125: the harness stages a Typeform application and books on the calendar asked for", () => {
  beforeAll(async () => {
    process.env.CRON_SECRET = KEY;
    await migrate();
    const { crm, salesCall, calendars, closerCall, bookingCalendar, scopeTag, testDomains, typeform, contractValueDefault, harness } = NELLY;
    co = (await installCompany({ name: "Dating (Nelly) D125", slug: SLUG, timezone: TZ, locationId: "LOC-D125", pit: "fake", crm, salesCall, calendars, closerCall, bookingCalendar, scopeTag, testDomains, contractValueDefault, harness,
      typeform: { forms: typeform.forms }, closers: ["nellysudri@d125.test"], templates: templates.map((t) => t.slug).filter((s) => s !== "call-booked") }, fake)).companyId;
    await asOperator(async (c) => {
      for (const slug of ["new-from-typeform", "triage-call-booked", "closing-call-booked", "triage-call-cancelled"]) {
        const o = own(slug);
        expect(await createCompanyWorkflow(c, { companyId: co, name: o.name, definition: o.definition, note: o.note, ...o.create }), slug).toMatchObject({ ok: true, created: true });
      }
      await c.query("update companies set mode='ghost', send_window_start='00:00', send_window_end='23:59' where id=$1", [co]);
      await c.query("update calendars set source='calendly' where company_id=$1", [co]);
      // RapidCloser's roster holds the other business's staff too: never the caller of a staged setter call
      await c.query("insert into users (company_id, email, name, role, ghl_user_id) values ($1,'andy@other.test','Andy Other','staff','U-ANDY')", [co]);
      await c.query("update workflows set enabled=true where company_id=$1 and name = any($2::text[])", [co,
        ["New from Typeform", "New lead", "Triage call booked", "Closing call booked", "Triage call cancelled", "Call cancelled", "Call outcome filed", "Sales call recorded", "Payment recorded", "Setter call logged", "Agreement signed", "Deal closed"]]);
    });
  }, 60_000);
  afterAll(async () => {
    if (co) await asOperator((c) => c.query("update runs set status='exited', next_run_at=null where company_id=$1", [co]));
    if (prevSecret === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = prevSecret;
  });

  it("form, shadow: makes the person the door makes, records the application (sim-…, simulated), writes nothing to GHL, and runs New from Typeform and New lead once", async () => {
    const email = "tyler+shadow@jtylerray.com";
    expect(await byEmail(email)).toBeUndefined();
    const r = await form(email);
    expect(r).toMatchObject({ ok: true, action: "form", detail: { outcome: "recorded", form: FORM, ghost: true, action: "create", ghl_contact_id: null } });
    if (!r.ok) return;
    expect(String(r.detail.response_id)).toMatch(/^sim-[0-9a-f]{16}$/);
    const who = (await byEmail(email))!;
    expect(r.detail.contact).toBe(who.id);
    expect(who.ghl_contact_id).toBeNull();
    expect(writes).toEqual([]);
    const [sub] = await events(who.id, "form.submitted");
    expect(sub.source).toBe("form");
    expect(sub.data).toMatchObject({ simulated: true, via: "webhook", response_id: r.detail.response_id, ghost: true,
      would_write: { action: "create", standard: { email, firstName: "Test", lastName: "Applicant", phone: expect.stringMatching(/^\+131055501\d\d$/) }, fields: { field_contact_app_age: "36", field_contact_app_location: "Los Angeles, CA", field_contact_utm_source: "sys-test", field_contact_app_response_id: r.detail.response_id } } });
    await settle();
    const rs = await runs(who.id);
    expect(count(rs, "New from Typeform")).toBe(1);
    expect(count(rs, "New lead")).toBe(1);
    expect(await events(who.id, "lead.created")).toHaveLength(1);
  });

  it("is one application per synthetic response id: the same request again is a no-op; a new responseId is a second application, and no second lead", async () => {
    const email = "tyler+shadow@jtylerray.com", who = (await byEmail(email))!;
    const again = await form(email);
    expect(again).toMatchObject({ ok: true, detail: { outcome: "duplicate", contact: who.id }, runsStarted: 0 });
    expect(await events(who.id, "form.submitted")).toHaveLength(1);
    const second = await form(email, { responseId: "second", answers: { app_age: 37, [REF.field_contact_app_location]: "San Diego, CA", utm_campaign: "retest" } });
    expect(second).toMatchObject({ ok: true, detail: { outcome: "recorded", response_id: "sim-second" } });
    const subs = await events(who.id, "form.submitted");
    expect(subs).toHaveLength(2);
    expect(subs[1].data.would_write).toMatchObject({ fields: { field_contact_app_age: "37", field_contact_app_location: "San Diego, CA", field_contact_utm_campaign: "retest" } });
    await settle();
    const rs = await runs(who.id);
    expect(count(rs, "New from Typeform")).toBe(2);
    expect(count(rs, "New lead")).toBe(1);
    expect(await form(email, { answers: { nope: "x" }, responseId: "third" })).toEqual({ ok: false, why: '"nope" is no question, field or hidden field of the form' });
  });

  it("only a test contact: an email on no test domain is refused and nothing is made or written; live is refused unless forced", async () => {
    expect(await form("someone@gmail.com")).toMatchObject({ ok: false, why: expect.stringMatching(/^not a test contact/) });
    expect(await byEmail("someone@gmail.com")).toBeUndefined();
    await setMode("live");
    expect(await form("tyler+live@jtylerray.com")).toMatchObject({ ok: false, why: expect.stringMatching(/^company is live/) });
    expect(await byEmail("tyler+live@jtylerray.com")).toBeUndefined();
    await setMode("ghost");
    expect(writes).toEqual([]);
  });

  it("form, test mode: a test-domain contact is written to GHL for real (the answers by ref), and New from Typeform's tag is real", async () => {
    await setMode("test");
    const email = "tyler+test@jtylerray.com";
    const r = await form(email);
    expect(r).toMatchObject({ ok: true, detail: { outcome: "recorded", ghost: false, action: "create", ghl_contact_id: expect.stringMatching(/^G\d+$/) } });
    if (!r.ok) return;
    const id = r.detail.ghl_contact_id as string;
    const created = writes.find((w) => w.op === "create" && w.id === id)!.body as { email: string; customFields: { id: string; field_value: string }[]; source: string };
    expect(created).toMatchObject({ email, source: "Typeform: VIP Matchmaking Application" });
    const crmIds = NELLY.crm as Record<string, string>;
    expect(created.customFields).toEqual(expect.arrayContaining([{ id: crmIds.field_contact_app_age, field_value: "36" }, { id: crmIds.field_contact_app_response_id, field_value: r.detail.response_id }, { id: crmIds.field_contact_utm_source, field_value: "sys-test" }]));
    expect((await byEmail(email))!.ghl_contact_id).toBe(id);
    await settle();
    expect(writes.filter((w) => w.op === "tag" && w.id === id).map((w) => w.body)).toContain("dating");
    expect(await runs(r.detail.contact as string)).toEqual(expect.arrayContaining(["New from Typeform", "New lead"]));
    // someone on no test domain is still refused in test, and nothing more is written
    expect(await form("someone@gmail.com")).toMatchObject({ ok: false });
    expect(writes.filter((w) => w.op === "create")).toHaveLength(1);
    await setMode("ghost");
  });

  it("reset clears what form staged: the same request is a first application again, New lead included", async () => {
    const email = "tyler+shadow@jtylerray.com", who = (await byEmail(email))!;
    expect(await sim(who.id, "reset")).toMatchObject({ ok: true, detail: { applications_removed: 2 } });
    expect(await events(who.id, "form.submitted")).toEqual([]);
    expect(await asOperator((c) => many(c, "select 1 from webhook_deliveries where company_id=$1 and delivery_id like $2", [co, `${FORM}:sim-%`]))).toHaveLength(2);   // the test-mode applicant's (seen, and written) stay
    expect(await form(email)).toMatchObject({ ok: true, detail: { outcome: "recorded", contact: who.id } });
    await settle();
    expect(await runs(who.id)).toEqual(["New from Typeform", "New lead"]);
  });

  it("calendar: a Triage call runs Triage call booked, a Closing call Closing call booked, never both; reschedule and cancel take the calendar too; no calendar is the closer call, as before", async () => {
    const r = await form("tyler+cal@jtylerray.com");
    const ct = (r.ok && r.detail.contact) as string;
    await settle();
    const booked = async (o: Partial<Parameters<typeof simulate>[0]>, action: SimAction = "book-self") => { const before = await runs(ct); const x = await sim(ct, action, o); expect(x.ok, JSON.stringify(x)).toBe(true); await settle(); return (await runs(ct)).slice(before.length); };
    expect(await booked({ calendar: "Triage call" })).toEqual(["Triage call booked"]);
    expect(await booked({ calendar: CONSULT })).toEqual(["Closing call booked"]);
    expect(await booked({ calendar: "triage CALL" }, "reschedule")).toEqual(["Triage call booked"]);
    expect(await booked({ calendar: "Closing call" }, "reschedule")).toEqual(["Closing call booked"]);
    expect(await booked({})).toEqual(["Closing call booked"]);   // the closer call, Calendly's Private Consultation
    const rescheduled = await asOperator((c) => many<{ term: string }>(c, "select t.name as term from events e join appointments a on a.id=e.appointment_id join company_terms t on t.id=a.appointment_term where e.company_id=$1 and e.contact_id=$2 and e.event_type='appointment.rescheduled' order by e.id", [co, ct]));
    expect(rescheduled.map((x) => x.term)).toEqual(["Triage call", "Closing call"]);
    expect(await sim(ct, "book", { calendar: "Discovery" })).toMatchObject({ ok: false, why: expect.stringMatching(/^no mapped calendar is "Discovery".*"Closing call" \(80955126.*"Triage call" \(86985d27/) });
    const cancelled = await booked({ calendar: "Triage call" }, "cancel");
    expect(cancelled).toEqual(["Triage call cancelled"]);   // D142: a triage call's cancel is its own, never Call cancelled's
    expect(await asOperator((c) => many<{ status: string; term: string }>(c, "select a.status, t.name as term from appointments a join company_terms t on t.id=a.appointment_term where a.company_id=$1 and a.contact_id=$2 order by a.booked_at", [co, ct]))).toEqual([
      { status: "cancelled", term: "Triage call" }, { status: "confirmed", term: "Closing call" }, { status: "confirmed", term: "Closing call" }]);
  });

  it("every other action works on a contact form made, for the Calendly company: record, call, a deposit, pay, agreement, sign", async () => {
    const r = await form("tyler+journey@jtylerray.com");
    const ct = (r.ok && r.detail.contact) as string;
    const done = async (action: SimAction, o: Partial<Parameters<typeof simulate>[0]> = {}) => { const x = await sim(ct, action, o); expect(x.ok, `${action}: ${JSON.stringify(x)}`).toBe(true); await settle(); return x.ok ? x : null!; };
    await done("book-self", { calendar: "Closing call", startsAt: DateTime.now().setZone(TZ).minus({ hours: 2 }).toISO()! });
    // D131: the staged calls speak the company's offer, from its install, with the people's names (read before the runs are done: D87 drops a held transcript then)
    const said = (id: unknown) => asOperator(async (c) => (await one<{ t: { speaker: string; text: string }[] }>(c, "select transcript as t from recordings where id=$1", [id]))!.t);
    const staged = async (action: SimAction, o: Partial<Parameters<typeof simulate>[0]> = {}) => { const x = await sim(ct, action, o); expect(x.ok, `${action}: ${JSON.stringify(x)}`).toBe(true); const t = x.ok ? await said(x.detail.recording) : []; await settle(); return { x: x.ok ? x : null!, t }; };
    const { x: rec, t: closerSaid } = await staged("record", { calendar: "Closing call" });
    expect(rec.detail.appointment).toBeTruthy();
    expect(closerSaid.map((l) => `${l.speaker}: ${l.text}`)).toEqual(NELLY.harness.closerCall!.map((l) => `${l.speaker === "prospect" ? "Test Applicant" : "Nelly S."}: ${l.text}`));
    // D126: the closer's end-of-day answer for this one call, through the form's own per-call path
    const filed = await done("outcome", { outcome: "Deposit", amount: 250 });
    expect(filed.detail).toMatchObject({ appointment: rec.detail.appointment, call_type: "Closing call", outcome: "deposit", cash: 250, filed: "filed" });
    expect(filed.runsStarted).toBe(1);
    expect(await asOperator((c) => one(c, "select ot.category as attendance, cot.category as call_outcome, fs.answers->>'notes' as notes from appointments a join company_terms ot on ot.id=a.outcome_term join company_terms cot on cot.id=a.call_outcome_term join form_submissions fs on fs.id=a.disposition_id where a.id=$1", [rec.detail.appointment])))
      .toEqual({ attendance: "showed", call_outcome: "deposit", notes: "Filed by the test harness\nDeposit: $250 collected" });
    expect((await done("outcome", { outcome: "deposit", amount: 250 })).detail).toMatchObject({ filed: "held" });   // the same answer twice is not filed twice
    expect(await asOperator((c) => many(c, "select 1 from eod_reports where company_id=$1", [co]))).toEqual([]);   // the closer's day is theirs to file
    const { x: call, t: setterSaid } = await staged("call");
    expect(call.detail).toMatchObject({ caller: "Nelly S." });
    expect(setterSaid[0]).toMatchObject({ speaker: "0", text: "Hey Test, this is the team calling about the application you sent in. Got two minutes?" });
    const dep = await done("pay", { deposit: true, amount: 250 });
    expect(dep.detail).toMatchObject({ amount: 250, kind: "deposit" });
    const paid = await done("pay", { amount: 4750 });
    expect(paid.detail).toMatchObject({ amount: 4750, kind: "balance" });
    await done("agreement");
    const signed = await done("sign");
    expect(signed.detail).toMatchObject({ status: "completed" });
    expect(await runs(ct)).toEqual(expect.arrayContaining(["New from Typeform", "New lead", "Closing call booked", "Sales call recorded", "Setter call logged", "Payment recorded", "Agreement signed", "Deal closed"]));
    expect(count(await runs(ct), "Call outcome filed")).toBe(1);
  });

  it("outcome refuses an answer the company does not have (and says which it has), a call that has not started, and no staged call", async () => {
    const r = await form("tyler+outcome@jtylerray.com");
    const ct = (r.ok && r.detail.contact) as string;
    expect(await sim(ct, "outcome", { outcome: "deposit" })).toMatchObject({ ok: false, why: expect.stringMatching(/^no open simulated appointment/) });
    expect((await sim(ct, "book-self", { calendar: "Closing call" })).ok).toBe(true);
    expect(await sim(ct, "outcome", { outcome: "deposit" })).toMatchObject({ ok: false, why: expect.stringMatching(/only a call that has started/) });
    expect((await sim(ct, "reschedule", { calendar: "Closing call", startsAt: DateTime.now().setZone(TZ).minus({ hours: 1 }).toISO()! })).ok).toBe(true);
    expect(await sim(ct, "outcome", { outcome: "won" })).toMatchObject({ ok: false, why: expect.stringMatching(/^outcome is one of the company's end-of-day answers: "closed" \(Closed\), "deposit" \(Deposit\)/) });
  });

  it("D131: harness scripts are checked at install (a role that is not on that call, a call with one speaker); without its own a company stages the offer-neutral pair", async () => {
    expect(harnessProblem(NELLY.harness)).toBeNull();
    expect(harnessProblem({ closerCall: [{ speaker: "setter", text: "Hi" }, { speaker: "prospect", text: "Hi" }] })).toBe("closerCall[0]: speaker is closer or prospect");
    expect(harnessProblem({ setterCall: [{ speaker: "setter", text: "Hi" }, { speaker: "setter", text: "Hello?" }] })).toBe("setterCall: both setter and prospect speak");
    expect(harnessProblem({ demoCall: [] })).toBe('"demoCall" is not closerCall or setterCall');
    await expect(installCompany({ name: "x", slug: SLUG, timezone: TZ, locationId: "LOC-D125", pit: "fake", calendars: {}, templates: [], harness: { closerCall: [{ speaker: "closer", text: "" }, { speaker: "prospect", text: "Hi" }] } }, fake)).rejects.toThrow("harness: closerCall[0]: text is needed");
    expect(JSON.stringify(DEFAULT_SCRIPTS)).not.toMatch(/hair|crown|thinning/i);
  });

  it("the admin route: book takes a calendar; form refuses answers that are not a map; an unknown contact still 404s for every action but a form by email", async () => {
    const post = (body: unknown) => simulateRoute(new Request("http://x/api/admin/simulate", { method: "POST", headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" }, body: JSON.stringify(body) }));
    const r = await post({ company: SLUG, contact: "tyler+journey@jtylerray.com", action: "book-self", calendar: "Triage call" });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, action: "book-self", detail: { calendar: STRATEGY, call_type: "Triage call" }, runs_started: 1 });
    expect((await post({ company: SLUG, contact: "nobody@jtylerray.com", action: "book" })).status).toBe(404);
    expect((await post({ company: SLUG, contact: "00000000-0000-0000-0000-000000000000", action: "form" })).status).toBe(404);
    expect((await post({ company: SLUG, contact: "tyler+journey@jtylerray.com", action: "form", answers: ["x"] })).status).toBe(400);
  });
});
