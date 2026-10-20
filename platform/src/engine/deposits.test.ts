/**
 * D119: a deposit is not a close. A deposit is a payment for one of the company's declared deposit products (never a guess
 * from the amount); filed on a call it is the company's own Deposit disposition, stat-deposit and the closer card's Deposit
 * stage; the agreement, the chase, the won opportunity and Deal closed wait for the first payment beyond it; the reports give
 * deposits their own line. Three companies, as they are bound: Hair-like (no deposit product, no Deposit option, no Deposit
 * stage: only what Tyler decided changes), PMU-like (one board, its own copies from installs/pmu) and Dating-like (two boards,
 * the shipped templates and Nelly's Deal closed copy).
 */
import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { DateTime } from "luxon";
import { asOperator, one, many } from "@/db/client";
import { migrate } from "@/db/migrate";
import { templates } from "@/templates";
import { installCompany, type InstallInput } from "./install";
import { findCompanyWorkflow, saveDefinition } from "./definitions";
import { recordPayment, deriveKind, depositProducts, isDepositProduct, type PaymentInput } from "./payments";
import { recordDisposition } from "./disposition";
import { dispatchEvent } from "./dispatch";
import { loadCompany } from "./context";
import { simulate } from "./simulate";
import { tick } from "./runner";
import { fakeAdapters, unlockSendsForTest } from "./test-install";
import { parseWhopEvent } from "./webhooks/whop";
import { parseZapierPayment } from "./webhooks/zapier";
import { dispositionValues } from "./sales-call";
import { render } from "./template";
import { mergeEodFields, totalsOf, type CallEntry } from "./eod-form";
import { prefill } from "./eod";
import { getMetric } from "./metric-registry";
import { reportFacts, renderLayout, shippedLayout, WRAPUP_METRICS } from "./reports";
import type { Adapters } from "@/adapters/types";
import type { GhlObjectRecord, GhlReads } from "@/adapters/ghl/metrics";

process.env.BINDINGS_KEY ??= Buffer.alloc(32, 7).toString("base64");
const TZ = "America/New_York";
const PMU_DIR = path.resolve(__dirname, "../../installs/pmu");
const NELLY_DIR = path.resolve(__dirname, "../../installs/dating-nelly");
const copy = (dir: string, slug: string) => JSON.parse(fs.readFileSync(path.join(dir, `${slug}.json`), "utf8")) as { definition: unknown; note: string };

// ---- the option keys, the kinds, the doors: pure ---------------------------------------------------------------------------
// Hair's Sales Call Outcome options (D83): no Deposit option; PMU's and Dating Nelly's have one (read from their GHL, 2026-10-16)
const HAIR_DISPOSITIONS = { closed_won: "closed", follow_up: "follow_up", lost: "lost", dq: "unqualified", financing_denied: { meaning: "lost", reason: "Financing denied" }, close_pending: "pending" };
const PMU_DISPOSITIONS = { closed_won: "closed", deposit: "deposit", follow_up: "follow_up", lost: "lost", dq: "unqualified", no_offer: { meaning: "unqualified", reason: "No offer made (DQ before the pitch)" } };
const DATING_DISPOSITIONS = { ...PMU_DISPOSITIONS, financing_denied: { meaning: "lost", reason: "Financing denied" }, close_pending: "pending" };

