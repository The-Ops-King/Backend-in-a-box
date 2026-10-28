/**
 * D197: one offer's team, changed in one call (Tyler: "I want to be able to add and remove setters and closers very quickly").
 * A person is someone on the offer's GHL roster (a GHL user of the location); adding them as a setter or closer gives them that
 * role, so their calls, end-of-day reminder and form, and their setter link (`utm_content=<their first name>`) work as the rest of
 * the team's; their Slack account is linked by its email (or a Slack id) so the reminders reach them. Removing them takes the role
 * off (staff: on the roster, takes no calls); nothing they did is touched. Audited.
 */
import type { PoolClient } from "pg";
import { many, one } from "@/db/client";
import type { Adapters, Company } from "@/adapters/types";

export type TeamRole = "setter" | "closer";
export type TeamChange = { email: string; role?: TeamRole; remove?: boolean; slack?: string; by?: string };
export type TeamResult =
  | { ok: true; person: { name: string; email: string; role: string; slack_user_id: string | null }; was: { role: string | null; slack_user_id: string | null }; synced: boolean; notes: string[] }
  | { ok: false; status: number; why: string };

/** The team as the engine holds it: everyone with a role that takes calls, and anyone the roster has. */
export const teamOf = (c: PoolClient, companyId: string) =>
  many<{ name: string; email: string; role: string; active: boolean; slack_user_id: string | null }>(c, "select name, email, role, active, slack_user_id from users where company_id=$1 and role<>'operator' order by (role in ('closer','setter')) desc, role, name", [companyId]);

export async function changeTeam(c: PoolClient, args: { companyId: string; ac: Company; adapters: Adapters; slackToken: string | null; change: TeamChange }): Promise<TeamResult> {
  const { companyId, ac, adapters, change } = args;
  const email = change.email?.trim().toLowerCase();
  if (!email || !email.includes("@")) return { ok: false, status: 400, why: "email: the person's email as a GHL user of the location" };
  if (!change.remove && change.role !== "setter" && change.role !== "closer") return { ok: false, status: 400, why: 'role: "setter" or "closer" (or remove: true)' };
  const find = () => one<{ id: string; name: string; email: string; role: string; slack_user_id: string | null }>(c, "select id, name, email, role, slack_user_id from users where company_id=$1 and lower(email)=$2", [companyId, email]);
  let person = await find(), synced = false;
  // someone just added in GHL: the roster is read again (as install reads it), so they need no re-install. D247: a GHL user whose
  // email changed in GHL (Mel Reynolds: ops@thebeautybosses.com → mel@thebeautymoguls.com) takes the new one, unless another member has it
  if (!person && !change.remove) {
    for (const u of await adapters.read.listUsers(ac)) {
      // an address another member already has is not taken (two GHL users, one email): that one stays as it is
      if (u.email && await one(c, "select 1 from users where company_id=$1 and lower(email)=lower($2) and ghl_user_id is distinct from $3", [companyId, u.email, u.id])) continue;
      await c.query(`insert into users (company_id, email, name, role, ghl_user_id) values ($1,$2,$3,'staff',$4) on conflict (company_id, ghl_user_id) do update set name=excluded.name,
        email=case when excluded.email like '%@unclaimed.local' then users.email else excluded.email end
        where not exists (select 1 from users o where o.company_id=excluded.company_id and lower(o.email)=lower(excluded.email) and o.ghl_user_id is distinct from excluded.ghl_user_id)`, [companyId, u.email ?? `${u.id}@unclaimed.local`, u.name || u.id, u.id]);
    }
    synced = true; person = await find();
  }
  if (!person) return { ok: false, status: 404, why: change.remove ? `no one on the team is ${email}` : `${email} is not a GHL user of this location: add them in GHL first` };
  if (person.role === "operator" || person.role === "owner" || person.role === "manager") return { ok: false, status: 409, why: `${person.name} is ${person.role}: changed by hand, not here` };
  const was = { role: person.role, slack_user_id: person.slack_user_id };
  const notes: string[] = [];
  const role = change.remove ? "staff" : change.role!;
  let slackId = person.slack_user_id;
  if (change.slack?.trim() && !change.remove) {
    const want = change.slack.trim();
    if (/^[UW][A-Z0-9]{4,}$/.test(want)) slackId = want;
    else if (!args.slackToken) return { ok: false, status: 409, why: "slack: this offer has no Slack connected to look the email up in" };
    else { const id = await adapters.notifier.lookupUserByEmail(args.slackToken, want); if (!id) return { ok: false, status: 404, why: `no one in the Slack workspace has the email ${want}` }; slackId = id; }
  } else if (!change.remove && !slackId && args.slackToken) {
    const id = await adapters.notifier.lookupUserByEmail(args.slackToken, email).catch(() => null);
    if (id) slackId = id; else notes.push(`no Slack account has ${email}: give their Slack email (slack) so their reminders reach them`);
  }
  await c.query("update users set role=$2, slack_user_id=$3, active=true where id=$1", [person.id, role, slackId]);
  if (role === "closer") notes.push("a closer's Sales Calls name them by the Sales Call Closer field's option: add theirs in GHL if the field has none for them (salesCall.closerOptions)");
  if (role === "setter") notes.push(`their setter link: the booking link with ?utm_medium=setter&utm_content=${encodeURIComponent(person.name.split(/\s+/)[0].toLowerCase())}`);
  await c.query("insert into audit_log (company_id, action, target_type, target_id, before, after) values ($1,'team.changed','user',$2,$3,$4)", [companyId, person.id, was, { role, slack_user_id: slackId, by: change.by ?? "operator" }]);
  return { ok: true, person: { name: person.name, email: person.email, role, slack_user_id: slackId }, was, synced, notes };
}
