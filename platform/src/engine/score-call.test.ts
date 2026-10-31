/** D272: a setter call scored as PMU's Zap scored it, from the offer's own rubric. */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { parseRubric, revenueScore, tally, jevQuestions, fitBlock, scoreCall, toPlain, type Rubric } from "./score-call";
import type { Analyst, Classifier } from "@/adapters/types";

const RAW = fs.readFileSync(path.resolve(__dirname, "../../installs/pmu/settings/setter-call-rubric.json"), "utf8");
const PMU = (parseRubric(RAW) as { ok: true; rubric: Rubric }).rubric;
const FORM = { biggest_struggle: "Not enough clients in the slow months", average_monthly_revenue: "5-10k" };
const noul = (p: number) => ({ noul: p });
const score = (lvl: number, confidence = 0.9) => ({ probabilities: { 0: lvl === 0 ? 0.8 : 0.1, 1: lvl === 1 ? 0.8 : 0.1, 2: lvl === 2 ? 0.8 : 0.1 }, confidence });
/** Jev's answers for a call: each call category discussed (or not) at a level. */
const answers = (cats: Record<string, number | null>, extra: Record<string, Record<string, unknown>> = {}) => ({
  ...Object.fromEntries(Object.entries(cats).flatMap(([k, lvl]) => [[`${k}__discussed`, noul(lvl === null ? 0.1 : 0.9)], [`${k}__score`, score(lvl ?? 1)]])), ...extra });

