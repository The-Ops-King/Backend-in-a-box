/**
 * D316: is a person fully in, or fully out, of one offer (Tyler, 2026-11-06: "I need you to actually look and see if Minerva is
 * fully out and Mel is fully in ... I just need you to check those things instead of telling me to"). Every tool the engine can
 * reach is read live, and each line says what was seen, not what to go and look at:
 * - the engine: role, upcoming calls, open cards, contacts owned, the calendars it watches as theirs, the Sales Call closer option
 * - GHL: whether they are a user of the location
 * - Calendly: whether they are a member, which calendars they host (and which of those the engine watches), open times on their own
 * - Slack: whether their account is active, and whether they are in the role's channels
 * - Fathom: whether they are on the team the offer's key reads, and their latest meeting the key can see
 * Someone with a setter or closer role is checked as "in"; anyone else as "out". Nothing is changed. The vendor reads are passed in
 * (`MemberLookups`), so a read that is refused or not set up says so instead of failing the whole check.
 */
import type { PoolClient } from "pg";
import { many, one } from "@/db/client";
import type { CalendarSnapshot } from "@/adapters/types";

export type Mark = "ok" | "no" | "wait" | "unknown" | "info";
export type MemberLine = { area: string; mark: Mark; say: string };
export type MemberCheck = { ok: true; email: string; name: string | null; role: string | null; expect: "in" | "out"; lines: MemberLine[]; left: number };

/** The live reads. Each may be missing (the offer has no such tool) or answer null (the vendor would not say). */
export type MemberLookups = {
  ghlUsers?: () => Promise<{ id: string; email?: string; name?: string }[]>;
  calendars?: () => Promise<CalendarSnapshot[]>;
  calendlyMember?: (email: string) => Promise<boolean | null>;
  openTimes?: (calendarId: string) => Promise<number | null>;
  slack?: { find(email: string): Promise<string | null>; active(id: string): Promise<boolean | null>; members(channelId: string): Promise<string[] | null> };
  fathom?: { team(): Promise<string[] | null>; latest(email: string): Promise<string | null> };
};

/** The Slack channels each role works in (the offer's own settings); only those set are checked. */
export const ROLE_CHANNELS: Record<"setter" | "closer", { key: string; label: string }[]> = {
  setter: [{ key: "slack.channel.bookings", label: "bookings" }, { key: "slack.channel.setter_calls", label: "setter calls" }],
  closer: [{ key: "slack.channel.bookings", label: "bookings" }, { key: "slack.channel.calls", label: "calls" }, { key: "slack.channel.eod", label: "end of day" }],
};

const day = (iso: string | Date) => new Date(iso).toISOString().slice(0, 10);
async function tryRead<T>(f: (() => Promise<T>) | undefined): Promise<{ ok: true; v: T } | { ok: false; why: string } | null> {
  if (!f) return null;
  try { return { ok: true, v: await f() }; } catch (e) { return { ok: false, why: String((e as Error).message).slice(0, 140) }; }
}

