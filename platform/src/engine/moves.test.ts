/** D88: business rules that lived in engine code now live in workflows and settings. Each item: what an existing company sees is what it saw before, and editing the step or the setting changes it. */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { asOperator, one, many } from "@/db/client";
import { migrate } from "@/db/migrate";
import { encrypt } from "@/engine/crypto";
import { dispatchEvent } from "@/engine/dispatch";
import { tick } from "@/engine/runner";
import { installTemplateForTest, replicaSnapshot } from "@/engine/test-install";
import { recordPayment } from "@/engine/payments";
import { ingestRecording } from "@/engine/inbound";
import { loadCompany } from "@/engine/context";
import type { Definition } from "@/engine/definition";
import type { Adapters, BookingRead, SlackPersona } from "@/adapters/types";

process.env.BINDINGS_KEY ??= Buffer.alloc(32, 7).toString("base64");
process.env.PUBLIC_URL = "https://engine.test";
export const posts: { channel: string; text: string; as?: SlackPersona; threadTs?: string }[] = [];
export const reactions: { channel: string; ts: string; emoji: string }[] = [];
const fake: Adapters = {
  read: { contactsChangedSince: async () => [], openCards: async () => [], inboundSince: async () => [], callMedia: async () => null, contactsAddedBetween: async () => [], callsBetween: async () => [], wonOpportunities: async () => [], objectRecords: async () => [], documents: async () => [], opportunitiesSince: async () => [], pipelineCards: async () => [], getContact: async (c, id) => replicaSnapshot(c.id, id), listUsers: async () => [] },
  booking: (() => { const b: BookingRead = { appointmentsInWindow: async () => [], getAppointment: async () => null, listCalendars: async () => [] }; return { ghl: b, calendly: b }; })(),
  write: { createContact: async () => ({ id: "x" }), addTag: async () => {}, removeTag: async () => {}, addNote: async () => {}, updateAppointment: async () => {}, updateContact: async () => {}, createTask: async () => ({ id: "t" }), createRecord: async () => ({ id: "r" }), updateRecord: async () => {}, relateRecords: async () => {}, createOpportunity: async () => ({ id: "o" }), updateOpportunity: async () => {}, sendDocumentTemplate: async () => ({ id: "d" }) },
  sender: { sendSms: async () => ({ externalId: "s", accepted: true }), sendEmail: async () => ({ externalId: "e", accepted: true }), deliveryStatus: async () => ({ status: "sent" }), sendEmailTemplate: async () => ({ externalId: "t", accepted: true }), smsTemplateBody: async () => null },
  classifier: { choice: async () => ({ value: "confirmed", confidence: 1, distribution: {}, unclear: false }) },
  notifier: { post: async (_t, channel, text, as, threadTs) => { posts.push({ channel, text, as, threadTs }); return { ts: `ts${posts.length}` }; }, lookupUserByEmail: async () => null, react: async (_t, channel, ts, emoji) => { reactions.push({ channel, ts, emoji }); return true; }, unreact: async () => true, authTest: async () => ({ ok: true }), channelInfo: async () => ({ ok: true, member: true }), update: async () => {} },
  analyst: { analyze: async () => ({ text: "{}", parsed: {}, model: "fake", usage: { input: 0, output: 0, cacheRead: 0 } }) },
};
let companyId: string;
const TABLES = ["slack_posts", "alerts", "sends", "runs", "events", "form_submissions", "forms", "eod_reports", "crm_records", "recordings", "payments", "pipeline_cards", "appointments", "opportunities", "contact_identifiers", "contacts", "workflow_triggers", "workflows", "slack_connections", "users", "calendars", "company_terms", "bindings", "poll_cursors", "audit_log", "step_effects", "wrapups", "health_checks", "rollups_daily"];
const freshCompany = async (slug: string, mode = "live") => asOperator(async (c) => {
  const co = await one<{ id: string }>(c, "select id from companies where slug=$1", [slug]);
  if (co) { await c.query("delete from run_steps where run_id in (select id from runs where company_id=$1)", [co.id]); await c.query("delete from workflow_versions where workflow_id in (select id from workflows where company_id=$1)", [co.id]);
    for (const t of TABLES) await c.query(`delete from ${t} where company_id=$1`, [co.id]).catch(() => undefined); await c.query("delete from companies where id=$1", [co.id]); }
  const id = (await one<{ id: string }>(c, "insert into companies (name, slug, timezone, mode) values ('Moves Co',$1,'America/Phoenix',$2) returning id", [slug, mode]))!.id;
  await c.query("insert into company_terms (company_id, domain, name, category, is_default, sort) select $1, domain, label, value, true, sort from core_categories", [id]);
  await c.query("insert into bindings (company_id,key,kind,value) values ($1,'crm.location_id','id',$2),($1,'secret.ghl_pit','secret',$3),($1,'slack.channel.alerts','channel',$4),($1,'slack.channel.bookings','channel',$5)", [id, Buffer.from("LOC"), encrypt("p"), Buffer.from("CALERTS"), Buffer.from("CBOOK")]);
  await c.query("insert into slack_connections (company_id, team_id, bot_token, channels) values ($1,'T1',$2,'{}')", [id, encrypt("xoxb-fake")]);
  return id;
});
const install = (slug: string, patch?: (d: Definition) => void) => asOperator((c) => installTemplateForTest(c, companyId, slug, { patch }));
const run = () => tick(fake, undefined, companyId);

