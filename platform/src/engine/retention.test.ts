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
    if (co.rows[0]) { for (const t of ["messages", "sends", "runs", "workflows", "contacts"]) await c.query(`delete from ${t} where company_id=$1`, [co.rows[0].id]); await c.query("delete from companies where id=$1", [co.rows[0].id]); }
    companyId = (await c.query("insert into companies (name, slug, timezone) values ('Retention','ret','America/New_York') returning id")).rows[0].id;
    contactId = (await c.query("insert into contacts (company_id, ghl_contact_id, first_name) values ($1,'R1','Ray') returning id", [companyId])).rows[0].id;
  });
});
afterAll(async () => { await asOperator(async (c) => { for (const t of ["messages", "sends", "runs", "workflows", "contacts"]) await c.query(`delete from ${t} where company_id=$1`, [companyId]); await c.query("delete from companies where id=$1", [companyId]); }); });

describe("D38 retention", () => {
  it("drops old replies and finished runs' old sends, keeps the recent and the live", async () => {
    await asOperator(async (c) => {
      await c.query("insert into messages (company_id, contact_id, ghl_message_id, channel, direction, occurred_at) values ($1,$2,'old','sms','inbound',now()-interval '8 days'),($1,$2,'new','sms','inbound',now()-interval '1 hour')", [companyId, contactId]);
      await c.query("insert into sends (company_id, contact_id, channel, idempotency_key, rendered_body, status, sent_at) values ($1,$2,'sms','k-old','hi','ghost',now()-interval '40 days'),($1,$2,'sms','k-new','hi','ghost',now()-interval '2 days')", [companyId, contactId]);
    });
    const r = await asOperator((c) => purgeOld(c));
    expect(r.replies).toBe(1); expect(r.sends).toBe(1);
    const left = await asOperator(async (c) => ({ m: (await c.query("select ghl_message_id from messages where company_id=$1", [companyId])).rows.map((x) => x.ghl_message_id), s: (await c.query("select idempotency_key from sends where company_id=$1", [companyId])).rows.map((x) => x.idempotency_key) }));
    expect(left.m).toEqual(["new"]); expect(left.s).toEqual(["k-new"]);
  });
  it("D193: an old send is kept while its run can still go on (waiting, paused, failed: a retry would send it again), and goes once the run is over", async () => {
    const keys = await asOperator(async (c) => {
      const wf = (await c.query("insert into workflows (company_id, name, reentry_policy) values ($1,'Ret','once_per_contact') returning id", [companyId])).rows[0].id;
      for (const status of ["waiting", "paused", "failed", "completed", "exited"]) {
        const run = (await c.query("insert into runs (company_id, workflow_id, workflow_version, reentry_key, contact_id, status) values ($1,$2,1,$3,$4,$5) returning id", [companyId, wf, `ret-${status}`, contactId, status])).rows[0].id;
        await c.query("insert into sends (company_id, contact_id, run_id, channel, idempotency_key, rendered_body, status, sent_at) values ($1,$2,$3,'sms',$4,'hi','sent',now()-interval '40 days')", [companyId, contactId, run, `k-${status}`]);
      }
      await purgeOld(c);
      return (await c.query("select idempotency_key from sends where company_id=$1 and run_id is not null order by 1", [companyId])).rows.map((x) => x.idempotency_key);
    });
    expect(keys).toEqual(["k-failed", "k-paused", "k-waiting"]);
  });
});
