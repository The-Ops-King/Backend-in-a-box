import type { Notifier } from "../types";
export const slackNotifier: Notifier = {
  async post(token, channelId, text) {
    const res = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ channel: channelId, text, unfurl_links: false, unfurl_media: false }),
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
