import type { PoolClient } from "pg";
import { DateTime } from "luxon";
import { many } from "@/db/client";
import type { CompanyRow } from "./context";
import { eodFacts } from "./eod";

/**
 * D246: who owes an end of day, at a glance (Tyler: "i can't see who has missing EODs at a glance"). For each active closer and
 * setter, the days before today in the last `lookbackDays` with calls and no report filed (eodFacts' own rule: a call is owed until
 * it has an answer), each with the names of the calls still open. Today is not late yet and is left out. The same list is the
 * `/missing-eod` command, a wrap-up's `report.missing_eods`, and the dashboard's panel. No one's link is in it (each is private).
 */
export type MissingDay = { day: string; label: string; calls: number; names: string[] };
export type MissingPerson = { user_id: string; name: string; role: string; slack_user_id: string | null; days: MissingDay[] };

export async function missingEods(c: PoolClient, company: CompanyRow, now = DateTime.now(), lookbackDays = 14): Promise<MissingPerson[]> {
  const people = await many<{ id: string; name: string; role: string; slack_user_id: string | null }>(c,
    "select id, name, role, slack_user_id from users where company_id=$1 and active and role in ('closer','setter') order by name", [company.id]);
  const out: MissingPerson[] = [];
  for (const p of people) {
    const f = await eodFacts(c, company, p.id, "", now, lookbackDays);
    if (!f.earlier.length) continue;
    const days: MissingDay[] = [];
    for (const d of f.earlier) {
      const names = d.open.length ? (await many<{ n: string }>(c, `select trim(coalesce(ct.first_name,'')||' '||coalesce(ct.last_name,'')) as n from appointments a join contacts ct on ct.id=a.contact_id
        where a.id = any($1::uuid[]) order by a.starts_at`, [d.open])).map((r) => r.n || "someone") : [];
      days.push({ day: d.day, label: d.label, calls: d.calls, names });
    }
    out.push({ user_id: p.id, name: p.name, role: p.role, slack_user_id: p.slack_user_id, days });
  }
  return out;
}

/** One line per person: "Jose P: Mon Oct 26 (Tommy Arakilian), Tue Oct 27 (Kimberly C)". */
export const missingLines = (list: MissingPerson[]): string[] =>
  list.map((p) => `${p.name}: ${p.days.map((d) => `${d.label}${d.names.length ? ` (${d.names.join(", ")})` : ` (${d.calls} call${d.calls === 1 ? "" : "s"})`}`).join(", ")}`);

/** The Slack answer. */
export function formatMissingEods(list: MissingPerson[], companyName: string): string {
  if (!list.length) return `✅ *Missing EODs · ${companyName}*\nEveryone is filed up to yesterday.`;
  const n = list.reduce((s, p) => s + p.days.length, 0);
  return [`⚠️ *Missing EODs · ${companyName}* (${n} day${n === 1 ? "" : "s"})`, ...missingLines(list).map((l) => `• ${l}`)].join("\n");
}
