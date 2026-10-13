/**
 * D90: the closing chain as it ran live on Hair on 2026-10-12 (Tyler TEST: a $1,500 deposit, Payment recorded wins the
 * opportunity, Deal closed puts the closer card on Closed - Won), against a fake CRM that remembers its cards the way GHL does
 * (every write stamps `updatedAt`), and the cards poll looking at the boards after it. What the engine writes to a card is
 * never read back as a hand; a person's (or a CRM workflow's) move still is, once; a card closed before the engine got
 * there is not made twice.
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { DateTime } from "luxon";
import { asOperator, one, many } from "@/db/client";
import { migrate } from "@/db/migrate";
import { encrypt } from "@/engine/crypto";
import { installCompany } from "@/engine/install";
import { dispatchEvent, emitEvent, startRun } from "@/engine/dispatch";
import { parseDefinition, extractManifest } from "@/engine/definition";
import { applyAppointment, pollCards, type PollReport } from "@/engine/poll";
import { applyPayment } from "@/engine/lifecycle";
import { loadCompany } from "@/engine/context";
import { tick } from "@/engine/runner";
import { simulate } from "@/engine/simulate";
import { fakeAdapters, fakeProbes } from "@/engine/test-install";
import type { Adapters, AppointmentSnapshot, LiveCard } from "@/adapters/types";

const HAS_DB = !!process.env.DATABASE_URL;
process.env.BINDINGS_KEY ??= Buffer.alloc(32, 7).toString("base64");
const TZ = "America/Phoenix";

// the CRM's cards, by id; `writes` counts what the engine asked of it
const cards = new Map<string, LiveCard>();
const writes: { op: string; id: string; stageId?: string; status?: string }[] = [];
let seq = 0;
/** A CRM workflow of the company's own: when this tag lands, the contact's open closer card goes to Closed - Won, won (what Hair's GHL did live). */
let automation: { tag: string; stageId: string } | null = null;
/** Holds an engine card write after the CRM took it, until the test lets it go (a run's transaction still open). */
let holdWrite: Promise<void> | null = null, wroteHeld: (() => void) | null = null;
const at = () => new Date(Date.now() + ++seq).toISOString();   // each CRM write a later stamp, as GHL's clock would give
const crmMove = (id: string, patch: Partial<LiveCard>) => { const k = cards.get(id)!; Object.assign(k, patch, { updatedAt: at() }); };
const base = fakeAdapters();
const appts = new Map<string, AppointmentSnapshot>();
const fake: Adapters = {
  ...base,
  read: { ...base.read, listUsers: async () => [{ id: "U1", name: "Sam Closer", email: "sam@x.com" }],
    openCards: async (_c, ghlId) => [...cards.values()].filter((k) => k.contactId === ghlId).map((k) => ({ ...k })),
    pipelineCards: async (_c, pipelineId) => [...cards.values()].filter((k) => k.pipelineId === pipelineId).map((k) => ({ ...k })) },
  booking: (() => { const b = { appointmentsInWindow: async () => [], listCalendars: async () => [{ id: "CAL", name: "Closer Call", teamMemberIds: ["U1"] }], getAppointment: async (_c: unknown, id: string) => appts.get(id) ?? null }; return { ghl: b, calendly: b }; })(),
  write: { ...base.write,
    addTag: async (_c, ghlId, tag) => {
      if (automation?.tag !== tag) return;
      for (const k of cards.values()) if (k.contactId === ghlId && k.pipelineId === CRM.pipeline_closer && k.status === "open") crmMove(k.id, { stageId: automation.stageId, status: "won", updatedBy: undefined });
    },
    createOpportunity: async (_c, input) => { const id = `GO-${++seq}`; cards.set(id, { id, pipelineId: input.pipelineId, stageId: input.stageId, status: input.status, name: input.name, assignedUserId: input.assignedUserId, contactId: input.contactId, updatedAt: at() }); writes.push({ op: "create", id, stageId: input.stageId, status: input.status }); return { id }; },
    updateOpportunity: async (_c, id, patch) => {
      crmMove(id, { stageId: patch.stageId ?? cards.get(id)!.stageId, status: patch.status ?? cards.get(id)!.status, name: patch.name ?? cards.get(id)!.name });
      writes.push({ op: "update", id, stageId: patch.stageId, status: patch.status });
      if (holdWrite) { wroteHeld?.(); await holdWrite; }
    } },
};

