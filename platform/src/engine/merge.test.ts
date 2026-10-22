/** D222: a contact GHL merged away is followed to the one it became, only when that is certain. */
import { describe, it, expect, beforeAll } from "vitest";
import { DateTime } from "luxon";
import { asOperator, one, many } from "@/db/client";
import { migrate } from "@/db/migrate";
import { followMerge } from "./merge";
import { refreshContact } from "./contact-truth";
import { loadCompany } from "./context";
import { fakeAdapters } from "./test-install";
import type { Adapters, ContactSnapshot } from "@/adapters/types";

process.env.BINDINGS_KEY ??= Buffer.alloc(32, 7).toString("base64");
const TZ = "America/New_York";
let companyId = "", term = "";
const crm = new Map<string, ContactSnapshot>();
const byEmail = new Map<string, string[]>();
const snap = (id: string, email: string): ContactSnapshot => ({ id, email, firstName: "Lyric", lastName: "B", tags: [], customFields: {}, dateUpdated: "2026-10-20T00:00:00Z", dateAdded: "2026-10-01T00:00:00Z" });
const base = fakeAdapters({ crm });
const fake: Adapters = { ...base, read: { ...base.read, contactsByEmail: async (_c, e) => (byEmail.get(e) ?? []).map((id) => crm.get(id)).filter((x): x is ContactSnapshot => !!x) } };

async function person(ghl: string, email: string, phone?: string) {
  return asOperator(async (c) => {
    const id = (await one<{ id: string }>(c, "insert into contacts (company_id, ghl_contact_id, first_name, last_name) values ($1,$2,'Lyric','B') returning id", [companyId, ghl]))!.id;
    await c.query("insert into contact_identifiers (company_id, contact_id, kind, value) values ($1,$2,'ghl_contact',$3),($1,$2,'email',$4)", [companyId, id, ghl, email]);
    if (phone) await c.query("insert into contact_identifiers (company_id, contact_id, kind, value) values ($1,$2,'phone',$3)", [companyId, id, phone]);
    return id;
  });
}
async function booking(contact: string, ext: string) {
  return asOperator(async (c) => {
    const at = DateTime.fromISO("2026-10-21T19:30", { zone: TZ });
    const id = (await one<{ id: string }>(c, "insert into appointments (company_id, contact_id, source, external_id, appointment_term, starts_at, ends_at, booked_at, status) values ($1,$2,'calendly',$3,$4,$5,$5,now(),'cancelled') returning id", [companyId, contact, ext, term, at.toJSDate()]))!.id;
    await c.query("insert into crm_records (company_id, object_key, record_key, ghl_record_id, contact_id, properties) values ($1,'custom_objects.sales_call',$2,$3,$4,'{}')", [companyId, ext, `REC-${ext}`, contact]);
    return id;
  });
}

