import { ghl } from "./client";
import type { Sender } from "../types";

/** POST /conversations/messages with contactId — GHL creates the thread. Verified 2026-10-05. */
export const ghlSender: Sender = {
  async sendSms(c, contactId, body) {
    try {
      const r = await ghl<{ messageId: string; conversationId: string }>(c.pit, "POST", "/conversations/messages", { version: "2021-04-15", body: { type: "SMS", contactId, message: body } });
      return { externalId: r.messageId, accepted: true };
    } catch (e) { return { externalId: "", accepted: false, error: String((e as Error).message) }; }
  },
  async sendEmail(c, contactId, subject, html) {
    try {
      const r = await ghl<{ messageId: string; emailMessageId?: string }>(c.pit, "POST", "/conversations/messages", { version: "2021-04-15", body: { type: "Email", contactId, subject, html } });
      return { externalId: r.emailMessageId ?? r.messageId, accepted: true };
    } catch (e) { return { externalId: "", accepted: false, error: String((e as Error).message) }; }
  },
  async deliveryStatus(c, externalId) {
    const r = await ghl<{ message: { status?: string; error?: string } }>(c.pit, "GET", `/conversations/messages/${externalId}`, { version: "2021-04-15" });
    return { status: r.message?.status ?? "unknown", error: r.message?.error };
  },
};