const CRM = { pipeline_setter: "PIPE-SETTER", pipeline_closer: "PIPE-CLOSER", stage_setter_new_lead: "STAGE-NEW", stage_setter_direct_booked: "STAGE-DIRECT", stage_setter_appointment_set: "STAGE-SET", stage_setter_showed: "STAGE-SHOWED", stage_setter_cancelled: "STAGE-S-CANCEL",
  stage_closer_scheduled: "STAGE-SCHED", stage_closer_agreement_sent: "STAGE-AGREE", stage_closer_closed_won: "STAGE-WON", stage_closer_cancelled: "STAGE-C-CANCEL", stage_closer_follow_up: "STAGE-FOLLOWUP", stage_closer_lost: "STAGE-LOST", stage_closer_disqualified: "STAGE-DQ",
  field_opportunity_stage_entered: "CF-STAGE-DATE", field_contact_appointment_date: "CF-APPT-DATE", field_contact_cash_collected: "CF-CASH", field_contact_revenue_generated: "CF-REV", field_contact_setter: "CF-SETTER", field_opportunity_setter_owner: "CF-SETTER-OWNER",
  assoc_sales_call_contact: "ASSOC-SC", assoc_sales_call_opportunity: "ASSOC-SO", assoc_payment_contact: "ASSOC-PC", assoc_payment_opportunity: "ASSOC-PO", agreement_template: "TPL-AGREE", agreement_sender: "U1", default_closer: "U1" };
const TABLES = ["alerts", "eod_reports", "slack_posts", "agreements", "sends", "step_effects", "runs", "events", "slack_connections", "workflow_triggers", "workflows", "messages", "crm_records", "webhook_deliveries", "payments", "recordings", "form_submissions", "forms", "appointments", "pipeline_cards", "opportunities", "calendars", "contact_identifiers", "intake", "contacts", "users", "company_terms", "bindings", "poll_cursors", "audit_log"];
let companyId: string;

const runsOf = (slug: string, contactId: string) => asOperator((c) => many<{ id: string; status: string; current_node: string | null; exit_reason: string | null; claimed_at: Date | null; finished_at: Date | null }>(c,
  "select r.id, r.status, r.current_node, r.exit_reason, r.claimed_at, r.finished_at from runs r join workflows w on w.id=r.workflow_id join workflow_templates t on t.id=w.template_id where w.company_id=$1 and t.slug=$2 and r.contact_id=$3 order by r.started_at, r.id", [companyId, slug, contactId]));
const stepOf = async (runId: string, node: string) => (await asOperator((c) => one<{ status: string; result: Record<string, unknown> }>(c, "select status, result from run_steps where run_id=$1 and node_id=$2 order by started_at desc, id desc limit 1", [runId, node])))!;
const cardMoves = (contactId: string) => asOperator((c) => many<{ data: Record<string, unknown> }>(c, "select data from events where company_id=$1 and contact_id=$2 and event_type='card.moved' order by id", [companyId, contactId])).then((r) => r.map((x) => x.data));
const closerCards = (ghlId: string) => [...cards.values()].filter((k) => k.contactId === ghlId && k.pipelineId === CRM.pipeline_closer);
const report = (): PollReport => ({ companies: 0, contacts: 0, appointmentsNew: 0, appointmentsChanged: 0, inbound: 0, calls: 0, agreements: 0, cardsMoved: 0, eventsDispatched: 0, baselined: 0, errors: [] });
const pollTheCards = () => asOperator(async (c) => { const { row, adapterCompany, bindings } = await loadCompany(c, companyId); const rep = report(); await pollCards(c, row, adapterCompany, fake, rep, bindings); return rep; });
const tickNow = () => tick(fake, DateTime.now() as DateTime<true>, companyId, fakeProbes);
const holdDealClosed = (contactId: string, hold: boolean) => asOperator((c) => c.query(`update runs set next_run_at=${hold ? "now() + interval '1 hour'" : "now()"} from workflows w join workflow_templates t on t.id=w.template_id where runs.workflow_id=w.id and t.slug='deal-closed' and runs.contact_id=$1 and runs.status in ('active','waiting')`, [contactId]));

