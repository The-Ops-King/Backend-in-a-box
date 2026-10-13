import { api, usePage, useAction, type WorkflowSlack } from "~/api";
import { toast } from "./pieces";

const words = (k: string) => k.replace(/^slack\.channel\./, "").replace(/^alerts\.slack_channel$/, "alerts").replace(/_/g, " ");
const chan = (c: { id: string; name: string | null }) => (c.name ? `#${c.name}` : c.id);

/**
 * In a Slack step's popup on the workflow page: where this step posts today, and a picker of this company's own Slack
 * channels to change it (D106). A thread reply, a DM or an answer in the asking channel says where it goes and has no picker.
 */
export function StepChannel({ workflowId, nodeId }: { workflowId: string; nodeId: string }) {
  const key = ["workflow-slack", workflowId];
  const q = usePage<WorkflowSlack>(key, `/api/v1/workflows/${workflowId}/slack-channel`, { every: 60_000 });
  const pick = useAction<string>((channel) => api(`/api/v1/workflows/${workflowId}/slack-channel`, { method: "POST", json: { node: nodeId, channel } }), [key, ["workflow", workflowId]]);
  if (!q.data) return <p className="m chline">{q.error ? `Channel: ${q.error.message}` : "Reading the channels…"}</p>;
  const d = q.data, s = d.steps.find((x) => x.node_id === nodeId);
  if (!s) return null;
  if (!d.connected) return <p className="m chline">Slack is not connected for this company: the post is recorded, never sent.</p>;
  if (s.kind !== "pick") return <p className="m chline">Posts {s.kind === "thread" ? "in the thread of the earlier post" : s.kind === "dm" ? "as a direct message" : "in the channel the question was asked in"}.</p>;
  const p = s.posts_to;
  const how = !p ? null : p.via === "step" ? "picked on this step" : p.via === "fallback" ? `the ${words(s.binding ?? "")} setting is empty, so its fallback` : `the company's ${words(p.setting ?? "")} setting`;
  const choose = async (channel: string) => {
    const to = channel === "default" ? `the ${words(s.default_binding ?? "")} setting` : chan(d.channels.find((c) => c.id === channel) ?? { id: channel, name: null });
    try { await pick.mutateAsync(channel); toast(`Now posts to ${to}.`); } catch (e) { toast((e as Error).message, true); }
  };
  return <div className="chline">
    <label className="m">Posts to
      {d.channels_readable ? <select className="chpick" disabled={pick.isPending} value={s.on_step ? s.raw : ""} onChange={(e) => choose(e.target.value || "default")}>
        <option value="" disabled={!s.default_binding && !s.binding}>{s.binding ? (p ? `${chan(p)} (company setting)` : "nowhere: pick a channel") : s.default_binding ? `the ${words(s.default_binding)} setting` : "pick a channel"}</option>
        {s.on_step && !d.channels.some((c) => c.id === s.raw) ? <option value={s.raw}>{s.raw} (not in this workspace's list)</option> : null}
        {d.channels.map((c) => <option key={c.id} value={c.id}>#{c.name}{c.is_private ? " (private)" : ""}{c.is_member ? "" : " · bot not in it"}</option>)}
      </select> : <b> {p ? chan(p) : "nowhere"}</b>}
    </label>
    {how ? <p className="m">{how}</p> : !p ? <p className="m" style={{ color: "var(--warn)" }}>No channel: this post is skipped until one is picked.</p> : null}
    {p?.is_member === false ? <p className="m" style={{ color: "var(--warn)" }}>The bot is not in {chan(p)}. Invite it there (/invite) or the post fails.</p> : null}
    {!d.channels_readable ? <p className="m">Slack would not list this workspace's channels (the bot needs channels:read), so there is nothing to pick from.</p> : null}
  </div>;
}
