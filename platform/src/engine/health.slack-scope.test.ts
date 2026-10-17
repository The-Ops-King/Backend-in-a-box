/** One unreadable Slack channel is one finding, on the slack check, naming the missing permission and every setting that points at it; the steps check does not repeat it once per step (Dating's private ops-test channel was 22 red alerts). */
import { describe, it, expect, beforeAll } from "vitest";
import { asOperator, one } from "@/db/client";
import { migrate } from "@/db/migrate";
import { installCompany } from "@/engine/install";
import { loadCompany } from "@/engine/context";
import { encrypt } from "@/engine/crypto";
import { extractManifest, parseDefinition } from "@/engine/definition";
import { runHealthStep, setProbeRetryMs } from "@/engine/health";
import { fakeAdapters, fakeProbes } from "@/engine/test-install";
import type { Adapters } from "@/adapters/types";

process.env.BINDINGS_KEY ??= Buffer.alloc(32, 7).toString("base64");
let companyId: string;
const base = fakeAdapters();
const fake: Adapters = { ...base, notifier: { ...base.notifier, authTest: async () => ({ ok: true }),
  channelInfo: async (_t, id) => (id === "CPRIV" ? { ok: false, error: "missing_scope", needed: "groups:read" } : id === "CGONE" ? { ok: false, error: "channel_not_found" } : { ok: true, name: id.toLowerCase(), member: true }) } };
const posting = (channel: string) => ({ schema: 1, reentry: "always", premise: { check: "none" }, nodes: [{ id: "t1", type: "trigger", event: "tag.added" }, { id: "s1", type: "slack_post", channel, template: "x" }, { id: "x1", type: "exit", reason: "done" }], edges: [{ from: "t1", to: "s1" }, { from: "s1", to: "x1" }] });

describe.skipIf(!process.env.DATABASE_URL)("health: an unreadable Slack channel is one finding", () => {
  beforeAll(async () => {
    await migrate(); setProbeRetryMs(0);
    await asOperator(async (c) => {
      const co = await one<{ id: string }>(c, "select id from companies where slug='slackscope'");
      if (co) {
        await c.query("delete from run_steps where run_id in (select id from runs where company_id=$1)", [co.id]); await c.query("delete from workflow_versions where workflow_id in (select id from workflows where company_id=$1)", [co.id]);
        for (const t of ["alerts", "audit_log", "health_checks", "sends", "events", "runs", "workflow_triggers", "workflows", "slack_connections", "bindings", "company_terms", "users", "calendars", "poll_cursors"]) await c.query(`delete from ${t} where company_id=$1`, [co.id]);
        await c.query("delete from companies where id=$1", [co.id]);
      }
    });
    companyId = (await installCompany({ name: "Slack Scope", slug: "slackscope", timezone: "America/Phoenix", locationId: "LOC", pit: "pit-fake", calendars: {}, templates: [] }, fake)).companyId;
    await asOperator(async (c) => {
      await c.query("insert into bindings (company_id, key, kind, value) values ($1,'alerts.slack_channel','channel',$2),($1,'slack.channel.deals','channel',$2),($1,'slack.channel.bookings','channel',$2),($1,'slack.channel.calls','channel',$3)", [companyId, Buffer.from("CPRIV"), Buffer.from("CGONE")]);
      await c.query("insert into slack_connections (company_id, team_id, bot_token, channels) values ($1,'T1',$2,'{}')", [companyId, encrypt("xoxb-fake")]);
      for (const [name, channel] of [["Deals post", "{{slack.channel.deals}}"], ["Bookings post", "{{slack.channel.bookings}}"], ["Calls post", "{{slack.channel.calls}}"]]) {
        const def = posting(channel);
        const wf = (await one<{ id: string }>(c, "insert into workflows (company_id, name, reentry_policy, enabled) values ($1,$2,'always',true) returning id", [companyId, name]))!;
        await c.query("insert into workflow_versions (workflow_id, version, definition, manifest) values ($1,1,$2,$3)", [wf.id, def, extractManifest(parseDefinition(def))]);
      }
    });
  });
  const sweep = (checks: Record<string, boolean> = {}) => asOperator(async (c) => { const { row } = await loadCompany(c, companyId); return runHealthStep(c, row, fake, fakeProbes, { checks, min_slots: 0, slots_days: 7 } as never); });

  it("the private channel: one slack finding naming groups:read and the three settings on it; its steps are fine; any other unreadable channel is still said, once", async () => {
    const r = await sweep();
    const bad = r.findings.filter((f) => !f.ok && (f.check === "slack" || f.check === "steps"));
    expect(bad.map((f) => `${f.check}:${f.item}`).sort()).toEqual(["slack:CGONE", "slack:CPRIV"]);
    expect(bad.find((f) => f.item === "CPRIV")!.text).toBe("Channel CPRIV, used by 3 settings (alerts.slack_channel, slack.channel.deals, slack.channel.bookings), cannot be checked: the Slack app is missing the groups:read permission (the channel is private). Add it under OAuth & Permissions and reinstall the app. Posts there may still land.");
    expect(bad.find((f) => f.item === "CGONE")!.text).toBe("Channel for slack.channel.calls (CGONE) cannot be read: channel_not_found.");
    expect(r.findings.filter((f) => f.check === "steps" && f.ok && /dependencies verified/.test(f.text)).map((f) => f.text.split(":")[0]).sort()).toEqual(['"Bookings post"', '"Calls post"', '"Deals post"']);
  });

  it("with the slack check off, the steps check still says each unreadable channel", async () => {
    const r = await sweep({ slack: false });
    expect(r.findings.filter((f) => !f.ok && f.check === "steps").map((f) => f.text).sort()).toEqual([
      '"Bookings post": step s1: channel slack.channel.bookings (CPRIV) cannot be read: missing_scope.', '"Calls post": step s1: channel slack.channel.calls (CGONE) cannot be read: channel_not_found.', '"Deals post": step s1: channel slack.channel.deals (CPRIV) cannot be read: missing_scope.']);
  });
});
