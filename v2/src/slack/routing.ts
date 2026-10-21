import type { SlackApp } from "./app";
import { channel, identitiesOf, offersOfTeam } from "./data";
import { isOperator } from "./people";

/**
 * Which offer a Slack request is about. Never from free text the model wrote, and never another workspace's offer:
 * - an event in a channel: the channel's offer (slack_channels);
 * - a DM: the person's offers in this workspace; asked which when there are several;
 * - a button or a modal: the offer in its signed value or metadata (interactions.ts);
 * - a slash command: the channel's offer; else an offer named first in its text (`/mtd pmu`), one the person is on;
 *   else the person's only offer; else a picker.
 */
export type Offer = { id: string; slug: string; name: string; zone: string };
export type Routed = { offer: Offer; text: string } | { pick: Offer[]; text: string } | { none: string };

export async function offerOfChannel(app: Pick<SlackApp, "db">, teamId: string, channelId: string): Promise<Offer | undefined> {
  const ch = await channel(app.db, teamId, channelId);
  if (!ch || ch.archivedAt) return undefined;
  return (await offersOfTeam(app.db, teamId)).find((o) => o.id === ch.offerId);
}

/** The offers a person may be answered about in this workspace: the ones they are on, or every linked one for the operator. */
export async function offersOfPerson(app: Pick<SlackApp, "db">, teamId: string, userId: string): Promise<Offer[]> {
  const linked = await offersOfTeam(app.db, teamId);
  if (await isOperator(app, teamId, userId)) return linked;
  const mine = new Set((await identitiesOf(app.db, teamId, userId)).map((i) => i.offerId));
  return linked.filter((o) => mine.has(o.id));
}

export async function routeDm(app: Pick<SlackApp, "db">, teamId: string, userId: string, text: string): Promise<Routed> {
  const offers = await offersOfPerson(app, teamId, userId);
  if (!offers.length) return { none: "I don't know you on any offer in this workspace yet. Ask Tyler to add you to the team." };
  if (offers.length === 1) return { offer: offers[0]!, text };
  return { pick: offers, text };
}

export async function routeCommand(app: Pick<SlackApp, "db">, x: { teamId: string; channelId: string; userId: string; text: string }): Promise<Routed> {
  const inChannel = await offerOfChannel(app, x.teamId, x.channelId);
  if (inChannel) return { offer: inChannel, text: x.text.trim() };
  const offers = await offersOfPerson(app, x.teamId, x.userId);
  const [first, ...rest] = x.text.trim().split(/\s+/);
  const named = first ? (await offersOfTeam(app.db, x.teamId)).find((o) => o.slug.toLowerCase() === first.toLowerCase()) : undefined;
  if (named) {
    if (!offers.some((o) => o.id === named.id)) return { none: `You're not on ${named.name}'s team in this workspace.` };
    return { offer: named, text: rest.join(" ") };
  }
  if (!offers.length) return { none: "I don't know you on any offer in this workspace yet. Ask Tyler to add you to the team." };
  if (offers.length === 1) return { offer: offers[0]!, text: x.text.trim() };
  return { pick: offers, text: x.text.trim() };
}