describe("D119: what a deposit is", () => {
  it("a deposit is a payment for a declared deposit product, whatever its amount; nothing else ever is", () => {
    expect(deriveKind(300, 0, 5000, "succeeded", true)).toBe("deposit");
    expect(deriveKind(5000, 0, 5000, "succeeded", true)).toBe("deposit");   // even one that would clear the price
    expect(deriveKind(300, 0, 5000, "succeeded")).toBe("installment");     // short of the price is the first installment
    expect(deriveKind(4700, 300, 5000, "succeeded")).toBe("balance");       // the deposit counts toward the price
    expect(deriveKind(1000, 300, 5000, "succeeded")).toBe("installment");
    expect(deriveKind(-300, 300, 5000, "refunded", true)).toBe("refund");
    expect(deriveKind(300, 0, 5000, "failed", true)).toBe("failed");
  });
  it("the products: Whop's product id or plan id, or a Zap's plan, as the install declares them", () => {
    const products = depositProducts(JSON.stringify(["prod_DEP", " plan_DEP "]));
    expect(products).toEqual(["prod_DEP", "plan_DEP"]);
    expect(isDepositProduct({ product_id: "prod_DEP", plan_id: "plan_x" }, products)).toBe(true);
    expect(isDepositProduct({ product_id: "prod_MAIN", plan_id: "plan_DEP" }, products)).toBe(true);
    expect(isDepositProduct({ plan: "plan_DEP" }, products)).toBe(true);
    expect(isDepositProduct({ product_id: "prod_MAIN", plan_id: "plan_MAIN" }, products)).toBe(false);
    expect(isDepositProduct({ product_id: "prod_DEP" }, [])).toBe(false);   // nothing declared: nothing is a deposit
    expect(depositProducts("not json")).toEqual([]); expect(depositProducts(undefined)).toEqual([]);
    const whop = parseWhopEvent({ id: "msg_1", type: "payment.succeeded", data: { id: "pay_1", total: { amount: "250", currency: "usd" }, plan_id: "plan_DEP", product_id: "prod_MAIN", customer_email: "a@x.com", paid_at: "2026-10-16T12:00:00Z" } });
    expect(isDepositProduct(whop!.raw, products)).toBe(true);
    const zap = parseZapierPayment({ transaction_id: "z1", amount: "250", product_id: "prod_DEP", plan_id: "plan_y" });
    expect(zap.ok && zap.input.raw).toMatchObject({ product_id: "prod_DEP", plan_id: "plan_y" });
  });
  it("the Sales Call Outcome a meaning is written as, in the company's own keys: a deposit is the Deposit option, and nothing on a field without one", () => {
    expect(dispositionValues({ "sales_call.dispositions": JSON.stringify(HAIR_DISPOSITIONS) })).toEqual({ closed: "closed_won", pending: "close_pending", follow_up: "follow_up", lost: "lost", unqualified: "dq" });
    expect(dispositionValues({ "sales_call.dispositions": JSON.stringify(PMU_DISPOSITIONS) })).toEqual({ closed: "closed_won", deposit: "deposit", follow_up: "follow_up", lost: "lost", unqualified: "dq" });
    expect(dispositionValues({})).toEqual({ closed: "closed_won", deposit: "deposit", pending: "close_pending", follow_up: "follow_up", lost: "lost", unqualified: "dq" });
    const v = templates.find((t) => t.slug === "call-outcome")!.definition.nodes.find((n) => n.id === "v_disp") as unknown as { value: string };
    const as = (map: object, meaning: string) => render(v.value, { appointment: { call_outcome: meaning }, picklist: { sales_call_disposition: dispositionValues({ "sales_call.dispositions": JSON.stringify(map) }) } }, { tz: TZ });
    // Hair: every answer writes what it wrote before, except a deposit, which was closed_won
    expect(["closed", "follow_up", "lost", "unqualified", "pending", "deposit"].map((m) => as(HAIR_DISPOSITIONS, m))).toEqual(["closed_won", "follow_up", "lost", "dq", "close_pending", ""]);
    expect(as(PMU_DISPOSITIONS, "deposit")).toBe("deposit"); expect(as(DATING_DISPOSITIONS, "deposit")).toBe("deposit");
  });
  it("the end-of-day form: a deposit's cash is asked and counted, its revenue is not (revenue contracted is a close's)", () => {
    const fields = mergeEodFields(null);
    expect(fields.find((f) => f.key === "cash")!.when).toEqual(["closed", "deposit"]);
    expect(fields.find((f) => f.key === "revenue")!.when).toEqual(["closed"]);
    const call = (outcome: string, cash: number, revenue: number | null): CallEntry => ({ appointment_id: outcome, contact_id: "", contact: outcome, starts_at: "", href_contact: null, recording_url: null, outcome, revenue, cash, next_date: null, next_steps: "", dq_reason: "", dq_note: "", about: "", notes: "", extra: {} });
    expect(totalsOf([call("closed", 1000, 5000), call("deposit", 300, 5000)], fields)).toEqual({ calls_count: 2, closes: 1, deposits: 1, cash: 1300, revenue: 5000 });
  });
});

// ---- the wrap-ups: their own line ------------------------------------------------------------------------------------------
describe("D119: deposits in the wrap-ups", () => {
  it("each wrap-up reads deposits and deposit cash and words them on their own lines, never as closes; none, and there is no line (Hair's wrap-up reads as before)", () => {
    for (const kind of ["daily", "weekly", "monthly"] as const) {
      const t = templates.find((x) => x.slug === `${kind}-wrap-up`)!;
      const step = t.definition.nodes.find((n) => n.type === "report") as unknown as { metrics: string[] };
      expect(step.metrics, kind).toEqual(expect.arrayContaining(["deposits", "deposit_cash", "closes", "cash_collected"]));
      const facts = (numbers: Record<string, number>) => reportFacts({ kind, period: { start: "2026-10-01", end: "2026-10-16" }, tz: TZ, toDate: false, numbers, calls: null, said: [], readAt: new Date("2026-10-16T20:00:00Z") });
      const body = renderLayout(shippedLayout(kind), facts({ closes: 1, deposits: 2, deposit_cash: 600, cash_collected: 5600, cash_gross: 5600 }), {}, { tz: TZ, companyTz: TZ });
      const rows = body.split("\n").map((l) => l.replace(/\s+/g, " ").trim());
      expect(rows, kind).toEqual(expect.arrayContaining(["Closes 1", "Deposits 2", "Deposit cash $600", "Cash $5,600"]));
      const none = renderLayout(shippedLayout(kind), facts({ closes: 1, cash_collected: 5000, cash_gross: 5000 }), {}, { tz: TZ, companyTz: TZ });
      expect(none, kind).not.toMatch(/Deposit/);
    }
    expect(WRAPUP_METRICS).toEqual(expect.arrayContaining(["deposits", "deposit_cash"]));
  });
});

