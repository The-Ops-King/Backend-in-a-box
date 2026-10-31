/**
 * D272: PMU's own Setter call logged (installs/pmu/settings/setter-call-logged.v4.definition.json) end to end: the call scored on the
 * offer's rubric, the post with the summary and the fit block, the transcript in its thread, the same recap as a GHL note, and the
 * Discovery Call made blank for the end of day.
 */
import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { asOperator, one } from "@/db/client";
import { migrate } from "@/db/migrate";
import { encrypt } from "@/engine/crypto";
import { installCompany } from "@/engine/install";
import { dispatchEvent, eventMatchContext, workflowTakes, type EventRow } from "@/engine/dispatch";
import { tick } from "@/engine/runner";
import { fakeAdapters } from "@/engine/test-install";
import { findCompanyWorkflow, saveDefinition } from "@/engine/definitions";
import { settingsRows } from "@/engine/settings";
import { recordPhoneCall, settlePhoneCall, phoneFacts } from "@/engine/recordings";
import type { Adapters, CallMedia, Classification } from "@/adapters/types";

const HAS_DB = !!process.env.DATABASE_URL;
process.env.BINDINGS_KEY ??= Buffer.alloc(32, 7).toString("base64");
const TZ = "America/New_York", SLUG = `d272-${Date.now()}`;
const DIR = path.resolve(__dirname, "../../installs/pmu/settings");
const RUBRIC = fs.readFileSync(path.join(DIR, "setter-call-rubric.json"), "utf8"), PROMPT = fs.readFileSync(path.join(DIR, "setter-call-score-prompt.txt"), "utf8");
const V4 = JSON.parse(fs.readFileSync(path.join(DIR, "setter-call-logged.v4.definition.json"), "utf8"));

const posts: { channel: string; text: string; threadTs?: string; ts: string }[] = [];
const notes: { contact: string; body: string }[] = [], records: Record<string, unknown>[] = [];
const scored: { state: Record<string, unknown>; questions: string[] }[] = [];
const media = new Map<string, CallMedia>();
const lvl = (l: number) => ({ probabilities: { 0: l === 0 ? 0.8 : 0.1, 1: l === 1 ? 0.8 : 0.1, 2: l === 2 ? 0.8 : 0.1 }, confidence: 0.9 });
const base = fakeAdapters();
const fake: Adapters = { ...base,
  read: { ...base.read, listUsers: async () => [{ id: "U1", name: "Allan Setter", email: "allan@x.com" }], callMedia: async (_c, id) => media.get(id) ?? { transcript: null },
    getContact: async (_c, id) => (id === "G-ANA" ? { id, firstName: "Ana", lastName: "Lopez", tags: [], customFields: { "F-STRUGGLE": "Slow months", "F-REV": ["5-10k"] }, dateUpdated: "2026-10-30T00:00:00Z", dateAdded: "2026-10-01T00:00:00Z" } : null), objectFields: async () => ["display_label", "external_id", "contact_id", "occurred_at", "direction", "duration_sec", "setter", "outcome", "recording_url"].map((key) => ({ key })) },
  write: { ...base.write, addNote: async (_c, id, body) => { notes.push({ contact: id, body }); }, createRecord: async (_c, o, props) => { records.push({ object: o, ...props }); return { id: `rec-${records.length}` }; } },
  classifier: {
    choice: async (_s, _input, options): Promise<Classification> => options.includes("setting") ? { value: "setting", confidence: 0.95, distribution: { setting: 0.95 }, unclear: false } : { value: "follow_up", confidence: 0.9, distribution: { follow_up: 0.9 }, unclear: false },
    ask: async (_k, state, questions) => { scored.push({ state, questions: Object.keys(questions) });
      return { answers: { biz_fit__discussed: { noul: 0.9 }, biz_fit__score: lvl(2), monthly_rev__discussed: { noul: 0.1 }, monthly_rev__score: lvl(1), problem_goals__discussed: { noul: 0.9 }, problem_goals__score: lvl(2),
        timeline__discussed: { noul: 0.9 }, timeline__score: lvl(1), investment__discussed: { noul: 0.2 }, investment__score: lvl(1), ad_spend__discussed: { noul: 0.1 }, ad_spend__score: lvl(1), decision__discussed: { noul: 0.9 }, decision__score: lvl(2),
        dq_no_revenue: { noul: 0.1 }, dq_magic_button: { noul: 0.1 }, tag_academy: { noul: 0.8 } } }; } },
  analyst: { analyze: async () => { const parsed = { summary: "Ana runs a PMU studio and wants steadier bookings.", notes: { biz_fit: "Owns a PMU studio", timeline: "Wants to start after the holidays", monthly_rev: "Form says 5-10k" } }; return { text: "", parsed, model: "fake", usage: { input: 1, output: 1, cacheRead: 0 } }; } },
  notifier: { ...base.notifier, post: async (_t, channel, text, _as, threadTs) => { const ts = `ts${posts.length + 1}`; posts.push({ channel, text, threadTs, ts }); return { ts }; } },
};
let co = "", contactId = "";

