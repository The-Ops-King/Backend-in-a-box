import { type SlackApp } from "./app";
import { identitiesOf, platformSettingsOf } from "./data";

/**
 * Who pressed or asked, on one offer: the person their Slack user is confirmed as (person_identities), their roles
 * on that offer (the people projection), and whether they are the operator (platform setting slack.operators). Roles
 * are the offer's, never another offer's.
 */
export type Presser = { teamId: string; userId: string; offerId: string | null; personId: string | null; name: string; roles: string[]; active: boolean; operator: boolean };

/** Who may do what: the platform's rules, the same on every offer (the spec's button table). */
export const MAY = {
  ask: ["closer", "setter", "manager", "owner"],
  alert: ["manager", "owner", "operator"],
  link: ["manager", "owner", "operator"],
  agreement: ["owner", "manager", "closer"],
  team: ["operator"],
} as const;
export type Rule = keyof typeof MAY | "member";

export async function isOperator(app: Pick<SlackApp, "db">, teamId: string, userId: string): Promise<boolean> {
  const ops = (await platformSettingsOf(app.db))["slack.operators"];
  return Array.isArray(ops) && ops.some((o) => o && typeof o === "object" && (o as Record<string, unknown>).team_id === teamId && (o as Record<string, unknown>).user_id === userId);
}

export async function presserOf(app: Pick<SlackApp, "db" | "engine">, offerId: string | null, teamId: string, userId: string): Promise<Presser> {
  const operator = await isOperator(app, teamId, userId);
  const base: Presser = { teamId, userId, offerId, personId: null, name: `<@${userId}>`, roles: [], active: false, operator };
  if (!offerId) return base;
  const id = (await identitiesOf(app.db, teamId, userId)).find((i) => i.offerId === offerId);
  if (!id) return base;
  const person = await app.engine.store.tx((tx) => tx.projGet("people", offerId, id.personId));
  return { ...base, personId: id.personId, name: person?.name ?? base.name, roles: person?.active ? person.roles : [], active: !!person?.active };
}

/** Whether the person may: "member" is anyone on the offer's team (any role), or the operator. */
export function may(p: Presser, rule: Rule): boolean {
  if (rule === "member") return p.operator || (p.active && p.personId !== null);
  const allowed = MAY[rule] as readonly string[];
  return (p.operator && allowed.includes("operator")) || p.roles.some((r) => allowed.includes(r));
}

const words: Record<Rule, string> = {
  ask: "a closer, setter, manager or owner", alert: "a manager, an owner or the operator", link: "a manager, an owner or the operator",
  agreement: "an owner, a manager or the closer on that deal", team: "the operator", member: "someone on this offer's team",
};
export const refusal = (rule: Rule) => `Only ${words[rule]} can do that.`;
