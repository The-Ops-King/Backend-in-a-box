import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closeDb, db } from "@/db/client";
import { events } from "@/db/schema";
import { MAX_ROWS, queryViews } from "./query-views";
import { type Bench, slackBench } from "./testkit";

/** The bot's read-only SQL: views of one offer's rows only, a time limit, no writes, nothing left behind. */
describe.skipIf(!process.env.DATABASE_URL)("query_views", () => {
  afterAll(closeDb);
  let b: Bench;
  beforeEach(async () => {
    b = await slackBench({ offers: [{ slug: "acme" }, { slug: "pmu" }] });
    const rows = (offer: string, n: number) => Array.from({ length: n }, (_, i) => ({ offerId: offer, type: "lead.created", occurredAt: b.clock.now(), contactId: `c${i}`, source: "test", dedupeKey: `q:${offer}:${i}`, payload: {} }));
    await db().insert(events).values([...rows(b.offers.acme!, 250), ...rows(b.offers.pmu!, 7)]);
  });

  it("sees only the offer's own rows", async () => {
    expect(await queryViews(db(), b.offers.pmu!, "select count(*)::int n from facts")).toEqual({ ok: true, rows: [{ n: 7 }], truncated: false });
    expect(await queryViews(db(), b.offers.acme!, "select count(*)::int n from facts")).toEqual({ ok: true, rows: [{ n: 250 }], truncated: false });
  });

  it("gives at most MAX_ROWS rows, and says it cut them", async () => {
    const r = await queryViews(db(), b.offers.acme!, "select id from facts");
    expect(r).toMatchObject({ ok: true, truncated: true });
    expect(r.ok && r.rows.length).toBe(MAX_ROWS);
  });

  it("stops a query that runs past its time", async () => {
    const r = await queryViews(db(), b.offers.acme!, "select count(*) from facts a, facts b, facts c, facts d", 200);
    expect(r).toEqual({ ok: false, why: "the query took longer than 200 ms" });
  });

  it("cannot reach the tables behind the views, and leaves nothing behind for the next query on the same connection", async () => {
    expect(await queryViews(db(), b.offers.acme!, "select count(*) from events")).toMatchObject({ ok: false, why: expect.stringMatching(/does not exist/) });
    for (let i = 0; i < 3; i++) expect((await queryViews(db(), b.offers.pmu!, "select count(*)::int n from facts")).ok).toBe(true);
    const leftover = await db().execute((await import("drizzle-orm")).sql`select count(*)::int n from pg_class where relname = 'facts' and relpersistence = 't'`);
    expect(leftover.rows[0]).toEqual({ n: 0 });
  });
});
