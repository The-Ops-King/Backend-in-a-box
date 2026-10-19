import type { PoolClient } from "pg";
import { asOperator, many, one } from "@/db/client";
import type { Adapters } from "@/adapters/types";
import { decrypt } from "./crypto";

/**
 * D152 (Tyler: "a /issue command for all of them which opens a tech issue, or /request so they can ask for things ... and it
 * tracks for me"): anyone in an offer's Slack types `/issue <one line>` or `/request <one line>`. The engine numbers it for that
 * offer, posts it where it was typed (the thread is where a Loom or a screenshot goes), tells the operator in that Slack, and opens
 * a GitHub issue (GITHUB_TOKEN, GITHUB_REPO) so Claude can pick it up. Closing it answers in the thread and puts a ✅ on the post.
 * Two commands, one ticket system: the command says which kind it is, and nobody is turned away for picking the other one.
 */
export type TicketKind = "issue" | "request";
export const TICKET_COMMANDS: Record<string, TicketKind> = { issue: "issue", request: "request" };
export type Ticket = { id: string; number: number; kind: TicketKind; text: string; by_name: string | null; status: string; slack_channel: string | null; slack_ts: string | null; github_number: number | null; github_url: string | null; github_error: string | null; created_at: Date; closed_at: Date | null; close_note: string | null };

const LABEL: Record<TicketKind, string> = { issue: "Issue", request: "Request" };
export const ticketUsage = (kind: TicketKind) => kind === "issue"
  ? "Say what went wrong in one line: `/issue the EOD form won't load`. Add a Loom or a screenshot in the thread after."
  : "Say what you need in one line: `/request add a no-show text for closing calls`.";

