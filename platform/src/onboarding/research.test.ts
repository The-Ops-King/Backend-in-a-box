/**
 * D145: research reads what the client has and the AI's guesses pre-fill the answers; one part failing names itself and the
 * rest still counts; Tyler's answers are checked one problem a line and kept across a re-read; done only when every calendar and
 * a closer are settled.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { asOperator, one } from "@/db/client";
import { migrate } from "@/db/migrate";
import { encrypt } from "@/engine/crypto";
import { createClient, onboardingState, saveIntake } from "@/onboarding/store";
import { describe as describeOffer, gather, prefill, researchInput, saveResearch, saveResearchAnswers, type ResearchDeps } from "@/onboarding/research";
import type { Intake } from "@/onboarding/intake";
import type { Proposal } from "@/engine/describe-config";

process.env.BINDINGS_KEY ??= Buffer.alloc(32, 7).toString("base64");
const intake: Intake = { business: "Research Co", price: "5000", deposits: false, payment_plans: false, lead_paths: ["ads_direct_book"], application: "none", setters: true, triage: false, boards: "one",
  journey: "Ads to a booking page; setters call and book the strategy call; Carly closes.", crm: "ghl", booking: "calendly", payments: "whop", recording: "fathom", agreement: "ghl_documents", closers: "carly@r.co", setter_emails: "sam@r.co" };
const CALS = [{ id: "ev-strat", name: "Strategy Call", teamMemberIds: [], active: true }, { id: "ev-setter", name: "Strategy Call (Setter)", teamMemberIds: [], active: true }, { id: "ev-old", name: "Old intro", teamMemberIds: [], active: false }, { id: "ev-demo", name: "Demo", teamMemberIds: [], active: true }];
const USERS = [{ id: "u-carly", name: "Carly", email: "carly@r.co" }, { id: "u-sam", name: "Sam", email: "Sam@r.co" }, { id: "u-owner", name: "Owner", email: "o@r.co" }];
const proposal: Proposal = { summary: "Strategy Call is the closing call.", questions: ["Is Demo a closing call or a follow-up?"], operations: [
  { op: "map_calendar", calendar_id: "ev-strat", call_type: "closing", booking: "self", active: true, why: "the self-booked strategy call" },
  { op: "map_calendar", calendar_id: "ev-setter", call_type: "closing", booking: "setter", active: true, why: "booked by setters" },
  { op: "set_calendar_role", calendar_id: "ev-strat", role: "closer_call", why: "the team works from it" }] };
const asked: string[] = [];
const deps = (over: Partial<ResearchDeps> = {}): ResearchDeps => ({
  catalog: async () => ({ users: USERS, pipelines: [{ id: "p1", name: "Sales", stages: [{ id: "s1", name: "New" }] }], contactFields: [], opportunityFields: [], associations: [], objects: [], tags: [], errors: ["tags: 403"] }),
  workflows: async () => [{ id: "w1", name: "01 -- New Lead", status: "published" }],
  calendars: async (co) => { expect(co.booking).toMatchObject({ source: "calendly", organization: "org-1" }); return CALS; },
  organization: async () => "org-1",
  propose: async (_k, _f, text) => { asked.push(text); return proposal; },
  ...over,
});

describe("research, without the database", () => {
  it("the offer goes to the AI in Tyler's words, then what the answers settle", () => {
    expect(describeOffer(intake)).toBe("Ads to a booking page; setters call and book the strategy call; Carly closes.\nSetters book or qualify calls: yes. A short triage call before the closing call: no. Application form: none. Bookings in calendly.\nClosers: carly@r.co.\nSetters: sam@r.co.");
  });
  it("pre-fills from the AI and the offer's emails; Tyler's earlier answers win", () => {
    const p = prefill(CALS, USERS, intake, proposal.operations);
    expect(p).toEqual({ calendars: { "ev-strat": { call_type: "closing", booking: "self" }, "ev-setter": { call_type: "closing", booking: "setter" }, "ev-old": { call_type: "ignore" } }, closerCall: "ev-strat", bookingCalendar: undefined, team: { "u-carly": "closer", "u-sam": "setter", "u-owner": "staff" } });
    const again = prefill(CALS, USERS, intake, proposal.operations, { calendars: { "ev-strat": { call_type: "follow_up" }, "ev-gone": { call_type: "closing" } }, closerCall: "ev-gone", team: { "u-owner": "owner" } });
    expect(again.calendars["ev-strat"]).toEqual({ call_type: "follow_up" });
    expect(again.calendars["ev-gone"]).toBeUndefined();
    expect(again.closerCall).toBe("ev-strat");
    expect(again.team["u-owner"]).toBe("owner");
  });
});

describe.skipIf(!process.env.DATABASE_URL)("D145: the research step", () => {
  let id: string;
  beforeAll(async () => {
    await migrate();
    await asOperator(async (c) => { const co = await one<{ id: string }>(c, "select id from companies where slug='research-co'"); if (co) { for (const t of ["onboarding", "bindings", "audit_log"]) await c.query(`delete from ${t} where company_id=$1`, [co.id]); await c.query("delete from companies where id=$1", [co.id]); } });
    id = (await asOperator((c) => createClient(c, { name: "Research Co", timezone: "America/New_York" })) as { id: string }).id;
    await asOperator((c) => saveIntake(c, id, { intake }));
  });

  it("is refused until Connections is done", async () => {
    expect(await asOperator((c) => researchInput(c, id))).toMatchObject({ ok: false, status: 409, why: expect.stringMatching(/^finish Connections first/) });
    await asOperator(async (c) => {
      for (const [k, kind, v] of [["crm.location_id", "id", "LOC"], ["secret.ghl_pit", "secret", "pit"], ["secret.calendly_token", "secret", "cal"], ["secret.anthropic_key", "secret", "sk"]] as const)
        await c.query("insert into bindings (company_id, key, kind, value) values ($1,$2,$3,$4)", [id, k, kind, kind === "secret" ? encrypt(v) : Buffer.from(v)]);
      await c.query("update onboarding set steps = steps || '{\"connections\":{\"done_at\":\"2026-10-18T00:00:00Z\",\"by\":\"test\"}}'::jsonb where company_id=$1", [id]);
    });
  });

  it("reads their accounts, names what failed, suggests, and keeps it", async () => {
    const input = await asOperator((c) => researchInput(c, id));
    if (!input.ok) throw new Error(input.why);
    expect(input.input).toMatchObject({ locationId: "LOC", pit: "pit", calendlyToken: "cal", anthropicKey: "sk" });
    const r = await gather(input.input, deps());
    expect(r).toMatchObject({ source: "calendly", errors: ["GHL tags: 403"], workflows: [{ name: "01 -- New Lead" }], proposal: { questions: ["Is Demo a closing call or a follow-up?"], why: { "ev-strat": "the self-booked strategy call" } } });
    await asOperator((c) => saveResearch(c, id, r));
    expect((await asOperator((c) => onboardingState(c, "research-co")))!.research!.answers.closerCall).toBe("ev-strat");
    // the model failing still leaves the reading, said plainly
    const noAi = await gather(input.input, deps({ propose: async () => { throw new Error("overloaded"); } }));
    expect(noAi).toMatchObject({ proposal: null, proposalError: "the AI's suggestions failed (overloaded): every calendar is answered by hand" });
    expect(noAi.calendars).toHaveLength(4);
  });

  it("answers: every problem one line, kept even when refused; done once every calendar and a closer are settled", async () => {
    const s = (await asOperator((c) => onboardingState(c, "research-co")))!;
    const bad = await asOperator((c) => saveResearchAnswers(c, id, { ...s.research!.answers, closerCall: "ev-setter", team: { "u-sam": "setter" }, calendars: { ...s.research!.answers.calendars, "ev-strat": { call_type: "follow_up" } } }));
    expect(bad).toMatchObject({ ok: false, status: 422, problems: ['"Demo": say what it books, or ignore it', "nobody closes: mark at least one closer"] });
    const kept = (await asOperator((c) => onboardingState(c, "research-co")))!;
    expect(kept.research!.answers.calendars["ev-strat"]).toEqual({ call_type: "follow_up" });
    expect(kept.steps.find((x) => x.id === "research")!.done).toBeNull();
    const good = await asOperator((c) => saveResearchAnswers(c, id, { ...s.research!.answers, calendars: { ...s.research!.answers.calendars, "ev-demo": { call_type: "closing", name: "Demo call", booking: "self" } } }, "test"));
    expect(good).toMatchObject({ ok: true });
    expect((await asOperator((c) => onboardingState(c, "research-co")))!.steps.find((x) => x.id === "research")!.done).toMatchObject({ by: "test" });
    expect(await asOperator((c) => saveResearchAnswers(c, id, { ...s.research!.answers, calendars: { ...s.research!.answers.calendars, "ev-demo": { call_type: "closing" } }, closerCall: "ev-old" }))).toMatchObject({ ok: false, problems: ['the closer call ("Old intro") has to be a closing calendar'] });
  });
});
