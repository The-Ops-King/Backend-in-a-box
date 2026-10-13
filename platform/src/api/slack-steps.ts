import type { PoolClient } from "pg";
import { many, one } from "@/db/client";
import { loadCompany } from "@/engine/context";
import { parseDefinition, fallbacksOf, type Definition, type Node } from "@/engine/definition";
import { describeNode } from "@/engine/describe";
import { decrypt } from "@/engine/crypto";
import { saveStepEdit } from "@/engine/edits";
import { listSlackChannels, type SlackChannel } from "./setup-data";

/**
 * Where each Slack message posts, per workflow, and the one setting the dashboard writes: a step's channel, picked from this
 * company's own Slack workspace (Tyler: "ONLY the slack channel should be selectable right now"). A pick is a literal channel id
 * on that step of the company's copy (saveStepEdit: a new version, diverged), so two workflows that share the reports channel
 * can post in different places. "Back to the company setting" puts the template's binding back on the step.
 */

/** How a step finds its channel: a channel the operator can pick, or one the run decides (a thread reply, a DM, the channel asked in). */
export type StepChannelKind = "pick" | "thread" | "dm" | "dynamic";
export type ChannelRef = { id: string; name: string | null; is_member: boolean | null };
export type SlackStepRow = {
  node_id: string; title: string; kind: StepChannelKind;
  /** the step's channel as written: a binding ({{slack.channel.reports}}) or a literal channel id */
  raw: string;
  /** set on the step itself (a literal id) rather than through a company setting */
  on_step: boolean;
  /** the company setting the step reads ("slack.channel.reports"), or that the template had, to go back to */
  binding: string | null; default_binding: string | null;
  /** where it posts today: the first of the channel and its fallbacks that resolves; null = nowhere (skipped) */
  posts_to: (ChannelRef & { via: "step" | "setting" | "fallback"; setting: string | null }) | null;
  fallbacks: string[];
};
export type SlackWorkflow = { id: string; name: string; enabled: boolean; steps: SlackStepRow[] };

const REF = /^\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}$/;
const refOf = (v: string): string | null => REF.exec(v)?.[1] ?? null;
const isSetting = (path: string) => path.startsWith("slack.channel.") || path === "alerts.slack_channel";

/** The Slack steps of one definition, in the order they appear, with where each one posts today. Pure: the tests drive it. */
export function slackStepsOf(def: Definition, template: Definition | null, bindings: Record<string, string>, channels: SlackChannel[] | null): SlackStepRow[] {
  const ref = (id: string): ChannelRef => { const ch = channels?.find((x) => x.id === id); return { id, name: ch?.name ?? null, is_member: ch ? ch.is_member : null }; };
  const out: SlackStepRow[] = [];
  for (const n of def.nodes) {
    if (n.type !== "slack_post") continue;
    const path = refOf(n.channel);
    const kind: StepChannelKind = n.thread_of ? "thread" : path === null ? "pick" : isSetting(path) ? "pick" : /slack_user_id$|operator_slack_id$/.test(path) ? "dm" : "dynamic";
    const tplNode = template?.nodes.find((x) => x.id === n.id) as (Node & { channel?: string }) | undefined;
    const tplPath = tplNode?.type === "slack_post" && tplNode.channel ? refOf(tplNode.channel) : null;
    const fallbacks = fallbacksOf(n.fallback_channel);
    let posts_to: SlackStepRow["posts_to"] = null;
    if (kind === "pick") {
      const tries = [n.channel, ...fallbacks];
      for (let i = 0; i < tries.length && !posts_to; i++) {
        const p = refOf(tries[i]);
        const id = p === null ? tries[i] : bindings[p];
        if (id) posts_to = { ...ref(id), via: i > 0 ? "fallback" : p === null ? "step" : "setting", setting: p };
      }
    }
    out.push({ node_id: n.id, title: n.title ?? describeNode(n).title, kind, raw: n.channel, on_step: path === null, binding: path !== null && isSetting(path) ? path : null,
      default_binding: tplPath && isSetting(tplPath) ? tplPath : null, posts_to, fallbacks: fallbacks.map((f) => refOf(f) ?? f) });
  }
  return out;
}