/** A self-booked closing call (Call booked makes the cards in the CRM), signed, then a $1,500 deposit dispatched; the cards poll has had its silent first look. */
async function toTheDeposit(ghlId: string, first: string): Promise<string> {
  const contactId = await asOperator(async (c) => (await one<{ id: string }>(c, "insert into contacts (company_id, ghl_contact_id, first_name, last_name, timezone) values ($1,$2,$3,'TEST',$4) returning id", [companyId, ghlId, first, TZ]))!.id);
  await asOperator((c) => c.query("insert into contact_identifiers (company_id, contact_id, kind, value) values ($1,$2,'email',$3)", [companyId, contactId, `${ghlId.toLowerCase()}@x.com`]));
  const start = DateTime.now().setZone(TZ).minus({ hours: 2 });
  const s: AppointmentSnapshot = { id: `A-${ghlId}`, calendarId: "CAL", contactId: ghlId, assignedUserId: "U1", startTime: start.toISO()!, endTime: start.plus({ minutes: 45 }).toISO()!, status: "confirmed", dateAdded: start.minus({ days: 1 }).toISO()!, raw: {} };
  appts.set(s.id, s);
  await asOperator(async (c) => { const { row, adapterCompany } = await loadCompany(c, companyId); await applyAppointment(c, row, adapterCompany, fake, s); });
  await tickNow();
  expect(closerCards(ghlId)).toEqual([expect.objectContaining({ stageId: CRM.stage_closer_scheduled, status: "open" })]);
  await pollTheCards();   // the first pass is the silent baseline (and later ones see these cards as the engine left them)
  await asOperator((c) => c.query("update contacts set tags = array_append(tags, 'sys-test') where id=$1 and not ('sys-test' = any(tags))", [contactId]));   // D97: the harness stages only for a test contact
  await asOperator((c) => simulate({ c, company: { id: companyId, mode: "live", timezone: TZ } as never, contactId, force: true }, "sign"));
  await tickNow();
  expect((await runsOf("deal-closed", contactId)).at(-1)).toMatchObject({ status: "completed", exit_reason: "not_yet" });
  await asOperator(async (c) => dispatchEvent(c, await applyPayment(c, companyId, contactId, { whopPaymentId: `pay-${ghlId}`, amount: 1500, currency: "USD", status: "succeeded", paidAt: new Date(), raw: {} }), { contact: { id: contactId } }));
  return contactId;
}

