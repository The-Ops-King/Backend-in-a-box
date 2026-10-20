/** D202: /agreement <who> <type> in Slack: exact (email, phone, link) sends at once, a full name asks first, no type offers each agreement, nothing opens a form; the Send agreement workflow sends, under the offer's mode and lock. */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { asOperator, many, one } from "@/db/client";
import { migrate } from "@/db/migrate";
import { installCompany } from "@/engine/install";
import { loadCompany } from "@/engine/context";
import { encrypt } from "@/engine/crypto";
import { fakeAdapters, installTemplateForTest, unlockSendsForTest } from "@/engine/test-install";
import { parseSlackInteraction } from "./slack-actions";
import { agreementChoices, agreementForm, answerAgreementCommand, checkAgreementPress, checkAgreementSubmit, parseAgreementText, requestAgreement } from "./agreement-request";
import type { Adapters } from "@/adapters/types";

process.env.BINDINGS_KEY ??= Buffer.alloc(32, 7).toString("base64");
const SLUG = "d202-agreement";
const sentDocs: { templateId: string; contactId: string; userId?: string }[] = [], dms: { to: string; text: string }[] = [], notes: string[] = [];
const base = fakeAdapters();
const fake: Adapters = { ...base, write: { ...base.write, addNote: async (_c, _id, body) => { notes.push(body); }, sendDocumentTemplate: async (_c, input) => { sentDocs.push(input); return { id: `doc-${sentDocs.length}` }; } },
  notifier: { ...base.notifier, post: async (_t, channel, text) => { dms.push({ to: channel, text }); return { ts: "1.1" }; } } };
let co = "", rae = "";

describe("D202: the agreement choices and the form", () => {
  it("the offer's list, else its one agreement; a bad list is not a choice", () => {
    expect(agreementChoices({ "agreements.list": JSON.stringify([{ label: "Deposit agreement", template: "T-DEP" }, { label: "", template: "x" }, { label: "Full", template: "T-FULL", key: "Paid in full" }]) }))
      .toEqual([{ key: "deposit", label: "Deposit agreement", template: "T-DEP" }, { key: "paid", label: "Full", template: "T-FULL" }]);
    expect(agreementChoices({ "crm.agreement_template": "T-ONE" })).toEqual([{ key: "purchase", label: "Purchase agreement", template: "T-ONE" }]);
    expect(agreementChoices({ "agreements.list": "not json", "crm.agreement_template": "T-ONE" })).toEqual([{ key: "purchase", label: "Purchase agreement", template: "T-ONE" }]);
    expect(agreementChoices({})).toEqual([]);
  });
  it("the command's words: who, then which when its last word is an agreement's key", () => {
    const ch = [{ key: "deposit", label: "Deposit agreement", template: "T-DEP" }, { key: "full", label: "Full agreement", template: "T-FULL" }];
    expect(parseAgreementText("Rae Lee full", ch)).toEqual({ who: "Rae Lee", choice: ch[1] });
    expect(parseAgreementText(" rae@example.com   Deposit ", ch)).toEqual({ who: "rae@example.com", choice: ch[0] });
    expect(parseAgreementText("Rae Lee", ch)).toEqual({ who: "Rae Lee" });
    expect(parseAgreementText("full", ch)).toEqual({ who: "full" });   // one word is a person, not a type
    expect(parseAgreementText("", ch)).toEqual({ who: "" });
  });
  it("the form sent back gives what was typed and what was picked", () => {
    const view = agreementForm([{ key: "full", label: "Full", template: "T-FULL" }], { channel: "C1" });
    const payload = { type: "view_submission", user: { id: "U1" }, team: { id: "T1" }, view: { callback_id: view.callback_id, private_metadata: view.private_metadata,
      state: { values: { who: { who: { type: "plain_text_input", value: "rae@example.com" } }, which: { which: { type: "static_select", selected_option: { value: "T-FULL" } } } } } } };
    expect(parseSlackInteraction(new URLSearchParams({ payload: JSON.stringify(payload) }).toString())).toMatchObject({ kind: "submit", callbackId: "send_agreement", values: { who: "rae@example.com", which: "T-FULL" } });
  });
});

const wipe = () => asOperator(async (c) => {
  const old = await one<{ id: string }>(c, "select id from companies where slug=$1", [SLUG]); if (!old) return;
  await c.query("delete from run_steps where run_id in (select id from runs where company_id=$1)", [old.id]);
  await c.query("delete from workflow_versions where workflow_id in (select id from workflows where company_id=$1)", [old.id]);
  for (const t of ["sends", "step_effects", "runs", "events", "workflow_triggers", "workflows", "agreements", "contact_identifiers", "opportunities", "contacts", "users", "calendars", "company_terms", "slack_connections", "bindings", "poll_cursors", "engine_state", "audit_log"])
    await c.query(t === "engine_state" ? "delete from engine_state where key like '%' || $1 || '%'" : `delete from ${t} where company_id=$1`, [old.id]);
  await c.query("delete from companies where id=$1", [old.id]);
});

