/** D281: the UTMs a person's first Typeform response carried, into their empty UTM and lead-source fields in GHL. */
import { describe, it, expect, beforeAll } from "vitest";
import { asOperator, one } from "@/db/client";
import { migrate } from "@/db/migrate";
import { installCompany } from "@/engine/install";
import { fakeAdapters } from "@/engine/test-install";
import { utmBackfill, utmOf, sourceName, answerText } from "@/engine/utm-backfill";
import type { Adapters, ContactSnapshot } from "@/adapters/types";
import type { TfResponse, TypeformApi } from "@/adapters/typeform/client";

process.env.BINDINGS_KEY ??= Buffer.alloc(32, 7).toString("base64");
const HAS_DB = !!process.env.DATABASE_URL;
const SLUG = `d281-${Date.now()}`;
const IDS = { average_monthly_revenue: "F-REV", utm_source: "F-SRC", utm_medium: "F-MED", utm_campaign: "F-CMP", utm_content: "F-CNT", utm_term: "F-TRM", lead_source: "F-LEAD" };
const resp = (email: string, at: string, hidden: Record<string, string>): TfResponse => ({ token: `${email}-${at}`, landed_at: at, submitted_at: at, hidden, answers: [{ type: "email", email, field: { ref: "e" } } as never] });
const RESPONSES = [
  resp("ana@x.com", "2026-10-02T00:00:00Z", { utm_source: "ig", utm_medium: "paid", utm_campaign: "retarget" }),
  resp("ana@x.com", "2026-10-01T00:00:00Z", { utm_source: "fb", utm_medium: "paid", utm_campaign: "cold", utm_content: "video-a", utm_term: "{{adset.name}}" }),
  resp("bea@x.com", "2026-10-03T00:00:00Z", { utm_source: "fb", utm_campaign: "cold" }),
  { ...resp("cal@x.com", "2026-10-03T00:00:00Z", {}), answers: [{ type: "email", email: "cal@x.com", field: { ref: "e" } } as never, { type: "choice", choice: { label: "$0-$4k/month" }, field: { ref: "REV" } } as never] },
  { ...resp("cal@x.com", "2026-10-05T00:00:00Z", {}), answers: [{ type: "email", email: "cal@x.com", field: { ref: "e" } } as never, { type: "choice", choice: { label: "$5-$10k/month" }, field: { ref: "REV" } } as never] },
  resp("nobody@x.com", "2026-10-04T00:00:00Z", { utm_source: "google" }),
];
const tf = { responses: async (_t: string, _f: string, kind: string) => (kind === "completed" ? RESPONSES : []) } as unknown as TypeformApi;
const crm = new Map<string, ContactSnapshot>([
  ["G-ANA", { id: "G-ANA", firstName: "Ana", email: "ana@x.com", tags: [], customFields: {}, dateUpdated: "", dateAdded: "" }],
  ["G-BEA", { id: "G-BEA", firstName: "Bea", email: "bea@x.com", tags: [], customFields: { "F-LEAD": "Referral" }, dateUpdated: "", dateAdded: "" }],
  ["G-CAL", { id: "G-CAL", firstName: "Cal", email: "cal@x.com", tags: [], customFields: {}, dateUpdated: "", dateAdded: "" }],
]);
const writes: { id: string; fields: unknown }[] = [];
const base = fakeAdapters();
const fake: Adapters = { ...base,
  read: { ...base.read, getContact: async (_c, id) => crm.get(id) ?? null, findDuplicate: async (_c, by) => ("email" in by ? [...crm.values()].find((x) => x.email === by.email) ?? null : null) },
  write: { ...base.write, updateContact: async (_c, id, patch) => { writes.push({ id, fields: (patch as { customFields: unknown }).customFields }); } } };
let co = "";

