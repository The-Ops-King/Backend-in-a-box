import crypto from "node:crypto";
import { connectorKit, type Kit } from "../testkit/kit";
import { FakeAnthropic, FakeCalendly, FakeJev, message } from "../testkit/fake-vendors";
import { signStandardWebhook, signTypeform } from "../framework/signatures";
import { door, type DoorVendor } from "../doors";
import { connectorPorts } from "../registry";
import type { Connection, J } from "../framework/types";
import { FakePorts } from "@/engine/fake-ports";
import { aiContract, crmContract, esignContract, formsContract, messagingContract, paymentsInContract, recordingContract, schedulingContract } from "./suites";

/**
 * Every provider of every port, through the same contract suite. The ports are taken through the registry, as the engine
 * calls them (routed by the offer's connection), so a provider is tested as it is used.
 */

const portsOf = (k: Kit) => { const f = new FakePorts(k.http.now).ports(); return connectorPorts(k.hub, { slack: f.slack, http: f.http }); };

// ---- GHL: the CRM, messaging, scheduling and e-sign ports, in both auth modes ---------------------------------------------

const PG = !!process.env.DATABASE_URL;
const variants: { mode: "oauth" | "pit"; pg: boolean }[] = [{ mode: "oauth", pg: false }, { mode: "pit", pg: false }, ...(PG ? [{ mode: "oauth" as const, pg: true }, { mode: "pit" as const, pg: true }] : [])];
for (const { mode, pg } of variants) {
  const ghlKit = async () => {
    const k = await connectorKit({ pg });
    await k.connectGhl({ mode, ...(mode === "pit" ? { token: "pit-token" } : {}) });
    await k.state.setFieldMap([
      { offerId: k.offerId, provider: "ghl", object: "contact", canonicalField: "lead_source", providerFieldId: "CF-SRC", valueType: "text", options: {} },
      { offerId: k.offerId, provider: "ghl", object: "contact", canonicalField: "call_date", providerFieldId: "CF-DATE", valueType: "date", options: {} },
      { offerId: k.offerId, provider: "ghl", object: "contact", canonicalField: "cash_collected", providerFieldId: "CF-CASH", valueType: "money", options: {} },
    ]);
    k.ghl.dateFields.add("CF-DATE");
    return k;
  };
  crmContract(`GHL (${mode}${pg ? ", on Postgres" : ""})`, async () => {
    const k = await ghlKit();
    const g = k.ghl;
    return {
      k, port: portsOf(k).crm, object: "custom_objects.sales_call",
      fields: { lead_source: "fb", call_date: "2026-10-16T15:30:00Z", cash_collected: 1500 },
      seed: async (x) => g.seedContact({ locationId: "LOC1", ...(x.email ? { email: x.email } : {}), ...(x.phone ? { phone: x.phone } : {}), tags: x.tags ?? [] }).id,
      revoke: () => { g.tokens.clear(); g.refreshTokens.clear(); },
      inspect: {
        contacts: () => g.contacts.size,
        tags: (id) => g.contacts.get(id)!.tags,
        field: (id, canonical) => { const fid = { lead_source: "CF-SRC", call_date: "CF-DATE", cash_collected: "CF-CASH" }[canonical]!; return g.contacts.get(id)!.customFields.find((f) => f.id === fid)?.value; },
        dnd: (id) => g.contacts.get(id)!.dnd === true,
        deals: (cid) => [...g.opps.values()].filter((o) => o.contactId === cid).map((o) => ({ id: o.id, stage: o.pipelineStageId, status: o.status, ...(o.monetaryValue !== undefined ? { value: Number(o.monetaryValue) } : {}) })),
        tasks: (cid) => g.tasks.filter((t) => t.contactId === cid).length,
        notes: (cid) => g.notes.filter((t) => t.contactId === cid).length,
        records: (obj) => [...g.records.values()].filter((r) => r.objectKey === obj),
      },
    };
  });
  messagingContract(`GHL (${mode}${pg ? ", on Postgres" : ""})`, async () => {
    const k = await ghlKit();
    return {
      k, port: portsOf(k).messaging,
      seed: async (x) => k.ghl.seedContact({ locationId: "LOC1", ...x }).id,
      sent: () => k.ghl.messages.map((m) => ({ channel: m.messageType === "TYPE_SMS" ? "sms" : "email", contactId: m.contactId, ...(m.body !== undefined ? { body: String(m.body) } : {}), ...(m.subject !== undefined ? { subject: String(m.subject) } : {}) })),
    };
  });
  schedulingContract(`GHL calendars (${mode}${pg ? ", on Postgres" : ""})`, async () => {
    const k = await ghlKit();
    return {
      k, port: portsOf(k).scheduling, supports: ["confirmed", "showed", "noshow"],
      book: async () => k.ghl.seedAppointment({ locationId: "LOC1", contactId: "c1", calendarId: "CAL1", appointmentStatus: "new" }).id,
      status: (id) => k.ghl.appts.get(id)!.appointmentStatus,
    };
  });
  esignContract(`GHL documents (${mode}${pg ? ", on Postgres" : ""}) — the send call's body is unverified`, async () => {
    const k = await ghlKit();
    return { k, port: portsOf(k).esign, seed: async () => k.ghl.seedContact({ locationId: "LOC1" }).id, sign: (id) => k.ghl.sign(id) };
  });
}

