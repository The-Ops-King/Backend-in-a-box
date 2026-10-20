/** D203: /team in Slack: only the operator; a checklist of what is done and what is left; the role given once they are a GHL user. */
import { describe, it, expect, beforeAll } from "vitest";
import { asOperator } from "@/db/client";
import { migrate } from "@/db/migrate";
import { installCompany } from "./install";
import { loadCompany } from "./context";
import { setBinding } from "./settings";
import { parseTeam, teamCommand } from "./team-command";
import { fakeAdapters } from "./test-install";
import type { Adapters } from "@/adapters/types";

process.env.BINDINGS_KEY ??= Buffer.alloc(32, 7).toString("base64");

describe("D203: parseTeam", () => {
  it("reads add, remove, the list and help; refuses the rest with a reason", () => {
    expect(parseTeam("")).toEqual({ kind: "list" });
    expect(parseTeam("add <mailto:Nonie@X.com|Nonie@X.com> Setter")).toEqual({ kind: "add", email: "nonie@x.com", role: "setter" });
    expect(parseTeam("add nonie@x.com closer slack:n@slack.x")).toEqual({ kind: "add", email: "nonie@x.com", role: "closer", slack: "n@slack.x" });
    expect(parseTeam("remove nonie@x.com")).toEqual({ kind: "remove", email: "nonie@x.com" });
    expect(parseTeam("add nonie@x.com")).toMatchObject({ kind: "usage", why: expect.stringContaining("setter or closer") });
    expect(parseTeam("add nonie")).toMatchObject({ kind: "usage", why: expect.stringContaining("email") });
    expect(parseTeam("fire nonie@x.com")).toMatchObject({ kind: "usage" });
  });
});

const SLUG = `d200-${Date.now()}`;
let co = "";
const ghlUsers = [{ id: "U1", name: "Mitch Sapoff", email: "mitch@x.com" }, { id: "U9", name: "Nick One", email: "nick1@x.com" }];
const slackIds: Record<string, string> = { "nonie@x.com": "UNONIE1", "mitch@x.com": "UMITCH1" };
const channels: Record<string, string[] | null> = { CBOOK1: ["UNONIE1"], CSET1: [], CEOD1: null };
const base = fakeAdapters();
const fake: Adapters = { ...base, read: { ...base.read, listUsers: async () => ghlUsers },
  booking: { ...base.booking, ghl: { ...base.booking.ghl, listCalendars: async () => [{ id: "CAL-T", name: "Strategy Session", teamMemberIds: ["U1"] }, { id: "CAL-C", name: "Consultation", teamMemberIds: [] }] } },
  notifier: { ...base.notifier, lookupUserByEmail: async (_t, e) => slackIds[e] ?? null, channelMembers: async (_t, id) => channels[id] ?? null } };
const run = (text: string, userId = "UTYLER1") => asOperator(async (c) => { const { adapterCompany, bindings } = await loadCompany(c, co); return teamCommand(c, { companyId: co, ac: adapterCompany, adapters: fake, slackToken: "xoxb", bindings, userId, text }); });

describe.skipIf(!process.env.DATABASE_URL)("D203: /team", () => {
  beforeAll(async () => {
    await migrate();
    co = (await installCompany({ name: "Team Cmd", slug: SLUG, timezone: "America/Phoenix", locationId: "LOC-D203", pit: "pit-fake", calendars: {}, templates: [] }, fake)).companyId;
    await asOperator(async (c) => {
      for (const [k, v] of [["bot.escalate_to", "UTYLER1"], ["bot.escalate_name", "Tyler"], ["slack.channel.bookings", "CBOOK1"], ["slack.channel.setter_calls", "CSET1"], ["slack.channel.eod", "CEOD1"]] as const) await setBinding(c, co, k, k.startsWith("bot.") ? "text" : "channel", v, "test");
      const term = (await c.query("select id, category from company_terms where company_id=$1 and domain='appointment_type' and is_default", [co])).rows as { id: string; category: string }[];
      for (const [ext, name, cat, cfg] of [["CAL-T", "Strategy Session", "first_call", {}], ["CAL-C", "Consultation", "closing", { booking: "utm" }]] as const)
        await c.query("insert into calendars (company_id, source, external_id, name, appointment_term, booking_url, config) values ($1,'ghl',$2,$3,$4,$5,$6)", [co, ext, name, term.find((t) => t.category === cat)?.id ?? term[0].id, `https://book.x/${ext}`, JSON.stringify(cfg)]);
    });
  });

  it("is the operator's alone", async () => {
    expect(await run("add nonie@x.com setter", "USOMEONE")).toBe("Only Tyler can change the team.");
  });

  it("someone not yet in GHL: says to invite them there first, and whether Slack has them; gives no role", async () => {
    const out = await run("add nonie@x.com setter");
    expect(out).toContain("❌ Not a GHL user in this location yet: invite nonie@x.com in GHL");
    expect(out).toContain("✅ In Slack");
    expect(out).not.toContain("Made a setter");
  });

  it("once in GHL: the role, Slack linked, each channel checked, no call yet, inbound optional, their setter link; run again nothing changes twice", async () => {
    ghlUsers.push({ id: "U2", name: "Nonie Wallace", email: "nonie@x.com" });
    const out = await run("add nonie@x.com setter");
    expect(out).toContain("*Nonie Wallace* → setter (just found in GHL)");
    expect(out).toContain("✅ Made a setter (was staff)");
    expect(out).toContain(`✅ First name "nonie" is theirs alone`);
    expect(out).toContain("✅ Slack linked");
    expect(out).toContain("✅ In <#CBOOK1>");
    expect(out).toContain("❌ Not in <#CSET1> (setter calls): add them.");
    expect(out).not.toContain("CEOD1");   // a closer's channel, not a setter's
    expect(out).toContain("⏳ No call from them yet: give them a phone number in GHL and turn on call recording");
    expect(out).toContain(`ℹ️ Only if they take inbound calls: add them as a host on "Strategy Session".`);
    expect(out).toContain("Their setter link: https://book.x/CAL-C?utm_medium=setter&utm_content=nonie");
    expect(out).toContain("2 left. Run `/team add nonie@x.com setter` again after each fix.");
    expect(await run("add nonie@x.com setter")).toContain("✅ Already a setter");
  });

  it("a setter whose first name someone else has is told their link can't tell them apart; a closer is checked against the closing calendar", async () => {
    ghlUsers.push({ id: "U3", name: "Nick Two", email: "nick2@x.com" });
    expect(await run("add nick2@x.com setter")).toContain(`❌ Their first name "nick" is shared with Nick One`);
    const closer = await run("add mitch@x.com closer");
    expect(closer).toContain(`❌ Not a host on "Consultation"`);
    expect(closer).toContain("❔ Couldn't check the end of day channel (<#CEOD1>)");
  });

  it("the list, and remove takes the role off and says what is theirs to do", async () => {
    expect(await run("")).toMatch(/\*The team\*[\s\S]*Nonie Wallace \(nonie@x.com\): setter/);
    expect(await run("remove nonie@x.com")).toContain("Nonie Wallace is off the team (was setter)");
    expect(await run("bogus")).toContain('I don\'t know "bogus".');
  });
});
