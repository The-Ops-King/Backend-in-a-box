import Anthropic from "@anthropic-ai/sdk";
import type { BotModel, BotTurn } from "../types";

/**
 * One turn of the Slack bot's tool-use conversation (D70). The system prompt and the tool list never change between
 * questions, so they are the cached prefix; the question and its context ride in the messages. Tools are strict, so a
 * call's input always matches its schema. Server-side fallbacks are on: a safety decline re-runs on the fallback model
 * inside the same call instead of leaving the asker with nothing.
 */
export const BOT_MODEL = "claude-opus-5-5";
const clients = new Map<string, Anthropic>();
const clientFor = (apiKey: string) => { let c = clients.get(apiKey); if (!c) { c = new Anthropic({ apiKey, timeout: 60_000, maxRetries: 2 }); clients.set(apiKey, c); } return c; };

export const anthropicBot: BotModel = {
  async next(apiKey, req): Promise<BotTurn> {
    const tools = req.tools.map((t, i) => ({ ...t, strict: true, ...(i === req.tools.length - 1 ? { cache_control: { type: "ephemeral" as const } } : {}) })) as Anthropic.Beta.BetaTool[];
    const msg = await clientFor(apiKey).beta.messages.create({
      model: BOT_MODEL, max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"], fallbacks: "default",
      output_config: { effort: "medium" },
      system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }],
      tools,
      messages: req.messages as Anthropic.Beta.BetaMessageParam[],
    });
    const text = msg.content.filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text").map((b) => b.text).join("\n").trim();
    const calls = msg.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use").map((b) => ({ id: b.id, name: b.name, input: (b.input ?? {}) as Record<string, unknown> }));
    return { text, calls, stop: msg.stop_reason ?? "end_turn", content: msg.content };
  },
};
