import React from "react";

/**
 * A Slack message, the way Slack draws it: avatar, bot name with the APP tag, a time, then the text with Slack's mrkdwn
 * rendered (*bold*, _italic_, <url|label>, <@U…>, bullets, line breaks). Used for the "what would this post look like"
 * popover on workflow pages. Emoji shortcodes the templates use are mapped; unknown ones show as their name.
 */
const EMOJI: Record<string, string> = {
  tada: "🎉", boom: "💥", partying_face: "🥳", bomb: "💣", mirror_ball: "🪩", man_dancing: "🕺", dancer: "💃", fire: "🔥", rocket: "🚀", champagne: "🍾", "100": "💯",
  moneybag: "💰", money_with_wings: "💸", money_mouth_face: "🤑", dollar: "💵", heavy_dollar_sign: "💲", telephone_receiver: "📞", calendar: "📅", date: "📅", spiral_calendar_pad: "🗓️",
  x: "❌", no_entry_sign: "🚫", memo: "📝", pencil: "✏️", page_with_curl: "📃", fountain_pen: "🖋️", studio_microphone: "🎙️", headphones: "🎧", movie_camera: "🎥", speech_balloon: "💬",
  clipboard: "📋", bar_chart: "📊", mag: "🔍", warning: "⚠️", credit_card: "💳", rotating_light: "🚨", hourglass_flowing_sand: "⏳", stethoscope: "🩺", white_check_mark: "✅", bell: "🔔",
};
export const emoji = (code: string | undefined): string | null => { if (!code) return null; const k = code.replace(/:/g, "").trim(); return EMOJI[k] ?? null; };

/** One line of mrkdwn → React nodes. */
function line(s: string, key: number): React.ReactNode {
  const parts: React.ReactNode[] = [];
  const re = /(<(https?:\/\/[^|>]+)(?:\|([^>]+))?>)|(<@([A-Z0-9]+)>)|(\*([^*\n]+)\*)|(_([^_\n]+)_)|(:([a-z0-9_+-]+):)/g;
  let last = 0, m: RegExpExecArray | null, i = 0;
  while ((m = re.exec(s))) {
    if (m.index > last) parts.push(s.slice(last, m.index));
    if (m[1]) parts.push(<a key={`${key}.${i++}`} className="sl-link" href={m[2]} target="_blank" rel="noreferrer">{m[3] ?? m[2]}</a>);
    else if (m[4]) parts.push(<span key={`${key}.${i++}`} className="sl-mention">@{m[5] === "UALLAN" ? "Allan P" : m[5].startsWith("U") && m[5].length < 12 ? "someone" : m[5]}</span>);
    else if (m[6]) parts.push(<strong key={`${key}.${i++}`}>{m[7]}</strong>);
    else if (m[8]) parts.push(<em key={`${key}.${i++}`}>{m[9]}</em>);
    else if (m[10]) parts.push(emoji(m[11]) ?? m[10]);
    last = m.index + m[0].length;
  }
  if (last < s.length) parts.push(s.slice(last));
  return parts;
}

export function SlackPreview({ name, icon, text, channel, when = "2:00 PM" }: { name?: string; icon?: string | string[]; text: string; channel?: string; when?: string }) {
  const first = Array.isArray(icon) ? icon[0] : icon;
  const av = emoji(first);
  const isUrl = first ? /^https?:\/\//.test(first) : false;
  const body = text.replace(/^@[^\n]*\s—\s/, "").split("\n");
  return <div className="sl">
    {channel ? <div className="sl-ch"># {channel.replace(/^#/, "")}</div> : null}
    <div className="sl-msg">
      <div className="sl-av">{isUrl ? <img src={first} alt="" /> : av ? <span>{av}</span> : <span className="sl-av-x">{(name ?? "B").slice(0, 1).toUpperCase()}</span>}</div>
      <div className="sl-body">
        <div className="sl-hd"><span className="sl-name">{name ?? "App"}</span><span className="sl-app">APP</span><span className="sl-time">{when}</span></div>
        <div className="sl-text">{body.map((l, i) => { const bullet = /^[•\-]\s/.test(l) ? l.replace(/^[•\-]\s/, "") : null; const quote = /^>\s?/.test(l) ? l.replace(/^>\s?/, "") : null;
          return <div key={i} className={quote ? "sl-quote" : bullet ? "sl-bullet" : l.trim() === "" ? "sl-gap" : ""}>{quote ? line(quote, i) : bullet ? <>• {line(bullet, i)}</> : line(l, i)}</div>; })}</div>
      </div>
    </div>
  </div>;
}
