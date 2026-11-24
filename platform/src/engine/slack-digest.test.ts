/** D367: posts that land together become one message: each adds its line to the one post its digest key names, edited in place. */
import { describe, it, expect, beforeAll } from "vitest";
import { asOperator, one } from "@/db/client";
import { migrate } from "@/db/migrate";
import { encrypt } from "@/engine/crypto";
import { dispatchEvent } from "@/engine/dispatch";
import { tick } from "@/engine/runner";
import { installTemplateForTest, replicaSnapshot } from "@/engine/test-install";
import { recordPayment } from "@/engine/payments";
import type { Adapters, BookingRead } from "@/adapters/types";

process.env.BINDINGS_KEY ??= Buffer.alloc(32, 7).toString("base64");
const posts: { channel: string; text: string }[] = [], edits: { ts: string; text: string }[] = [];
const fake: Adapters = {
  read: { contactsChangedSince: async () => [], openCards: async () => [], inboundSince: async () => [], messageBodies: async () => new Map(), callMedia: async () => null, contactsAddedBetween: async () => [], callsBetween: async () => [], wonOpportunities: async () => [], objectRecords: async () => [], documents: async () => [], opportunitiesSince: async () => [], pipelineCards: async () => [], getContact: async (c, id) => replicaSnapshot(c.id, id), listUsers: async () => [] },
  booking: (() => { const b: BookingRead = { appointmentsInWindow: async () => [], getAppointment: async () => null, listCalendars: async () => [] }; return { ghl: b, calendly: b }; })(),
  write: { createContact: async () => ({ id: "x" }), addTag: async () => {}, removeTag: async () => {}, addNote: async () => {}, updateAppointment: async () => {}, updateContact: async () => {}, createTask: async () => ({ id: "t" }), createRecord: async () => ({ id: "r" }), updateRecord: async () => {}, relateRecords: async () => {}, createOpportunity: async () => ({ id: "o" }), updateOpportunity: async () => {}, sendDocumentTemplate: async () => ({ id: "d" }) },
  sender: { sendSms: async () => ({ externalId: "s", accepted: true }), sendEmail: async () => ({ externalId: "e", accepted: true }), deliveryStatus: async () => ({ status: "sent" }), sendEmailTemplate: async () => ({ externalId: "t", accepted: true }), smsTemplateBody: async () => null },
  classifier: { choice: async (_s: unknown, _i: unknown, options: string[]) => ({ value: options[0], confidence: 1, distribution: {}, unclear: false }) },
  notifier: { post: async (_t, channel, text) => { posts.push({ channel, text }); return { ts: `ts${posts.length}` }; }, update: async (_t, _c, ts, text) => { edits.push({ ts, text }); },
    lookupUserByEmail: async () => null, react: async () => true, unreact: async () => true, authTest: async () => ({ ok: true }), channelInfo: async () => ({ ok: true, member: true }) },
  analyst: { analyze: async () => ({ text: "{}", parsed: {}, model: "fake", usage: { input: 0, output: 0, cacheRead: 0 } }) },
} as Adapters;

describe.skipIf(!process.env.DATABASE_URL)("D367: a digest post", () => {
  let co = "";
  beforeAll(async () => {
    await migrate();
    co = await asOperator(async (c) => {
      const id = (await one<{ id: string }>(c, "insert into companies (name, slug, timezone, mode) values ('Digest Co',$1,'America/Phoenix','live') returning id", [`dg-${Date.now()}`]))!.id;
      await c.query("insert into company_terms (company_id, domain, name, category, is_default, sort) select $1, domain, label, value, true, sort from core_categories", [id]);
      await c.query("insert into bindings (company_id,key,kind,value) values ($1,'crm.location_id','id',$2),($1,'secret.ghl_pit','secret',$3),($1,'slack.channel.alerts','channel',$4)", [id, Buffer.from("LOC"), encrypt("p"), Buffer.from("CALERTS")]);
      await c.query("insert into slack_connections (company_id, team_id, bot_token, channels) values ($1,'T1',$2,'{}')", [id, encrypt("xoxb-fake")]);
      await installTemplateForTest(c, id, "payment-unlinked", { patch: (d) => { const n = d.nodes.find((x) => x.id === "n1") as { digest?: unknown; label?: string; buttons?: unknown }; n.digest = { key: "unlinked-today", title: "Payments that matched nobody" }; n.label = "none"; delete n.buttons; } });
      return id;
    });
  }, 180000);

  it("three alerts at once: one message, its lines added as they come, each run still says it posted", async () => {
    for (const [i, amount] of [[1, 100], [2, 200], [3, 300]] as const) await asOperator(async (c) => {
      const r = await recordPayment(c, co, { providerPaymentId: `pay_dg${i}`, amount, status: "succeeded", email: `nobody${i}@buyer.test`, paidAt: new Date() });
      if (r.outcome === "unlinked") await dispatchEvent(c, r.event, {});
    });
    await tick(fake, undefined, co);
    expect(posts).toHaveLength(1);
    expect(posts[0].text).toMatch(/^Payments that matched nobody \(1\)\n/);
    expect(edits).toHaveLength(2);
    expect(edits.at(-1)!.ts).toBe("ts1");
    expect(edits.at(-1)!.text).toMatch(/^Payments that matched nobody \(3\)\n/);
    expect(edits.at(-1)!.text.match(/\*Unlinked payment\*/g)).toHaveLength(3);
    expect(await asOperator((c) => one<{ n: number }>(c, "select jsonb_array_length(lines) as n from slack_posts where company_id=$1 and tag='digest:unlinked-today'", [co]))).toEqual({ n: 3 });
  });
});
