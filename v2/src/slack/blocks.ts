/**
 * The platform's Block Kit layouts: card, alert, report table and form summary. A workflow names a layout and supplies
 * the words (the offer's content); no workflow carries Slack markup of its own. Every message also carries `text`, the
 * plain fallback Slack shows in notifications.
 */
export type Block = Record<string, unknown>;
export type Button = { actionId: string; label: string; value: string; style?: "primary" | "danger" };
export type Message = { text: string; blocks: Block[] };

/** Slack refuses a section over 3000 characters and a message over 50 blocks. */
const SECTION_MAX = 3000, MAX_BLOCKS = 50;
export const SANDBOX_PREFIX = "🧪 sandbox";

const mrkdwn = (text: string) => ({ type: "mrkdwn", text });
const plain = (text: string) => ({ type: "plain_text", text: text.slice(0, 75) || " ", emoji: true });

/** Words as sections: split on line breaks so a long post stays under Slack's section limit. */
export function sections(text: string): Block[] {
  const out: Block[] = [];
  let cur = "";
  for (const line of text.split("\n")) {
    if (cur && cur.length + line.length + 1 > SECTION_MAX) { out.push({ type: "section", text: mrkdwn(cur) }); cur = ""; }
    cur = cur ? `${cur}\n${line}` : line.slice(0, SECTION_MAX);
  }
  if (cur.trim()) out.push({ type: "section", text: mrkdwn(cur) });
  return out;
}

export const context = (...lines: string[]): Block => ({ type: "context", elements: lines.filter(Boolean).map(mrkdwn) });

export function actions(buttons: Button[], blockId = "actions"): Block {
  return {
    type: "actions", block_id: blockId,
    elements: buttons.slice(0, 5).map((b) => ({ type: "button", action_id: b.actionId, text: plain(b.label), value: b.value, ...(b.style ? { style: b.style } : {}) })),
  };
}

const cap = (blocks: Block[]) => blocks.slice(0, MAX_BLOCKS);

/** A card: the words, then its buttons; in sandbox it says so first, in the words and the fallback text. */
export function card(x: { text: string; buttons?: Button[]; sandbox?: boolean; footer?: string }): Message {
  const text = x.sandbox ? `${SANDBOX_PREFIX} · ${x.text}` : x.text;
  const blocks = [...(x.sandbox ? [context(`*${SANDBOX_PREFIX}*: a test post; the live workflow posts in its own channel`)] : []), ...sections(x.text)];
  if (x.buttons?.length) blocks.push(actions(x.buttons));
  if (x.footer) blocks.push(context(x.footer));
  return { text, blocks: cap(blocks) };
}

/** An alert: its mark and headline, what happened, and its buttons. */
export function alertLayout(x: { level: "error" | "warning"; title: string; text: string; buttons?: Button[]; footer?: string }): Message {
  const mark = x.level === "error" ? "🔴" : "🟡";
  const blocks: Block[] = [{ type: "section", text: mrkdwn(`${mark} *${x.title}*`) }, ...sections(x.text)];
  if (x.buttons?.length) blocks.push(actions(x.buttons, "alert"));
  if (x.footer) blocks.push(context(x.footer));
  return { text: `${mark} ${x.title}: ${x.text}`.slice(0, 3000), blocks: cap(blocks) };
}

/** A report table: a title, a monospace table that fits a phone, and how the numbers were worked out. */
export function reportTable(x: { title: string; table: string; lines?: string[]; working: string[] }): Message {
  const blocks: Block[] = [{ type: "section", text: mrkdwn(`*${x.title}*`) }, ...sections(x.table), ...(x.lines?.length ? sections(x.lines.join("\n")) : [])];
  if (x.working.length) blocks.push(context(...x.working.slice(0, 10)));
  return { text: `${x.title}\n${x.table}`, blocks: cap(blocks) };
}

/** A form summary: what a form or a request said, field by field. */
export function formSummary(x: { title: string; fields: [string, string][]; buttons?: Button[] }): Message {
  const blocks: Block[] = [{ type: "section", text: mrkdwn(`*${x.title}*`) }];
  for (let i = 0; i < x.fields.length; i += 10) blocks.push({ type: "section", fields: x.fields.slice(i, i + 10).map(([k, v]) => mrkdwn(`*${k}*\n${v || "—"}`)) });
  if (x.buttons?.length) blocks.push(actions(x.buttons, "form"));
  return { text: `${x.title}: ${x.fields.map(([k, v]) => `${k}: ${v}`).join(", ")}`.slice(0, 3000), blocks: cap(blocks) };
}

/**
 * A message after a press: the same words, its buttons removed (so nothing can be pressed twice), and a line saying who
 * pressed what and when.
 */
export function settled(original: { text?: string; blocks?: Block[] }, line: string): Message {
  const kept = (original.blocks ?? sections(original.text ?? "")).filter((b) => b.type !== "actions");
  return { text: original.text ?? line, blocks: cap([...kept, context(line)]) };
}

/** "3:04 PM" on the offer's clock, as a person reads it beside a press. */
export function clockTime(at: Date, zone: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: zone, hour: "numeric", minute: "2-digit", month: "short", day: "numeric" }).format(at);
}
