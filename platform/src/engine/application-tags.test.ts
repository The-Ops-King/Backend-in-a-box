import { describe, expect, it } from "vitest";
import { APP_COMPLETE, APP_PARTIAL, NOT_BOOKED, peopleOf, personOf, tagChange } from "./application-tags";
import type { TfResponse } from "@/adapters/typeform/client";

const resp = (email: string | null, phone: string | null, at: string, first = "Ann"): TfResponse => ({ token: `${email}-${at}`, landed_at: at, submitted_at: at,
  answers: [{ field: { ref: "f" }, type: "text", text: first }, ...(phone ? [{ field: { ref: "p" }, type: "phone_number", phone_number: phone }] : []), ...(email ? [{ field: { ref: "e" }, type: "email", email }] : [])] });

describe("D250 application tags", () => {
  it("reads the person by the answers' types", () => {
    expect(personOf(resp("Ann@X.com", "+1 (602) 555-0101", "2026-10-01"))).toMatchObject({ email: "ann@x.com", name: "Ann" });
  });
  it("one submitted response makes the person complete, whichever came first; no email or phone is unidentified", () => {
    const { people, unidentified } = peopleOf([
      { r: resp("a@x.com", null, "2026-10-02"), status: "partial" }, { r: resp("a@x.com", null, "2026-10-01"), status: "complete" },
      { r: resp("b@x.com", null, "2026-10-01"), status: "partial" }, { r: resp(null, null, "2026-10-01"), status: "partial" },
    ]);
    expect(unidentified).toBe(1);
    expect(Object.fromEntries(people.map((p) => [p.key, [p.status, p.responses]]))).toEqual({ "a@x.com": ["complete", 2], "b@x.com": ["partial", 1] });
  });
  it("complete takes partial off; partial never goes on someone complete; not-booked follows the booking", () => {
    expect(tagChange([APP_PARTIAL], "complete", false)).toEqual({ add: [APP_COMPLETE, NOT_BOOKED], remove: [APP_PARTIAL] });
    expect(tagChange([APP_COMPLETE], "partial", true)).toEqual({ add: [], remove: [] });
    expect(tagChange([NOT_BOOKED], "partial", true)).toEqual({ add: [APP_PARTIAL], remove: [NOT_BOOKED] });
    expect(tagChange([APP_COMPLETE, NOT_BOOKED], "complete", false)).toEqual({ add: [], remove: [] });
  });
});

import { beforeAll } from "vitest";
import { asOperator, one } from "@/db/client";
import { migrate } from "@/db/migrate";
import { installCompany } from "./install";
import { applicationTags } from "./application-tags";
import { fakeAdapters } from "./test-install";
import type { Adapters, ContactSnapshot } from "@/adapters/types";
import type { TypeformApi } from "@/adapters/typeform/client";

process.env.BINDINGS_KEY ??= Buffer.alloc(32, 7).toString("base64");
const SLUG = `d250-${Date.now()}`;
const snap = (id: string, email: string, tags: string[]): ContactSnapshot => ({ id, email, firstName: id, tags, customFields: {}, dateUpdated: "2026-10-20T00:00:00Z", dateAdded: "2026-10-01T00:00:00Z" });

describe.skipIf(!process.env.DATABASE_URL)("D250 apply", () => {
  let co = "";
  beforeAll(async () => {
    await migrate();
    co = (await installCompany({ name: "D250", slug: SLUG, timezone: "America/New_York", locationId: "LOC-D250", pit: "pit-fake", calendars: {}, templates: [] }, fakeAdapters())).companyId;
    await asOperator(async (c) => {
      await c.query("insert into bindings (company_id, key, kind, value) values ($1,'secret.typeform_token','text',convert_to('tok','UTF8'))", [co]);
      await c.query("insert into contacts (company_id, ghl_contact_id, first_name, tags) values ($1,'GA','A','{stat-call-not-booked}'), ($1,'GB','B','{}'), ($1,'GT','T','{}')", [co]);
    });
  });

  it("tags GHL and the replica, skips the named, lists who GHL lacks, audits once; a second run changes nothing", async () => {
    const crm = new Map([["GA", snap("GA", "a@x.com", ["stat-call-not-booked", "meta booked call"])], ["GB", snap("GB", "b@x.com", [])], ["GT", snap("GT", "t@x.com", [])]]);
    const base = fakeAdapters({ crm }), writes: string[] = [];
    const ad: Adapters = { ...base,
      read: { ...base.read, findDuplicate: async (_c, by) => [...crm.values()].find((s) => "email" in by && s.email === by.email) ?? null },
      write: { ...base.write, addTag: async (_c, id, t) => { writes.push(`${id}+${t}`); crm.get(id)!.tags.push(t); }, removeTag: async (_c, id, t) => { writes.push(`${id}-${t}`); crm.get(id)!.tags = crm.get(id)!.tags.filter((x) => x !== t); } } };
    const tf: TypeformApi = { getForm: async () => { throw new Error("no"); }, getWebhook: async () => ({ ok: true, found: false }), putWebhook: async () => ({}) as never,
      responses: async (_t, _f, type) => (type === "completed" ? [resp("a@x.com", null, "2026-10-01"), resp("t@x.com", null, "2026-10-01"), resp("gone@x.com", null, "2026-10-01")] : [resp("b@x.com", null, "2026-10-02")]) };
    const run = (dryRun: boolean) => asOperator((c) => applicationTags(c, ad, { company: SLUG, forms: ["F1"], why: "t", skip: ["GT"], dryRun, tf, cal: async () => false }));
    const r = await run(false);
    expect(r).toMatchObject({ ok: true, dryRun: false, skipped: [{ ghl_contact_id: "GT" }], notInGhl: [{ email: "gone@x.com" }], errors: [] });
    expect(writes.sort()).toEqual(["GA+stat-application-complete", "GA-stat-call-not-booked", "GB+stat-application-partial", "GB+stat-call-not-booked"]);
    expect(await asOperator((c) => one(c, "select tags from contacts where company_id=$1 and ghl_contact_id='GA'", [co]))).toEqual({ tags: ["stat-application-complete"] });
    expect(await asOperator((c) => one(c, "select count(*)::int n from audit_log where company_id=$1 and action='contact.application_tags'", [co]))).toEqual({ n: 1 });
    expect(await run(true)).toMatchObject({ changes: [] });
  });
});
