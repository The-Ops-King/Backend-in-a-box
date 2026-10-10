/** Slack posts (D31): who they appear from (name + one of several icons), @mentions for the closer and setter, and a scorecard that lands in the call post's thread. */
import { describe, it, expect, beforeAll } from "vitest";
import { asOperator, one, many } from "@/db/client";
import { migrate } from "@/db/migrate";
import { encrypt } from "@/engine/crypto";
import { parseDefinition, extractManifest, indexDefinition } from "@/engine/definition";
import { emitEvent, dispatchEvent } from "@/engine/dispatch";
import { tick } from "@/engine/runner";
import { pickIcon } from "@/adapters/slack/notifier";
import type { Adapters, BookingRead, SlackPersona } from "@/adapters/types";

process.env.BINDINGS_KEY ??= Buffer.alloc(32, 7).toString("base64");
const posts: { channel: string; text: string; as?: SlackPersona; threadTs?: string }[] = [];
const fake: Adapters = {
  read: { contactsChangedSince: async () => [], openCards: async () => [], inboundSince: async () => [], callMedia: async () => null, contactsAddedBetween: async () => [], callsBetween: async () => [], wonOpportunities: async () => [], objectRecords: async () => [], documents: async () => [], opportunitiesSince: async () => [], pipelineCards: async () => [], getContact: async () => null, listUsers: async () => [] },
  booking: (() => { const b: BookingRead = { appointmentsInWindow: async () => [], getAppointment: async () => null, listCalendars: async () => [] }; return { ghl: b, calendly: b }; })(),
  write: { createContact: async () => ({ id: "x" }), addTag: async () => {}, removeTag: async () => {}, addNote: async () => {}, updateAppointment: async () => {}, updateContact: async () => {}, createTask: async () => ({ id: "t" }), createRecord: async () => ({ id: "r" }), updateRecord: async () => {}, relateRecords: async () => {}, createOpportunity: async () => ({ id: "o" }), updateOpportunity: async () => {}, sendDocumentTemplate: async () => ({ id: "d" }) },
  sender: { sendSms: async () => ({ externalId: "s", accepted: true }), sendEmail: async () => ({ externalId: "e", accepted: true }), deliveryStatus: async () => ({ status: "sent" }), sendEmailTemplate: async () => ({ externalId: "t", accepted: true }), smsTemplateBody: async () => null },
  classifier: { choice: async () => ({ value: "confirmed", confidence: 1, distribution: {}, unclear: false }) },
  notifier: { post: async (_t, channel, text, as, threadTs) => { posts.push({ channel, text, as, threadTs }); return { ts: `ts${posts.length}` }; }, lookupUserByEmail: async (_t, email) => (email === "allan@hair.test" ? "UALLAN" : email === "luis@hair.test" ? "ULUIS" : null), react: async () => true, unreact: async () => true, authTest: async () => ({ ok: true }), channelInfo: async () => ({ ok: true, member: true }) },
  analyst: { analyze: async () => ({ text: "Well done Allan, that is a fast one.", parsed: {}, model: "fake", usage: { input: 0, output: 0, cacheRead: 0 } }) },
};
const LINK = "<https://app.gohighlevel.com/v2/location/{{crm.location_id}}/contacts/detail/{{contact.ghl_contact_id | default:}}|{{contact.name | default:Unknown}}>";
const definition = {
  schema: 1, reentry: "always", premise: { check: "contact_exists" },
  nodes: [
    { id: "t1", type: "trigger", event: "tag.added" },
    { id: "a1", type: "analyze", prompt: "{{prompt.close_cheer}}", input: "Closer: {{contact.closer.name}}", format: "text", into: "cheer", optional: true },
    { id: "s1", type: "slack_post", channel: "{{slack.channel.deals}}", as: { name: "NEW CLOSE", icon: [":tada:", ":boom:"] },
      template: `*NEW CLOSE!* Well done {{contact.closer.mention | default:team}}!\n*Name:* ${LINK}{{contact.setter.mention | line:*Setter:*}}\n*Cash:* \${{contact.cash_collected | money}} · *Revenue:* \${{contact.revenue | money | default:—}}\n*First Booking:* {{contact.first_booked_at | date_company:ccc LLL d | default:—}} · *Days to Close:* {{contact.days_to_close | default:—}}\n*Source:* {{contact.source | default:—}}{{vars.cheer | line:}}` },
    { id: "s2", type: "slack_post", channel: "{{slack.channel.deals}}", thread_of: "s1", as: { name: "Call review", icon: ":clipboard:" }, template: "*Scorecard:* 8/10" },
    { id: "x1", type: "exit", reason: "posted" },
  ],
  edges: [{ from: "t1", to: "a1" }, { from: "a1", to: "s1" }, { from: "s1", to: "s2" }, { from: "s2", to: "x1" }],
};
let companyId: string, contactId: string;

