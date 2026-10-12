/** Who does what on the team: closers from `closers`, everyone else's job from `roles` (setter, manager, owner, staff). */
import { describe, it, expect, beforeAll } from "vitest";
import { asOperator, many, one } from "@/db/client";
import { migrate } from "@/db/migrate";
import { installCompany } from "@/engine/install";
import { fakeAdapters } from "@/engine/test-install";

process.env.BINDINGS_KEY ??= Buffer.alloc(32, 7).toString("base64");
const base = fakeAdapters();
const fake = { ...base, read: { ...base.read, listUsers: async () => [{ id: "U1", name: "Cal Closer", email: "cal@x.com" }, { id: "U2", name: "Lu Setter", email: "lu@x.com" }, { id: "U3", name: "Lea Manager", email: "Lea@x.com" }, { id: "U4", name: "Jo Away", email: "jo@x.com" }] } };

describe.skipIf(!process.env.DATABASE_URL)("team roles at install", () => {
  beforeAll(async () => {
    await migrate();
    await asOperator(async (c) => {
      const co = await one<{ id: string }>(c, "select id from companies where slug='roles'");
      if (co) { for (const t of ["workflow_versions w using workflows x where w.workflow_id=x.id and x.company_id=$1", "workflow_triggers where company_id=$1", "workflows where company_id=$1", "users where company_id=$1", "calendars where company_id=$1", "company_terms where company_id=$1", "bindings where company_id=$1"]) await c.query(`delete from ${t}`, [co.id]).catch(() => undefined); await c.query("delete from companies where id=$1", [co.id]).catch(() => undefined); }
    });
  });
  it("closers, setters and managers are set by email (any case); the rest stay staff; a later install without `roles` leaves them as they are", async () => {
    const input = { name: "Roles", slug: "roles", timezone: "America/Phoenix", locationId: "LOC-R", pit: "pit-fake", calendars: {}, templates: [], closers: ["cal@x.com"] };
    const r = await installCompany({ ...input, roles: { "LU@x.com": "setter", "lea@x.com": "manager" } }, fake as never);
    const roles = async () => Object.fromEntries((await asOperator((c) => many<{ name: string; role: string }>(c, "select name, role from users where company_id=$1", [r.companyId]))).map((u) => [u.name, u.role]));
    expect(await roles()).toEqual({ "Cal Closer": "closer", "Lu Setter": "setter", "Lea Manager": "manager", "Jo Away": "staff" });
    await installCompany(input, fake as never);
    expect(await roles()).toEqual({ "Cal Closer": "closer", "Lu Setter": "setter", "Lea Manager": "manager", "Jo Away": "staff" });
  });
});
