/** D365: Zoom decides whether a booked call happened; the call check tells the team when Zoom saw the prospect and nothing recorded it. */
import { describe, it, expect, beforeAll, vi } from "vitest";
vi.mock("next/server", async (orig) => ({ ...(await orig<typeof import("next/server")>()), after: () => undefined }));   // the route works its runs after answering; here the test ticks
import { createHmac } from "node:crypto";
import { DateTime } from "luxon";
import { asOperator, many, one } from "@/db/client";
import { migrate } from "@/db/migrate";
import { installCompany } from "@/engine/install";
import { setBinding } from "@/engine/settings";
import { tick } from "@/engine/runner";
import { fakeAdapters } from "@/engine/test-install";
import { parseZoomEvent, urlValidationAnswer, zoomSignatureOk } from "./webhooks/zoom";
import { verdictOf } from "./zoom";
import { POST as zoomRoute } from "../../app/api/webhooks/zoom/[companyId]/route";

process.env.BINDINGS_KEY ??= Buffer.alloc(32, 7).toString("base64");
const SECRET = "zoom-secret-d365";
const sign = (raw: string, ts = Math.floor(Date.now() / 1000)) => ({ ts: String(ts), sig: `v0=${createHmac("sha256", SECRET).update(`v0:${ts}:${raw}`).digest("hex")}` });

describe("D365: Zoom webhook rules", () => {
  it("accepts only Zoom's signature, recent; answers the URL validation", () => {
    const raw = '{"event":"x"}', { ts, sig } = sign(raw);
    expect(zoomSignatureOk(SECRET, raw, ts, sig)).toBe(true);
    expect(zoomSignatureOk("other", raw, ts, sig)).toBe(false);
    expect(zoomSignatureOk(SECRET, raw, String(Number(ts) - 600), sign(raw, Number(ts) - 600).sig)).toBe(false);   // a replay
    expect(urlValidationAnswer(SECRET, "abc")).toEqual({ plainToken: "abc", encryptedToken: createHmac("sha256", SECRET).update("abc").digest("hex") });
  });
  it("reads joins, leaves and the end; webinars and other events are not used", () => {
    const o = { id: 123, uuid: "U1", start_time: "2026-11-24T18:00:00Z" };
    expect(parseZoomEvent({ event: "meeting.participant_joined", payload: { object: { ...o, participant: { email: "A@B.com", user_name: "Ann", join_time: "2026-11-24T18:01:00Z" } } } }))
      .toMatchObject({ ok: true, event: { kind: "participant", event: "joined", meetingId: "123", key: "a@b.com" } });
    expect(parseZoomEvent({ event: "meeting.ended", payload: { object: { ...o, end_time: "2026-11-24T18:40:00Z" } } })).toMatchObject({ ok: true, event: { kind: "ended" } });
    expect(parseZoomEvent({ event: "webinar.participant_joined", payload: { object: o } }).ok).toBe(false);
  });
  it("held when a prospect stayed 5 minutes; no-show when only the team or a bot came; unclear when the prospect only popped in", () => {
    const p = (minutes: number, x: Partial<{ team: boolean; bot: boolean }> = {}) => ({ key: "k", name: "n", email: null, minutes, team: false, bot: false, ...x });
    expect(verdictOf([p(30, { team: true }), p(12)]).verdict).toBe("held");
    expect(verdictOf([p(30, { team: true }), p(30, { bot: true })]).verdict).toBe("no_show");
    expect(verdictOf([p(30, { team: true }), p(2)]).verdict).toBe("unclear");
  });
});