// ---- Calendly: the scheduling port --------------------------------------------------------------------------------------

schedulingContract("Calendly (webhook payload unverified; the cancel and no-show calls as Calendly documents them)", async () => {
  const k = await connectorKit();
  const cal = new FakeCalendly(k.http);
  await k.state.upsertConnection({ offerId: k.offerId, port: "scheduling", provider: "calendly", mode: "webhook", externalId: "https://api.calendly.com/organizations/ORG1", credentials: { token: "cal-token", webhook_secret: "calsecret" } });
  let n = 0;
  return {
    k, port: portsOf(k).scheduling, supports: ["noshow"],
    book: async () => {
      const id = `ev${++n}`;
      const { invitee } = cal.book(id, { email: "ana@example.com", start: "2026-10-28T15:00:00Z", at: k.http.now().toISOString() });
      await k.state.putVersion({ offerId: k.offerId, provider: "calendly", kind: "appointment", entityId: id, versionAt: k.http.now(), state: { status: "booked", invitee: invitee.uri }, updatedAt: k.http.now() });
      return id;
    },
    status: (id) => (cal.events.get(id)!.status === "canceled" ? "cancelled" : cal.noShows.includes(String(cal.invitees.get(id)![0]!.uri)) ? "noshow" : "booked"),
  };
});

// ---- AI: Jev classifies, Anthropic summarizes -----------------------------------------------------------------------------

aiContract("Jev", "classify", async () => {
  const k = await connectorKit();
  const jev = new FakeJev(k.http);
  await k.state.upsertConnection({ offerId: k.offerId, port: "ai.classify", provider: "jev", credentials: { api_key: "jev-key" } });
  return {
    k, port: portsOf(k).ai,
    answerWith: (x) => {
      jev.answer = (b) => {
        if (x.status) return { status: x.status, body: { error: "x" } };
        const options = Object.keys(((b.questions as J).answer as J).criteria as J);
        return { body: { answers: { answer: { choice: x.value, confidence: x.confidence, probabilities: Object.fromEntries(options.map((o) => [o, o === x.value ? x.confidence : 0.01])) }, ambiguous: { noul: x.ambiguity ?? 0.1 } } } };
      };
    },
  };
});

aiContract("Anthropic (Messages API through the SDK, on the fake fetch)", "summarize", async () => {
  const k = await connectorKit();
  const ant = new FakeAnthropic(k.http);
  await k.state.upsertConnection({ offerId: k.offerId, port: "ai.summarize", provider: "anthropic", config: { model: "claude-opus-5-5" }, credentials: { api_key: "sk-ant-test" } });
  return {
    k, port: portsOf(k).ai,
    answerWith: (x) => {
      ant.reply = () => (x.status ? { status: x.status, body: { type: "error", error: { type: x.status === 529 ? "overloaded_error" : "authentication_error", message: "no" } } } : { body: message(x.text ?? "", x.stop ?? "end_turn", x.stop === "refusal" ? { stop_details: { type: "refusal", category: "cyber", explanation: "declined" } } : {}) });
    },
  };
});

// ---- inbound doors --------------------------------------------------------------------------------------------------------

const B64 = crypto.randomBytes(24).toString("base64");

async function inbound(vendor: DoorVendor, port: string, config: J, samples: Record<string, J>, sign: "standard" | "typeform", pg = false) {
  const k = await connectorKit({ pg });
  const secret = sign === "standard" ? `whsec_${B64}` : "tf-secret";
  const conn: Connection = await k.state.upsertConnection({ offerId: k.offerId, port, provider: vendor, config, credentials: { webhook_secret: secret, api_key: "key" } });
  let n = 0;
  return {
    k, samples,
    known: async () => { await k.engine.ingest({ offerId: k.offerId, type: "contact.created", source: "test", dedupeKey: "known", contactId: "c-known", payload: { contact: { email: "ana@example.com", phone: "+15550100001" } } }); return "c-known"; },
    deliver: async (body: J, o: { id?: string; badSignature?: boolean } = {}) => {
      const id = o.id ?? `msg_${++n}`;
      const b = vendor === "typeform" ? { ...body, event_id: id } : body;
      const raw = JSON.stringify(b);
      const ts = Math.floor(k.http.now().getTime() / 1000);
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (sign === "standard") Object.assign(headers, { "webhook-id": id, "webhook-timestamp": String(ts), "webhook-signature": signStandardWebhook(o.badSignature ? `whsec_${crypto.randomBytes(24).toString("base64")}` : secret, id, ts, raw) });
      else headers["typeform-signature"] = signTypeform(o.badSignature ? "wrong" : secret, raw);
      return door(k.hub, vendor, conn.id, new Request(`https://app.example/in/${vendor}/${conn.id}`, { method: "POST", headers, body: raw }));
    },
  };
}

