/** D368: an application ten minutes old is recorded once about its person; Partial applicant posts the ones with no call booked. */
import { describe, it, expect, beforeAll } from "vitest";
import { DateTime } from "luxon";
import { asOperator, many, one } from "@/db/client";
import { migrate } from "@/db/migrate";
import { encrypt } from "@/engine/crypto";
import { tick } from "@/engine/runner";
import { installTemplateForTest, replicaSnapshot } from "@/engine/test-install";
import { answersOf, answersText, recordApplications } from "./applications";
import type { TfField, TfForm, TfResponse, TypeformApi } from "@/adapters/typeform/client";
import type { Adapters, BookingRead } from "@/adapters/types";

process.env.BINDINGS_KEY ??= Buffer.alloc(32, 7).toString("base64");

const FIELDS: TfField[] = [
  { id: "f_str", ref: "r_str", type: "multiple_choice", title: "What's your biggest struggle right now?" },
  { id: "f_rev", ref: "r_rev", type: "multiple_choice", title: "Over the last 90 days, what was your average monthly revenue?" },
  { id: "f_grp", ref: "r_grp", type: "inline_group", title: "Contact Information", properties: { fields: [
    { id: "f_fn", ref: "r_fn", type: "short_text", title: "First name" }, { id: "f_ln", ref: "r_ln", type: "short_text", title: "Last name" },
    { id: "f_ph", ref: "r_ph", type: "phone_number", title: "Phone number" }, { id: "f_em", ref: "r_em", type: "email", title: "Email" } ] } },
  { id: "f_cal", ref: "r_cal", type: "calendly", title: "Book Your Beauty Moguls Demo Call" },
];
const FLAT = [FIELDS[0], FIELDS[1], ...FIELDS[2].properties!.fields!, FIELDS[3]];
const choice = (id: string, label: string) => ({ field: { id, ref: `r${id.slice(1)}`, type: "multiple_choice" }, type: "choice", choice: { label } });
const response = (token: string, minsAgo: number, who: { first: string; email?: string; phone?: string }, finished = true): TfResponse => {
  const at = new Date(Date.now() - minsAgo * 60e3).toISOString();
  return { token, response_id: token, landed_at: at, ...(finished ? { submitted_at: at } : {}), hidden: { utm_source: "ig", utm_medium: "paid", utm_campaign: "C1", utm_term: "S1", utm_content: "A1" },
    answers: [
      // answered out of the form's order: the post keeps the form's
      choice("f_rev", "$11k-$20k/month"), choice("f_str", "I can't step away and everything falls apart when I'm not there"),
      { field: { id: "f_fn", ref: "r_fn", type: "short_text" }, type: "text", text: who.first }, { field: { id: "f_ln", ref: "r_ln", type: "short_text" }, type: "text", text: "Doe" },
      ...(who.email ? [{ field: { id: "f_em", ref: "r_em", type: "email" }, type: "email", email: who.email }] : []),
      ...(who.phone ? [{ field: { id: "f_ph", ref: "r_ph", type: "phone_number" }, type: "phone_number", phone_number: who.phone }] : []),
      { field: { id: "f_cal", ref: "r_cal", type: "calendly" }, type: "url", url: "https://calendly.com/x" },
    ] };
};

describe("D368: the answers an application holds", () => {
  it("every answer as the form asked it, in the form's order; the name, email, phone and booking step are not answers", () => {
    const r = response("t1", 15, { first: "Pam", email: "pam@x.test", phone: "+16025550100" });
    expect(answersOf(r, FLAT)).toEqual([
      { question: "What's your biggest struggle right now?", answer: "I can't step away and everything falls apart when I'm not there" },
      { question: "Over the last 90 days, what was your average monthly revenue?", answer: "$11k-$20k/month" },
    ]);
    expect(answersText(answersOf(r, FLAT))).toBe("*What's your biggest struggle right now?:* I can't step away and everything falls apart when I'm not there\n*Over the last 90 days, what was your average monthly revenue?:* $11k-$20k/month");
  });
});

