import type { PoolClient } from "pg";
import { DateTime } from "luxon";
import { one } from "@/db/client";
import type { Adapters } from "@/adapters/types";
import { loadCompany } from "../context";
import { tokenFor } from "../eod";
import { missingEods } from "../missing-eods";
import { readsFrom } from "../owed";
import type { GhlReads } from "@/adapters/ghl/metrics";

/**
 * D303 (Tyler: "when an EOD form gets posted it should give the link that closers can click to fill out their eod"). A post in a
 * shared channel carries a "File my EOD" button (slack_post `buttons`, action `eod_open`), never a closer's link: their link opens
 * their form for anyone who has it. A press says who pressed, so the answer is that person's own link, shown only to them
 * (ephemeral), one per day they still owe from GHL (the same list the post tags, D264) and today's. Someone not on the team, or
 * with no end of day, is told so; nobody can open another person's form from the channel.
 */
export async function eodButtonReply(c: PoolClient, adapters: Adapters, companyId: string, slackUser: string, now = DateTime.now(), reads?: GhlReads): Promise<string> {
  const u = await one<{ id: string; name: string }>(c, `select id, name from users where company_id=$1 and slack_user_id=$2 and active
    order by (role in ('closer','setter')) desc limit 1`, [companyId, slackUser]);
  if (!u) return "This button opens your own end-of-day form, and you're not on this offer's team. Ask your manager to add you.";
  const { row } = await loadCompany(c, companyId);
  const base = (process.env.PUBLIC_URL ?? process.env.TICK_URL ?? "").replace(/\/$/, "");
  const url = `${base}/eod/${await tokenFor(c, u.id)}`;
  const first = u.name.split(" ")[0];
  let owed: { day: string; label: string; names: string[]; calls: number }[] | null;
  try { owed = (await missingEods(c, row, now, 14, reads ?? readsFrom(adapters))).find((p) => p.user_id === u.id)?.days ?? []; }
  catch { owed = null; }
  if (owed === null) return `Here's your end of day, ${first}: <${url}|Open your form>. (I couldn't read which days you still owe from GHL just now; the form shows them.)`;
  if (!owed.length) return `You're filed up to yesterday, ${first}. <${url}|Open today's end of day>`;
  const lines = owed.map((d) => `• <${url}?day=${d.day}|${d.label}>: ${d.names.length ? d.names.join(", ") : `${d.calls} call${d.calls === 1 ? "" : "s"}`}`);
  return [`Your end of day, ${first}. Still to file:`, ...lines, `• <${url}|Today>`, "_Only you can see this._"].join("\n");
}
