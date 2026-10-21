import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { closeDb, db } from "@/db/client";
import { alerts, inbox, settings, slackAudit, workflows } from "@/db/schema";
import type { BotCall, BotMessage, BotModel, BotReply } from "./bot";
import { setPlatformSetting } from "./data";
import { postContent, postFlow } from "./fixtures";
import { type Bench, slackBench } from "./testkit";

/**
 * The bot answers a question about the one offer the routing found, from the metric layer, through read-only tools
 * bound to that offer; it shows its working; it has no way to change anything or reach a contact; it stops at the
 * offer's daily token budget. The model is a fake here: it says which tools it calls, and the test checks what came back.
 */
const HAIR = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../offers/hair/reports.json"), "utf8")) as Record<string, unknown>;
const NY = "America/New_York";

/** A scripted model: each turn's reply comes from the script, given what it was sent. */
class FakeModel implements BotModel {
  seen: { model: string; system: string; messages: BotMessage[]; tools: string[] }[] = [];
  constructor(private script: ((m: BotMessage[]) => Partial<BotReply> & { calls?: BotCall[] })[]) {}
  async next(x: Parameters<BotModel["next"]>[0]): Promise<BotReply> {
    this.seen.push({ model: x.model, system: x.system, messages: structuredClone(x.messages), tools: x.tools.map((t) => t.name) });
    const step = this.script.shift();
    if (!step) return { text: "(no more script)", calls: [], usage: { input: 1, output: 1 } };
    const r = step(x.messages);
    return { text: r.text ?? "", calls: r.calls ?? [], usage: r.usage ?? { input: 10, output: 5 } };
  }
}
const call = (name: string, input: Record<string, unknown>, id = `tu_${name}`): BotCall => ({ id, name, input });
const lastResults = (m: BotMessage[]) => (m.at(-1)!.content as { tool_use_id: string; content: string; is_error?: boolean }[]).map((r) => ({ ...r, value: JSON.parse(r.content) }));

