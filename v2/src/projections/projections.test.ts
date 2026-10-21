import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadScenarioFolder } from "@/sim/files";
import { simulate } from "@/sim/simulate";
import { STORES, makeStore } from "@/test/harness";
import { Engine } from "@/engine/engine";
import { FakePorts } from "@/engine/fake-ports";
import { setupOffer } from "@/engine/testkit";
import type { EventRow } from "@/engine/types";
import { projectionsOf, rebuildProjections } from "./apply";
import { type Change, type Loaded, emptyLoaded, project } from "./projector";
import type { ProjTable, Rows } from "./tables";

/** Projectors are pure (a fact and the rows it touches in, row changes out), and a rebuild from the log gives what was built as facts came. */

let id = 0;
const fact = (type: string, x: { contact?: string | null; appointment?: string | null; deal?: string | null; at?: string; payload?: Record<string, unknown> } = {}): EventRow => ({
  id: ++id, offerId: "o1", type, occurredAt: new Date(x.at ?? "2026-10-26T14:00:00Z"), contactId: x.contact === undefined ? "c1" : x.contact, appointmentId: x.appointment ?? null,
  dealId: x.deal ?? null, source: "test", dedupeKey: `k${id}`, payload: x.payload ?? {}, runId: null,
});

/** Runs facts through the projectors in memory, as the store would, without a store. */
function fold(facts: EventRow[], zone = "America/New_York"): { rows: Loaded; counts: Map<string, { n: number; amount: number }> } {
  const rows = emptyLoaded();
  const counts = new Map<string, { n: number; amount: number }>();
  for (const e of facts) {
    for (const c of project(e, rows, { zone }) as Change[]) {
      if ("put" in c) (rows[c.put.table] as Map<string, Rows[ProjTable]>).set(c.put.row.id, c.put.row);
      else { const k = c.inc.id, at = counts.get(k) ?? { n: 0, amount: 0 }; counts.set(k, { n: at.n + c.inc.n, amount: at.amount + c.inc.amount }); }
    }
  }
  return { rows, counts };
}

