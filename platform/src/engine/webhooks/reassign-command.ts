import type { PoolClient } from "pg";
import { DateTime } from "luxon";
import { many, one } from "@/db/client";
import { callsOf, requestReassign } from "../reassign";

/**
 * D253 (Tyler: "/reassign ... select who you're assigning it from, select what day, select which calls you're assigning and to whom";
 * "If a closer is sick or something, they can say /reassign all my calls today to Minerva"). Two forms: whose calls and which day
 * (you and today unless you change them), then that day's calls to tick (all ticked to start) and who takes them. A closer hands
 * over their own calls; an owner, a manager or the operator anyone's. Only calls still ahead are offered: a call already taken is
 * the end of day's ("Someone else took this call"). Each ticked call is one `appointment.reassign_requested`; the offer's
 * workflows do the rest.
 */
export const REASSIGN_COMMAND = "reassign";
export const REASSIGN_PICK = "reassign_pick";
export const REASSIGN_CALLS = "reassign_calls";
type Member = { id: string; name: string; role: string };
type Asker = { me: Member | null; admin: boolean; name: string };
type Meta = { channel?: string; from?: string; day?: string };

const opt = (text: string, value: string) => ({ text: { type: "plain_text", text: text.slice(0, 75) }, value });
const team = (c: PoolClient, companyId: string) => many<Member>(c, "select id, name, role from users where company_id=$1 and active and role in ('closer','setter','owner','manager') order by name", [companyId]);

async function asker(c: PoolClient, companyId: string, slackUser: string): Promise<Asker> {
  const me = await one<Member>(c, "select id, name, role from users where company_id=$1 and slack_user_id=$2 and active order by (role in ('owner','manager')) desc limit 1", [companyId, slackUser]);
  const op = (await one<{ value: Buffer }>(c, "select value from bindings where company_id=$1 and key='bot.escalate_to'", [companyId]))?.value.toString("utf8").trim();
  return { me: me ?? null, admin: (!!op && op === slackUser) || me?.role === "owner" || me?.role === "manager", name: me?.name ?? "the operator" };
}

/** The first form, or why there is none (said privately). */
export async function reassignStart(c: PoolClient, companyId: string, slackUser: string, tz: string, channel: string): Promise<{ view: Record<string, unknown> } | { say: string }> {
  const a = await asker(c, companyId, slackUser);
  if (!a.me && !a.admin) return { say: "You're not on this offer's team in the engine yet, so there are no calls of yours to hand over. Ask Tyler to add you." };
  const people = a.admin ? await team(c, companyId) : [a.me!];
  const initial = a.me && people.some((p) => p.id === a.me!.id) ? a.me : people[0];
  if (!initial) return { say: "Nobody is on this offer's team yet." };
  const meta: Meta = { channel };
  return { view: { type: "modal", callback_id: REASSIGN_PICK, private_metadata: JSON.stringify(meta), title: { type: "plain_text", text: "Hand over calls" }, submit: { type: "plain_text", text: "Next" }, close: { type: "plain_text", text: "Cancel" },
    blocks: [
      { type: "input", block_id: "from", label: { type: "plain_text", text: "Whose calls?" }, element: { type: "static_select", action_id: "v", options: people.map((p) => opt(p.name, p.id)), initial_option: opt(initial.name, initial.id) } },
      { type: "input", block_id: "day", label: { type: "plain_text", text: "Which day?" }, element: { type: "datepicker", action_id: "v", initial_date: DateTime.now().setZone(tz).toISODate() } },
    ] } };
}