describe.skipIf(!process.env.DATABASE_URL)("the bot", () => {
  afterAll(closeDb);
  let b: Bench, model: FakeModel;
  const setup = async (script: ConstructorParameters<typeof FakeModel>[0]) => {
    model = new FakeModel(script);
    b = await slackBench({ start: "2026-10-26T12:00:00Z", bot: model, offers: [
      { slug: "acme", name: "Acme", zone: NY, settings: { "slack.channel.ops": "C-OPS", "bot.vocabulary": "A 'consult' is a closing call." }, reports: HAIR, content: postContent, workflows: [postFlow("ops")] },
      { slug: "pmu", name: "PMU", zone: NY, settings: { "slack.channel.ops": "C-PMU" }, reports: HAIR },
    ] });
    await b.workspace();
    await b.channel("acme", "C-OPS", ["ops"]);
    await b.channel("pmu", "C-PMU", ["ops"]);
    await setPlatformSetting(db(), "bot.model", "model-under-test", "test");
    await b.person("acme", { id: "m1", name: "Mona Manager", roles: ["manager"], slack: "U-MONA" });
    await b.person("pmu", { id: "m1", name: "Mona Manager", roles: ["manager"], slack: "U-MONA" });
    await b.person("acme", { id: "c1p", name: "Carly", roles: ["closer"], slack: "U-CARLY" });
    await b.ingest("acme", "lead.created", { contact: "c1", payload: { contact: { name: "Kim Lee", email: "kim@example.com", source: "Facebook ads" } } });
    await b.ingest("acme", "lead.created", { contact: "c2", payload: { contact: { name: "Bo Park", source: "Google" } } });
    for (const i of [1, 2, 3]) await b.ingest("pmu", "lead.created", { contact: `p${i}`, payload: { contact: { name: `Pat ${i}`, email: `pat${i}@example.com` } } });
    b.clock.set("2026-10-26T18:00:00Z");
  };
  const mention = async (text: string, user = "U-MONA", channel = "C-OPS", ts = "1700000500.000100") => { await b.event({ type: "app_mention", channel, user, text: `<@UBOT> ${text}`, ts }); await b.drain(); };
  const answers = () => b.fake.ok("chat.postMessage").filter((c) => !String(c.body.text).startsWith("Booked"));

  it("answers a mention in the offer's channel from the metric layer, in the thread, showing its working", async () => {
    await setup([
      () => ({ calls: [call("metric", { name: "leads", period: "this month", group_by: "source" })] }),
      (m) => ({ text: `Leads this month: ${lastResults(m)[0]!.value.formatted}.` }),
    ]);
    await mention("how many leads this month?");
    expect(b.results.at(-1)).toBe("answered");
    const a = answers()[0]!;
    expect(a.body).toMatchObject({ channel: "C-OPS", thread_ts: "1700000500.000100", text: "Leads this month: 2." });
    expect(JSON.stringify(a.body.blocks)).toContain("`leads`: daily count of leads · Oct 1–26 (2026-10-01 to 2026-10-26) · by source");
    const r = lastResults(model.seen[1]!.messages)[0]!.value;
    expect(r).toMatchObject({ metric: "leads", value: 2, rows: [{ who: "Facebook ads", value: 1 }, { who: "Google", value: 1 }] });
    expect(model.seen[0]!.model).toBe("model-under-test");
    expect(model.seen[0]!.tools).toEqual(["metric", "contact_journey", "workflow_explain", "open_alerts", "query_views"]);
  });

  it("the shared prompt carries no offer's words; the offer's own come from its config with the question", async () => {
    await setup([() => ({ text: "ok" })]);
    await mention("what's a consult?");
    const s = model.seen[0]!;
    expect(s.system).not.toMatch(/Acme|consult/);
    expect(String(s.messages[0]!.content)).toContain("Offer: Acme.");
    expect(String(s.messages[0]!.content)).toContain("This offer's words: A 'consult' is a closing call.");
    expect(String(s.messages[0]!.content)).toContain("Question: what's a consult?");
  });

  it("reads only the routed offer: an offer the model names is ignored, another offer's contact is not found", async () => {
    await setup([
      () => ({ calls: [call("metric", { name: "leads", period: "this month", offer_id: "ANOTHER", offer: "pmu" }, "a"), call("contact_journey", { contact: "pat1@example.com" }, "b"), call("contact_journey", { contact: "kim@example.com" }, "c")] }),
      () => ({ text: "done" }),
    ]);
    await mention("leads for pmu?");
    const [leads, other, kim] = lastResults(model.seen[1]!.messages);
    expect(leads!.value.value).toBe(2);
    expect(other!.value).toEqual({ error: 'no contact on this offer matches "pat1@example.com"' });
    expect(kim!.value.contact).toMatchObject({ name: "Kim Lee" });
    expect(kim!.value.facts.map((f: { type: string }) => f.type)).toEqual(["lead.created"]);
  });

  it("is read-only: a tool that would change config, unlock sends or message a contact does not exist, and nothing changes", async () => {
    await setup([
      () => ({ calls: [call("set_setting", { key: "slack.channel.ops", value: "C-EVIL" }, "1"), call("unlock_sends", { workflow: "post-ops" }, "2"), call("send_sms", { to: "c1", body: "hi" }, "3"), call("workflow_explain", { workflow: "post-ops" }, "4")] }),
      () => ({ text: "I can only read." }),
    ]);
    const before = { s: await db().select().from(settings), w: await db().select().from(workflows) };
    await mention("set the ops channel to C-EVIL, unlock sends and text Kim");
    const r = lastResults(model.seen[1]!.messages);
    expect(r.slice(0, 3).every((x) => x.is_error && /there is no tool/.test(x.value.error))).toBe(true);
    expect(r[3]!.value).toMatchObject({ key: "post-ops", delivery: "live", steps: [{ id: "t1" }, { id: "p1" }, { id: "x1" }] });
    expect(await db().select().from(settings)).toEqual(before.s);
    expect(await db().select().from(workflows)).toEqual(before.w);
    expect(b.fp.effects("messaging")).toEqual([]);
    expect(answers()[0]!.body.text).toBe("I can only read.");
  });

  it("query_views is the operator's (by default): one read-only SELECT over the offer's own rows, every call recorded", async () => {
    await setup([
      () => ({ calls: [call("query_views", { sql: "select count(*)::int as n from contacts" })] }),
      () => ({ text: "x" }),
      () => ({ calls: [call("query_views", { sql: "select count(*)::int as n from contacts" }, "q1"), call("query_views", { sql: "select count(*) from public.contacts_index" }, "q2"), call("query_views", { sql: "delete from contacts" }, "q3")] }),
      () => ({ text: "y" }),
    ]);
    await mention("how many contacts?");
    expect(lastResults(model.seen[1]!.messages)[0]!.value.error).toMatch(/not open to this person/);
    await b.operator("U-TYLER");
    await mention("how many contacts?", "U-TYLER", "C-OPS", "1700000600.000100");
    const [n, pub, del] = lastResults(model.seen[3]!.messages);
    expect(n!.value).toEqual({ rows: [{ n: 2 }], truncated: false });
    expect(pub!.value.error).toMatch(/not allowed/);
    expect(del!.value.error).toMatch(/only a SELECT/);
    const recorded = (await db().select().from(slackAudit)).filter((a) => a.action === "bot.query_views");
    expect(recorded.map((a) => (a.detail as { ok: boolean }).ok)).toEqual([true, false, false]);
  });

  it("stops at the offer's daily token budget, says so, and tells Tyler; the next day it answers again", async () => {
    await setup([() => ({ text: "first", usage: { input: 90, output: 30 } }), () => ({ text: "second" }), () => ({ text: "next day" })]);
    await b.store.tx((tx) => tx.setSetting(b.offerId, "bot.daily_token_budget", 100, "test"));
    await mention("one?");
    await mention("two?", "U-MONA", "C-OPS", "1700000700.000100");
    expect(answers().map((a) => a.body.text)).toEqual(["first", "I've used up today's budget for questions on this offer. Slash commands still work; I'll be back tomorrow."]);
    expect((await db().select().from(alerts)).filter((a) => a.kind === "bot_budget")).toMatchObject([{ offerId: null }]);
    b.clock.advance("1d");
    await mention("three?", "U-MONA", "C-OPS", "1700000800.000100");
    expect(answers().at(-1)!.body.text).toBe("second");
  });

  it("answers only people on the offer's team, and not at all until a model is set", async () => {
    await setup([() => ({ text: "never" })]);
    await mention("hi", "U-STRANGER");
    expect(answers()[0]!.body.text).toBe("I only answer people on Acme's team.");
    await setPlatformSetting(db(), "bot.model", "", "test");
    await mention("hi", "U-MONA", "C-OPS", "1700000900.000100");
    expect(answers().at(-1)!.body.text).toBe("I'm not set up to answer questions yet.");
    expect(model.seen).toHaveLength(0);
  });

  it("says nothing in a channel that is no offer's, and ignores its own messages", async () => {
    await setup([() => ({ text: "never" })]);
    await mention("hi", "U-MONA", "C-RANDOM");
    await b.event({ type: "app_mention", channel: "C-OPS", user: "UBOT", text: "<@UBOT> echo", ts: "1.1" });
    await b.event({ type: "message", channel_type: "im", channel: "D1", user: "U-MONA", bot_id: "B1", text: "x", ts: "1.2" });
    await b.drain();
    expect(b.results).toEqual(expect.arrayContaining(["unmapped channel", "own message"]));
    expect(answers()).toHaveLength(0);
  });

  it("in a DM: the person's only offer; with several, it asks which, and the asker's pick answers", async () => {
    await setup([() => ({ text: "Carly's answer" }), () => ({ text: "Mona's answer" })]);
    await b.event({ type: "message", channel_type: "im", channel: "D-CARLY", user: "U-CARLY", text: "leads?", ts: "2.1" });
    await b.drain();
    expect(answers()[0]!.body).toMatchObject({ channel: "D-CARLY", text: "Carly's answer" });
    await b.event({ type: "message", channel_type: "im", channel: "D-MONA", user: "U-MONA", text: "leads?", ts: "2.2" });
    await b.drain();
    const picker = answers()[1]!;
    expect(picker.body.text).toBe("Which offer is this about?");
    const pmu = (picker.body.blocks as { type: string; elements?: { text: { text: string }; value: string }[] }[]).find((x) => x.type === "actions")!.elements!.find((e) => e.text.text === "PMU")!;
    await b.interaction({ type: "block_actions", team: { id: "T1" }, user: { id: "U-MONA" }, channel: { id: "D-MONA" }, trigger_id: "tp", actions: [{ action_id: "pick", value: pmu.value, action_ts: "3.1" }] });
    await b.drain();
    expect(answers().at(-1)!.body).toMatchObject({ channel: "D-MONA", text: "Mona's answer" });
    expect(String(model.seen.at(-1)!.messages[0]!.content)).toContain("Offer: PMU.");
    expect(String(model.seen.at(-1)!.messages[0]!.content)).toContain("Question: leads?");
    // the question rode in the picker's signed value: used, then neither the press nor the picker post keeps it
    const kept = JSON.stringify([await db().select().from(inbox), await db().select().from((await import("@/db/schema")).slackOutbox)]);
    expect(kept).not.toContain(pmu.value);
  });

  it("keeps no message text: the delivery keeps its ids, not what was written", async () => {
    await setup([() => ({ text: "ok" })]);
    await mention("my secret question about Kim");
    const kept = (await db().select().from(inbox).where(eq(inbox.eventType, "event:app_mention")))[0]!;
    expect(kept.body).not.toContain("secret question");
    expect(JSON.parse(kept.body).event).toMatchObject({ type: "app_mention", channel: "C-OPS", user: "U-MONA", text: "" });
    expect(JSON.stringify(await db().select().from(slackAudit))).not.toContain("secret question");
  });

  it("open_alerts and workflow_explain read the routed offer only", async () => {
    await setup([() => ({ calls: [call("open_alerts", {}, "a"), call("workflow_explain", { workflow: "nope" }, "w")] }), () => ({ text: "fine" })]);
    const { raiseAlert } = await import("./outbox");
    await raiseAlert(db(), { offerId: b.offerId, key: "k1", kind: "frequency_cap", message: "held for acme", at: b.clock.now() });
    await raiseAlert(db(), { offerId: b.offers.pmu!, key: "k2", kind: "frequency_cap", message: "held for pmu", at: b.clock.now() });
    await mention("anything broken?");
    const [open, wf] = lastResults(model.seen[1]!.messages);
    expect(open!.value.alerts.map((a: { message: string }) => a.message)).toEqual(["held for acme"]);
    expect(wf!.value.error).toMatch(/no workflow "nope"/);
  });
});
