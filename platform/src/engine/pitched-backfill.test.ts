/** D226 backfill: recorded closing calls read for whether they were pitched; a dry run first, then only a person's answers are written. */
import { describe, it, expect, beforeAll } from "vitest";
import { asOperator, one } from "@/db/client";
import { migrate } from "@/db/migrate";
import { backfillPitched } from "./pitched-backfill";
import { fakeAdapters } from "./test-install";
import type { Adapters } from "@/adapters/types";

process.env.BINDINGS_KEY ??= Buffer.alloc(32, 7).toString("base64");
process.env.ANTHROPIC_API_KEY ??= "test";
let companyId = "", carly = "", jp = "", term = "";
const read: string[] = [];
const fake: Adapters = { ...fakeAdapters(), analyst: { analyze: async (_k, req) => { read.push(req.input); return { text: "", parsed: req.input.includes("ten thousand") ? { pitched: true, evidence: "the investment is ten thousand" } : { pitched: false, evidence: "booked a second call" }, model: "fake", usage: { input: 0, output: 0, cacheRead: 0 } }; } } };

async function call(closer: string, at: string, said: string | null) {
  return asOperator(async (c) => {
    const ct = (await one<{ id: string }>(c, "insert into contacts (company_id, first_name) values ($1,'P') returning id", [companyId]))!.id;
    const a = (await one<{ id: string }>(c, "insert into appointments (company_id, contact_id, source, external_id, appointment_term, starts_at, ends_at, booked_at, status, assigned_user_id) values ($1,$2,'calendly',$3,$4,$5,$5,now(),'confirmed',$6) returning id", [companyId, ct, `E${Math.random()}`, term, at, closer]))!.id;
    if (said !== null) await c.query("insert into recordings (company_id, contact_id, appointment_id, provider, external_id, started_at, transcript, share_url) values ($1,$2,$3,'fathom',$4,$5,$6,'https://fathom.video/share/x')", [companyId, ct, a, `R${Math.random()}`, at, JSON.stringify([{ speaker: "Carly", text: said }])]);
    return a;
  });
}

describe.skipIf(!process.env.DATABASE_URL)("D226: backfilling pitched from recordings", () => {
  beforeAll(async () => {
    await migrate();
    await asOperator(async (c) => {
      companyId = (await one<{ id: string }>(c, "insert into companies (name, slug, timezone) values ('D226b',$1,'America/New_York') returning id", [`d226b-${Date.now()}`]))!.id;
      await c.query("insert into company_terms (company_id, domain, name, category, is_default, sort) select $1, domain, label, value, true, sort from core_categories", [companyId]);
      term = (await one<{ id: string }>(c, "select id from company_terms where company_id=$1 and domain='appointment_type' and category='closing'", [companyId]))!.id;
      carly = (await one<{ id: string }>(c, "insert into users (company_id, email, name, role) values ($1,'carly@x.com','Carly','closer') returning id", [companyId]))!.id;
      jp = (await one<{ id: string }>(c, "insert into users (company_id, email, name, role) values ($1,'jp@x.com','JP','closer') returning id", [companyId]))!.id;
    });
  });

  it("the dry run reads each recorded call nobody answered, skips the unrecorded and the closers left out, and writes nothing; the write sets only the answers given", async () => {
    const yes = await call(carly, "2026-10-14T17:30:00Z", "The investment is ten thousand dollars.");
    const no = await call(carly, "2026-10-15T17:30:00Z", "Let's get you on a second call.");
    const none = await call(carly, "2026-10-16T17:30:00Z", null);
    const jps = await call(jp, "2026-10-16T19:30:00Z", "The investment is ten thousand dollars.");
    const window = { from: new Date("2026-10-14T00:00:00Z"), to: new Date("2026-10-17T00:00:00Z"), exclude: ["JP@x.com"] };
    const dry = await asOperator((c) => backfillPitched(c, fake, companyId, { ...window, dryRun: true }));
    expect(dry.rows.map((r) => [r.appointment, r.pitched])).toEqual([[yes, true], [no, false]]);
    expect(read).toHaveLength(2);
    expect(await asOperator((c) => one(c, "select count(*)::int as n from appointments where company_id=$1 and pitched is not null", [companyId]))).toEqual({ n: 0 });

    const w = await asOperator((c) => backfillPitched(c, fake, companyId, { ...window, dryRun: false, decide: { [yes]: true, [no]: true } }));   // the person overrode one
    expect(w.written).toBe(2);
    for (const [id, v] of [[yes, true], [no, true], [none, null], [jps, null]] as const) expect(await asOperator((c) => one(c, "select pitched from appointments where id=$1", [id]))).toEqual({ pitched: v });
    // an answer already given is not overwritten
    expect((await asOperator((c) => backfillPitched(c, fake, companyId, { ...window, dryRun: false, decide: { [yes]: false } }))).written).toBe(0);
  });
});
