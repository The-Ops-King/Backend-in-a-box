/** D338: a recording the history pass brought in silently gets the event a live delivery would have made, once; nothing runs here. */
import { describe, it, expect, beforeAll } from "vitest";
import { asOperator, many, one } from "@/db/client";
import { migrate } from "@/db/migrate";
import { releaseBackfilled } from "./recording-release";

let co: string, ct: string, linked: string, unlinked: string, live: string;
const rec = async (c: Parameters<Parameters<typeof asOperator>[0]>[0], ext: string, raw: Record<string, unknown>, contact: string | null) =>
  (await one<{ id: string }>(c, `insert into recordings (company_id, contact_id, provider, external_id, title, started_at, invitees, link_status, linked_by, unlinked_reason, raw)
    values ($1,$2,'fathom',$3,'A call','2026-11-12T20:00:00Z',$4,$5,$6,$7,$8) returning id`, [co, contact, ext, JSON.stringify([{ name: "Taylor", email: "t@x.com" }]), contact ? "linked" : "unlinked", contact ? "email" : null, contact ? null : "only the team was invited", raw]))!.id;

describe.skipIf(!process.env.DATABASE_URL)("D338: releasing a silently backfilled recording", () => {
  beforeAll(async () => {
    await migrate();
    await asOperator(async (c) => {
      const old = await one<{ id: string }>(c, "select id from companies where slug='releaseco'");
      if (old) { for (const t of ["audit_log", "events", "recordings", "contacts"]) await c.query(`delete from ${t} where company_id=$1`, [old.id]); await c.query("delete from companies where id=$1", [old.id]); }
      co = (await one<{ id: string }>(c, "insert into companies (name, slug, timezone, status) values ('Release Co','releaseco','UTC','active') returning id"))!.id;
      ct = (await one<{ id: string }>(c, "insert into contacts (company_id, ghl_contact_id, first_name) values ($1,'G1','Ana') returning id", [co]))!.id;
      linked = await rec(c, "f1", { backfill: true }, ct);
      unlinked = await rec(c, "f2", { backfill: true }, null);
      live = await rec(c, "f3", {}, ct);
    });
  });

  it("the dry run says which event each would get and emits nothing; a live recording is refused", async () => {
    const r = await asOperator((c) => releaseBackfilled(c, co, [linked, unlinked, live], { why: "t" }));
    expect(r.recordings).toMatchObject([{ recording: linked, would: "emit recording.received" }, { recording: unlinked, would: "emit recording.unlinked" }, { recording: live, refused: expect.stringMatching(/not brought in/) }]);
    expect(await asOperator((c) => many(c, "select 1 from events where company_id=$1", [co]))).toHaveLength(0);
  });

  it("the write emits each once, as a live delivery would, and a second release is refused", async () => {
    const r = await asOperator((c) => releaseBackfilled(c, co, [linked, unlinked], { why: "t", dryRun: false }));
    expect(r.recordings).toMatchObject([{ event_id: expect.anything() }, { event_id: expect.anything() }]);
    const evs = await asOperator((c) => many<{ event_type: string; contact_id: string | null; data: Record<string, unknown> }>(c, "select event_type, contact_id, data from events where company_id=$1 order by event_type", [co]));
    expect(evs).toMatchObject([{ event_type: "recording.received", contact_id: ct, data: { recording_id: linked, matched_by: "email", released: true } }, { event_type: "recording.unlinked", contact_id: null, data: { recording_id: unlinked, reason: "only the team was invited", attendees: "t@x.com" } }]);
    const again = await asOperator((c) => releaseBackfilled(c, co, [linked], { why: "t", dryRun: false }));
    expect(again.recordings).toMatchObject([{ refused: expect.stringMatching(/already has recording.received/) }]);
    expect(await asOperator((c) => many(c, "select 1 from runs where company_id=$1", [co]))).toHaveLength(0);
  });
});