/** The first form sent: the second (that day's calls, and who takes them), or what is wrong with the first. */
export async function reassignPicked(c: PoolClient, companyId: string, slackUser: string, tz: string, values: Record<string, string>, metaRaw?: string): Promise<{ view: Record<string, unknown> } | { errors: Record<string, string> }> {
  const a = await asker(c, companyId, slackUser);
  const from = values.from, day = values.day;
  if (!from) return { errors: { from: "Pick whose calls" } };
  if (!day || !DateTime.fromISO(day).isValid) return { errors: { day: "Pick a day" } };
  if (!a.admin && a.me?.id !== from) return { errors: { from: "You can hand over your own calls; a manager can hand over anyone's" } };
  const owner = (await team(c, companyId)).find((p) => p.id === from);
  if (!owner) return { errors: { from: "They're not on the team" } };
  const calls = await callsOf(c, companyId, from, day, tz, { upcoming: true });
  if (!calls.length) return { errors: { day: `${owner.name.split(" ")[0]} has no calls still ahead that day` } };
  const to = (await team(c, companyId)).filter((p) => p.id !== from);
  const meta: Meta = { ...(safe(metaRaw)), from, day };
  const options = calls.slice(0, 10).map((x) => opt(`${DateTime.fromJSDate(x.starts_at).setZone(tz).toFormat("h:mm a")} · ${x.who || "someone"}${x.term ? ` (${x.term})` : ""}`, x.id));
  return { view: { type: "modal", callback_id: REASSIGN_CALLS, private_metadata: JSON.stringify(meta), title: { type: "plain_text", text: "Hand over calls" }, submit: { type: "plain_text", text: "Hand over" }, close: { type: "plain_text", text: "Cancel" },
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: `*${owner.name}*, ${DateTime.fromISO(day, { zone: tz }).toFormat("cccc LLL d")}` } },
      { type: "input", block_id: "calls", label: { type: "plain_text", text: "Which calls?" }, element: { type: "checkboxes", action_id: "v", options, initial_options: options } },
      { type: "input", block_id: "to", label: { type: "plain_text", text: "Who takes them?" }, element: { type: "static_select", action_id: "v", options: to.map((p) => opt(p.name, p.id)) } },
      { type: "context", elements: [{ type: "mrkdwn", text: "They're told to reach each prospect with their own meeting link: the invite keeps the old one." }] },
    ] } };
}

/** The second form sent: each ticked call handed over, and the words for the person who asked; or what is wrong with it. */
export async function reassignChosen(c: PoolClient, companyId: string, slackUser: string, tz: string, values: Record<string, string>, metaRaw?: string): Promise<{ say: string } | { errors: Record<string, string> }> {
  const a = await asker(c, companyId, slackUser), meta = safe(metaRaw);
  if (!meta.from || !meta.day) return { errors: { calls: "That form is out of date; run /reassign again" } };
  if (!a.admin && a.me?.id !== meta.from) return { errors: { calls: "You can hand over your own calls; a manager can hand over anyone's" } };
  const picked = (values.calls ?? "").split(",").filter(Boolean), to = values.to;
  if (!picked.length) return { errors: { calls: "Tick at least one call" } };
  if (!to) return { errors: { to: "Pick who takes them" } };
  const theirs = new Map((await callsOf(c, companyId, meta.from, meta.day, tz, { upcoming: true })).map((x) => [x.id, x]));
  const done: string[] = [], skipped: string[] = [];
  let toName = "";
  for (const id of picked) {
    const x = theirs.get(id);
    if (!x) { skipped.push("a call that is no longer theirs or has started"); continue; }
    const r = await requestReassign(c, companyId, { appointmentId: id, toUserId: to, via: "slack", by: a.name });
    if (r.ok) { done.push(`${DateTime.fromJSDate(x.starts_at).setZone(tz).toFormat("h:mm a")} ${x.who}`); toName = r.to.name; } else skipped.push(`${x.who}: ${r.error}`);
  }
  if (!done.length) return { errors: { calls: skipped[0] ?? "Nothing to hand over" } };
  return { say: `🔀 Handed ${done.length} call${done.length === 1 ? "" : "s"} to ${toName}: ${done.join(", ")}. They're being told to reach out with their own link.${skipped.length ? `\nNot handed over: ${skipped.join("; ")}.` : ""}` };
}

function safe(raw?: string): Meta { try { const m = JSON.parse(raw ?? "{}") as Meta; return m && typeof m === "object" ? m : {}; } catch { return {}; } }