describe("D272: the setter call rubric", () => {
  it("PMU's rubric parses: 8 categories, two gates, the Hot / Warm / Nurture tiers; a broken rubric says what is wrong", () => {
    expect(PMU.categories.map((c) => c.key)).toEqual(["biz_fit", "monthly_rev", "problem_goals", "timeline", "investment", "ad_spend", "decision", "engagement"]);
    expect(PMU.categories.filter((c) => c.gate).map((c) => c.key)).toEqual(["ad_spend", "decision"]);
    expect(parseRubric("")).toMatchObject({ ok: false, why: expect.stringContaining("no rubric") });
    expect(parseRubric("{nope")).toMatchObject({ ok: false });
    expect(parseRubric(JSON.stringify({ tiers: [{ min: 0, label: "x" }], categories: [{ key: "a", label: "A", source: "call", levels: ["0", "1"] }] }))).toMatchObject({ ok: false, why: expect.stringContaining("3 levels") });
  });

  it("the form's revenue is read by its lower bound against the cutoffs; unreadable is N/A", () => {
    expect([revenueScore("0-4k", [4000, 8000]), revenueScore("5-10k", [4000, 8000]), revenueScore("11-20k", [4000, 8000]), revenueScore("21k+", [4000, 8000]), revenueScore("$4,000 - $8,000", [4000, 8000])]).toEqual([0, 1, 2, 2, 1]);
    expect(revenueScore("not sure", [4000, 8000])).toBeNull();
  });

  it("Jev is asked two questions per call category, the form's struggle when there is one, the disqualifiers and the Academy tag", () => {
    const q = jevQuestions(PMU, FORM);
    expect(Object.keys(q)).toEqual(expect.arrayContaining(["biz_fit__discussed", "biz_fit__score", "decision__score", "problem_goals__form", "dq_no_revenue", "dq_magic_button", "tag_academy"]));
    expect(q).not.toHaveProperty("engagement__score");
    expect(jevQuestions(PMU, { biggest_struggle: "", average_monthly_revenue: "" })).not.toHaveProperty("problem_goals__form");
  });

  it("a strong call: everything discussed, the form fills nothing the call covered, engagement from the form, 15 of 16 → 9.4 Hot", () => {
    const t = tally(PMU, answers({ biz_fit: 2, monthly_rev: 2, problem_goals: 2, timeline: 2, investment: 1, ad_spend: 2, decision: 2 }, { tag_academy: noul(0.9) }), FORM);
    expect(t.scores.monthly_rev).toMatchObject({ score: 2, source: "call" });   // the call wins over the form's 5-10k
    expect(t.scores.engagement).toMatchObject({ score: 2, source: "crm" });
    expect(t).toMatchObject({ fit: 9.4, scored: 8, evidenced: 8, dq: [], tags: ["Academy / adding artists"], gates_failed: [], gates_unknown: [] });
  });

  it("never discussed is N/A and leaves the denominator; a gate never asked scores 1 and is flagged; the form fills revenue and the problem", () => {
    const t = tally(PMU, answers({ biz_fit: 2, monthly_rev: null, problem_goals: null, timeline: 1, investment: null, ad_spend: null, decision: null }, { problem_goals__form: score(2) }), FORM);
    expect(t.scores.monthly_rev).toMatchObject({ score: 1, source: "form" });
    expect(t.scores.problem_goals).toMatchObject({ score: 2, source: "form" });
    expect(t.scores.investment).toBeUndefined();
    expect(t.scores.ad_spend).toMatchObject({ score: 1, source: "unknown" });
    expect(t.gates_unknown).toEqual(["Ad-Spend Capacity", "Decision & Implementation"]);
    // biz 2 + rev 1 + problem 2 + timeline 1 + ad 1 + decision 1 + engagement 2 = 10 of 14
    expect(t).toMatchObject({ fit: 7.1, scored: 7, evidenced: 5 });
  });

  it("a gate at 0 is a red flag and a DQ; the DQ questions add theirs; too little evidence is no number", () => {
    const t = tally(PMU, answers({ biz_fit: 1, ad_spend: 0, decision: 0 }, { dq_magic_button: noul(0.8) }), {});
    expect(t.dq).toEqual(["Can't fund ad spend", "Not the decision-maker", "Wants a \"just turn on ads\" fix"]);
    expect(t.gates_failed).toEqual(["Ad-Spend Capacity", "Decision & Implementation"]);
    expect(t.fit).toBe(1.7);
    const thin = tally(PMU, answers({ biz_fit: 2, timeline: 2 }), {});
    expect(thin).toMatchObject({ fit: null, evidenced: 2 });
    expect(fitBlock(PMU, thin, {}).slack).toContain("*Fit Quality: Insufficient data to score* (2 of 8 categories came up)");
  });

  it("the block reads as the Zap's: the number and tier, flags above the breakdown, a line per category with Claude's note; plain for the CRM note", () => {
    const t = tally(PMU, answers({ biz_fit: 2, monthly_rev: 2, problem_goals: 2, timeline: 1, investment: 1, ad_spend: null, decision: 2 }, { biz_fit__score: score(2, 0.3) }), FORM);
    const b = fitBlock(PMU, t, { biz_fit: "Runs a PMU studio", timeline: "Wants to start \"after the holidays\"" });
    expect(b.slack.split("\n")).toEqual([
      "*Fit Quality: 8.1/10 · Hot*",
      ":large_yellow_circle: *Needs review:* setter didn't cover Ad-Spend Capacity",
      "",
      "Biz Fit: 2 (low confidence) · Runs a PMU studio",
      "Monthly Rev: 2", "Problem & Goals: 2",
      "Timeline: 1 · Wants to start \"after the holidays\"",
      "Investment Readiness: 1", "Ad-Spend Capacity: 1 (unknown)", "Decision & Implementation: 2", "Behavior/Engagement: 2",
    ]);
    expect(b.plain.split("\n").slice(0, 2)).toEqual(["Fit Quality: 8.1/10 · Hot", "[YELLOW] Needs review: setter didn't cover Ad-Spend Capacity"]);
    expect(toPlain("<https://x|Ana> _quiet_ snake_case *b*")).toBe("Ana quiet snake_case b");
  });

  it("the whole step: Jev answers, Claude writes the summary and the lines; Jev down still posts, saying scoring is unavailable", async () => {
    const asked: Record<string, unknown>[] = [];
    const classifier: Classifier = { choice: async () => ({ value: "", confidence: 0, distribution: {}, unclear: true }), ask: async (_k, state, questions) => { asked.push({ state, questions }); return { answers: answers({ biz_fit: 2, monthly_rev: 2, problem_goals: 2, timeline: 2, investment: 2, ad_spend: 2, decision: 2 }) }; } };
    let system = "", input = "";
    const analyst: Analyst = { analyze: async (_k, req) => { system = req.system; input = req.input; return { text: "", parsed: { summary: "Ana runs a PMU studio doing \"10k\" a month.", notes: { biz_fit: "PMU studio owner" } }, model: "m", usage: { input: 0, output: 0, cacheRead: 0 } }; } };
    const r = await scoreCall({ classifier, analyst, jevKey: "j", anthropicKey: "a" }, { rubric: PMU, prompt: "You write the recap.", transcript: "Speaker 0: hi\nSpeaker 1: I run a PMU studio", form: FORM, about: "Call with Ana, 12 minutes." });
    expect(r).toMatchObject({ ran: true, fit: 10, fit_text: "10", tier: "Hot", summary: "Ana runs a PMU studio doing '10k' a month.", summary_slack: "_\"Ana runs a PMU studio doing '10k' a month.\"_" });
    expect(r.slack).toContain("Biz Fit: 2 · PMU studio owner");
    expect((asked[0].state as Record<string, unknown>).program).toContain("Beauty Moguls");
    expect(system).toContain("You write the recap."); expect(system).toContain("Beauty Moguls runs");
    expect(input).toContain("biz_fit (Biz Fit): 2 of 2, from the call"); expect(input).toContain("- Average monthly revenue, last 90 days: 5-10k");
    const down = await scoreCall({ classifier: { ...classifier, ask: async () => ({ error: "503 down" }) }, analyst, jevKey: "j", anthropicKey: "a" }, { rubric: PMU, prompt: "p", transcript: "t", form: {}, about: "" });
    expect(down).toMatchObject({ ran: false, fit: null, jev_error: "503 down" });
    expect(down.slack).toBe("_Scoring unavailable: 503 down._");
    const noAi = await scoreCall({ classifier, analyst, jevKey: "j" }, { rubric: PMU, prompt: "p", transcript: "t", form: {}, about: "" });
    expect(noAi.slack).toContain("_Summary step failed: no Anthropic key for this offer._");
  });
});