// ---- through the engine ----------------------------------------------------------------------------------------------------
const tags: { contact: string; tag: string }[] = [], removed: { contact: string; tag: string }[] = [];
const records: Record<string, unknown>[] = [], cards: Record<string, unknown>[] = [], docs: { contactId: string }[] = [];
const base = fakeAdapters();
const fake: Adapters = { ...base,
  read: { ...base.read, listUsers: async () => [{ id: "U-CLOSER", name: "Casey Closer", email: "casey@d119.test" }] },
  write: { ...base.write, addTag: async (_c, id, tag) => { tags.push({ contact: id, tag }); }, removeTag: async (_c, id, tag) => { removed.push({ contact: id, tag }); },
    createRecord: async (_c, object, props) => { records.push({ op: "create", object, ...props }); return { id: `rec-${records.length}` }; },
    updateRecord: async (_c, object, id, props) => { records.push({ op: "update", object, id, ...props }); },
    createOpportunity: async (_c, input) => { cards.push({ op: "create", ...input }); return { id: `card-${cards.length}` }; },
    updateOpportunity: async (_c, id, patch) => { cards.push({ op: "update", id, ...patch }); },
    sendDocumentTemplate: async (_c, input) => { docs.push(input); return { id: `doc-${docs.length}` }; } } };

const CRM = { pipeline_closer: "P-C", stage_closer_scheduled: "ST-SCHED", stage_closer_follow_up: "ST-FU", stage_closer_lost: "ST-LOST", stage_closer_disqualified: "ST-DQ", stage_closer_cancelled: "ST-CXL",
  stage_closer_agreement_sent: "ST-AGREE", stage_closer_closed_won: "ST-WON", field_contact_cash_collected: "F-CASH", field_contact_revenue_generated: "F-REV", agreement_template: "TPL", agreement_sender: "U-CLOSER",
  assoc_payment_contact: "A-PC", assoc_payment_opportunity: "A-PO" };
const TWO_BOARDS = { ...CRM, pipeline_setter: "P-S", stage_setter_showed: "ST-S-SHOWED", stage_setter_cancelled: "ST-S-CXL" };
const OUTCOMES = { scheduled: "scheduled", showed: "showed", no_show: "noshow", cancelled: "cancelled", rescheduled: "rescheduled" } as const;
const SLUGS = ["call-outcome", "payment-recorded", "deal-closed", "agreement-chase", "agreement-signed"];
const install = (slug: string, extra: Partial<InstallInput>): InstallInput => ({ name: slug, slug, timezone: TZ, locationId: `LOC-${slug}`, pit: "fake", calendars: { CAL: "closing" }, closers: ["casey@d119.test"], testDomains: ["d119.test"], templates: SLUGS, enable: true, contractValueDefault: 5000, anthropicKey: "sk-fake", ...extra });

