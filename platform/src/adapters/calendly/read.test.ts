import { describe, it, expect } from "vitest";
import { mapEvent, type RawEvent, type RawInvitee } from "./read";
import { eventUuidOfInvitee, uuidOf } from "./client";

const ev = (over: Partial<RawEvent> = {}): RawEvent => ({
  uri: "https://api.calendly.com/scheduled_events/EV1", name: "45 Min Strategy Call", status: "active",
  start_time: "2026-10-08T16:00:00.000000Z", end_time: "2026-10-08T16:45:00.000000Z",
  event_type: "https://api.calendly.com/event_types/ET1", created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z",
  event_memberships: [{ user: "https://api.calendly.com/users/U1", user_email: "James@SaveYourHairToday.com" }], invitees_counter: { total: 1, active: 1 }, ...over,
});
const inv = (over: Partial<RawInvitee> = {}): RawInvitee => ({
  uri: "https://api.calendly.com/scheduled_events/EV1/invitees/I1", email: "Pete@Snet.net", name: "Pete  Van Gruber", status: "active", timezone: "America/Denver", rescheduled: false,
  questions_and_answers: [{ question: "Phone Number", answer: "+1 860-716-1928" }, { question: "Setter", answer: "Luis" }], updated_at: "2026-10-01T00:00:00Z", ...over,
});

describe("Calendly → AppointmentSnapshot", () => {
  it("maps identity, host, phone from the configured question, and status", () => {
    const s = mapEvent(ev(), inv());
    expect(s.id).toBe("EV1"); expect(s.calendarId).toBe("ET1");
    expect(s.invitee).toEqual({ email: "pete@snet.net", phone: "+1 860-716-1928", firstName: "Pete", lastName: "Van Gruber", timezone: "America/Denver" });
    expect(s.assignedUserEmail).toBe("james@saveyourhairtoday.com");
    expect(s.status).toBe("confirmed");
    expect(s.rescheduledFrom).toBeUndefined(); expect(s.rescheduledTo).toBeUndefined();
  });
  it("prefers Calendly's own text reminder number over the question answer", () => {
    expect(mapEvent(ev(), inv({ text_reminder_number: "+18605550000" })).invitee?.phone).toBe("+18605550000");
  });
  it("a different phone question label is honoured; an unknown label yields no phone", () => {
    expect(mapEvent(ev(), inv({ questions_and_answers: [{ question: "Best number to text?", answer: "555" }] }), "best number to text?").invitee?.phone).toBe("555");
    expect(mapEvent(ev(), inv({ questions_and_answers: [{ question: "Best number to text?", answer: "555" }] })).invitee?.phone).toBeUndefined();
  });
  it("canceled → cancelled; a no-show mark → noshow", () => {
    expect(mapEvent(ev({ status: "canceled" }), inv({ status: "canceled" })).status).toBe("cancelled");
    expect(mapEvent(ev(), inv({ no_show: { uri: "x", created_at: "2026-10-08T17:00:00Z" } })).status).toBe("noshow");
  });
  it("reschedule pointers: the old cancelled event points forward, the new event points back, both carry the EVENT uuid", () => {
    const old = mapEvent(ev({ status: "canceled" }), inv({ status: "canceled", rescheduled: true, new_invitee: "https://api.calendly.com/scheduled_events/EV2/invitees/I2" }));
    expect(old.rescheduledTo).toBe("EV2");
    const neu = mapEvent(ev({ uri: "https://api.calendly.com/scheduled_events/EV2" }), inv({ uri: "https://api.calendly.com/scheduled_events/EV2/invitees/I2", old_invitee: "https://api.calendly.com/scheduled_events/EV1/invitees/I1" }));
    expect(neu.id).toBe("EV2"); expect(neu.rescheduledFrom).toBe("EV1");
    // a plain cancellation (no reschedule) must not point anywhere
    expect(mapEvent(ev({ status: "canceled" }), inv({ status: "canceled", rescheduled: false })).rescheduledTo).toBeUndefined();
  });
  it("an event with no invitee data still maps (status and time), with no identity", () => {
    const s = mapEvent(ev(), undefined);
    expect(s.invitee).toBeUndefined(); expect(s.status).toBe("confirmed");
  });
  it("uri helpers", () => {
    expect(uuidOf("https://api.calendly.com/event_types/abc")).toBe("abc");
    expect(eventUuidOfInvitee("https://api.calendly.com/scheduled_events/E/invitees/I")).toBe("E");
    expect(eventUuidOfInvitee(null)).toBe("");
  });
});

describe("per-calendar questions (D24)", () => {
  it("answers are read by the question text the calendar config names, prefix-matched; the setter decides self vs setter when the calendar says so", () => {
    const e = { uri: "https://api.calendly.com/scheduled_events/E1", name: "Call", status: "active", start_time: "2026-10-20T18:00:00Z", end_time: "2026-10-20T18:45:00Z", event_type: "https://api.calendly.com/event_types/T1", created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z", event_memberships: [{ user: "u", user_email: "james@x.com" }], invitees_counter: { total: 1, active: 1 } } as const;
    const inv = { uri: "https://api.calendly.com/scheduled_events/E1/invitees/I1", email: "ann@x.com", name: "Ann Lee", status: "active", rescheduled: false, updated_at: "2026-10-01T00:00:00Z",
      questions_and_answers: [{ question: "Who set this call for you? (required)", answer: "Luis" }, { question: "How long have you been noticing hair loss?", answer: "2 years" }, { question: "Best number to reach you", answer: "602-555-0101" }] } as const;
    const snap = mapEvent(e as never, inv as never, undefined, undefined, { booking: "question", questions: { setter: "Who set this call for you", phone: "Best number", noticing_for: "How long have you been noticing" } });
    expect(snap.setBy).toBe("Luis"); expect(snap.invitee?.phone).toBe("602-555-0101");
    expect(snap.answers).toEqual({ setter: "Luis", phone: "602-555-0101", noticing_for: "2 years" });
  });
});
