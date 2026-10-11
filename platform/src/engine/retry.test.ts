/**
 * D66: a failed step is retried in place, never the run, and never a side effect twice. Driven through the real runner
 * against Postgres with fakes that misbehave on cue: a 503 on a tag, a 401, a 400 on a card, a crash between the vendor
 * and our bookkeeping, a text the CRM could not take; and the three doors a second delivery could sneak a second run through.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { DateTime } from "luxon";
import { asOperator, one, many } from "@/db/client";
import { migrate } from "@/db/migrate";
import { encrypt } from "@/engine/crypto";
import { emitEvent, dispatchEvent, startRun, type EventRow } from "@/engine/dispatch";
import { tick } from "@/engine/runner";
import { fakeAdapters } from "@/engine/test-install";
import { syncTriggers } from "@/engine/install";
import { setBinding } from "@/engine/settings";
import { retryStep, skipStep } from "@/engine/hand";
import { applyAppointment } from "@/engine/poll";
import { recordRecording } from "@/engine/recordings";
import { loadCompany } from "@/engine/context";
import { parseDefinition, extractManifest } from "@/engine/definition";
import { classifyError, plainError, RETRY_SCHEDULE, VendorError } from "@/engine/failures";
import { GhlError } from "@/adapters/ghl/client";
import type { Adapters, AppointmentSnapshot } from "@/adapters/types";

const HAS_DB = !!process.env.DATABASE_URL;
process.env.BINDINGS_KEY ??= Buffer.alloc(32, 7).toString("base64");
const TZ = "America/New_York";

// what the fakes record, and the switches that make the CRM misbehave on cue
const tags: string[] = [], notes: string[] = [], texts: string[] = [], cards: Record<string, unknown>[] = [];
let tagMode: "ok" | "503" | "401" = "ok";
let cardMode: "ok" | "400" | "503" = "ok";
const tries = { addTag: 0, createOpportunity: 0 };
let oppSeq = 0;   // card ids stay unique across the file
let noteCrash = false;
// the body GHL sent Hair's Call booked (2026-10-10): a Sales Call whose External ID another record already has
const DUPLICATE = '{"message":"A record with the same value for External ID - test-20254447 already exists.","errors":[{"errorCode":"duplicate_record","message":"A record with the same value for External ID - test-20254447 already exists.","field":"external_id"}],"statusCode":400}';      // the CRM wrote the note, then the socket died before it answered
let smsMode: "ok" | "503" = "ok";
const base = fakeAdapters();
const fake: Adapters = {
  ...base,
  write: { ...base.write,
    addTag: async (_c, id, t) => { tries.addTag++; if (tagMode === "503") throw new GhlError(503, "upstream connect error", `/contacts/${id}/tags`); if (tagMode === "401") throw new GhlError(401, "Invalid Private Integration token", `/contacts/${id}/tags`); tags.push(t); },
    addNote: async (_c, _id, body) => { notes.push(body); if (noteCrash) throw new Error("socket hang up"); },
    createRecord: async (_c, object) => { if (object === "custom_objects.sales_call") throw new GhlError(400, DUPLICATE, "/objects/custom_objects.sales_call/records"); return { id: "rec-x" }; },
    createOpportunity: async (_c, input) => { tries.createOpportunity++; if (cardMode === "503") throw new GhlError(503, "no healthy upstream", "/opportunities/"); if (cardMode === "400") throw new GhlError(400, '{"message":"stageId is invalid"}', "/opportunities/"); cards.push(input); return { id: `ghl-opp-${++oppSeq}` }; } },
  sender: { ...base.sender, sendSms: async (_c, _to, body) => { if (smsMode === "503") return { externalId: "", accepted: false, error: "GHL 503 on /conversations/messages: upstream unavailable" }; texts.push(body); return { externalId: `s${texts.length}`, accepted: true }; } },
};

const TABLES = ["alerts", "slack_posts", "sends", "step_effects", "runs", "events", "slack_connections", "workflow_triggers", "workflows", "messages", "crm_records", "payments", "recordings", "appointments", "pipeline_cards", "opportunities", "calendars", "contact_identifiers", "contacts", "users", "company_terms", "bindings", "poll_cursors", "audit_log"];
let companyId: string;
const wfIds: Record<string, string> = {};
type Run = { id: string; status: string; current_node: string | null; exit_reason: string | null; next_run_at: Date | null; step_attempt: number; step_error: string | null; contact_id: string | null };
const run = (id: string) => asOperator((c) => one<Run>(c, "select id, status, current_node, exit_reason, next_run_at, step_attempt, step_error, contact_id from runs where id=$1", [id]));
const steps = (id: string, node: string) => asOperator((c) => many<{ status: string; result: Record<string, unknown>; error: string | null }>(c, "select status, result, error from run_steps where run_id=$1 and node_id=$2 order by started_at, id", [id, node]));
const alerts = (key: string) => asOperator((c) => many<{ key: string; resolved_at: Date | null; text: string }>(c, "select key, resolved_at, text from alerts where company_id=$1 and key=$2", [companyId, key]));
const wake = (id: string) => asOperator((c) => c.query("update runs set next_run_at=now() where id=$1", [id]));
const tickAt = (at: DateTime) => tick(fake, at as DateTime<true>, companyId);
const newContact = (ghlId: string, first: string, phone?: string) => asOperator(async (c) => {
  const id = (await one<{ id: string }>(c, "insert into contacts (company_id, ghl_contact_id, first_name, last_name, timezone) values ($1,$2,$3,'Retry',$4) returning id", [companyId, ghlId, first, TZ]))!.id;
  if (phone) await c.query("insert into contact_identifiers (company_id, contact_id, kind, value) values ($1,$2,'phone',$3)", [companyId, id, phone]);
  return id;
});
/** One `tag.added` event with the tag that picks the workflow; returns the run it started. */
const fire = (contactId: string, tag: string) => asOperator(async (c) => {
  const ev = await emitEvent(c, { company_id: companyId, contact_id: contactId, opportunity_id: null, appointment_id: null, event_type: "tag.added", source: "test", data: { tag } });
  const started = await dispatchEvent(c, ev, { contact: { id: contactId } });
  return { ev, runId: started[0] };
});
/** A tiny workflow: a trigger on tag.added with that tag, the step under test, an exit. */
const workflow = (name: string, tag: string, step: Record<string, unknown>, extra: { trigger?: Record<string, unknown> } = {}) => ({ schema: 1, reentry: "always", premise: { check: "contact_exists" },
  nodes: [{ id: "t1", type: "trigger", ...(extra.trigger ?? { event: "tag.added", match: { eq: ["{{event.tag}}", tag] } }) }, { id: "n1", ...step }, { id: "x1", type: "exit", reason: "done" }], edges: [{ from: "t1", to: "n1" }, { from: "n1", to: "x1" }], name });
