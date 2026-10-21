import { type AiPort, PortError } from "@/engine/ports";
import { attemptOnce, withPolicy } from "../framework/http";
import type { Hub } from "../framework/hub";
import type { Connection, J } from "../framework/types";

/**
 * Jev (TypeSafe AI) behind ai.classify, as Tyler decided ("Keep Jev"). Shape verified live in v1 (2026-10-09):
 * POST https://api.typesafe.ai/v1/systemone, Bearer key, `questions` keyed by name, `type` choice | noul, `criteria`
 * (label -> what it means); answers under `answers.<name>` as { choice, confidence, probabilities } and { noul }.
 *
 * Two questions go up for every classification: the choice, and "would a careful person be unsure what this means?"
 * The answer is acted on only when the choice is confident (>= threshold) and the text is not ambiguous (< ambiguityMax,
 * 0.8 when the step does not say); otherwise it is the step's `unclear` option, which routes to a person. A dead key
 * (401, 403) pauses the AI connection; an outage (429, 5xx) is tried again; any other refusal is unclear.
 */
export const JEV_URL = "https://api.typesafe.ai/v1/systemone";
const AMBIGUOUS = "A careful person would not be sure what this reply means without asking the person who sent it.";

export function jevAi(hub: Hub, conn: Connection): Pick<AiPort, "classify"> {
  return {
    async classify(_c, p) {
      const key = conn.credentials.api_key;
      if (!key) throw new PortError("auth", "the Jev connection has no API key");
      const criteria = Object.fromEntries(p.options.map((o) => [o, ((conn.config.criteria ?? {}) as Record<string, string>)[o] ?? o.replace(/_/g, " ")]));
      const body = {
        model: typeof conn.config.model === "string" ? conn.config.model : "jev-latest",
        state: [p.context ? `Context:\n${p.context}` : "", `Text:\n${p.input}`].filter(Boolean).join("\n\n"),
        questions: { answer: { type: "choice", instructions: p.prompt || "What does the text mean?", criteria }, ambiguous: { type: "noul", instructions: AMBIGUOUS } },
      };
      const url = typeof conn.config.url === "string" ? conn.config.url : JEV_URL;
      const out = await withPolicy(hub.http, "Jev", () => attemptOnce(hub.http, url, { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify(body) }, 30_000), { write: false });
      const unclear = (confidence = 0, guesses: { value: string; confidence: number }[] = []) => ({ value: p.unclear, confidence, guesses });
      if ("confirmed" in out) return unclear();
      const res = out.res;
      if (res.status === 401 || res.status === 403) throw new PortError("auth", `Jev refused the key (${res.status})`, res.status);
      if (res.status >= 400) return unclear();
      const answers = ((res.body as J).answers ?? {}) as Record<string, J>;
      const a = answers.answer ?? {};
      const dist = (a.probabilities ?? {}) as Record<string, number>;
      const guesses = Object.entries(dist).map(([value, confidence]) => ({ value, confidence: Number(confidence) })).sort((x, y) => y.confidence - x.confidence);
      const choice = typeof a.choice === "string" ? a.choice : "";
      const conf = typeof a.confidence === "number" ? a.confidence : dist[choice] ?? 0;
      const ambiguity = typeof answers.ambiguous?.noul === "number" ? answers.ambiguous.noul : 0;
      if (!p.options.includes(choice) || conf < p.threshold || ambiguity >= (p.ambiguityMax ?? 0.8)) return unclear(conf, guesses);
      return { value: choice, confidence: conf, guesses };
    },
  };
}
