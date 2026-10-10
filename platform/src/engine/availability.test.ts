/** D72: open slots per closer. Calendly round robins are split per host from the pooled times Calendly offers; a time no host is free for drops the split instead of guessing. */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { DateTime } from "luxon";
import { asOperator, one } from "@/db/client";
import { migrate } from "@/db/migrate";
import { encrypt } from "./crypto";
import { fakeProbes } from "./test-install";
import { hostFree, type HealthProbes } from "./health";
import { getAvailability } from "./metric-registry";
import { formatAvailability } from "./bot-format";
import type { CalendlySchedule } from "@/adapters/calendly/health";

process.env.BINDINGS_KEY ??= Buffer.alloc(32, 7).toString("base64");
const TZ = "America/New_York";
const NY = (iso: string) => DateTime.fromISO(iso, { zone: TZ });
const t = (iso: string) => NY(iso).toMillis();

describe("hostFree: the host's own schedule on the event type, for the whole call, clear of busy times", () => {
  const sched: CalendlySchedule = { timezone: "America/Chicago", rules: [
    { type: "wday", wday: "monday", intervals: [{ from: "09:00", to: "12:00" }, { from: "12:00", to: "14:00" }] },
    { type: "wday", wday: "tuesday", intervals: [{ from: "09:00", to: "17:00" }] },
    { type: "date", date: "2026-10-13", intervals: [] },
  ] };
  it("reads the schedule in its own zone and needs the whole call inside it", () => {
    expect(hostFree(t("2026-10-12T10:00"), 45, sched, [])).toBe(true);    // 9:00 Chicago
    expect(hostFree(t("2026-10-12T09:30"), 45, sched, [])).toBe(false);   // 8:30 Chicago
    expect(hostFree(t("2026-10-12T14:00"), 60, sched, [])).toBe(true);    // 13:00–14:00 Chicago, to the minute
    expect(hostFree(t("2026-10-12T14:30"), 45, sched, [])).toBe(false);   // runs past 14:00 Chicago
  });
  it("contiguous intervals are one stretch; a date override replaces the weekday", () => {
    expect(hostFree(t("2026-10-12T12:45"), 45, sched, [])).toBe(true);   // 11:45–12:30 Chicago spans the 12:00 seam
    expect(hostFree(t("2026-10-13T11:00"), 45, sched, [])).toBe(false);  // Tuesday, but the 13th is a day off
    expect(hostFree(t("2026-10-20T11:00"), 45, sched, [])).toBe(true);
  });
  it("a busy time overlapping any part of the call blocks it; touching ends do not; no schedule is never free", () => {
    const busy = [{ start: t("2026-10-12T11:30"), end: t("2026-10-12T12:00") }];
    expect(hostFree(t("2026-10-12T11:00"), 45, sched, busy)).toBe(false);
    expect(hostFree(t("2026-10-12T12:00"), 45, sched, busy)).toBe(true);
    expect(hostFree(t("2026-10-12T10:45"), 45, sched, busy)).toBe(true);
    expect(hostFree(t("2026-10-12T12:00"), 45, undefined, [])).toBe(false);
  });
});

