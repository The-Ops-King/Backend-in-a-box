/**
 * D181: the wizard makes the test contact in their GHL: the email as given (the send lock matches it exactly), tagged sys-test, its domain a test
 * domain, read back at once; one already there is tagged, not made twice; refused until their GHL workflows are marked.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { asOperator, one } from "@/db/client";
import { migrate } from "@/db/migrate";
import { encrypt } from "@/engine/crypto";
import { fakeAdapters } from "@/engine/test-install";
import type { ContactSnapshot } from "@/adapters/types";
import { createClient } from "@/onboarding/store";
import { createTestContact, suggestedEmail } from "@/onboarding/test-contact";
import { testContacts } from "@/onboarding/tests";

process.env.BINDINGS_KEY ??= Buffer.alloc(32, 7).toString("base64");

describe.skipIf(!process.env.DATABASE_URL)("D181: the test contact, made by the wizard", () => {
  let id: string;
  const ghl = new Map<string, ContactSnapshot>(), made: unknown[] = [], tagged: string[] = [];
  const adapters = fakeAdapters();
  adapters.read.contactsByEmail = async (_c, email) => [...ghl.values()].filter((x) => x.email === email);
  adapters.read.getContact = async (_c, gid) => ghl.get(gid) ?? null;
  adapters.write.createContact = async (_c, input) => { made.push(input); const gid = `g${ghl.size + 1}`; ghl.set(gid, { id: gid, firstName: input.firstName ?? null, lastName: input.lastName ?? null, email: input.email ?? null, phone: input.phone ?? null, tags: input.tags ?? [], customFields: {}, dateUpdated: new Date().toISOString() } as unknown as ContactSnapshot); return { id: gid }; };
  adapters.write.addTag = async (_c, gid, tag) => { tagged.push(`${gid}:${tag}`); const x = ghl.get(gid); if (x) x.tags = [...(x.tags ?? []), tag]; };
  beforeAll(async () => {
    await migrate();
    await asOperator(async (c) => { const co = await one<{ id: string }>(c, "select id from companies where slug='contact-co'"); if (!co) return;
      for (const t of ["onboarding", "audit_log", "contact_identifiers", "contacts", "bindings", "company_terms"]) await c.query(`delete from ${t} where company_id=$1`, [co.id]);
      await c.query("delete from companies where id=$1", [co.id]); });
    id = (await asOperator((c) => createClient(c, { name: "Contact Co", timezone: "America/Phoenix", kind: "takeover" })) as { id: string }).id;
  });

  it("is refused without an email, before their GHL is connected, and before their workflows are marked", async () => {
    expect(await createTestContact(asOperator, adapters, id, { email: "nope" })).toMatchObject({ ok: false, status: 400 });
    expect(await createTestContact(asOperator, adapters, id, { email: "jt@jtylerray.com" })).toMatchObject({ ok: false, status: 409, why: expect.stringContaining("step 8") });
    await asOperator(async (c) => {
      await c.query("update onboarding set steps = steps || '{\"filters\":{\"done_at\":\"2026-10-19T00:00:00Z\",\"by\":\"t\"}}'::jsonb where company_id=$1", [id]);
    });
    expect(await createTestContact(asOperator, adapters, id, { email: "jt@jtylerray.com" })).toMatchObject({ ok: false, status: 409, why: "connect their GHL first" });
    await asOperator(async (c) => {
      await c.query("insert into bindings (company_id, key, kind, value) values ($1,'crm.location_id','id',$2)", [id, Buffer.from("LOC")]);
      await c.query("insert into bindings (company_id, key, kind, value) values ($1,'secret.ghl_pit','secret',$2)", [id, encrypt("pit")]);
    });
  });

  it("makes it in GHL on the email as given, tagged sys-test, reads it back, and makes its domain a test domain; again, it is found and not made twice", async () => {
    const r = await createTestContact(asOperator, adapters, id, { email: "JT@jtylerray.com", phone: "+16025550100" });
    expect(r).toMatchObject({ ok: true, email: "jt@jtylerray.com", created: true });
    expect(made).toEqual([{ firstName: "Test", lastName: "Contact Co", email: "jt@jtylerray.com", phone: "+16025550100", tags: ["sys-test"], source: "engine test contact" }]);
    expect((await asOperator((c) => testContacts(c, id))).map((x) => x.email)).toEqual(["jt@jtylerray.com"]);
    expect(await asOperator((c) => one(c, "select convert_from(value,'utf8') as v from bindings where company_id=$1 and key='test.domains'", [id]))).toEqual({ v: "jtylerray.com" });
    expect(await asOperator((c) => suggestedEmail(c, id))).toBe("jt@jtylerray.com");
    const again = await createTestContact(asOperator, adapters, id, { email: "jt@jtylerray.com" });
    expect(again).toMatchObject({ ok: true, created: false, id: (r as { id: string }).id });
    expect(made).toHaveLength(1);
    expect(tagged).toEqual(["g1:sys-test"]);
  });
});
