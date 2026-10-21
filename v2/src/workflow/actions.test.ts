import { describe, expect, it } from "vitest";
import { ACTIONS, isContactFacing, isOutbound } from "./actions/registry";

/** One params object each verb accepts, and one it refuses. Every verb in the registry must be here. */
const CASES: Record<string, { ok: unknown; bad: unknown }> = {
  "crm.find_or_create_contact": { ok: { match: ["crm_id", "email", "phone"], create: true, fillBlank: { first_name: "{{event.first_name}}" } }, bad: { match: [], create: true } },
  "crm.update_contact": { ok: { set: { lead_source: "{{event.utm_source}}" }, ifEmpty: ["lead_source"] }, bad: {} },
  "crm.add_tag": { ok: { tags: ["stat-confirmed", "{{setting.scope.tag}}"] }, bad: { tags: [] } },
  "crm.remove_tag": { ok: { tags: ["stat-unconfirmed"] }, bad: { tags: "stat-unconfirmed" } },
  "crm.mark_dnd": { ok: { channel: "sms" }, bad: { channel: "fax" } },
  "crm.move_deal": { ok: { pipeline: "{{setting.crm.pipeline.closer}}", stage: "{{setting.crm.stage.closer.booked}}", ifMissing: "create", pick: "open", fromStages: ["{{setting.crm.stage.closer.new}}"] }, bad: { pipeline: "p", ifMissing: "create", pick: "open" } },
  "crm.set_deal_status": { ok: { pipeline: "{{setting.crm.pipeline.closer}}", status: "won", from: ["open"] }, bad: { pipeline: "p", status: "closed" } },
  "crm.update_deal": { ok: { pipeline: "{{setting.crm.pipeline.closer}}", value: "{{event.contract_value}}" }, bad: { pipeline: "p" } },
  "crm.create_task": { ok: { title: "rebook.task_title", due: "1d", assignTo: "{{contact.owner.crm_id}}" }, bad: { title: "Rebook this person", due: "1d" } },
  "crm.add_note": { ok: { content: "payment.note" }, bad: { text: "PAYMENT RECEIVED" } },
  "crm.upsert_record": { ok: { object: "{{setting.crm.object.payment}}", key: "{{payment.id}}", properties: { amount: "{{payment.amount}}" }, ifMissing: "create" }, bad: { object: "o", properties: {}, ifMissing: "create" } },
  "crm.relate_records": { ok: { association: "{{setting.crm.assoc.payment_contact}}", first: "{{contact.crm_id}}", second: "{{vars.record.id}}" }, bad: { association: "a", first: "b" } },
  "scheduling.cancel": { ok: { appointment: "{{appointment.id}}" }, bad: {} },
  "scheduling.set_status": { ok: { appointment: "{{appointment.id}}", status: "showed" }, bad: { appointment: "{{appointment.id}}", status: "cancelled" } },
  "esign.send": { ok: { template: "{{setting.esign.agreement_template}}", name: "Purchase agreement" }, bad: { name: "x" } },
  "esign.void": { ok: { agreement: "{{agreement.id}}" }, bad: { agreement: "" } },
  "ai.classify": { ok: { input: "{{reply.since_last_send}}", context: "{{reply.last_sent}}", prompt: "pre_call.reply_intent", options: ["confirmed", "cancelled", "unclear"], threshold: 0.8, ambiguityMax: 0.8, unclear: "unclear" }, bad: { input: "x", prompt: "p.q", options: ["confirmed", "cancelled"], threshold: 0.8, unclear: "unclear" } },
  "ai.summarize": { ok: { prompt: "calls.notes", input: "{{recording.transcript}}", format: "json", optional: false }, bad: { prompt: "Summarize this call", input: "x", format: "json" } },
  "slack.react": { ok: { post: { node: "p1" }, emojis: ["white_check_mark"] }, bad: { post: { node: "p1" }, emojis: [] } },
  "slack.unreact": { ok: { post: { tag: "decision:{{appointment.id}}" }, emojis: ["x", "repeat"] }, bad: { post: "p1", emojis: ["x"] } },
  "slack.update_post": { ok: { post: { node: "p1" }, content: "booking.card_cancelled" }, bad: { post: { node: "p1" } } },
  "http.request": { ok: { url: "https://hooks.zapier.com/x", method: "POST", headers: { authorization: "Bearer {{secret.zap}}" }, body: { id: "{{contact.id}}" }, onError: "skip" }, bad: { url: "http://insecure.test", method: "POST", onError: "skip" } },
  "facts.record": { ok: { type: "intent.reviewed", data: { agreed: "{{vars.agreed}}" }, startsWorkflows: false }, bad: { type: "IntentReviewed", data: {}, startsWorkflows: false } },
  "facts.lookup": { ok: { query: "calls_for_contact", params: { since: "{{appointment.booked_at}}", connected: "true" } }, bad: { query: "calls_for_contact", params: { recording_id: "x" } } },
  "facts.record_outcome": { ok: { appointment: "{{appointment.id}}", outcome: "showed", source: "engine" }, bad: { appointment: "{{appointment.id}}", outcome: "showed", source: "jev" } },
  "runs.pause_others": { ok: { scope: "contact" }, bad: { scope: "offer" } },
};

describe("the action registry", () => {
  it("has a test case for every verb, and every case is a verb", () => {
    expect(Object.keys(CASES).sort()).toEqual([...ACTIONS.keys()].sort());
  });

  it.each(Object.entries(CASES))("%s accepts its params and refuses wrong ones", (verb, { ok, bad }) => {
    const def = ACTIONS.get(verb)!;
    const good = def.params.safeParse(ok);
    expect(good.success, good.success ? "" : JSON.stringify(good.error.issues)).toBe(true);
    expect(def.params.safeParse(bad).success).toBe(false);
  });

  it("refuses params a verb does not know", () => {
    expect(ACTIONS.get("crm.add_tag")!.params.safeParse({ tags: ["a"], colour: "red" }).success).toBe(false);
  });

  it("says which verbs reach the contact, so the send lock covers them like a text", () => {
    expect([...ACTIONS.keys()].filter(isContactFacing).sort()).toEqual(["esign.send", "esign.void", "scheduling.cancel"]);
  });

  it("says which verbs leave the platform, so the delivery gate checks them", () => {
    const outbound = [...ACTIONS.keys()].filter(isOutbound);
    expect(outbound).toContain("crm.add_tag");
    expect(outbound).toContain("slack.react");
    expect(outbound).toContain("http.request");
    expect(outbound).toContain("scheduling.cancel");
    for (const v of ["ai.classify", "ai.summarize", "facts.record", "facts.lookup", "facts.record_outcome", "runs.pause_others"]) expect(outbound).not.toContain(v);
    expect(isOutbound("crm.nope")).toBe(false);
  });

  it("names the content an action's params use", () => {
    const note = ACTIONS.get("crm.add_note")!;
    expect(note.content!(note.params.parse({ content: "payment.note" }))).toEqual(["payment.note"]);
    const task = ACTIONS.get("crm.create_task")!;
    expect(task.content!(task.params.parse({ title: "t.title", body: "t.body", due: "1d" }))).toEqual(["t.title", "t.body"]);
  });
});
