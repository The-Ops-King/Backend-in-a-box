import { describe, it, expect, vi, afterEach } from "vitest";
import { jevClassifier } from "./classifier";

const reply = (choice: string, confidence: number, ambiguous: number) => ({ ok: true, status: 200, text: async () => JSON.stringify({ model: "jev-1.13.0", answers: { answer: { type: "choice", choice, confidence, probabilities: { [choice]: confidence } }, ambiguous: { type: "noul", noul: ambiguous } } }) });
const OPTS = ["confirmed", "cancelled", "reschedule_request", "unclear"];

describe("Jev classifier (D47)", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("sends the verified systemone shape: the choice with criteria and the ambiguity question", async () => {
    const calls: unknown[] = []; vi.stubGlobal("fetch", vi.fn(async (_u: string, init: RequestInit) => { calls.push(JSON.parse(String(init.body))); return reply("confirmed", 0.99, 0.2); }));
    const r = await jevClassifier.choice("we texted: reply with an emoji", "💯", OPTS, 0.8, { apiKey: "k", criteria: { confirmed: "a yes" }, question: "What does the reply mean?" });
    expect(r).toMatchObject({ value: "confirmed", unclear: false, ambiguity: 0.2 });
    const body = calls[0] as { model: string; state: string; questions: Record<string, { type: string; instructions?: string; criteria?: Record<string, string> }> };
    expect(body.model).toBe("jev-latest"); expect(body.state).toBe("Context:\nwe texted: reply with an emoji\n\nText:\n💯"); expect(body.questions.answer.instructions).toBe("What does the reply mean?");
    expect(body.questions.answer.type).toBe("choice"); expect(body.questions.answer.criteria).toMatchObject({ confirmed: "a yes", reschedule_request: "reschedule request" });
    expect(body.questions.ambiguous.type).toBe("noul");
  });
  it("a confident answer that a careful person would still doubt is unclear (👎 goes to a human)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => reply("cancelled", 0.97, 0.85)));
    expect(await jevClassifier.choice(undefined, "👎", OPTS, 0.8, { apiKey: "k" })).toMatchObject({ value: "unclear", unclear: true, confidence: 0.97, ambiguity: 0.85 });
  });
  it("below the threshold, outside the options, a failed call, or no key: unclear", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => reply("confirmed", 0.6, 0.1)));
    expect((await jevClassifier.choice(undefined, "🙏", OPTS, 0.8, { apiKey: "k" })).unclear).toBe(true);
    vi.stubGlobal("fetch", vi.fn(async () => reply("maybe", 0.99, 0.1)));
    expect((await jevClassifier.choice(undefined, "?", OPTS, 0.8, { apiKey: "k" })).unclear).toBe(true);
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 500, text: async () => "boom" })));
    expect((await jevClassifier.choice(undefined, "yes", OPTS, 0.8, { apiKey: "k" })).unclear).toBe(true);
    const f = vi.fn(); vi.stubGlobal("fetch", f); delete process.env.JEV_API_KEY;
    expect((await jevClassifier.choice(undefined, "yes", OPTS, 0.8, {})).unclear).toBe(true); expect(f).not.toHaveBeenCalled();
  });
});