async function wipe(slug: string) {
  await asOperator(async (c) => {
    const co = await one<{ id: string }>(c, "select id from companies where slug=$1", [slug]); if (!co) return;
    await c.query("delete from run_steps where run_id in (select id from runs where company_id=$1)", [co.id]);
    await c.query("delete from workflow_versions where workflow_id in (select id from workflows where company_id=$1)", [co.id]);
    await c.query("update appointments set disposition_id=null where company_id=$1", [co.id]);
    for (const t of ["step_effects", "alerts", "eod_reports", "slack_posts", "agreements", "sends", "runs", "events", "slack_connections", "workflow_triggers", "workflows", "messages", "crm_records", "webhook_deliveries", "payments", "recordings", "form_submissions", "forms", "appointments", "pipeline_cards", "opportunities", "calendars", "contact_identifiers", "intake", "contacts", "users", "company_terms", "bindings", "poll_cursors", "audit_log"])
      await c.query(`delete from ${t} where company_id=$1`, [co.id]);
    await c.query("delete from companies where id=$1", [co.id]);
  });
}
async function company(slug: string, extra: Partial<InstallInput>): Promise<string> {
  await wipe(slug);
  const id = (await installCompany(install(slug, extra), fake)).companyId;
  await asOperator((c) => c.query("update companies set mode='live', send_window_start='00:00', send_window_end='23:59' where id=$1", [id]));
  await unlockSendsForTest(id);   // D145
  return id;
}
/** A person who had their closing call an hour ago, with a Sales Call record for it and a closer card at Scheduled. */
async function person(co: string, key: string) {
  return asOperator(async (c) => {
    const ct = (await one<{ id: string }>(c, "insert into contacts (company_id, ghl_contact_id, first_name, last_name, timezone) values ($1,$2,$3,'Test',$4) returning id", [co, `G-${key}`, key, TZ]))!.id;
    await c.query("insert into contact_identifiers (company_id, contact_id, kind, value) values ($1,$2,'email',$3)", [co, ct, `${key.toLowerCase()}@d119.test`]);
    const term = (await one<{ id: string }>(c, "select id from company_terms where company_id=$1 and domain='appointment_type' and category='closing' and is_default", [co]))!.id;
    const closer = (await one<{ id: string }>(c, "select id from users where company_id=$1 and email='casey@d119.test'", [co]))!.id;
    // 50 minutes ago, but never in the hour before local midnight, so the call and its payments share a local day whatever the clock says
    const ago = DateTime.now().minus({ minutes: 50 }).setZone(TZ), at = ago.hour === 23 ? ago.set({ hour: 22 }) : ago;
    const opp = (await one<{ id: string }>(c, "insert into opportunities (company_id, contact_id, opened_by, contract_value) values ($1,$2,'first_booking',5000) returning id", [co, ct]))!.id;
    const appt = (await one<{ id: string }>(c, "insert into appointments (company_id, contact_id, opportunity_id, external_id, appointment_term, assigned_user_id, starts_at, ends_at, booked_at, status) values ($1,$2,$3,$4,$5,$6,$7,$8,now() - interval '3 days','confirmed') returning id",
      [co, ct, opp, `A-${key}`, term, closer, at.toJSDate(), at.plus({ minutes: 45 }).toJSDate()]))!.id;
    const objects = (await loadCompany(c, co)).bindings;
    await c.query("insert into crm_records (company_id, object_key, record_key, ghl_record_id, contact_id) values ($1,$2,$3,$4,$5)", [co, objects["crm.object_sales_call"] ?? "custom_objects.sales_call", `A-${key}`, `SC-${key}`, ct]);
    await c.query("insert into pipeline_cards (company_id, opportunity_id, contact_id, ghl_opportunity_id, ghl_pipeline_id, ghl_stage_id, name, status) values ($1,$2,$3,$4,'P-C','ST-SCHED',$5,'open')", [co, opp, ct, `CARD-${key}`, `${key} Test`]);
    return { ct, appt, ghl: `G-${key}`, card: `CARD-${key}`, at: at.toJSDate() };
  });
}
type Who = Awaited<ReturnType<typeof person>>;
const file = async (co: string, who: Who, callOutcome: string) => {
  await asOperator(async (c) => {
    const term = async (domain: string, cat: string) => (await one<{ id: string }>(c, "select id from company_terms where company_id=$1 and domain=$2 and category=$3 and active order by is_default desc limit 1", [co, domain, cat]))!.id;
    await recordDisposition(c, { companyId: co, appointmentId: who.appt, outcomeTermId: await term("appointment_outcome", "showed"), callOutcomeTermId: await term("call_outcome", callOutcome) });
  });
  for (let i = 0; i < 2; i++) await tick(fake, undefined, co);
};
let paid = 0;
const pay = async (co: string, who: Who, id: string, amount: number, raw: Record<string, unknown>) => {
  const r = await asOperator(async (c) => {
    // paid during the call, a second apart in the order made: on the call's local day (at 12:13 AM a payment "now" was the next day's)
    const input: PaymentInput = { providerPaymentId: id, amount, status: "succeeded", paidAt: new Date(who.at.getTime() + ++paid * 1000), raw };
    const out = await recordPayment(c, co, input, who.ct);
    if (out.outcome !== "linked") throw new Error(out.outcome);
    await dispatchEvent(c, out.event, { contact: { id: who.ct } });
    return out;
  });
  for (let i = 0; i < 3; i++) await tick(fake, undefined, co);
  return r;
};
const sign = async (co: string, who: Who) => {
  await asOperator(async (c) => { const { row } = await loadCompany(c, co); const r = await simulate({ c, company: row, contactId: who.ct, force: true }, "sign"); if (!r.ok) throw new Error(r.why); });
  for (let i = 0; i < 3; i++) await tick(fake, undefined, co);
};
/** The latest run of a workflow for a person, and how each of its steps went. */
const lastRun = async (co: string, slug: string, who: Who) => asOperator(async (c) => {
  const r = await one<{ id: string; status: string; exit_reason: string | null }>(c, "select r.id, r.status, r.exit_reason from runs r join workflows w on w.id=r.workflow_id left join workflow_templates t on t.id=w.template_id where r.company_id=$1 and r.contact_id=$2 and t.slug=$3 order by r.started_at desc, r.id desc limit 1", [co, who.ct, slug]);
  if (!r) return null;
  const steps = await many<{ node_id: string; status: string; why: string | null }>(c, "select node_id, status, result->>'why' as why from run_steps where run_id=$1 order by started_at, id", [r.id]);
  return { ...r, step: (id: string) => steps.find((s) => s.node_id === id) ?? null, ran: steps.map((s) => s.node_id) };
});
const runsOf = (co: string, slug: string, who: Who) => asOperator((c) => many<{ exit_reason: string | null }>(c, "select r.exit_reason from runs r join workflows w on w.id=r.workflow_id join workflow_templates t on t.id=w.template_id where r.company_id=$1 and r.contact_id=$2 and t.slug=$3 order by r.started_at", [co, who.ct, slug]));
const tagsOf = (who: Who) => tags.filter((t) => t.contact === who.ghl).map((t) => t.tag);
const removedOf = (who: Who) => removed.filter((t) => t.contact === who.ghl).map((t) => t.tag);
const salesCallWrites = (who: Who) => records.filter((r) => r.id === `SC-${who.ghl.slice(2)}`);
const cardWrites = (who: Who) => cards.filter((k) => k.id === who.card);
const kindOf = (co: string, id: string) => asOperator(async (c) => (await one<{ kind: string }>(c, "select kind from payments where company_id=$1 and whop_payment_id=$2", [co, id]))?.kind);

