/**
 * D63: two CRM records for one person. D60 folds them into one engine person; the Health check `duplicates` says so, once
 * per person, as one finding and one alert (`duplicate:<contact_id>`), until the CRM merge lands — the dropped record
 * answers 404, its id is retired here, the finding clears and the alert resolves in its thread. Nothing is merged by the
 * engine: GoHighLevel is the source of truth.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { asOperator, one, many } from "@/db/client";
import { migrate } from "@/db/migrate";
import { encrypt } from "@/engine/crypto";
import { pollAll } from "@/engine/poll";
import { loadCompany } from "@/engine/context";
import { runHealthStep, type Finding } from "@/engine/health";
import { announceDue, openAlerts } from "@/engine/alerts";
import { fakeAdapters, fakeProbes } from "@/engine/test-install";
import { companyBySlug, healthPage } from "@/api/data";
import type { Adapters, ContactSnapshot, SlackPersona } from "@/adapters/types";

process.env.BINDINGS_KEY ??= Buffer.alloc(32, 7).toString("base64");
const TZ = "America/Phoenix";

// the fake CRM: what it holds (getContact), what the next poll delivers (contactsChangedSince)
const crm = new Map<string, ContactSnapshot>();
const changed: ContactSnapshot[] = [];
const posts: { channel: string; text: string; as?: SlackPersona; threadTs?: string }[] = [];
const reactions: { channel: string; ts: string; emoji: string }[] = [];
const base = fakeAdapters();
const fake: Adapters = {
  ...base,
  read: { ...base.read, getContact: async (_c, id) => crm.get(id) ?? null, contactsChangedSince: async (c) => (c.id === companyId ? changed.splice(0) : []) },
  notifier: { ...base.notifier, post: async (_t, channel, text, as, threadTs) => { posts.push({ channel, text, as, threadTs }); return { ts: `ts${posts.length}` }; }, react: async (_t, channel, ts, emoji) => { reactions.push({ channel, ts, emoji }); return true; } },
};
let companyId: string;
const inCrm = (id: string, over: Partial<ContactSnapshot> = {}): ContactSnapshot => { const s: ContactSnapshot = { id, tags: [], customFields: {}, dateUpdated: new Date().toISOString(), dateAdded: new Date().toISOString(), ...over }; crm.set(id, s); changed.push(s); return s; };
const sweep = () => asOperator(async (c) => { const { row } = await loadCompany(c, companyId); return runHealthStep(c, row, fake, fakeProbes, { checks: {}, min_slots: 0, slots_days: 7, channel: "CDUPES", as_name: "Health check" }); });
const dupes = (findings: Finding[]) => findings.filter((f) => f.check === "duplicates");
const contactByGhl = (ghlId: string) => asOperator((c) => one<{ id: string; ghl_contact_id: string; gone_at: Date | null }>(c, "select ct.id, ct.ghl_contact_id, ct.gone_at from contacts ct where ct.company_id=$1 and (ct.ghl_contact_id=$2 or exists (select 1 from contact_identifiers i where i.contact_id=ct.id and i.kind='ghl_contact' and i.value=$2))", [companyId, ghlId]));   // any id the person ever had (D65: the primary follows the live record)
const idents = (contactId: string, kind: string) => asOperator((c) => many<{ value: string; retired: boolean }>(c, "select value, retired_at is not null as retired from contact_identifiers where contact_id=$1 and kind=$2 order by created_at, value", [contactId, kind]));
// announceDue is engine-wide and the database is shared with other suites: what this suite asserts on is its own channel
const mine = () => posts.filter((p) => p.channel === "CDUPES");
const tsOf = (p: (typeof posts)[number]) => `ts${posts.indexOf(p) + 1}`;
const open = () => asOperator((c) => openAlerts(c, companyId));
const page = () => asOperator(async (c) => healthPage(c, (await companyBySlug(c, "dupes"))!));

describe.skipIf(!process.env.DATABASE_URL)("health: duplicate contacts (D63)", () => {
  beforeAll(async () => {
    await migrate();
    await asOperator(async (c) => {
      const co = await one<{ id: string }>(c, "select id from companies where slug='dupes'");
      if (co) { for (const t of ["alerts", "health_checks", "events", "contact_identifiers", "contacts", "slack_connections", "company_terms", "bindings", "poll_cursors", "audit_log"]) await c.query(`delete from ${t} where company_id=$1`, [co.id]); await c.query("delete from companies where id=$1", [co.id]); }
      companyId = (await one<{ id: string }>(c, "insert into companies (name, slug, timezone, mode) values ('Dupes Co','dupes',$1,'live') returning id", [TZ]))!.id;
      await c.query("insert into company_terms (company_id, domain, name, category, is_default, sort) select $1, domain, label, value, true, sort from core_categories", [companyId]);
      await c.query("insert into bindings (company_id,key,kind,value) values ($1,'crm.location_id','id',$2),($1,'secret.ghl_pit','secret',$3),($1,'alerts.slack_channel','channel',$4)", [companyId, Buffer.from("LOC-DUPES"), encrypt("p"), Buffer.from("CALERTS")]);
      await c.query("insert into slack_connections (company_id, team_id, bot_token, channels) values ($1,'T1',$2,'{}')", [companyId, encrypt("xoxb-fake")]);
      // the baseline poll already happened: from here every poll is deltas, as in production
      await c.query("insert into poll_cursors (company_id, entity, cursor, last_polled_at, last_success_at) values ($1,'contacts',$2,now(),now())", [companyId, new Date(Date.now() - 864e5).toISOString()]);
    });
  });

  it("two CRM records with one number in two spellings arrive via the poll → one engine person with two ghl_contact identifiers → one finding naming both ids, one alert, posted once in the sweep's channel", async () => {
    inCrm("DUP-1", { firstName: "Dup", lastName: "Spelled", phone: "+16025550901" });
    inCrm("DUP-2", { firstName: "Dup", lastName: "Spelled", phone: "1-602-555-0901" });
    await pollAll(fake);
    const ct = (await contactByGhl("DUP-1"))!;
    expect((await contactByGhl("DUP-2"))?.id).toBe(ct.id);   // D60: no second person; D65: the live record is the primary id
    expect((await idents(ct.id, "ghl_contact")).map((i) => i.value)).toEqual(["DUP-1", "DUP-2"]);
    expect((await idents(ct.id, "phone")).map((i) => i.value)).toEqual(["+16025550901"]);   // one number, however it was spelled

    const r = await sweep();
    const found = dupes(r.findings);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ ok: false, level: "warning", item: ct.id, key: `duplicate:${ct.id}`, text: "Two CRM records for one person: Dup Spelled — DUP-1, DUP-2 (same phone +16025550901)",
      href: "https://app.gohighlevel.com/v2/location/LOC-DUPES/contacts/detail/DUP-2", hrefLabel: "Open in the CRM", page: `/app/c/dupes/contacts/${ct.id}` });
    expect(r.findings.filter((f) => !f.ok)).toHaveLength(1);   // every other check passes on the fake vendors
    expect(r.raised).toBe(1);
    const alerts = await open();
    expect(alerts.map((a) => [a.key, a.level, a.source, a.href])).toEqual([[`duplicate:${ct.id}`, "warning", "health", `/app/c/dupes/contacts/${ct.id}`]]);
    expect(alerts[0].detail).toMatchObject({ link: "https://app.gohighlevel.com/v2/location/LOC-DUPES/contacts/detail/DUP-2", link_label: "Open in the CRM", ghl_contact_ids: ["DUP-1", "DUP-2"] });

    // said once, in the sweep's own channel, with the CRM link to merge at
    const ann = await asOperator((c) => announceDue(c, fake, new Date(), companyId));
    expect(ann.posted).toBeGreaterThanOrEqual(1); expect(mine()).toHaveLength(1);
    expect(mine()[0].as?.name).toBe("Health check");
    expect(mine()[0].text).toMatch(/^🟡 \*Dupes Co · Health check\*\nTwo CRM records for one person: Dup Spelled — DUP-1, DUP-2 \(same phone \+16025550901\)\n/);
    expect(mine()[0].text).toMatch(/<https:\/\/app\.gohighlevel\.com\/v2\/location\/LOC-DUPES\/contacts\/detail\/DUP-2\|Open in the CRM>/);
    // the next sweep finds the same pair: nothing new is raised or said
    const r2 = await sweep(); expect(r2.raised).toBe(0); expect(r2.resolved).toBe(0); expect(dupes(r2.findings)).toHaveLength(1);
    await asOperator((c) => announceDue(c, fake, new Date(), companyId)); expect(mine()).toHaveLength(1);
    expect(await open()).toHaveLength(1);

    // the Health page: the check is `warn` with the one finding and its CRM link
    const pg = await page();
    const ck = pg.checks.find((x) => x.id === "duplicates")!;
    expect(ck.state).toBe("warn"); expect(ck.findings).toHaveLength(1);
    expect(ck.findings[0]).toMatchObject({ ok: false, text: expect.stringMatching(/^Two CRM records for one person: Dup Spelled/), href: expect.stringMatching(/DUP-2$/), href_label: "Open in the CRM" });
    expect(ck.about).toMatch(/never merges/);
    expect(pg.open.map((a) => a.link_label)).toEqual(["Open in the CRM"]);
  });

  it("the merge lands in the CRM (the second record is gone) → its id is retired on the replica, the finding clears, the alert resolves in its thread with a ✅", async () => {
    const ct = (await contactByGhl("DUP-1"))!;
    crm.delete("DUP-2");   // what GHL's merge leaves behind: one record; the other answers 404
    const r = await sweep();
    expect(dupes(r.findings)).toEqual([expect.objectContaining({ ok: true, text: expect.stringMatching(/^\d+ contacts?, none held twice by the CRM\.$/) })]);
    expect(r.resolved).toBe(1);
    expect(await open()).toHaveLength(0);
    expect(await idents(ct.id, "ghl_contact")).toEqual([{ value: "DUP-1", retired: false }, { value: "DUP-2", retired: true }]);
    expect((await contactByGhl("DUP-1"))!).toMatchObject({ ghl_contact_id: "DUP-1", gone_at: null });   // the person is still here, under the survivor
    const ann = await asOperator((c) => announceDue(c, fake, new Date(), companyId));
    expect(ann.resolved).toBeGreaterThanOrEqual(1);
    expect(mine()).toHaveLength(2); expect(mine()[1].threadTs).toBe(tsOf(mine()[0])); expect(mine()[1].text).toMatch(/^✅ Resolved after 0h: Two CRM records for one person: Dup Spelled/);
    expect(reactions.filter((x) => x.channel === "CDUPES")).toEqual([{ channel: "CDUPES", ts: tsOf(mine()[0]), emoji: "white_check_mark" }]);
    const pg = await page();
    expect(pg.checks.find((x) => x.id === "duplicates")!.state).toBe("ok");
    expect(pg.resolved.map((a) => a.text)).toEqual([expect.stringMatching(/^Two CRM records for one person: Dup Spelled/)]);
  });

  it("the merge kept the second record: the first id is retired and sends follow the survivor (contacts.ghl_contact_id moves); an email in two cases is the same finding", async () => {
    posts.length = 0;
    inCrm("DUP-3", { firstName: "Casey", lastName: "Case", email: "Casey@X.com" });
    inCrm("DUP-4", { firstName: "Casey", lastName: "Case", email: "casey@x.com " });
    await pollAll(fake);
    const ct = (await contactByGhl("DUP-3"))!;
    expect((await idents(ct.id, "email")).map((i) => i.value)).toEqual(["casey@x.com"]);
    let r = await sweep();
    expect(dupes(r.findings).map((f) => f.text)).toEqual(["Two CRM records for one person: Casey Case — DUP-3, DUP-4 (same email casey@x.com)"]);
    expect((await open()).map((a) => a.key)).toEqual([`duplicate:${ct.id}`]);
    crm.delete("DUP-3");
    r = await sweep();
    expect(dupes(r.findings).every((f) => f.ok)).toBe(true); expect(r.resolved).toBe(1); expect(await open()).toHaveLength(0);
    expect(await idents(ct.id, "ghl_contact")).toEqual([{ value: "DUP-3", retired: true }, { value: "DUP-4", retired: false }]);
    expect((await contactByGhl("DUP-3"))!.ghl_contact_id).toBe("DUP-4");   // the retired id still names the person; the primary is the survivor
    expect((await contactByGhl("DUP-4"))!).toMatchObject({ id: ct.id, gone_at: null });
  });

  it("two engine persons whose numbers differ only in spelling (a non-US number with and without its plus, which D60 does not fold) are one finding keyed on both ids; the dropped record is stamped gone and the finding clears", async () => {
    posts.length = 0;
    inCrm("UK-1", { firstName: "Nia", lastName: "Hughes", phone: "+44 20 7946 0958" });
    inCrm("UK-2", { firstName: "Nia", lastName: "Hughes", phone: "44 20 7946 0958" });
    await pollAll(fake);
    const a = (await contactByGhl("UK-1"))!, b = (await contactByGhl("UK-2"))!;
    expect(a.id).not.toBe(b.id);   // two persons: the engine normalises only US/CA numbers
    let r = await sweep();
    const found = dupes(r.findings);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ ok: false, key: `duplicate:${a.id}:${b.id}`, text: "Two CRM records for one person: Nia Hughes — UK-1, UK-2 (same phone +442079460958 / 442079460958)", href: expect.stringMatching(/UK-1$/), page: `/app/c/dupes/contacts/${a.id}` });
    expect((await open()).map((x) => x.key)).toEqual([`duplicate:${a.id}:${b.id}`]);
    await asOperator((c) => announceDue(c, fake, new Date(), companyId)); expect(mine()).toHaveLength(1);
    // merged in the CRM: UK-2 is gone there → stamped gone here (G21's mark), as a failed send would have done
    crm.delete("UK-2");
    r = await sweep();
    expect(dupes(r.findings).every((f) => f.ok)).toBe(true); expect(r.resolved).toBe(1); expect(await open()).toHaveLength(0);
    expect((await contactByGhl("UK-2"))!.gone_at).toEqual(expect.any(Date));
    expect((await contactByGhl("UK-1"))!.gone_at).toBeNull();
    const ann = await asOperator((c) => announceDue(c, fake, new Date(), companyId));
    expect(ann.resolved).toBeGreaterThanOrEqual(1); expect(mine()).toHaveLength(2); expect(mine()[1].text).toMatch(/^✅ Resolved/);
  });
});