describe.skipIf(!process.env.DATABASE_URL)("D88: unlinked payments and recordings are workflows (A2)", () => {
  beforeAll(async () => { await migrate(); companyId = await freshCompany("mvs-a2"); });
  beforeEach(() => { posts.length = 0; });

  it("an unlinked payment starts Unlinked payment, which posts what the engine used to post, word for word", async () => {
    await install("payment-unlinked");
    await asOperator(async (c) => { const r = await recordPayment(c, companyId, { providerPaymentId: "pay_x1", amount: 1500, status: "succeeded", email: "nobody@buyer.test", phone: "+16025550199", memberId: "mem_1", paidAt: new Date() }); expect(r.outcome).toBe("unlinked"); if (r.outcome === "unlinked") await dispatchEvent(c, r.event, {}); });
    await run();
    expect(posts).toHaveLength(1);
    expect(posts[0].channel).toBe("CALERTS");
    expect(posts[0].text).toBe("*Unlinked payment* · $1500.00 succeeded\nNobody in the CRM matched this buyer.\n*Email:* nobody@buyer.test · *Phone:* +16025550199 · *Whop member:* mem_1\nLink it: https://engine.test/c/mvs-a2/payments");
  });

  it("an unmatched recording starts Unmatched recording, word for word; an edited copy says what the company wrote", async () => {
    await install("recording-unlinked");
    await asOperator(async (c) => { const { row, bindings } = await loadCompany(c, companyId); await ingestRecording(c, row, bindings, { provider: "fathom", externalId: "rec-x1", title: "Strategy call", startedAt: new Date(), endedAt: new Date(), durationMin: 32, shareUrl: "https://fathom.test/share/1", recordedBy: { email: "closer@co.test", name: "Closer" }, invitees: [{ name: "Ann", email: "ann@x.test" }, { name: "Bo" }], raw: {} }); });
    await run();
    expect(posts).toHaveLength(1);
    expect(posts[0].text).toMatch(/^\*Unmatched recording\* · Strategy call · 32 min\n.+\n\*Attendees:\* ann@x\.test, Bo · \*Recorded by:\* closer@co\.test\nhttps:\/\/fathom\.test\/share\/1\nLink it: https:\/\/engine\.test\/c\/mvs-a2\/recordings$/);
    // the company's own words: its copy of the step changes what goes out
    await asOperator((c) => c.query("update workflows set enabled=false where company_id=$1", [companyId]));
    await install("payment-unlinked", (d) => { const n = d.nodes.find((x) => x.id === "n1")!; if (n.type === "slack_post") { n.template = "💸 Nobody matched {{event.customer_email}} (${{event.amount | money}})"; n.channel = "{{slack.channel.bookings}}"; } });
    await asOperator(async (c) => { const r = await recordPayment(c, companyId, { providerPaymentId: "pay_x2", amount: 2999, status: "succeeded", email: "ghost@buyer.test", paidAt: new Date() }); if (r.outcome === "unlinked") await dispatchEvent(c, r.event, {}); });
    await run();
    expect(posts.at(-1)).toMatchObject({ channel: "CBOOK", text: "💸 Nobody matched ghost@buyer.test ($2,999)" });
  });
});
