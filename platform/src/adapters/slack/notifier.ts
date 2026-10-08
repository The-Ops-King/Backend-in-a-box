import type { Notifier } from "../types";
/** One icon out of a list, so a kind of post has a few faces (D31): the team sees a money bag one time and money eyes the next. */
export const pickIcon = (icon: string | string[] | undefined): string | undefined => {
  const list = (Array.isArray(icon) ? icon : [icon ?? ""]).map((s) => s.trim()).filter(Boolean);
  return list.length ? list[Math.floor(Math.random() * list.length)] : undefined;
};
export const slackNotifier: Notifier = {
  async post(token, channelId, text, as, threadTs) {
    const icon = pickIcon(as?.icon);
    const persona = { ...(as?.name?.trim() ? { username: as.name.trim() } : {}), ...(icon ? (/^https?:\/\//.test(icon) ? { icon_url: icon } : { icon_emoji: icon.startsWith(":") ? icon : `:${icon}:` }) : {}) };
    const res = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ channel: channelId, text, unfurl_links: false, unfurl_media: false, ...persona, ...(threadTs ? { thread_ts: threadTs } : {}) }),
    });
    const data = (await res.json()) as { ok: boolean; ts?: string; error?: string };
    if (!data.ok) throw new Error(`slack: ${data.error}`);
    return { ts: data.ts! };
  },
  async lookupUserByEmail(token, email) {
    const res = await fetch(`https://slack.com/api/users.lookupByEmail?email=${encodeURIComponent(email)}`, { headers: { Authorization: `Bearer ${token}` } });
    const data = (await res.json()) as { ok: boolean; user?: { id: string }; error?: string };
    if (!data.ok) { if (data.error === "users_not_found") return null; throw new Error(`slack: ${data.error}`); }
    return data.user?.id ?? null;
  },
};
