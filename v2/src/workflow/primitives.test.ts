import { describe, expect, it } from "vitest";
import { PRIMITIVES, parseType } from "./primitives";

const t = { title: "A step" };
const accept = (node: Record<string, unknown>) => {
  const r = PRIMITIVES.get(node.type as string)!.schema.safeParse({ id: "n1", ...t, ...node });
  expect(r.success, r.success ? "" : JSON.stringify(r.error.issues)).toBe(true);
};
const refuse = (node: Record<string, unknown>, message?: string) => {
  const r = PRIMITIVES.get(node.type as string)!.schema.safeParse({ id: "n1", ...t, ...node });
  expect(r.success).toBe(false);
  if (message && !r.success) expect(r.error.issues.map((i) => i.message).join(" | ")).toContain(message);
};
const outcomes = (node: Record<string, unknown>) => {
  const spec = PRIMITIVES.get(node.type as string)!;
  return spec.outcomes(spec.schema.parse({ id: "n1", ...t, ...node }));
};

describe("the primitive registry", () => {
  it("has the ten primitives, each at version 1", () => {
    expect([...PRIMITIVES.keys()].sort()).toEqual(["action@1", "ask@1", "branch@1", "call@1", "end@1", "message@1", "report@1", "set@1", "trigger@1", "wait@1"]);
  });

  it("reads a node type as a primitive and a version", () => {
    expect(parseType("wait@1")).toEqual({ name: "wait", version: 1 });
    expect(parseType("wait@12")).toEqual({ name: "wait", version: 12 });
    expect(parseType("wait")).toBeUndefined();
    expect(parseType("wait@0")).toBeUndefined();
    expect(parseType("Wait@1")).toBeUndefined();
  });

  it("every node needs an id and a title, and takes nothing it does not know", () => {
    refuse({ type: "end@1", reason: "done", title: "" });
    refuse({ type: "end@1", reason: "done", id: "$x" }, "a node id");
    refuse({ type: "end@1", reason: "done", colour: "red" });
    accept({ type: "end@1", reason: "done", onFailure: "hold" });
    refuse({ type: "end@1", reason: "done", onFailure: "retry" });
  });
});

describe("trigger@1", () => {
  it("starts on an event, narrowed by a match", () => {
    accept({ type: "trigger@1", on: { event: "appointment.booked", match: { eq: ["{{appointment.call_type}}", "closing"] } } });
    refuse({ type: "trigger@1", on: { event: "AppointmentCreate" } }, "canonical name");
  });
  it("starts on the clock: every interval, or at a time on given days", () => {
    accept({ type: "trigger@1", on: { schedule: { every: "1h" } } });
    accept({ type: "trigger@1", on: { schedule: { at: "18:00", days: [1, 2, 3, 4, 5], for: { role: "closer" } } } });
    accept({ type: "trigger@1", on: { schedule: { at: "08:00", dayOfMonth: 1 } } });
    refuse({ type: "trigger@1", on: { schedule: { every: "1h", at: "18:00" } } }, "either every");
    refuse({ type: "trigger@1", on: { schedule: {} } }, "either every");
    refuse({ type: "trigger@1", on: { schedule: { every: "1h", days: [1] } } }, "days and dayOfMonth go with at");
    refuse({ type: "trigger@1", on: { schedule: { at: "25:00" } } });
    refuse({ type: "trigger@1", on: { schedule: { at: "08:00", days: [8] } } });
  });
  it("starts by hand, about a subject", () => {
    accept({ type: "trigger@1", on: { manual: { about: "contact" } } });
    refuse({ type: "trigger@1", on: { manual: {} } });
  });
  it("needs exactly one way to start", () => {
    refuse({ type: "trigger@1", on: { event: "payment.failed", schedule: { every: "1h" } } });
    refuse({ type: "trigger@1" });
  });
});

