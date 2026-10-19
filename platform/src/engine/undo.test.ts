/** D142: the operator takes back what a run made in GHL (from the engine's ledger of what it created, never what it found or a record GHL made), and removes a test contact, never anyone else. */
import { describe, it, expect, beforeAll } from "vitest";
import { asOperator, many, one } from "@/db/client";
import { migrate } from "@/db/migrate";
import { installCompany } from "@/engine/install";
import { undoRunWrites } from "@/engine/undo";
import { removeTestContact, contactTags } from "@/engine/contact-ops";
import { fakeAdapters } from "@/engine/test-install";
import type { Adapters } from "@/adapters/types";

process.env.BINDINGS_KEY ??= Buffer.alloc(32, 7).toString("base64");
const SLUG = `d142-${Date.now()}`, OBJ = "custom_objects.sales_call";
const gone: string[] = [], tagOps: string[] = [];
const base = fakeAdapters();
const fake: Adapters = { ...base, write: { ...base.write,
  deleteOpportunity: async (_c, id) => { gone.push(`card:${id}`); }, deleteTask: async (_c, ct, id) => { gone.push(`task:${ct}/${id}`); }, deleteRecord: async (_c, o, id) => { gone.push(`record:${o}/${id}`); }, deleteContact: async (_c, id) => { gone.push(`contact:${id}`); },
  addTag: async (_c, id, t) => { tagOps.push(`+${id}:${t}`); }, removeTag: async (_c, id, t) => { tagOps.push(`-${id}:${t}`); } } };
let co = "", run = "", lee = "", tess = "";

describe.skipIf(!process.env.DATABASE_URL)("D142: undo a run's writes; remove a test contact", () => {
  beforeAll(async () => {
    await migrate();
    co = (await installCompany({ name: "Undo", slug: SLUG, timezone: "America/New_York", locationId: "LOC-D142", pit: "pit-fake", calendars: {}, templates: [], testDomains: ["jtylerray.com"] }, fake)).companyId;
    await asOperator(async (c) => {
      lee = (await one<{ id: string }>(c, "insert into contacts (company_id, ghl_contact_id, first_name, tags) values ($1,'GC-LEE','Lee',array['dating','stat-new','rc old']) returning id", [co]))!.id;
      tess = (await one<{ id: string }>(c, "insert into contacts (company_id, ghl_contact_id, first_name) values ($1,'GC-TESS','Tess') returning id", [co]))!.id;
      await c.query("insert into contact_identifiers (company_id, contact_id, kind, value) values ($1,$2,'email','tess@jtylerray.com'),($1,$3,'email','lee@gmail.com')", [co, tess, lee]);
      const wf = (await one<{ id: string }>(c, "insert into workflows (company_id, name, reentry_policy, enabled) values ($1,'Booked','always',true) returning id", [co]))!.id;
      run = (await one<{ id: string }>(c, "insert into runs (company_id, workflow_id, workflow_version, contact_id, status, born_in, reentry_key) values ($1,$2,1,$3,'completed','quiet','undo-test') returning id", [co, wf, lee]))!.id;
      for (const [node, kind, ext] of [["c_new", "card", "OPP-1"], ["k3", "task", "TASK-1"], ["k4", "record", "SC-1"], ["k9", "record", "SC-GHL"], ["n_note", "note", "NOTE-1"]])
        await c.query("insert into step_effects (company_id, run_id, node_id, kind, external_id, done_at) values ($1,$2,$3,$4,$5,now())", [co, run, node, kind, ext]);
      await c.query("insert into crm_records (company_id, object_key, record_key, ghl_record_id, contact_id) values ($1,$2,'SLOT','SC-1',$3)", [co, OBJ, lee]);
      await c.query("insert into crm_records (company_id, object_key, record_key, ghl_record_id, contact_id, adopted) values ($1,$2,'SLOT2','SC-GHL',$3,true)", [co, OBJ, lee]);
    });
  });

  it("a dry run lists the card, the task and the record the run made; a record GHL made and a note are kept; the real one deletes them, narrowed to the steps named, and audits each", async () => {
    const dry = await asOperator((c) => undoRunWrites(c, fake, { company: SLUG, runs: [run], why: "triage is not a closing call" }));
    expect(dry).toMatchObject({ ok: true, dryRun: true, writes: [{ node_id: "c_new", kind: "card", external_id: "OPP-1" }, { node_id: "k3", kind: "task", external_id: "TASK-1" }, { node_id: "k4", kind: "record", external_id: "SC-1", object: OBJ }] });
    expect((dry as { kept: string[] }).kept).toEqual([expect.stringMatching(/^k9: record SC-GHL \(taken over from GHL\)/), expect.stringMatching(/^n_note: the note NOTE-1/)]);
    expect(gone).toEqual([]);
    await asOperator((c) => undoRunWrites(c, fake, { company: SLUG, runs: [run], nodes: ["c_new", "k3", "k4"], why: "triage is not a closing call", dryRun: false }));
    expect(gone).toEqual(["card:OPP-1", "task:GC-LEE/TASK-1", `record:${OBJ}/SC-1`]);
    expect(await asOperator((c) => many(c, "select record_key from crm_records where company_id=$1 order by record_key", [co]))).toEqual([{ record_key: "SLOT2" }]);
    expect((await asOperator((c) => many(c, "select 1 from audit_log where company_id=$1 and action='run.undone'", [co]))).length).toBe(3);
    // what was taken back is gone from the ledger: asked again, nothing
    expect(await asOperator((c) => undoRunWrites(c, fake, { company: SLUG, runs: [run], nodes: ["c_new", "k3", "k4"], why: "again" }))).toMatchObject({ writes: [] });
  });

  it("a test contact is removed from GHL and the engine; anyone else is refused; one contact's tags are taken off in GHL and the replica", async () => {
    expect(await asOperator((c) => removeTestContact(c, fake, { company: SLUG, contact: "GC-LEE", why: "test", dryRun: false }))).toMatchObject({ ok: false, status: 409 });
    expect(await asOperator((c) => removeTestContact(c, fake, { company: SLUG, contact: "GC-TESS", why: "test cleanup", dryRun: false }))).toMatchObject({ ok: true, who: "Tess" });
    expect(gone.at(-1)).toBe("contact:GC-TESS");
    expect(await asOperator((c) => one(c, "select gone_at is not null as gone from contacts where id=$1", [tess]))).toEqual({ gone: true });
    expect(await asOperator((c) => contactTags(c, fake, { company: SLUG, contact: "GC-LEE", remove: ["dating", "stat-new", "never-had"], why: "not in the offer", dryRun: false }))).toMatchObject({ ok: true, remove: ["dating", "stat-new"] });
    expect(tagOps).toEqual(["-GC-LEE:dating", "-GC-LEE:stat-new"]);
    expect(await asOperator((c) => one(c, "select tags from contacts where id=$1", [lee]))).toEqual({ tags: ["rc old"] });
  });
});
