import { describe, expect, it } from "vitest";
import { SendWindow } from "@/workflow/definition";
import { DEFAULT_CAP_PER_DAY, type GateInput, gate } from "./gate";

const NY = "America/New_York";
const MON_10AM = new Date("2026-10-26T14:00:00Z");
const MON_9PM = new Date("2026-10-27T01:00:00Z");
const window = SendWindow.parse({ zone: "contact", opens: "08:00", closes: "20:00", outside: "earlier_same_day", transactional: "any_hour" });

type Over = Partial<Omit<GateInput, "row">> & { row?: Partial<GateInput["row"]>; payload?: Record<string, unknown> };
const input = (o: Over = {}): GateInput => {
  const { row, payload, ...rest } = o;
  const kind = row?.kind ?? "message.sms";
  const effect = row?.effect ?? (kind === "message.slack" ? "team" : "contact");
  return {
    row: { kind, effect, contactId: "c1", ...row, payload: { text: "Hi Ana", kind: "human", render: { blanks: [], errors: [] }, ...payload } },
    workflow: { delivery: "live", crmWrites: "real" },
    operator: { emails: ["tyler@example.com"], phones: ["+1 (555) 000-9999"] },
    contact: { id: "c1", phone: "+15550101001", email: "ana@example.com", timezone: NY, dnd: {} },
    settings: {},
    sendWindow: window,
    windowZone: NY,
    offer: { sendsPausedAt: null },
    counts: { contactToday: 0, offerLastHour: 0, day: "2026-10-26" },
    now: MON_10AM,
    ...rest,
  } as GateInput;
};
const run = (o: Over = {}) => gate(input(o));
const decided = (o: Over = {}) => { const r = run(o); const last = r.checks[r.checks.length - 1]!; return { decision: r.decision, check: last.check, why: last.why, r }; };

