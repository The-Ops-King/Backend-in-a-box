/** D227: a recording on the wrong person is moved, and what it set off on them is put back; the read-only check of links against the rules. */
import { describe, it, expect, beforeAll } from "vitest";
import { asOperator, one, many } from "@/db/client";
import { migrate } from "@/db/migrate";
import { encrypt } from "./crypto";
import { fakeAdapters } from "./test-install";
import { checkRecordings, relinkRecording } from "./recording-relink";
import type { Adapters } from "@/adapters/types";

process.env.BINDINGS_KEY ??= Buffer.alloc(32, 7).toString("base64");
const SLUG = `relink-${Date.now()}`;   // its own company each run: runs and events point at each other, so nothing is cleared
const T = new Date("2026-10-22T21:04:03Z");
let companyId: string, corina: string, beth: string, apptC: string, apptB: string, recId: string, runId: string;
const calls: string[] = [];
const base = fakeAdapters();
const fake: Adapters = {
  ...base,
  read: { ...base.read, contactNotes: async (_c, id) => (id === "G-COR" ? [{ id: "note-1", body: "CALL SUMMARY — 2026-10-22\nBeth pays", dateAdded: "2026-10-22T22:12:01.000Z" }] : []) },
  write: { ...base.write,
    deleteNote: async (_c, contact, note) => { calls.push(`deleteNote ${contact} ${note}`); },
    deleteRecord: async (_c, object, id) => { calls.push(`deleteRecord ${object} ${id}`); },
    removeTag: async (_c, contact, tag) => { calls.push(`removeTag ${contact} ${tag}`); },
    updateOpportunity: async (_c, id, patch) => { calls.push(`updateOpportunity ${id} ${patch.stageId} ${patch.status}`); } },
  notifier: { ...base.notifier, update: async (_t, ch, ts, text) => { calls.push(`update ${ch} ${ts} ${text}`); }, unreact: async (_t, ch, ts, emoji) => { calls.push(`unreact ${ch} ${ts} ${emoji}`); return true; } },
  recorder: { transcript: async () => [{ speaker: "Cal", email: "closer@relink.test", text: "hi" }, { speaker: "Elizabeth Huffman", text: "hi" }] },
};

