/** D200: hand-linking an unlinked payment or recording from its Slack post: the press opens a form, the submit is checked, then linked. */
import { describe, it, expect, beforeAll } from "vitest";
import { asOperator, one } from "@/db/client";
import { migrate } from "@/db/migrate";
import { installCompany } from "@/engine/install";
import { encrypt } from "@/engine/crypto";
import { fakeAdapters } from "@/engine/test-install";
import { parseSlackInteraction } from "./slack-actions";
import { checkSubmit, findContact, linkForm, linkSubmitted, parseMeta } from "./slack-link";
import type { Adapters } from "@/adapters/types";

process.env.BINDINGS_KEY ??= Buffer.alloc(32, 7).toString("base64");
const posts: { channel: string; text: string; thread?: string }[] = [], reacts: string[] = [];
const base = fakeAdapters();
const fake: Adapters = { ...base, notifier: { ...base.notifier, post: async (_t, channel, text, _as, thread) => { posts.push({ channel, text, thread }); return { ts: "9.1" }; }, react: async (_t, _c, ts, emoji) => { reacts.push(`${ts}:${emoji}`); return true; } } };
let companyId = "", rae = "", paymentId = "";

describe("slack form parsing", () => {
  it("a form sent back is a submit with what was typed; the form carries what to link", () => {
    const view = linkForm({ kind: "payment", id: "p1", channel: "C1", ts: "1.2" });
    const payload = { type: "view_submission", user: { id: "U1" }, team: { id: "T1" }, view: { callback_id: view.callback_id, private_metadata: view.private_metadata, state: { values: { who: { who: { type: "plain_text_input", value: "rae@example.com" } } } } } };
    const p = parseSlackInteraction(new URLSearchParams({ payload: JSON.stringify(payload) }).toString());
    expect(p).toMatchObject({ kind: "submit", user: "U1", teamId: "T1", callbackId: "link_contact", values: { who: "rae@example.com" } });
    expect(parseMeta(view.private_metadata)).toEqual({ kind: "payment", id: "p1", channel: "C1", ts: "1.2" });
    expect(parseMeta("{}")).toBeNull();
  });
});

describe.skipIf(!process.env.DATABASE_URL)("D200: linking from Slack", () => {
  beforeAll(async () => {
    await migrate();
    companyId = (await installCompany({ name: "Link Co", slug: `slack-link-${Date.now()}`, timezone: "America/Phoenix", locationId: "LOC", pit: "pit-fake", calendars: {}, templates: [] }, fake)).companyId;
    await asOperator(async (c) => {
      await c.query("insert into slack_connections (company_id, team_id, bot_token, channels) values ($1,'T1',$2,'{}')", [companyId, encrypt("xoxb-fake")]);
      await c.query("insert into users (company_id, email, name, role, slack_user_id) values ($1,'mo@t.co','Mo','manager','U-MO'),($1,'cy@t.co','Cy','closer','U-CY')", [companyId]);
      rae = (await one<{ id: string }>(c, "insert into contacts (company_id, ghl_contact_id, first_name, last_name) values ($1,'GHLRAE0000000000001','Rae','Lee') returning id", [companyId]))!.id;
      await c.query("insert into contact_identifiers (company_id, contact_id, kind, value) values ($1,$2,'email','rae@example.com'),($1,$2,'phone','+16025550199')", [companyId, rae]);
      paymentId = (await one<{ id: string }>(c, "insert into payments (company_id, whop_payment_id, amount, status, paid_at, link_status, customer_email) values ($1,'pay_1',500,'succeeded',now(),'unlinked','buyer@other.com') returning id", [companyId]))!.id;
    });
  });

  it("finds the contact by GHL link, email or phone, written any way", async () => {
    for (const typed of ["https://app.gohighlevel.com/v2/location/LOC/contacts/detail/GHLRAE0000000000001", "GHLRAE0000000000001", " Rae@Example.com ", "(602) 555-0199", "602.555.0199"])
      expect(await asOperator((c) => findContact(c, companyId, typed)), typed).toEqual({ id: rae, name: "Rae Lee" });
    expect(await asOperator((c) => findContact(c, companyId, "nobody@example.com"))).toBeNull();
  });

  it("the submit is refused for a closer and for someone unknown, and says why inside the form", async () => {
    const meta = { kind: "payment" as const, id: paymentId, channel: "C1", ts: "1.2" };
    expect(await asOperator((c) => checkSubmit(c, companyId, "U-CY", meta, "rae@example.com"))).toEqual({ error: "Only a manager can link." });
    expect(await asOperator((c) => checkSubmit(c, companyId, "U-MO", meta, "nobody@example.com"))).toMatchObject({ error: expect.stringContaining("No one in the CRM") });
    expect(await asOperator((c) => checkSubmit(c, companyId, "U-MO", meta, "rae@example.com"))).toEqual({ contact: { id: rae, name: "Rae Lee" } });
  });

  it("a manager's submit links the payment, says so in the post's thread with a ✅; a second try is told it is already linked", async () => {
    const meta = { kind: "payment" as const, id: paymentId, channel: "C1", ts: "1.2" };
    expect(await linkSubmitted(fake, companyId, "U-MO", meta, { id: rae, name: "Rae Lee" })).toEqual({ ok: true });
    expect(await asOperator((c) => one(c, "select link_status, contact_id from payments where id=$1", [paymentId]))).toEqual({ link_status: "linked", contact_id: rae });
    expect(posts.at(-1)).toEqual({ channel: "C1", text: "✅ Linked to Rae Lee by <@U-MO>.", thread: "1.2" });
    expect(reacts.at(-1)).toBe("1.2:white_check_mark");
    expect(await asOperator((c) => checkSubmit(c, companyId, "U-MO", meta, "rae@example.com"))).toEqual({ error: "That payment is already linked." });
  });
});
