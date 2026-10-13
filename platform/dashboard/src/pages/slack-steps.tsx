import { Link } from "react-router-dom";
import { api, usePage, useAction, type SlackPage } from "~/api";
import { Empty, Fold, Ic, Skeleton, Tag, toast } from "~/ui/pieces";

type Step = SlackPage["workflows"][number]["steps"][number];
const words = (k: string) => k.replace(/^slack\.channel\./, "").replace(/^alerts\.slack_channel$/, "alerts").replace(/_/g, " ");
const chan = (c: { id: string; name: string | null }) => (c.name ? `#${c.name}` : c.id);

/**
 * Where every Slack message of this company posts, workflow by workflow, and the one thing Setup lets you change: the
 * channel of each post, picked from this company's own Slack workspace. Thread replies, DMs and answers in the asking
 * channel go where the run takes them and are listed so nothing is hidden.
 */
export function SlackSteps({ slug }: { slug: string }) {
  const key = ["slack", slug];
  const q = usePage<SlackPage>(key, `/api/v1/companies/${slug}/slack`, { every: 60_000 });
  const pick = useAction<{ workflow: string; node: string; channel: string }>((v) => api(`/api/v1/workflows/${v.workflow}/slack-channel`, { method: "POST", json: { node: v.node, channel: v.channel } }), [key, ["setup", slug]]);
  if (!q.data) return q.error ? <p className="note">{q.error.message}</p> : <Skeleton lines={4} />;
  const d = q.data;
  if (!d.connected) return <Empty>Slack is not connected: every post is recorded but never sent.</Empty>;
  const choose = async (wf: { id: string; name: string }, s: Step, channel: string) => {
    const to = channel === "default" ? `the ${words(s.default_binding ?? "")} setting` : chan(d.channels.find((c) => c.id === channel) ?? { id: channel, name: null });
    try { await pick.mutateAsync({ workflow: wf.id, node: s.node_id, channel }); toast(`${wf.name}: ${s.title} now posts to ${to}.`); } catch (e) { toast((e as Error).message, true); }
  };
  return <>
    {!d.channels_readable ? <p className="note">Slack would not list this workspace's channels (the bot needs channels:read), so channels show as ids and cannot be picked.</p> : null}
    {d.workflows.length === 0 ? <Empty>No installed workflow posts to Slack.</Empty> : d.workflows.map((wf) => <Fold key={wf.id} open={wf.enabled} title={<>{wf.name} <small>· {wf.steps.length} post{wf.steps.length === 1 ? "" : "s"}{wf.enabled ? "" : " · off"}</small></>}>
      <div className="rows">{wf.steps.map((s) => <StepRow key={s.node_id} s={s} channels={d.channels} readable={d.channels_readable} busy={pick.isPending} onPick={(ch) => choose(wf, s, ch)} />)}</div>
      <p className="note" style={{ marginTop: 6 }}><Link to={`/app/c/${slug}/w/${wf.id}`}>Open the workflow</Link></p>
    </Fold>)}
  </>;
}

function StepRow({ s, channels, readable, busy, onPick }: { s: Step; channels: SlackPage["channels"]; readable: boolean; busy: boolean; onPick: (channel: string) => void }) {
  const p = s.posts_to;
  const where = s.kind === "thread" ? "in the thread of the earlier post" : s.kind === "dm" ? "a direct message" : s.kind === "dynamic" ? "the channel it was asked in" : p ? chan(p) : "nowhere: no channel set, the post is skipped";
  const how = s.kind !== "pick" ? null : !p ? (s.binding ? `the ${words(s.binding)} setting is empty` : null) : p.via === "step" ? "set on this step" : p.via === "fallback" ? `${words(s.binding ?? "")} setting is empty, so its fallback (${words(p.setting ?? "")})` : `the company's ${words(p.setting ?? "")} setting`;
  const state = s.kind !== "pick" ? "skip" : !p ? "warn" : p.is_member === false ? "warn" : "ok";
  const value = s.on_step ? s.raw : "";
  return <div className="row ctl">
    <Ic state={state} />
    <span className="mid"><span className="nm" style={{ whiteSpace: "normal" }}>{s.title}</span>
      <span className="sub"><span>posts to <b>{where}</b></span>{how ? <span>· {how}</span> : null}{p?.is_member === false ? <span style={{ color: "var(--warn)" }}>· the bot is not in {chan(p)}: invite it there or the post fails</span> : null}</span></span>
    {s.kind === "pick" && readable ? <select className="chpick" aria-label={`Channel for ${s.title}`} disabled={busy} value={value} onChange={(e) => onPick(e.target.value || "default")}>
      <option value="" disabled={!s.default_binding && !s.binding}>{s.binding ? `${words(s.binding)} setting${p && p.via !== "step" ? ` (${chan(p)})` : ""}` : s.default_binding ? `back to the ${words(s.default_binding)} setting` : "pick a channel"}</option>
      {s.on_step && !channels.some((c) => c.id === s.raw) ? <option value={s.raw}>{s.raw} (not in this workspace's list)</option> : null}
      {channels.map((c) => <option key={c.id} value={c.id}>#{c.name}{c.is_private ? " (private)" : ""}{c.is_member ? "" : " · bot not in it"}</option>)}
    </select> : <span className="d">{s.kind === "pick" ? <Tag>ids only</Tag> : null}</span>}
  </div>;
}
