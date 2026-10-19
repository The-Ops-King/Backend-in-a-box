/**
 * D154: the engine runs active and hosted companies, and the one template business checked out to the sandbox; taking the
 * sandbox stops every other template business on the same GHL location, and none on another.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { asOperator, many, one } from "@/db/client";
import { migrate } from "@/db/migrate";
import { runningSql } from "./running";
import { leaveSandbox, takeSandbox } from "@/onboarding/tests";

describe.skipIf(!process.env.DATABASE_URL)("D154: the sandbox, one template business at a time", () => {
  const ids: Record<string, string> = {};
  const running = async () => (await asOperator((c) => many<{ slug: string }>(c, `select co.slug from companies co where co.slug like 'run-%' and ${runningSql()} order by co.slug`))).map((r) => r.slug);
  beforeAll(async () => {
    await migrate();
    await asOperator(async (c) => {
      await c.query("delete from bindings where company_id in (select id from companies where slug like 'run-%')");
      await c.query("delete from companies where slug like 'run-%'");
      for (const [slug, status, loc] of [["run-a", "template", "SANDBOX"], ["run-b", "template", "SANDBOX"], ["run-c", "template", "OTHER"], ["run-live", "active", "L1"], ["run-new", "onboarding", "L2"]] as const) {
        ids[slug] = (await one<{ id: string }>(c, "insert into companies (name, slug, timezone, mode, status) values ($1,$1,'America/Phoenix','ghost',$2) returning id", [slug, status]))!.id;
        await c.query("insert into bindings (company_id, key, kind, value) values ($1,'crm.location_id','id',$2)", [ids[slug], Buffer.from(loc)]);
      }
    });
  });

  it("runs active companies and no template business until one takes the sandbox", async () => {
    expect(await running()).toEqual(["run-live"]);
    await asOperator((c) => takeSandbox(c, ids["run-c"]));
    await asOperator((c) => takeSandbox(c, ids["run-a"]));
    expect(await running()).toEqual(["run-a", "run-c", "run-live"]);
  });

  it("taking it stops the other template business on the same location only; leaving it stops it", async () => {
    await asOperator((c) => takeSandbox(c, ids["run-b"]));
    expect(await running()).toEqual(["run-b", "run-c", "run-live"]);
    await asOperator((c) => takeSandbox(c, ids["run-b"]));   // again: nothing changes
    expect(await running()).toEqual(["run-b", "run-c", "run-live"]);
    await asOperator((c) => leaveSandbox(c, ids["run-b"]));
    expect(await running()).toEqual(["run-c", "run-live"]);
  });
});
