/** D233: the operator sets one contact's GHL fields (by binding or id) and marks their deal won in the engine; dry run first, audited. */
import { describe, it, expect, beforeAll } from "vitest";
import { asOperator, one } from "@/db/client";
import { migrate } from "@/db/migrate";
import { installCompany } from "./install";
import { contactFields, contactMerged, opportunityStatus } from "./contact-ops";
import { fakeAdapters } from "./test-install";
import type { Adapters } from "@/adapters/types";

process.env.BINDINGS_KEY ??= Buffer.alloc(32, 7).toString("base64");
const SLUG = `d233-${Date.now()}`;
const writes: unknown[] = [];
const base = fakeAdapters();
const fake: Adapters = { ...base, write: { ...base.write, updateContact: async (_c, id, patch) => { writes.push({ id, patch }); } } };
let co = "", ct = "";

describe.skipIf(!process.env.DATABASE_URL)("D233: contact fields and deal status", () => {
  beforeAll(async () => {
    await migrate();
    co = (await installCompany({ name: "D233", slug: SLUG, timezone: "America/New_York", locationId: "LOC-D233", pit: "pit-fake", calendars: {}, templates: [] }, fake)).companyId;
    await asOperator(async (c) => {
      await c.query("insert into bindings (company_id, key, kind, value) values ($1,'crm.field_contact_cash_collected','id',convert_to('F-CASH','UTF8'))", [co]);
      ct = (await one<{ id: string }>(c, "insert into contacts (company_id, ghl_contact_id, first_name, ghl_fields) values ($1,'GJ','Jen','{\"F-CASH\":9750}') returning id", [co]))!.id;
      await c.query("insert into opportunities (company_id, contact_id, opened_by, contract_value) values ($1,$2,'payment',10000)", [co, ct]);
    });
  });

  it("fields: a dry run says was and to and writes nothing; applied, GHL and the replica both change; an unbound binding is refused", async () => {
    const dry = await asOperator((c) => contactFields(c, fake, { company: SLUG, contact: "GJ", fields: { "crm.field_contact_cash_collected": 10000 }, why: "t" }));
    expect(dry).toMatchObject({ ok: true, dryRun: true, fields: [{ id: "F-CASH", was: 9750, to: "10000" }] });
    expect(writes).toEqual([]);
    await asOperator((c) => contactFields(c, fake, { company: SLUG, contact: "GJ", fields: { "crm.field_contact_cash_collected": 10000 }, why: "t", dryRun: false }));
    expect(writes).toEqual([{ id: "GJ", patch: { customFields: [{ id: "F-CASH", field_value: "10000" }] } }]);
    expect(await asOperator((c) => one(c, "select ghl_fields->'F-CASH' as v from contacts where id=$1", [ct]))).toEqual({ v: 10000 });
    expect(await asOperator((c) => contactFields(c, fake, { company: SLUG, contact: "GJ", fields: { "crm.field_contact_revenue_generated": 1 }, why: "t" }))).toMatchObject({ ok: false, status: 400 });
  });

  it("deal: marked won at the time given", async () => {
    expect(await asOperator((c) => opportunityStatus(c, { company: SLUG, contact: "GJ", status: "won", at: "2026-10-23T00:04:34Z", why: "t", dryRun: false }))).toMatchObject({ ok: true, was: "open", to: "won" });
    expect(await asOperator((c) => one(c, "select status, won_at from opportunities where contact_id=$1", [ct]))).toEqual({ status: "won", won_at: new Date("2026-10-23T00:04:34Z") });
  });

  it("D240: a named merge is followed only once GHL has dropped the gone one; its booking moves and it is kept as merged", async () => {
    const crm = new Map([["GKEEP", { id: "GKEEP", firstName: "Alma", tags: [], customFields: {}, dateUpdated: "2026-10-20T00:00:00Z", dateAdded: "2026-10-01T00:00:00Z" }], ["GDUP", { id: "GDUP", firstName: "Alma", tags: [], customFields: {}, dateUpdated: "2026-10-20T00:00:00Z", dateAdded: "2026-10-01T00:00:00Z" }]]);
    const ghl = fakeAdapters({ crm });
    const [keep, dup] = await asOperator(async (c) => {
      const k = (await one<{ id: string }>(c, "insert into contacts (company_id, ghl_contact_id, first_name) values ($1,'GKEEP','Alma') returning id", [co]))!.id;
      const d = (await one<{ id: string }>(c, "insert into contacts (company_id, ghl_contact_id, first_name) values ($1,'GDUP','Alma') returning id", [co]))!.id;
      const term = (await one<{ id: string }>(c, "insert into company_terms (company_id, domain, name, category, is_default, sort) values ($1,'appointment_type','Closing','closing',true,1) on conflict do nothing returning id", [co]))?.id
        ?? (await one<{ id: string }>(c, "select id from company_terms where company_id=$1 and domain='appointment_type' limit 1", [co]))!.id;
      await c.query("insert into appointments (company_id, contact_id, source, external_id, appointment_term, starts_at, ends_at, booked_at, status) values ($1,$2,'calendly','EV-DUP',$3,now(),now(),now(),'confirmed')", [co, d, term]);
      return [k, d];
    });
    const go = (dryRun: boolean) => asOperator((c) => contactMerged(c, ghl, { company: SLUG, gone: "GDUP", into: "GKEEP", why: "t", dryRun }));
    expect(await go(true)).toMatchObject({ ok: false, status: 409 });   // still in GHL
    crm.delete("GDUP");
    expect(await go(true)).toMatchObject({ ok: true, dryRun: true, moves: { appointments: 1 } });
    expect(await go(false)).toMatchObject({ ok: true, dryRun: false });
    expect(await asOperator((c) => one(c, "select contact_id from appointments where external_id='EV-DUP' and company_id=$1", [co]))).toEqual({ contact_id: keep });
    expect(await asOperator((c) => one(c, "select merged_into from contacts where id=$1", [dup]))).toEqual({ merged_into: keep });
  });
});
