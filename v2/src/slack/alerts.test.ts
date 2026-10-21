import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { closeDb, db } from "@/db/client";
import { alerts, connections, slackAlertState } from "@/db/schema";
import { announceAlerts } from "./alerts";
import { setPlatformSetting } from "./data";
import { raiseAlert } from "./outbox";
import { type Bench, slackBench } from "./testkit";

/**
 * Alerts as platform behavior: raised is a post in the offer's alerts channel; still open is a reply in its thread every
 * N minutes, only in the operator's working hours, after its cause is checked again; resolved is a reply and a ✅. N and
 * the hours are platform settings in the database. An alert of no offer goes to the operator's channel.
 */
describe.skipIf(!process.env.DATABASE_URL)("alerts in Slack", () => {
  afterAll(closeDb);
  let b: Bench;
  // 16:00Z is 09:00 in Arizona (the seeded working day 07:00-17:00, America/Phoenix)
  beforeEach(async () => {
    b = await slackBench({ start: "2026-10-26T16:00:00Z", offers: [{ slug: "acme", settings: { "slack.channel.alerts": "C-ALERTS" } }, { slug: "pmu" }] });
    await b.workspace();
    await b.workspace({ teamId: "T-OPS", offers: [] });
    await b.channel("acme", "C-ALERTS", ["alerts"]);
    await setPlatformSetting(db(), "slack.operator_channel", { team_id: "T-OPS", channel: "C-TYLER" }, "test");
  });
  const sweep = async () => { const r = await announceAlerts(b.app); await b.drain(); return r; };
  const authAlert = async (offer = b.offerId) => {
    await db().insert(connections).values({ offerId: offer, port: "crm", status: "paused_auth", reason: "x", pausedAt: b.clock.now() }).onConflictDoNothing();
    return (await raiseAlert(db(), { offerId: offer, key: "auth:crm", kind: "connection_auth", message: "The crm connection refused its token", at: b.clock.now() })).id;
  };
  const top = (channel: string) => [...b.fake.messages.values()].filter((m) => m.channel === channel && !m.threadTs);
  const thread = (channel: string) => { const t = top(channel)[0]!; return [...b.fake.messages.values()].filter((m) => m.threadTs === t.ts).map((m) => m.text); };

  it("raised: one post in the offer's alerts channel, with Retry, Resolve and Pause, said once however often it is raised again", async () => {
    await authAlert();
    await authAlert();
    expect((await sweep()).raised).toBe(1);
    await sweep();
    const posts = top("C-ALERTS");
    expect(posts).toHaveLength(1);
    expect(posts[0]!.text).toMatch(/^🔴 Token rejected: The crm connection refused its token/);
    expect(b.fake.ok("chat.postMessage")[0]!.token).toBe("xoxb-T1");
    expect((await db().select().from(alerts))).toHaveLength(1);
    expect((await db().select().from(slackAlertState))[0]).toMatchObject({ channel: "C-ALERTS", ts: posts[0]!.ts, saidCount: 1 });
  });

  it("an alert of no offer, or of an offer with no alerts channel, goes to the operator's channel", async () => {
    await raiseAlert(db(), { offerId: null, key: "worker-down", kind: "worker_down", message: "The worker has not run for 10 minutes", at: b.clock.now() });
    await authAlert(b.offers.pmu);
    await sweep();
    const ops = top("C-TYLER");
    expect(ops.map((m) => m.text.split(":")[0])).toEqual(["🔴 Alert", "🔴 pmu"]);
    expect(b.fake.ok("chat.postMessage").every((c) => c.token === "xoxb-T-OPS")).toBe(true);
    expect(top("C-ALERTS")).toHaveLength(0);
  });

  it("still open: said again in its thread every N minutes, its cause checked first", async () => {
    await authAlert();
    await sweep();
    b.clock.advance("59m"); await sweep();
    expect(thread("C-ALERTS")).toEqual([]);
    b.clock.advance("1m"); await sweep();
    expect(thread("C-ALERTS")).toEqual(["⏰ Still open (1 hour): The crm connection refused its token"]);
    b.clock.advance("60m"); await sweep();
    expect(thread("C-ALERTS")).toHaveLength(2);
  });

  it("N is the platform's setting in the database", async () => {
    await setPlatformSetting(db(), "alerts.repeat_minutes", 30, "test");
    await authAlert();
    await sweep();
    b.clock.advance("30m"); await sweep();
    expect(thread("C-ALERTS")).toHaveLength(1);
  });

  it("only inside the operator's working hours (a platform setting): what falls due at night is said when the day opens", async () => {
    b.clock.set("2026-10-26T23:30:00Z");   // 16:30 in Arizona
    await authAlert();
    await sweep();
    b.clock.set("2026-10-27T00:31:00Z"); await sweep();   // 17:31: the day is over
    b.clock.set("2026-10-27T09:00:00Z"); await sweep();   // 02:00
    expect(thread("C-ALERTS")).toEqual([]);
    b.clock.set("2026-10-27T14:00:00Z"); await sweep();   // 07:00
    expect(thread("C-ALERTS")).toHaveLength(1);
    await setPlatformSetting(db(), "alerts.repeat_hours", "00:00-23:59", "test");
    b.clock.set("2026-10-28T09:00:00Z"); await sweep();
    expect(thread("C-ALERTS")).toHaveLength(2);
  });

  it("a cause found gone when checked closes the alert: the ✅ instead of a repeat", async () => {
    await authAlert();
    await sweep();
    await db().update(connections).set({ status: "ok" });
    b.clock.advance("1h");
    expect((await sweep()).checkedFixed).toBe(1);
    expect(thread("C-ALERTS")).toEqual(["✅ Resolved (open for 1 hour)"]);
    expect(top("C-ALERTS")[0]!.reactions).toEqual(["white_check_mark"]);
    expect((await db().select().from(alerts))[0]!.resolvedAt).not.toBeNull();
  });

  it("an alert only a person can call over is said once and kept open, never repeated", async () => {
    await raiseAlert(db(), { offerId: b.offerId, key: "failed:9", kind: "outbox_failed", message: "slack.ask for step q1 failed", at: b.clock.now() });
    await sweep();
    b.clock.advance("1h"); await sweep();
    b.clock.advance("1h"); await sweep();
    expect(thread("C-ALERTS")).toEqual([]);
    expect((await db().select().from(slackAlertState))[0]!.quiet).toBe(true);
    await db().update(alerts).set({ resolvedAt: b.clock.now() });
    await sweep();
    expect(thread("C-ALERTS")).toEqual(["✅ Resolved (open for 2 hours)"]);
  });

  it("resolved: a reply and a ✅ on the original, once; resolved before it was ever said, nothing", async () => {
    const id = await authAlert();
    await sweep();
    await db().update(alerts).set({ resolvedAt: b.clock.now() }).where(eq(alerts.id, id));
    await sweep(); await sweep();
    expect(thread("C-ALERTS")).toEqual(["✅ Resolved (open for 1 min)"]);
    const quiet = await raiseAlert(db(), { offerId: b.offerId, key: "other", kind: "frequency_cap", message: "held", at: b.clock.now() });
    await db().update(alerts).set({ resolvedAt: b.clock.now() }).where(eq(alerts.id, quiet.id));
    await sweep();
    expect(top("C-ALERTS")).toHaveLength(1);
  });

  it("a paused alert is still checked: it closes with its ✅ once the cause is gone", async () => {
    const id = await authAlert();
    await sweep();
    await db().update(slackAlertState).set({ pausedAt: b.clock.now(), pausedBy: "x" }).where(eq(slackAlertState.alertId, id));
    b.clock.advance("2h"); await sweep();
    expect(thread("C-ALERTS")).toEqual([]);
    await db().update(connections).set({ status: "ok" });
    b.clock.advance("1h"); await sweep();
    expect(thread("C-ALERTS")).toEqual(["✅ Resolved (open for 3 hours)"]);
  });

  it("with no channel at all (no alerts channel, no operator channel) it stays on the dashboard", async () => {
    await setPlatformSetting(db(), "slack.operator_channel", {}, "test");
    await authAlert(b.offers.pmu);
    expect((await sweep()).raised).toBe(0);
    expect(b.fake.ok("chat.postMessage")).toHaveLength(0);
  });

  it("an alert about a failed alert post is kept off Slack, so a broken Slack does not feed itself", async () => {
    b.fake.failNext({ method: "chat.postMessage", error: "channel_not_found" });
    await authAlert();
    await sweep();
    const all = await db().select().from(alerts).orderBy(alerts.id);
    expect(all.map((a) => a.kind)).toEqual(["connection_auth", "outbox_failed"]);
    expect(all[1]!.detail).toMatchObject({ slackSilent: true });
    b.clock.advance("1h"); await sweep();
    expect(b.fake.calls.filter((c) => c.method === "chat.postMessage")).toHaveLength(1);
  });
});
