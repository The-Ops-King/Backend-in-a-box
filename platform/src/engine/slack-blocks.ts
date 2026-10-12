import type { SlackBlock } from "@/adapters/types";

/** Slack refuses a section whose text is over 3,000 characters, so a long post (the drift questions) is cut into several at line ends. */
const SECTION_MAX = 3000;
export function sectionBlocks(text: string): SlackBlock[] {
  const out: SlackBlock[] = []; let cur = "";
  const push = () => { if (cur.trim()) out.push({ type: "section", text: { type: "mrkdwn", text: cur } }); cur = ""; };
  for (const line of text.split("\n")) {
    for (let piece = line; ; ) {
      const room = SECTION_MAX - (cur ? cur.length + 1 : 0);
      if (piece.length <= room) { cur = cur ? `${cur}\n${piece}` : piece; break; }
      if (cur) { push(); continue; }
      cur = piece.slice(0, SECTION_MAX); push(); piece = piece.slice(SECTION_MAX); if (!piece) break;
    }
  }
  push();
  return out;
}

export type RenderedButton = { text: string; action: string; value: string; style?: "primary" | "danger" };
/** D93: the post's own words as sections, then one row of buttons. */
export const withButtons = (text: string, buttons: RenderedButton[]): SlackBlock[] => [
  ...sectionBlocks(text),
  { type: "actions", block_id: "engine_actions", elements: buttons.map((b) => ({ type: "button", action_id: b.action, text: { type: "plain_text", text: b.text, emoji: true }, value: b.value, ...(b.style ? { style: b.style } : {}) })) },
];

/** D93: the message once a press settled it: the same words, the buttons gone, one line saying what happened and who did it. */
export function settledMessage(message: { text?: string; blocks?: SlackBlock[] }, line: string): { text: string; blocks: SlackBlock[] } {
  const kept = (message.blocks ?? []).filter((b) => b.type !== "actions");
  const base = kept.length ? kept : sectionBlocks(message.text ?? "");
  return { text: `${message.text ?? ""}\n${line}`.trim(), blocks: [...base, { type: "context", elements: [{ type: "mrkdwn", text: line }] }] };
}