describe.skipIf(!process.env.DATABASE_URL)("moving a recording off the wrong person (D227)", () => {
  beforeAll(async () => {
    await migrate();
    await asOperator(async (c) => {
      companyId = (await one<{ id: string }>(c, "insert into companies (name, slug, timezone) values ('Relink',$1,'America/New_York') returning id", [SLUG]))!.id;
      await c.query(`insert into company_terms (company_id, domain, name, category, is_default, sort) select $1, domain, label, value, true, sort from core_categories`, [companyId]);
      await c.query("insert into bindings (company_id, key, kind, value) values ($1,'secret.fathom_api_key','secret',$2)", [companyId, encrypt("fk")]);
      await c.query("insert into slack_connections (company_id, team_id, bot_token, channels) values ($1,'T1',$2,'{}')", [companyId, encrypt("xoxb-fake")]);
      const closer = (await one<{ id: string }>(c, "insert into users (company_id, email, name, role) values ($1,'closer@relink.test','Cal Closer','closer') returning id", [companyId]))!.id;
      corina = (await one<{ id: string }>(c, "insert into contacts (company_id, ghl_contact_id, first_name, last_name, tags) values ($1,'G-COR','Corina','Raducanu','{stat-showed,dating}') returning id", [companyId]))!.id;
      beth = (await one<{ id: string }>(c, "insert into contacts (company_id, ghl_contact_id, first_name, last_name) values ($1,'G-BETH','Beth','Huffman') returning id", [companyId]))!.id;
      await c.query("insert into contact_identifiers (company_id, contact_id, kind, value) values ($1,$2,'email','corina@x.com'),($1,$3,'email','elizabethahuffman@gmail.com')", [companyId, corina, beth]);
      const term = (await one<{ id: string }>(c, "select id from company_terms where company_id=$1 and domain='appointment_type' and category='closing'", [companyId]))!.id;
      const cal = (await one<{ id: string }>(c, "insert into calendars (company_id, source, external_id, name, appointment_term) values ($1,'ghl','CAL','Closer',$2) returning id", [companyId, term]))!.id;
      const showed = (await one<{ id: string }>(c, "select id from company_terms where company_id=$1 and domain='appointment_outcome' and category='showed'", [companyId]))!.id;
      const closed = (await one<{ id: string }>(c, "select id from company_terms where company_id=$1 and domain='call_outcome' and category='closed'", [companyId]))!.id;
      const opp = (await one<{ id: string }>(c, "insert into opportunities (company_id, contact_id, opened_by) values ($1,$2,'test') returning id", [companyId, corina]))!.id;
      apptC = (await one<{ id: string }>(c, "insert into appointments (company_id, contact_id, opportunity_id, source, external_id, calendar_id, appointment_term, assigned_user_id, starts_at, ends_at, booked_at, status, outcome_term, call_outcome_term, dispositioned_at) values ($1,$2,$3,'ghl','A-COR',$4,$5,$6,'2026-10-22T20:00Z','2026-10-22T20:15Z',now(),'confirmed',$7,$8,now()) returning id", [companyId, corina, opp, cal, term, closer, showed, closed]))!.id;
      apptB = (await one<{ id: string }>(c, "insert into appointments (company_id, contact_id, source, external_id, calendar_id, appointment_term, assigned_user_id, starts_at, ends_at, booked_at, status) values ($1,$2,'ghl','A-BETH',$3,$4,$5,'2026-10-22T21:00Z','2026-10-22T22:00Z',now(),'confirmed') returning id", [companyId, beth, cal, term, closer]))!.id;
      await c.query("insert into pipeline_cards (company_id, opportunity_id, contact_id, ghl_opportunity_id, ghl_pipeline_id, ghl_stage_id, name, status) values ($1,$2,$3,'OPP-COR','PIPE','STAGE-SHOWED','Corina -- Direct','won')", [companyId, opp, corina]);
      recId = (await one<{ id: string }>(c, "insert into recordings (company_id, contact_id, appointment_id, provider, external_id, title, started_at, recorded_by_email, invitees, link_status, linked_by) values ($1,$2,$3,'fathom','F-1','Corina Raducanu and Cal',$4,'closer@relink.test',$5,'linked','email') returning id",
        [companyId, corina, apptC, T, JSON.stringify([{ name: "corina@x.com", email: "corina@x.com", isExternal: true }, { name: "Cal", email: "closer@relink.test", isExternal: false }])]))!.id;
      // the Sales call recorded run on Corina, and its footprint
      const wf = (await one<{ id: string }>(c, "insert into workflows (company_id, name, reentry_policy, enabled) values ($1,'Sales call recorded','always',true) returning id", [companyId]))!.id;
      await c.query("insert into workflow_versions (workflow_id, version, definition, manifest) values ($1,1,$2,'{}')", [wf, { schema: 1, nodes: [{ id: "o4", type: "slack_post", react: "white_check_mark", thread_of: "tag:appointment:{{appointment.id}}" }], edges: [] }]);
      const ev = (await one<{ id: string }>(c, "insert into events (company_id, contact_id, appointment_id, event_type, source, data, occurred_at) values ($1,$2,$3,'recording.received','fathom',$4,now()) returning id", [companyId, corina, apptC, { recording_id: recId }]))!.id;
      runId = (await one<{ id: string }>(c, "insert into runs (company_id, workflow_id, workflow_version, contact_id, appointment_id, triggered_by_event, status, reentry_key, started_at) values ($1,$2,1,$3,$4,$5,'completed','k','2026-10-22T22:05:56Z') returning id", [companyId, wf, corina, apptC, ev]))!.id;
      await c.query("insert into events (company_id, contact_id, appointment_id, run_id, event_type, source, data, occurred_at) values ($1,$2,$3,$4,'appointment.outcome','engine',$5,now()),($1,$2,null,$4,'tag.added','engine',$6,now())", [companyId, corina, apptC, runId, { outcome: "showed", previous_outcome: null, previous_call_outcome: null }, { tag: "stat-showed" }]);
      await c.query("insert into run_steps (run_id, node_id, node_type, status, result) values ($1,'o3','pipeline_card','ok',$2),($1,'o4','slack_post','ok','{}')", [runId, { card: "moved", from_stage: "STAGE-BOOKED", crm_card: "OPP-COR", stage: "STAGE-SHOWED" }]);
      await c.query("insert into crm_records (company_id, object_key, record_key, ghl_record_id, contact_id, properties, adopted, created_at, updated_at) values ($1,'custom_objects.sales_call','A-COR','REC-COR',$2,'{}',false,'2026-10-22T23:00:12Z','2026-10-22T23:00:12Z')", [companyId, corina]);
      await c.query("insert into step_effects (company_id, run_id, node_id, kind, external_id, done_at) values ($1,$2,'r1','record','REC-COR',now()),($1,$2,'n1','note',null,'2026-10-22T22:12:01.043Z')", [companyId, runId]);
      await c.query("insert into slack_posts (company_id, tag, channel, ts, run_id) values ($1,$2,'C-BOOK','1.1',null),($1,$3,'C-BOOK','1.2',$4),($1,$5,'C-CALLS','2.1',$4)", [companyId, `appointment:${apptC}`, `showed:${apptC}`, runId, `recording:${recId}`]);
    });
  });

  it("the dry run names every part, writes nothing; the move puts Corina back and links Beth's booking", async () => {
    const dry = await asOperator((c) => relinkRecording(c, fake, { company: SLUG, recording: recId, to: "rules", why: "Beth's call, not Corina's" }));
    expect(dry).toMatchObject({ ok: true, dryRun: true, from: { contact: corina, name: "Corina Raducanu", appointment: apptC }, to: { contact: beth, name: "Beth Huffman", appointment: apptB, by: "speaker" } });
    if (!dry.ok) return;
    const said = dry.undo.map((u) => u.what);
    expect(said[0]).toMatch(/delete the record REC-COR \(custom_objects.sales_call\) it made on Corina Raducanu/);   // what the runs made goes first
    expect(said).toEqual(expect.arrayContaining([
      "Corina Raducanu's booking: outcome back to none, call outcome back to none",
      "Corina Raducanu: tag stat-showed off",
      expect.stringMatching(/Corina Raducanu's card "Corina -- Direct": back to the stage it came from \(STAGE-BOOKED\), open/),
      expect.stringMatching(/delete the call note on Corina Raducanu \(CALL SUMMARY/),
      "take the :white_check_mark: off Corina Raducanu's booking post",
      expect.stringMatching(/edit 2 Slack posts to: ~This call was not Corina Raducanu's.~ It is Beth Huffman's/),
    ]));
    expect(calls).toEqual([]);

    const done = await asOperator((c) => relinkRecording(c, fake, { company: SLUG, recording: recId, to: "rules", why: "Beth's call, not Corina's", dryRun: false }));
    expect(done).toMatchObject({ ok: true, dryRun: false });
    if (!done.ok) return;
    expect(done.undo.filter((u) => u.error)).toEqual([]);
    expect(calls).toEqual(expect.arrayContaining(["deleteRecord custom_objects.sales_call REC-COR", "removeTag G-COR stat-showed", "updateOpportunity OPP-COR STAGE-BOOKED open", "deleteNote G-COR note-1", "unreact C-BOOK 1.1 white_check_mark",
      expect.stringMatching(/^update C-BOOK 1.2 ~This call was not Corina/), expect.stringMatching(/^update C-CALLS 2.1 ~This call was not Corina/)]));
    expect(await asOperator((c) => one(c, "select outcome_term, call_outcome_term, dispositioned_at from appointments where id=$1", [apptC]))).toEqual({ outcome_term: null, call_outcome_term: null, dispositioned_at: null });
    expect(await asOperator((c) => one(c, "select tags from contacts where id=$1", [corina]))).toEqual({ tags: ["dating"] });
    expect(await asOperator((c) => one(c, "select ghl_stage_id, status from pipeline_cards where ghl_opportunity_id='OPP-COR'"))).toEqual({ ghl_stage_id: "STAGE-BOOKED", status: "open" });
    expect(await asOperator((c) => many(c, "select 1 from crm_records where ghl_record_id='REC-COR'"))).toHaveLength(0);
    expect(await asOperator((c) => one(c, "select contact_id, appointment_id, link_status, linked_by from recordings where id=$1", [recId]))).toEqual({ contact_id: beth, appointment_id: apptB, link_status: "linked", linked_by: "speaker" });
    expect(await asOperator((c) => one(c, "select contact_id, appointment_id from events where company_id=$1 and event_type='recording.received' order by id desc limit 1", [companyId]))).toEqual({ contact_id: beth, appointment_id: apptB });
    // the wrong invite is not remembered on Beth
    expect(await asOperator((c) => many<{ value: string }>(c, "select value from contact_identifiers where contact_id=$1 and kind='email'", [beth]))).toEqual([{ value: "elizabethahuffman@gmail.com" }]);
    expect(await asOperator((c) => one(c, "select action from audit_log where company_id=$1 and target_id=$2 and action='recording.relinked'", [companyId, recId]))).toEqual({ action: "recording.relinked" });
    // already there: refused
    expect(await asOperator((c) => relinkRecording(c, fake, { company: SLUG, recording: recId, to: "rules", why: "again" }))).toMatchObject({ ok: false, status: 409 });
  });

  it("a run that stopped before the Showed step takes nothing off the booking post (the ✅ there is the real call's)", async () => {
    const r2 = await asOperator(async (c) => {
      const wf = (await one<{ id: string }>(c, "select workflow_id as id from runs where id=$1", [runId]))!.id;
      const rec = (await one<{ id: string }>(c, "insert into recordings (company_id, contact_id, appointment_id, provider, external_id, title, started_at, recorded_by_email, invitees, transcript, link_status, linked_by) values ($1,$2,$3,'fathom','F-3','Impromptu','2026-10-22T22:20Z','closer@relink.test','[]',$4,'linked','calendar') returning id",
        [companyId, beth, apptB, JSON.stringify([{ speaker: "Cal", email: "closer@relink.test", text: "hi" }, { speaker: "Beth Huffman", text: "hi" }])]))!.id;
      const ev = (await one<{ id: string }>(c, "insert into events (company_id, contact_id, appointment_id, event_type, source, data, occurred_at) values ($1,$2,$3,'recording.received','fathom',$4,now()) returning id", [companyId, beth, apptB, { recording_id: rec }]))!.id;
      const run = (await one<{ id: string }>(c, "insert into runs (company_id, workflow_id, workflow_version, contact_id, appointment_id, triggered_by_event, status, exit_reason, reentry_key, started_at) values ($1,$2,1,$3,$4,$5,'completed','not_a_sales_call','k2',now()) returning id", [companyId, wf, beth, apptB, ev]))!.id;
      await c.query("insert into run_steps (run_id, node_id, node_type, status) values ($1,'c1','check','ok')", [run]);
      await c.query("insert into slack_posts (company_id, tag, channel, ts) values ($1,$2,'C-BOOK','3.1') on conflict do nothing", [companyId, `appointment:${apptB}`]);
      return rec;
    });
    const dry = await asOperator((c) => relinkRecording(c, fake, { company: SLUG, recording: r2, to: "none", why: "Audra's coaching call" }));
    expect(dry).toMatchObject({ ok: true, undo: [], kept: [] });
  });

  it("no transcript from Fathom: the move by the rules is refused, not made on the invite alone; the check says it could not look", async () => {
    const silent: Adapters = { ...fake, recorder: { transcript: async () => null } };
    const rec = await asOperator(async (c) => (await one<{ id: string }>(c, "insert into recordings (company_id, contact_id, provider, external_id, title, started_at, recorded_by_email, invitees, link_status, linked_by) values ($1,$2,'fathom','F-4','Quiet','2026-10-21T15:00Z','closer@relink.test','[]','linked','email') returning id", [companyId, beth]))!.id);
    expect(await asOperator((c) => relinkRecording(c, silent, { company: SLUG, recording: rec, to: "rules", why: "x" }))).toMatchObject({ ok: false, status: 409, error: expect.stringMatching(/no transcript/) });
    const r = await asOperator((c) => checkRecordings(c, silent, companyId, new Date("2026-10-21T00:00Z"), new Date("2026-10-21T23:00Z")));
    expect(r).toMatchObject({ checked: 1, differ: [], unread: [expect.stringMatching(/Quiet\): no transcript from Fathom, so it was not checked/)] });
  });

  it("the check lists a link the rules would not make, and only that", async () => {
    const roleplay = await asOperator(async (c) => (await one<{ id: string }>(c, "insert into recordings (company_id, contact_id, appointment_id, provider, external_id, title, started_at, recorded_by_email, invitees, transcript, link_status, linked_by) values ($1,$2,$3,'fathom','F-2','Roleplay/training','2026-10-22T20:05Z','closer@relink.test','[]',$4,'linked','calendar') returning id",
      [companyId, beth, apptB, JSON.stringify([{ speaker: "Cal", email: "closer@relink.test", text: "you be the client" }, { speaker: "Cal Closer", text: "ok" }])]))!.id);
    const r = await asOperator((c) => checkRecordings(c, fake, companyId, new Date("2026-10-22T00:00Z"), new Date("2026-10-23T00:00Z")));
    expect(r.checked).toBe(3);
    // the 22:20 call after Beth's booking ended is that booking held late (D236), as it is linked: not listed
    expect(r.differ).toEqual([expect.objectContaining({ id: roleplay, now: "Beth Huffman", rules: "internal: no one", why: expect.stringMatching(/only the team spoke/) })]);
  });
});