describe("wait@1", () => {
  const until = { anchor: "appointment.starts_at", offset: "-24h", zone: "contact" };
  it("waits a length of time", () => {
    accept({ type: "wait@1", for: "2h" });
    refuse({ type: "wait@1", for: "2 hours" }, "a duration");
    refuse({ type: "wait@1", for: "0h" });
  });
  it("waits until a time rule: an offset or a day rule, earliest and latest, a min-lead guard", () => {
    accept({ type: "wait@1", until });
    accept({ type: "wait@1", until: { anchor: "appointment.starts_at", offset: "day_before@19:00", zone: "contact", earliest: "08:00", latest: "21:00" } });
    accept({ type: "wait@1", until: { anchor: "appointment.starts_at", offset: "day_of@08:00", zone: "offer" } });
    accept({ type: "wait@1", until: { anchor: "now", offset: "+4h", zone: "contact", guard: { minLead: "2h", fallback: "+15m" } } });
    accept({ type: "wait@1", until: { ...until, guard: { minLead: "2h", fallback: "+15m" } }, fitSendWindow: false });
    refuse({ type: "wait@1", until: { ...until, zone: undefined } });
    refuse({ type: "wait@1", until: { ...until, offset: "-1 day" } });
    refuse({ type: "wait@1", until: { ...until, offset: "week_before@19:00" } });
    refuse({ type: "wait@1", until: { ...until, earliest: "21:00", latest: "08:00" } }, "earliest must be before latest");
    refuse({ type: "wait@1", until: { ...until, guard: { minLead: "2h", fallback: "-15m" } } }, "fallback is a time after now");
    refuse({ type: "wait@1", until: { ...until, anchor: "{{appointment.starts_at}} or so" } }, "anchor");
    refuse({ type: "wait@1", until: { ...until, anchor: "the call" } }, "anchor");
    refuse({ type: "wait@1", for: "2h", fitSendWindow: true }, "fitSendWindow goes with until");
  });
  it("waits for an event, a reply or an answer, with a deadline", () => {
    accept({ type: "wait@1", event: { type: "agreement.signed", about: "contact" }, timeout: "3d", into: "signed" });
    accept({ type: "wait@1", event: { type: "payment.received", about: "contact", match: { gt: ["{{event.amount}}", 0] }, since: "{{appointment.starts_at}}" } });
    accept({ type: "wait@1", reply: { channel: "sms", settle: "90s" }, timeout: "4h", until: { anchor: "appointment.starts_at", offset: "-1h", zone: "contact" }, into: "answer" });
    accept({ type: "wait@1", answer: { ask: "q1" }, timeout: "1h", into: "decision" });
    refuse({ type: "wait@1", reply: { channel: "sms" } }, "needs a timeout or an until");
    refuse({ type: "wait@1", event: { type: "agreement.signed" } });
    refuse({ type: "wait@1", reply: { channel: "whatsapp" }, timeout: "1h" });
  });
  it("takes one {{…}} expression as an anchor, for time arithmetic", () => {
    accept({ type: "wait@1", until: { anchor: "{{appointment.booked_at | plus:5m}}", zone: "contact" } });
    accept({ type: "wait@1", until: { anchor: "{{vars.deadline}}", offset: "-1h", zone: "offer" } });
  });
  it("waits for the answer to a post any run remembered under a tag", () => {
    accept({ type: "wait@1", answer: { tag: "decision:{{appointment.id}}" }, timeout: "2h", into: "decision" });
    accept({ type: "wait@1", answer: { tag: "decision:{{appointment.id}}", since: "{{appointment.booked_at}}" }, into: "decision" });
    refuse({ type: "wait@1", answer: { tag: "" }, into: "decision" });
    refuse({ type: "wait@1", answer: { ask: "q1", tag: "x" } });
    expect(outcomes({ type: "wait@1", answer: { tag: "t:{{appointment.id}}" }, timeout: "1h" })).toEqual({ required: ["arrived", "timeout"] });
  });
  it("looks again at a condition every so often, up to a deadline", () => {
    accept({ type: "wait@1", check: { holds: { exists: "contact.phone" }, every: "1h" }, timeout: "24h" });
    accept({ type: "wait@1", check: { holds: { exists: "contact.phone" }, every: "15m" }, until: { anchor: "appointment.starts_at", offset: "-1h", zone: "contact" } });
    refuse({ type: "wait@1", check: { holds: { exists: "contact.phone" }, every: "1h" } }, "needs a timeout or an until");
    refuse({ type: "wait@1", check: { holds: { exists: "contact.phone" } }, timeout: "1d" });
    refuse({ type: "wait@1", check: { holds: { exists: "contact.phone" }, every: "1h" }, timeout: "1d", into: "x" }, "into goes with");
    expect(outcomes({ type: "wait@1", check: { holds: { exists: "contact.phone" }, every: "1h" }, timeout: "24h" })).toEqual({ required: ["arrived", "timeout"] });
  });
  it("pauses the run for a person, who resumes or ends it", () => {
    accept({ type: "wait@1", person: { reason: "no_phone" } });
    refuse({ type: "wait@1", person: { reason: "No phone!" } }, "lowercase");
    refuse({ type: "wait@1", person: { reason: "no_phone" }, timeout: "1d" }, "timeout goes with");
    refuse({ type: "wait@1", person: { reason: "no_phone" }, until }, "no deadline");
    refuse({ type: "wait@1", person: { reason: "no_phone" }, for: "1h" }, "one thing");
    expect(outcomes({ type: "wait@1", person: { reason: "no_phone" } })).toEqual({ required: ["resumed"] });
  });
  it("waits for one thing at a time", () => {
    refuse({ type: "wait@1" }, "a wait needs");
    refuse({ type: "wait@1", for: "1h", until }, "not both");
    refuse({ type: "wait@1", for: "1h", reply: { channel: "sms" }, timeout: "1h" }, "one thing");
    refuse({ type: "wait@1", for: "1h", timeout: "2h" }, "timeout goes with");
    refuse({ type: "wait@1", until, into: "x" }, "into goes with");
  });
  it("leaves by next after a time, by arrived or timeout after waiting for something", () => {
    expect(outcomes({ type: "wait@1", for: "2h" })).toEqual({ required: ["next"] });
    expect(outcomes({ type: "wait@1", until })).toEqual({ required: ["next"] });
    expect(outcomes({ type: "wait@1", reply: { channel: "sms" }, timeout: "4h" })).toEqual({ required: ["arrived", "timeout"] });
    expect(outcomes({ type: "wait@1", event: { type: "agreement.signed", about: "contact" } })).toEqual({ required: ["arrived"] });
  });
});

