import Anthropic from "@anthropic-ai/sdk";
import { type AiPort, PortError } from "@/engine/ports";
import type { Hub } from "../framework/hub";
import type { Connection } from "../framework/types";

/**
 * Anthropic behind ai.summarize: a document (a transcript, an intake) read against the offer's prompt (content). The
 * model is a setting on the connection (config.model), never written in; with none set the step fails and says so. The
 * prompt is the system block and is cached, so only the document is paid for in full. Server-side fallback is on: a
 * safety decline is re-run on the fallback model inside the same call. A refusal that stands is a permanent failure
 * (the step's failure rule applies); a cut-off JSON answer is closed at its last complete value (v1's repair).
 *
 * The SDK is given the hub's fetch, so tests answer from constructed payloads and nothing leaves the process. Its own
 * retries are off: the shared policy (and the dispatcher's) decides.
 */

const clients = new WeakMap<Hub, Map<string, Anthropic>>();
function clientFor(hub: Hub, apiKey: string): Anthropic {
  let m = clients.get(hub);
  if (!m) { m = new Map(); clients.set(hub, m); }
  let c = m.get(apiKey);
  if (!c) { c = new Anthropic({ apiKey, fetch: hub.http.fetch as never, maxRetries: 0, timeout: 600_000 }); m.set(apiKey, c); }
  return c;
}

function classOf(e: unknown): PortError {
  if (e instanceof PortError) return e;
  if (e instanceof Anthropic.APIConnectionError) return new PortError("transient", `Anthropic did not answer: ${e.message}`);
  if (e instanceof Anthropic.APIError) {
    const s = e.status ?? 0;
    if (s === 401 || s === 403) return new PortError("auth", `Anthropic refused the key (${s})`, s);
    if (s === 429 || s === 529 || s >= 500) return new PortError("transient", `Anthropic ${s}: ${e.message}`, s);
    return new PortError("permanent", `Anthropic ${s}: ${e.message}`, s);
  }
  return new PortError("transient", `Anthropic: ${(e as Error).message ?? String(e)}`);
}

export function anthropicAi(hub: Hub, conn: Connection): Pick<AiPort, "summarize"> {
  return {
    async summarize(_c, p) {
      const key = conn.credentials.api_key;
      if (!key) throw new PortError("auth", "the Anthropic connection has no API key");
      const model = typeof conn.config.model === "string" && conn.config.model ? conn.config.model : undefined;
      if (!model) throw new PortError("permanent", "no model is set on the offer's Anthropic connection (config.model)");
      const system = p.format === "json" ? `${p.prompt.trim()}\n\nAnswer with one JSON object and nothing else: no prose before or after it, no code fence.` : p.prompt;
      let msg: Anthropic.Beta.BetaMessage;
      try {
        msg = await clientFor(hub, key).beta.messages.create({
          model, max_tokens: p.maxTokens ?? 16000,
          betas: ["server-side-fallback-2026-07-01"], fallbacks: "default",
          output_config: { effort: (typeof conn.config.effort === "string" ? conn.config.effort : "medium") as "medium" },
          system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
          messages: [{ role: "user", content: p.input }],
        });
      } catch (e) { throw classOf(e); }
      if (msg.stop_reason === "refusal") throw new PortError("permanent", `the model declined to read it (${msg.stop_details?.category ?? "refused"})`);
      const text = msg.content.filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text").map((b) => b.text).join("\n").trim();
      if (p.format === "text") return text;
      const parsed = parseJsonAnswer(text);
      if (parsed === undefined) throw new PortError("permanent", `the model's answer is not JSON${msg.stop_reason === "max_tokens" ? " (cut off at max_tokens)" : ""}`);
      return parsed;
    },
  };
}

/** Models add fences and preambles; a cut-off answer is closed at its last complete value rather than thrown away. */
export function parseJsonAnswer(text: string): unknown {
  let t = text.replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
  if (!t.startsWith("{") && !t.startsWith("[")) { const a = t.indexOf("{"), b = t.lastIndexOf("}"); if (a !== -1 && b > a) t = t.slice(a, b + 1); }
  try { return JSON.parse(t); } catch { /* repaired below */ }
  const mended = repairJson(t);
  if (mended) { try { return JSON.parse(mended); } catch { /* not JSON */ } }
  return undefined;
}

function repairJson(text: string): string | null {
  const stack: string[] = [];
  let inString = false, escaped = false, cut = -1, cutStack: string[] = [];
  const keyAhead = (from: number) => { for (let j = from; j < text.length; j++) { const c = text[j]!; if (" \n\r\t".includes(c)) continue; return c === ":"; } return false; };
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inString) { if (escaped) escaped = false; else if (c === "\\") escaped = true; else if (c === '"') { inString = false; if (stack.length && !keyAhead(i + 1)) { cut = i + 1; cutStack = stack.slice(); } } continue; }
    if (c === '"') { inString = true; continue; }
    if (c === "{" || c === "[") { stack.push(c === "{" ? "}" : "]"); continue; }
    if (c === "}" || c === "]") { stack.pop(); if (stack.length) { cut = i + 1; cutStack = stack.slice(); } continue; }
    if (c === "," && cut < i) { cut = i; cutStack = stack.slice(); }
  }
  if (!stack.length || cut <= 0 || !cutStack.length) return null;
  return text.slice(0, cut).replace(/,\s*$/, "") + cutStack.reverse().join("");
}
