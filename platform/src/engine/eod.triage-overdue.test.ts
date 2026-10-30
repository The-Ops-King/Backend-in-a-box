/** D207: a setter's triage calls left blank past the overdue days are named to the operator, with a link to file the day, where the company turns it on (`eod.triage_overdue`); a call whose Discovery record in GHL already has an outcome is not owed. */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { DateTime } from "luxon";
import { asOperator, one } from "@/db/client";
import { migrate } from "@/db/migrate";
import { encrypt } from "@/engine/crypto";
import { tick } from "@/engine/runner";
import { fakeAdapters, installTemplateForTest } from "@/engine/test-install";
import { tokenFor } from "@/engine/eod";
import type { Adapters, ObjectRecord } from "@/adapters/types";

process.env.BINDINGS_KEY ??= Buffer.alloc(32, 7).toString("base64");
process.env.PUBLIC_URL = "https://engine.test";
const TZ = "America/Phoenix";
const posts: { channel: string; text: string }[] = [];
const records: ObjectRecord[] = [];
const base = fakeAdapters();
const fake: Adapters = { ...base, read: { ...base.read, objectRecords: async (_c, key) => (key === "custom_objects.discovery" ? records : []) },
  notifier: { ...base.notifier, post: async (_t, channel, text) => { posts.push({ channel, text }); return { ts: `ts${posts.length}` }; } } };
let co = "", mitch = "";
const SLUG = `d207-${Date.now()}`;

describe.skipIf(!process.env.DATABASE_URL)("D207: setters' blank triage calls in the operator's ping", () => {
  beforeAll(async () => {
    await migrate();
    await asOperator(async (c) => {
      co = (await one<{ id: string }>(c, "insert into companies (name, slug, timezone, mode) values ('Triage Co',$1,$2,'live') returning id", [SLUG, TZ]))!.id;
      await c.query("insert into company_terms (company_id, domain, name, category, is_default, sort) select $1, domain, label, value, true, sort from core_categories", [co]);
      await c.query("insert into bindings (company_id,key,kind,value) values ($1,'crm.location_id','id',$2),($1,'secret.ghl_pit','secret',$3),($1,'bot.escalate_to','text',$4),($1,'crm.object_discovery_call','text',$5)", [co, Buffer.from("LOC"), encrypt("p"), Buffer.from("UOP"), Buffer.from("custom_objects.discovery")]);
      await c.query("insert into slack_connections (company_id, team_id, bot_token, channels) values ($1,'T1',$2,'{}')", [co, encrypt("xoxb-fake")]);
      mitch = (await one<{ id: string }>(c, "insert into users (company_id, email, name, role, slack_user_id, ghl_user_id) values ($1,'mitch@x.test','Mitch Setter','setter','UMITCH','GM') returning id", [co]))!.id;
      const term = (await one<{ id: string }>(c, "select id from company_terms where company_id=$1 and domain='appointment_type' and category='first_call'", [co]))!.id;
      const cal = (await one<{ id: string }>(c, "insert into calendars (company_id, external_id, name, appointment_term, active) values ($1,'CALT','Strategy',$2,true) returning id", [co, term]))!.id;
      for (const [ext, first, daysAgo] of [["T1", "Blank", 3], ["T2", "Answered", 3], ["T3", "Recent", 1]] as const) {
        const ct = (await one<{ id: string }>(c, "insert into contacts (company_id, ghl_contact_id, first_name, last_name) values ($1,$2,$3,'Lead') returning id", [co, `G${ext}`, first]))!.id;
        const at = DateTime.now().setZone(TZ).minus({ days: daysAgo }).set({ hour: 10, minute: 0 });
        await c.query("insert into appointments (company_id, contact_id, calendar_id, external_id, slot_key, appointment_term, starts_at, ends_at, status, booked_at, assigned_user_id) values ($1,$2,$3,$4,$4,$5,$6,$7,'confirmed',now() - interval '20 days',$8)", [co, ct, cal, ext, term, at.toJSDate(), at.plus({ minutes: 15 }).toJSDate(), mitch]);
      }
    });
    // D255: what is owed is GHL's Discovery Call records alone: whose (setter), when (the label's day, occurred_at's clock), and whether answered (outcome)
    const rec = (id: string, ext: string, first: string, daysAgo: number, outcome: string) => { const at = DateTime.now().setZone(TZ).minus({ days: daysAgo }).set({ hour: 10, minute: 0 }); return { id, createdAt: "", properties: { external_id: ext, outcome, setter: "Mitch Setter", contact_id: `G${ext}`, display_label: `${first} Lead — ${at.toISODate()}`, occurred_at: `${at.toFormat("ccc LLL d")} · 10:00 AM` } }; };
    records.push(rec("R1", "T1", "Blank", 3, "scheduled"), rec("R2", "T2", "Answered", 3, "showed"), rec("R3", "T3", "Recent", 1, "scheduled"));
  });
  beforeEach(() => { posts.length = 0; });
  const evening = async (wf: string) => { const { fireNow } = await import("@/engine/clock"); await asOperator(async (c) => { for (const t of ["run_steps", "sends", "step_effects", "slack_posts"]) await c.query(`delete from ${t} where run_id in (select id from runs where workflow_id=$1)`, [wf]).catch(() => undefined); await c.query("update events set run_id=null where run_id in (select id from runs where workflow_id=$1)", [wf]); await c.query("delete from runs where workflow_id=$1", [wf]); }); await asOperator((c) => fireNow(c, co, wf, "t_evening")); await tick(fake, undefined, co); return posts; };
  let wf = "";

  it("off (an offer that turned it off; on is every offer's default since D239): the setter is reminded, the operator hears nothing", async () => {
    await asOperator((c) => c.query("insert into bindings (company_id,key,kind,value) values ($1,'eod.triage_overdue','text',$2)", [co, Buffer.from("off")]));
    wf = await asOperator((c) => installTemplateForTest(c, co, "eod-reminder", { patch: (d) => { const op = d.nodes.find((x) => x.id === "n_op")!; if (op.type === "slack_post") op.template = "{{user.name}}: {{vars.due.overdue | each:\"<{{item.url}}|{{item.label}}> {{item.names | join}}\" | join:\"; \"}}"; } }));
    const out = await evening(wf);
    expect(out.map((p) => p.channel)).toEqual(["UMITCH"]);
  });

  it("on: the blank one past two days is named to the operator with the setter's link for that day; the one GHL answered and the recent one are not", async () => {
    await asOperator((c) => c.query("update bindings set value=$2 where company_id=$1 and key='eod.triage_overdue'", [co, Buffer.from("on")]));
    const out = await evening(wf);
    const token = await asOperator((c) => tokenFor(c, mitch));
    const d3 = DateTime.now().setZone(TZ).minus({ days: 3 });
    expect(out.find((p) => p.channel === "UOP")?.text).toBe(`Mitch Setter: <https://engine.test/eod/${token}?day=${d3.toISODate()}|${d3.toFormat("ccc LLL d")}> Blank Lead`);
    // the GHL-answered call is no longer owed to the setter either; the blank and the recent ones are
    expect(out.find((p) => p.channel === "UMITCH")?.text).not.toContain("2 calls");
  });
});