describe.skipIf(!process.env.DATABASE_URL)("D368: applications recorded and partials posted", () => {
  const posts: { channel: string; text: string }[] = [];
  let reads = 0;
  const tf = { getForm: async () => { reads++; return { id: "FORM_A", title: "VSL A", fields: FIELDS } as TfForm; } } as unknown as TypeformApi;
  const fake: Adapters = {
    read: { contactsChangedSince: async () => [], openCards: async () => [], inboundSince: async () => [], messageBodies: async () => new Map(), callMedia: async () => null, contactsAddedBetween: async () => [], callsBetween: async () => [], wonOpportunities: async () => [], objectRecords: async () => [], documents: async () => [], opportunitiesSince: async () => [], pipelineCards: async () => [], getContact: async (c, id) => replicaSnapshot(c.id, id), listUsers: async () => [] },
    booking: (() => { const b: BookingRead = { appointmentsInWindow: async () => [], getAppointment: async () => null, listCalendars: async () => [] }; return { ghl: b, calendly: b }; })(),
    write: { createContact: async () => ({ id: "x" }), addTag: async () => {}, removeTag: async () => {}, addNote: async () => {}, updateAppointment: async () => {}, updateContact: async () => {}, createTask: async () => ({ id: "t" }), createRecord: async () => ({ id: "r" }), updateRecord: async () => {}, relateRecords: async () => {}, createOpportunity: async () => ({ id: "o" }), updateOpportunity: async () => {}, sendDocumentTemplate: async () => ({ id: "d" }) },
    sender: { sendSms: async () => ({ externalId: "s", accepted: true }), sendEmail: async () => ({ externalId: "e", accepted: true }), deliveryStatus: async () => ({ status: "sent" }), sendEmailTemplate: async () => ({ externalId: "t", accepted: true }), smsTemplateBody: async () => null },
    classifier: { choice: async (_s: unknown, _i: unknown, options: string[]) => ({ value: options[0], confidence: 1, distribution: {}, unclear: false }) },
    notifier: { post: async (_t, channel, text) => { posts.push({ channel, text }); return { ts: `ts${posts.length}` }; }, update: async () => {},
      lookupUserByEmail: async () => null, react: async () => true, unreact: async () => true, authTest: async () => ({ ok: true }), channelInfo: async () => ({ ok: true, member: true }) },
    analyst: { analyze: async () => ({ text: "{}", parsed: {}, model: "fake", usage: { input: 0, output: 0, cacheRead: 0 } }) },
  } as Adapters;
  let co = "", pam = "", bo = "";

  beforeAll(async () => {
    await migrate();
    co = await asOperator(async (c) => {
      const id = (await one<{ id: string }>(c, "insert into companies (name, slug, timezone, mode) values ('Apps Co',$1,'America/New_York','live') returning id", [`apps-${Date.now()}`]))!.id;
      await c.query("insert into company_terms (company_id, domain, name, category, is_default, sort) select $1, domain, label, value, true, sort from core_categories", [id]);
      await c.query("insert into bindings (company_id,key,kind,value) values ($1,'crm.location_id','id',$2),($1,'secret.ghl_pit','secret',$3),($1,'slack.channel.partials','channel',$4)", [id, Buffer.from("LOC"), encrypt("p"), Buffer.from("CPARTIALS")]);
      await c.query("insert into slack_connections (company_id, team_id, bot_token, channels) values ($1,'T1',$2,'{}')", [id, encrypt("xoxb-fake")]);
      await installTemplateForTest(c, id, "partial-applicant");
      // Pam: no call. Bo: a closing call tomorrow (he booked inside the form)
      pam = (await one<{ id: string }>(c, "insert into contacts (company_id, ghl_contact_id, first_name, last_name) values ($1,'G-PAM','Pam','Doe') returning id", [id]))!.id;
      await c.query("insert into contact_identifiers (company_id, contact_id, kind, value) values ($1,$2,'email','pam@x.test')", [id, pam]);
      bo = (await one<{ id: string }>(c, "insert into contacts (company_id, ghl_contact_id, first_name, last_name) values ($1,'G-BO','Bo','Doe') returning id", [id]))!.id;
      await c.query("insert into contact_identifiers (company_id, contact_id, kind, value) values ($1,$2,'phone','+16025550111')", [id, bo]);
      const term = (await one<{ id: string }>(c, "select id from company_terms where company_id=$1 and domain='appointment_type' and category='closing' and is_default", [id]))!.id;
      const at = DateTime.now().plus({ days: 1 });
      await c.query("insert into appointments (company_id, contact_id, external_id, appointment_term, starts_at, ends_at, booked_at, status) values ($1,$2,'A-BO',$3,$4,$5,now(),'confirmed')", [id, bo, term, at.toJSDate(), at.plus({ hours: 1 }).toJSDate()]);
      return id;
    });
  }, 180000);

  const record = (rs: { r: TfResponse; status: "complete" | "partial"; form: string }[]) =>
    asOperator((c) => recordApplications(c, { companyId: co, token: "tok", tf, formTags: { FORM_A: "vsl a" } }, rs));
  const events = () => asOperator((c) => many<{ contact_id: string; data: Record<string, unknown> }>(c, "select contact_id, data from events where company_id=$1 and event_type='application.received' order by id", [co]));

  it("ten minutes old: recorded once about the person; younger waits, older than two hours and unknown people are left", async () => {
    const rs = [
      { r: response("pam1", 15, { first: "Pam", email: "PAM@x.test" }), status: "complete" as const, form: "FORM_A" },
      { r: response("bo1", 12, { first: "Bo", phone: "(602) 555-0111" }, false), status: "partial" as const, form: "FORM_A" },
      { r: response("new1", 5, { first: "New", email: "new@x.test" }), status: "complete" as const, form: "FORM_A" },
      { r: response("stranger", 20, { first: "Sue", email: "sue@x.test" }), status: "complete" as const, form: "FORM_A" },
      { r: response("old1", 180, { first: "Pam", email: "pam@x.test" }), status: "complete" as const, form: "FORM_A" },
    ];
    expect(await record(rs)).toEqual({ recorded: 2, waiting: 1, notYet: 1 });
    expect(reads).toBe(1);   // the form is read once a pass
    const evs = await events();
    expect(evs.map((e) => e.contact_id)).toEqual([pam, bo]);
    expect(evs[0].data).toMatchObject({ form_id: "FORM_A", form_name: "vsl a", response_id: "pam1", status: "complete", finished: true, email: "pam@x.test", utm: { source: "ig", medium: "paid", campaign: "C1", term: "S1", content: "A1" } });
    expect(evs[1].data).toMatchObject({ status: "partial", finished: false, phone: "+16025550111" });
    expect(await record(rs)).toEqual({ recorded: 0, waiting: 1, notYet: 1 });   // once
    expect(await events()).toHaveLength(2);
  });

  it("Partial applicant: Pam (no call) is posted with her answers and the ad; Bo (booked) is not", async () => {
    await tick(fake, undefined, co);
    expect(posts).toHaveLength(1);
    expect(posts[0].channel).toBe("CPARTIALS");
    expect(posts[0].text).toMatch(/^\*Partial: Pam Doe\* \(VSL A, finished the form, no call booked\)\n/);
    expect(posts[0].text).toContain("*Email:* pam@x.test");
    expect(posts[0].text).toContain("*Over the last 90 days, what was your average monthly revenue?:* $11k-$20k/month");
    expect(posts[0].text).toContain("*Ad IDs:* campaign C1 · ad set S1 · ad A1");
    const runs = await asOperator((c) => many<{ contact_id: string; exit_reason: string }>(c, "select contact_id, exit_reason from runs where company_id=$1 order by started_at", [co]));
    expect(runs).toEqual(expect.arrayContaining([{ contact_id: pam, exit_reason: "posted" }, { contact_id: bo, exit_reason: "booked" }]));
    expect(await asOperator((c) => one(c, "select 1 from slack_posts where company_id=$1 and tag=$2", [co, `partial:${pam}`]))).toBeTruthy();
  });
});

