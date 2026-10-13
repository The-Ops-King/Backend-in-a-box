/** D99: the cards poll reads what it knows about a board in two queries; a card unchanged since the engine last saw it costs nothing, a moved one is still caught. */
import { describe, it, expect, beforeAll } from "vitest";
import type { PoolClient } from "pg";
import { asOperator, one } from "@/db/client";
import { migrate } from "@/db/migrate";
import { installCompany } from "@/engine/install";
import { loadCompany } from "@/engine/context";
import { emptyPollReport, pollCards } from "@/engine/poll";
import { fakeAdapters } from "@/engine/test-install";
import type { LiveCard } from "@/adapters/types";

process.env.BINDINGS_KEY ??= Buffer.alloc(32, 7).toString("base64");
const N = 50;
let companyId: string;
let board: LiveCard[] = [];
const fake = { ...fakeAdapters(), read: { ...fakeAdapters().read, pipelineCards: async () => board } };
const counted = (c: PoolClient, n: { q: number }) => new Proxy(c, { get: (t, k) => (k === "query" ? (...a: unknown[]) => { n.q++; return (t.query as (...x: unknown[]) => unknown).apply(t, a); } : Reflect.get(t, k)) }) as PoolClient;
const poll = (n: { q: number }) => asOperator(async (c) => { const { row, adapterCompany, bindings } = await loadCompany(c, companyId); const rep = emptyPollReport(); await pollCards(counted(c, n), row, adapterCompany, fake, rep, bindings); return rep; });

describe.skipIf(!process.env.DATABASE_URL)("the cards poll (D99)", () => {
  beforeAll(async () => {
    await migrate();
    await asOperator(async (c) => {
      const co = await one<{ id: string }>(c, "select id from companies where slug='cardpoll'");
      if (co) for (const t of ["events", "pipeline_cards", "opportunities", "contact_identifiers", "contacts", "poll_cursors", "workflow_triggers", "workflow_versions", "workflows", "company_terms", "calendars", "bindings", "audit_log"])
        await c.query(`delete from ${t} where ${t === "workflow_versions" ? "workflow_id in (select id from workflows where company_id=$1)" : "company_id=$1"}`, [co.id]);
    });
    companyId = (await installCompany({ name: "Card poll", slug: "cardpoll", timezone: "America/Phoenix", locationId: "LOC", pit: "pit-fake", calendars: {}, templates: [], crm: { pipeline_setter: "P", stage_setter_new_lead: "S1" } }, fakeAdapters())).companyId;
    const at = new Date(Date.now() - 3_600_000).toISOString();
    await asOperator(async (c) => {
      for (let i = 0; i < N; i++) await c.query("insert into contacts (company_id, ghl_contact_id, first_name) values ($1,$2,$3)", [companyId, `G${i}`, `P${i}`]);
    });
    board = Array.from({ length: N }, (_, i) => ({ id: `O${i}`, pipelineId: "P", stageId: "S1", status: "open", name: `P${i}`, updatedAt: at, contactId: `G${i}` }));
  });

  it("the first look adopts every card; after that 50 unchanged cards take a handful of queries, not four each; a card moved since is still a hand move", async () => {
    await poll({ q: 0 });   // baseline: every card adopted, no moves said
    expect(Number((await asOperator((c) => one<{ n: string }>(c, "select count(*) as n from pipeline_cards where company_id=$1", [companyId])))!.n)).toBe(N);
    const quiet = { q: 0 };
    expect((await poll(quiet)).cardsMoved).toBe(0);
    expect(quiet.q).toBeLessThan(10);   // cursor, the two reads, the save: not 4 × 50
    board = board.map((k, i) => (i === 7 ? { ...k, stageId: "S2", updatedAt: new Date(Date.now() + 1000).toISOString() } : k));
    const one7 = { q: 0 };
    expect((await poll(one7)).cardsMoved).toBe(1);
    expect(await asOperator((c) => one(c, "select 1 from pipeline_cards where company_id=$1 and ghl_opportunity_id='O7' and ghl_stage_id='S2'", [companyId]))).toBeTruthy();
    expect(one7.q).toBeLessThan(40);   // the one moved card does its full work; the other 49 cost nothing
  });
});
