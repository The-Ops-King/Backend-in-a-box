/** D283: the onboarding page's links: each closer's own two, and each setter's round robin and closer links tagged with their name. */
import { describe, it, expect, beforeAll } from "vitest";
import { asOperator, one } from "@/db/client";
import { migrate } from "@/db/migrate";
import { teamLinks, setterTag, tagged } from "@/engine/team-links";
import { calendarBooking } from "@/engine/contact-ops";

describe("D283: a setter's tag", () => {
  it("is their first name, or their email when someone else shares it; it rides on the link as D153 reads it", () => {
    const team = [{ name: "Jake Taylor", email: "jake@x.com" }, { name: "Taylor Duzel", email: "taylor@x.com" }, { name: "Sam One", email: "s1@x.com" }, { name: "Sam Two", email: "s2@x.com" }];
    expect(setterTag(team[0], team)).toBe("jake");
    expect(setterTag(team[2], team)).toBe("s1@x.com");
    expect(tagged("https://calendly.com/d/abc/closing", "jake")).toBe("https://calendly.com/d/abc/closing?utm_medium=setter&utm_content=jake");
  });
});

let co: string;
const TABLES = ["audit_log", "bindings", "calendars", "users", "company_terms"];
describe.skipIf(!process.env.DATABASE_URL)("D283: team links", () => {
  beforeAll(async () => {
    await migrate();
    await asOperator(async (c) => {
      const old = await one<{ id: string }>(c, "select id from companies where slug='links'");
      if (old) { for (const t of TABLES) await c.query(`delete from ${t} where company_id=$1`, [old.id]); await c.query("delete from companies where id=$1", [old.id]); }
      co = (await one<{ id: string }>(c, "insert into companies (name, slug, timezone) values ('Links','links','UTC') returning id"))!.id;
      await c.query("insert into company_terms (company_id, domain, name, category, is_default, sort) select $1, domain, label, value, true, sort from core_categories", [co]);
      const term = (await one<{ id: string }>(c, "select id from company_terms where company_id=$1 and domain='appointment_type' and category='closing'", [co]))!.id;
      for (const [name, email, role, active] of [["Taylor Duzel", "taylor@x.com", "closer", true], ["Jassie NS", "jassie@x.com", "closer", true], ["Jake Taylor", "jake@x.com", "setter", true], ["Gone Setter", "gone@x.com", "setter", false]] as const)
        await c.query("insert into users (company_id, email, name, role, active) values ($1,$2,$3,$4,$5)", [co, email, name, role, active]);
      for (const [ext, name, url] of [["RT", "RR Triage", "https://cal.test/rr-triage"], ["RC", "RR Closing", "https://cal.test/rr-closing"], ["TT", "Taylor Triage", "https://cal.test/taylor-triage"], ["TC", "Taylor Closing", "https://cal.test/taylor-closing"], ["JC", "Jassie Closing", "https://cal.test/jassie-closing"]])
        await c.query("insert into calendars (company_id, source, external_id, name, booking_url, appointment_term, config) values ($1,'calendly',$2,$3,$4,$5,'{\"booking\":\"self\"}')", [co, ext, name, url, term]);
    });
  });
  it("nothing without the offer's team.links; with it, closers' own links and each active setter's tagged ones (a calendar not watched is left out)", async () => {
    expect(await asOperator((c) => teamLinks(c, co))).toBeNull();
    await asOperator((c) => c.query("insert into bindings (company_id, key, kind, value) values ($1,'team.links','text',$2)", [co, Buffer.from(JSON.stringify({ rr: { triage: "RT", closing: "RC" }, closers: [{ email: "taylor@x.com", triage: "TT", closing: "TC" }, { email: "jassie@x.com", triage: "NOT-WATCHED", closing: "JC" }, { email: "nobody@x.com", triage: "TT" }] }))]));
    const l = (await asOperator((c) => teamLinks(c, co)))!;
    expect(l.closers).toEqual([
      { name: "Taylor Duzel", links: [{ label: "Triage", url: "https://cal.test/taylor-triage" }, { label: "Closing: follow-up or self-set", url: "https://cal.test/taylor-closing" }] },
      { name: "Jassie NS", links: [{ label: "Closing: follow-up or self-set", url: "https://cal.test/jassie-closing" }] },
    ]);
    const t = (u: string) => `${u}?utm_medium=setter&utm_content=jake`;
    expect(l.setters).toEqual([{ name: "Jake Taylor", links: [
      { label: "Triage (round robin)", url: t("https://cal.test/rr-triage") }, { label: "Closing (round robin)", url: t("https://cal.test/rr-closing") },
      { label: "Taylor's closing", url: t("https://cal.test/taylor-closing") }, { label: "Jassie's closing", url: t("https://cal.test/jassie-closing") }] }]);
  });
  it("a calendar's booking mode changes after a dry run, audited", async () => {
    expect(await asOperator((c) => calendarBooking(c, { company: "links", calendar: "RT", booking: "utm", why: "test" }))).toMatchObject({ ok: true, dryRun: true, was: "self", booking: "utm" });
    expect(await asOperator((c) => calendarBooking(c, { company: "links", calendar: "RT", booking: "utm", why: "test", dryRun: false }))).toMatchObject({ ok: true, dryRun: false });
    expect(await asOperator((c) => one(c, "select config->>'booking' as b from calendars where company_id=$1 and external_id='RT'", [co]))).toEqual({ b: "utm" });
    expect(await asOperator((c) => calendarBooking(c, { company: "links", calendar: "RT", booking: "nope", why: "test" }))).toMatchObject({ ok: false, status: 400 });
  });
});