describe.skipIf(!process.env.DATABASE_URL)("D119: a deposit is not a close, company by company", () => {
  let hair: string, pmu: string, dating: string;
  beforeAll(async () => {
    await migrate();
    // Hair: two boards, its Outcome options have no Deposit, no Deposit stage, no deposit product declared
    hair = await company("d119hair", { crm: TWO_BOARDS, salesCall: { object: "custom_objects.sales_call", outcomes: OUTCOMES, dispositions: HAIR_DISPOSITIONS as never } });
    // PMU: one board with a Deposit stage, its Cash object, a deposit product, its own copies
    pmu = await company("d119pmu", { crm: { ...CRM, stage_closer_deposit: "ST-DEPOSIT", stage_closer_no_show: "ST-NOSHOW", stage_closer_purchase: "ST-PURCHASE", object_payment: "custom_objects.cash" },
      salesCall: { object: "custom_objects.sales_call", outcomes: OUTCOMES, dispositions: PMU_DISPOSITIONS as never }, depositProducts: ["prod_DEP"] });
    for (const slug of ["call-outcome", "payment-recorded", "deal-closed"]) {
      const { definition, note } = copy(PMU_DIR, slug);
      const saved = await asOperator(async (c) => { const w = await findCompanyWorkflow(c, pmu, slug); if (!w.ok) throw new Error(w.why); return saveDefinition(c, { workflowId: w.id, definition, note }); });
      expect(saved, slug).toMatchObject({ ok: true, saved: true });
    }
    // Dating Nelly: two boards with a Deposit stage, her objects' keys as PMU's, a deposit plan; her own Deal closed
    dating = await company("d119dating", { crm: { ...TWO_BOARDS, stage_closer_deposit: "ST-DEPOSIT" }, salesCall: { object: "custom_objects.sales_call", outcomes: OUTCOMES, dispositions: DATING_DISPOSITIONS as never }, depositProducts: ["plan_DEP"] });
    const dc = copy(NELLY_DIR, "deal-closed");
    expect(await asOperator(async (c) => { const w = await findCompanyWorkflow(c, dating, "deal-closed"); if (!w.ok) throw new Error(w.why); return saveDefinition(c, { workflowId: w.id, definition: dc.definition, note: dc.note }); })).toMatchObject({ ok: true, saved: true });
    // every workflow on (PMU's copies need none of the setter board's bindings the templates they replace would)
    const off = await asOperator((c) => many<{ name: string }>(c, "update workflows set enabled=true where company_id = any($1) and not enabled returning name", [[hair, pmu, dating]]));
    expect(off.map((w) => w.name).sort()).toEqual(["Call outcome filed", "Deal closed"]);   // PMU's, installed OFF for the template's setter board
  });

  it("Hair: a call filed as a deposit is no longer closed won: stat-deposit (not stat-closed-won), the Outcome left empty (its field has no Deposit option), and the card step skips, saying there is no Deposit stage", async () => {
    const who = await person(hair, "Hana");
    await file(hair, who, "deposit");
    const run = (await lastRun(hair, "call-outcome", who))!;
    expect(run).toMatchObject({ status: "completed", exit_reason: "noted" });
    expect(tagsOf(who)).toEqual(expect.arrayContaining(["stat-showed", "stat-deposit"])); expect(tagsOf(who)).not.toContain("stat-closed-won");
    expect(salesCallWrites(who).at(-1)).toMatchObject({ op: "update", outcome: "showed", disposition: null });
    expect(run.step("kd")).toMatchObject({ status: "skipped", why: "only if there is a Deposit stage on the closer board; there is no Deposit stage on the closer board" });
    expect(run.ran).not.toContain("kc"); expect(run.ran).not.toContain("c1");
    expect(cardWrites(who)).toEqual([]);   // the closer card stays where it was
  });

  it("Hair: a closed call files exactly as before (stat-closed-won, closed_won), and a payment short of the price is the first installment that sends the agreement, wins the opportunity and, signed, closes the deal", async () => {
    const who = await person(hair, "Hugo");
    await file(hair, who, "closed");
    expect(tagsOf(who)).toEqual(expect.arrayContaining(["stat-showed", "stat-closed-won"])); expect(tagsOf(who)).not.toContain("stat-deposit");
    expect(salesCallWrites(who).at(-1)).toMatchObject({ op: "update", outcome: "showed", disposition: "closed_won" });
    const nDocs = docs.length;
    // a product Hair never declared is no deposit, whatever it is called
    const r = await pay(hair, who, "pay_hugo_1", 750, { product_id: "prod_DEP", billing_reason: "subscription_create" });
    expect(r.payment.kind).toBe("installment"); expect(r.event.data).toMatchObject({ prior_total: 0, prior_non_deposit_total: 0 });
    const pr = (await lastRun(hair, "payment-recorded", who))!;
    expect(pr).toMatchObject({ status: "completed", exit_reason: "recorded" });
    expect(pr.step("o_won")?.status).toBe("ok"); expect(pr.ran).toEqual(expect.arrayContaining(["r1", "p1", "a1", "a2", "a3"])); expect(pr.ran).not.toContain("d1");
    expect(docs.length).toBe(nDocs + 1);
    expect(records.find((x) => x.transaction_id === "pay_hugo_1")).toMatchObject({ type: "installment" });
    expect((await runsOf(hair, "agreement-chase", who)).length).toBe(1);
    expect((await lastRun(hair, "deal-closed", who))?.exit_reason).toBe("not_yet");
    await sign(hair, who);
    expect((await lastRun(hair, "deal-closed", who))?.exit_reason).toBe("closed");
    expect(tagsOf(who)).toContain("stat-customer");
    expect(cardWrites(who).filter((k) => "monetaryValue" in k)).toEqual([]);   // Hair's template sets no value (D130 is Dating's copy)
  });

  it("Hair: the end-of-day form pre-fills a call paid short of the price as a close with its revenue, not a deposit (the amount says nothing)", async () => {
    const who = await person(hair, "Hal");
    await pay(hair, who, "pay_hal_1", 750, { billing_reason: "subscription_create" });
    const day = await asOperator(async (c) => { const { row } = await loadCompany(c, hair); const u = (await one<{ id: string }>(c, "select id from users where company_id=$1 and email='casey@d119.test'", [hair]))!; return prefill(c, row, { id: u.id, name: "Casey Closer", email: "casey@d119.test" }, DateTime.fromJSDate(who.at).setZone(TZ).toFormat("yyyy-MM-dd")); });
    expect(day.calls.find((x) => x.appointment_id === who.appt)).toMatchObject({ outcome: "closed", cash: 750, revenue: 5000 });
  });

  it("PMU: a Whop payment for its deposit product is a deposit: no agreement, no chase, no won opportunity, no revenue, pay-deposit (not pay-plan-active), the Cash record typed deposit; the Sales Call's cash still follows", async () => {
    const who = await person(pmu, "Pia");
    const nDocs = docs.length;
    const r = await pay(pmu, who, "pay_pia_dep", 500, { product_id: "prod_DEP", plan_id: "plan_500" });
    expect(r.payment.kind).toBe("deposit"); expect(r.event.data).toMatchObject({ kind: "deposit", prior_non_deposit_total: 0, running_total: 500, cleared: false });
    const pr = (await lastRun(pmu, "payment-recorded", who))!;
    expect(pr).toMatchObject({ status: "completed", exit_reason: "recorded" });
    expect(pr.step("o_won")?.status).toBe("skipped");
    expect(pr.ran).toContain("d1"); expect(pr.ran).not.toContain("r1"); expect(pr.ran).not.toContain("p1"); expect(pr.ran).not.toContain("a1");
    expect(docs.length).toBe(nDocs);
    expect(tagsOf(who)).toEqual(["pay-deposit"]);
    expect(records.find((x) => x.transaction_id === "pay_pia_dep")).toMatchObject({ op: "create", object: "custom_objects.cash", type: "deposit", amount: 500 });
    expect(salesCallWrites(who).at(-1)).toMatchObject({ op: "update", cash_collected: "500" });
    expect(await runsOf(pmu, "agreement-chase", who)).toEqual([]);
    expect(await asOperator(async (c) => (await one<{ status: string }>(c, "select status from opportunities where company_id=$1 and contact_id=$2", [pmu, who.ct]))!.status)).toBe("open");
    expect((await lastRun(pmu, "deal-closed", who))?.exit_reason).toBe("not_yet");
  });

  it("PMU: the call filed as a deposit is its Deposit outcome, stat-deposit and the card on Deposit; the end-of-day form pre-fills Deposit with the cash and no revenue", async () => {
    const who = (await asOperator((c) => one<{ id: string; appt: string; at: Date }>(c, "select ct.id, a.id as appt, a.starts_at as at from contacts ct join appointments a on a.contact_id=ct.id where ct.company_id=$1 and ct.ghl_contact_id='G-Pia'", [pmu])))!;
    const pia: Who = { ct: who.id, appt: who.appt, ghl: "G-Pia", card: "CARD-Pia", at: who.at };
    const day = await asOperator(async (c) => { const { row } = await loadCompany(c, pmu); const u = (await one<{ id: string }>(c, "select id from users where company_id=$1 and email='casey@d119.test'", [pmu]))!; return prefill(c, row, { id: u.id, name: "Casey Closer", email: "casey@d119.test" }, DateTime.fromJSDate(pia.at).setZone(TZ).toFormat("yyyy-MM-dd")); });
    expect(day.calls.find((x) => x.appointment_id === pia.appt)).toMatchObject({ outcome: "deposit", cash: 500, revenue: null });
    expect(day).toMatchObject({ closes: 0, deposits: 1, cash: 500, revenue: 0 });
    await file(pmu, pia, "deposit");
    const run = (await lastRun(pmu, "call-outcome", pia))!;
    expect(run.step("kd")?.status).toBe("ok");
    expect(cardWrites(pia).at(-1)).toMatchObject({ op: "update", stageId: "ST-DEPOSIT", status: "open" });
    expect(tagsOf(pia)).toEqual(expect.arrayContaining(["stat-showed", "stat-deposit"])); expect(tagsOf(pia)).not.toContain("stat-closed-won");
    expect(salesCallWrites(pia).at(-1)).toMatchObject({ op: "update", outcome: "showed", disposition: "deposit" });
  });

  it("PMU: the payment that comes back for the rest is the balance: it sends the agreement (card → Purchase), starts the chase, wins the opportunity; signed, the deal closes", async () => {
    const row = (await asOperator((c) => one<{ id: string; appt: string; at: Date }>(c, "select ct.id, a.id as appt, a.starts_at as at from contacts ct join appointments a on a.contact_id=ct.id where ct.company_id=$1 and ct.ghl_contact_id='G-Pia'", [pmu])))!;
    const pia: Who = { ct: row.id, appt: row.appt, ghl: "G-Pia", card: "CARD-Pia", at: row.at };
    const nDocs = docs.length;
    const r = await pay(pmu, pia, "pay_pia_rest", 4500, { product_id: "prod_MAIN", plan_id: "plan_4500" });
    expect(r.payment.kind).toBe("balance"); expect(r.event.data).toMatchObject({ prior_total: 500, prior_non_deposit_total: 0, running_total: 5000, cleared: true });
    const pr = (await lastRun(pmu, "payment-recorded", pia))!;
    expect(pr.step("o_won")?.status).toBe("ok"); expect(pr.ran).toEqual(expect.arrayContaining(["r1", "f1", "a1", "a2", "a3"]));
    expect(docs.length).toBe(nDocs + 1);
    expect(cardWrites(pia).at(-1)).toMatchObject({ op: "update", stageId: "ST-PURCHASE" });
    expect((await runsOf(pmu, "agreement-chase", pia)).length).toBe(1);
    expect((await lastRun(pmu, "deal-closed", pia))?.exit_reason).toBe("not_yet");   // paid, not signed
    await sign(pmu, pia);
    expect((await lastRun(pmu, "deal-closed", pia))?.exit_reason).toBe("closed");
    expect(cardWrites(pia).at(-1)).toMatchObject({ stageId: "ST-WON", status: "won" });
  });

  it("Dating Nelly: a deposit, even signed, is not a close; the first payment beyond it, with the signature, is", async () => {
    const who = await person(dating, "Dani");
    await sign(dating, who);
    expect((await lastRun(dating, "deal-closed", who))?.exit_reason).toBe("not_yet");
    // her processor's deposit plan, as Whop sends it
    const whop = parseWhopEvent({ id: "msg_dani", type: "payment.succeeded", data: { id: "pay_dani_dep", total: { amount: "250", currency: "usd" }, plan_id: "plan_DEP", product_id: "prod_PROGRAM", paid_at: new Date().toISOString() } })!;
    const r = await pay(dating, who, whop.providerPaymentId, whop.amount, whop.raw!);
    expect(r.payment.kind).toBe("deposit");
    expect((await lastRun(dating, "deal-closed", who))?.exit_reason).toBe("not_yet");
    expect(tagsOf(who)).not.toContain("stat-customer");
    expect(await kindOf(dating, "pay_dani_dep")).toBe("deposit");
    expect(await runsOf(dating, "agreement-chase", who)).toEqual([]);   // the chase waits for the payment the agreement goes out on
    await pay(dating, who, "pay_dani_2", 1000, { plan_id: "plan_PLAN1", product_id: "prod_PROGRAM" });
    expect(await kindOf(dating, "pay_dani_2")).toBe("installment");
    expect((await lastRun(dating, "deal-closed", who))?.exit_reason).toBe("closed");
    expect(tagsOf(who)).toContain("stat-customer");
    // D130: the won closer card carries the deal's value (its opportunity's $5,000), not the cash so far
    expect(cardWrites(who).find((k) => k.status === "won" && k.stageId === "ST-WON")).toMatchObject({ op: "update", monetaryValue: 5000 });
    expect((await runsOf(dating, "agreement-chase", who)).length).toBe(1);
  });

  it("Dating Nelly: filed as a deposit, then refiled as closed: the Deposit option, stat-deposit and the Deposit stage, then closed won, stat-deposit off and the card back to Scheduled for the money to move on", async () => {
    const who = await person(dating, "Dora");
    await file(dating, who, "deposit");
    expect(salesCallWrites(who).at(-1)).toMatchObject({ outcome: "showed", disposition: "deposit" });
    expect(cardWrites(who).at(-1)).toMatchObject({ stageId: "ST-DEPOSIT", status: "open" });
    expect(tagsOf(who)).toEqual(expect.arrayContaining(["stat-showed", "stat-deposit"]));
    await file(dating, who, "closed");
    expect(salesCallWrites(who).at(-1)).toMatchObject({ outcome: "showed", disposition: "closed_won" });
    expect(tagsOf(who)).toContain("stat-closed-won"); expect(removedOf(who)).toContain("stat-deposit");
    expect(cardWrites(who).at(-1)).toMatchObject({ stageId: "ST-SCHED", status: "open" });
  });

  it("the install declares deposit products and takes them back; a list that is not one is refused", async () => {
    const products = async () => asOperator(async (c) => (await loadCompany(c, dating)).bindings["payments.deposit_products"] ?? null);
    expect(await products()).toBe(JSON.stringify(["plan_DEP"]));
    await installCompany({ ...install("d119dating", { crm: { ...TWO_BOARDS, stage_closer_deposit: "ST-DEPOSIT" } }), templates: ["agreement-signed"] }, fake);
    expect(await products()).toBe(JSON.stringify(["plan_DEP"]));   // omitted: left as it is
    await expect(installCompany({ ...install("d119dating", {}), templates: ["agreement-signed"], depositProducts: ["prod_x", " "] }, fake)).rejects.toThrow(/depositProducts/);
    await installCompany({ ...install("d119dating", {}), templates: ["agreement-signed"], depositProducts: [] }, fake);
    expect(await products()).toBeNull();
  });
});

