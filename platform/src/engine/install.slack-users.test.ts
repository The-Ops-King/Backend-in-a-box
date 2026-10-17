/** D129: a team member whose Slack email is not their GHL one is mapped by hand at install, by Slack id or by the email Slack has for them. */
import { describe, it, expect, beforeAll } from "vitest";
import { asOperator, many } from "@/db/client";
import { migrate } from "@/db/migrate";
import { encrypt } from "@/engine/crypto";
import { installCompany, type InstallInput } from "@/engine/install";
import { fakeAdapters } from "@/engine/test-install";
import type { Adapters } from "@/adapters/types";

process.env.BINDINGS_KEY ??= Buffer.alloc(32, 7).toString("base64");
const SLUG = `d129-${Date.now()}`;
const base = fakeAdapters();
const fake: Adapters = { ...base,
  read: { ...base.read, listUsers: async () => [{ id: "G-MITCH", name: "Mitch S", email: "mitch@revsignals.io" }, { id: "G-NELLY", name: "Nelly S", email: "nelly@d129.test" }] },
  notifier: { ...base.notifier, lookupUserByEmail: async (_t, email) => (email === "mitch@salesagency.ai" ? "U065NB5C1EE" : null) } };
const input: InstallInput = { name: "Slack Users", slug: SLUG, timezone: "America/Phoenix", locationId: "LOC-D129", pit: "pit-fake", calendars: {}, templates: [] };
const ids = () => asOperator(async (c) => Object.fromEntries((await many<{ email: string; slack_user_id: string | null }>(c, "select u.email, u.slack_user_id from users u join companies co on co.id=u.company_id where co.slug=$1", [SLUG])).map((u) => [u.email, u.slack_user_id])));

describe.skipIf(!process.env.DATABASE_URL)("D129: Slack users mapped by hand", () => {
  beforeAll(async () => {
    await migrate();
    const co = (await installCompany(input, fake)).companyId;
    await asOperator((c) => c.query("insert into slack_connections (company_id, team_id, bot_token, channels) values ($1,'T1',$2,'{}')", [co, encrypt("xoxb-fake")]));
  });

  it("by the email Slack has (not the GHL one) and by Slack id, keyed by GHL email or GHL user id; a re-install without the key leaves them", async () => {
    await installCompany({ ...input, slackUsers: { "Mitch@RevSignals.io": "mitch@salesagency.ai", "G-NELLY": "W0NELLY12" } }, fake);
    expect(await ids()).toEqual({ "mitch@revsignals.io": "U065NB5C1EE", "nelly@d129.test": "W0NELLY12" });
    await installCompany(input, fake);
    expect((await ids())["mitch@revsignals.io"]).toBe("U065NB5C1EE");
  });

  it("refuses, changing nothing: someone not on the roster, an email Slack does not know, a value that is neither", async () => {
    await expect(installCompany({ ...input, slackUsers: { "ghost@d129.test": "U0GHOST12" } }, fake)).rejects.toThrow('slackUsers: no one on the roster is "ghost@d129.test"');
    await expect(installCompany({ ...input, slackUsers: { "mitch@revsignals.io": "who@nowhere.test" } }, fake)).rejects.toThrow("no one in the Slack workspace has the email who@nowhere.test");
    await expect(installCompany({ ...input, slackUsers: { "mitch@revsignals.io": "mitch" } }, fake)).rejects.toThrow('"mitch" is neither a Slack user id');
    expect((await ids())["mitch@revsignals.io"]).toBe("U065NB5C1EE");
  });
});
