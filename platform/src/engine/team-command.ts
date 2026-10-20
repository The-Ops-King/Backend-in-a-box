/**
 * D203: /team in Slack (Tyler: "Maybe if we could just have the Slack command tell me what I need to do"). Only the operator
 * (`bot.escalate_to`) runs it. `/team add <email> <setter|closer>` re-reads the GHL roster, gives the person the role once they are a
 * GHL user (D197's changeTeam), and answers with a checklist: what is done, and the exact next step for anything that is not. Run it
 * again after a fix; nothing is done twice. `/team remove <email>` takes the role off; `/team` lists the team. Nothing is invited or
 * created anywhere: GHL, Slack, Calendly and the phone number stay Tyler's to set up, and the checklist says which.
 */
import type { PoolClient } from "pg";
import { many, one } from "@/db/client";
import { bookingFor, type Adapters, type Company } from "@/adapters/types";
import { changeTeam, teamOf, type TeamRole } from "./team";

export const TEAM_COMMAND = "team";
export const TEAM_USAGE = [
  "`/team` lists the team.",
  "`/team add <email> <setter|closer>` adds them (once they're a GHL user) and says what's left to do. Run it again after each fix.",
  "`/team add <email> setter slack:<their Slack email>` when their Slack email is different.",
  "`/team remove <email>` takes the role off (nothing they did is touched).",
].join("\n");

export type TeamAsk = { kind: "list" } | { kind: "add"; email: string; role: TeamRole; slack?: string } | { kind: "remove"; email: string } | { kind: "usage"; why?: string };

export function parseTeam(text: string): TeamAsk {
  const words = text.trim().split(/\s+/).filter(Boolean).map((w) => w.replace(/^<mailto:[^|]+\|(.+)>$/, "$1"));   // Slack links a typed email
  if (!words.length) return { kind: "list" };
  const [verb, email, ...rest] = words;
  const v = verb.toLowerCase();
  if (v === "help") return { kind: "usage" };
  if (v !== "add" && v !== "remove") return { kind: "usage", why: `I don't know "${verb}".` };
  if (!email || !email.includes("@")) return { kind: "usage", why: "Give their email (the one they use in GHL)." };
  if (v === "remove") return { kind: "remove", email: email.toLowerCase() };
  const role = rest.find((w) => /^(setter|closer)$/i.test(w))?.toLowerCase() as TeamRole | undefined;
  if (!role) return { kind: "usage", why: "Say setter or closer." };
  const slack = rest.find((w) => /^slack:/i.test(w))?.slice(6);
  return { kind: "add", email: email.toLowerCase(), role, ...(slack ? { slack } : {}) };
}

/** The channels each role works in; only the ones this offer has set are checked. */
const ROLE_CHANNELS: Record<TeamRole, { key: string; label: string }[]> = {
  setter: [{ key: "slack.channel.bookings", label: "bookings" }, { key: "slack.channel.setter_calls", label: "setter calls" }],
  closer: [{ key: "slack.channel.bookings", label: "bookings" }, { key: "slack.channel.calls", label: "calls" }, { key: "slack.channel.eod", label: "end of day" }],
};

type Args = { companyId: string; ac: Company; adapters: Adapters; slackToken: string | null; bindings: Record<string, string>; userId: string; text: string };

