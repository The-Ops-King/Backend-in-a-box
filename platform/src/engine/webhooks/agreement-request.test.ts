/** D202: /agreement in Slack: a form (who, which agreement), checked at once; the Send agreement workflow sends it at once, under the offer's mode and lock. */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { asOperator, many, one } from "@/db/client";
import { migrate } from "@/db/migrate";
import { installCompany } from "@/engine/install";
import { loadCompany } from "@/engine/context";
import { encrypt } from "@/engine/crypto";
import { fakeAdapters, installTemplateForTest, unlockSendsForTest } from "@/engine/test-install";
import { parseSlackInteraction } from "./slack-actions";
import { agreementChoices, agreementForm, checkAgreementCommand, checkAgreementSubmit, requestAgreement } from "./agreement-request";
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
    expect(agreementChoices({ "agreements.list": JSON.stringify([{ label: "Deposit agreement", template: "T-DEP" }, { label: "", template: "x" }, { label: "Full", template: "T-FULL" }]) }))
      .toEqual([{ label: "Deposit agreement", template: "T-DEP" }, { label: "Full", template: "T-FULL" }]);
    expect(agreementChoices({ "crm.agreement_template": "T-ONE" })).toEqual([{ label: "Purchase agreement", template: "T-ONE" }]);
    expect(agreementChoices({ "agreements.list": "not json", "crm.agreement_template": "T-ONE" })).toEqual([{ label: "Purchase agreement", template: "T-ONE" }]);
    expect(agreementChoices({})).toEqual([]);
  });
  it("the form sent back gives what was typed and what was picked", () => {
    const view = agreementForm([{ label: "Full", template: "T-FULL" }], { channel: "C1" });
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
      await c.query("update companies set mode='live' where id=$1", [co]);
      await c.query("insert into engine_state (key, value, updated_at) values ($1, $2, now()) on conflict (key) do update set value=excluded.value", [`scheduler:${co}`, { last_tick: new Date().toISOString() }]);
    });
    await unlockSendsForTest(co);
  });
  afterAll(wipe);

  const bindings = () => asOperator(async (c) => (await loadCompany(c, co)).bindings);

  it("only closers, managers and the operator get the form; a bad pick or an unknown person is said in the form", async () => {
    const b = await bindings();
    expect(await asOperator((c) => checkAgreementCommand(c, co, "U-ST", b))).toEqual({ error: "Only closers, managers and the operator can send agreements." });
    expect(await asOperator((c) => checkAgreementCommand(c, co, "U-CY", b))).toMatchObject({ choices: [{ template: "T-DEP" }, { template: "T-FULL" }] });
    expect(await asOperator((c) => checkAgreementSubmit(c, co, "U-CY", b, "rae@example.com", "T-ELSE"))).toEqual({ errors: { which: "Pick one of the agreements." } });
    expect(await asOperator((c) => checkAgreementSubmit(c, co, "U-CY", b, "nobody@example.com", "T-FULL"))).toMatchObject({ errors: { who: expect.stringContaining("No one in the CRM") } });
  });

  it("a closer's request sends the agreement they picked, from them, at once; the note says so; they are told in a DM", async () => {
    const b = await bindings();
    const ok = await asOperator((c) => checkAgreementSubmit(c, co, "U-CY", b, "Rae@Example.com", "T-FULL"));
    if ("errors" in ok) throw new Error(JSON.stringify(ok.errors));
    const said = await requestAgreement(fake, co, "U-CY", ok.contact, ok.choice, ok.by);
    expect(said).toBe("✅ Full agreement sent to Rae Lee.");
    expect(sentDocs.at(-1)).toEqual({ templateId: "T-FULL", contactId: "GHLRAE00000000000AG", userId: "GU-CY" });
    expect(dms.at(-1)).toEqual({ to: "U-CY", text: said });
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
    expect(await asOperator((c) => many(c, "select 1 from events where company_id=$1 and event_type='agreement.requested'", [co]))).toHaveLength(3);
  });
});