export async function memberCheck(c: PoolClient, a: { companyId: string; email: string; bindings: Record<string, string>; lookups: MemberLookups; expect?: "in" | "out"; now?: Date }): Promise<MemberCheck> {
  const email = a.email.trim().toLowerCase();
  const now = a.now ?? new Date();
  const p = await one<{ id: string; name: string; role: string; active: boolean; ghl_user_id: string | null; slack_user_id: string | null }>(c,
    "select id, name, role, active, ghl_user_id, slack_user_id from users where company_id=$1 and lower(email)=$2 order by active desc limit 1", [a.companyId, email]);
  const role = p?.role ?? null;
  const working = (role === "setter" || role === "closer") && p!.active;
  const expect = a.expect ?? (working ? "in" : "out");
  const IN = expect === "in";
  const L: MemberLine[] = [];
  const add = (area: string, mark: Mark, say: string) => L.push({ area, mark, say });

  // ── the engine ──
  if (!p) add("Engine", IN ? "no" : "ok", IN ? `No one on the roster has ${email}.` : `Not on the roster.`);
  else if (IN) add("Engine", working ? "ok" : "no", working ? `On the roster as a ${role}.` : `On the roster as ${role}${p.active ? "" : " (inactive)"}, not a setter or closer.`);
  else add("Engine", working ? "no" : "ok", working ? `Still a ${role} on the roster.` : `No setter or closer role (${role}).`);
  if (p) {
    const upcoming = Number((await one<{ n: string }>(c, "select count(*) n from appointments where company_id=$1 and assigned_user_id=$2 and starts_at > $3 and status <> 'cancelled'", [a.companyId, p.id, now]))!.n);
    const cards = Number((await one<{ n: string }>(c, "select count(*) n from pipeline_cards where company_id=$1 and assigned_user_id=$2 and status='open'", [a.companyId, p.id]))!.n);
    const owned = p.ghl_user_id ? Number((await one<{ n: string }>(c, "select count(*) n from contacts where company_id=$1 and assigned_ghl_user_id=$2", [a.companyId, p.ghl_user_id]))!.n) : 0;
    if (!IN) {
      add("Engine", upcoming ? "no" : "ok", upcoming ? `${upcoming} upcoming call${upcoming === 1 ? "" : "s"} still assigned to them.` : "No upcoming calls assigned.");
      add("Engine", cards ? "no" : "ok", cards ? `${cards} open card${cards === 1 ? "" : "s"} still on them.` : "No open cards on them.");
      add("Engine", owned ? "no" : "ok", owned ? `Owns ${owned} contact${owned === 1 ? "" : "s"}.` : "Owns no contacts.");
    } else add("Engine", "info", `${upcoming} upcoming call${upcoming === 1 ? "" : "s"}, ${cards} open card${cards === 1 ? "" : "s"}, ${owned} contact${owned === 1 ? "" : "s"} owned.`);
    const theirs = await many<{ name: string; external_id: string }>(c, "select name, external_id from calendars where company_id=$1 and active and default_user_id=$2 order by name", [a.companyId, p.id]);
    if (!IN && theirs.length) add("Engine", "no", `Still watches ${theirs.map((k) => `"${k.name}"`).join(", ")} as their calendar.`);
    if (IN && role === "closer") {
      let options: Record<string, string> = {};
      try { options = JSON.parse(a.bindings["sales_call.closer_options"] || "{}") as Record<string, string>; } catch { /* unset */ }
      const opt = Object.entries(options).find(([k]) => k.toLowerCase() === email)?.[1];
      add("Engine", opt ? "ok" : "no", opt ? `Sales Calls name them "${opt}".` : "No option for them on the Sales Call Closer field: their Sales Calls can't name them.");
    }
  }

  // ── GHL ──
  const ghl = await tryRead(a.lookups.ghlUsers);
  if (ghl && !ghl.ok) add("GHL", "unknown", `Couldn't read the users: ${ghl.why}`);
  else if (ghl) {
    const u = ghl.v.find((x) => x.email?.toLowerCase() === email || (!!p?.ghl_user_id && x.id === p.ghl_user_id));
    if (IN) add("GHL", u ? "ok" : "no", u ? `A user of the location${p?.ghl_user_id && u.id !== p.ghl_user_id ? " (a different GHL user than the engine has)" : ""}.` : "Not a user of the location.");
    else add("GHL", u ? "no" : "ok", u ? `Still a user of the location (${u.name || u.email}).` : "Not a user of the location.");
  }

  // ── Calendly ──
  const member = await tryRead(a.lookups.calendlyMember ? () => a.lookups.calendlyMember!(email) : undefined);
  if (member && !member.ok) add("Calendly", "unknown", `Couldn't read the members: ${member.why}`);
  else if (member && member.v !== null) add("Calendly", member.v === IN ? "ok" : "no", member.v ? "A member of the organization." : "Not a member of the organization.");
  const cals = await tryRead(a.lookups.calendars);
  if (cals && !cals.ok) add("Calendly", "unknown", `Couldn't read the calendars: ${cals.why}`);
  else if (cals) {
    const watched = await many<{ external_id: string; name: string; category: string | null; term: string | null; owner: string | null }>(c,
      `select k.external_id, k.name, t.category, t.name term, k.default_user_id::text owner from calendars k left join company_terms t on t.id=k.appointment_term where k.company_id=$1 and k.active`, [a.companyId]);
    const hosted = cals.v.filter((k) => k.active !== false && k.hosts?.some((h) => h.email.toLowerCase() === email));
    const w = (k: CalendarSnapshot) => watched.find((x) => x.external_id === k.id);
    if (!IN) add("Calendly", hosted.length ? "no" : "ok", hosted.length ? `Still hosts ${hosted.map((k) => `"${k.name}"${w(k) ? " (watched)" : ""}`).join(", ")}.` : "Hosts no active calendar.");
    else {
      const role0 = role === "setter" ? "setter" : "closer";
      const closing = watched.filter((x) => x.category === "closing");
      const pools = hosted.filter((k) => (k.hosts?.length ?? 0) > 1 && w(k));
      const own = hosted.filter((k) => (k.hosts?.length ?? 0) <= 1 && w(k));
      if (role0 === "closer") {
        const theirsClosing = hosted.filter((k) => closing.some((x) => x.external_id === k.id));
        add("Calendly", theirsClosing.length ? "ok" : "no", theirsClosing.length ? `Hosts ${theirsClosing.map((k) => `"${k.name}"`).join(", ")}, watched as ${[...new Set(theirsClosing.map((k) => w(k)!.term))].join(" / ")}.` : `Hosts none of the closing calendars the engine watches (${closing.map((x) => `"${x.name}"`).join(", ") || "none"}).`);
        const pooled = closing.filter((x) => cals.v.find((k) => k.id === x.external_id && (k.hosts?.length ?? 0) > 1));
        const missing = pooled.filter((x) => !pools.some((k) => k.id === x.external_id));
        if (missing.length) add("Calendly", "no", `Not a host on ${missing.map((x) => `"${x.name}"`).join(", ")}, which the other closers share.`);
        add("Calendly", own.length ? "ok" : "info", own.length ? `Their own calendar${own.length === 1 ? "" : "s"}: ${own.map((k) => `"${k.name}" (${w(k)!.term})`).join(", ")}.` : "No calendar of their own the engine watches (for follow-ups they book).");
      } else add("Calendly", hosted.length ? "ok" : "info", hosted.length ? `Hosts ${hosted.map((k) => `"${k.name}"`).join(", ")}.` : "Hosts no calendar (setters book on the closers').");
      const unwatched = hosted.filter((k) => !w(k));
      if (unwatched.length) add("Calendly", "info", `Also hosts ${unwatched.map((k) => `"${k.name}"`).join(", ")}, which the engine doesn't watch: bookings there never reach it.`);
      for (const k of own.slice(0, 2)) {
        const t = await tryRead(a.lookups.openTimes ? () => a.lookups.openTimes!(k.id) : undefined);
        if (!t) continue;
        if (!t.ok || t.v === null) add("Calendly", "unknown", `Couldn't read the open times on "${k.name}".`);
        else add("Calendly", t.v > 0 ? "ok" : "no", t.v > 0 ? `Bookable: ${t.v} open time${t.v === 1 ? "" : "s"} in the next 7 days on "${k.name}".` : `No open times in the next 7 days on "${k.name}": their availability or calendar blocks every slot.`);
      }
    }
  }

  // ── Slack ──
  const s = a.lookups.slack;
  if (s) {
    const id = (await tryRead(() => s.find(email)));
    const sid = id && id.ok ? id.v : null;
    const known = sid ?? p?.slack_user_id ?? null;
    const active = known ? await tryRead(() => s.active(known)) : null;
    const isActive = active && active.ok ? active.v : null;
    if (id && !id.ok) add("Slack", "unknown", `Couldn't look them up: ${id.why}`);
    else if (IN) {
      if (!known) add("Slack", "no", `No Slack account has ${email}.`);
      else if (isActive === false) add("Slack", "no", "Their Slack account is deactivated.");
      else add("Slack", p?.slack_user_id === known ? "ok" : "no", p?.slack_user_id === known ? "Account active and linked: reminders and buttons reach them." : "Has a Slack account the engine hasn't linked.");
    } else {
      if (!known || isActive === false) add("Slack", "ok", known ? "Their Slack account is deactivated." : "No Slack account has their email.");
      else add("Slack", "no", "Their Slack account is still active.");
    }
    const r = role === "setter" ? "setter" : role === "closer" ? "closer" : null;
    const channels = (r ? ROLE_CHANNELS[r] : [...ROLE_CHANNELS.closer, ...ROLE_CHANNELS.setter]).filter((ch, i, all) => a.bindings[ch.key] && all.findIndex((x) => x.key === ch.key) === i);
    if (known && isActive !== false) {
      for (const ch of channels) {
        const m = await tryRead(() => s.members(a.bindings[ch.key]));
        const ids = m && m.ok ? m.v : null;
        if (ids === null) add("Slack", "unknown", `Couldn't read who is in the ${ch.label} channel (<#${a.bindings[ch.key]}>).`);
        else if (IN) add("Slack", ids.includes(known) ? "ok" : "no", ids.includes(known) ? `In the ${ch.label} channel.` : `Not in the ${ch.label} channel (<#${a.bindings[ch.key]}>).`);
        else if (ids.includes(known)) add("Slack", "no", `Still in the ${ch.label} channel (<#${a.bindings[ch.key]}>).`);
      }
    }
  }

  // ── Fathom ──
  const f = a.lookups.fathom;
  if (f) {
    const team = await tryRead(() => f.team());
    const latest = await tryRead(() => f.latest(email));
    const onTeam = team && team.ok && team.v ? team.v.map((e) => e.toLowerCase()).includes(email) : null;
    const last = latest && latest.ok ? latest.v : null;
    if (onTeam === null) { if (team && !team.ok) add("Fathom", "unknown", `Couldn't read the team: ${team.why}`); }
    else add("Fathom", onTeam === IN ? "ok" : "no", onTeam ? "On the Fathom team the engine reads." : "Not on the Fathom team the engine reads.");
    if (IN) add("Fathom", last ? "ok" : "wait", last ? `Their meetings reach the engine (latest ${day(last)}).` : "No meeting of theirs reached the engine's Fathom yet: their first recorded call shows here.");
    else if (last) add("Fathom", "info", `Their latest meeting the engine's Fathom can see: ${day(last)}.`);
  }

  const left = L.filter((l) => l.mark === "no").length;
  return { ok: true, email, name: p?.name ?? null, role, expect, lines: L, left };
}

const ICON: Record<Mark, string> = { ok: "✅", no: "❌", wait: "⏳", unknown: "❔", info: "ℹ️" };
/** The check as one Slack or chat message. */
export function formatMemberCheck(r: MemberCheck): string {
  const who = r.name ? `*${r.name}* (${r.email})` : `*${r.email}*`;
  const head = r.expect === "in" ? `${who}: is everything set up for a ${r.role}?` : `${who}: are they out of everything?`;
  const body: string[] = [];
  let area = "";
  for (const l of r.lines) { if (l.area !== area) { body.push(`*${l.area}*`); area = l.area; } body.push(`${ICON[l.mark]} ${l.say}`); }
  const verdict = r.left ? `${r.left} thing${r.left === 1 ? "" : "s"} not right yet.` : r.expect === "in" ? "Fully in." : "Fully out.";
  return [head, "", ...body, "", verdict].join("\n");
}
