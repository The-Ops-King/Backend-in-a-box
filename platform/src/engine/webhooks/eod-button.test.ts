/** D303: "File my EOD" answers the presser with their own links, one per day they still owe in GHL, never anyone else's. */
import { describe, it, expect, beforeAll } from "vitest";
import { DateTime } from "luxon";
import { asOperator, one } from "@/db/client";
import { migrate } from "@/db/migrate";
import { encrypt } from "../crypto";
import { liveGhlReads, type GhlReads } from "@/adapters/ghl/metrics";
import { fakeAdapters } from "../test-install";
import { eodButtonReply } from "./eod-button";

process.env.BINDINGS_KEY ??= Buffer.alloc(32, 7).toString("base64");
process.env.PUBLIC_URL = "https://biab.test";
const TZ = "America/New_York";
let co = "";
const at = (n: number) => DateTime.now().setZone(TZ).minus({ days: n }).set({ hour: 11, minute: 0, second: 0, millisecond: 0 });
const rec = (id: string, closer: string, name: string, n: number) => ({ id, createdAt: "", properties: { closer, outcome: "scheduled", contact_id: `G-${id}`, call_date: at(n).toISODate(), scheduled_at: at(n).toISO(), display_label: `${name} — ${at(n).toISODate()}` } });
let SALES = [rec("S1", "Jose P", "Tommy", 2), rec("S2", "Mel R", "Ana", 1)];
const reads: GhlReads = { ...liveGhlReads, objectRecords: async (_c, object) => (object === "custom_objects.sales_call" ? SALES : []), recordContact: async () => null };

describe.skipIf(!process.env.DATABASE_URL)("D303: File my EOD", () => {
  beforeAll(async () => {
    await migrate();
    await asOperator(async (c) => {
      co = (await one<{ id: string }>(c, "insert into companies (name, slug, timezone) values ('D303',$1,$2) returning id", [`d303-${Date.now()}`, TZ]))!.id;
      await c.query("insert into company_terms (company_id, domain, name, category, is_default, sort) select $1, domain, label, value, true, sort from core_categories", [co]);
      await c.query("insert into users (company_id, email, name, role, slack_user_id, report_token) values ($1,'jp@x.test','Jose P','closer','UJOSE','er_jose'),($1,'mel@x.test','Mel R','closer','UMEL','er_mel')", [co]);
      await c.query("insert into bindings (company_id,key,kind,value) values ($1,'crm.location_id','id',convert_to('LOC','UTF8')),($1,'secret.ghl_pit','secret',$2),($1,'crm.object_sales_call','text',convert_to('custom_objects.sales_call','UTF8')),($1,'sales_call.outcomes','text',convert_to('{\"scheduled\":\"scheduled\",\"showed\":\"showed\"}','UTF8'))", [co, encrypt("pit")]);
    });
  });

  it("the presser gets their own link for each day they owe and today; another closer's day and link are not in it", async () => {
    const say = await asOperator((c) => eodButtonReply(c, fakeAdapters(), co, "UJOSE", DateTime.now(), reads));
    expect(say).toMatch(/^Your end of day, Jose\. Still to file:/);
    expect(say).toContain(`<https://biab.test/eod/er_jose?day=${at(2).toISODate()}|`);
    expect(say).toContain("Tommy");
    expect(say).toContain("<https://biab.test/eod/er_jose|Today>");
    expect(say).not.toMatch(/er_mel|Ana/);
  });

  it("nothing owed: today's form; someone not on the team: told so, no link", async () => {
    SALES = [rec("S2", "Mel R", "Ana", 1)];
    expect(await asOperator((c) => eodButtonReply(c, fakeAdapters(), co, "UJOSE", DateTime.now(), reads))).toBe("You're filed up to yesterday, Jose. <https://biab.test/eod/er_jose|Open today's end of day>");
    const stranger = await asOperator((c) => eodButtonReply(c, fakeAdapters(), co, "UNOBODY", DateTime.now(), reads));
    expect(stranger).toMatch(/not on this offer's team/);
    expect(stranger).not.toMatch(/eod\//);
  });

  it("GHL unread: their own link still, said plainly", async () => {
    const broken: GhlReads = { ...reads, objectRecords: async () => { throw new Error("GHL 503"); } };
    expect(await asOperator((c) => eodButtonReply(c, fakeAdapters(), co, "UJOSE", DateTime.now(), broken))).toMatch(/^Here's your end of day, Jose: <https:\/\/biab\.test\/eod\/er_jose\|Open your form>/);
  });
});
