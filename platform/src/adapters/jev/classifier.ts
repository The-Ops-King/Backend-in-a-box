import type { Classifier, Classification } from "../types";

/**
 * Jev (TypeSafe AI): state + typed question in, probability distribution out.
 * ENDPOINT SHAPE UNVERIFIED — see engine/01-open.md #7. Isolated here so fixing it is one function.
 * Without JEV_API_KEY every call returns `unclear` with confidence 0, which routes to the human path (D13).
 */
export const jevClassifier: Classifier = {
  async choice(state, input, options, threshold): Promise<Classification> {
    const key = process.env.JEV_API_KEY;
    const unclear = (dist: Record<string, number>): Classification => ({ value: "unclear", confidence: 0, distribution: dist, unclear: true });
    if (!key) return unclear(Object.fromEntries(options.map((o) => [o, 0])));
    const res = await fetch(process.env.JEV_API_URL ?? "https://api.typesafe.ai/v1/jev", {
      method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ state: state ?? "", questions: [{ type: "choice", text: input, options }] }),
    });
    if (!res.ok) return unclear(Object.fromEntries(options.map((o) => [o, 0])));
    const data = (await res.json()) as { results?: { distribution?: Record<string, number> }[] };
    const dist = data.results?.[0]?.distribution ?? {};
    const [best, p] = Object.entries(dist).sort((a, b) => b[1] - a[1])[0] ?? ["unclear", 0];
    return p >= threshold ? { value: best, confidence: p, distribution: dist, unclear: false } : { value: "unclear", confidence: p, distribution: dist, unclear: true };
  },
};
