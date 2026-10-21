import { and, eq, isNull, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "@/db/schema";

const { slackWorkspaces, slackOfferLinks, slackChannels, personIdentities, slackMessages, slackAudit, platformSettings, settings, offers } = schema;

/** The platform database, or a transaction in it: the Slack tables are read and written through Drizzle. */
export type Db = NodePgDatabase<typeof schema>;
export type Q = Pick<Db, "select" | "insert" | "update" | "delete" | "execute">;

export type Workspace = typeof slackWorkspaces.$inferSelect;
export type ChannelRow = typeof slackChannels.$inferSelect;
export type MessageRow = typeof slackMessages.$inferSelect;

/** The Slack slots an offer's channels fill (the spec's channel picker); a workflow posts to a slot's setting, never an id. */
export const SLOTS = ["bookings", "calls", "deals", "payments", "eod", "reports", "alerts", "ops", "test"] as const;

// ---- platform settings ---------------------------------------------------------------------------------------------------

export async function platformSettingsOf(db: Q): Promise<Record<string, unknown>> {
  return Object.fromEntries((await db.select().from(platformSettings)).map((r) => [r.key, r.value]));
}
export async function setPlatformSetting(db: Q, key: string, value: unknown, by: string): Promise<void> {
  await db.insert(platformSettings).values({ key, value, updatedBy: by }).onConflictDoUpdate({ target: platformSettings.key, set: { value, updatedBy: by, updatedAt: new Date() } });
}

// ---- workspaces and offers -----------------------------------------------------------------------------------------------

export async function workspace(db: Q, teamId: string): Promise<Workspace | undefined> {
  return (await db.select().from(slackWorkspaces).where(eq(slackWorkspaces.teamId, teamId)))[0];
}

/** The workspace an offer's Slack is in, with its link. */
export async function workspaceOf(db: Q, offerId: string): Promise<Workspace | undefined> {
  const r = await db.select({ w: slackWorkspaces }).from(slackOfferLinks).innerJoin(slackWorkspaces, eq(slackWorkspaces.teamId, slackOfferLinks.teamId)).where(eq(slackOfferLinks.offerId, offerId));
  return r[0]?.w;
}

export async function offersOfTeam(db: Q, teamId: string): Promise<{ id: string; slug: string; name: string; zone: string }[]> {
  return db.select({ id: offers.id, slug: offers.slug, name: offers.name, zone: offers.zone }).from(slackOfferLinks).innerJoin(offers, eq(offers.id, slackOfferLinks.offerId)).where(eq(slackOfferLinks.teamId, teamId)).orderBy(offers.slug);
}

export async function offerRow(db: Q, offerId: string) { return (await db.select().from(offers).where(eq(offers.id, offerId)))[0]; }
export async function offerSettings(db: Q, offerId: string): Promise<Record<string, unknown>> {
  return Object.fromEntries((await db.select().from(settings).where(eq(settings.offerId, offerId))).map((r) => [r.key, r.value]));
}

// ---- channels ---------------------------------------------------------------------------------------------------------------

export async function channel(db: Q, teamId: string, channelId: string): Promise<ChannelRow | undefined> {
  return (await db.select().from(slackChannels).where(and(eq(slackChannels.teamId, teamId), eq(slackChannels.channelId, channelId))))[0];
}

/**
 * Gives a channel to an offer for some slots, and sets each slot's setting (slack.channel.<slot>) to it in the same
 * transaction. A channel belongs to one offer: one that is another offer's is refused, never moved.
 */
export async function mapChannel(db: Db, x: { teamId: string; channelId: string; offerId: string; slots: string[]; name?: string; isPrivate?: boolean; botMember?: boolean; by: string; now: Date }): Promise<void> {
  for (const s of x.slots) if (!(SLOTS as readonly string[]).includes(s)) throw new Error(`${s} is not a Slack slot (${SLOTS.join(", ")})`);
  await db.transaction(async (t) => {
    const link = (await t.select().from(slackOfferLinks).where(eq(slackOfferLinks.offerId, x.offerId)))[0];
    if (!link || link.teamId !== x.teamId) throw new Error("the offer's Slack is not that workspace");
    const prior = (await t.select().from(slackChannels).where(and(eq(slackChannels.teamId, x.teamId), eq(slackChannels.channelId, x.channelId))).for("update"))[0];
    if (prior && prior.offerId !== x.offerId) throw new Error(`that channel belongs to another offer`);
    const slots = [...new Set([...(prior?.slots ?? []), ...x.slots])].sort();
    const row = { teamId: x.teamId, channelId: x.channelId, offerId: x.offerId, slots, name: x.name ?? prior?.name ?? null, isPrivate: x.isPrivate ?? prior?.isPrivate ?? false, botMember: x.botMember ?? prior?.botMember ?? false, archivedAt: null, updatedAt: x.now };
    await t.insert(slackChannels).values(row).onConflictDoUpdate({ target: [slackChannels.teamId, slackChannels.channelId], set: row });
    for (const s of x.slots) {
      const key = `slack.channel.${s}`;
      await t.insert(settings).values({ offerId: x.offerId, key, value: x.channelId, updatedBy: x.by }).onConflictDoUpdate({ target: [settings.offerId, settings.key], set: { value: x.channelId, updatedBy: x.by, updatedAt: x.now } });
    }
  });
}

export async function updateChannel(db: Q, teamId: string, channelId: string, patch: Partial<Pick<ChannelRow, "name" | "botMember" | "archivedAt">>, now: Date): Promise<ChannelRow | undefined> {
  return (await db.update(slackChannels).set({ ...patch, updatedAt: now }).where(and(eq(slackChannels.teamId, teamId), eq(slackChannels.channelId, channelId))).returning())[0];
}

// ---- people ---------------------------------------------------------------------------------------------------------------

/** A person confirmed as a Slack user (never a guessed match). */
export async function confirmIdentity(db: Q, x: { offerId: string; personId: string; teamId: string; userId: string; by: string; now: Date }): Promise<void> {
  await db.delete(personIdentities).where(and(eq(personIdentities.offerId, x.offerId), eq(personIdentities.personId, x.personId), eq(personIdentities.kind, "slack"), eq(personIdentities.teamId, x.teamId)));
  await db.insert(personIdentities).values({ offerId: x.offerId, personId: x.personId, kind: "slack", teamId: x.teamId, userId: x.userId, confirmedBy: x.by, confirmedAt: x.now })
    .onConflictDoUpdate({ target: [personIdentities.offerId, personIdentities.kind, personIdentities.teamId, personIdentities.userId], set: { personId: x.personId, confirmedBy: x.by, confirmedAt: x.now } });
}

export async function removeIdentity(db: Q, offerId: string, teamId: string, userId: string): Promise<void> {
  await db.delete(personIdentities).where(and(eq(personIdentities.offerId, offerId), eq(personIdentities.kind, "slack"), eq(personIdentities.teamId, teamId), eq(personIdentities.userId, userId)));
}

/** The offers a Slack user is a person on, in this workspace (only offers linked to it). */
export async function identitiesOf(db: Q, teamId: string, userId: string): Promise<{ offerId: string; personId: string }[]> {
  return db.select({ offerId: personIdentities.offerId, personId: personIdentities.personId }).from(personIdentities)
    .innerJoin(slackOfferLinks, and(eq(slackOfferLinks.offerId, personIdentities.offerId), eq(slackOfferLinks.teamId, teamId)))
    .where(and(eq(personIdentities.kind, "slack"), eq(personIdentities.teamId, teamId), eq(personIdentities.userId, userId)));
}

export async function slackUserOf(db: Q, offerId: string, personId: string): Promise<string | undefined> {
  return (await db.select({ u: personIdentities.userId }).from(personIdentities).where(and(eq(personIdentities.offerId, offerId), eq(personIdentities.personId, personId), eq(personIdentities.kind, "slack"))))[0]?.u;
}

// ---- messages -------------------------------------------------------------------------------------------------------------

export async function recordMessage(db: Q, m: typeof slackMessages.$inferInsert): Promise<void> {
  await db.insert(slackMessages).values(m).onConflictDoNothing();
}

export async function messageAt(db: Q, teamId: string, channelId: string, ts: string): Promise<MessageRow | undefined> {
  return (await db.select().from(slackMessages).where(and(eq(slackMessages.teamId, teamId), eq(slackMessages.channel, channelId), eq(slackMessages.ts, ts))))[0];
}

/** Claims a message for one press: true for the first, false when someone already answered it. */
export async function settleMessage(db: Q, id: number, settled: Record<string, unknown>): Promise<boolean> {
  return (await db.update(slackMessages).set({ settled }).where(and(eq(slackMessages.id, id), isNull(slackMessages.settled))).returning({ id: slackMessages.id })).length > 0;
}
export async function unsettleMessage(db: Q, id: number): Promise<void> { await db.update(slackMessages).set({ settled: null }).where(eq(slackMessages.id, id)); }

// ---- audit ----------------------------------------------------------------------------------------------------------------

export async function audit(db: Q, x: { offerId?: string | null; teamId?: string | null; userId?: string | null; action: string; detail?: Record<string, unknown>; at: Date }): Promise<void> {
  await db.insert(slackAudit).values({ offerId: x.offerId ?? null, teamId: x.teamId ?? null, userId: x.userId ?? null, action: x.action, detail: x.detail ?? {}, at: x.at });
}

export const nowSql = sql`now()`;