describe("branch@1", () => {
  it("is only the question: its edges hold the answers", () => {
    accept({ type: "branch@1" });
    refuse({ type: "branch@1", when: { exists: "contact.email" } });
  });
});

describe("set@1", () => {
  it("computes one variable from text, a value, a $pick or an $if", () => {
    accept({ type: "set@1", var: "greeting", value: "Hi {{contact.first_name | default:there}}" });
    accept({ type: "set@1", var: "n", value: 3 });
    accept({ type: "set@1", var: "pay", value: { $pick: "{{event.kind}}", cases: { refund: { sign: "−", status: "refunded" } }, else: { sign: "", status: "succeeded" } } });
    accept({ type: "set@1", var: "late", value: { $if: { gt: ["{{event.days}}", 3] }, then: true, else: false } });
    accept({ type: "set@1", var: "list", value: ["a", { b: [1, null] }] });
  });
  it("refuses a misspelled operation, a bad name, or more than one variable", () => {
    refuse({ type: "set@1", var: "x", value: { $pik: "{{event.kind}}", cases: {}, else: 1 } }, "may not start with $");
    refuse({ type: "set@1", var: "x", value: { $pick: "event.kind", cases: {}, else: 1 } });
    refuse({ type: "set@1", var: "X-Y", value: 1 });
    refuse({ type: "set@1", var: "x", vars: { y: 1 }, value: 1 });
  });
});

