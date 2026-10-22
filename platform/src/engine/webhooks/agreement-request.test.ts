/** D202: /agreement <who> <type> in Slack: exact (email, phone, link) sends at once, a full name asks first, no type offers each agreement, nothing opens a form; the Send agreement workflow sends, under the offer's mode and lock. */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { asOperator, many, one } from "@/db/client";
import { migrate } from "@/db/migrate";
import { installCompany } from "@/engine/install";
import { loadCompany } from "@/engine/context";
import { encrypt } from "@/engine/crypto";
import { fakeAdapters, installTemplateForTest, unlockSendsForTest } from "@/engine/test-install";
import { parseSlackInteraction } from "./slack-actions";
import { agreementChoices, agreementForm, answerAgreementCommand, checkAgreementPress, checkAgreementSubmit, parseAgreementText, phraseWords, requestAgreement } from "./agreement-request";
import type { Adapters } from "@/adapters/types";

process.env.BINDINGS_KEY ??= Buffer.alloc(32, 7).toString("base64");
const SLUG = "d202-agreement";
const sentDocs: { templateId: string; contactId: string; userId?: string }[] = [], dms: { to: string; text: string }[] = [], notes: string[] = [];
const base = fakeAdapters();
const fake: Adapters = { ...base, write: { ...base.write, addNote: async (_c, _id, body) => { notes.push(body); }, sendDocumentTemplate: async (_c, input) => { sentDocs.push(input); return { id: `doc-${sentDocs.length}` }; } },
  notifier: { ...base.notifier, post: async (_t, channel, text) => { dms.push({ to: channel, text }); return { ts: "1.1" }; } } };
let co = "", rae = "";

// PMU's four (D214): the price and whether it carries the guarantee
const PMU = JSON.stringify([
  { key: "10k", label: "$9,997", template: "T-10", match: ["9997 no guarantee", "10k no guarantee"] },
  { key: "10k-g", label: "$9,997 + Guarantee", template: "T-10G", match: ["10k guarantee"] },
  { key: "12k", label: "$12,000", template: "T-12", match: ["12k no guarantee"] },
  { key: "12k-g", label: "$12,000 + Guarantee", template: "T-12G", match: ["12k guarantee"] },
]);