describe.skipIf(!HAS_DB)("D90: the closing chain and the cards poll", () => {
  beforeAll(async () => {
    await migrate().catch((e: Error) => { if (!/events_source_check/.test(e.message)) throw e; });
    await asOperator(async (c) => {
      const co = await one<{ id: string }>(c, "select id from companies where slug='closing-chain'"); if (!co) return;
      await c.query("delete from run_steps where run_id in (select id from runs where company_id=$1)", [co.id]);
      await c.query("delete from workflow_versions where workflow_id in (select id from workflows where company_id=$1)", [co.id]);
      await c.query("update appointments set disposition_id=null where company_id=$1", [co.id]);
      for (const t of TABLES) await c.query(`delete from ${t} where company_id=$1`, [co.id]);
      await c.query("delete from companies where id=$1", [co.id]);
    });
    const r = await installCompany({ name: "Closing chain", slug: "closing-chain", timezone: TZ, locationId: "LOC", pit: "pit-fake", calendars: { CAL: "closing" }, setterRule: "question", closers: ["sam@x.com"], enable: true, crm: CRM, slack: { bookings: "CBOOK", deals: "CDEALS", payments: "CPAY", alerts: "CALERTS" }, anthropicKey: "sk-fake", contractValueDefault: 2999,
      templates: ["call-booked", "agreement-signed", "payment-recorded", "deal-closed", "card-moved"] }, fake);
    companyId = r.companyId;
    expect([...r.installed].sort()).toEqual(["agreement-signed → enabled", "call-booked → enabled", "card-moved → enabled", "deal-closed → enabled", "payment-recorded → enabled"]);
    await asOperator(async (c) => {
      await c.query("update companies set mode='live', send_window_start='00:00', send_window_end='23:59' where id=$1", [companyId]);
      await c.query("insert into slack_connections (company_id, team_id, bot_token, bot_user_id, channels) values ($1,'T1',$2,'UBOT','{}')", [companyId, encrypt("xoxb-fake")]);
    });
  });
  beforeEach(() => { automation = null; holdWrite = null; wroteHeld = null; });

  it("the engine's own moves: Payment recorded wins the opportunity, Deal closed puts the closer card on Closed - Won (won) and marks the setter card won; the next poll sees the CRM where the engine put it and says nothing. A person's drag afterwards is one card.moved", async () => {
    const ct = await toTheDeposit("TT1", "Tyler");
    await tickNow();
    expect((await runsOf("payment-recorded", ct)).at(-1)).toMatchObject({ status: "completed" });
    const closed = (await runsOf("deal-closed", ct)).at(-1)!;
    expect(closed).toMatchObject({ status: "completed", exit_reason: "closed" });
    expect(await stepOf(closed.id, "p1")).toMatchObject({ status: "ok", result: { card: "moved", stage: CRM.stage_closer_closed_won, card_status: "won" } });
    expect(closerCards("TT1")).toEqual([expect.objectContaining({ stageId: CRM.stage_closer_closed_won, status: "won" })]);
    expect(await pollTheCards()).toMatchObject({ cardsMoved: 0, errors: [] });
    await tickNow();
    expect(await cardMoves(ct)).toEqual([]);
    expect(await runsOf("card-moved", ct)).toEqual([]);
    // a closer drags the card back to Follow Up in the CRM: that is a hand
    crmMove(closerCards("TT1")[0].id, { stageId: CRM.stage_closer_follow_up, updatedBy: "U1" });
    expect(await pollTheCards()).toMatchObject({ cardsMoved: 1 });
    expect(await cardMoves(ct)).toEqual([expect.objectContaining({ pipeline: "closer", from_stage: CRM.stage_closer_closed_won, to_stage: CRM.stage_closer_follow_up, by: "crm", mover: "Sam Closer" })]);
    expect(await pollTheCards()).toMatchObject({ cardsMoved: 0 });
  });

  it("as it ran live: a CRM workflow closes the closer card on Closed - Won seconds after the payment, before Deal closed runs. That is the CRM's move (one card.moved, said once); Deal closed finds its card already there and makes no second card (it made one live); the Card moved by hand run waits for the next tick and then completes", async () => {
    automation = { tag: "pay-plan-active", stageId: CRM.stage_closer_closed_won };
    const ct = await toTheDeposit("TT2", "Tess");
    const nWrites = writes.length;
    await holdDealClosed(ct, true); await tickNow();   // live, Payment recorded ran first and Deal closed after it in the same tick
    expect((await runsOf("payment-recorded", ct)).at(-1)).toMatchObject({ status: "completed" });
    expect(closerCards("TT2")).toEqual([expect.objectContaining({ stageId: CRM.stage_closer_closed_won, status: "won" })]);
    await holdDealClosed(ct, false); await tickNow();
    const closed = (await runsOf("deal-closed", ct)).at(-1)!;
    expect(closed).toMatchObject({ status: "completed", exit_reason: "closed" });
    expect(await stepOf(closed.id, "p1")).toMatchObject({ status: "skipped", result: { kind: "noop", why: "already there" } });
    expect(closerCards("TT2")).toHaveLength(1);
    expect(writes.slice(nWrites).filter((w) => w.op === "create")).toEqual([]);
    expect(await cardMoves(ct)).toEqual([expect.objectContaining({ pipeline: "closer", from_stage: CRM.stage_closer_scheduled, to_stage: CRM.stage_closer_closed_won, from_status: "open", to_status: "won", mover: null })]);
    // started inside Deal closed's transaction, so nothing claims it until the next tick: active on its trigger, never claimed, not stuck
    expect(await runsOf("card-moved", ct)).toEqual([expect.objectContaining({ status: "active", current_node: "t1", claimed_at: null, finished_at: null })]);
    await tickNow();
    expect(await runsOf("card-moved", ct)).toEqual([expect.objectContaining({ status: "completed", exit_reason: "noted", claimed_at: null, finished_at: expect.any(Date) })]);
    expect(await pollTheCards()).toMatchObject({ cardsMoved: 0 });
    expect(await cardMoves(ct)).toHaveLength(1);
  });

  it("a step with no status that picks a closed card (pick: latest) reopens it in the CRM, and the replica says open too: the next poll sees no hand", async () => {
    const { ct, oppId } = await asOperator(async (c) => {
      const ct = (await one<{ id: string }>(c, "insert into contacts (company_id, ghl_contact_id, first_name, last_name, timezone) values ($1,'TT4','Lou','TEST',$2) returning id", [companyId, TZ]))!.id;
      const oppId = (await one<{ id: string }>(c, "insert into opportunities (company_id, contact_id, opened_by, status) values ($1,$2,'test','lost') returning id", [companyId, ct]))!.id;
      return { ct, oppId };
    });
    cards.set("GO-LOST", { id: "GO-LOST", pipelineId: CRM.pipeline_closer, stageId: CRM.stage_closer_lost, status: "lost", name: "Lou TEST", contactId: "TT4", updatedAt: new Date(Date.now() - 3600e3).toISOString() });
    await asOperator((c) => c.query("insert into pipeline_cards (company_id, opportunity_id, contact_id, ghl_opportunity_id, ghl_pipeline_id, ghl_stage_id, name, status, updated_at) values ($1,$2,$3,'GO-LOST',$4,$5,'Lou TEST','lost',now() - interval '1 hour')", [companyId, oppId, ct, CRM.pipeline_closer, CRM.stage_closer_lost]));
    const def = parseDefinition({ schema: 1, reentry: "always", premise: { check: "contact_exists" }, nodes: [{ id: "t1", type: "trigger", event: "lead.created" }, { id: "p1", type: "pipeline_card", pipeline: "{{crm.pipeline_closer}}", stage: "{{crm.stage_closer_scheduled}}", pick: "latest" }, { id: "x1", type: "exit", reason: "done" }], edges: [{ from: "t1", to: "p1" }, { from: "p1", to: "x1" }] });
    await asOperator(async (c) => {
      const wf = (await one<{ id: string }>(c, "insert into workflows (company_id, name, reentry_policy, enabled) values ($1,'Back to Scheduled','always',true) returning id", [companyId]))!.id;
      await c.query("insert into workflow_versions (workflow_id, version, definition, manifest, note) values ($1,1,$2,$3,'test')", [wf, def, extractManifest(def)]);
      const ev = await emitEvent(c, { company_id: companyId, contact_id: ct, opportunity_id: null, appointment_id: null, event_type: "lead.created", source: "test", data: {} });
      await startRun(c, { companyId, workflowId: wf, triggerNodeId: "t1", event: ev, contactId: ct });
    });
    await tickNow();
    expect(cards.get("GO-LOST")).toMatchObject({ stageId: CRM.stage_closer_scheduled, status: "open" });
    expect(await asOperator((c) => one(c, "select ghl_stage_id, status from pipeline_cards where ghl_opportunity_id='GO-LOST' and company_id=$1", [companyId]))).toEqual({ ghl_stage_id: CRM.stage_closer_scheduled, status: "open" });
    expect(await pollTheCards()).toMatchObject({ cardsMoved: 0, errors: [] });
    expect(await cardMoves(ct)).toEqual([]);
  });

  it("an engine write still in flight when the poll looks: the CRM already has the new stage, the run has not committed; the poll waits for it and sees no hand", async () => {
    const ct = await toTheDeposit("TT3", "Theo");
    await holdDealClosed(ct, true); await tickNow();
    let release!: () => void;
    holdWrite = new Promise<void>((r) => { release = r; });
    const written = new Promise<void>((r) => { wroteHeld = r; });
    await holdDealClosed(ct, false);
    const ticking = tickNow();
    await written; holdWrite = null;   // Deal closed's p1 is in the CRM; its transaction is still open
    expect(closerCards("TT3")).toEqual([expect.objectContaining({ stageId: CRM.stage_closer_closed_won, status: "won" })]);
    const polling = pollTheCards();
    await new Promise((r) => setTimeout(r, 300));
    release();
    const [, rep] = await Promise.all([ticking, polling]);
    expect(rep).toMatchObject({ cardsMoved: 0, errors: [] });
    expect((await runsOf("deal-closed", ct)).at(-1)).toMatchObject({ status: "completed", exit_reason: "closed" });
    expect(await cardMoves(ct)).toEqual([]);
  });
});