describe("the projectors", () => {
  it("keep what the CRM said of a contact, never a worked-out fact a snapshot carried", () => {
    const { rows } = fold([fact("lead.created", { payload: { contact: { name: "Ana Lopez", phone: "+1 (555) 010-0001", email: " Ana@Example.com ", ghl_contact_id: "ghl-c1", source: "Facebook ads", paid_non_deposit: true, closer: { name: "Luis" }, cards: { closer: { id: "x" } } } } })]);
    const c = rows.contacts_index.get("c1")!;
    expect(c).toMatchObject({ crmId: "ghl-c1", phones: ["5550100001"], emails: ["ana@example.com"], leadAt: new Date("2026-10-26T14:00:00Z") });
    expect(c.attrs).toEqual({ name: "Ana Lopez", phone: "+1 (555) 010-0001", email: " Ana@Example.com ", ghl_contact_id: "ghl-c1", source: "Facebook ads" });
  });

  it("are pure: the rows read are left as they were", () => {
    const rows = emptyLoaded();
    project(fact("lead.created"), rows, { zone: "UTC" });
    expect(rows.contacts_index.size).toBe(0);
  });

  it("make a booking an appointment and its call, counted once on the day it was made, by closer, setter and source", () => {
    const booked = { appointment: { starts_at: "2026-10-29T18:00:00Z", term: { category: "closing" }, self_booked: false, set_by: "Mia", closer: { name: "Luis", ghl_user_id: "U-L" }, status: "booked" } };
    const { rows, counts } = fold([
      fact("lead.created", { payload: { contact: { source: "ads" } }, at: "2026-10-25T14:00:00Z" }),
      fact("appointment.booked", { appointment: "a1", payload: booked }),
      fact("appointment.booked", { appointment: "a1", payload: booked }),
      fact("appointment.rescheduled", { appointment: "a1", payload: { appointment: { starts_at: "2026-10-30T18:00:00Z" } } }),
    ]);
    expect(rows.appointments.get("a1")).toMatchObject({ status: "booked", kind: "closing", bookingSource: "setter", setBy: "Mia", closerKey: "crm:U-L", reschedules: 1, startsAt: new Date("2026-10-30T18:00:00Z"), bookedAt: new Date("2026-10-26T14:00:00Z") });
    expect(rows.calls.get("a1")).toMatchObject({ source: "booking", booked: true, kind: "closing", repKey: "crm:U-L" });
    expect(counts.get("2026-10-26|booked|crm:U-L|name:Mia|ads")).toEqual({ n: 1, amount: 0 });
    expect(counts.get("2026-10-26|booked_set|crm:U-L|name:Mia|ads")).toEqual({ n: 1, amount: 0 });
    expect(counts.get("2026-10-25|leads|||ads")).toEqual({ n: 1, amount: 0 });
    expect(counts.get("2026-10-26|reschedules|crm:U-L||ads")).toEqual({ n: 1, amount: 0 });
  });

  it("file an outcome on the appointment and its call; a status change and a pending read on the appointment", () => {
    const { rows } = fold([
      fact("appointment.booked", { appointment: "a1", payload: { appointment: { starts_at: "2026-10-26T13:00:00Z" } } }),
      fact("appointment.pending_read", { appointment: "a1", payload: { intent: "cancelled", confidence: 86, at: "2026-10-25T15:00:00Z" } }),
      fact("appointment.outcome", { appointment: "a1", payload: { outcome: "showed", call_outcome: "follow_up", outcome_source: "disposition" } }),
    ]);
    expect(rows.appointments.get("a1")).toMatchObject({ outcome: "showed", callOutcome: "follow_up", outcomeSource: "disposition", pendingRead: { intent: "cancelled", confidence: 86, at: "2026-10-25T15:00:00Z" } });
    expect(rows.calls.get("a1")).toMatchObject({ held: true, outcome: "follow_up" });
    const later = fold([fact("appointment.booked", { appointment: "a1" }), fact("appointment.status_changed", { appointment: "a1", payload: { status: { from: "booked", to: "cancelled" } } })]);
    expect(later.rows.appointments.get("a1")!.status).toBe("cancelled");
  });

  it("make a dialer call a call with its recording: connected as the CRM said it, its length, the dial counted, speed to lead", () => {
    const rec = (id: string, started: string, ended: string, status = "connected") => ({ recording_id: id, recording: { id, kind: "phone", status, direction: "outbound", started_at: started, ended_at: ended, caller: { name: "Mia", ghl_user_id: "U-M" }, has_transcript: true } });
    const { rows, counts } = fold([
      fact("lead.created", { at: "2026-10-26T13:00:00Z" }),
      fact("call.logged", { at: "2026-10-26T13:56:00Z", payload: rec("r1", "2026-10-26T13:50:00Z", "2026-10-26T13:55:00Z") }),
      fact("call.logged", { at: "2026-10-26T14:10:00Z", payload: rec("r2", "2026-10-26T14:05:00Z", "2026-10-26T14:05:00Z", "no_answer") }),
    ]);
    expect(rows.calls.get("r1")).toMatchObject({ source: "dialer", recordingId: "r1", durationSec: 300, connected: true, repKey: "crm:U-M", direction: "outbound" });
    expect(rows.calls.get("r1")!.recording).toMatchObject({ transcript_status: "ready", rep: { name: "Mia", ghl_user_id: "U-M" } });
    expect(rows.calls.get("r2")!.connected).toBe(false);
    expect(counts.get("2026-10-26|dials||crm:U-M|")).toEqual({ n: 2, amount: 0 });
    expect(counts.get("2026-10-26|connected||crm:U-M|")).toEqual({ n: 1, amount: 0 });
    expect(rows.contacts_index.get("c1")).toMatchObject({ firstDialAt: new Date("2026-10-26T13:50:00Z"), speedToLeadMin: 50 });
  });

  it("record payments as the provider said them (a refund negative), the day's cash credited to the closer of the latest call, an unlinked one counted when linked", () => {
    const { rows, counts } = fold([
      fact("appointment.booked", { appointment: "a1", payload: { appointment: { starts_at: "2026-10-20T13:00:00Z", closer: { name: "Luis" } } } }),
      fact("payment.received", { payload: { payment_id: "p1", amount: 1500, product_name: "Deposit", paid_at: "2026-10-26T15:00:00Z" } }),
      fact("payment.refunded", { payload: { payment_id: "p2", amount: 500, refund_of: "p1" } }),
      fact("payment.unlinked", { contact: null, payload: { payment_id: "p3", amount: 200, customer_email: "x@y.z" } }),
      fact("payment.linked", { payload: { payment_id: "p3", by: "manual" } }),
    ]);
    expect(rows.payments.get("p1")).toMatchObject({ status: "succeeded", amount: 1500, product: { product_name: "Deposit" }, contactId: "c1" });
    expect(rows.payments.get("p2")).toMatchObject({ status: "refunded", amount: -500, refundOf: "p1" });
    expect(rows.payments.get("p3")).toMatchObject({ contactId: "c1", linkedBy: "manual", customer: { email: "x@y.z" } });
    expect(counts.get("2026-10-26|cash_collected|name:Luis||")).toEqual({ n: 3, amount: 1200 });
    expect(counts.get("2026-10-26|cash_gross|name:Luis||")).toEqual({ n: 2, amount: 1700 });
    expect(counts.get("2026-10-26|refunds|name:Luis||")).toEqual({ n: 1, amount: 500 });
  });

  it("keep the ledger's deals and the CRM cards we wrote; a close counted once; records, the agreement, the team and their filed days", () => {
    const { rows, counts } = fold([
      fact("deal.opened", { deal: "d1", payload: { value: 2999 } }), fact("deal.won", { deal: "d1" }), fact("deal.won", { deal: "d1" }),
      fact("crm.deal_written", { payload: { deal_id: "opp-1", pipeline: "PIPE-C", stage: "S1", owner: "U-L" } }),
      fact("crm.deal_written", { payload: { deal_id: "opp-2", pipeline: "PIPE-C", stage: "S2" } }),
      fact("crm.deal_status_set", { payload: { pipeline: "PIPE-C", status: "won" } }),
      fact("crm.record_written", { payload: { object: "custom_objects.sales_call", key: "cal-1", record_id: "R1" } }),
      fact("agreement.signed", { payload: { agreement: { name: "Purchase agreement" } } }),
      fact("person.added", { contact: null, payload: { person: { id: "u1", name: "Luis Ortega", ghl_user_id: "U-L", roles: ["closer"], email: "L@x.com" } } }),
      fact("eod.filed", { contact: null, payload: { user_id: "u1", day: "2026-10-26" } }),
    ]);
    expect(rows.deals.get("d1")).toMatchObject({ kind: "ledger", status: "won", value: 2999 });
    expect(counts.get("2026-10-26|closes|||")).toEqual({ n: 1, amount: 0 });
    expect(rows.deals.get("card:opp-1")).toMatchObject({ kind: "card", pipeline: "PIPE-C", stage: "S1", ownerKey: "crm:U-L", status: "open" });
    // a card moved without an owner keeps its pipeline's owner; the status set lands on the latest card
    expect(rows.deals.get("card:opp-2")).toMatchObject({ ownerKey: "crm:U-L", status: "won" });
    expect(rows.contacts_index.get("c1")!.records).toEqual({ sales_call: { key: "cal-1", id: "R1" } });
    expect(rows.contacts_index.get("c1")!.agreement).toMatchObject({ name: "Purchase agreement", status: "signed", signed_at: "2026-10-26T14:00:00.000Z" });
    expect(rows.people.get("u1")).toMatchObject({ name: "Luis Ortega", crmUserId: "U-L", roles: ["closer"], email: "l@x.com", eodDays: ["2026-10-26"], active: true });
  });
});