describe("message@1", () => {
  it("texts or emails the contact by content key", () => {
    accept({ type: "message@1", to: { contact: "sms" }, content: "pre_call.reminder_1h", kind: "human", validity: { before: "appointment.starts_at", minLead: "15m" }, whenStale: "skip" });
    accept({ type: "message@1", to: { contact: "email" }, content: "deal.welcome", validity: { after: "payment.paid_at", maxLag: "2d" }, whenStale: { send: "deal.welcome_late" } });
  });
  it("posts to a Slack channel from a setting, or a DM with a fallback", () => {
    accept({ type: "message@1", to: { slack: { channel: "{{setting.slack.channel.payments}}" } }, content: "payment_failed.slack_alert", remember: "pay:{{payment.id}}", buttons: [{ action: "alert_resolve", value: "{{event.alert_id}}" }] });
    accept({ type: "message@1", to: { slack: { dm: "{{contact.owner.slack_id}}", fallbackChannel: "{{setting.slack.channel.alerts}}" } }, content: "owner.nudge", thread: { tag: "booking:{{appointment.id}}" }, threadOnly: true });
    accept({ type: "message@1", to: { slack: { channel: "{{setting.slack.channel.calls}}" } }, content: { pick: "{{event.level}}", cases: { error: "alerts.error" }, else: "alerts.warning" } });
  });
  it("shows a button only when its condition holds", () => {
    accept({ type: "message@1", to: { slack: { channel: "{{setting.slack.channel.payments}}" } }, content: "payments.unlinked", buttons: [{ action: "link_payment", value: "{{payment.id}}", when: { not: { exists: "payment.contact_id" } } }, { action: "alert_resolve", value: "{{payment.id}}" }] });
    refuse({ type: "message@1", to: { slack: { channel: "{{setting.slack.channel.payments}}" } }, content: "payments.unlinked", buttons: [{ action: "link_payment", value: "{{payment.id}}", when: { exists: "{{payment.contact_id}}" } }] });
  });
  it("never takes words inline, nor a channel written in", () => {
    refuse({ type: "message@1", to: { contact: "sms" }, content: "Hi {{contact.first_name}}, see you soon!" }, "content key");
    refuse({ type: "message@1", to: { contact: "sms" }, text: "Hi" });
    refuse({ type: "message@1", to: { slack: { channel: "C0C7QCTHL8L" } }, content: "x.y" }, "one setting");
    refuse({ type: "message@1", to: { slack: { channel: "#payments" } }, content: "x.y" }, "one setting");
    refuse({ type: "message@1", to: { slack: { channel: "{{setting.slack.channel.payments | default:x}}" } }, content: "x.y" }, "one setting");
  });
  it("keeps contact options and Slack options to their own kind of message", () => {
    refuse({ type: "message@1", to: { slack: { channel: "{{setting.slack.channel.a}}" } }, content: "x.y", kind: "human" }, "kind is only for a message to the contact");
    refuse({ type: "message@1", to: { contact: "sms" }, content: "x.y", thread: { node: "p1" } }, "thread is only for a message to Slack");
    refuse({ type: "message@1", to: { contact: "sms" }, content: "x.y", whenStale: "skip" }, "whenStale needs a validity");
    refuse({ type: "message@1", to: { slack: { channel: "{{setting.slack.channel.a}}" } }, content: "x.y", threadOnly: true }, "threadOnly needs a thread");
    refuse({ type: "message@1", to: { contact: "whatsapp" }, content: "x.y" });
    refuse({ type: "message@1", to: { slack: { channel: "{{setting.slack.channel.a}}" } }, content: "x.y", buttons: [{ action: "launch_rocket", value: "1" }] });
  });
});

