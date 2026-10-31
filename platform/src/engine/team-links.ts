import type { PoolClient } from "pg";
import { many, one } from "@/db/client";

/**
 * D283: the booking links each person on the team uses, shown on the onboarding page ("Your links"). Which calendars are the round
 * robin's and which are each closer's own is the offer's setting `team.links` (Tyler: "configurable, not written in"):
 *   { "rr": { "triage": <calendar id>, "closing": <calendar id> }, "closers": [{ "email": …, "triage": <calendar id>, "closing": <calendar id> }] }
 * A calendar id is the booking tool's id (or a watched calendar's name); its link is the one the engine keeps for it. The setters
 * are the roster's active setters, each link tagged as theirs (D153: utm_medium=setter, utm_content=their first name, or their email
 * when another active person shares it), so whatever they book is credited to them.
 */
export type TeamLink = { label: string; url: string };
export type TeamLinks = { closers: { name: string; links: TeamLink[] }[]; setters: { name: string; links: TeamLink[] }[] };
type Config = { rr?: { triage?: string; closing?: string }; closers?: { email: string; triage?: string; closing?: string }[] };

export function parseTeamLinks(raw: string | undefined | null): Config | null {
  if (!raw?.trim()) return null;
  try { const v = JSON.parse(raw) as Config; return v && typeof v === "object" ? v : null; } catch { return null; }
}

/** A setter's tag on a link: their first name, or their email when another active person has the same first name (D153 matches either). */
export const setterTag = (u: { name: string; email: string }, team: { name: string; email: string }[]) => {
  const first = u.name.trim().split(/\s+/)[0].toLowerCase();
  return team.filter((x) => x.name.trim().split(/\s+/)[0].toLowerCase() === first).length === 1 ? first : u.email.toLowerCase();
};
export const tagged = (url: string, tag: string) => { const u = new URL(url); u.searchParams.set("utm_medium", "setter"); u.searchParams.set("utm_content", tag); return u.toString(); };

export async function teamLinks(c: PoolClient, companyId: string): Promise<TeamLinks | null> {
  const cfg = parseTeamLinks((await one<{ v: Buffer }>(c, "select value as v from bindings where company_id=$1 and key='team.links'", [companyId]))?.v.toString("utf8"));
  if (!cfg) return null;
  const cals = await many<{ external_id: string; name: string; booking_url: string | null }>(c, "select external_id, name, booking_url from calendars where company_id=$1 and active and booking_url is not null", [companyId]);
  const url = (ref?: string) => (ref ? cals.find((k) => k.external_id === ref || k.name.toLowerCase() === ref.toLowerCase())?.booking_url ?? null : null);
  const team = await many<{ name: string; email: string; role: string }>(c, "select name, email, role from users where company_id=$1 and active order by name", [companyId]);
  const closers = (cfg.closers ?? []).map((k) => ({ ...k, who: team.find((u) => u.email.toLowerCase() === k.email.toLowerCase()) })).filter((k) => k.who);
  const first = (n: string) => n.trim().split(/\s+/)[0];
  const out: TeamLinks = {
    closers: closers.map((k) => ({ name: k.who!.name, links: [{ label: "Triage", url: url(k.triage) }, { label: "Closing: follow-up or self-set", url: url(k.closing) }].filter((l): l is TeamLink => !!l.url) })),
    setters: [],
  };
  for (const s of team.filter((u) => u.role === "setter")) {
    const tag = setterTag(s, team);
    const links: (TeamLink | { label: string; url: string | null })[] = [
      { label: "Triage (round robin)", url: url(cfg.rr?.triage) }, { label: "Closing (round robin)", url: url(cfg.rr?.closing) },
      // Tyler: setters do not book triage calls on a closer's own calendar; only the round robin's
      ...closers.map((k) => ({ label: `${first(k.who!.name)}'s closing`, url: url(k.closing) })),
    ];
    out.setters.push({ name: s.name, links: links.filter((l): l is TeamLink => !!l.url).map((l) => ({ label: l.label, url: tagged(l.url, tag) })) });
  }
  return out;
}
