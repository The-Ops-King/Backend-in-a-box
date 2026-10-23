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
  async deleteNote(c, contactId, noteId) { await ghl(c.pit, "DELETE", `/contacts/${contactId}/notes/${noteId}`); },
  // never `tags` on this PUT: GHL's spec says tags there replace every tag the contact has (addTag / removeTag change one)
  async updateContact(c, contactId, patch) {
    const body: Record<string, unknown> = {};
    if (patch.firstName) body.firstName = patch.firstName; if (patch.lastName) body.lastName = patch.lastName;
    if (patch.email) body.email = patch.email; if (patch.phone) body.phone = patch.phone; if (patch.timezone) body.timezone = patch.timezone; if (patch.assignedUserId) body.assignedTo = patch.assignedUserId;
    if (patch.customFields?.length) body.customFields = patch.customFields;
    if (Object.keys(body).length) await ghl(c.pit, "PUT", `/contacts/${contactId}`, { body });
  },
  async createTask(c, contactId, task) {
    const r = await ghl<{ task?: { id: string }; id?: string }>(c.pit, "POST", `/contacts/${contactId}/tasks`, { body: { title: task.title, body: task.body ?? "", dueDate: task.dueAt.toISOString(), completed: false, ...(task.assignedUserId ? { assignedTo: task.assignedUserId } : {}) } });
    return { id: r.task?.id ?? r.id ?? "" };
  },
  // Custom objects: properties use the SHORT key (not the custom_objects.x.y fieldKey); owners is an array on create and { add: [...] } on update (verified in the Zap this replaces)
  /** UNVERIFIED body (the send scope was not on the token when written, 2026-10-07): POST /proposals/templates/send { locationId, templateId, contactId, userId, medium }. Fix here if GHL wants another shape. */
  async sendDocumentTemplate(c, input) {
    const r = await ghl<{ _id?: string; id?: string; document?: { _id?: string; id?: string } }>(c.pit, "POST", "/proposals/templates/send", { body: { locationId: c.locationId, templateId: input.templateId, contactId: input.contactId, ...(input.userId ? { userId: input.userId } : {}), medium: "email" } });
    return { id: r.document?._id ?? r.document?.id ?? r._id ?? r.id ?? "" };
  },
  async createRecord(c, objectKey, properties, ownerUserId) {
    const r = await ghl<{ record?: { id: string }; id?: string }>(c.pit, "POST", `/objects/${objectKey}/records`, { body: { locationId: c.locationId, properties, ...(ownerUserId ? { owners: [ownerUserId] } : {}) } });
    return { id: r.record?.id ?? r.id ?? "" };
  },
  async updateRecord(c, objectKey, recordId, properties, ownerUserId, removeOwnerIds) {
    const owners = { ...(ownerUserId ? { add: [ownerUserId] } : {}), ...(removeOwnerIds?.length ? { remove: removeOwnerIds } : {}) };
    await ghl(c.pit, "PUT", `/objects/${objectKey}/records/${recordId}?locationId=${c.locationId}`, { body: { properties, ...(Object.keys(owners).length ? { owners } : {}) } });
  },
  async deleteContact(c, contactId) { await ghl(c.pit, "DELETE", `/contacts/${contactId}`); },
  async deleteOpportunity(c, opportunityId) { await ghl(c.pit, "DELETE", `/opportunities/${opportunityId}`); },
  async deleteTask(c, contactId, taskId) { await ghl(c.pit, "DELETE", `/contacts/${contactId}/tasks/${taskId}`); },
  async deleteRecord(c, objectKey, recordId) {
    await ghl(c.pit, "DELETE", `/objects/${objectKey}/records/${recordId}`);   // GHL refuses locationId here (422), though its PUT needs it
  },
  async relateRecords(c, associationId, firstRecordId, secondRecordId) {
    try { await ghl(c.pit, "POST", "/associations/relations", { body: { locationId: c.locationId, associationId, firstRecordId, secondRecordId } }); }
    catch (e) { const st = (e as { status?: number }).status; if (st !== 400 && st !== 409) throw e; }   // already related
  },
  async createOpportunity(c, input) {
    const r = await ghl<{ opportunity: { id: string } }>(c.pit, "POST", "/opportunities/", { body: {
      locationId: c.locationId, contactId: input.contactId, pipelineId: input.pipelineId, pipelineStageId: input.stageId, name: input.name, status: input.status,
      ...(input.assignedUserId ? { assignedTo: input.assignedUserId } : {}), ...(input.customFields?.length ? { customFields: input.customFields } : {}), ...(input.monetaryValue !== undefined ? { monetaryValue: input.monetaryValue } : {}),
    } });
    return { id: r.opportunity.id };
  },
  async updateOpportunity(c, id, patch) {
    const body: Record<string, unknown> = {};
    if (patch.pipelineId) body.pipelineId = patch.pipelineId; if (patch.stageId) body.pipelineStageId = patch.stageId;
    if (patch.name) body.name = patch.name; if (patch.status) body.status = patch.status; if (patch.assignedUserId) body.assignedTo = patch.assignedUserId;
    if (patch.customFields?.length) body.customFields = patch.customFields;
    if (patch.monetaryValue !== undefined) body.monetaryValue = patch.monetaryValue;
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