describe.skipIf(!process.env.DATABASE_URL)("Slack posts: persona, mentions, threads", () => {
  beforeAll(async () => {
    await migrate();
    await asOperator(async (c) => {
      const co = await one<{ id: string }>(c, "select id from companies where slug='slackp'");
      if (co) { await c.query("delete from run_steps where run_id in (select id from runs where company_id=$1)", [co.id]); await c.query("delete from workflow_versions where workflow_id in (select id from workflows where company_id=$1)", [co.id]);
        for (const t of ["sends", "runs", "events", "payments", "pipeline_cards", "appointments", "opportunities", "contact_identifiers", "contacts", "workflow_triggers", "workflows", "slack_connections", "users", "calendars", "company_terms", "bindings", "poll_cursors", "audit_log"]) await c.query(`delete from ${t} where company_id=$1`, [co.id]); await c.query("delete from companies where id=$1", [co.id]); }
      companyId = (await one<{ id: string }>(c, "insert into companies (name, slug, timezone, mode, contract_value_default) values ('Slack P','slackp','America/New_York','shadow',4000) returning id"))!.id;
      await c.query("insert into company_terms (company_id, domain, name, category, is_default, sort) select $1, domain, label, value, true, sort from core_categories", [companyId]);
      await c.query("insert into bindings (company_id,key,kind,value) values ($1,'crm.location_id','id',$2),($1,'secret.ghl_pit','secret',$3),($1,'slack.channel.deals','channel',$4),($1,'crm.pipeline_closer','id',$5),($1,'crm.field_contact_setter','id',$6),($1,'crm.field_contact_lead_source','id',$7),($1,'prompt.close_cheer','text',$8),($1,'secret.anthropic_key','secret',$9)",
        [companyId, Buffer.from("LOC"), encrypt("p"), Buffer.from("CDEALS"), Buffer.from("PCLOSER"), Buffer.from("F_SETTER"), Buffer.from("F_SRC"), Buffer.from("cheer"), encrypt("sk-fake")]);
      await c.query("insert into slack_connections (company_id, team_id, bot_token, channels) values ($1,'T1',$2,'{}')", [companyId, encrypt("xoxb-fake")]);
      const allan = (await one<{ id: string }>(c, "insert into users (company_id, email, name, role, ghl_user_id) values ($1,'allan@hair.test','Allan P','closer','GALLAN') returning id", [companyId]))!.id;
      await c.query("insert into users (company_id, email, name, role, ghl_user_id) values ($1,'luis@hair.test','Luis','setter','GLUIS')", [companyId]);
      contactId = (await one<{ id: string }>(c, "insert into contacts (company_id, ghl_contact_id, first_name, last_name, ghl_fields) values ($1,'GC1','Leo','Ortiz',$2) returning id", [companyId, { F_SETTER: "luis", F_SRC: "instagram" }]))!.id;
      const term = (await one<{ id: string }>(c, "select id from company_terms where company_id=$1 and domain='appointment_type' and category='closing'", [companyId]))!.id;
      await c.query("insert into calendars (company_id, external_id, name, appointment_term) values ($1,'CAL','Closer',$2)", [companyId, term]);
      await c.query("insert into appointments (company_id, contact_id, calendar_id, external_id, starts_at, ends_at, booked_at, status, appointment_term) select $1,$2,id,'A1','2026-10-01T15:00Z','2026-10-01T15:30Z','2026-09-30T12:00Z','showed',$3 from calendars where company_id=$1", [companyId, contactId, term]);
      const opp = (await one<{ id: string }>(c, "insert into opportunities (company_id, contact_id, opened_by) values ($1,$2,'test') returning id", [companyId, contactId]))!.id;   // no contract_value: the program price fills in
      await c.query("insert into pipeline_cards (company_id, contact_id, opportunity_id, ghl_pipeline_id, ghl_stage_id, name, assigned_user_id, status) values ($1,$2,$3,'PCLOSER','S1','Leo -- Scheduled',$4,'open')", [companyId, contactId, opp, allan]);
      await c.query("insert into payments (company_id, contact_id, whop_payment_id, amount, status, paid_at) values ($1,$2,'p1',1500,'succeeded','2026-10-04T15:00Z')", [companyId, contactId]);
      const def = parseDefinition(definition), manifest = extractManifest(def);
      const wf = (await one<{ id: string }>(c, "insert into workflows (company_id, name, reentry_policy, enabled) values ($1,'Close post','always',true) returning id", [companyId]))!;
      await c.query("insert into workflow_versions (workflow_id, version, definition, manifest) values ($1,1,$2,$3)", [wf.id, definition, manifest]);
      for (const trig of indexDefinition(def).triggers) await c.query("insert into workflow_triggers (company_id, workflow_id, node_id, event_type, match) values ($1,$2,$3,$4,$5)", [companyId, wf.id, trig.id, trig.event, trig.match ?? {}]);
    });
  });

  it("pickIcon: one of the list, or the single icon, or nothing", () => {
    for (let i = 0; i < 20; i++) expect([":a:", ":b:"]).toContain(pickIcon([":a:", ":b:"]));
    expect(pickIcon(":one:")).toBe(":one:"); expect(pickIcon(undefined)).toBeUndefined(); expect(pickIcon([])).toBeUndefined();
  });

  it("the close post: closer from the card and @mentioned, setter matched by name and @mentioned, money, first booking, days to close, source, the cheer; the scorecard replies in its thread; both carry their persona", async () => {
    await asOperator(async (c) => dispatchEvent(c, await emitEvent(c, { company_id: companyId, contact_id: contactId, opportunity_id: null, appointment_id: null, event_type: "tag.added", source: "test", data: { tag: "x" } }), { contact: { id: contactId } }));
    const r = await tick(fake, undefined, companyId);
    expect(r.failed).toBe(0); expect(r.completed).toBe(1);
    expect(posts).toHaveLength(2);
    const [post, reply] = posts;
    expect(post.channel).toBe("CDEALS"); expect(post.threadTs).toBeUndefined();
    expect(post.text).toContain("🧪 *shadow* — *NEW CLOSE!* Well done <@UALLAN>!");
    expect(post.text).toContain("|Leo Ortiz>\n*Setter:* <@ULUIS>\n*Cash:* $1,500 · *Revenue:* $4,000");
    expect(post.text).toContain("*First Booking:* Thu Oct 1 · *Days to Close:* 3");
    expect(post.text).toContain("*Source:* instagram\nWell done Allan, that is a fast one.");
    expect(post.as).toEqual({ name: "NEW CLOSE", icon: [":tada:", ":boom:"] });
    expect(reply.threadTs).toBe("ts1"); expect(reply.text).toBe("*Scorecard:* 8/10");   // in the thread, no second shadow label
    expect(reply.as).toEqual({ name: "Call review", icon: ":clipboard:" });
    // the lookups were remembered on the team
    const ids = await asOperator((c) => many<{ name: string; slack_user_id: string | null }>(c, "select name, slack_user_id from users where company_id=$1 order by name", [companyId]));
    expect(ids).toEqual([{ name: "Allan P", slack_user_id: "UALLAN" }, { name: "Luis", slack_user_id: "ULUIS" }]);
  });

  it("without the AI key the optional cheer is skipped and the post still goes out, without the line", async () => {
    posts.length = 0;
    await asOperator((c) => c.query("delete from bindings where company_id=$1 and key='secret.anthropic_key'", [companyId]));
    const saved = process.env.ANTHROPIC_API_KEY; delete process.env.ANTHROPIC_API_KEY;
    try {
      await asOperator(async (c) => dispatchEvent(c, await emitEvent(c, { company_id: companyId, contact_id: contactId, opportunity_id: null, appointment_id: null, event_type: "tag.added", source: "test", data: { tag: "y" } }), { contact: { id: contactId } }));
      const r = await tick(fake, undefined, companyId);
      expect(r.failed).toBe(0); expect(posts).toHaveLength(2);
      expect(posts[0].text).toMatch(/\*Source:\* instagram$/);
      const step = await asOperator((c) => one<{ status: string }>(c, "select s.status from run_steps s join runs r on r.id=s.run_id where r.company_id=$1 and s.node_id='a1' order by s.started_at desc limit 1", [companyId]));
      expect(step?.status).toBe("skipped");
    } finally { if (saved) process.env.ANTHROPIC_API_KEY = saved; }
  });
});