describe.skipIf(!process.env.DATABASE_URL)("D202: /agreement end to end", () => {
  beforeAll(async () => {
    await migrate(); await wipe();
    co = (await installCompany({ name: "Agreements", slug: SLUG, timezone: "UTC", locationId: "LOC-AG", pit: "pit-fake", calendars: {}, templates: [] }, fake)).companyId;
    await asOperator(async (c) => {
      await installTemplateForTest(c, co, "agreement-send-manually", { enabled: true });
      await c.query("insert into bindings (company_id, key, kind, value) values ($1,'agreements.list','text',$2),($1,'crm.agreement_template','text',convert_to('T-ONE','UTF8'))",
        [co, Buffer.from(JSON.stringify([{ label: "Deposit agreement", template: "T-DEP" }, { label: "Full agreement", template: "T-FULL" }]))]);
      await c.query("insert into slack_connections (company_id, team_id, bot_token, channels) values ($1,'T1',$2,'{}')", [co, encrypt("xoxb-fake")]);
      await c.query("insert into users (company_id, email, name, role, slack_user_id, ghl_user_id) values ($1,'cy@t.co','Cy Closer','closer','U-CY','GU-CY'),($1,'st@t.co','Stu','staff','U-ST',null)", [co]);
      rae = (await one<{ id: string }>(c, "insert into contacts (company_id, ghl_contact_id, first_name, last_name) values ($1,'GHLRAE00000000000AG','Rae','Lee') returning id", [co]))!.id;
      await c.query("insert into contact_identifiers (company_id, contact_id, kind, value) values ($1,$2,'email','rae@example.com')", [co, rae]);
      // two Sam Parks: a name that fits both sends nothing
      for (const [g, e] of [["GHLSAM00000000000A1", "sam1@example.com"], ["GHLSAM00000000000A2", "sam2@example.com"]]) {
        const s = (await one<{ id: string }>(c, "insert into contacts (company_id, ghl_contact_id, first_name, last_name) values ($1,$2,'Sam','Park') returning id", [co, g]))!.id;
        await c.query("insert into contact_identifiers (company_id, contact_id, kind, value) values ($1,$2,'email',$3)", [co, s, e]);
      }
      await c.query("update companies set mode='live' where id=$1", [co]);
      await c.query("insert into engine_state (key, value, updated_at) values ($1, $2, now()) on conflict (key) do update set value=excluded.value", [`scheduler:${co}`, { last_tick: new Date().toISOString() }]);
    });
    await unlockSendsForTest(co);
  });
  afterAll(wipe);

  const bindings = () => asOperator(async (c) => (await loadCompany(c, co)).bindings);

  it("answers inside Slack: nothing typed, a form; exact with a type, send now; a name, ask first; no type, a button each; ambiguous or unknown, nothing", async () => {
    const b = await bindings();
    const ans = (who: string, user = "U-CY") => asOperator((c) => answerAgreementCommand(c, co, user, b, who));
    expect(await ans("rae@example.com full", "U-ST")).toEqual({ say: { response_type: "ephemeral", text: "Only closers, managers and the operator can send agreements." } });
    expect(await ans("")).toMatchObject({ form: [{ key: "deposit" }, { key: "full" }] });
    expect(await ans("Rae@Example.com full")).toMatchObject({ send: { contact: { id: rae, name: "Rae Lee", email: "rae@example.com" }, choice: { key: "full" }, by: { name: "Cy Closer", ghl_user_id: "GU-CY" } }, say: { text: "Sending Full agreement to Rae Lee (rae@example.com)…" } });
    expect(await ans("https://app.gohighlevel.com/v2/location/L/contacts/detail/GHLRAE00000000000AG deposit")).toMatchObject({ send: { contact: { id: rae }, choice: { key: "deposit" } } });
    const named = await ans("rae lee full");
    expect(named.send).toBeUndefined();
    expect(named.say).toMatchObject({ text: "Send Full agreement to Rae Lee (rae@example.com)?" });
    expect(JSON.stringify(named.say)).toContain('"action_id":"agreement_send"');
    const which = await ans("rae@example.com");
    expect(which.say).toMatchObject({ text: "Which agreement for Rae Lee (rae@example.com)?" });
    expect((JSON.stringify(which.say).match(/"action_id":"agreement_send"/g) ?? []).length).toBe(2);
    expect((await ans("Sam Park full")).say).toMatchObject({ text: expect.stringMatching(/^More than one person is "Sam Park":\n• Sam Park \(sam1@example.com\)\n• Sam Park \(sam2@example.com\)\n.*Nothing was sent\.$/s) });
    expect((await ans("Rae deposit")).say).toMatchObject({ text: expect.stringContaining('No one in the CRM matches "Rae"') });   // a first name alone is no one
    expect((await ans("nobody@example.com")).say).toMatchObject({ text: expect.stringContaining("No one in the CRM") });
  });

  it("a Send button is checked again when pressed; the form takes names too and says what's wrong under its field", async () => {
    const b = await bindings();
    const named = await asOperator((c) => answerAgreementCommand(c, co, "U-CY", b, "Rae Lee full"));
    const value = /"value":"(\{[^}]+\})"/.exec(JSON.stringify(named.say).replace(/\\"/g, '"'))![1];
    expect(await asOperator((c) => checkAgreementPress(c, co, "U-CY", b, value))).toMatchObject({ contact: { id: rae }, choice: { key: "full" } });
    expect(await asOperator((c) => checkAgreementPress(c, co, "U-ST", b, value))).toEqual({ say: "Only closers, managers and the operator can send agreements." });
    expect(await asOperator((c) => checkAgreementPress(c, co, "U-CY", b, JSON.stringify({ c: rae, t: "T-GONE" })))).toMatchObject({ say: expect.stringContaining("isn't there any more") });
    expect(await asOperator((c) => checkAgreementSubmit(c, co, "U-CY", b, "Rae Lee", "T-FULL"))).toMatchObject({ contact: { id: rae } });
    expect(await asOperator((c) => checkAgreementSubmit(c, co, "U-CY", b, "rae@example.com", "T-ELSE"))).toEqual({ errors: { which: "Pick one of the agreements." } });
    expect(await asOperator((c) => checkAgreementSubmit(c, co, "U-CY", b, "Sam Park", "T-FULL"))).toMatchObject({ errors: { who: expect.stringContaining("More than one person") } });
  });

  it("a closer's request sends the agreement they picked, from them, at once; the note says so; they are told in a DM", async () => {
    const b = await bindings();
    const ok = await asOperator((c) => checkAgreementSubmit(c, co, "U-CY", b, "Rae@Example.com", "T-FULL"));
    if ("errors" in ok) throw new Error(JSON.stringify(ok.errors));
    const replies: string[] = [];
    const said = await requestAgreement(fake, co, "U-CY", ok.contact, ok.choice, ok.by, async (t) => { replies.push(t); });
    expect(said).toBe("✅ Full agreement sent to Rae Lee (rae@example.com).");
    expect(replies).toEqual([said]);   // said where it was asked (the command's answer), not in a DM
    expect(sentDocs.at(-1)).toEqual({ templateId: "T-FULL", contactId: "GHLRAE00000000000AG", userId: "GU-CY" });
    expect(await requestAgreement(fake, co, "U-CY", ok.contact, ok.choice, ok.by)).toMatch(/^✅/);
    expect(dms.at(-1)).toEqual({ to: "U-CY", text: "✅ Full agreement sent to Rae Lee (rae@example.com)." });   // from the form: a DM
    expect(notes.at(-1)).toMatch(/^AGREEMENT SENT — .+ · Full agreement · sent from Slack by Cy Closer$/);
  });

  it("someone who already signed gets nothing; an offer that isn't live holds it and says why", async () => {
    const b = await bindings();
    await asOperator((c) => c.query("insert into agreements (company_id, contact_id, external_id, status, sent_at, signed_at) values ($1,$2,'doc-x','completed',now(),now())", [co, rae]));
    const n = sentDocs.length;
    const ok = await asOperator((c) => checkAgreementSubmit(c, co, "U-CY", b, "rae@example.com", "T-DEP"));
    if ("errors" in ok) throw new Error(JSON.stringify(ok.errors));
    expect(await requestAgreement(fake, co, "U-CY", ok.contact, ok.choice, ok.by)).toBe("Rae Lee has already signed. Nothing sent.");
    await asOperator(async (c) => { await c.query("delete from agreements where company_id=$1", [co]); await c.query("update companies set mode='ghost' where id=$1", [co]); });
    expect(await requestAgreement(fake, co, "U-CY", ok.contact, ok.choice, ok.by)).toMatch(/^Not sent: the offer isn't live yet \(ghost\)/);
    expect(sentDocs.length).toBe(n);
    expect(await asOperator((c) => many(c, "select 1 from events where company_id=$1 and event_type='agreement.requested'", [co]))).toHaveLength(4);
  });
});