export async function teamCommand(c: PoolClient, a: Args): Promise<string> {
  const op = a.bindings["bot.escalate_to"];
  if (!op) return "No one is set up to run /team in this workspace (`bot.escalate_to` is empty).";
  if (a.userId !== op) return `Only ${a.bindings["bot.escalate_name"] || "the operator"} can change the team.`;
  const ask = parseTeam(a.text);
  if (ask.kind === "usage") return [ask.why, TEAM_USAGE].filter(Boolean).join("\n");
  if (ask.kind === "list") {
    const team = (await teamOf(c, a.companyId)).filter((p) => p.role === "setter" || p.role === "closer");
    if (!team.length) return `No setters or closers yet.\n${TEAM_USAGE}`;
    return ["*The team*", ...team.map((p) => `• ${p.name} (${p.email}): ${p.role}${p.slack_user_id ? "" : " · ❌ no Slack linked"}`), "", "`/team add <email> <role>` gives anyone's full checklist."].join("\n");
  }
  if (ask.kind === "remove") {
    const r = await changeTeam(c, { companyId: a.companyId, ac: a.ac, adapters: a.adapters, slackToken: a.slackToken, change: { email: ask.email, remove: true, by: `slack:${a.userId}` } });
    if (!r.ok) return `❌ ${r.why}`;
    return `${r.person.name} is off the team (was ${r.was.role}): no calls, end of day or setter link from now on. Nothing they did is touched. If they're leaving, remove them from GHL, Slack and Calendly yourself.`;
  }
  return addChecklist(c, a, ask);
}