async function companyChannels(c: PoolClient, companyId: string): Promise<{ connected: boolean; channels: SlackChannel[] | null }> {
  const tok = await one<{ bot_token: Buffer }>(c, "select bot_token from slack_connections where company_id=$1", [companyId]);
  if (!tok) return { connected: false, channels: null };
  return { connected: true, channels: await listSlackChannels(decrypt(tok.bot_token)) };
}

/** Every workflow of the company that posts to Slack, with each Slack step and the company's own channels to pick from. */
export async function slackPage(c: PoolClient, companyId: string) {
  const { bindings } = await loadCompany(c, companyId);
  const safe = Object.fromEntries(Object.entries(bindings).filter(([k]) => !k.startsWith("secret.")));
  const { connected, channels } = await companyChannels(c, companyId);
  const rows = await many<{ id: string; name: string; enabled: boolean; definition: unknown; template: unknown }>(c, `select w.id, w.name, w.enabled, v.definition, t.definition as template
    from workflows w join workflow_versions v on v.workflow_id=w.id and v.version=w.current_version left join workflow_templates t on t.id=w.template_id
    where w.company_id=$1 order by w.enabled desc, w.name`, [companyId]);
  const workflows: SlackWorkflow[] = [];
  for (const r of rows) {
    let def: Definition; try { def = parseDefinition(r.definition); } catch { continue; }   // unparseable: the workflow page and health say so
    let tpl: Definition | null = null; try { tpl = r.template ? parseDefinition(r.template) : null; } catch { tpl = null; }
    const steps = slackStepsOf(def, tpl, safe, channels);
    if (steps.length) workflows.push({ id: r.id, name: r.name, enabled: r.enabled, steps });
  }
  return { connected, channels_readable: channels !== null, channels: channels ?? [], workflows };
}
export type SlackPage = Awaited<ReturnType<typeof slackPage>>;

/**
 * Point one Slack step at a channel: `channel` is a channel id from this company's workspace, or "default" for the
 * template's company setting. Refused when the channel is not one the company's bot can see, so a pick can never name
 * another company's channel.
 */
export async function setStepChannel(c: PoolClient, args: { workflowId: string; nodeId: string; channel: string; by?: string }): Promise<{ ok: true; version: number; changed: string[] } | { ok: false; status: number; why: string }> {
  const w = await one<{ company_id: string; definition: unknown; template: unknown }>(c, `select w.company_id, v.definition, t.definition as template from workflows w
    join workflow_versions v on v.workflow_id=w.id and v.version=w.current_version left join workflow_templates t on t.id=w.template_id where w.id=$1`, [args.workflowId]);
  if (!w) return { ok: false, status: 404, why: "no such workflow" };
  const def = parseDefinition(w.definition);
  let tpl: Definition | null = null; try { tpl = w.template ? parseDefinition(w.template) : null; } catch { tpl = null; }
  const step = slackStepsOf(def, tpl, {}, null).find((s) => s.node_id === args.nodeId);
  if (!step) return { ok: false, status: 404, why: "no such Slack step on this workflow" };
  if (step.kind !== "pick") return { ok: false, status: 422, why: step.kind === "thread" ? "this step replies in the thread of an earlier post; it goes where that post went" : "this step's channel is decided by the run (a DM or the channel a question was asked in)" };
  let value: string;
  if (args.channel === "default") {
    if (!step.default_binding) return { ok: false, status: 422, why: "this step has no company setting to go back to" };
    value = `{{${step.default_binding}}}`;
  } else {
    const { connected, channels } = await companyChannels(c, w.company_id);
    if (!connected) return { ok: false, status: 422, why: "Slack is not connected for this company" };
    if (!channels) return { ok: false, status: 502, why: "Slack did not list this company's channels; check the bot's channels:read scope" };
    if (!channels.some((ch) => ch.id === args.channel)) return { ok: false, status: 422, why: "that channel is not in this company's Slack workspace (or the bot cannot see it)" };
    value = args.channel;
  }
  const r = await saveStepEdit(c, { workflowId: args.workflowId, nodeId: args.nodeId, edit: { type: "slack_post", channel: value }, by: args.by ?? "dashboard" });
  return r.ok ? r : { ok: false, status: 422, why: r.why };
}