describe("the delivery gate", () => {
  it("lets a message through when every check passes, recording each", () => {
    const r = run();
    expect(r.decision).toBe("send");
    expect(r.checks.map((c) => [c.check, c.result])).toEqual([["delivery", "pass"], ["crm_writes", "not_applicable"], ["dnd", "pass"], ["window", "pass"], ["cap", "pass"], ["breaker", "pass"], ["blank", "pass"]]);
  });

  describe("1. delivery state", () => {
    const sandbox = { workflow: { delivery: "sandbox" as const, crmWrites: "real" as const } };
    it("in sandbox, refuses a text to anyone but the operator", () => {
      expect(decided(sandbox)).toMatchObject({ decision: "suppress", check: "delivery", why: "sandbox: the contact's phone is not the operator's own" });
    });
    it("in sandbox, lets through a text to the operator's own phone, however it is written", () => {
      expect(run({ ...sandbox, contact: { id: "c1", phone: "555-000-9999", email: null, dnd: {} } }).decision).toBe("send");
    });
    it("in sandbox, checks an email against the operator's emails, not phones", () => {
      expect(run({ ...sandbox, row: { kind: "message.email", effect: "contact" }, contact: { id: "c1", phone: "+15550009999", email: "ana@example.com", dnd: {} } }).decision).toBe("suppress");
      expect(run({ ...sandbox, row: { kind: "message.email", effect: "contact" }, contact: { id: "c1", phone: null, email: " Tyler@Example.com ", dnd: {} } }).decision).toBe("send");
    });
    it("in sandbox, holds an agreement and a cancellation for anyone but the operator: they reach the contact too", () => {
      expect(decided({ ...sandbox, row: { kind: "esign.send", effect: "contact" } }).decision).toBe("suppress");
      expect(decided({ ...sandbox, row: { kind: "scheduling.cancel", effect: "contact" } }).decision).toBe("suppress");
    });
    it("in sandbox, puts a Slack post in the offer's test channel", () => {
      const r = run({ ...sandbox, row: { kind: "message.slack", effect: "team" }, settings: { "slack.channel.test": "C-TEST" } });
      expect(r.decision).toBe("send");
      expect(r.channel).toBe("C-TEST");
      expect(r.checks[0]).toMatchObject({ check: "delivery", result: "reroute" });
    });
    it("in sandbox, holds a Slack post when the offer has no test channel: it never goes to the live one", () => {
      expect(decided({ ...sandbox, row: { kind: "slack.ask", effect: "team" } })).toMatchObject({ decision: "hold", check: "delivery" });
    });
    it("in sandbox, sends no outbound webhook", () => {
      expect(decided({ ...sandbox, row: { kind: "http.request", effect: "external" } })).toMatchObject({ decision: "suppress", check: "delivery" });
    });
    it("refuses a contact effect when the CRM has no such contact", () => {
      expect(decided({ contact: null })).toMatchObject({ decision: "suppress", check: "delivery", why: "the CRM has no such contact" });
    });
    it("live lets everyone through", () => {
      expect(run({ row: { kind: "http.request", effect: "external" } }).decision).toBe("send");
      expect(run({ row: { kind: "message.slack", effect: "team" } }).channel).toBeUndefined();
    });
  });

  describe("2. CRM writes", () => {
    it("dry records a CRM write without making it", () => {
      expect(decided({ row: { kind: "crm.add_tag", effect: "crm" }, workflow: { delivery: "live", crmWrites: "dry" } })).toMatchObject({ decision: "suppress", check: "crm_writes", why: "dry: the write is recorded, not made" });
    });
    it("real makes it, whatever the delivery state", () => {
      expect(run({ row: { kind: "crm.add_tag", effect: "crm" }, workflow: { delivery: "sandbox", crmWrites: "real" } }).decision).toBe("send");
    });
  });

  describe("3. opt-out and DND", () => {
    it("refuses a text to a contact who is DND for texts or for everything", () => {
      expect(decided({ contact: { id: "c1", phone: "+1", email: null, dnd: { sms: true } } })).toMatchObject({ decision: "suppress", check: "dnd" });
      expect(decided({ contact: { id: "c1", phone: "+1", email: null, dnd: { all: true } } })).toMatchObject({ decision: "suppress", check: "dnd" });
    });
    it("lets a text through to a contact DND only for email", () => {
      expect(run({ contact: { id: "c1", phone: "+1", email: null, dnd: { email: true } } }).decision).toBe("send");
    });
    it("refuses an agreement to a contact DND for email", () => {
      expect(decided({ row: { kind: "esign.send", effect: "contact" }, contact: { id: "c1", phone: null, email: "a@b.c", dnd: { email: true } } }).check).toBe("dnd");
    });
  });

  describe("4. the send window", () => {
    it("defers a human message outside the window to its next opening", () => {
      const r = run({ now: MON_9PM });
      expect(r.decision).toBe("defer");
      expect(r.at?.toISOString()).toBe("2026-10-27T12:00:00.000Z");
    });
    it("lets a receipt go at any hour when the workflow allows it, and defers it when it says in_window", () => {
      expect(run({ now: MON_9PM, payload: { kind: "transactional" } }).decision).toBe("send");
      expect(run({ now: MON_9PM, payload: { kind: "transactional" }, sendWindow: { ...window, transactional: "in_window" } }).decision).toBe("defer");
    });
    it("refuses a message that would stop making sense before the window opens", () => {
      expect(decided({ now: MON_9PM, payload: { notAfter: "2026-10-27T11:00:00Z" } })).toMatchObject({ decision: "suppress", check: "window" });
    });
    it("does not apply to Slack", () => {
      expect(run({ now: MON_9PM, row: { kind: "message.slack", effect: "team" } }).decision).toBe("send");
    });
  });

  describe("5. frequency cap and circuit breaker", () => {
    it(`lets the ${DEFAULT_CAP_PER_DAY}th message of the day through and holds the next, with an alert`, () => {
      expect(run({ counts: { contactToday: DEFAULT_CAP_PER_DAY - 1, offerLastHour: 0, day: "2026-10-26" } }).decision).toBe("send");
      const r = decided({ counts: { contactToday: DEFAULT_CAP_PER_DAY, offerLastHour: 0, day: "2026-10-26" } });
      expect(r).toMatchObject({ decision: "hold", check: "cap" });
      expect(r.r.alert).toMatchObject({ key: "cap:c1:2026-10-26", kind: "frequency_cap" });
    });
    it("takes the offer's own cap", () => {
      expect(decided({ settings: { "delivery.cap_per_day": 2 }, counts: { contactToday: 2, offerLastHour: 0, day: "d" } }).decision).toBe("hold");
    });
    it("trips the breaker when the offer has sent its hourly limit, holding with an alert", () => {
      const r = decided({ settings: { "delivery.breaker_per_hour": 10 }, counts: { contactToday: 0, offerLastHour: 10, day: "d" } });
      expect(r).toMatchObject({ decision: "hold", check: "breaker" });
      expect(r.r.tripBreaker).toBe(true);
    });
    it("holds every message to a contact while the breaker is tripped", () => {
      expect(decided({ offer: { sendsPausedAt: MON_10AM } })).toMatchObject({ decision: "hold", check: "breaker" });
      expect(decided({ offer: { sendsPausedAt: MON_10AM }, row: { kind: "esign.send", effect: "contact" } })).toMatchObject({ decision: "hold", check: "breaker" });
    });
    it("does not count or cap Slack posts", () => {
      expect(run({ row: { kind: "message.slack", effect: "team" }, counts: { contactToday: 99, offerLastHour: 99, day: "d" } }).decision).toBe("send");
    });
  });

  describe("6. blank-variable hold", () => {
    it("holds words with a blank variable", () => {
      expect(decided({ payload: { render: { blanks: [{ expr: "contact.first_name", path: "contact.first_name", reason: "missing" }], errors: [] } } })).toMatchObject({ decision: "hold", check: "blank", why: "1 blank variable" });
    });
    it("holds words with a refused value, a placeholder left in, or no content", () => {
      expect(decided({ payload: { render: { blanks: [], errors: ["x is not in the future"] } } }).check).toBe("blank");
      expect(decided({ payload: { text: "Hi {{contact.first_name}}" } }).why).toBe("a placeholder is left in the words");
      expect(decided({ payload: { missingContent: ["pre_call.booked"] } }).why).toBe("no content for pre_call.booked");
    });
    it("holds a Slack post and an agreement the same way", () => {
      const blank = { render: { blanks: [{ expr: "x", path: "x", reason: "missing" }], errors: [] } };
      expect(decided({ row: { kind: "message.slack", effect: "team" }, payload: blank }).check).toBe("blank");
      expect(decided({ row: { kind: "esign.send", effect: "contact" }, payload: blank }).check).toBe("blank");
    });
    it("does not hold a CRM write: a blank field there is left alone", () => {
      expect(run({ row: { kind: "crm.update_contact", effect: "crm" }, payload: { render: { blanks: [{ expr: "x", path: "x", reason: "missing" }], errors: [] } } }).decision).toBe("send");
    });
  });

  describe("the order of the checks", () => {
    it("delivery before DND: a sandbox refusal is the decision, DND is not reached", () => {
      const r = run({ workflow: { delivery: "sandbox", crmWrites: "real" }, contact: { id: "c1", phone: "+1", email: null, dnd: { sms: true } } });
      expect(r.checks.map((c) => c.check)).toEqual(["delivery"]);
    });
    it("crm_writes before the blank hold", () => {
      expect(run({ row: { kind: "crm.add_note", effect: "crm" }, workflow: { delivery: "live", crmWrites: "dry" }, payload: { missingContent: ["x"] } }).checks.map((c) => c.check)).toEqual(["delivery", "crm_writes"]);
    });
    it("DND before the window: a DND contact outside the window is refused, not deferred", () => {
      expect(decided({ now: MON_9PM, contact: { id: "c1", phone: "+1", email: null, dnd: { sms: true } } }).check).toBe("dnd");
    });
    it("the window before the cap: outside the window it waits, and the cap is counted when it opens", () => {
      expect(decided({ now: MON_9PM, counts: { contactToday: 9, offerLastHour: 0, day: "d" } })).toMatchObject({ decision: "defer", check: "window" });
    });
    it("the cap before the blank hold", () => {
      expect(decided({ counts: { contactToday: 9, offerLastHour: 0, day: "d" }, payload: { missingContent: ["x"] } }).check).toBe("cap");
    });
    it("records a check that does not apply as not applicable", () => {
      const r = run({ row: { kind: "ai.classify", effect: "read" } });
      expect(r.decision).toBe("send");
      expect(r.checks.every((c) => c.result === "not_applicable")).toBe(true);
    });
  });
});