const ROOT = path.resolve(__dirname, "../../offers");
const offers = fs.readdirSync(ROOT).filter((d) => fs.statSync(path.join(ROOT, d)).isDirectory());

describe("rebuilding the projections from the fact log gives what was built as the facts came", () => {
  for (const offer of offers) {
    const dir = path.join(ROOT, offer);
    const content = JSON.parse(fs.readFileSync(path.join(dir, "content.json"), "utf8"));
    const reports = JSON.parse(fs.readFileSync(path.join(dir, "reports.json"), "utf8"));
    for (const wf of fs.readdirSync(path.join(dir, "scenarios"))) {
      const { scenarios } = loadScenarioFolder(path.join(dir, "scenarios", wf));
      const definition = JSON.parse(fs.readFileSync(path.join(dir, "workflows", `${wf}.json`), "utf8"));
      it(`${offer}: every ${wf} scenario`, async () => {
        for (const { scenario } of scenarios) {
          await simulate({ definition, scenario, content, reports, inspect: async (store, offerId) => {
            const built = await projectionsOf(store, offerId);
            await rebuildProjections(store, offerId);
            expect(await projectionsOf(store, offerId)).toEqual(built);
          } });
        }
      });
    }
  }
});

describe.each(STORES)("the projections, on %s", (kind) => {
  it("come out the same incrementally, after a rebuild, and in either store", async () => {
    const store = await makeStore(kind);
    const offerId = await setupOffer(store, { slug: "p", zone: "America/New_York" });
    const engine = new Engine({ store, ports: new FakePorts().ports(), now: () => new Date("2026-10-26T20:00:00Z") });
    const facts: [string, Record<string, unknown>][] = [
      ["person.added", { contactId: null, payload: { person: { id: "u1", name: "Luis Ortega", ghl_user_id: "U-L", roles: ["closer"] } } }],
      ["lead.created", { contactId: "c1", payload: { contact: { name: "Ana", phone: "+15550100001", source: "ads" } } }],
      ["appointment.booked", { contactId: "c1", appointmentId: "a1", payload: { appointment: { starts_at: "2026-10-26T18:00:00Z", term: { category: "closing" }, closer: { ghl_user_id: "U-L" }, self_booked: true } } }],
      ["call.logged", { contactId: "c1", payload: { recording_id: "r1", duration_sec: 120, recording: { id: "r1", kind: "phone", status: "connected", direction: "outbound", started_at: "2026-10-26T14:10:00Z" } } }],
      ["appointment.outcome", { contactId: "c1", appointmentId: "a1", payload: { outcome: "showed", call_outcome: "closed" } }],
      ["payment.received", { contactId: "c1", payload: { payment_id: "p1", amount: 2999.5, paid_at: "2026-10-26T19:00:00Z" } }],
      ["deal.won", { contactId: "c1", dealId: "d1", payload: {} }],
    ];
    for (const [i, [type, x]] of facts.entries()) await engine.ingest({ offerId, type, source: "t", dedupeKey: `f${i}`, occurredAt: new Date(`2026-10-26T1${i}:00:00Z`), ...(x as object), payload: x.payload as Record<string, unknown> });
    const built = await projectionsOf(store, offerId);
    expect(built.daily_facts.map((r) => `${r.metric}:${r.n}:${r.amount}`).sort()).toEqual(["booked:1:0", "booked_self:1:0", "cash_collected:1:2999.5", "cash_gross:1:2999.5", "closes:1:0", "connected:1:0", "dials:1:0", "leads:1:0"]);
    expect(built.payments[0]!.amount).toBe(2999.5);
    expect(built.people[0]!.roles).toEqual(["closer"]);
    await rebuildProjections(store, offerId);
    expect(await projectionsOf(store, offerId)).toEqual(built);
    // the same facts in memory give the same rows (bar the offer's id)
    const mem = await makeStore("memory");
    const o2 = await setupOffer(mem, { slug: "p", zone: "America/New_York" });
    const e2 = new Engine({ store: mem, ports: new FakePorts().ports(), now: () => new Date("2026-10-26T20:00:00Z") });
    for (const [i, [type, x]] of facts.entries()) await e2.ingest({ offerId: o2, type, source: "t", dedupeKey: `f${i}`, occurredAt: new Date(`2026-10-26T1${i}:00:00Z`), ...(x as object), payload: x.payload as Record<string, unknown> });
    const strip = (p: Record<string, { offerId: string }[]>) => JSON.parse(JSON.stringify(p, (k, v) => (k === "offerId" ? undefined : v)));
    expect(strip(await projectionsOf(mem, o2))).toEqual(strip(built));
  });
});