describe("D202/D214: the agreement choices, the words and the form", () => {
  it("the offer's list, else its one agreement; a bad list is not a choice", () => {
    expect(agreementChoices({ "agreements.list": JSON.stringify([{ label: "Deposit agreement", template: "T-DEP" }, { label: "", template: "x" }, { label: "Full", template: "T-FULL", key: "Paid in full" }]) }).map(({ key, label, template }) => ({ key, label, template })))
      .toEqual([{ key: "deposit", label: "Deposit agreement", template: "T-DEP" }, { key: "paid-in-full", label: "Full", template: "T-FULL" }]);
    expect(agreementChoices({ "crm.agreement_template": "T-ONE" })).toEqual([{ key: "purchase", label: "Purchase agreement", template: "T-ONE", phrases: [["purchase"]] }]);
    expect(agreementChoices({ "agreements.list": "not json", "crm.agreement_template": "T-ONE" })).toMatchObject([{ key: "purchase", template: "T-ONE" }]);
    expect(agreementChoices({})).toEqual([]);
  });
  it("money and words read one way", () => {
    expect(phraseWords("$12,000 + Guarantee")).toEqual(["12000", "guarantee"]);
    expect(phraseWords("12k guaranteed")).toEqual(["12000", "guarantee"]);
    expect(phraseWords("9.997k")).toEqual(["9997"]);
    expect(phraseWords("send the agreement with guarantees")).toEqual(["guarantee"]);
    expect(phraseWords("12k no guarantee")).toEqual(["12000", "no-guarantee"]);
    expect(phraseWords("without guarantee")).toEqual(["no-guarantee"]);
  });
  it("the who and the which, either order: exactly one fits, it is that one; words that fit several offer those; no which, all of it is the who", () => {
    const ch = agreementChoices({ "agreements.list": PMU });
    const key = (r: ReturnType<typeof parseAgreementText>) => ({ who: r.who, choice: r.choice?.key, candidates: r.candidates?.map((x) => x.key) });
    expect(key(parseAgreementText("rae@example.com 12k guarantee", ch))).toEqual({ who: "rae@example.com", choice: "12k-g", candidates: undefined });
    expect(key(parseAgreementText("12k guarantee rae@example.com", ch))).toEqual({ who: "rae@example.com", choice: "12k-g", candidates: undefined });
    expect(key(parseAgreementText("Rae Lee $12,000 + Guarantee", ch))).toEqual({ who: "Rae Lee", choice: "12k-g", candidates: undefined });
    expect(key(parseAgreementText("12k to Rae Lee", ch))).toEqual({ who: "Rae Lee", choice: "12k", candidates: undefined });
    expect(key(parseAgreementText("rae@example.com 10k", ch))).toEqual({ who: "rae@example.com", choice: "10k", candidates: undefined });
    expect(key(parseAgreementText("rae@example.com 9,997 no guarantee", ch))).toEqual({ who: "rae@example.com", choice: "10k", candidates: undefined });
    expect(key(parseAgreementText("rae@example.com guarantee", ch))).toEqual({ who: "rae@example.com", choice: undefined, candidates: ["10k-g", "12k-g"] });
    expect(key(parseAgreementText("12k guarantee", ch))).toEqual({ who: "", choice: "12k-g", candidates: undefined });
    expect(key(parseAgreementText("rae@example.com", ch))).toEqual({ who: "rae@example.com", choice: undefined, candidates: undefined });
    expect(key(parseAgreementText("Rae Lee", ch))).toEqual({ who: "Rae Lee", choice: undefined, candidates: undefined });
    expect(key(parseAgreementText("", ch))).toEqual({ who: "", choice: undefined, candidates: undefined });
    // the offer with one agreement: its words are the which, anything else the who
    const one = agreementChoices({ "agreements.list": JSON.stringify([{ label: "Deposit agreement", template: "T-DEP", key: "deposit" }, { label: "Full agreement", template: "T-FULL", key: "full" }]) });
    expect(key(parseAgreementText("Rae Lee full", one))).toEqual({ who: "Rae Lee", choice: "full", candidates: undefined });
    expect(key(parseAgreementText(" rae@example.com   Deposit ", one))).toEqual({ who: "rae@example.com", choice: "deposit", candidates: undefined });
  });
  it("the form asks who, with the agreement already picked when the command named it; sent back it gives what was typed and picked", () => {
    const ch = agreementChoices({ "agreements.list": PMU });
    const asked = agreementForm(ch, { channel: "C1" }, ch[3]) as { blocks: { label: { text: string }; element: { initial_option?: { value: string } } }[] };
    expect(asked.blocks[0].label.text).toBe("Who do you want to send $12,000 + Guarantee to?");
    expect(asked.blocks[1].element.initial_option?.value).toBe("T-12G");
    expect((agreementForm(ch, { channel: "C1" }) as typeof asked).blocks[1].element.initial_option).toBeUndefined();
    const view = agreementForm([{ key: "full", label: "Full", template: "T-FULL", phrases: [["full"]] }], { channel: "C1" });
    const payload = { type: "view_submission", user: { id: "U1" }, team: { id: "T1" }, view: { callback_id: view.callback_id, private_metadata: view.private_metadata,
      state: { values: { who: { who: { type: "plain_text_input", value: "rae@example.com" } }, which: { which: { type: "static_select", selected_option: { value: "T-FULL" } } } } } } };
    expect(parseSlackInteraction(new URLSearchParams({ payload: JSON.stringify(payload) }).toString())).toMatchObject({ kind: "submit", callbackId: "send_agreement", values: { who: "rae@example.com", which: "T-FULL" } });
    const press = { type: "block_actions", user: { id: "U1" }, team: { id: "T1" }, actions: [{ action_id: "agreement_send:2", value: "{}" }] };
    expect(parseSlackInteraction(new URLSearchParams({ payload: JSON.stringify(press) }).toString())).toMatchObject({ kind: "press", action: "agreement_send", value: "{}" });   // the press, whichever button
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
    expect(await ans("full")).toMatchObject({ form: [{ key: "deposit" }, { key: "full" }], picked: { key: "full" } });   // D214: the which alone asks who
    expect((await ans("full to Rae@Example.com")).send).toMatchObject({ contact: { id: rae }, choice: { key: "full" } });   // either order
    expect(await ans("Rae@Example.com full")).toMatchObject({ send: { contact: { id: rae, name: "Rae Lee", email: "rae@example.com" }, choice: { key: "full" }, by: { name: "Cy Closer", ghl_user_id: "GU-CY" } }, say: { text: "Sending Full agreement to Rae Lee (rae@example.com)…" } });
    expect(await ans("https://app.gohighlevel.com/v2/location/L/contacts/detail/GHLRAE00000000000AG deposit")).toMatchObject({ send: { contact: { id: rae }, choice: { key: "deposit" } } });
    const named = await ans("rae lee full");
    expect(named.send).toBeUndefined();
    expect(named.say).toMatchObject({ text: "Send Full agreement to Rae Lee (rae@example.com)?" });
    expect(JSON.stringify(named.say)).toContain('"action_id":"agreement_send:0"');
    const which = await ans("rae@example.com");
    expect(which.say).toMatchObject({ text: "Which agreement for Rae Lee (rae@example.com)?" });
    const ids = [...JSON.stringify(which.say).matchAll(/"action_id":"([^"]+)"/g)].map((m) => m[1]);
    expect(ids).toEqual(["agreement_send:0", "agreement_send:1", "agreement_cancel"]);   // Slack refuses a message whose buttons share an action_id
    expect((await ans("<mailto:rae@example.com|rae@example.com> full")).send).toMatchObject({ contact: { id: rae } });   // as Slack hands a typed email back
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

  it("someone who signed before still gets the one a closer asked for, and the closer is told they had signed; an offer that isn't live holds it and says why", async () => {
    const b = await bindings();
    await asOperator((c) => c.query("insert into agreements (company_id, contact_id, external_id, status, sent_at, signed_at) values ($1,$2,'doc-x','completed','2026-09-21','2026-09-21')", [co, rae]));
    const ok = await asOperator((c) => checkAgreementSubmit(c, co, "U-CY", b, "rae@example.com", "T-DEP"));
    if ("errors" in ok) throw new Error(JSON.stringify(ok.errors));
    expect(await requestAgreement(fake, co, "U-CY", ok.contact, ok.choice, ok.by)).toBe("✅ Deposit agreement sent to Rae Lee (rae@example.com). (They signed an earlier agreement on 2026-09-21.)");
    expect(sentDocs.at(-1)).toMatchObject({ templateId: "T-DEP" });
    const n = sentDocs.length;
    await asOperator(async (c) => { await c.query("delete from agreements where company_id=$1", [co]); await c.query("update companies set mode='ghost' where id=$1", [co]); });
    expect(await requestAgreement(fake, co, "U-CY", ok.contact, ok.choice, ok.by)).toMatch(/^Not sent: the offer isn't live yet \(ghost\)/);
    expect(sentDocs.length).toBe(n);
    expect(await asOperator((c) => many(c, "select 1 from events where company_id=$1 and event_type='agreement.requested'", [co]))).toHaveLength(4);
  });
});