describe.skipIf(!process.env.DATABASE_URL)("D119: the numbers", () => {
  let co: string;
  const pays: GhlObjectRecord[] = [];
  const rec = (id: string, contact: string, amount: number, type: string, status = "succeeded"): GhlObjectRecord => ({ id, createdAt: "2026-10-01T00:00:00Z", properties: { contact_id: contact, amount: { currency: "default", value: amount }, type, status, occurred_at: "2026-10-12T15:00:00Z", closer: "Casey Closer" } });
  const reads: GhlReads = { contactsAdded: async () => [], wonCards: async () => [{ id: "W1", pipelineId: "P-C", status: "won", contactId: "G-C3", contactName: "C3", contactTags: [], contactEmail: "c3@x.com", wonAt: "2026-10-13T15:00:00Z", monetaryValue: 5000 }] as never,
    objectRecords: async (_c, key) => (key === "custom_objects.payment" ? pays : []), getContact: async () => null, fieldCatalog: async () => [], recordContact: async () => null, cards: async () => [], pipelines: async () => [], users: async () => [] };
  beforeAll(async () => {
    await migrate();
    co = await company("d119num", { crm: CRM, templates: ["agreement-signed"], enable: false });
    pays.push(rec("P1", "G-C1", 300, "deposit"), rec("P2", "G-C1", 200, "deposit"), rec("P3", "G-C2", 250, "deposit"), rec("P4", "G-C2", 999, "deposit", "failed"), rec("P5", "G-C3", 4700, "balance"), rec("P6", "G-C3", 300, "deposit"));
  });
  it("deposits are people who put one down, deposit cash what they brought in, already inside cash collected; closes and revenue are the won cards only", async () => {
    const m = (metric: string) => asOperator((c) => getMetric(c, co, { metric, period: { from: "2026-10-01", to: "2026-10-16", label: "Oct 1–16", name: "Custom" }, now: new Date("2026-10-16T20:00:00Z") }, reads));
    expect((await m("deposits")).value).toBe(3);
    expect((await m("deposit_cash")).value).toBe(1050);
    expect((await m("cash_collected")).value).toBe(5750);
    expect((await m("closes")).value).toBe(1);
    expect((await m("revenue")).value).toBe(5000);
  });
});

