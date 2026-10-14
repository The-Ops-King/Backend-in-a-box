/** Slack :shortcodes: as the emoji Slack shows (D43), for the chart's words and the Slack previews alike. */
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
