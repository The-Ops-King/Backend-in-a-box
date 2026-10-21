import { chain, flow } from "@/test/harness";

/** Workflows and words the Slack tests post with (test data, no offer's). */
type N = Record<string, unknown>;
export const trig = (event = "appointment.booked"): N => ({ id: "t1", type: "trigger@1", title: "Booked", on: { event } });
export const end = (id = "x1", reason = "done"): N => ({ id, type: "end@1", title: "Done", reason });

/** A booking card asking Confirm / Cancel / Reschedule, waiting for the answer, then saying which. */
export const cardFlow = (extra: N = {}) => flow("booking-card", [
  trig(),
  { id: "q1", type: "ask@1", title: "Confirm the call?", to: { channel: "{{setting.slack.channel.bookings}}" }, content: "c.q1", answers: { buttons: [{ value: "confirm", style: "primary" }, { value: "cancel", style: "danger" }, { value: "reschedule" }] }, into: "decision", then: "wait", remember: "card:{{appointment.id}}", ...extra },
  { id: "b1", type: "branch@1", title: "Which?" },
  { id: "p_ok", type: "message@1", title: "Confirmed", to: { slack: { channel: "{{setting.slack.channel.bookings}}" } }, content: "c.ok", thread: { node: "q1" } },
  { id: "p_no", type: "message@1", title: "Other", to: { slack: { channel: "{{setting.slack.channel.bookings}}" } }, content: "c.no", thread: { node: "q1" } },
  end(),
], [{ from: "t1", to: "q1" }, { from: "q1", to: "b1", on: "answered" }, { from: "b1", to: "p_ok", when: { eq: ["{{vars.decision.value}}", "confirm"] } }, { from: "b1", to: "p_no", else: true }, { from: "p_ok", to: "x1" }, { from: "p_no", to: "x1" }]);

export const cardContent = {
  "c.q1": { channel: "slack" as const, body: "New call: {{contact.first_name}}", as: "Acme Bookings", icons: [":calendar:"], labels: { confirm: "Confirm", cancel: "Cancel", reschedule: "Reschedule" } },
  "c.ok": { channel: "slack" as const, body: "Confirmed by {{vars.decision.person}}" },
  "c.no": { channel: "slack" as const, body: "Not confirmed: {{vars.decision.value}}" },
};

/** A reaction question (✅ or ❌). */
export const reactFlow = () => flow("react-card", [
  trig(),
  { id: "q1", type: "ask@1", title: "Did they show?", to: { channel: "{{setting.slack.channel.calls}}" }, content: "c.r1", answers: { reactions: ["white_check_mark", "x"] }, into: "showed", then: "wait" },
  { id: "p1", type: "message@1", title: "Said", to: { slack: { channel: "{{setting.slack.channel.calls}}" } }, content: "c.r2" },
  end(),
], [...chain("t1", "q1"), { from: "q1", to: "p1", on: "answered" }, { from: "p1", to: "x1" }]);
export const reactContent = { "c.r1": { channel: "slack" as const, body: "Did {{contact.first_name}} show?" }, "c.r2": { channel: "slack" as const, body: "Answer: {{vars.showed.value}}" } };

/** An unlinked payment's post with a Link button. */
export const unlinkedFlow = () => flow("unlinked", [
  trig("payment.unlinked"),
  { id: "p1", type: "message@1", title: "Unlinked", to: { slack: { channel: "{{setting.slack.channel.payments}}" } }, content: "c.u1", buttons: [{ action: "link_payment", value: "{{event.payment_id}}" }] },
  end(),
], chain("t1", "p1", "x1"));
export const unlinkedContent = { "c.u1": { channel: "slack" as const, body: "A payment of {{event.amount}} matched nobody", labels: { link_payment: "Link to a contact" } } };

/** A plain post. */
export const postFlow = (channel = "bookings") => flow(`post-${channel}`, [trig(), { id: "p1", type: "message@1", title: "Post", to: { slack: { channel: `{{setting.slack.channel.${channel}}}` } }, content: "c.p1" }, end()], chain("t1", "p1", "x1"));
export const postContent = { "c.p1": { channel: "slack" as const, body: "Booked: {{contact.first_name}}", as: "Acme Ops", icons: [":one:", ":two:"] } };

export const booked = (first = "Ana") => ({ appointment: "a1", payload: { contact: { first_name: first, timezone: "America/New_York" }, appointment: { starts_at: "2026-10-29T18:00:00Z", status: "booked", call_type: "closing" } } });
