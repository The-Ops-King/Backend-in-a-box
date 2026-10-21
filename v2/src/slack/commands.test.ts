import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closeDb, db } from "@/db/client";
import { slackAudit } from "@/db/schema";
import { chain, flow } from "@/test/harness";
import { setPlatformSetting } from "./data";
import { type Bench, slackBench } from "./testkit";

/**
 * Slash commands, answered from the metric layer (Hair's definitions here, as test data) and the engine, after the ack,
 * privately; routed to the channel's offer, else an offer named in the text, else the person's only offer, else a
 * picker; each with its role rule. Which commands an offer has is its config (slack.commands).
 */
const HAIR = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../offers/hair/reports.json"), "utf8")) as Record<string, unknown>;
const NY = "America/New_York";
const COMMANDS = {
  enabled: ["mtd", "weekly", "monthly", "show-rate", "close-rate", "cash", "leads", "closes", "leaderboard", "availability", "support", "agreement"],
  summary: ["leads", "booked", "show_rate", "close_rate", "cash_collected"],
  metric: { "show-rate": "show_rate", "close-rate": "close_rate", cash: "cash_collected", leads: "leads", closes: "closes" },
  leaderboard: "reports.leaderboard", availability: "reports.availability",
};
const SETTINGS = { "slack.channel.ops": "C-OPS", "payments.contract_value": 2999, "calls.reached_seconds": 60, "slack.commands": COMMANDS };
const agreementWf = flow("send-agreement", [
  { id: "t1", type: "trigger@1", title: "Asked in Slack", on: { event: "agreement.requested" } },
  { id: "a1", type: "action@1", title: "Send", action: "esign.send", params: { template: "tpl-1" } },
  { id: "x1", type: "end@1", title: "Done", reason: "done" },
], chain("t1", "a1", "x1"));