describe.skipIf(!process.env.DATABASE_URL)("D368: a check that waited goes on along its `timeout` edge", () => {
  const posts: string[] = [];
  const base = { read: { getContact: async (c: { id: string }, id: string) => replicaSnapshot(c.id, id) }, notifier: { post: async (_t: string, _c: string, text: string) => { posts.push(text); return { ts: `t${posts.length}` }; }, update: async () => {}, react: async () => true, unreact: async () => true, lookupUserByEmail: async () => null } };
  let co = "", ct = "";
  beforeAll(async () => {
    await migrate();
    co = await asOperator(async (c) => {
      const id = (await one<{ id: string }>(c, "insert into companies (name, slug, timezone, mode) values ('Timeout Co',$1,'America/New_York','live') returning id", [`tmo-${Date.now()}`]))!.id;
      await c.query("insert into company_terms (company_id, domain, name, category, is_default, sort) select $1, domain, label, value, true, sort from core_categories", [id]);
      await c.query("insert into bindings (company_id,key,kind,value) values ($1,'crm.location_id','id',$2),($1,'secret.ghl_pit','secret',$3),($1,'slack.channel.partials','channel',$4)", [id, Buffer.from("LOC"), encrypt("p"), Buffer.from("CP")]);
      await c.query("insert into slack_connections (company_id, team_id, bot_token, channels) values ($1,'T1',$2,'{}')", [id, encrypt("xoxb-fake")]);
      // the gate waits up to 3 minutes for something that never comes, then posts anyway
      await installTemplateForTest(c, id, "partial-applicant", { patch: (d) => {
        Object.assign(d.nodes.find((n) => n.id === "c_booked")!, { when: { exists: "contact.fields.never_set" }, retry: { every: "1m", for: "3m" } });
        d.edges.push({ from: "c_booked", to: "n_post", label: "timeout" });
      } });
      ct = (await one<{ id: string }>(c, "insert into contacts (company_id, ghl_contact_id, first_name, last_name) values ($1,'G-TOM','Tom','Doe') returning id", [id]))!.id;
      await c.query("insert into contact_identifiers (company_id, contact_id, kind, value) values ($1,$2,'email','tom@x.test')", [id, ct]);
      return id;
    });
  }, 180000);

  it("waits while there is time, then takes the timeout edge instead of exiting", async () => {
    const tf = { getForm: async () => ({ id: "F", title: "F", fields: FIELDS }) } as unknown as TypeformApi;
    await asOperator((c) => recordApplications(c, { companyId: co, token: "tok", tf, formTags: {} }, [{ r: response("tom1", 11, { first: "Tom", email: "tom@x.test" }), status: "complete", form: "F" }]));
    const fake = base as unknown as Adapters;
    await tick(fake, DateTime.now(), co);
    expect(posts).toEqual([]);
    expect(await asOperator((c) => one(c, "select status, current_node from runs where company_id=$1", [co]))).toEqual({ status: "waiting", current_node: "c_booked" });
    // the three minutes pass: the deadline the step pinned is behind us and the run is due
    await asOperator((c) => c.query("update runs set next_run_at=now() - interval '1 second', context=jsonb_set(context, '{vars,__check,c_booked,deadline}', to_jsonb(now() - interval '1 minute')) where company_id=$1", [co]));
    await tick(fake, DateTime.now(), co);
    expect(posts).toHaveLength(1);
    expect(await asOperator((c) => one(c, "select status, exit_reason from runs where company_id=$1", [co]))).toEqual({ status: "completed", exit_reason: "posted" });
  });
});