describe.skipIf(!process.env.DATABASE_URL)("D365: the call check through the real engine", () => {
  const fake = fakeAdapters();
  let co = "", contact = "";
  const T0 = DateTime.now().minus({ hours: 3 }).startOf("minute");
  const post = async (body: Record<string, unknown>) => {
    const raw = JSON.stringify(body), { ts, sig } = sign(raw);
    const res = await zoomRoute(new Request(`http://x/api/webhooks/zoom/${co}`, { method: "POST", headers: { "x-zm-request-timestamp": ts, "x-zm-signature": sig, "content-type": "application/json" }, body: raw }), { params: Promise.resolve({ companyId: co }) });
    return { status: res.status, body: await res.json() as Record<string, unknown> };
  };
  const booking = (meeting: string) => asOperator(async (c) => (await one<{ id: string }>(c, `insert into appointments (company_id, contact_id, source, external_id, appointment_term, starts_at, ends_at, booked_at, status, meeting_key)
    values ($1,$2,'test',$3,(select id from company_terms where company_id=$1 and category='closing' order by sort limit 1), $4, $4::timestamptz + interval '1 hour', now() - interval '2 days', 'confirmed', $5) returning id`, [co, contact, `ext-${meeting}`, T0.toJSDate(), meeting]))!.id);
  const meeting = async (id: string, uuid: string, who: { email?: string; name: string; from: number; to: number }[]) => {
    const object = { id, uuid, topic: "Leap Welcome Call", start_time: T0.toISO() };
    for (const w of who) {
      await post({ event: "meeting.participant_joined", payload: { object: { ...object, participant: { email: w.email, user_name: w.name, join_time: T0.plus({ minutes: w.from }).toISO() } } } });
      await post({ event: "meeting.participant_left", payload: { object: { ...object, participant: { email: w.email, user_name: w.name, leave_time: T0.plus({ minutes: w.to }).toISO() } } } });
    }
    return post({ event: "meeting.ended", payload: { object: { ...object, end_time: T0.plus({ minutes: 45 }).toISO() } } });
  };
  const alerts = () => asOperator((c) => many<{ rendered_body: string }>(c, "select s.rendered_body from sends s join runs r on r.id=s.run_id where r.company_id=$1 and s.channel='slack'", [co]));
  const later = async () => { await tick(fake, DateTime.now() as DateTime<true>, co); await asOperator((c) => c.query("update runs set next_run_at=now() where company_id=$1 and status='waiting'", [co])); await tick(fake, DateTime.now().plus({ hours: 3 }) as DateTime<true>, co); };

  beforeAll(async () => {
    await migrate();
    co = (await installCompany({ name: "Zoom Check", slug: `d365-${Date.now()}`, timezone: "America/Los_Angeles", locationId: "LOC-D365", pit: "pit-fake", calendars: {}, templates: ["zoom-call-check"], enable: true } as never, fake)).companyId;
    await asOperator(async (c) => {
      await c.query("update companies set mode='live' where id=$1", [co]);
      await setBinding(c, co, "secret.zoom_webhook", "secret", SECRET, "test");
      await c.query("insert into users (company_id, name, email, ghl_user_id, role) values ($1,'Nick Rowe','nick@trc.test','NICK','closer')", [co]);
      contact = (await one<{ id: string }>(c, "insert into contacts (company_id, ghl_contact_id, first_name, last_name, tags) values ($1,'G-ANN','Ann','Prospect','{}') returning id", [co]))!.id;
    });
  }, 60_000);

  it("refuses a request Zoom did not sign, and answers Zoom's URL validation", async () => {
    const bad = await zoomRoute(new Request(`http://x/api/webhooks/zoom/${co}`, { method: "POST", headers: { "x-zm-request-timestamp": "1", "x-zm-signature": "v0=no" }, body: "{}" }), { params: Promise.resolve({ companyId: co }) });
    expect(bad.status).toBe(401);
    expect((await post({ event: "endpoint.url_validation", payload: { plainToken: "tok" } })).body).toEqual(urlValidationAnswer(SECRET, "tok"));
  });

  it("the prospect was on the call and nothing recorded it: the team is told 2 hours later, once", async () => {
    const appt = await booking("111");
    const ended = await meeting("111", "UUID-HELD", [{ email: "nick@trc.test", name: "Nick Rowe", from: 0, to: 45 }, { name: "Nick's Fathom Notetaker", from: 0, to: 45 }, { email: "ann@x.test", name: "Ann Prospect", from: 2, to: 40 }]);
    expect(ended.body).toMatchObject({ booking: appt, verdict: "held", started: 1 });
    expect((await meeting("111", "UUID-HELD", [])).body).toMatchObject({ duplicate: true });   // Zoom retries: one verdict
    await later();
    expect((await alerts()).map((a) => a.rendered_body)).toEqual([expect.stringMatching(/^\*Call happened, no recording:\*.*Ann Prospect.*Zoom shows them on the call for 38 minutes.*It is not a no-show/s)]);
  });

  it("a recording that arrived in the 2 hours: nothing is said", async () => {
    const before = (await alerts()).length;
    const appt = await booking("222");
    await meeting("222", "UUID-REC", [{ email: "nick@trc.test", name: "Nick Rowe", from: 0, to: 45 }, { email: "ann@x.test", name: "Ann Prospect", from: 1, to: 44 }]);
    await asOperator((c) => c.query("insert into recordings (company_id, contact_id, appointment_id, provider, external_id, started_at, link_status, raw) values ($1,$2,$3,'fathom','F-222',$4,'linked','{}')", [co, contact, appt, T0.toJSDate()]));
    await later();
    expect(await alerts()).toHaveLength(before);
  });

  it("only the team and a bot joined: a no-show by Zoom's word, and no alert", async () => {
    const before = (await alerts()).length;
    const appt = await booking("333");
    const ended = await meeting("333", "UUID-NS", [{ email: "nick@trc.test", name: "Nick Rowe", from: 0, to: 20 }, { name: "Fathom Notetaker", from: 0, to: 20 }]);
    expect(ended.body).toMatchObject({ booking: appt, verdict: "no_show", started: 0 });
    const ev = await asOperator((c) => one<{ data: { verdict: string; team: string[] } }>(c, "select data from events where company_id=$1 and appointment_id=$2 and event_type='zoom.meeting_ended'", [co, appt]));
    expect(ev?.data).toMatchObject({ verdict: "no_show", team: ["Nick Rowe"] });
    await later();
    expect(await alerts()).toHaveLength(before);
  });

  it("a meeting no booking has is kept, and nothing is fired", async () => {
    expect((await meeting("999", "UUID-NONE", [{ email: "ann@x.test", name: "Ann Prospect", from: 0, to: 30 }])).body).toMatchObject({ ok: true, booking: null });
  });
});