describe("ask@1", () => {
  const to = { channel: "{{setting.slack.channel.attention}}" };
  it("asks with buttons, reactions or a form, and waits, goes on, or listens", () => {
    accept({ type: "ask@1", to, content: "pre_call.decide", answers: { buttons: [{ value: "keep", style: "primary" }, { value: "cancel", style: "danger" }] }, into: "decision", then: "wait", timeout: "2h" });
    accept({ type: "ask@1", to, content: "pre_call.decide", answers: { reactions: ["white_check_mark", "x", "repeat"] }, into: "decision", then: "listen", until: { anchor: "appointment.starts_at", zone: "contact" } });
    accept({ type: "ask@1", to, content: "eod.ask", answers: { form: "eod.closer" }, into: "eod", then: "go_on", remember: "eod:{{person.id}}" });
  });
  it("refuses an ask with no answers, duplicate buttons, or a deadline when it goes on", () => {
    refuse({ type: "ask@1", to, content: "a.b", answers: { buttons: [] }, into: "d", then: "wait" });
    refuse({ type: "ask@1", to, content: "a.b", answers: { buttons: [{ value: "yes" }, { value: "yes" }] }, into: "d", then: "wait" }, "each button has its own value");
    refuse({ type: "ask@1", to, content: "a.b", answers: { reactions: [":x:"] }, into: "d", then: "wait" }, "without colons");
    refuse({ type: "ask@1", to, content: "a.b", answers: { buttons: [{ value: "y" }] }, into: "d", then: "go_on", timeout: "1h" }, "no deadline of its own");
    refuse({ type: "ask@1", to, content: "a.b", answers: { buttons: [{ value: "y" }] }, then: "wait" });
    refuse({ type: "ask@1", to: { contact: "sms" }, content: "a.b", answers: { buttons: [{ value: "y" }] }, into: "d", then: "wait" });
  });
  it("leaves by answered or timeout when it waits; by next, then answered or expired, when it listens", () => {
    const base = { type: "ask@1", to, content: "a.b", answers: { buttons: [{ value: "y" }] }, into: "d" };
    expect(outcomes({ ...base, then: "wait", timeout: "1h" })).toEqual({ required: ["answered", "timeout"] });
    expect(outcomes({ ...base, then: "wait" })).toEqual({ required: ["answered"] });
    expect(outcomes({ ...base, then: "go_on" })).toEqual({ required: ["next"] });
    expect(outcomes({ ...base, then: "listen", timeout: "1d" })).toEqual({ required: ["next", "answered", "expired"] });
    expect(outcomes({ ...base, then: "listen" })).toEqual({ required: ["next", "answered"] });
  });
});

describe("action@1", () => {
  it("takes a known verb with its params", () => {
    accept({ type: "action@1", action: "crm.add_tag", params: { tags: ["stat-confirmed"] } });
    accept({ type: "action@1", action: "ai.classify", params: { input: "{{reply.since_last_send}}", prompt: "pre_call.reply_intent", options: ["confirmed", "unclear"], threshold: 0.8, unclear: "unclear" }, into: "intent" });
  });
  it("refuses an unknown verb, wrong params, or an into the verb cannot fill", () => {
    refuse({ type: "action@1", action: "crm.add_tags", params: {} }, 'unknown action "crm.add_tags"');
    refuse({ type: "action@1", action: "crm.add_tag", params: { tag: "x" } }, "crm.add_tag:");
    refuse({ type: "action@1", action: "crm.add_tag", params: { tags: ["x"] }, into: "t" }, "gives nothing back");
    refuse({ type: "action@1", action: "ai.summarize", params: { prompt: "a.b", input: "{{recording.transcript}}", format: "json" } }, "name it with into");
    refuse({ type: "action@1", action: "CRM.add", params: {} }, "connector.verb");
  });
});

describe("report@1", () => {
  it("renders a report definition by key into a variable", () => {
    accept({ type: "report@1", report: "wrap_up.daily", period: "just_ended", into: "report" });
    accept({ type: "report@1", report: "leaderboard.weekly", period: "in_progress", params: { closer: "{{person.id}}" }, into: "board" });
    refuse({ type: "report@1", report: "wrap_up.daily", into: "report" });
    refuse({ type: "report@1", report: "Daily wrap-up", period: "just_ended", into: "report" });
    refuse({ type: "report@1", report: "wrap_up.daily", period: "just_ended" });
  });
});

describe("call@1", () => {
  it("starts another of the offer's workflows", () => {
    accept({ type: "call@1", workflow: "no-show-recovery" });
    accept({ type: "call@1", workflow: "no-show-recovery", with: { reason: "{{vars.why}}" } });
    refuse({ type: "call@1", workflow: "No Show" });
  });
});

describe("end@1", () => {
  it("ends with a reason", () => {
    accept({ type: "end@1", reason: "cancelled" });
    refuse({ type: "end@1" });
    refuse({ type: "end@1", reason: "Cancelled by them" });
    expect(outcomes({ type: "end@1", reason: "done" })).toEqual({ required: [] });
  });
});
