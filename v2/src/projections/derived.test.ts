import { afterAll, describe, expect, it } from "vitest";
import { closeDb } from "@/db/client";
import { enableWorkflow, saveVersion } from "@/engine/config";
import { chain, flow, harness, STORES } from "@/test/harness";
import { validateWorkflow } from "@/workflow/validate";
import { DERIVED_FACTS, FACT_SETTINGS, derivedFactOf, factSettingsIn } from "./facts";
import { isDeposit, paymentKind, recordingView } from "./derived";

/**
 * The facts a run reads come from the projections, and each fact v1 worked out by a business rule reads the rule's
 * parameters from the offer's typed settings: while one is unset the fact is not there, and a workflow that reads it
 * cannot be enabled.
 */

type N = Record<string, unknown>;
const trig = (event: string): N => ({ id: "t1", type: "trigger@1", title: "Start", on: { event } });
const end = (): N => ({ id: "x1", type: "end@1", title: "End", reason: "done" });
const post = (id: string): N => ({ id, type: "message@1", title: `Post ${id}`, to: { slack: { channel: "{{setting.slack.channel.ops}}" } }, content: `c.${id}` });
const slack = (id: string, body: string) => ({ [`c.${id}`]: { channel: "slack" as const, body } });
const RULES = {
  "payments.deposit_products": [], "payments.deposit_by_name": true, "payments.contract_value": 2999, "payments.cleared_tolerance": 0.01,
  "people.closer_from": ["closer_card", "contact_owner"], "people.setter_from": ["field:setter"], "setter_result.set_within_min": 30,
};
const BASE = { "slack.channel.ops": "C-OPS", "crm.pipeline_closer": "PIPE-C" };
const texts = (h: { fp: { effects: (p?: "slack") => { args: unknown }[] } }) => h.fp.effects("slack").map((c) => (c.args as { text: string }).text);

afterAll(async () => { await closeDb(); });

describe("the rules' settings", () => {
  it("name every setting a worked-out fact reads, typed, with what v1 had", () => {
    for (const f of Object.values(DERIVED_FACTS)) for (const k of f.requires) expect(FACT_SETTINGS[k]).toBeDefined();
    expect(derivedFactOf("contact.closer.mention")).toEqual({ fact: "contact.closer", requires: ["people.closer_from"], optional: [] });
    expect(derivedFactOf("contact.cash_collected")).toBeUndefined();
    expect(factSettingsIn("{{payment.kind}} for {{contact.setter.name | optional}}").required.sort()).toEqual(["payments.cleared_tolerance", "payments.contract_value", "payments.deposit_by_name", "payments.deposit_products", "people.setter_from"]);
  });

  it("are what a workflow needs before it is enabled: reading a fact requires its rule's settings", () => {
    const v = validateWorkflow(flow("w", [trig("payment.received"), { id: "s1", type: "set@1", title: "k", var: "k", value: "{{payment.kind}}" }, end()], chain("t1", "s1", "x1")));
    expect(v.requires.facts).toEqual(["payment.kind"]);
    expect(v.requires.settings).toEqual(["payments.cleared_tolerance", "payments.contract_value", "payments.deposit_by_name", "payments.deposit_products"]);
  });

  it("tell a deposit by the offer's rule: its declared products, else (when it says so) the word in the name", () => {
    const named = { product: { product_name: "VIP Deposit" } }, prod = { product: { product_id: "prod_dep" } };
    expect(isDeposit(named, {})).toBeUndefined();
    expect(isDeposit(named, { "payments.deposit_products": [], "payments.deposit_by_name": true })).toBe(true);
    expect(isDeposit(named, { "payments.deposit_products": [], "payments.deposit_by_name": false })).toBe(false);
    expect(isDeposit({ product: { product_name: "Deposited funds" } }, { "payments.deposit_products": [], "payments.deposit_by_name": true })).toBe(false);
    expect(isDeposit(named, { "payments.deposit_products": ["prod_dep"], "payments.deposit_by_name": true })).toBe(false);
    expect(isDeposit(prod, { "payments.deposit_products": ["prod_dep"], "payments.deposit_by_name": false })).toBe(true);
  });

  it("give v1's payment kinds, measured against the price within the tolerance", () => {
    const cleared = (t: number) => t >= 2999 - 0.01;
    expect(paymentKind(2998.99, "succeeded", 0, false, cleared)).toBe("paid_in_full");
    expect(paymentKind(1500, "succeeded", 0, false, cleared)).toBe("installment");
    expect(paymentKind(1499, "succeeded", 1500, false, cleared)).toBe("balance");
    expect(paymentKind(500, "succeeded", 0, true, cleared)).toBe("deposit");
    expect(paymentKind(-500, "refunded", 2999, false, cleared)).toBe("refund");
    expect(paymentKind(500, "failed", 0, false, cleared)).toBe("failed");
  });
});