describe.skipIf(!process.env.DATABASE_URL)("D119: deposits guessed from the amount before", () => {
  it("are what they were, first installments, once, on a company that declares no deposit product; a declared company's are left alone", async () => {
    await migrate();
    const a = await company("d119miga", { crm: CRM, templates: ["agreement-signed"], enable: false }), b = await company("d119migb", { crm: CRM, templates: ["agreement-signed"], enable: false, depositProducts: ["prod_DEP"] });
    await asOperator(async (c) => {
      for (const co of [a, b]) await c.query("insert into payments (company_id, whop_payment_id, amount, status, kind, paid_at, link_status) values ($1,'old-dep',750,'succeeded','deposit',now(),'unlinked')", [co]);
      await c.query("delete from engine_state where key='d119_deposit_kinds'");
      await c.query("delete from schema_migrations where id='0001-baseline'");   // D200: the baseline runs once; this asks it to run again
    });
    await migrate();
    expect([await kindOf(a, "old-dep"), await kindOf(b, "old-dep")]).toEqual(["installment", "deposit"]);
    await asOperator((c) => c.query("update payments set kind='deposit' where company_id=$1", [a]));
    await migrate();   // once: a deposit written after it is not touched again
    expect(await kindOf(a, "old-dep")).toBe("deposit");
  });
});
