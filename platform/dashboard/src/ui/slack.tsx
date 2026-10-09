import type { ReactNode } from "react";
import type { SlackFace } from "@/api/words";

/**
 * A Slack message as Slack shows it (D43): the bot's face and name, the APP tag, the time, and the text in Slack's own
 * markup (mrkdwn): *bold*, _italic_, ~strike~, `code`, <url|label>, > quotes, • bullets, :emoji: shortcodes.
 */
const EMOJI: Record<string, string> = {
  clipboard: "📋", warning: "⚠️", memo: "📝", hourglass_flowing_sand: "⏳", tada: "🎉", speech_balloon: "💬", rotating_light: "🚨", calendar: "📅", boom: "💥", x: "❌",
  telephone_receiver: "📞", stethoscope: "🩺", one: "1️⃣", two: "2️⃣", three: "3️⃣", no_entry_sign: "🚫", headphones: "🎧", grey_question: "❔", bar_chart: "📊", a: "🅰️", b: "🅱️",
  studio_microphone: "🎙️", spiral_calendar_pad: "🗓️", rocket: "🚀", pencil: "✏️", partying_face: "🥳", page_with_curl: "📃", movie_camera: "🎥", moneybag: "💰", money_with_wings: "💸",
  money_mouth_face: "🤑", mirror_ball: "🪩", man_dancing: "🕺", dancer: "💃", mag: "🔍", heavy_dollar_sign: "💲", gate: "⛩️", fountain_pen: "🖋️", fire: "🔥", dollar: "💵", date: "📅",
  credit_card: "💳", bomb: "💣", champagne: "🍾", chart_with_upwards_trend: "📈", white_check_mark: "✅", heavy_check_mark: "✔️", eyes: "👀", wave: "👋", bell: "🔔", bust_in_silhouette: "👤",
  link: "🔗", phone: "📱", email: "📧", "e-mail": "📧", envelope: "✉️", hourglass: "⌛", alarm_clock: "⏰", clock1: "🕐", star: "⭐", sparkles: "✨", robot_face: "🤖", test_tube: "🧪", zap: "⚡",
  thumbsup: "👍", "+1": "👍", thumbsdown: "👎", "-1": "👎", point_right: "👉", exclamation: "❗", question: "❓", information_source: "ℹ️", handshake: "🤝", trophy: "🏆", gem: "💎", sunrise: "🌅",
  sunny: "☀️", crescent_moon: "🌙", scissors: "✂️", mailbox: "📬", package: "📦", card_index: "📇", bookmark_tabs: "📑", ballot_box_with_check: "☑️", repeat: "🔁", arrows_counterclockwise: "🔄",
};
export const emoji = (code: string): string | null => { const k = code.replace(/^:|:$/g, "").replace(/::skin-tone-\d$/, ""); return EMOJI[k] ?? null; };

const inline = (text: string, key: string): ReactNode[] => {
  const out: ReactNode[] = []; let i = 0, n = 0;
  const re = /<(https?:\/\/[^|>]+)(?:\|([^>]+))?>|<(?:@|#)([A-Z0-9]+)(?:\|([^>]+))?>|\*([^*\n]+)\*|_([^_\n]+)_|~([^~\n]+)~|`([^`\n]+)`|:([a-z0-9_+-]+(?:::skin-tone-\d)?):/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > i) out.push(text.slice(i, m.index));
    const k = `${key}-${n++}`;
    if (m[1]) out.push(<a key={k} href={m[1]} target="_blank" rel="noreferrer">{m[2] ?? m[1].replace(/^https?:\/\//, "")}</a>);
    else if (m[3]) out.push(<span key={k} className="mention">{m[4] ? `${m[4]}` : `@${m[3]}`}</span>);
    else if (m[5]) out.push(<b key={k}>{inline(m[5], k)}</b>);
    else if (m[6]) out.push(<i key={k}>{inline(m[6], k)}</i>);
    else if (m[7]) out.push(<s key={k}>{m[7]}</s>);
    else if (m[8]) out.push(<code key={k}>{m[8]}</code>);
    else if (m[9]) { const e = emoji(m[9]); out.push(e ? <span key={k} className="em">{e}</span> : <code key={k}>:{m[9]}:</code>); }
    i = m.index + m[0].length;
  }
  if (i < text.length) out.push(text.slice(i));
  return out;
};

/** mrkdwn → blocks: quotes, bullets, paragraphs; a blank line separates paragraphs the way Slack does. */
export function Mrkdwn({ text }: { text: string }) {
  const lines = text.replace(/\r/g, "").split("\n");
  const blocks: ReactNode[] = []; let quote: string[] = []; let para: string[] = []; let b = 0;
  const flushQ = () => { if (quote.length) { blocks.push(<blockquote key={`q${b++}`}>{quote.map((l, i) => <span key={i} className="ln">{inline(l, `q${b}-${i}`)}</span>)}</blockquote>); quote = []; } };
  const flushP = () => { if (para.length) { blocks.push(<p key={`p${b++}`}>{para.map((l, i) => <span key={i} className="ln">{inline(l, `p${b}-${i}`)}</span>)}</p>); para = []; } };
  for (const raw of lines) {
    if (/^>\s?/.test(raw)) { flushP(); quote.push(raw.replace(/^>\s?/, "")); continue; }
    flushQ();
    if (raw.trim() === "") { flushP(); continue; }
    para.push(/^[•\-*]\s+/.test(raw) ? `•  ${raw.replace(/^[•\-*]\s+/, "")}` : raw);
  }
  flushQ(); flushP();
  return <div className="mk">{blocks}</div>;
}

/** The message, framed as Slack frames it. `time` is the clock Slack would show; `thread` draws it as a reply in a thread. */
export function SlackMsg({ face, text, time, thread, shadow, reaction, offers }: { face?: SlackFace; text: string; time?: string; thread?: boolean; shadow?: boolean; reaction?: string | string[]; offers?: string[] }) {
  const icon = face?.icon ?? null; const e = icon && !/^https?:/.test(icon) ? emoji(icon) : null;
  const name = face?.name || "Engine";
  const rxs = (reaction ? (Array.isArray(reaction) ? reaction : [reaction]) : []).map((r) => emoji(r) ?? `:${r}:`);
  return <>{rxs.length ? <div className="slk-rx">{rxs.map((r, i) => <span key={i} className="em">{r}</span>)} reaction on the booking post</div> : null}<div className={`slk ${thread ? "thread" : ""}`}>
    <span className="av" aria-hidden>{icon && /^https?:/.test(icon) ? <img src={icon} alt="" /> : e ?? name.slice(0, 1).toUpperCase()}</span>
    <span className="hd"><b>{name}</b><span className="app">APP</span>{time ? <span className="tm">{time}</span> : null}</span>
    <div className="bd">{shadow ? <span className="shadowtag">🧪 shadow</span> : null}<Mrkdwn text={text} />{offers?.length ? <div className="offers">{offers.map((o) => <span key={o} className="pill">{emoji(o) ?? `:${o}:`} <small>1</small></span>)}<span className="hint">tap one to decide</span></div> : null}</div>
  </div></>;
}