const paid = "2026-10-26T13:59:00Z";
paymentsInContract("Whop (envelope as v1 verified; Standard Webhooks)", () => inbound("whop", "payments", {}, {
  succeeded: { id: "evt_1", type: "payment.succeeded", data: { id: "pay_1", status: "paid", total: { amount: "1500.00", currency: "usd" }, customer_email: "Ana@Example.com", member_id: "mem_1", product_id: "prod_1", line_items: [{ product_id: "prod_1", product_title: "Hair Program" }], paid_at: paid } },
  failed: { id: "evt_2", type: "payment.failed", data: { id: "pay_2", total: { amount: "1500.00" }, customer_email: "ana@example.com", failure_message: "card declined", created_at: paid } },
  refunded: { id: "evt_3", type: "refund.created", data: { id: "ref_1", amount: 500, payment_id: "pay_1", customer_email: "ana@example.com", created_at: paid } },
}, "standard"));

paymentsInContract("the generic signed door (a Zap's payment)", () => inbound("generic", "payments", { emits: "payment", map: { amount: "amount", email: "customer.email", status: "status", paid_at: "paid_at", product_name: "product" }, dedupe: "transaction_id" }, {
  succeeded: { transaction_id: "tx-1", amount: "$1,500.00", customer: { email: "ana@example.com" }, status: "paid", paid_at: paid, product: "Hair Program" },
  failed: { transaction_id: "tx-2", amount: "1500", customer: { email: "ana@example.com" }, status: "failed", paid_at: paid },
  refunded: { transaction_id: "tx-3", amount: "500", customer: { email: "ana@example.com" }, status: "refunded", paid_at: paid },
}, "standard"));

recordingContract("Fathom (the Meeting object as v1 read it; Standard Webhooks)", () => inbound("fathom", "recording", {}, {
  meeting: {
    recording_id: 123456, title: "Ana Lopez <> Luis Ortega", url: "https://fathom.video/calls/123456", share_url: "https://fathom.video/share/abc", recording_start_time: "2026-10-26T13:00:00Z", recording_end_time: "2026-10-26T13:41:00Z",
    calendar_invitees: [{ name: "Ana Lopez", email: "ana@example.com", is_external: true }, { name: "Luis Ortega", email: "luis@team.com", is_external: false }],
    recorded_by: { name: "Luis Ortega", email: "luis@team.com" }, transcript: [{ speaker: { display_name: "Luis" }, text: "Hi Ana", timestamp: "00:00:01" }],
  },
}, "standard"));

recordingContract("the generic signed door (a Zap's recording)", () => inbound("generic", "recording", { emits: "recording", map: { email: "attendee", started_at: "start", title: "title" }, dedupe: "recording_id" }, {
  meeting: { recording_id: "rec-77", attendee: "ana@example.com", start: "2026-10-26T13:00:00Z", title: "Discovery" },
}, "standard"));

formsContract("Typeform (form_response as Typeform documents it; v1's answer reading)", () => inbound("typeform", "forms", { forms: { FORM1: { name: "Application", answers: { ref_email: "email", ref_name: "first_name", ref_goal: "goal" }, hidden: { utm_source: "utm_source" } } } }, {
  response: { event_type: "form_response", form_response: { form_id: "FORM1", token: "tok-1", submitted_at: "2026-10-26T13:50:00Z", hidden: { utm_source: "fb" }, answers: [
    { field: { ref: "ref_email" }, type: "email", email: "Ana@Example.com" }, { field: { ref: "ref_name" }, type: "text", text: "Ana" }, { field: { ref: "ref_goal" }, type: "choice", choice: { label: "Thicker hair" } }, { field: { ref: "unmapped" }, type: "text", text: "ignored" },
  ] } },
}, "typeform"));

formsContract("the generic signed door (a Zap's form)", () => inbound("generic", "forms", { emits: "form", map: { email: "email", first_name: "name", goal: "answers.goal" }, dedupe: "id" }, {
  response: { id: "resp-1", email: "ana@example.com", name: "Ana", answers: { goal: "Thicker hair" } },
}, "standard"));

if (PG) {
  paymentsInContract("Whop, on Postgres", () => inbound("whop", "payments", {}, {
    succeeded: { id: "evt_1", type: "payment.succeeded", data: { id: "pay_1", total: { amount: "1500.00" }, customer_email: "ana@example.com", paid_at: paid } },
    failed: { id: "evt_2", type: "payment.failed", data: { id: "pay_2", total: { amount: "1500.00" }, customer_email: "ana@example.com", created_at: paid } },
    refunded: { id: "evt_3", type: "refund.created", data: { id: "ref_1", amount: 500, payment_id: "pay_1", customer_email: "ana@example.com", created_at: paid } },
  }, "standard", true));
}
