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
  async react(token, channelId, ts, emoji) {
    const res = await fetch("https://slack.com/api/reactions.add", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ channel: channelId, timestamp: ts, name: emoji.replace(/:/g, "") }) });
    const data = (await res.json()) as { ok: boolean; error?: string };
    return data.ok || data.error === "already_reacted";
  },
  async unreact(token, channelId, ts, emoji) {
    const res = await fetch("https://slack.com/api/reactions.remove", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ channel: channelId, timestamp: ts, name: emoji.replace(/^:|:$/g, "") }) });
    const data = (await res.json()) as { ok: boolean; error?: string };
    return data.ok || data.error === "no_reaction";
  },
  async authTest(token) {
    const res = await fetch("https://slack.com/api/auth.test", { method: "POST", headers: { Authorization: `Bearer ${token}` } });
    const data = (await res.json()) as { ok: boolean; team?: string; user?: string; error?: string };
    return { ok: data.ok, team: data.team, user: data.user, error: data.error };
  },
  async channelInfo(token, channelId) {
    const res = await fetch(`https://slack.com/api/conversations.info?channel=${encodeURIComponent(channelId)}`, { headers: { Authorization: `Bearer ${token}` } });
    const data = (await res.json()) as { ok: boolean; channel?: { name?: string; is_member?: boolean }; error?: string };
    return { ok: data.ok, name: data.channel?.name, member: data.channel?.is_member, error: data.error };
  },
  async lookupUserByEmail(token, email) {
    const res = await fetch(`https://slack.com/api/users.lookupByEmail?email=${encodeURIComponent(email)}`, { headers: { Authorization: `Bearer ${token}` } });
    const data = (await res.json()) as { ok: boolean; user?: { id: string }; error?: string };
    if (!data.ok) { if (data.error === "users_not_found") return null; throw new Error(`slack: ${data.error}`); }
    return data.user?.id ?? null;
  },
};