const DEFS = [
  workflow("Tag it", "tag", { type: "set_tag", tag: ["stat-x"] }),
  // nothing after the card reads it, so it would be skipped (D77); marked blocking to keep the pause-for-a-person path under test
  workflow("Card it", "card", { type: "pipeline_card", pipeline: "{{crm.pipeline_x}}", stage: "{{crm.stage_x}}", name: "{{contact.name}} card", blocking: true }),
  workflow("Note it", "note", { type: "note", template: "Hello {{contact.first_name}}" }),
  workflow("Text it", "text", { type: "send_sms", template: "Hi {{contact.first_name}}", kind: "transactional" }),
  workflow("Book it", "book", { type: "set_tag", tag: ["booked"] }, { trigger: { event: "appointment.booked" } }),
  workflow("Call booked", "record", { type: "crm_record", object: "custom_objects.sales_call", key: "{{event.tag}}", properties: { external_id: "test-20254447" }, blocking: true }),
  // D77: a tag nothing reads, then a note: the tag is non-blocking
  { schema: 1, reentry: "always", premise: { check: "contact_exists" }, name: "Tag then note",
    nodes: [{ id: "t1", type: "trigger", event: "tag.added", match: { eq: ["{{event.tag}}", "tagnote"] } }, { id: "n1", type: "set_tag", tag: ["stat-x"] }, { id: "n2", type: "note", template: "Noted {{contact.first_name}}" }, { id: "x1", type: "exit", reason: "done" }],
    edges: [{ from: "t1", to: "n1" }, { from: "n1", to: "n2" }, { from: "n2", to: "x1" }] },
  // D77: a card a later step reads (the note names it): the card is blocking
  { schema: 1, reentry: "always", premise: { check: "contact_exists" }, name: "Card then note",
    nodes: [{ id: "t1", type: "trigger", event: "tag.added", match: { eq: ["{{event.tag}}", "cardnote"] } }, { id: "n1", type: "pipeline_card", pipeline: "{{crm.pipeline_x}}", stage: "{{crm.stage_x}}", name: "{{contact.name}} card" }, { id: "n2", type: "note", template: "Card {{cards.x.id}}" }, { id: "x1", type: "exit", reason: "done" }],
    edges: [{ from: "t1", to: "n1" }, { from: "n1", to: "n2" }, { from: "n2", to: "x1" }] },
];