describe.skipIf(!process.env.DATABASE_URL)("availability per closer on Calendly round robins (D72)", () => {
  const NOW = NY("2026-10-10T08:00");
  const JAMES = { uri: "https://api.calendly.com/users/UJ", email: "James@Hair.co", name: "James L" };
  const JOSH = { uri: "https://api.calendly.com/users/UO", email: "josh@hair.co", name: "Josh H" };
  // the two strategy calls pool the same two hosts; Monday 9am and 2pm are offered by both
  const offered: Record<string, string[]> = {
    SELF: ["2026-10-10T11:00", "2026-10-11T11:30", "2026-10-12T09:00", "2026-10-12T11:00", "2026-10-12T12:45", "2026-10-12T14:00", "2026-10-13T13:00"],
    SETTER: ["2026-10-12T09:00", "2026-10-12T14:00", "2026-10-12T15:00"],
  };
  const schedules: CalendlySchedule[] = [
    { user: JAMES.uri, timezone: TZ, rules: [
      ...["monday", "tuesday", "wednesday", "thursday", "friday"].map((wday) => ({ type: "wday" as const, wday, intervals: [{ from: "09:00", to: "17:00" }] })),
      { type: "date", date: "2026-10-13", intervals: [] }] },
    { user: JOSH.uri, timezone: "America/Chicago", rules: [
      { type: "wday", wday: "saturday", intervals: [{ from: "10:00", to: "12:00" }] }, { type: "wday", wday: "sunday", intervals: [{ from: "10:00", to: "12:00" }] },
      { type: "wday", wday: "monday", intervals: [{ from: "09:00", to: "12:00" }, { from: "12:00", to: "14:00" }] },
      ...["tuesday", "wednesday", "thursday", "friday"].map((wday) => ({ type: "wday" as const, wday, intervals: [{ from: "13:00", to: "17:00" }] }))] },
  ];
  const reads: string[] = [];
  const probes: HealthProbes = {
    ...fakeProbes,
    calendlyAvailableTimes: async (_t, uri, from, to) => { const times = (offered[uri.split("/").pop()!] ?? []).map((x) => NY(x).toUTC().toISO()!).filter((x) => Date.parse(x) >= from.getTime() && Date.parse(x) <= to.getTime()); return { ok: true, slots: times.length, times }; },
    calendlyEventTypeHosts: async () => ({ ok: true, duration: 45, hosts: [JAMES, JOSH] }),
    calendlyEventTypeSchedules: async () => ({ ok: true, schedules }),
    // James has a call 10:45–11:00 with a 15-minute buffer each side: only the buffered times block 11:00
    calendlyBusyTimes: async (_t, user) => { reads.push(user); return { ok: true, busy: user === JAMES.uri ? [{ start: NY("2026-10-12T10:30").toISO()!, end: NY("2026-10-12T11:15").toISO()! }] : [] }; },
  };
  let companyId: string;
  const clean = async () => asOperator(async (c) => {
    const co = await one<{ id: string }>(c, "select id from companies where slug='avail72'");
    if (!co) return;
    for (const x of ["calendars", "bindings", "users", "company_terms"]) await c.query(`delete from ${x} where company_id=$1`, [co.id]);
    await c.query("delete from companies where id=$1", [co.id]);
  });
  beforeAll(async () => {
    await migrate(); await clean();
    await asOperator(async (c) => {
      companyId = (await one<{ id: string }>(c, "insert into companies (name, slug, timezone) values ('Hair Test','avail72',$1) returning id", [TZ]))!.id;
      await c.query("insert into company_terms (company_id, domain, name, category, is_default, sort) select $1, domain, label, value, true, sort from core_categories", [companyId]);
      const closing = (await one<{ id: string }>(c, "select id from company_terms where company_id=$1 and domain='appointment_type' and category='closing'", [companyId]))!.id;
      await c.query("insert into users (company_id, email, name, role) values ($1,'james@hair.co','James Langridge','closer'),($1,'josh@hair.co','Josh Harris','closer')", [companyId]);
      await c.query("insert into bindings (company_id, key, kind, value) values ($1,'secret.calendly_token','secret',$2),($1,'calendly.organization','id',$3)", [companyId, encrypt("tok"), Buffer.from("https://api.calendly.com/organizations/O1")]);
      await c.query("insert into calendars (company_id, source, external_id, name, appointment_term) values ($1,'calendly','SELF','45 Min Strategy Call',$2),($1,'calendly','SETTER','45 Min Strategy Call - S',$2)", [companyId, closing]);
    });
  });
  afterAll(clean);

  it("each offered time goes to every host free for the whole call; a time both event types offer counts once per host; the total is the sum of the closers", async () => {
    reads.length = 0;
    const a = await asOperator((c) => getAvailability(c, companyId, probes, 3, NOW));
    expect(a.source).toBe("Calendly, read just now"); expect(a.split_error).toBeUndefined();
    expect(a.closers).toEqual([
      { name: "James Langridge", short: "James", per_day: [0, 0, 4], total: 4 },   // Mon 9am, 12:45, 2pm, 3pm (11am is inside his buffered call)
      { name: "Josh Harris", short: "Josh", per_day: [1, 1, 3], total: 5 },        // Sat, Sun, Mon 11am, 12:45 (across his 12:00 seam), 2pm
    ]);
    expect(a.days.map((d) => d.total)).toEqual([1, 1, 7]); expect(a.total).toBe(9);
    expect(reads.sort()).toEqual([JOSH.uri, JAMES.uri].sort());   // one busy read per host, shared by both event types
    expect(formatAvailability(a)).toBe([
      "*Open slots, next 3 days: 9*  · _from Calendly, read just now_", "",
      "```", "Day         James Open  Josh Open  Total Open", "Sat Oct 10           0          1           1", "Sun Oct 11           0          1           1", "Mon Oct 12           4          3           7", "Total                4          5           9", "```", "",
      "_Period: Sat Oct 10 to Mon Oct 12, read just now (America/New_York)_"].join("\n"));
  });

  it("self-check: an offered time no host is free for drops the per-closer columns, keeps the distinct offered times per day, and says so", async () => {
    // Tuesday 1pm: James is off that date, Josh starts at 1pm Chicago (2pm here)
    const a = await asOperator((c) => getAvailability(c, companyId, probes, 4, NOW));
    expect(a.closers).toEqual([]); expect(a.split_error).toBe("Could not split by closer: 1 offered time matched no host's schedule");
    expect(a.days.map((d) => d.total)).toEqual([1, 1, 5, 1]); expect(a.total).toBe(8);
    const text = formatAvailability(a);
    expect(text).toContain("Day         Total Open\nSat Oct 10           1"); expect(text).toContain("Could not split by closer: 1 offered time matched no host's schedule");
    // a read the split needs that fails is the same: no columns, the reason named
    const b = await asOperator((c) => getAvailability(c, companyId, { ...probes, calendlyEventTypeSchedules: async () => ({ ok: false, error: "Calendly 403" }) }, 3, NOW));
    expect(b.closers).toEqual([]); expect(b.split_error).toMatch(/^Could not split by closer: the schedule of "45 Min Strategy Call" could not be read \(Calendly 403\)$/); expect(b.total).toBe(7);
  });

  it("a one-host event type is that host's without further reads; a host off the roster shows by Calendly name; first names only when unique on the roster", async () => {
    const solo: HealthProbes = { ...probes, calendlyEventTypeHosts: async (_t, uri) => ({ ok: true, duration: 45, hosts: [uri.endsWith("SELF") ? JOSH : { uri: "https://api.calendly.com/users/UX", email: "pat@else.co", name: "Pat Guest" }] }),
      calendlyEventTypeSchedules: async () => { throw new Error("not needed"); }, calendlyBusyTimes: async () => { throw new Error("not needed"); } };
    await asOperator((c) => c.query("insert into users (company_id, email, name, role) values ($1,'josh.s@hair.co','Josh Smith','setter')", [companyId]));
    try {
      const a = await asOperator((c) => getAvailability(c, companyId, solo, 3, NOW));
      expect(a.closers.map((x) => [x.short, x.per_day])).toEqual([["Josh Harris", [1, 1, 4]], ["Pat", [0, 0, 3]]]);
      expect(formatAvailability(a)).toContain("Day         Josh Harris Open  Pat Open  Total Open");
    } finally { await asOperator((c) => c.query("delete from users where company_id=$1 and email='josh.s@hair.co'", [companyId])); }
  });
});