describe.each(STORES)("a run's facts from the projections, on %s", (kind) => {
  it("works out a payment's kind, totals and cleared from the payments before it, by the offer's rule", async () => {
    const body = "{{payment.kind}} · {{payment.prior_total}} → {{payment.running_total}} of {{payment.contract_value}} · prior beyond deposits {{payment.prior_non_deposit_total}} · cleared {{payment.cleared}} · left {{payment.outstanding}} · paid beyond a deposit {{contact.paid_non_deposit}}";
    const h = await harness(kind, { settings: { ...BASE, ...RULES }, workflows: [flow("w", [trig("payment.received"), post("p1"), end()], chain("t1", "p1", "x1"))], content: slack("p1", body) });
    await h.ingest("payment.received", { payload: { payment_id: "p1", amount: 500, product_name: "Deposit" } });
    await h.ingest("payment.received", { payload: { payment_id: "p2", amount: 1000 } });
    await h.ingest("payment.received", { payload: { payment_id: "p3", amount: 1499 } });
    expect(texts(h)).toEqual([
      "deposit · 0 → 500 of 2999 · prior beyond deposits 0 · cleared false · left 2499 · paid beyond a deposit false",
      "installment · 500 → 1500 of 2999 · prior beyond deposits 0 · cleared false · left 1499 · paid beyond a deposit true",
      "balance · 1500 → 2999 of 2999 · prior beyond deposits 1000 · cleared true · left 0 · paid beyond a deposit true",
    ]);
  });

  it("leaves a fact out while its rule's setting is unset: a template reading it is held, a condition on it is false", async () => {
    const h = await harness(kind, { settings: BASE, workflows: [], content: {} });
    const wf = flow("w", [trig("payment.received"), post("p1"), end()], chain("t1", "p1", "x1"));
    const refused = await h.store.tx(async (tx) => {
      const saved = await saveVersion(tx, { offerId: h.offerId, definition: wf, by: "test", why: "t", now: h.clock.now() });
      if (!saved.ok) throw new Error("bad");
      await tx.setContent({ offerId: h.offerId, key: "c.p1", channel: "slack", body: "{{contact.closer.name}} {{payment.kind}}", subject: null, extras: null, approvedHash: null });
      return enableWorkflow(tx, saved.workflow.id, h.clock.now());
    });
    // its words read the closer and the payment's kind: the rules' settings are needed before it may run
    expect(refused).toEqual({ ok: false, missing: { settings: ["payments.cleared_tolerance", "payments.contract_value", "payments.deposit_by_name", "payments.deposit_products", "people.closer_from"], content: [], workflows: [] } });
    // a setting of the wrong type is as good as unset
    await h.store.tx(async (tx) => { for (const [k, v] of Object.entries(RULES)) await tx.setSetting(h.offerId, k, v, "t"); await tx.setSetting(h.offerId, "people.closer_from", "the closer", "t"); });
    const wrong = await h.store.tx(async (tx) => enableWorkflow(tx, (await tx.workflowByKey(h.offerId, "w"))!.id, h.clock.now()));
    expect(wrong).toEqual({ ok: false, missing: { settings: ["people.closer_from"], content: [], workflows: [] } });
  });

  it("finds the closer by the offer's order (the card's owner, else the contact's owner), the setter from the field it names, the owner from the CRM", async () => {
    const body = "closer {{contact.closer.name | default:none}} ({{contact.closer.from | default:-}}) {{contact.closer.mention | default:-}} · owner {{contact.owner.name | default:none}} · setter {{contact.setter.name | default:none}}";
    const h = await harness(kind, { settings: { ...BASE, ...RULES }, workflows: [flow("w", [trig("tag.added"), post("p1"), end()], chain("t1", "p1", "x1"))], content: slack("p1", body) });
    await h.ingest("person.added", { contact: null, payload: { person: { id: "u1", name: "Luis Ortega", ghl_user_id: "U-L", slack_user_id: "U-SL", roles: ["closer"] } } });
    await h.ingest("person.added", { contact: null, payload: { person: { id: "u2", name: "Ana Diaz", ghl_user_id: "U-A", roles: ["closer"] } } });
    await h.ingest("tag.added", { payload: { contact: { assigned_user_id: "U-A", fields: { setter: "Mia" } } } });
    await h.ingest("crm.deal_written", { payload: { deal_id: "opp-1", pipeline: "PIPE-C", stage: "S", owner: "U-L" } });
    await h.ingest("tag.added", { payload: {} });
    await h.store.tx((tx) => tx.setSetting(h.offerId, "people.closer_from", ["contact_owner"], "t"));
    await h.ingest("tag.added", { payload: {} });
    expect(texts(h)).toEqual([
      "closer Ana Diaz (contact_owner) Ana Diaz · owner Ana Diaz · setter Mia",
      "closer Luis Ortega (closer_card) <@U-SL> · owner Ana Diaz · setter Mia",
      "closer Ana Diaz (contact_owner) Ana Diaz · owner Ana Diaz · setter Mia",
    ]);
  });

  it("reads signed, the next call, the latest appointment and recording, records and cards, and the Set window", async () => {
    const body = "signed {{contact.agreement_signed}} · upcoming {{contact.has_upcoming_call}} · latest {{contact.latest_appointment_id}} · rec {{contact.latest_recording_id | default:-}} · sc {{contact.records.sales_call.key | default:-}} · card {{contact.cards.closer.id | default:-}} · first booked {{contact.first_booked_at | offer_date:iso_date}}";
    const h = await harness(kind, { settings: { ...BASE, ...RULES, "crm.object_sales_call": "custom_objects.sales_call" }, workflows: [flow("w", [trig("tag.added"), post("p1"), end()], chain("t1", "p1", "x1"))], content: slack("p1", body) });
    await h.ingest("appointment.booked", { appointment: "a1", payload: { appointment: { starts_at: "2026-10-20T15:00:00Z", term: { category: "closing" } } } });
    await h.ingest("tag.added", { payload: {} });
    await h.ingest("appointment.booked", { appointment: "a2", payload: { appointment: { starts_at: "2026-10-30T15:00:00Z", term: { category: "closing" } } } });
    await h.ingest("agreement.signed", { payload: { agreement: { name: "Purchase agreement" } } });
    await h.ingest("crm.record_written", { payload: { object: "custom_objects.sales_call", key: "cal-1", record_id: "R1" } });
    await h.ingest("crm.deal_written", { payload: { deal_id: "opp-1", pipeline: "PIPE-C", stage: "S" } });
    await h.ingest("recording.received", { payload: { recording_id: "rec-1", recording: { id: "rec-1", started_at: "2026-10-21T15:00:00Z" } } });
    await h.ingest("tag.added", { payload: {} });
    await h.ingest("appointment.status_changed", { appointment: "a2", payload: { status: { from: "booked", to: "cancelled" } } });
    await h.ingest("tag.added", { payload: {} });
    expect(texts(h)).toEqual([
      "signed false · upcoming false · latest a1 · rec - · sc - · card - · first booked 2026-10-20",
      "signed true · upcoming true · latest a2 · rec rec-1 · sc cal-1 · card opp-1 · first booked 2026-10-20",
      "signed true · upcoming false · latest a1 · rec rec-1 · sc cal-1 · card opp-1 · first booked 2026-10-20",
    ]);
  });

  it("gives a recording its caller, its connected and transcript, and the Set window by the offer's minutes; none while the setting is unset", async () => {
    const body = "{{recording.caller.name}} {{recording.connected}} {{recording.has_transcript}} {{recording.duration_sec}}s until {{recording.set_until | default:no window}}";
    const settings = { ...BASE, ...RULES };
    const h = await harness(kind, { settings, workflows: [flow("w", [trig("call.logged"), post("p1"), end()], chain("t1", "p1", "x1"))], content: slack("p1", body) });
    const rec = { id: "r1", kind: "phone", status: "connected", started_at: "2026-10-26T13:50:00Z", ended_at: "2026-10-26T13:55:00Z", caller: { name: "Mia Chen", ghl_user_id: "U-M" }, has_transcript: true, set_until: "2099-01-01T00:00:00Z" };
    await h.ingest("call.logged", { payload: { recording_id: "r1", recording: rec } });
    expect(texts(h)).toEqual(["Mia Chen true true 300s until 2026-10-26T14:25:00.000Z"]);
    // without the offer's minutes there is no Set window (the snapshot's own set_until never stands in)
    const call = (await h.store.tx((tx) => tx.projFind("calls", h.offerId, { where: { recordingId: "r1" } })))[0]!;
    expect(recordingView(call, { people: [] }, {}).set_until).toBeUndefined();
  });

  it("keeps an appointment's outcome, call outcome and pending read from the facts, never from a snapshot", async () => {
    const body = "{{appointment.outcome | default:none}} / {{appointment.call_outcome | default:none}} / {{appointment.pending_read.intent | default:none}} / started {{appointment.started}}";
    const h = await harness(kind, { settings: BASE, workflows: [flow("w", [trig("card.moved"), post("p1"), end()], chain("t1", "p1", "x1"))], content: slack("p1", body) });
    await h.ingest("card.moved", { appointment: "a1", payload: { appointment: { starts_at: "2026-10-26T13:00:00Z", outcome: "showed", call_outcome: "closed", started: false } } });
    await h.ingest("appointment.pending_read", { appointment: "a1", payload: { intent: "cancelled", confidence: 80 } });
    await h.ingest("appointment.outcome_recorded", { appointment: "a1", payload: { outcome: "noshow", call_outcome: null } });
    await h.ingest("card.moved", { appointment: "a1", payload: {} });
    expect(texts(h)).toEqual(["none / none / none / started true", "noshow / none / cancelled / started true"]);
  });
});