async function addChecklist(c: PoolClient, a: Args, ask: Extract<TeamAsk, { kind: "add" }>): Promise<string> {
  const r = await changeTeam(c, { companyId: a.companyId, ac: a.ac, adapters: a.adapters, slackToken: a.slackToken, change: { email: ask.email, role: ask.role, slack: ask.slack, by: `slack:${a.userId}` } });
  const L: string[] = [];
  if (!r.ok && r.status !== 404) return `❌ ${r.why}`;
  const notInGhl = !r.ok && /not a GHL user/.test(r.why);
  if (!r.ok && !notInGhl) {
    // a Slack email no one has: the role waits until it is right, so say only that
    return `❌ ${r.why}. Check their Slack email, or leave \`slack:\` off to look them up by ${ask.email}.`;
  }
  if (notInGhl) {
    L.push(`*${ask.email}* → ${ask.role}`, `❌ Not a GHL user in this location yet: invite ${ask.email} in GHL (Settings → My Staff) and have them accept. Then run this again; the rest is checked once they're in.`);
    const slackId = a.slackToken ? await a.adapters.notifier.lookupUserByEmail(a.slackToken, ask.slack ?? ask.email).catch(() => null) : null;
    L.push(slackId ? `✅ In Slack` : `❌ Not in Slack: invite ${ask.slack ?? ask.email} to the workspace (or add \`slack:<their Slack email>\` if it's different).`);
    return L.join("\n");
  }
  if (!r.ok) return `❌ ${r.why}`;
  const p = await one<{ id: string; name: string; ghl_user_id: string | null }>(c, "select id, name, ghl_user_id from users where company_id=$1 and lower(email)=$2", [a.companyId, ask.email]);
  L.push(`*${r.person.name}* → ${ask.role}${r.synced ? " (just found in GHL)" : ""}`);
  L.push(`✅ In GHL as ${r.person.name}`);
  L.push(r.was.role === ask.role ? `✅ Already a ${ask.role}` : `✅ Made a ${ask.role} (was ${r.was.role ?? "not on the team"})`);

  // a setter's link names them by first name, matched against everyone active on the roster: it has to be theirs alone
  const first = r.person.name.trim().split(/\s+/)[0].toLowerCase();
  const twins = await many<{ name: string }>(c, "select name from users where company_id=$1 and active and id<>$2 and lower(split_part(trim(name), ' ', 1))=$3", [a.companyId, p!.id, first]);
  if (ask.role === "setter") L.push(twins.length ? `❌ Their first name "${first}" is shared with ${twins.map((t) => t.name).join(", ")}: their setter link can't tell them apart. Give one of them a different first name in GHL.` : `✅ First name "${first}" is theirs alone (their setter link works)`);

  const slackId = r.person.slack_user_id;
  L.push(slackId ? `✅ Slack linked` : `❌ No Slack account has ${ask.email}: invite them to the workspace, then run this again (or add \`slack:<their Slack email>\` if it's different). Until then their reminders can't reach them.`);

  if (slackId && a.slackToken && a.adapters.notifier.channelMembers) {
    for (const ch of ROLE_CHANNELS[ask.role]) {
      const id = a.bindings[ch.key]; if (!id) continue;
      const members = await a.adapters.notifier.channelMembers(a.slackToken, id).catch(() => null);
      L.push(members === null ? `❔ Couldn't check the ${ch.label} channel (<#${id}>): make sure they're in it.` : members.includes(slackId) ? `✅ In <#${id}>` : `❌ Not in <#${id}> (${ch.label}): add them.`);
    }
  }

  // a call of theirs the engine has seen: a GHL phone call they placed, or a meeting they recorded
  const seen = await one<{ n: string }>(c, "select count(*) as n from recordings where company_id=$1 and ((raw->>'caller_ghl_user_id') = $2 or lower(recorded_by_email) = $3)", [a.companyId, p!.ghl_user_id ?? "", ask.email]);
  L.push(Number(seen?.n ?? 0) > 0 ? `✅ Their calls are coming in (${seen!.n} so far)` : ask.role === "setter"
    ? "⏳ No call from them yet: give them a phone number in GHL and turn on call recording and transcription for their user. Their first call shows here once it's in."
    : "⏳ No recorded call from them yet: make sure their calls are recorded (Fathom or GHL). Their first call shows here once it's in.");

  // the calendars the engine watches, and whether they host one
  try {
    const watched = await many<{ external_id: string; name: string; term: string | null }>(c, "select k.external_id, k.name, t.category as term from calendars k left join company_terms t on t.id=k.appointment_term where k.company_id=$1 and k.active", [a.companyId]);
    const listed = await bookingFor(a.adapters, a.ac).listCalendars(a.ac);
    const hosts = (id: string) => { const k = listed.find((x) => x.id === id); return !!k && (k.hosts?.some((h) => h.email.toLowerCase() === ask.email) || (!!p!.ghl_user_id && k.teamMemberIds.includes(p!.ghl_user_id))); };
    const theirs = watched.filter((w) => hosts(w.external_id));
    if (ask.role === "closer") {
      const closing = watched.filter((w) => w.term === "closing");
      L.push(theirs.some((w) => w.term === "closing") ? `✅ Hosts ${theirs.filter((w) => w.term === "closing").map((w) => `"${w.name}"`).join(", ")}` : `❌ Not a host on ${closing.length ? closing.map((w) => `"${w.name}"`).join(" or ") : "any closing calendar the engine watches"}: add them in the booking tool so their calls book to them.`);
    } else {
      const inbound = watched.filter((w) => w.term !== "closing");
      if (inbound.length) L.push(theirs.length ? `✅ Hosts ${theirs.map((w) => `"${w.name}"`).join(", ")} (inbound calls)` : `ℹ️ Only if they take inbound calls: add them as a host on ${inbound.map((w) => `"${w.name}"`).join(" or ")}.`);
    }
  } catch { L.push("❔ Couldn't read the calendars just now: check their calendar access yourself."); }

  if (ask.role === "setter") {
    const link = await one<{ booking_url: string | null }>(c, "select booking_url from calendars where company_id=$1 and active and config->>'booking'='utm' and booking_url is not null order by name limit 1", [a.companyId]);
    const tag = `utm_medium=setter&utm_content=${encodeURIComponent(first)}`;
    L.push("", link?.booking_url ? `Their setter link: ${link.booking_url}${link.booking_url.includes("?") ? "&" : "?"}${tag}` : `Their setter link: the booking link with ?${tag}`);
  }
  for (const n of r.notes.filter((n) => /closer's Sales Calls/.test(n))) L.push(`ℹ️ ${n}`);
  const open = L.filter((l) => /^(❌|⏳|❔)/.test(l)).length;
  L.push("", open ? `${open} left. Run \`/team add ${ask.email} ${ask.role}\` again after each fix.` : "All set.");
  return L.join("\n");
}
