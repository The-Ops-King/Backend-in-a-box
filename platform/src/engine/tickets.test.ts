/** D152: /issue and /request open a numbered ticket per offer, posted where typed, the operator told; closing answers in its thread with a ✅. */
import { describe, it, expect, beforeAll } from "vitest";
import { asOperator, one } from "@/db/client";
import { migrate } from "@/db/migrate";
import { installCompany } from "@/engine/install";
import { encrypt } from "@/engine/crypto";
import { fakeAdapters } from "@/engine/test-install";
import { closeTicket, listTickets, openTicket } from "@/engine/tickets";
import type { Adapters } from "@/adapters/types";

process.env.BINDINGS_KEY ??= Buffer.alloc(32, 7).toString("base64");
const posts: { channel: string; text: string; thread?: string }[] = [], reacts: { channel: string; ts: string; emoji: string }[] = [];
const base = fakeAdapters();
const fake: Adapters = { ...base, notifier: { ...base.notifier, post: async (_t, channel, text, _as, thread) => { posts.push({ channel, text, thread }); return { ts: `${posts.length}.0001` }; },
  react: async (_t, channel, ts, emoji) => { reacts.push({ channel, ts, emoji }); return true; } } };
let companyId: string;

describe.skipIf(!process.env.DATABASE_URL)("D152: /issue and /request", () => {
  beforeAll(async () => {
    await migrate();
    delete process.env.GITHUB_TOKEN;
    await asOperator(async (c) => {
      const co = await one<{ id: string }>(c, "select id from companies where slug='tickets'");
      if (co) {
        await c.query("delete from workflow_versions where workflow_id in (select id from workflows where company_id=$1)", [co.id]);
        for (const t of ["tickets", "audit_log", "slack_connections", "bindings", "company_terms", "users", "calendars", "poll_cursors", "workflow_triggers", "workflows"]) await c.query(`delete from ${t} where company_id=$1`, [co.id]);
        await c.query("delete from companies where id=$1", [co.id]);
      }
    });
    companyId = (await installCompany({ name: "Ticket Co", slug: "tickets", timezone: "America/Phoenix", locationId: "LOC", pit: "pit-fake", calendars: {}, templates: [] }, fake)).companyId;
    await asOperator(async (c) => {
      await c.query("insert into slack_connections (company_id, team_id, bot_token, channels) values ($1,'T1',$2,'{}')", [companyId, encrypt("xoxb-fake")]);
      await c.query("insert into bindings (company_id, key, kind, value) values ($1,'bot.escalate_to','id',$2)", [companyId, Buffer.from("U-OP")]);
      await c.query("insert into users (company_id, email, name, role, slack_user_id) values ($1,'mia@t.co','Mia','closer','U-MIA')", [companyId]);
    });
  });

  it("opens numbered tickets per offer, posts them where typed with the thread ask, tells the operator, and records why there is no GitHub issue", async () => {
    const a = await openTicket(fake, companyId, { kind: "issue", text: "the EOD form won't load", slackUser: "U-MIA", channel: "C-SALES" });
    const b = await openTicket(fake, companyId, { kind: "request", text: "a no-show text for closing calls", slackUser: "U-MIA", channel: "C-SALES" });
    expect([a.number, b.number]).toEqual([1, 2]);
    expect(posts[0]).toMatchObject({ channel: "C-SALES", text: expect.stringMatching(/^🎫 \*Issue #1\* from <@U-MIA>\nthe EOD form won't load\n_Add a Loom or a screenshot in this thread/) });
    expect(posts[1]).toMatchObject({ channel: "U-OP", text: expect.stringMatching(/^🎫 New issue #1 at Ticket Co from Mia: the EOD form won't load\n_No GitHub issue: GITHUB_TOKEN/) });
    const rows = await asOperator((c) => listTickets(c, companyId));
    expect(rows.map((t) => [t.number, t.kind, t.status, t.slack_ts !== null, t.by_name])).toEqual([[2, "request", "open", true, "Mia"], [1, "issue", "open", true, "Mia"]]);
  });

  it("closing answers in the ticket's thread and puts a ✅ on its post; a second close is refused", async () => {
    const t = (await asOperator((c) => listTickets(c, companyId))).find((x) => x.number === 1)!;
    expect(await closeTicket(fake, companyId, 1, "fixed the form", "Tyler")).toEqual({ ok: true, ticket: 1 });
    expect(posts.at(-1)).toEqual({ channel: "C-SALES", text: "✅ Done: fixed the form", thread: t.slack_ts });
    expect(reacts.at(-1)).toEqual({ channel: "C-SALES", ts: t.slack_ts, emoji: "white_check_mark" });
    expect(await closeTicket(fake, companyId, 1, "again", "Tyler")).toMatchObject({ ok: false, status: 404 });
    expect((await asOperator((c) => listTickets(c, companyId, "closed"))).map((x) => x.number)).toEqual([1]);
  });
});
