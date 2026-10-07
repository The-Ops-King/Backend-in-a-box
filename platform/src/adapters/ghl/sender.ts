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
  async sendEmailTemplate(c, contactId, templateId) {
    try {
      const r = await ghl<{ messageId: string; emailMessageId?: string }>(c.pit, "POST", "/conversations/messages", { version: "2021-04-15", body: { type: "Email", contactId, templateId } });
      return { externalId: r.emailMessageId ?? r.messageId, accepted: true };
    } catch (e) { return { externalId: "", accepted: false, error: String((e as Error).message) }; }
  },
  async smsTemplateBody(c, templateId) {
    const r = await ghl<{ templates?: { id: string; type?: string; template?: { body?: string }; body?: string }[] }>(c.pit, "GET", `/locations/${c.locationId}/templates?originId=${c.locationId}&limit=100`);
    const t = (r.templates ?? []).find((x) => x.id === templateId);
    return t ? (t.template?.body ?? t.body ?? null) : null;
  },
  async deliveryStatus(c, externalId) {
    const r = await ghl<{ message: { status?: string; error?: string } }>(c.pit, "GET", `/conversations/messages/${externalId}`, { version: "2021-04-15" });
    return { status: r.message?.status ?? "unknown", error: r.message?.error };
  },
};
