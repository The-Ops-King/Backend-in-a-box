/**
 * D265 (Tyler: "if the AI thinks it's qualified, and they put DQ, we'll want to be alerted"). Filing the end of day the other way
 * from the AI's read (Set filed DQ or not interested; a close heard filed lost or DQ) is an eod.disagreement event per call; the End of
 * day disagrees with the AI workflow posts it to the alerts channel when the AI was at least 80% sure, once per call (a refiled day edits it).
 */
import { describe, it, expect, beforeAll } from "vitest";
import { DateTime } from "luxon";
import { asOperator, one, many } from "@/db/client";
import { migrate } from "@/db/migrate";
import { encrypt } from "@/engine/crypto";
import { prefill, submitEod, tokenFor, todayFor, disagreements, type EodPrefill, type EodAnswers } from "@/engine/eod";
import { tick } from "@/engine/runner";
import { installTemplateForTest, fakeAdapters, fakeProbes } from "@/engine/test-install";
import { loadCompany } from "@/engine/context";
import type { Adapters } from "@/adapters/types";
import { TAKEN, type CallEntry } from "@/engine/eod-form";

process.env.BINDINGS_KEY ??= Buffer.alloc(32, 7).toString("base64");
const TZ = "America/Phoenix";
const posts: { channel: string; text: string }[] = [], edits: { channel: string; text: string }[] = [];
const base = fakeAdapters();
const fake: Adapters = { ...base, notifier: { ...base.notifier, post: async (_t, channel, text) => { posts.push({ channel, text }); return { ts: `ts${posts.length}` }; }, update: async (_t, channel, _ts, text) => { edits.push({ channel, text }); } } };
const TABLES = ["eod_reports", "crm_records", "slack_posts", "alerts", "sends", "step_effects", "runs", "events", "form_submissions", "forms", "recordings", "payments", "pipeline_cards", "appointments", "opportunities", "contact_identifiers", "contacts", "workflow_triggers", "workflows", "slack_connections", "users", "calendars", "company_terms", "bindings", "poll_cursors", "audit_log"];

const row = (over: Partial<CallEntry>): CallEntry => ({ appointment_id: "a", contact_id: "c", contact: "X", starts_at: "", href_contact: null, recording_url: null, outcome: "", revenue: null, cash: null, next_date: null, next_steps: "", dq_reason: "", dq_note: "", lost_reason: "", about: "", notes: "", extra: {}, ...over });

describe("D265: which filed calls disagree with the AI", () => {
  const pre = (calls: CallEntry[]) => ({ calls }) as unknown as EodPrefill;
  const ans = (calls: CallEntry[]) => ({ calls }) as unknown as EodAnswers;
  it("Set filed DQ or not interested, a close heard filed lost or DQ; nothing else; a call handed off is not checked", () => {
    const p = [
      row({ appointment_id: "t1", kind: "triage", ai_read: { read: "set", confidence: 90 } }),
      row({ appointment_id: "d1", kind: "dial", ai_read: { read: "set", confidence: 85 } }),
      row({ appointment_id: "c1", kind: "closing", ai_read: { read: "closed_won", confidence: 95 } }),
      row({ appointment_id: "c2", kind: "closing", ai_read: { read: "close_pending", confidence: 60 } }),
      row({ appointment_id: "c3", kind: "closing", ai_read: { read: "follow_up", confidence: 99 } }),
      row({ appointment_id: "t2", kind: "triage", ai_read: { read: "set", confidence: 99 } }),
      row({ appointment_id: "c4", kind: "closing" }),
      row({ appointment_id: "c5", kind: "closing", ai_read: { read: "closed_won", confidence: 99 } }),
    ];
    const a = [
      row({ appointment_id: "t1", kind: "triage", outcome: "dq", dq_reason: "Budget", dq_note: "no money" }),
      row({ appointment_id: "d1", kind: "dial", outcome: "not_interested" }),
      row({ appointment_id: "c1", kind: "closing", outcome: "lost", lost_reason: "partner said no" }),
      row({ appointment_id: "c2", kind: "closing", outcome: "dq" }),
      row({ appointment_id: "c3", kind: "closing", outcome: "lost" }),            // the AI heard a follow up: no disagreement
      row({ appointment_id: "t2", kind: "triage", outcome: "follow_up" }),        // a follow up is not negative
      row({ appointment_id: "c4", kind: "closing", outcome: "lost" }),            // no AI read
      row({ appointment_id: "c5", kind: "closing", outcome: TAKEN }),
    ];
    expect(disagreements(pre(p), ans(a), []).map((d) => [d.call.appointment_id, d.ai_label, d.ai_confidence, d.filed_meaning, d.reason])).toEqual([
      ["t1", "Set", 90, "unqualified", "Budget - no money"],
      ["d1", "Set", 85, "lost", ""],
      ["c1", "Closed", 95, "lost", "partner said no"],
      ["c2", "Close pending", 60, "unqualified", ""],
    ]);
  });
});

