import type { PoolClient } from "pg";
import { DateTime } from "luxon";
import { many } from "@/db/client";
import type { CompanyRow } from "./context";
import type { GhlReads } from "@/adapters/ghl/metrics";
import { owedFromGhl } from "./owed";

/**
 * D246: who owes an end of day, at a glance (Tyler: "i can't see who has missing EODs at a glance"). D255: read live from GHL
 * (`owedFromGhl`: Sales Calls whose call passed with no outcome, Discovery Calls still scheduled), never from what the engine
 * stored, so it is the same list /weekly's "No EOD outcome yet" gives. Each person with a day before today still owed, the names
 * open that day; today's are not late yet and are said apart (`today`). Someone off the team whose calls GHL still has unfiled is
 * listed by the name GHL has (no link: they have no form). The same list is the `/missing-eod` command, a wrap-up's
 * `report.missing_eods`, and the dashboard's panel. No one's link is in it (each is private).
 */
export type MissingDay = { day: string; label: string; calls: number; names: string[] };
export type MissingPerson = { user_id: string | null; name: string; role: string; slack_user_id: string | null; days: MissingDay[]; today: string[] };

export async function missingEods(c: PoolClient, company: CompanyRow, now = DateTime.now(), lookbackDays = 14, reads?: GhlReads): Promise<MissingPerson[]> {
  const tz = company.timezone, today = now.setZone(tz).toISODate()!;
  const owed = await owedFromGhl(c, company, now, lookbackDays, reads);
  const roster = new Map((await many<{ id: string; role: string; slack_user_id: string | null }>(c, "select id::text as id, role, slack_user_id from users where company_id=$1", [company.id])).map((u) => [u.id, u]));
  const by = new Map<string, MissingPerson>();
  for (const o of owed) {
    const k = o.user_id ?? `name:${o.who.toLowerCase()}`, u = o.user_id ? roster.get(o.user_id) : undefined;
    const p = by.get(k) ?? { user_id: o.user_id, name: o.who, role: u?.role ?? (o.kind === "triage" ? "setter" : "closer"), slack_user_id: u?.slack_user_id ?? null, days: [], today: [] };
    if (o.day === today) p.today.push(o.name);
    else {
      const d = p.days.find((x) => x.day === o.day) ?? (p.days.push({ day: o.day, label: DateTime.fromISO(o.day, { zone: tz }).toFormat("ccc LLL d"), calls: 0, names: [] }), p.days.at(-1)!);
      d.calls++; d.names.push(o.name);
    }
    by.set(k, p);
  }
  return [...by.values()].filter((p) => p.days.length).sort((a, b) => a.name.localeCompare(b.name));
}

/** One line per person: "Jose P is missing EOD for <Mon Oct 26> (Tommy Arakilian), <Tue Oct 27> (Kimberly C)", each day a link through `go` when given. */
export const missingLines = (list: MissingPerson[], go?: string): string[] =>
  list.map((p) => `${p.name} is missing EOD for ${p.days.map((d) => `${go && p.user_id ? `<${go}/${p.user_id}/${d.day}|${d.label}>` : d.label}${d.names.length ? ` (${d.names.join(", ")})` : ` (${d.calls} call${d.calls === 1 ? "" : "s"})`}`).join(", ")}`);

/**
 * The Slack answer: "Jose P is missing EOD for <Mon Oct 26> (Tommy Arakilian), <Tue Oct 27> (Kimberly C)", each day a link through the
 * operator's sign-in to that day's form (`go`: the base of /go/eod/<slug>; none, plain days). The closers' private links are never in it.
 */
export function formatMissingEods(list: MissingPerson[], companyName: string, go?: string): string {
  if (!list.length) return `✅ *Missing EODs · ${companyName}*\nEveryone is filed up to yesterday.`;
  const n = list.reduce((s, p) => s + p.days.length, 0);
  return [`⚠️ *Missing EODs · ${companyName}* (${n} day${n === 1 ? "" : "s"})`, ...missingLines(list, go).map((l, i) => `• ${l}${list[i].today.length ? `; today so far: ${list[i].today.join(", ")}` : ""}`), "_From the Sales Calls in GHL: a call that has passed with no outcome is owed._"].join("\n");
}

