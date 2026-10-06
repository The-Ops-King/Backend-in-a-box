import { ghl } from "./client";
import type { CrmWrite } from "../types";

export const ghlWrite: CrmWrite = {
  async createContact(c, input) {
    const r = await ghl<{ contact: { id: string } }>(c.pit, "POST", "/contacts/", { body: { locationId: c.locationId, ...input } });
    return { id: r.contact.id };
  },
  async addTag(c, contactId, tag) { await ghl(c.pit, "POST", `/contacts/${contactId}/tags`, { body: { tags: [tag] } }); },
  async removeTag(c, contactId, tag) { await ghl(c.pit, "DELETE", `/contacts/${contactId}/tags`, { body: { tags: [tag] } }); },
  async addNote(c, contactId, body) { await ghl(c.pit, "POST", `/contacts/${contactId}/notes`, { body: { body } }); },
  async updateContact(c, contactId, patch) {
    const body: Record<string, unknown> = {};
    if (patch.firstName) body.firstName = patch.firstName; if (patch.lastName) body.lastName = patch.lastName;
    if (patch.phone) body.phone = patch.phone; if (patch.timezone) body.timezone = patch.timezone; if (patch.assignedUserId) body.assignedTo = patch.assignedUserId;
    if (patch.customFields?.length) body.customFields = patch.customFields;
    if (Object.keys(body).length) await ghl(c.pit, "PUT", `/contacts/${contactId}`, { body });
  },
  async createOpportunity(c, input) {
    const r = await ghl<{ opportunity: { id: string } }>(c.pit, "POST", "/opportunities/", { body: {
      locationId: c.locationId, contactId: input.contactId, pipelineId: input.pipelineId, pipelineStageId: input.stageId, name: input.name, status: input.status,
      ...(input.assignedUserId ? { assignedTo: input.assignedUserId } : {}), ...(input.customFields?.length ? { customFields: input.customFields } : {}),
    } });
    return { id: r.opportunity.id };
  },
  async updateOpportunity(c, id, patch) {
    const body: Record<string, unknown> = {};
    if (patch.pipelineId) body.pipelineId = patch.pipelineId; if (patch.stageId) body.pipelineStageId = patch.stageId;
    if (patch.name) body.name = patch.name; if (patch.status) body.status = patch.status; if (patch.assignedUserId) body.assignedTo = patch.assignedUserId;
    if (patch.customFields?.length) body.customFields = patch.customFields;
    await ghl(c.pit, "PUT", `/opportunities/${id}`, { body });
  },
  /**
   * READ THEN WRITE, ALWAYS. A PUT that omits appointmentStatus silently resets it to "confirmed"
   * (verified, ghl/02-api-facts.md). So we fetch the current record and re-send every field.
   */
  async updateAppointment(c, id, patch) {
    const cur = await ghl<{ appointment?: Record<string, unknown>; event?: Record<string, unknown> }>(c.pit, "GET", `/calendars/events/appointments/${id}`, { version: "2021-04-15" });
    const a = (cur.appointment ?? cur.event ?? {}) as Record<string, unknown>;
    const body = {
      calendarId: a.calendarId, startTime: patch.startTime ?? a.startTime, endTime: patch.endTime ?? a.endTime,
      title: patch.title ?? a.title, assignedUserId: patch.assignedUserId ?? a.assignedUserId,
      appointmentStatus: patch.status ?? a.appointmentStatus, ignoreFreeSlotValidation: true,
    };
    await ghl(c.pit, "PUT", `/calendars/events/appointments/${id}`, { version: "2021-04-15", body });
  },
};
