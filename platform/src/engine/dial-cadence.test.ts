/** D352: the dial cadence (TRC's Smart List SOP) through the real engine: Jose's three test contacts and the edges around them. */
import { describe, it, expect, beforeAll, vi } from "vitest";
vi.mock("next/server", async (orig) => ({ ...(await orig<typeof import("next/server")>()), after: () => undefined }));   // the route works its runs after answering; here the test ticks
import { DateTime } from "luxon";
import { asOperator, many, one } from "@/db/client";
import { migrate } from "@/db/migrate";
import { installCompany } from "@/engine/install";
import { emitEvent, dispatchEvent } from "@/engine/dispatch";
import { tick } from "@/engine/runner";
import { fakeAdapters } from "@/engine/test-install";
import { POST as enroll } from "../../app/api/admin/workflows/enroll/route";

process.env.BINDINGS_KEY ??= Buffer.alloc(32, 7).toString("base64");
const KEY = "d352-key"; process.env.CRON_SECRET = KEY;
const TZ = "America/Los_Angeles";
const fake = fakeAdapters();
const FIELDS = ["cycle_status", "entry_reason", "cycle_start", "attempt_count", "last_call_at", "next_call_due", "last_outcome", "no_show_resets", "paused_at"];
// a Wednesday, 10am in the company's (and the contact's) zone: inside the calling window, not a holiday
const T0 = DateTime.fromISO("2026-12-02T10:00:00", { zone: TZ }) as DateTime<true>;
let co = "";
const field = async (contactId: string, f: string) => (await asOperator((c) => one<{ v: unknown }>(c, "select ghl_fields->>$2 as v from contacts where id=$1", [contactId, `F-${f}`])))?.v ?? null;
const runOf = (contactId: string) => asOperator((c) => many<{ id: string; status: string; current_node: string | null; exit_reason: string | null }>(c,
  "select r.id, r.status, r.current_node, r.exit_reason from runs r join workflows w on w.id=r.workflow_id join workflow_templates t on t.id=w.template_id where r.contact_id=$1 and t.slug='dial-cadence' order by r.started_at", [contactId]));
const person = (ghl: string) => asOperator(async (c) => (await one<{ id: string }>(c, "insert into contacts (company_id, ghl_contact_id, first_name, timezone, tags) values ($1,$2,$2,$3,'{}') returning id", [co, ghl, TZ]))!.id);
const fire = (contactId: string, type: string, data: Record<string, unknown>, ctx: Record<string, unknown> = {}, appointmentId: string | null = null, at?: DateTime) =>
  asOperator(async (c) => dispatchEvent(c, await emitEvent(c, { company_id: co, contact_id: contactId, opportunity_id: null, appointment_id: appointmentId, event_type: type, source: "test", data, ...(at ? { occurred_at: at.toJSDate() } : {}) }), { contact: { id: contactId }, ...ctx }));
const dial = (contactId: string, at: DateTime) => fire(contactId, "call.logged", { direction: "outbound", connected: false, duration_sec: 20 }, {}, null, at);
// the clock the test stands at: what is parked is looked at again (the scheduler picks by the real clock; the engine's own `now` decides)
const run = async (now: DateTime) => { await asOperator((c) => c.query("update runs set next_run_at=now() where company_id=$1 and status='waiting' and next_run_at is not null", [co])); return tick(fake, now as DateTime<true>, co); };
/** A closing booking of theirs that has passed (a no-show is about one). */
const pastBooking = (contactId: string, ext: string) => asOperator(async (c) => (await one<{ id: string }>(c, `insert into appointments (company_id, contact_id, source, external_id, appointment_term, starts_at, ends_at, booked_at, status)
  values ($1,$2,'test',$3,(select id from company_terms where company_id=$1 and category='closing' order by sort limit 1), now() - interval '2 days', now() - interval '2 days' + interval '30 minutes', now() - interval '5 days', 'noshow') returning id`, [co, contactId, ext]))!.id);

