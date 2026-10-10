import type { Classifier, Classification, ChoiceOptions } from "../types";
import { classOfStatus, VendorError } from "@/engine/failures";

/**
 * Jev (TypeSafe AI, model jev-latest): a state plus typed questions in, probability distributions out. Shape verified
 * live on 2026-10-09 (D47): POST https://api.typesafe.ai/v1/systemone, Bearer key, `questions` keyed by name with
 * `type` choice|noul|score, `instructions`, and for a choice `criteria` (label → what it means); answers come back
 * under `answers.<name>` as `{ choice, confidence, probabilities }` for a choice and `{ noul }` for a noul.
 *
 * Two questions go up for every classification: the choice itself, and "would a careful person be unsure what this
 * means?" (a noul). The answer is only acted on when the choice is confident AND the reply is not ambiguous; otherwise
 * it is `unclear`, which routes to a human (D13). Tyler: "💯 is a yes; 👎 is ambiguous and should require a human."
 * Without a key every call returns `unclear` with confidence 0.
 */
export const JEV_URL = () => process.env.JEV_API_URL ?? "https://api.typesafe.ai/v1/systemone";
const AMBIGUOUS = "A careful person would not be sure what this reply means without asking the person who sent it.";

export async function jevAsk(apiKey: string, body: Record<string, unknown>): Promise<{ ok: boolean; status: number; data?: Record<string, unknown>; error?: string }> {
  const res = await fetch(JEV_URL(), { method: "POST", headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const text = await res.text();
  if (!res.ok) return { ok: false, status: res.status, error: text.slice(0, 200) };
  try { return { ok: true, status: res.status, data: JSON.parse(text) as Record<string, unknown> }; } catch { return { ok: false, status: res.status, error: "not JSON" }; }
}

export const jevClassifier: Classifier = {
  async choice(state, input, options, threshold, opts?: ChoiceOptions): Promise<Classification> {
    const key = opts?.apiKey || process.env.JEV_API_KEY;
    const unclear = (dist: Record<string, number>, confidence = 0, ambiguity?: number): Classification => ({ value: "unclear", confidence, distribution: dist, unclear: true, ...(ambiguity !== undefined ? { ambiguity } : {}) });
    const zeros = Object.fromEntries(options.map((o) => [o, 0]));
    if (!key) return unclear(zeros);
    const criteria = Object.fromEntries(options.map((o) => [o, opts?.criteria?.[o] ?? o.replace(/_/g, " ")]));
    const body = { model: opts?.model ?? "jev-latest", state: [state ? `Context:\n${state}` : "", `Text:\n${input}`].filter(Boolean).join("\n\n"), questions: {
      answer: { type: "choice", instructions: opts?.question ?? "What does the text mean?", criteria },
      ambiguous: { type: "noul", instructions: AMBIGUOUS },
    } };
    const r = await jevAsk(key, body);
    // D66 (F3): a dead key (401/403) or an outage (429/5xx) is the failure policy's, never read as a vague reply; any other refusal stays unclear (a human decides)
    if (!r.ok && (classOfStatus(r.status) === "auth" || classOfStatus(r.status) === "transient")) throw new VendorError("jev", r.status, "/systemone", r.error ?? "");
    if (!r.ok) return unclear(zeros);
    const answers = (r.data?.answers ?? {}) as Record<string, Record<string, unknown>>;
    const a = answers.answer ?? {}; const dist = (a.probabilities ?? {}) as Record<string, number>;
    const choice = typeof a.choice === "string" ? a.choice : "unclear"; const p = typeof a.confidence === "number" ? a.confidence : dist[choice] ?? 0;
    const amb = answers.ambiguous; const ambiguity = amb && typeof amb.noul === "number" ? amb.noul : 0;
    if (!options.includes(choice) || p < threshold || ambiguity >= (opts?.ambiguityMax ?? 0.8)) return unclear(dist, p, ambiguity);
    return { value: choice, confidence: p, distribution: dist, unclear: false, ambiguity };
  },
};

/** Is the key alive? One tiny noul question (D33 health). */
export async function jevPing(apiKey: string): Promise<{ ok: boolean; error?: string }> {
  try { const r = await jevAsk(apiKey, { model: "jev-latest", state: "ping", questions: { ok: { type: "noul", instructions: "The state says ping." } } }); return r.ok ? { ok: true } : { ok: false, error: `${r.status} ${r.error ?? ""}`.trim() }; }
  catch (e) { return { ok: false, error: String((e as Error).message).slice(0, 160) }; }
}