type GitHub = { token: string; repo: string };
const github = (): GitHub | null => { const token = process.env.GITHUB_TOKEN, repo = process.env.GITHUB_REPO; return token && repo ? { token, repo } : null; };
async function gh<T>(g: GitHub, method: string, path: string, body?: unknown): Promise<T> {
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 15_000);
  try {
    const res = await fetch(`https://api.github.com/repos/${g.repo}${path}`, { method, signal: ctl.signal, headers: { Authorization: `Bearer ${g.token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    if (!res.ok) throw new Error(`GitHub ${res.status}: ${text.slice(0, 200)}`);
    return (text ? JSON.parse(text) : {}) as T;
  } finally { clearTimeout(timer); }
}

async function slackOf(c: PoolClient, companyId: string) {
  const conn = await one<{ bot_token: Buffer }>(c, "select bot_token from slack_connections where company_id=$1", [companyId]);
  const op = await one<{ value: Buffer }>(c, "select value from bindings where company_id=$1 and key='bot.escalate_to'", [companyId]);
  const co = (await one<{ name: string; slug: string }>(c, "select name, slug from companies where id=$1", [companyId]))!;
  return { token: conn ? decrypt(conn.bot_token) : null, operator: op?.value.toString("utf8") || null, co };
}

/** A ticket opened from Slack: numbered, posted where it was typed, the operator told, a GitHub issue opened. Never throws past Slack. */
export async function openTicket(adapters: Adapters, companyId: string, x: { kind: TicketKind; text: string; slackUser: string; channel: string }): Promise<{ number: number; posted: boolean; github?: string; error?: string }> {
  const text = x.text.trim().slice(0, 2000);
  const { t, token, operator, co, name } = await asOperator(async (c) => {
    const s = await slackOf(c, companyId);
    await c.query("select pg_advisory_xact_lock(hashtext($1))", [`tickets:${companyId}`]);   // one number at a time per offer
    const n = (await one<{ n: number }>(c, "select coalesce(max(number), 0) + 1 as n from tickets where company_id=$1", [companyId]))!.n;
    const who = await one<{ name: string }>(c, "select name from users where company_id=$1 and slack_user_id=$2 and active limit 1", [companyId, x.slackUser]);
    const row = (await one<{ id: string; number: number }>(c, "insert into tickets (company_id, number, kind, text, by_slack_user, by_name, slack_channel) values ($1,$2,$3,$4,$5,$6,$7) returning id, number", [companyId, n, x.kind, text, x.slackUser, who?.name ?? null, x.channel]))!;
    await c.query("insert into audit_log (company_id, action, target_type, target_id, after) values ($1,'ticket.opened','ticket',$2,$3)", [companyId, row.id, { number: n, kind: x.kind, by: x.slackUser }]);
    return { t: row, token: s.token, operator: s.operator, co: s.co, name: who?.name ?? null };
  });
  const head = `🎫 *${LABEL[x.kind]} #${t.number}* from <@${x.slackUser}>`;
  let ts: string | null = null, channel = x.channel, error: string | undefined;
  if (token) {
    const posted = await adapters.notifier.post(token, x.channel, `${head}\n${text}\n_Add a Loom or a screenshot in this thread if it helps. You'll get a ✅ here when it's done._`).catch((e) => { error = String((e as Error).message); return null; });
    if (posted) { ts = posted.ts; channel = posted.channel ?? x.channel; }
  }
  let ghUrl: string | undefined, ghNumber: number | undefined, ghError: string | undefined;
  const g = github();
  if (g) {
    try {
      const issue = await gh<{ number: number; html_url: string }>(g, "POST", "/issues", { title: `[${co.name}] ${LABEL[x.kind]} #${t.number}: ${text.slice(0, 80)}`,
        body: `${text}\n\n— ${name ?? x.slackUser} in ${co.name}'s Slack (${x.kind} #${t.number}, company \`${co.slug}\`). Screenshots and Looms are in the Slack thread.`, labels: [x.kind, `offer:${co.slug}`] });
      ghUrl = issue.html_url; ghNumber = issue.number;
    } catch (e) { ghError = String((e as Error).message).slice(0, 300); }
  } else ghError = "GITHUB_TOKEN / GITHUB_REPO not set";
  await asOperator((c) => c.query("update tickets set slack_channel=$2, slack_ts=$3, github_number=$4, github_url=$5, github_error=$6 where id=$1", [t.id, channel, ts, ghNumber ?? null, ghUrl ?? null, ghError ?? null]));
  if (token && operator && operator !== x.slackUser)
    await adapters.notifier.post(token, operator, `🎫 New ${x.kind} #${t.number} at ${co.name} from ${name ?? `<@${x.slackUser}>`}: ${text}${ghUrl ? `\n<${ghUrl}|GitHub #${ghNumber}>` : ghError ? `\n_No GitHub issue: ${ghError}_` : ""}`).catch(() => null);
  return { number: t.number, posted: !!ts, ...(ghUrl ? { github: ghUrl } : {}), ...(error ? { error } : {}) };
}

/** Done: the answer in the ticket's thread, a ✅ on its post, the GitHub issue closed with the same words. */
export async function closeTicket(adapters: Adapters, companyId: string, number: number, note: string, by: string): Promise<{ ok: true; ticket: number } | { ok: false; status: number; why: string }> {
  const r = await asOperator(async (c) => {
    const t = await one<Ticket>(c, "update tickets set status='closed', closed_at=now(), closed_by=$3, close_note=$4 where company_id=$1 and number=$2 and status='open' returning *", [companyId, number, by, note]);
    if (!t) return null;
    await c.query("insert into audit_log (company_id, action, target_type, target_id, after) values ($1,'ticket.closed','ticket',$2,$3)", [companyId, t.id, { number, by, note }]);
    return { t, s: await slackOf(c, companyId) };
  });
  if (!r) return { ok: false, status: 404, why: `no open ticket #${number}` };
  const { t, s } = r;
  if (s.token && t.slack_channel && t.slack_ts) {
    await adapters.notifier.post(s.token, t.slack_channel, `✅ Done${note ? `: ${note}` : "."}`, undefined, t.slack_ts).catch(() => null);
    await adapters.notifier.react(s.token, t.slack_channel, t.slack_ts, "white_check_mark");
  }
  const g = github();
  if (g && t.github_number) {
    await gh(g, "POST", `/issues/${t.github_number}/comments`, { body: `Closed by ${by}${note ? `: ${note}` : "."}` }).catch(() => null);
    await gh(g, "PATCH", `/issues/${t.github_number}`, { state: "closed" }).catch(() => null);
  }
  return { ok: true, ticket: number };
}

export const listTickets = (c: PoolClient, companyId: string, status?: string) =>
  many<Ticket>(c, `select id, number, kind, text, by_name, status, slack_channel, slack_ts, github_number, github_url, github_error, created_at, closed_at, close_note from tickets where company_id=$1 ${status ? "and status=$2" : ""} order by number desc limit 200`, status ? [companyId, status] : [companyId]);