let co: string, closer: string, ana: string, ben: string;
describe.skipIf(!process.env.DATABASE_URL)("D265: the end of day disagrees with the AI → the alerts channel", () => {
  beforeAll(async () => {
    await migrate();
    await asOperator(async (c) => {
      const old = await one<{ id: string }>(c, "select id from companies where slug='eoddis'");
      if (old) {
        await c.query("delete from run_steps where run_id in (select id from runs where company_id=$1)", [old.id]);
        await c.query("delete from workflow_versions where workflow_id in (select id from workflows where company_id=$1)", [old.id]);
        for (const t of TABLES) await c.query(`delete from ${t} where company_id=$1`, [old.id]);
        await c.query("delete from companies where id=$1", [old.id]);
      }
      co = (await one<{ id: string }>(c, "insert into companies (name, slug, timezone, mode) values ('EOD Dis','eoddis',$1,'live') returning id", [TZ]))!.id;
      await c.query("insert into company_terms (company_id, domain, name, category, is_default, sort) select $1, domain, label, value, true, sort from core_categories", [co]);
      await c.query("insert into bindings (company_id,key,kind,value) values ($1,'slack.channel.alerts','channel',$2)", [co, Buffer.from("CALERTS")]);
      await c.query("insert into slack_connections (company_id, team_id, bot_token, channels) values ($1,'T1',$2,'{}')", [co, encrypt("xoxb-fake")]);
      closer = (await one<{ id: string }>(c, "insert into users (company_id, email, name, role, ghl_user_id) values ($1,'cara@dis.test','Cara Closer','closer','GCARA') returning id", [co]))!.id;
      ana = (await one<{ id: string }>(c, "insert into contacts (company_id, ghl_contact_id, first_name, last_name) values ($1,'GA','Ana','Lopez') returning id", [co]))!.id;
      ben = (await one<{ id: string }>(c, "insert into contacts (company_id, ghl_contact_id, first_name, last_name) values ($1,'GB','Ben','Ruiz') returning id", [co]))!.id;
      const term = (await one<{ id: string }>(c, "select id from company_terms where company_id=$1 and domain='appointment_type' and category='closing'", [co]))!.id;
      const cal = (await one<{ id: string }>(c, "insert into calendars (company_id, external_id, name, appointment_term) values ($1,'CAL','Closer',$2) returning id", [co, term]))!.id;
      const at = (h: number) => DateTime.now().setZone(TZ).startOf("day").set({ hour: h }).toJSDate();
      for (const [who, ext, h, conf] of [[ana, "A1", 1, 0.92], [ben, "B1", 2, 0.6]] as const) {
        const appt = (await one<{ id: string }>(c, "insert into appointments (company_id, contact_id, calendar_id, external_id, starts_at, ends_at, booked_at, status, appointment_term, assigned_user_id) values ($1,$2,$3,$4,$5,$6,now(),'confirmed',$7,$8) returning id", [co, who, cal, ext, at(h), at(h + 1), term, closer]))!.id;
        await c.query("insert into recordings (company_id, contact_id, appointment_id, provider, external_id, title, started_at, share_url, analysis, linked_by, raw) values ($1,$2,$3,'fathom',$4,'Call',$5,$6,$7,'invitee_email','{}')",
          [co, who, appt, `R${ext}`, at(h), `https://fathom.video/share/${ext}`, { outcome: { disposition: { value: "closed_won", confidence: conf } }, notes: { disposition: "closed_won" } }]);
      }
    });
    await asOperator((c) => installTemplateForTest(c, co, "eod-disagreement"));
  });

  it("the AI's read rides on the prefill; filing both lost posts Ana (92% sure) to the alerts channel and not Ben (60%); refiling edits Ana's post", async () => {
    const pre = await asOperator(async (c) => prefill(c, (await loadCompany(c, co)).row, { id: closer, name: "Cara Closer", email: "cara@dis.test" }, todayFor(TZ)));
    expect(pre.calls.map((x) => [x.contact, x.ai_read])).toEqual([["Ana Lopez", { read: "closed_won", confidence: 92 }], ["Ben Ruiz", { read: "closed_won", confidence: 60 }]]);
    const calls = pre.calls.map((x) => ({ ...x, outcome: "lost" as const, lost_reason: x.contact === "Ana Lopez" ? "Partner said no" : "Price", pitched: "Yes", notes: "n" }));
    const answers = { ...pre, calls, closes: 0, cash: 0, revenue: 0, day_answers: {} };
    const token = await asOperator((c) => tokenFor(c, closer));
    expect(await asOperator((c) => submitEod(c, { token, day: todayFor(TZ), answers }))).toEqual(expect.objectContaining({ ok: true }));
    const evs = await asOperator((c) => many<{ contact_id: string; data: Record<string, unknown> }>(c, "select contact_id, data from events where company_id=$1 and event_type='eod.disagreement' order by id", [co]));
    expect(evs.map((e) => [e.contact_id, e.data.ai_confidence, e.data.filed_label, e.data.reason, e.data.filer])).toEqual([[ana, 92, "Lost", "Partner said no", "Cara Closer"], [ben, 60, "Lost", "Price", "Cara Closer"]]);
    await tick(fake, DateTime.now() as DateTime<true>, co, fakeProbes);
    const runs = await asOperator((c) => many<{ contact_id: string; exit_reason: string }>(c, "select contact_id, exit_reason from runs where company_id=$1 order by started_at", [co]));
    expect(new Map(runs.map((r) => [r.contact_id, r.exit_reason]))).toEqual(new Map([[ana, "done"], [ben, "ai_not_sure"]]));
    expect(posts).toEqual([{ channel: "CALERTS", text: `⚠️ *End of day disagrees with the AI*: Ana Lopez (closing call, ${DateTime.now().setZone(TZ).toFormat("ccc LLL d")})\n*Filed by:* Cara Closer\n*AI read:* Closed (92% sure)\n*Filed:* Lost\n*Reason:* Partner said no\n*Recording:* https://fathom.video/share/A1` }]);
    // the same day filed again: Ana's post is edited, not posted twice
    expect(await asOperator((c) => submitEod(c, { token, day: todayFor(TZ), answers }))).toEqual(expect.objectContaining({ ok: true }));
    await tick(fake, DateTime.now() as DateTime<true>, co, fakeProbes);
    expect(posts).toHaveLength(1);
    expect(edits.map((e) => e.channel)).toEqual(["CALERTS"]);
  });
});