describe("D281: a response's UTMs", () => {
  it("are its hidden fields, any case; blanks and unfilled placeholders are not UTMs; a source is named by the offer's words, else as it came", () => {
    expect(utmOf(resp("a@x.com", "", { UTM_Source: " fb ", utm_term: "{{adset.name}}", utm_content: "xxxxx", utm_medium: "" }))).toEqual({ utm_source: "fb" });
    expect(sourceName("FB", { fb: "Meta" })).toBe("Meta");
    expect(sourceName("google", { fb: "Meta" })).toBe("google");
    expect(answerText({ type: "choice", choice: { label: " $0-$4k/month " }, field: { ref: "x" } })).toBe("$0-$4k/month");
    expect(answerText({ type: "choices", choices: { labels: ["a", "b"] }, field: { ref: "x" } })).toBe("a, b");
  });
});

describe.skipIf(!HAS_DB)("D281: the UTM backfill", () => {
  beforeAll(async () => {
    await migrate();
    co = (await installCompany({ name: "D281", slug: SLUG, timezone: "America/New_York", locationId: "LOC", pit: "pit-fake", calendars: {}, templates: [] }, fake)).companyId;
    await asOperator(async (c) => {
      for (const [k, v] of [...Object.entries(IDS).map(([k, v]) => [`crm.field_contact_${k}`, v]), ["secret.typeform_token", "tf-fake"]])
        await c.query("insert into bindings (company_id,key,kind,value) values ($1,$2,'text',$3) on conflict (company_id,key) do update set value=excluded.value", [co, k, Buffer.from(v)]);
      await c.query("insert into contacts (company_id, ghl_contact_id, first_name, timezone) values ($1,'G-ANA','Ana','UTC')", [co]);
    });
  }, 180000);

  it("dry run: each person's first UTMs, the sources seen, who GHL lacks; nothing written", async () => {
    const r = await asOperator((c) => utmBackfill(c, fake, { company: SLUG, forms: ["F1"], why: "test", tf, sourceNames: { fb: "Meta" } }));
    expect(r).toMatchObject({ ok: true, dryRun: true, people: 3, sources: { fb: 2, google: 1 }, noUtm: 1, notInGhl: [{ email: "nobody@x.com" }] });
    if (!r.ok) return;
    expect(r.changes).toEqual([
      { who: "Ana", ghl_contact_id: "G-ANA", fields: { utm_source: "fb", utm_medium: "paid", utm_campaign: "cold", utm_content: "video-a", lead_source: "Meta" } },   // her first response, not the later ig one
      { who: "Bea", ghl_contact_id: "G-BEA", fields: { utm_source: "fb", utm_campaign: "cold" } },   // her lead source was already written: kept
    ]);
    expect(writes).toEqual([]);
  });

  it("apply: only empty fields are written in GHL and the replica; audited", async () => {
    const r = await asOperator((c) => utmBackfill(c, fake, { company: SLUG, forms: ["F1"], why: "test", tf, sourceNames: { fb: "Meta" }, dryRun: false }));
    expect(r).toMatchObject({ ok: true, dryRun: false });
    expect(writes.find((w) => w.id === "G-BEA")!.fields).toEqual([{ id: "F-SRC", field_value: "fb" }, { id: "F-CMP", field_value: "cold" }]);
    expect(await asOperator((c) => one<{ f: Record<string, string> }>(c, "select ghl_fields as f from contacts where company_id=$1 and ghl_contact_id='G-ANA'", [co]))).toMatchObject({ f: { "F-SRC": "fb", "F-LEAD": "Meta" } });
    expect(await asOperator((c) => one(c, "select 1 from audit_log where company_id=$1 and action='contact.utm_backfill'", [co]))).toBeTruthy();
  });

  it("D282: a form's answers fill their empty fields too, from the person's latest answer", async () => {
    const r = await asOperator((c) => utmBackfill(c, fake, { company: SLUG, forms: ["F1"], why: "test", tf, answers: { REV: "average_monthly_revenue" } }));
    expect(r.ok && r.changes.find((x) => x.ghl_contact_id === "G-CAL")).toEqual({ who: "Cal", ghl_contact_id: "G-CAL", fields: { average_monthly_revenue: "$5-$10k/month" } });
  });
});
