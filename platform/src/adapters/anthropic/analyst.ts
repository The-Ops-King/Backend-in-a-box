import Anthropic from "@anthropic-ai/sdk";
import type { Analyst, AnalysisRequest, AnalysisResult } from "../types";

/**
 * Reads a transcript against a company's prompt. The prompt is the system block and is cached: the same rubric is
 * read against every call, so only the transcript is paid for in full. Streaming because transcripts are long.
 * Server-side fallbacks are on: a safety decline re-runs on the fallback model inside the same call instead of
 * leaving the run with nothing.
 */
export const DEFAULT_MODEL = "claude-opus-5-5";
const clients = new Map<string, Anthropic>();
const clientFor = (apiKey: string) => { let c = clients.get(apiKey); if (!c) { c = new Anthropic({ apiKey }); clients.set(apiKey, c); } return c; };

export const anthropicAnalyst: Analyst = {
  async analyze(apiKey, req): Promise<AnalysisResult> {
    const client = clientFor(apiKey);
    const model = req.model ?? DEFAULT_MODEL;
    const system = req.format === "json" ? `${req.system.trim()}\n\nAnswer with one JSON object and nothing else: no prose before or after it, no code fence.` : req.system;
    const stream = client.beta.messages.stream({
      model, max_tokens: req.maxTokens ?? 16000,
      betas: ["server-side-fallback-2026-07-01"], fallbacks: "default",
      output_config: { effort: "medium" },
      system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: req.input }],
    });
    const msg = await stream.finalMessage();
    const text = msg.content.filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text").map((b) => b.text).join("\n").trim();
    const usage = { input: msg.usage.input_tokens, output: msg.usage.output_tokens, cacheRead: msg.usage.cache_read_input_tokens ?? 0 };
    if (msg.stop_reason === "refusal") return { text, model: msg.model, usage, refused: msg.stop_details?.explanation ?? msg.stop_details?.category ?? "refused" };
    const out: AnalysisResult = { text, model: msg.model, usage };
    if (req.format === "json") Object.assign(out, parseJsonAnswer(text));
    if (msg.stop_reason === "max_tokens" && !out.parseError) out.parseError = `cut off at max_tokens (${usage.output} tokens)`;
    return out;
  },
};

/** Models add fences and preambles even when told not to; a cut-off answer is closed at its last complete value rather than thrown away. */
export function parseJsonAnswer(text: string): Pick<AnalysisResult, "parsed" | "parseError" | "repaired"> {
  const t = extractJson(text);
  try { return { parsed: JSON.parse(t) }; } catch (e) {
    const mended = repairJson(t);
    if (mended) { try { return { parsed: JSON.parse(mended), repaired: true }; } catch { /* fall through */ } }
    return { parseError: String((e as Error).message) };
  }
}
function extractJson(text: string): string {
  const t = text.replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
  if (t.startsWith("{") || t.startsWith("[")) return t;
  const first = t.indexOf("{"), last = t.lastIndexOf("}");
  return first !== -1 && last > first ? t.slice(first, last + 1) : t;
}
/** Rewinds to the last complete value and closes every container still open at that point. A key whose value never arrived is dropped. */
function repairJson(text: string): string | null {
  const stack: string[] = []; let inString = false, escaped = false, cut = -1, cutStack: string[] = [];
  const keyAhead = (from: number) => { for (let j = from; j < text.length; j++) { const c = text[j]; if (" \n\r\t".includes(c)) continue; return c === ":"; } return false; };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) { if (escaped) escaped = false; else if (c === "\\") escaped = true; else if (c === '"') { inString = false; if (stack.length && !keyAhead(i + 1)) { cut = i + 1; cutStack = stack.slice(); } } continue; }
    if (c === '"') { inString = true; continue; }
    if (c === "{" || c === "[") { stack.push(c === "{" ? "}" : "]"); continue; }
    if (c === "}" || c === "]") { stack.pop(); if (stack.length) { cut = i + 1; cutStack = stack.slice(); } continue; }
    if (c === "," && cut < i) { cut = i; cutStack = stack.slice(); }
  }
  if (!stack.length || cut <= 0 || !cutStack.length) return null;
  return text.slice(0, cut).replace(/,\s*$/, "") + cutStack.reverse().join("");
}
