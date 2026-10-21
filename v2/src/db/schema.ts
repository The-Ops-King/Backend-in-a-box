import { bigserial, boolean, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

/**
 * Every inbound delivery, exactly as it arrived, before anything reads it. A vendor's retry of the same delivery is the same
 * row (source + delivery_id), so nothing downstream ever sees it twice.
 */
export const inbox = pgTable("inbox", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  source: text("source").notNull(),                       // the door it came through: "ghl", later "whop", "slack", ...
  deliveryId: text("delivery_id").notNull(),              // the vendor's own id for the delivery, else a hash of the body
  eventType: text("event_type"),                          // the vendor's name for it, as sent ("ContactCreate")
  locationId: text("location_id"),                        // GHL: the sub-account it is about
  headers: jsonb("headers").notNull(),
  body: text("body").notNull(),                           // raw, byte for byte, so the signature can be checked again
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex("inbox_source_delivery").on(t.source, t.deliveryId)]);

/** A GHL sub-account the app is installed on, with its tokens encrypted. One row per location. */
export const ghlConnections = pgTable("ghl_connections", {
  id: uuid("id").primaryKey().defaultRandom(),
  locationId: text("location_id").notNull().unique(),
  companyId: text("company_id"),
  installedBy: text("installed_by"),
  accessTokenEnc: text("access_token_enc").notNull(),
  refreshTokenEnc: text("refresh_token_enc").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  scopes: text("scopes").notNull(),
  status: text("status").notNull().default("connected"),  // connected | needs_reinstall | uninstalled
  installedAt: timestamp("installed_at", { withTimezone: true }).notNull().defaultNow(),
  needsReview: boolean("needs_review").notNull().default(true),   // no offer yet: Tyler links it; a location never becomes an offer by itself
});