describe("failure classes (pure)", () => {
  it("reads the vendor, the status and whether the vendor answered off a typed error or the adapters' message shapes", () => {
    expect(classifyError(new GhlError(503, "x", "/p"))).toMatchObject({ cls: "transient", vendor: "ghl", status: 503, answered: true });
    expect(classifyError(new GhlError(429, "x", "/p"))).toMatchObject({ cls: "transient", status: 429 });
    expect(classifyError(new GhlError(401, "x", "/p"))).toMatchObject({ cls: "auth", vendor: "ghl" });
    expect(classifyError(new GhlError(403, "x", "/p"))).toMatchObject({ cls: "auth" });
    expect(classifyError(new GhlError(400, "x", "/p"))).toMatchObject({ cls: "permanent" });
    expect(classifyError(new GhlError(404, "x", "/p"))).toMatchObject({ cls: "permanent" });
    expect(classifyError(new GhlError(422, "x", "/p"))).toMatchObject({ cls: "permanent" });
    expect(classifyError(new VendorError("whop", 502, "/payments", "bad gateway"))).toMatchObject({ cls: "transient", vendor: "whop" });
    expect(classifyError("GHL 503 on /contacts/x/tags: upstream")).toMatchObject({ cls: "transient", vendor: "ghl", status: 503 });
    expect(classifyError("pipeline_card n1: could not read the contact's cards in the CRM: GHL 502 on /opportunities/search: bad gateway")).toMatchObject({ cls: "transient", vendor: "ghl", status: 502 });
    expect(classifyError("fathom: create webhook 500 boom")).toMatchObject({ cls: "transient", vendor: "fathom", status: 500 });
    expect(classifyError("401 Unauthorized: the CRM token was rotated")).toMatchObject({ cls: "auth", status: 401 });
    expect(classifyError("POST https://hook.example/x → 502: bad gateway")).toMatchObject({ cls: "transient", status: 502 });
    expect(classifyError(new Error("socket hang up"))).toMatchObject({ cls: "transient", answered: false });
    expect(classifyError(new Error("fetch failed"))).toMatchObject({ cls: "transient", answered: false });
    expect(classifyError(new Error("connection terminated unexpectedly"))).toMatchObject({ cls: "transient", answered: false });
    expect(classifyError(new Error("slack: invalid_auth"))).toMatchObject({ cls: "auth", vendor: "slack" });
    expect(classifyError(new Error("slack: ratelimited"))).toMatchObject({ cls: "transient", vendor: "slack" });
    expect(classifyError(new Error("slack: channel_not_found"))).toMatchObject({ cls: "permanent", vendor: "slack" });
    expect(classifyError(Object.assign(new Error("overloaded"), { status: 529 }))).toMatchObject({ cls: "transient", status: 529 });
    expect(classifyError("update_contact: contact has no CRM id yet")).toMatchObject({ cls: "permanent" });
    expect(classifyError("record_outcome: no appointment_outcome term for \"shown\"")).toMatchObject({ cls: "unknown" });
    expect(RETRY_SCHEDULE).toEqual([1, 5]);   // D76: no loops; at most three tries of a step in all
  });
  it("D77: an alert says what the vendor said in its own words, never its JSON", () => {
    expect(plainError(classifyError(new GhlError(400, DUPLICATE, "/objects/custom_objects.sales_call/records")))).toBe("GHL says a record with the same value for External ID - test-20254447 already exists");
    expect(plainError(classifyError(`GHL 400 on /objects/custom_objects.sales_call/records: ${DUPLICATE.slice(0, 120)}`))).toBe("GHL says a record with the same value for External ID - test-20254447 already exists");   // a body cut short still reads
    expect(plainError(classifyError(new GhlError(503, "<html><body>Bad gateway</body></html>", "/contacts/x/tags")))).toBe("GHL is unavailable");
    expect(plainError(classifyError(new VendorError("calendly", 404, "/scheduled_events/x", '{"title":"Resource Not Found","message":"The server could not find the requested resource.","details":[]}')))).toBe("Calendly says the server could not find the requested resource");
    expect(plainError(classifyError(new Error("slack: channel_not_found")))).toBe("Slack says channel not found");
    expect(plainError(classifyError(new Error("socket hang up")))).toBe("socket hang up");
    expect(plainError(classifyError("note: contact has no CRM id yet"))).toBe("note: contact has no CRM id yet");
  });
});