describe.skipIf(!process.env.DATABASE_URL)("D222: following a merge in GHL", () => {
  beforeAll(async () => {
    await migrate();
    await asOperator(async (c) => {
      companyId = (await one<{ id: string }>(c, "insert into companies (name, slug, timezone) values ('D222',$2,$1) returning id", [TZ, `d222-${Date.now()}`]))!.id;
      await c.query("insert into company_terms (company_id, domain, name, category, is_default, sort) select $1, domain, label, value, true, sort from core_categories", [companyId]);
      term = (await one<{ id: string }>(c, "select id from company_terms where company_id=$1 and domain='appointment_type' and category='closing'", [companyId]))!.id;
    });
  });

  it("one live GHL contact has the gone one's email: its calls, records and email move there, the gone one is kept as merged into it", async () => {
    const gone = await person("G-OLD", "lyric@gmail.test"), live = await person("G-NEW", "lyric@yahoo.test");
    const appt = await booking(gone, "EVT-1");
    crm.set("G-NEW", snap("G-NEW", "lyric@yahoo.test")); byEmail.set("lyric@gmail.test", ["G-NEW"]);   // GHL kept the old address on the survivor
    await asOperator((c) => c.query("update contacts set gone_at=now() where id=$1", [gone]));
    const { adapterCompany } = await asOperator((c) => loadCompany(c, companyId));
    const r = await asOperator((c) => followMerge(c, companyId, TZ, adapterCompany, fake, gone));
    expect(r).toMatchObject({ folded: true, into: { id: live, ghl_contact_id: "G-NEW" }, moved: { appointments: 1, crm_records: 1, identifiers: 1 } });
    expect(await asOperator((c) => one(c, "select contact_id from appointments where id=$1", [appt]))).toEqual({ contact_id: live });
    expect(await asOperator((c) => one(c, "select merged_into from contacts where id=$1", [gone]))).toEqual({ merged_into: live });
    expect((await asOperator((c) => many<{ value: string }>(c, "select value from contact_identifiers where contact_id=$1 and kind='email' order by value", [live]))).map((x) => x.value)).toEqual(["lyric@gmail.test", "lyric@yahoo.test"]);
    expect(await asOperator((c) => one(c, "select after->>'into' as into from audit_log where company_id=$1 and action='contact.merged'", [companyId]))).toEqual({ into: live });
  });

  it("not certain, nothing moves: two live contacts have its email, or none has", async () => {
    const gone = await person("G-OLD2", "two@gmail.test");
    await person("G-A", "a@x.test"); await person("G-B", "b@x.test");
    crm.set("G-A", snap("G-A", "a@x.test")); crm.set("G-B", snap("G-B", "b@x.test")); byEmail.set("two@gmail.test", ["G-A", "G-B"]);
    const appt = await booking(gone, "EVT-2");
    const { adapterCompany } = await asOperator((c) => loadCompany(c, companyId));
    expect(await asOperator((c) => followMerge(c, companyId, TZ, adapterCompany, fake, gone))).toEqual({ folded: false, why: "2 live GHL contacts share its email, so which one it became is not certain" });
    expect(await asOperator((c) => one(c, "select contact_id from appointments where id=$1", [appt]))).toEqual({ contact_id: gone });
    const alone = await person("G-OLD3", "nobody@gmail.test");
    expect(await asOperator((c) => followMerge(c, companyId, TZ, adapterCompany, fake, alone))).toEqual({ folded: false, why: "no live GHL contact has its email" });
  });

  it("the live check before a run acts: a contact GHL merged away is followed and no alert is raised; one it cannot follow is the alert, saying why", async () => {
    const gone = await person("G-OLD4", "four@gmail.test"), live = await person("G-NEW4", "four@yahoo.test");
    crm.set("G-NEW4", snap("G-NEW4", "four@yahoo.test")); byEmail.set("four@gmail.test", ["G-NEW4"]);
    const lc = await asOperator((c) => loadCompany(c, companyId));
    expect(await asOperator((c) => refreshContact(c, lc.row, lc.adapterCompany, fake, lc.bindings, gone, DateTime.now()))).toEqual({ ok: false, why: "contact gone" });
    expect(await asOperator((c) => one(c, "select merged_into from contacts where id=$1", [gone]))).toEqual({ merged_into: live });
    expect(await asOperator((c) => one(c, "select 1 from alerts where company_id=$1 and key=$2 and resolved_at is null", [companyId, `contact:gone:${gone}`]))).toBeFalsy();
    const lost = await person("G-OLD5", "five@gmail.test");
    await asOperator((c) => refreshContact(c, lc.row, lc.adapterCompany, fake, lc.bindings, lost, DateTime.now()));
    expect(await asOperator((c) => one<{ text: string }>(c, "select text from alerts where company_id=$1 and key=$2 and resolved_at is null", [companyId, `contact:gone:${lost}`]))).toMatchObject({ text: expect.stringMatching(/Not followed to another contact: no live GHL contact has its email\.$/) });
  });
});
