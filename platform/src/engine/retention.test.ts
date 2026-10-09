import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { asOperator } from "@/db/client";
import { migrate } from "@/db/migrate";
import { purgeOld } from "./retention";

const slug = "ret";
let companyId = "", contactId = "";
beforeAll(async () => {
  await migrate();
  await asOperator(async (c) => {
    const co = await c.query("select id from companies where slug=$1", [slug]);
    if (co.rows[0]) { for (const t of ["messages", "sends", "contacts"]) await c.query(`delete from ${t} where company_id=$1`, [co.rows[0].id]); await c.query("delete from companies where id=$1", [co.rows[0].id]); }
    companyId = (await c.query("insert into companies (name, slug, timezone) values ('Retention','ret','America/New_York') returning id")).rows[0].id;
    contactId = (await c.query("insert into contacts (company_id, ghl_contact_id, first_name) values ($1,'R1','Ray') returning id", [companyId])).rows[0].id;
  });
});
afterAll(async () => { await asOperator(async (c) => { for (const t of ["messages", "sends", "contacts"]) await c.query(`delete from ${t} where company_id=$1`, [companyId]); await c.query("delete from companies where id=$1", [companyId]); }); });

describe("D38 retention", () => {
  it("drops old replies and finished runs' old sends, keeps the recent and the live", async () => {
    await asOperator(async (c) => {
      await c.query("insert into messages (company_id, contact_id, ghl_message_id, channel, direction, body, occurred_at) values ($1,$2,'old','sms','inbound','yes',now()-interval '8 days'),($1,$2,'new','sms','inbound','yes',now()-interval '1 hour')", [companyId, contactId]);
      await c.query("insert into sends (company_id, contact_id, channel, idempotency_key, rendered_body, status, sent_at) values ($1,$2,'sms','k-old','hi','shadow',now()-interval '40 days'),($1,$2,'sms','k-new','hi','shadow',now()-interval '2 days')", [companyId, contactId]);
    });
    const r = await asOperator((c) => purgeOld(c));
    expect(r.replies).toBe(1); expect(r.sends).toBe(1);
    const left = await asOperator(async (c) => ({ m: (await c.query("select ghl_message_id from messages where company_id=$1", [companyId])).rows.map((x) => x.ghl_message_id), s: (await c.query("select idempotency_key from sends where company_id=$1", [companyId])).rows.map((x) => x.idempotency_key) }));
    expect(left.m).toEqual(["new"]); expect(left.s).toEqual(["k-new"]);
  });
});