describe.skipIf(!HAS_DB)("a failed step is retried in place (D66)", () => {
  beforeAll(async () => {
    await migrate().catch((e: Error) => { if (!/events_source_check/.test(e.message)) throw e; });
    await asOperator(async (c) => {
      const co = await one<{ id: string }>(c, "select id from companies where slug='retry'");
      if (co) {
        await c.query("delete from run_steps where run_id in (select id from runs where company_id=$1)", [co.id]);
        await c.query("delete from workflow_versions where workflow_id in (select id from workflows where company_id=$1)", [co.id]);
        for (const t of TABLES) await c.query(`delete from ${t} where company_id=$1`, [co.id]);
        await c.query("delete from companies where id=$1", [co.id]);
      }
      companyId = (await one<{ id: string }>(c, "insert into companies (name, slug, timezone, mode, send_window_start, send_window_end) values ('Retry Co','retry',$1,'live','00:00','23:59') returning id", [TZ]))!.id;
      await c.query("insert into company_terms (company_id, domain, name, category, is_default, sort) select $1, domain, label, value, true, sort from core_categories", [companyId]);
      await c.query("insert into bindings (company_id,key,kind,value) values ($1,'crm.location_id','id',$2),($1,'secret.ghl_pit','secret',$3),($1,'alerts.slack_channel','channel',$4),($1,'crm.pipeline_x','id',$5),($1,'crm.stage_x','id',$6)",
        [companyId, Buffer.from("LOC"), encrypt("p1"), Buffer.from("CALERTS"), Buffer.from("PIPE1"), Buffer.from("STAGE1")]);
      const term = (await one<{ id: string }>(c, "select id from company_terms where company_id=$1 and domain='appointment_type' and category='closing'", [companyId]))!.id;
      await c.query("insert into calendars (company_id, external_id, name, appointment_term, active) values ($1,'CAL1','Closer',$2,true)", [companyId, term]);
      for (const d of DEFS) {
        const { name, ...definition } = d;
        const def = parseDefinition(definition);
        const wf = (await one<{ id: string }>(c, "insert into workflows (company_id, name, reentry_policy, enabled) values ($1,$2,'always',true) returning id", [companyId, name]))!;
        await c.query("insert into workflow_versions (workflow_id, version, definition, manifest, note) values ($1,1,$2,$3,'retry test')", [wf.id, def, extractManifest(def)]);
        await syncTriggers(c, companyId, wf.id, def);
        wfIds[name] = wf.id;
      }
    });
  });

  it("a 503 on a tag step: the run waits on that step and retries on the schedule; the third try passes and exactly one tag write reaches the CRM", async () => {
    const ct = await newContact("R1", "Ava");
    tagMode = "503";
    try {
      const t0 = DateTime.now();
      const { runId } = await fire(ct, "tag");
      expect(await tickAt(t0)).toMatchObject({ claimed: 1, waiting: 1, failed: 0, paused: 0, retries: 1 });
      let r = (await run(runId))!;
      expect(r).toMatchObject({ status: "waiting", current_node: "n1", step_attempt: 1, step_error: expect.stringMatching(/^GHL 503/) });
      expect(Math.abs(DateTime.fromJSDate(r.next_run_at!).diff(t0.plus({ minutes: RETRY_SCHEDULE[0] }), "seconds").seconds)).toBeLessThan(5);
      expect(await steps(runId, "n1")).toMatchObject([{ status: "failed", result: { attempt: 1, class: "transient", vendor: "ghl" } }]);
      // nothing moved: no tag, no alert, still the same step
      expect(tags).toHaveLength(0);
      expect(await alerts(`run:${runId}:paused`)).toHaveLength(0);
      // second try, a minute later: still down, the wait grows to five minutes
      await wake(runId); const t1 = t0.plus({ minutes: 1 });
      await tickAt(t1);
      r = (await run(runId))!;
      expect(r).toMatchObject({ status: "waiting", current_node: "n1", step_attempt: 2 });
      expect(Math.abs(DateTime.fromJSDate(r.next_run_at!).diff(t1.plus({ minutes: RETRY_SCHEDULE[1] }), "seconds").seconds)).toBeLessThan(5);
      // third try: the CRM is back
      tagMode = "ok";
      await wake(runId); await tickAt(t1.plus({ minutes: 5 }));
      r = (await run(runId))!;
      expect(r).toMatchObject({ status: "completed", step_attempt: 0, step_error: null });
      expect(tags).toEqual(["stat-x"]);
      expect((await steps(runId, "n1")).map((s) => s.status)).toEqual(["failed", "failed", "ok"]);
    } finally { tagMode = "ok"; tags.length = 0; }
  });

  it("D77: a non-blocking step that keeps failing makes exactly three tries, is skipped, and the rest of the run runs; one alert for that step and person; Retry this step re-runs only that step, once", async () => {
    const ct = await newContact("R2", "Ben");
    tagMode = "503"; tries.addTag = 0;
    try {
      const { runId } = await fire(ct, "tagnote");
      let at = DateTime.now();
      for (let i = 0; i < 6; i++) { await wake(runId); await tickAt(at); at = at.plus({ minutes: 10 }); }   // more looks than tries: no loop
      expect(tries.addTag).toBe(3);
      expect(await run(runId)).toMatchObject({ status: "completed", step_attempt: 0, step_error: null });
      expect(await steps(runId, "n1")).toMatchObject([{ status: "failed" }, { status: "failed" }, { status: "skipped", result: { kind: "gave_up", tries: 3, class: "transient", vendor: "ghl" }, error: expect.stringMatching(/^GHL 503/) }]);
      expect(notes).toEqual(["Noted Ben"]);   // everything else ran
      expect(tags).toHaveLength(0);
      const key = `skipped:${wfIds["Tag then note"]}:n1:${ct}`;
      let a = await alerts(key);
      expect(a).toHaveLength(1);
      expect(a[0].text).toBe("Couldn't add the tag “stat-x” for Ben Retry after 3 tries (GHL says upstream connect error); everything else in Tag then note ran.");
      expect(await alerts(`run:${runId}:paused`)).toHaveLength(0);
      // the same person through the same step again: the same alert, touched, not a second
      const again = await fire(ct, "tagnote");
      for (let i = 0; i < 3; i++) { await wake(again.runId); await tickAt(at); }
      expect(await run(again.runId)).toMatchObject({ status: "completed" });
      expect(await alerts(key)).toHaveLength(1);
      // the CRM is back: Retry this step on the first run runs n1 alone, once
      tagMode = "ok"; const before = await asOperator((c) => many(c, "select 1 from run_steps where run_id=$1", [runId]));
      expect(await asOperator((c) => retryStep(c, runId, "Tyler", { node: "n1", adapters: fake }))).toMatchObject({ ok: true, node: "n1" });
      expect(tags).toEqual(["stat-x"]); expect(notes).toEqual(["Noted Ben", "Noted Ben"]);   // the second note is the second run's, not the retry's
      expect(await asOperator((c) => many(c, "select 1 from run_steps where run_id=$1", [runId]))).toHaveLength(before.length + 1);
      expect((await steps(runId, "n1")).at(-1)).toMatchObject({ status: "ok", result: { retried_by: "Tyler" } });
      expect(await run(runId)).toMatchObject({ status: "completed" });
      a = await alerts(key); expect(a[0].resolved_at).not.toBeNull();
      // a second press finds the step done: refused, nothing written
      expect(await asOperator((c) => retryStep(c, runId, "Tyler", { node: "n1", adapters: fake }))).toMatchObject({ ok: false, status: 409 });
      expect(tags).toEqual(["stat-x"]);
      expect(await asOperator((c) => one(c, "select 1 from audit_log where company_id=$1 and action='run.step_retried' and target_id=$2 and after->>'by'='Tyler'", [companyId, runId]))).toBeTruthy();
      // a step that never gave up cannot be retried on its own
      expect(await asOperator((c) => retryStep(c, runId, "Tyler", { node: "n2", adapters: fake }))).toMatchObject({ ok: false, status: 409 });
    } finally { tagMode = "ok"; tags.length = 0; notes.length = 0; }
  });

  it("D77: the owner's alert, in plain words: the workflow, what the step does, for whom, and GHL's own message; the raw body stays in the detail and on the run", async () => {
    const ct = await newContact("R2c", "Tyler");
    const { runId } = await fire(ct, "record");
    await tickAt(DateTime.now());
    expect(await run(runId)).toMatchObject({ status: "paused", current_node: "n1", step_error: expect.stringContaining('"errorCode":"duplicate_record"') });
    const a = await asOperator((c) => one<{ text: string; detail: { error: string } }>(c, "select text, detail from alerts where company_id=$1 and key=$2", [companyId, `run:${runId}:paused`]));
    expect(a!.text).toBe("Call booked couldn't create the Sales Call record for Tyler Retry: GHL says a record with the same value for External ID - test-20254447 already exists. Retry or skip it on the run page.");
    expect(a!.detail.error).toContain('"errorCode":"duplicate_record"');
  });

  it("a 401: paused at once, one auth:ghl alert for the company; a new token wakes it (the same token again does not) and it completes", async () => {
    const ct = await newContact("R3", "Cal");
    tagMode = "401";
    try {
      const { runId } = await fire(ct, "tag");
      expect(await tickAt(DateTime.now())).toMatchObject({ claimed: 1, paused: 1, failed: 0 });
      expect(await run(runId)).toMatchObject({ status: "paused", current_node: "n1", step_attempt: 1, exit_reason: expect.stringMatching(/^auth:ghl: GHL 401/) });
      let a = await alerts("auth:ghl");
      expect(a).toHaveLength(1); expect(a[0].resolved_at).toBeNull(); expect(a[0].text).toBe("GHL rejected the company's token: runs that reach it pause until the token is replaced in settings. First seen when Tag it couldn't add the tag “stat-x” for Cal Retry: GHL says invalid Private Integration token.");
      expect(await alerts(`run:${runId}:paused`)).toHaveLength(0);   // one dead token is one message, not one per run
      // a second run hits the same dead token: the alert is touched, not doubled
      const second = await fire((await newContact("R3b", "Cat")), "tag");
      await tickAt(DateTime.now());
      expect(await run(second.runId)).toMatchObject({ status: "paused" });
      expect(await alerts("auth:ghl")).toHaveLength(1);
      // the same token saved again wakes nothing
      await asOperator((c) => setBinding(c, companyId, "secret.ghl_pit", "secret", "p1", "test"));
      expect(await run(runId)).toMatchObject({ status: "paused" });
      // a new token: both runs are due now, the auth alert is resolved
      tagMode = "ok";
      await asOperator((c) => setBinding(c, companyId, "secret.ghl_pit", "secret", "p2", "test"));
      expect(await run(runId)).toMatchObject({ status: "waiting", step_attempt: 0 });
      expect(await run(second.runId)).toMatchObject({ status: "waiting" });
      a = await alerts("auth:ghl"); expect(a[0].resolved_at).not.toBeNull();
      await tickAt(DateTime.now());
      expect(await run(runId)).toMatchObject({ status: "completed" });
      expect(await run(second.runId)).toMatchObject({ status: "completed" });
      expect(tags).toEqual(["stat-x", "stat-x"]);
    } finally { tagMode = "ok"; tags.length = 0; }
  });

  it("a 400 on a card create: paused at once, no card; Retry after the fix creates exactly one card; Skip on another run moves on without one", async () => {
    const ct = await newContact("R4", "Dee");
    cardMode = "400";
    try {
      const { runId } = await fire(ct, "card");
      expect(await tickAt(DateTime.now())).toMatchObject({ paused: 1, failed: 0 });
      expect(await run(runId)).toMatchObject({ status: "paused", current_node: "n1", exit_reason: expect.stringMatching(/^permanent:ghl: GHL 400 on \/opportunities\/: .*stageId is invalid/) });
      expect(cards).toHaveLength(0);
      expect(await asOperator((c) => many(c, "select 1 from pipeline_cards where company_id=$1 and contact_id=$2", [companyId, ct]))).toHaveLength(0);
      const a = await alerts(`run:${runId}:paused`); expect(a).toHaveLength(1); expect(a[0].text).toBe("Card it couldn't move the x card for Dee Retry: GHL says stageId is invalid. Retry or skip it on the run page."); expect(a[0].text).not.toMatch(/gave up/);
      // the CRM answered, so the create claim is released: the retry may ask again
      expect(await asOperator((c) => many(c, "select 1 from step_effects where run_id=$1", [runId]))).toHaveLength(0);
      cardMode = "ok";
      await asOperator((c) => retryStep(c, runId, "Tyler"));
      await tickAt(DateTime.now());
      expect(await run(runId)).toMatchObject({ status: "completed" });
      expect(cards).toHaveLength(1);
      expect(await asOperator((c) => many<{ created_by_run: string; ghl_opportunity_id: string }>(c, "select created_by_run, ghl_opportunity_id from pipeline_cards where company_id=$1 and contact_id=$2", [companyId, ct]))).toEqual([{ created_by_run: runId, ghl_opportunity_id: "ghl-opp-1" }]);
      expect(await asOperator((c) => one<{ done_at: Date | null; external_id: string }>(c, "select done_at, external_id from step_effects where run_id=$1 and node_id='n1' and kind='card'", [runId]))).toMatchObject({ external_id: "ghl-opp-1" });
      // another run, same 400: a person skips the step instead
      cardMode = "400";
      const ct2 = await newContact("R4b", "Dot");
      const second = await fire(ct2, "card");
      await tickAt(DateTime.now());
      expect(await run(second.runId)).toMatchObject({ status: "paused" });
      expect(await asOperator((c) => skipStep(c, second.runId, "Tyler"))).toMatchObject({ ok: true, node: "n1", next: "x1" });
      expect(await run(second.runId)).toMatchObject({ status: "waiting", current_node: "x1", exit_reason: null });
      expect(await steps(second.runId, "n1")).toMatchObject([{ status: "failed" }, { status: "skipped", result: { kind: "skipped_by", by: "Tyler" } }]);
      await tickAt(DateTime.now());
      expect(await run(second.runId)).toMatchObject({ status: "completed", exit_reason: "done" });
      expect(cards).toHaveLength(1);
      expect(await asOperator((c) => many(c, "select 1 from pipeline_cards where company_id=$1 and contact_id=$2", [companyId, ct2]))).toHaveLength(0);
      expect((await alerts(`run:${second.runId}:paused`))[0].resolved_at).not.toBeNull();
    } finally { cardMode = "ok"; cards.length = 0; }
  });

  it("a crash between the vendor call and the bookkeeping on a note step: the retry writes no second note (the step_effects claim)", async () => {
    const ct = await newContact("R5", "Eve");
    noteCrash = true;
    try {
      const t0 = DateTime.now();
      const { runId } = await fire(ct, "note");
      expect(await tickAt(t0)).toMatchObject({ waiting: 1, retries: 1 });
      expect(notes).toEqual(["Hello Eve"]);   // the CRM has it; we never heard back
      expect(await run(runId)).toMatchObject({ status: "waiting", current_node: "n1", step_attempt: 1, step_error: "socket hang up" });
      // the vendor never answered, so the claim stays pending
      expect(await asOperator((c) => one<{ done_at: Date | null }>(c, "select done_at from step_effects where run_id=$1 and node_id='n1' and kind='note'", [runId]))).toMatchObject({ done_at: null });
      noteCrash = false;
      await wake(runId); await tickAt(t0.plus({ minutes: 1 }));
      expect(await run(runId)).toMatchObject({ status: "completed" });
      expect(notes).toEqual(["Hello Eve"]);   // not written twice
      const s = await steps(runId, "n1");
      expect(s.map((x) => x.status)).toEqual(["failed", "skipped"]);
      expect(s[1].result).toMatchObject({ kind: "blocked", why: expect.stringMatching(/not written twice/) });
    } finally { noteCrash = false; notes.length = 0; }
  });

  it("a text the CRM could not take (503) is retried and goes out once; a retry of a step whose text already went out sends nothing (the sends key)", async () => {
    const ct = await newContact("R6", "Fay", "+12125550106");
    smsMode = "503";
    try {
      const t0 = DateTime.now();
      const { runId } = await fire(ct, "text");
      expect(await tickAt(t0)).toMatchObject({ waiting: 1, retries: 1, sends: 0 });
      expect(texts).toHaveLength(0);
      expect(await asOperator((c) => one<{ status: string; error: string }>(c, "select status, error from sends where run_id=$1", [runId]))).toMatchObject({ status: "failed", error: expect.stringMatching(/GHL 503/) });
      smsMode = "ok";
      await wake(runId); await tickAt(t0.plus({ minutes: 1 }));
      expect(await run(runId)).toMatchObject({ status: "completed" });
      expect(texts).toEqual(["Hi Fay"]);
      expect(await asOperator((c) => many<{ status: string }>(c, "select status from sends where run_id=$1", [runId]))).toEqual([{ status: "sent" }]);
      // the step is made to run again (as a retry after a crash past the vendor would): the ledger refuses a second text
      await asOperator((c) => c.query("update runs set status='paused', current_node='n1', exit_reason='test: forced back onto the send' where id=$1", [runId]));
      await asOperator((c) => retryStep(c, runId, "Tyler"));
      await tickAt(DateTime.now());
      expect(await run(runId)).toMatchObject({ status: "completed" });
      expect(texts).toEqual(["Hi Fay"]);
      const s = await steps(runId, "n1");
      expect(s[s.length - 1]).toMatchObject({ status: "skipped", result: { kind: "noop", why: "already sent (idempotency)" } });
    } finally { smsMode = "ok"; texts.length = 0; }
  });

  it("an engine bug (a node the pinned version lacks) still fails the run outright: the old status is for those alone", async () => {
    const ct = await newContact("R7", "Gus");
    const { runId } = await fire(ct, "tag");
    await asOperator((c) => c.query("update runs set current_node='ghost' where id=$1", [runId]));
    expect(await tickAt(DateTime.now())).toMatchObject({ failed: 1, paused: 0 });
    expect(await run(runId)).toMatchObject({ status: "failed", exit_reason: "unknown node ghost" });
    tags.length = 0;
  });

  it("D77: a blocking step that keeps failing makes three fast tries, then the run is held on that step and only it is re-checked (15 minutes, then hourly); nothing after it runs, no side effect twice; it carries on by itself when the step passes", async () => {
    const ct = await newContact("R2b", "Bo");
    cardMode = "503"; tries.createOpportunity = 0;
    try {
      const { runId } = await fire(ct, "cardnote");
      let at = DateTime.now();
      for (let i = 0; i < 3; i++) { await wake(runId); await tickAt(at); at = at.plus({ minutes: 5 }); }
      expect(tries.createOpportunity).toBe(3);
      let r = (await run(runId))!;
      expect(r).toMatchObject({ status: "paused", current_node: "n1", step_attempt: 3, exit_reason: expect.stringMatching(/^transient:ghl: GHL 503 .*\(3 tries; this step alone is re-checked every 15 minutes, then hourly\)$/) });
      const held = DateTime.fromJSDate(r.next_run_at!).diff(at.minus({ minutes: 5 }), "minutes").minutes;
      expect(held).toBeGreaterThan(14); expect(held).toBeLessThan(16);
      expect(await asOperator((c) => one<{ step_held: boolean }>(c, "select step_held from runs where id=$1", [runId]))).toEqual({ step_held: true });
      const key = `run:${runId}:paused`;
      let a = await alerts(key);
      expect(a).toHaveLength(1); expect(a[0].text).toBe("Card then note is paused: it couldn't move the x card for Bo Retry after 3 tries (GHL says no healthy upstream). Nothing after it runs without it, so the engine re-checks only this step every 15 minutes, then hourly, and carries on by itself when it passes. Retry or skip it on the run page.");
      // not due yet: a tick leaves it alone
      expect(await tickAt(at)).toMatchObject({ claimed: 0 });
      // the first re-check: still down; the next is an hour away; still one alert
      await wake(runId); await tickAt(at);
      expect(tries.createOpportunity).toBe(4);
      r = (await run(runId))!;
      expect(r).toMatchObject({ status: "paused", current_node: "n1" });
      const hour = DateTime.fromJSDate(r.next_run_at!).diff(at, "minutes").minutes; expect(hour).toBeGreaterThan(59); expect(hour).toBeLessThan(61);
      expect(await alerts(key)).toHaveLength(1);
      expect(notes).toHaveLength(0); expect(cards).toHaveLength(0);
      // the CRM is back: the re-check passes, the card is made once, the run carries on to the note and finishes
      cardMode = "ok"; at = at.plus({ hours: 1 });
      await wake(runId); await tickAt(at);
      expect(await run(runId)).toMatchObject({ status: "completed", step_attempt: 0 });
      expect(cards).toHaveLength(1); expect(notes).toEqual([`Card ghl-opp-${oppSeq}`]);
      expect(tries.createOpportunity).toBe(5);
      a = await alerts(key); expect(a[0].resolved_at).not.toBeNull();
      expect(await asOperator((c) => one<{ resolved_announced: boolean }>(c, "select resolved_announced from alerts where company_id=$1 and key=$2", [companyId, key]))).toEqual({ resolved_announced: true });   // never announced in this test, so it closes quietly; announced, it posts ✅ Resolved
      // only the held step was re-run: one trigger row, n1's five rows, one note row
      const all = await asOperator((c) => many<{ step: string; n: number }>(c, "select node_id||':'||status as step, count(*)::int as n from run_steps where run_id=$1 group by 1 order by 1", [runId]));
      expect(all).toEqual([{ step: "n1:failed", n: 4 }, { step: "n1:ok", n: 1 }, { step: "n2:ok", n: 1 }, { step: "t1:ok", n: 1 }, { step: "x1:ok", n: 1 }]);
    } finally { cardMode = "ok"; cards.length = 0; notes.length = 0; }
  });

  describe("a second delivery starts nothing", () => {
    const snap = (id: string, ghl: string): AppointmentSnapshot => { const start = DateTime.now().plus({ days: 3 }); return { id, calendarId: "CAL1", contactId: ghl, startTime: start.toISO()!, endTime: start.plus({ minutes: 45 }).toISO()!, status: "confirmed", dateAdded: new Date().toISOString(), raw: {} }; };
    const runsOf = (name: string) => asOperator((c) => many<{ id: string }>(c, "select id from runs where workflow_id=$1", [wfIds[name]]));
    const eventsOf = (type: string, contactId: string) => asOperator((c) => many(c, "select 1 from events where company_id=$1 and event_type=$2 and contact_id=$3", [companyId, type, contactId]));

    it("the poll delivers the same appointment twice: one booking event, one run (the no-delta path)", async () => {
      const ct = await newContact("R8", "Hal");
      const s = snap("A1", "R8");
      for (let i = 0; i < 2; i++) await asOperator(async (c) => { const { row, adapterCompany } = await loadCompany(c, companyId); await applyAppointment(c, row, adapterCompany, fake, s); });
      expect(await eventsOf("appointment.booked", ct)).toHaveLength(1);
      expect((await runsOf("Book it")).length).toBe(1);
    });

    it("the same recording twice: the second is a duplicate, no second event", async () => {
      const ct = await newContact("R9", "Ida");
      await asOperator((c) => c.query("insert into contact_identifiers (company_id, contact_id, kind, value) values ($1,$2,'email','ida@x.com')", [companyId, ct]));
      const input = { externalId: "rec-1", startedAt: new Date(), invitees: [{ email: "ida@x.com", name: "Ida", isExternal: true }], recordedBy: { email: "closer@x.com" } };
      const first = await asOperator((c) => recordRecording(c, companyId, input));
      const second = await asOperator((c) => recordRecording(c, companyId, input));
      expect(first.outcome).not.toBe("duplicate"); expect(second.outcome).toBe("duplicate");
      expect(await asOperator((c) => many(c, "select 1 from events where company_id=$1 and event_type like 'recording.%'", [companyId]))).toHaveLength(1);
      expect(await asOperator((c) => many(c, "select 1 from recordings where company_id=$1 and external_id='rec-1'", [companyId]))).toHaveLength(1);
    });

    it("startRun twice for the same event: the (workflow_id, reentry_key) unique keeps it to one run", async () => {
      const ct = await newContact("R10", "Jon");
      const { ev, runId } = await fire(ct, "tag");
      const again = await asOperator((c) => startRun(c, { companyId, workflowId: wfIds["Tag it"], triggerNodeId: "t1", event: ev as EventRow, contactId: ct }));
      expect(runId).toBeTruthy(); expect(again).toBeNull();
      expect((await runsOf("Tag it")).filter(Boolean).length).toBeGreaterThan(0);
      expect(await asOperator((c) => many(c, "select 1 from runs where workflow_id=$1 and triggered_by_event=$2", [wfIds["Tag it"], ev.id]))).toHaveLength(1);
    });
  });
});