describe.skipIf(!process.env.DATABASE_URL)("D352: dial cadence", () => {
  beforeAll(async () => {
    await migrate();
    co = (await installCompany({ name: "Cadence", slug: `d352-${Date.now()}`, timezone: TZ, locationId: "LOC-D352", pit: "pit-fake", calendars: {}, templates: ["dial-cadence", "dial-cadence-exits"], enable: true,
      crm: Object.fromEntries(FIELDS.map((f) => [`field_contact_${f}`, `F-${f}`])) } as never, fake)).companyId;
    await asOperator((c) => c.query("update companies set mode='live' where id=$1", [co]));
  }, 60_000);

  it("a new Leap buyer: enters at once (Next Call Due today, 0 calls); each dial counts and takes them off the lists until the next is due; 30 minutes later call #2 is due", async () => {
    const id = await person("LEAP1");
    await fire(id, "tag.added", { tag: "leap-buyer" }); await run(T0);
    expect(await field(id, "cycle_status")).toBe("Active"); expect(await field(id, "entry_reason")).toBe("Never booked");
    expect(await field(id, "attempt_count")).toBe("0"); expect(await field(id, "next_call_due")).toBe("2026-12-02");
    expect((await runOf(id))[0]).toMatchObject({ status: "waiting", current_node: "dial" });
    await dial(id, T0.plus({ minutes: 3 })); await run(T0.plus({ minutes: 3 }));
    expect(await field(id, "attempt_count")).toBe("1"); expect(await field(id, "next_call_due")).toBeNull(); expect(await field(id, "last_call_at")).toBe("2026-12-02");
    await run(T0.plus({ minutes: 20 })); expect(await field(id, "next_call_due")).toBeNull();   // not yet: 30 minutes from entry
    await run(T0.plus({ minutes: 31 })); expect(await field(id, "next_call_due")).toBe("2026-12-02"); expect((await runOf(id))[0].current_node).toBe("dial");
    // a repeat purchase never starts a second cycle
    await fire(id, "tag.added", { tag: "leap-buyer" }); await run(T0.plus({ minutes: 32 }));
    expect(await runOf(id)).toHaveLength(1);
    // not dialed 4 hours after it was due: the team is told once, and they stay on the list
    await run(T0.plus({ minutes: 31, hours: 4, seconds: 30 }));
    const said = await asOperator((c) => many<{ rendered_body: string }>(c, "select s.rendered_body from sends s join runs r on r.id=s.run_id where r.contact_id=$1 and s.channel='slack'", [id]));
    expect(said.map((x) => x.rendered_body)).toEqual([expect.stringMatching(/^Call #2 to .* has been due 4 hours and not dialed\. They stay on the list until it is\.$/)]);
    expect(await field(id, "attempt_count")).toBe("1");   // no attempt counted that was not made
    expect(await field(id, "next_call_due")).toBe("2026-12-02"); expect((await runOf(id))[0].current_node).toBe("dial_b");
  });

  it("someone who books: out of the cycle and every list at once; the cadence stops without a 'not dialed' alert", async () => {
    const id = await person("BOOK1");
    await fire(id, "tag.added", { tag: "leap-buyer" }); await run(T0);
    expect(await field(id, "next_call_due")).toBe("2026-12-02");
    await fire(id, "appointment.booked", {}); await run(T0.plus({ minutes: 1 }));
    expect(await field(id, "cycle_status")).toBe("Removed"); expect(await field(id, "last_outcome")).toBe("Booked"); expect(await field(id, "next_call_due")).toBeNull();
    await run(T0.plus({ hours: 4, minutes: 2 }));
    expect((await runOf(id))[0]).toMatchObject({ status: "completed", exit_reason: "left the cycle" });
    const late = await asOperator((c) => many(c, "select 1 from sends s join runs r on r.id=s.run_id where r.contact_id=$1 and s.channel='slack'", [id]));
    expect(late).toEqual([]);
  });

  it("a no-show: a new cycle (reason No-show, reset 1); the third no-show goes to long-term nurture instead", async () => {
    const id = await person("NOSHOW1");
    const ctx = { appointment: { term: { category: "closing" } } };
    const a1 = await pastBooking(id, "NS-A1"), a2 = await pastBooking(id, "NS-A2");
    await fire(id, "appointment.status_changed", { status: { to: "noshow" } }, ctx, a1); await run(T0);
    expect(await field(id, "entry_reason")).toBe("No-show"); expect(await field(id, "no_show_resets")).toBe("1"); expect(await field(id, "next_call_due")).toBe("2026-12-02");
    await asOperator((c) => c.query("update contacts set ghl_fields = ghl_fields || '{\"F-no_show_resets\":\"2\"}'::jsonb where id=$1", [id]));
    await fire(id, "appointment.status_changed", { status: { to: "noshow" } }, ctx, a2); await run(T0.plus({ minutes: 1 }));
    expect(await field(id, "cycle_status")).toBe("Long-term Nurture"); expect(await field(id, "next_call_due")).toBeNull();
  });

  it("dq-financial takes them out; the operator's enrollment starts someone already there (dry run first, once only)", async () => {
    const dq = await person("DQ1");
    await fire(dq, "tag.added", { tag: "leap-buyer" }); await run(T0);
    await fire(dq, "tag.added", { tag: "dq-financial" }); await run(T0.plus({ minutes: 1 }));
    expect(await field(dq, "cycle_status")).toBe("Removed"); expect(await field(dq, "last_outcome")).toBe("Financial DQ");
    const old = await person("OLD1");
    const slug = (await asOperator((c) => one<{ slug: string }>(c, "select slug from companies where id=$1", [co])))!.slug;
    const call = (dryRun: boolean) => enroll(new Request("http://x/api/admin/workflows/enroll", { method: "POST", headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ company: slug, workflow: "dial-cadence", contacts: [old], data: { entry_reason: "Never booked" }, why: "test", dryRun }) }));
    expect(await (await call(true)).json()).toMatchObject({ ok: true, dryRun: true, would_start: 1 });
    expect(await runOf(old)).toEqual([]);
    expect(await (await call(false)).json()).toMatchObject({ ok: true, dryRun: false, would_start: 1 });
    await run(T0);
    expect(await field(old, "cycle_status")).toBe("Active"); expect(await field(old, "next_call_due")).toBe("2026-12-02");
    expect(await (await call(true)).json()).toMatchObject({ would_start: 0, rows: [{ starts: false, why: "already in it" }] });
    // the backfill: someone who came in 30 days ago starts at call #8 (Weekly), 7 calls behind them, due at once
    const back = await person("BACK1");
    const res = await enroll(new Request("http://x/api/admin/workflows/enroll", { method: "POST", headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ company: slug, workflow: "dial-cadence", contacts: [back], data: { entry_reason: "Never booked", start_at: 8, attempts_done: 7, cycle_start: T0.minus({ days: 30 }).toISO() }, why: "backfill test", dryRun: false }) }));
    expect(await res.json()).toMatchObject({ ok: true, would_start: 1 });
    await run(T0); await run(T0.plus({ seconds: 30 }));
    expect(await field(back, "attempt_count")).toBe("7"); expect(await field(back, "next_call_due")).toBe("2026-12-02");
    expect((await runOf(back))[0].current_node).toBe("dial");
  });
});
