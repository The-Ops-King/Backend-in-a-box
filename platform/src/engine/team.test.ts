/** D197: an offer's team changed in one call: a new GHL user made a setter (the roster read again), Slack linked, then taken off. */
import { describe, it, expect, beforeAll } from "vitest";
import { asOperator, one } from "@/db/client";
import { migrate } from "@/db/migrate";
import { installCompany } from "./install";
import { loadCompany } from "./context";
import { changeTeam, teamOf } from "./team";
import { fakeAdapters } from "./test-install";
import type { Adapters } from "@/adapters/types";

process.env.BINDINGS_KEY ??= Buffer.alloc(32, 7).toString("base64");
const SLUG = `d197-${Date.now()}`;
let co = "";
const ghlUsers = [{ id: "U1", name: "Sam Closer", email: "sam@x.com" }];
const base = fakeAdapters();
const fake: Adapters = { ...base, read: { ...base.read, listUsers: async () => ghlUsers }, notifier: { ...base.notifier, lookupUserByEmail: async (_t, e) => (e === "riley@slack.x" ? "URILEY1" : null) } };
const change = (ch: Parameters<typeof changeTeam>[1]["change"]) => asOperator(async (c) => changeTeam(c, { companyId: co, ac: (await loadCompany(c, co)).adapterCompany, adapters: fake, slackToken: "xoxb", change: ch }));

describe.skipIf(!process.env.DATABASE_URL)("D197: an offer's team", () => {
  beforeAll(async () => {
    await migrate();
    co = (await installCompany({ name: "Team", slug: SLUG, timezone: "America/Phoenix", locationId: "LOC-D197", pit: "pit-fake", calendars: {}, templates: [] }, fake)).companyId;
  });

  it("a setter just added in GHL: the roster is read again, the role set, Slack linked by their Slack email; their setter link is said", async () => {
    expect(await change({ email: "riley@x.com", role: "setter" })).toMatchObject({ ok: false, status: 404, why: expect.stringContaining("not a GHL user") });
    ghlUsers.push({ id: "U2", name: "Riley Dials", email: "riley@x.com" });
    const r = await change({ email: "Riley@x.com", role: "setter", slack: "riley@slack.x" });
    expect(r).toMatchObject({ ok: true, synced: true, person: { name: "Riley Dials", role: "setter", slack_user_id: "URILEY1" }, was: { role: "staff" } });
    if (r.ok) expect(r.notes.join(" ")).toContain("utm_medium=setter&utm_content=riley");
    expect(await asOperator((c) => one(c, "select action from audit_log where company_id=$1 and action='team.changed'", [co]))).toEqual({ action: "team.changed" });
  });

  it("removed: the role comes off (staff), nothing else; a closer is added the same way; an unknown Slack email is refused", async () => {
    expect(await change({ email: "riley@x.com", remove: true })).toMatchObject({ ok: true, person: { role: "staff" }, was: { role: "setter" } });
    expect(await change({ email: "sam@x.com", role: "closer", slack: "nobody@slack.x" })).toMatchObject({ ok: false, status: 404, why: expect.stringContaining("no one in the Slack workspace") });
    expect(await change({ email: "sam@x.com", role: "closer" })).toMatchObject({ ok: true, person: { role: "closer" } });
    expect((await asOperator((c) => teamOf(c, co))).map((p) => [p.email, p.role])).toEqual([["sam@x.com", "closer"], ["riley@x.com", "staff"]]);
    expect(await change({ email: "sam@x.com", role: "boss" as "setter" })).toMatchObject({ ok: false, status: 400 });
  });
});