describe.skipIf(!process.env.DATABASE_URL)("slash commands", () => {
  afterAll(closeDb);
  let b: Bench;
  const vendor = { vendorReport: async (_o: string, x: { params: Record<string, unknown> }) => ({ body: `Open slots, next ${String(x.params.days)} days: Luis 4` }) };
  beforeEach(async () => {
    b = await slackBench({ start: "2026-10-26T12:00:00Z", reads: vendor, offers: [
      { slug: "acme", name: "Acme", zone: NY, settings: SETTINGS, reports: HAIR, workflows: [agreementWf] },
      { slug: "pmu", name: "PMU", zone: NY, settings: { ...SETTINGS, "slack.commands": { ...COMMANDS, enabled: ["mtd"] } }, reports: HAIR },
      { slug: "bare", name: "Bare", zone: NY },
    ] });
    await b.workspace();
    await b.channel("acme", "C-OPS", ["ops"]);
    await b.channel("pmu", "C-PMU", ["ops"]);
    await b.person("acme", { id: "u1", name: "Luis Ortega", roles: ["closer"], crm: "U-L", slack: "U-LUIS" });
    await b.person("acme", { id: "u2", name: "Ana Diaz", roles: ["closer"], crm: "U-A" });
    await b.person("acme", { id: "m1", name: "Mona Manager", roles: ["manager"], slack: "U-MONA" });
    await b.person("acme", { id: "s1", name: "Mia Setter", roles: ["setter"], slack: "U-MIA" });
    await b.person("pmu", { id: "m1", name: "Mona Manager", roles: ["manager"], slack: "U-MONA" });
    await b.person("bare", { id: "z1", name: "Zed", roles: ["owner"], slack: "U-ZED" });
    const at = (t: string) => b.clock.set(`2026-10-26T${t}:00Z`);
    at("14:00"); await b.ingest("acme", "lead.created", { contact: "c1", payload: { contact: { name: "Kim Lee", email: "kim@example.com", source: "Facebook ads" } } });
    at("15:00"); await b.ingest("acme", "lead.created", { contact: "c2", payload: { contact: { name: "Bo Park", source: "Google" } } });
    at("14:30");
    await b.ingest("acme", "appointment.booked", { contact: "c1", appointment: "a1", payload: { appointment: { starts_at: "2026-10-26T17:00:00Z", term: { category: "closing" }, self_booked: true, closer: { ghl_user_id: "U-L" } } } });
    await b.ingest("acme", "appointment.booked", { contact: "c2", appointment: "a2", payload: { appointment: { starts_at: "2026-10-26T18:00:00Z", term: { category: "closing" }, set_by: "Mia", closer: { ghl_user_id: "U-A" } } } });
    await b.ingest("acme", "appointment.booked", { contact: "c2", appointment: "a3", payload: { appointment: { starts_at: "2026-10-29T18:00:00Z", term: { category: "closing" }, set_by: "Mia", closer: { ghl_user_id: "U-A" } } } });
    at("18:00"); await b.ingest("acme", "appointment.outcome", { contact: "c1", appointment: "a1", payload: { outcome: "showed", call_outcome: "closed" } });
    at("19:00"); await b.ingest("acme", "appointment.outcome", { contact: "c2", appointment: "a2", payload: { outcome: "noshow" } });
    at("19:30"); await b.ingest("acme", "payment.received", { contact: "c1", payload: { payment_id: "p1", amount: 2999 } });
    await b.ingest("acme", "deal.won", { contact: "c1", deal: "d1", payload: {} });
    at("20:00"); await b.ingest("acme", "payment.received", { contact: "c2", payload: { payment_id: "p2", amount: 500 } });
    at("21:00"); await b.ingest("acme", "payment.refunded", { contact: "c2", payload: { payment_id: "p3", amount: 100, refund_of: "p2" } });
    at("23:00");
  });
  const run = async (command: string, text: string, user: string, channel = "C-OPS") => {
    const r = await b.command(command, text, { user, channel });
    expect(r.status).toBe(200);
    await b.drain();
    return b.fake.bodies("response_url").at(-1) as { text: string; blocks?: unknown[]; response_type: string } | undefined;
  };

  it("/mtd: the month so far from the offer's summary metrics, privately, with the period and how each number is worked out", async () => {
    const r = (await run("/mtd", "", "U-LUIS"))!;
    expect(r.response_type).toBe("ephemeral");
    expect(r.text).toContain("Month to date · Oct 1–26");
    for (const line of ["Leads", "Bookings made", "Show rate", "Close rate", "Cash collected"]) expect(r.text).toContain(line);
    expect(r.text).toMatch(/Leads\s+2/);
    expect(r.text).toMatch(/Show rate\s+50%/);
    expect(r.text).toMatch(/Close rate\s+100%/);
    expect(r.text).toMatch(/Cash collected\s+\$3,399/);
    const ctx = JSON.stringify(r.blocks);
    expect(ctx).toContain("2026-10-01 to 2026-10-26, America/New_York");
    expect(ctx).toContain("`show_rate`: shows ÷ calls_due");
    expect(ctx).toContain("`leads`: daily count of leads");
    expect((await run("/mtd", "last month", "U-LUIS"))!.text).toMatch(/always month to date/);
  });

  it("/weekly and /monthly: last week and last month by default, or this one", async () => {
    expect((await run("/weekly", "", "U-LUIS"))!.text).toContain("Last week · Oct 19–25");
    expect((await run("/weekly", "this week", "U-LUIS"))!.text).toMatch(/This week · Oct 26[\s\S]*Leads\s+2/);
    expect((await run("/monthly", "", "U-LUIS"))!.text).toContain("Last month · Sep 1–30");
    expect((await run("/monthly", "next year", "U-LUIS"))!.text).toMatch(/couldn't read "next year"/);
  });

  it("/show-rate, /close-rate, /cash, /leads, /closes: one metric, split by closer or source when asked", async () => {
    expect((await run("/show-rate", "", "U-MIA"))!.text).toMatch(/Show rate \(1\/2\)\s+50%/);
    expect((await run("/close-rate", "today", "U-MIA"))!.text).toMatch(/Close rate \(1\/1\)\s+100%/);
    const cash = (await run("/cash", "by closer", "U-MIA"))!.text;
    expect(cash).toMatch(/Cash collected by closer/);
    expect(cash).toMatch(/Luis Ortega\s+\$2,999[\s\S]*Ana Diaz\s+\$400/);
    expect((await run("/leads", "this week by source", "U-MIA"))!.text).toMatch(/Facebook ads\s+1[\s\S]*Google\s+1/);
    expect((await run("/closes", "", "U-MIA"))!.text).toMatch(/Closes\s+1/);
    expect((await run("/cash", "by the moon", "U-MIA"))!.text).toMatch(/couldn't read/);
  });

  it("/leaderboard renders the offer's leaderboard definition; /availability its vendor report for N days", async () => {
    expect((await run("/leaderboard", "", "U-LUIS"))!.text).toMatch(/🏆 \*Leaderboard\*[\s\S]*1\. Luis\s+\$2,999/);
    expect((await run("/availability", "3", "U-LUIS"))!.text).toContain("Open slots, next 3 days: Luis 4");
    expect((await run("/availability", "", "U-LUIS"))!.text).toContain("next 7 days");
    expect((await run("/availability", "soon", "U-LUIS"))!.text).toMatch(/number of days/);
  });

  it("/support opens a ticket in the operator's channel and says so", async () => {
    await b.workspace({ teamId: "T-OPS", offers: [] });
    await setPlatformSetting(db(), "slack.operator_channel", { team_id: "T-OPS", channel: "C-TYLER" }, "test");
    expect((await run("/support", "the wrap-up didn't post", "U-MIA"))!.text).toBe("Got it. It's with Tyler.");
    const ticket = b.fake.ok("chat.postMessage").at(-1)!;
    expect(ticket.token).toBe("xoxb-T-OPS");
    expect(ticket.body.channel).toBe("C-TYLER");
    expect(ticket.body.text).toMatch(/Support request · Acme.*<@U-MIA>.*the wrap-up didn't post/);
    expect((await run("/support", "", "U-MIA"))!.text).toMatch(/Say what's wrong/);
  });

  it("/help lists only the commands this offer has on; /team only for the operator", async () => {
    const acme = (await run("/help", "", "U-MIA"))!.text;
    expect(acme).toContain("*Commands for Acme*");
    expect(acme).toContain("`/cash`");
    expect(acme).not.toContain("`/team`");
    const pmu = (await run("/help", "", "U-MONA", "C-PMU"))!.text;
    expect(pmu).toContain("`/mtd`");
    expect(pmu).not.toContain("`/cash`");
    await b.operator("U-MONA");
    expect((await run("/help", "", "U-MONA", "C-PMU"))!.text).toContain("`/team`");
  });

  it("a command the offer has not turned on, an offer with no command setup, and an unknown command each answer helpfully", async () => {
    expect((await run("/cash", "", "U-MONA", "C-PMU"))!.text).toBe("`/cash` isn't turned on for PMU. `/help` lists what is.");
    expect((await run("/mtd", "", "U-ZED", "D-ZED"))!.text).toMatch(/aren't set up for this offer yet/);
    expect((await run("/help", "", "U-ZED", "D-ZED"))!.text).toMatch(/aren't set up for this offer yet/);
    expect((await run("/frobnicate", "", "U-MIA"))!.text).toBe("I don't know /frobnicate. Try `/help` for what I can do.");
  });

  it("someone not on the offer's team is refused, and the refusal is recorded", async () => {
    expect((await run("/mtd", "", "U-STRANGER"))!.text).toBe("Only someone on this offer's team can do that.");
    expect((await db().select().from(slackAudit)).filter((a) => a.action === "slack.refused")).toMatchObject([{ userId: "U-STRANGER", detail: { command: "mtd" } }]);
  });

  describe("routing", () => {
    it("in a mapped channel: the channel's offer, whatever the text names", async () => {
      expect((await run("/mtd", "", "U-MONA", "C-PMU"))!.text).toMatch(/Leads\s+—|Leads\s+0/);
      expect((await run("/mtd", "", "U-MONA", "C-OPS"))!.text).toMatch(/Leads\s+2/);
    });
    it("in a DM: an offer named first (`/mtd acme`), one the person is on; else their only offer; else a picker", async () => {
      expect((await run("/mtd", "acme", "U-MONA", "D-MONA"))!.text).toMatch(/Leads\s+2/);
      expect((await run("/mtd", "pmu", "U-MIA", "D-MIA"))!.text).toBe("You're not on PMU's team in this workspace.");
      expect((await run("/mtd", "", "U-MIA", "D-MIA"))!.text).toMatch(/Leads\s+2/);
      const pick = (await run("/mtd", "", "U-MONA", "D-MONA"))!;
      expect(pick.text).toBe("Which offer is `/mtd` for?");
      const buttons = (pick.blocks as { type: string; elements?: { text: { text: string }; value: string; action_id: string }[] }[]).find((x) => x.type === "actions")!.elements!;
      expect(buttons.map((x) => x.text.text)).toEqual(["Acme", "PMU"]);
      // someone else pressing the asker's picker changes nothing; the asker's press runs it for that offer
      const press = (user: string) => b.interaction({ type: "block_actions", team: { id: "T1" }, user: { id: user }, channel: { id: "D-MONA" }, response_url: "https://hooks.slack.com/actions/p", trigger_id: `t-${user}`, actions: [{ action_id: "pick", value: buttons[0]!.value, action_ts: `9.${user}` }] });
      await press("U-MIA"); await b.drain();
      expect(b.results.at(-1)).toBe("not theirs");
      await press("U-MONA"); await b.drain();
      expect(String((b.fake.bodies("response_url").at(-1) as { text: string }).text)).toMatch(/Leads\s+2/);
    });
    it("someone on no offer in this workspace is told so", async () => {
      expect((await run("/mtd", "", "U-NOBODY", "D-NOBODY"))!.text).toMatch(/don't know you on any offer/);
    });
  });

  describe("/team (the operator)", () => {
    it("lists the team; adds and removes a person by facts, confirming their Slack user; anyone else is refused", async () => {
      expect((await run("/team", "", "U-MONA"))!.text).toBe("Only the operator can do that.");
      await b.operator("U-TYLER");
      const list = (await run("/team", "", "U-TYLER"))!.text;
      expect(list).toContain("*Acme's team*");
      expect(list).toContain("• Luis Ortega: closer (<@U-LUIS>)");
      expect(list).toContain("• Ana Diaz: closer (not linked in Slack)");
      expect((await run("/team", "add <@UNEW|newbie> setter,closer Nia New", "U-TYLER"))!.text).toBe("Added <@UNEW> to Acme as setter,closer.");
      expect(await b.store.tx((tx) => tx.projGet("people", b.offerId, "slack-T1-UNEW"))).toMatchObject({ name: "Nia New", roles: ["setter", "closer"], active: true, slackUserId: "UNEW" });
      expect((await run("/mtd", "", "UNEW"))!.text).toMatch(/Leads\s+2/);
      expect((await run("/team", "remove <@UNEW>", "U-TYLER"))!.text).toBe("Removed <@UNEW> from Acme's team.");
      expect((await run("/mtd", "", "UNEW"))!.text).toBe("Only someone on this offer's team can do that.");
      expect((await run("/team", "promote everyone", "U-TYLER"))!.text).toMatch(/`\/team add @person/);
    });
  });

  describe("/agreement", () => {
    it("owner, manager, or the closer on that contact's deal; a setter is refused", async () => {
      expect((await run("/agreement", "kim@example.com", "U-MIA"))!.text).toBe("Only an owner, a manager or the closer on that deal can do that.");
      const asked = (await run("/agreement", "<mailto:kim@example.com|kim@example.com>", "U-MONA"))!;
      expect(asked.text).toMatch(/Send an agreement\?.*Kim Lee/);
      expect((await run("/agreement", "nobody@example.com", "U-MONA"))!.text).toMatch(/No one on Acme matches/);
    });

    it("Send records the request as a fact the offer's agreement workflow takes (the send goes through its gate); Cancel sends nothing", async () => {
      const asked = (await run("/agreement", "kim@example.com", "U-MONA"))!;
      const buttons = (asked.blocks as { type: string; elements?: { action_id: string; value: string }[] }[]).find((x) => x.type === "actions")!.elements!;
      const press = (id: string, user = "U-MONA") => b.interaction({ type: "block_actions", team: { id: "T1" }, user: { id: user }, channel: { id: "C-OPS" }, response_url: "https://hooks.slack.com/actions/a", trigger_id: `t-${id}-${user}`, actions: [{ action_id: id, value: buttons.find((x) => x.action_id === id)!.value, action_ts: `5.${id}.${user}` }] });
      await press("agreement_cancel"); await b.drain();
      expect(b.fake.bodies("response_url").at(-1)).toMatchObject({ replace_original: true, text: "Cancelled by <@U-MONA>. Nothing sent." });
      await press("agreement_send", "U-MIA"); await b.drain();
      expect(String((b.fake.bodies("response_url").at(-1) as { text: string }).text)).toBe("Only an owner, a manager or the closer on that deal can do that.");
      await press("agreement_send"); await b.drain();
      expect(String((b.fake.bodies("response_url").at(-1) as { text: string }).text)).toBe("📨 Requested by <@U-MONA>: send-agreement sends Kim Lee's agreement.");
      const fact = (await b.store.tx((tx) => tx.events({ offerId: b.offerId, types: ["agreement.requested"] })))[0]!;
      expect(fact).toMatchObject({ contactId: "c1", source: "slack", payload: { by: "m1", by_slack_user: "U-MONA" } });
      expect(b.fp.calls.filter((c) => c.port === "esign" && c.ok)).toHaveLength(1);
    });

    it("the closer on the contact's deal may ask", async () => {
      expect((await run("/agreement", "kim@example.com", "U-LUIS"))!.text).toBe("Only an owner, a manager or the closer on that deal can do that.");
      await b.ingest("acme", "card.moved", { contact: "c1", payload: { deal_id: "card-1", pipeline: "closer", to_stage: "won", owner: "U-L" } });
      expect((await b.store.tx((tx) => tx.projFind("deals", b.offerId, { where: { contactId: "c1" } }))).some((d) => d.ownerKey === "crm:U-L")).toBe(true);
      expect((await run("/agreement", "kim@example.com", "U-LUIS"))!.text).toMatch(/Send an agreement\?/);
    });

    it("an offer with no workflow that takes the request is told so, and nothing is recorded", async () => {
      await b.store.tx((tx) => tx.setSetting(b.offers.pmu!, "slack.commands", { ...COMMANDS, enabled: ["agreement"] }, "test"));
      await b.ingest("pmu", "lead.created", { contact: "c9", payload: { contact: { name: "Pat", email: "pat@example.com" } } });
      const asked = (await run("/agreement", "pat@example.com", "U-MONA", "C-PMU"))!;
      const send = (asked.blocks as { type: string; elements?: { action_id: string; value: string }[] }[]).find((x) => x.type === "actions")!.elements!.find((x) => x.action_id === "agreement_send")!;
      await b.interaction({ type: "block_actions", team: { id: "T1" }, user: { id: "U-MONA" }, channel: { id: "C-PMU" }, response_url: "https://hooks.slack.com/actions/n", trigger_id: "t-n", actions: [{ action_id: "agreement_send", value: send.value, action_ts: "6.1" }] });
      await b.drain();
      expect(String((b.fake.bodies("response_url").at(-1) as { text: string }).text)).toBe("This offer has no workflow that sends an agreement on request yet, so nothing was sent.");
      expect(await b.store.tx((tx) => tx.events({ offerId: b.offers.pmu!, types: ["agreement.requested"] }))).toHaveLength(0);
    });

    it("with nothing after it, the form opens at once (inside Slack's three seconds), and its submission requests the agreement", async () => {
      const r = await b.command("/agreement", "", { user: "U-MONA", channel: "C-OPS", trigger: "trig-ag" });
      expect(r.status).toBe(200);
      const view = b.fake.ok("views.open")[0]!.body as { trigger_id: string; view: { callback_id: string; private_metadata: string } };
      expect(view.trigger_id).toBe("trig-ag");
      expect(view.view.callback_id).toBe("agreement_form");
      expect(b.queue).toHaveLength(0);
      const submit = (contact: string) => b.interaction({ type: "view_submission", team: { id: "T1" }, user: { id: "U-MONA" }, view: { id: `V-${contact}`, hash: "h", callback_id: "agreement_form", private_metadata: view.view.private_metadata, state: { values: { who: { contact: { selected_option: { value: contact } } } } } } });
      expect(await (await submit("c-none")).json()).toEqual({ response_action: "errors", errors: { who: "Pick a contact from the list." } });
      expect((await submit("c1")).status).toBe(200);
      await b.drain();
      expect(await b.store.tx((tx) => tx.events({ offerId: b.offerId, types: ["agreement.requested"] }))).toHaveLength(1);
      expect(b.fake.ok("chat.postMessage").at(-1)!.body.text).toMatch(/Requested by <@U-MONA>/);
    });
  });
});