describe.skipIf(!HAS_DB)("D272: PMU's setter call, scored as the Zap scored it", () => {
  beforeAll(async () => {
    await migrate();
    process.env.JEV_API_KEY ??= "jev-fake";
    co = (await installCompany({ name: "D272", slug: SLUG, timezone: TZ, locationId: "LOC", pit: "pit-fake", calendars: { CAL: { term: "closing", booking: "setter" } }, templates: ["setter-call-logged"], enable: true, anthropicKey: "sk-fake",
      crm: { assoc_discovery_call_contact: "ASSOC-DC", field_contact_biggest_struggle: "F-STRUGGLE", field_contact_average_monthly_revenue: "F-REV" }, slack: { setter_calls: "CSET" } }, fake)).companyId;
    await asOperator(async (c) => {
      await c.query("update companies set mode='live', send_window_start='00:00', send_window_end='23:59' where id=$1", [co]);
      await c.query("insert into slack_connections (company_id, team_id, bot_token, bot_user_id, channels) values ($1,'T1',$2,'UBOT','{}')", [co, encrypt("xoxb-fake")]);
      for (const [k, v] of [["prompt.setter_call_rubric", RUBRIC], ["prompt.setter_call_score", PROMPT]])
        await c.query("insert into bindings (company_id,key,kind,value) values ($1,$2,'text',$3) on conflict (company_id,key) do update set value=excluded.value", [co, k, Buffer.from(v)]);
      const w = await findCompanyWorkflow(c, co, "setter-call-logged"); if (!w.ok) throw new Error(w.why);
      const saved = await saveDefinition(c, { workflowId: w.id, definition: V4, note: "PMU v4 (D272)" });
      expect(saved).toMatchObject({ ok: true, saved: true });
      contactId = (await one<{ id: string }>(c, "insert into contacts (company_id, ghl_contact_id, first_name, last_name, timezone, ghl_fields) values ($1,'G-ANA','Ana','Lopez',$2,'{}') returning id",
        [co, TZ]))!.id;
    });
  }, 180000);

  it("the post carries the summary and the fit; the transcript goes in its thread; the GHL note is the same recap in plain text; the Discovery Call is made", async () => {
    const ext = "dial-ana-1", sec = 600;
    media.set(ext, { recordingUrl: "https://ghl.test/ana", transcript: [{ speaker: "0", text: "Hi Ana, it's Allan from Beauty Moguls." }, { speaker: "1", text: "I run a PMU studio and the slow months kill me." }] });
    const started = new Date(Date.now() - 50 * 60e3 - sec * 1000);
    await asOperator(async (c) => {
      const { recording } = await recordPhoneCall(c, co, { externalId: ext, contactId, startedAt: started, durationSec: sec, direction: "outbound", status: "completed", callerGhlUserId: "U1" });
      const { recording: row, event } = await settlePhoneCall(c, recording, media.get(ext)!);
      await dispatchEvent(c, event!, { contact: { id: contactId }, recording: { id: row.id, ...phoneFacts(row) } });
    });
    for (let i = 0; i < 6; i++) await tick(fake, undefined, co);
    const run = await asOperator((c) => one<{ status: string; exit_reason: string }>(c, "select r.status, r.exit_reason from runs r join workflows w on w.id=r.workflow_id where r.contact_id=$1 and w.name='Setter call logged' order by r.started_at desc limit 1", [contactId]));
    expect(run).toMatchObject({ status: "completed", exit_reason: "posted" });

    // Jev was handed the offer, the form answers and the transcript, and asked the rubric's questions
    expect(scored).toHaveLength(1);
    expect(scored[0].state).toMatchObject({ program: expect.stringContaining("Beauty Moguls"), form_answers: { biggest_struggle: "Slow months", average_monthly_revenue: "5-10k" }, call_transcript: expect.stringContaining("slow months kill me") });
    expect(scored[0].questions).toEqual(expect.arrayContaining(["biz_fit__score", "problem_goals__form", "tag_academy"]));

    const [post, thread] = posts;
    expect(post.channel).toBe("CSET");
    // biz 2 + rev 1 (form) + problem 2 + timeline 1 + ad 1 (unknown) + decision 2 + engagement 2 = 11 of 14
    expect(post.text).toContain("_\"Ana runs a PMU studio and wants steadier bookings.\"_");
    expect(post.text).toContain("*Fit Quality: 7.9/10 · Warm* (7 of 8 scored)");
    expect(post.text).toContain(":large_yellow_circle: *Needs review:* setter didn't cover Ad-Spend Capacity");
    expect(post.text).toContain(":label: Academy / adding artists");
    expect(post.text).toContain("Monthly Rev: 1 (form) · Form says 5-10k");
    expect(post.text).toContain("Investment Readiness: N/A");
    expect(thread).toMatchObject({ channel: "CSET", threadTs: post.ts, text: expect.stringContaining("*Transcript*") });
    expect(thread.text).toContain("slow months kill me");

    expect(notes).toHaveLength(1);
    expect(notes[0].contact).toBe("G-ANA");
    expect(notes[0].body).toMatch(/^Setter call scored /);
    expect(notes[0].body).toContain("Fit Quality: 7.9/10 · Warm (7 of 8 scored)");
    expect(notes[0].body).toContain("[YELLOW] Needs review: setter didn't cover Ad-Spend Capacity");
    expect(notes[0].body).not.toMatch(/\*Fit|:label:/);

    expect(records.filter((r) => r.object === "custom_objects.discovery_call")).toHaveLength(1);
  });

  it("the form fields the rubric reads are the offer's settings, bound to its GHL fields (the Settings page and the bindings route offer them)", async () => {
    const rows = await asOperator((c) => settingsRows(c, co));
    expect(rows.filter((r) => r.key.startsWith("crm.field_contact_")).map((r) => ({ key: r.key, required: r.required, set: r.set, usedBy: r.usedBy })))
      .toEqual(expect.arrayContaining([{ key: "crm.field_contact_average_monthly_revenue", required: true, set: true, usedBy: ["Setter call logged"] }, { key: "crm.field_contact_biggest_struggle", required: true, set: true, usedBy: ["Setter call logged"] }]));
  });

  it("a replay matches a phone call with the facts the poll dispatched it with: the workflow takes the call it took live", async () => {
    const r = await asOperator(async (c) => {
      const e = (await one<EventRow>(c, "select * from events where company_id=$1 and event_type='call.logged' order by id limit 1", [co]))!;
      const w = await findCompanyWorkflow(c, co, "setter-call-logged"); if (!w.ok) throw new Error(w.why);
      const ctx = await eventMatchContext(c, e);
      return { recording: ctx.recording, takes: await workflowTakes(c, e, ctx, w.id) };
    });
    expect(r.recording).toMatchObject({ kind: "phone", connected: true });
    expect(r.takes).toBe(true);
  });
});
