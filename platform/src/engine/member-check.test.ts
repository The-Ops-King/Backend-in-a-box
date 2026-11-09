/** D316: fully in, fully out: one person read across the engine, GHL, Calendly, Slack and Fathom (the vendor reads are fakes here). */
import { describe, it, expect, beforeAll } from "vitest";
import { asOperator, one } from "@/db/client";
import { migrate } from "@/db/migrate";
import { formatMemberCheck, memberCheck, type MemberLookups } from "./member-check";
import { parseTeam } from "./team-command";

let co = "", mel = "", min = "";
const bindings = { "sales_call.closer_options": JSON.stringify({ "mel@x.com": "mel", "min@x.com": "minerva" }), "slack.channel.bookings": "CBOOK", "slack.channel.eod": "CEOD" };
const RR = { id: "RR", name: "Consultation RR", teamMemberIds: [], active: true, pooling: "round_robin", hosts: [{ name: "Jose", email: "jose@x.com" }, { name: "Mel", email: "mel@x.com" }] };
const MELS = { id: "MELS", name: "Strategy", teamMemberIds: [], active: true, hosts: [{ name: "Mel", email: "mel@x.com" }] };
const MINS = { id: "MINA", name: "Assessment", teamMemberIds: [], active: true, hosts: [{ name: "Min", email: "min@x.com" }] };
const lookups = (o: Partial<MemberLookups> = {}): MemberLookups => ({
  ghlUsers: async () => [{ id: "G-MEL", email: "mel@x.com", name: "Mel" }, { id: "G-MIN", email: "min@x.com", name: "Min" }],
  calendars: async () => [RR, MELS, MINS],
  calendlyMember: async (e) => e === "mel@x.com" || e === "min@x.com",
  openTimes: async () => 12,
  slack: { find: async (e) => (e === "mel@x.com" ? "UMEL" : e === "min@x.com" ? "UMIN" : null), active: async () => true, members: async (ch) => (ch === "CEOD" ? ["UMEL", "UMIN"] : ["UMEL"]) },
  fathom: { team: async () => ["jose@x.com"], latest: async (e) => (e === "min@x.com" ? "2026-11-05T17:00:00Z" : null) },
  ...o,
});

describe.skipIf(!process.env.DATABASE_URL)("D316: is someone fully in or fully out", () => {
  beforeAll(async () => {
    await migrate();
    await asOperator(async (c) => {
      co = (await one<{ id: string }>(c, "insert into companies (name, slug, timezone) values ('D316',$1,'America/New_York') returning id", [`d316-${Date.now()}`]))!.id;
      await c.query("insert into company_terms (company_id, domain, name, category, is_default, sort) select $1, domain, label, value, true, sort from core_categories", [co]);
      const closing = (await one<{ id: string }>(c, "select id from company_terms where company_id=$1 and domain='appointment_type' and category='closing'", [co]))!.id;
      mel = (await one<{ id: string }>(c, "insert into users (company_id, email, name, role, ghl_user_id, slack_user_id) values ($1,'mel@x.com','Mel Reynolds','closer','G-MEL','UMEL') returning id", [co]))!.id;
      min = (await one<{ id: string }>(c, "insert into users (company_id, email, name, role, ghl_user_id, slack_user_id) values ($1,'min@x.com','Minerva Rostro','staff','G-MIN','UMIN') returning id", [co]))!.id;
      await c.query("insert into calendars (company_id, source, external_id, name, appointment_term, default_user_id, active) values ($1,'calendly','RR','Consultation RR',$2,null,true),($1,'calendly','MELS','Strategy',$2,$3,true),($1,'calendly','MINA','Assessment',$2,$4,true)", [co, closing, mel, min]);
    });
  }, 180000);

  it("a closer set up everywhere is in; only her first recorded call is still to come", async () => {
    const r = await asOperator((c) => memberCheck(c, { companyId: co, email: "Mel@x.com", bindings, lookups: lookups({ fathom: { team: async () => ["mel@x.com"], latest: async () => null } }) }));
    expect(r).toMatchObject({ expect: "in", role: "closer", left: 0 });
    const text = formatMemberCheck(r);
    expect(text).toContain('Sales Calls name them "mel"');
    expect(text).toContain('Hosts "Consultation RR", "Strategy"');
    expect(text).toContain('Bookable: 12 open times in the next 7 days on "Strategy"');
    expect(text).toContain("⏳ No meeting of theirs reached the engine's Fathom yet");
    expect(text).toContain("Fully in.");
  });

  it("a closer missing from Slack's channels, Fathom's team and a shared calendar says each", async () => {
    const r = await asOperator((c) => memberCheck(c, { companyId: co, email: "mel@x.com", bindings, lookups: lookups({ calendars: async () => [{ ...RR, hosts: [{ name: "Jose", email: "jose@x.com" }, { name: "Ana", email: "ana@x.com" }] }, MELS], slack: { find: async () => "UMEL", active: async () => true, members: async () => [] } }) }));
    const no = r.lines.filter((l) => l.mark === "no").map((l) => l.say);
    expect(no).toEqual(expect.arrayContaining(['Not a host on "Consultation RR", which the other closers share.', "Not in the bookings channel (<#CBOOK>).", "Not in the end of day channel (<#CEOD>).", "Not on the Fathom team the engine reads."]));
  });

  it("someone whose role is off but who is still in GHL, Calendly, Slack and a watched calendar is not out", async () => {
    const r = await asOperator((c) => memberCheck(c, { companyId: co, email: "min@x.com", bindings, lookups: lookups() }));
    expect(r.expect).toBe("out");
    const no = r.lines.filter((l) => l.mark === "no").map((l) => `${l.area}: ${l.say}`);
    expect(no).toEqual(["Engine: Still watches \"Assessment\" as their calendar.", "GHL: Still a user of the location (Min).", "Calendly: A member of the organization.", 'Calendly: Still hosts "Assessment" (watched).', "Slack: Their Slack account is still active.", "Slack: Still in the end of day channel (<#CEOD>)."]);
    expect(formatMemberCheck(r)).toContain("Their latest meeting the engine's Fathom can see: 2026-11-05");
  });

  it("removed everywhere is out; a read that fails says so instead of guessing", async () => {
    await asOperator((c) => c.query("update calendars set active=false where company_id=$1 and external_id='MINA'", [co]));
    const r = await asOperator((c) => memberCheck(c, { companyId: co, email: "min@x.com", bindings, lookups: lookups({
      ghlUsers: async () => [{ id: "G-MEL", email: "mel@x.com" }], calendars: async () => [RR, MELS], calendlyMember: async () => false,
      slack: { find: async () => null, active: async () => false, members: async () => ["UMIN"] }, fathom: { team: async () => { throw new Error("403"); }, latest: async () => null } }) }));
    expect(r.left).toBe(0);
    expect(r.lines.find((l) => l.area === "Fathom")).toEqual({ area: "Fathom", mark: "unknown", say: "Couldn't read the team: 403" });
    expect(formatMemberCheck(r)).toContain("Fully out.");
  });

  it("/team check <email> is understood", () => {
    expect(parseTeam("check Mel@x.com")).toEqual({ kind: "check", email: "mel@x.com" });
    expect(parseTeam("check")).toMatchObject({ kind: "usage" });
  });
});
