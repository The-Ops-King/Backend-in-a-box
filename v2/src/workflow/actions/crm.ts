import { z } from "zod";
import { Duration } from "../duration";
import { ContentKey, Template } from "../primitives/common";
import { wholeExpr } from "../template";
import { defineAction } from "./define";

/**
 * CRM writes and reads, through the CRM port. Fields are canonical names ("lead_source", "cash_collected"); the offer's
 * field map turns each into the CRM's own field. A value that renders empty is left alone, never blanked; `clear` is
 * the one way to empty a field.
 */

const Field = z.string().regex(/^[a-z][a-z0-9_]*$/, { message: "a canonical field name is lowercase letters, digits and _" });
const Fields = z.record(Field, Template);
/**
 * Tags: a list of tags (each may be a template), or one `{{…}}` whose value is a list (a list held in a variable,
 * `"{{vars.tags_before}}"`). A list inside the list is flattened.
 */
const Tags = z.union([z.array(Template.min(1)).min(1), Template.refine((t) => !!wholeExpr(t), { message: "tags is a list, or one {{…}} whose value is a list" })]);
const atLeastOne = (o: Record<string, unknown>) => Object.values(o).some((v) => v !== undefined && !(Array.isArray(v) && v.length === 0) && !(typeof v === "object" && v !== null && !Array.isArray(v) && Object.keys(v).length === 0));

export const crmActions = [
  defineAction({
    verb: "crm.find_or_create_contact",
    summary: "Finds the run's person in the CRM (by CRM id, then email, then phone) or creates them from what is known. Gives back { id, action: found | created }.",
    effect: "crm",
    params: z.object({
      match: z.array(z.enum(["crm_id", "email", "phone"])).min(1),
      create: z.boolean(),
      /** Standard fields filled in only where the CRM has them blank, on a found or a created contact. */
      fillBlank: Fields.optional(),
    }).strict(),
    returns: "optional",
  }),
  defineAction({
    verb: "crm.update_contact",
    summary: "Writes fields on the contact. `ifEmpty` fields are written only where the CRM's value is empty right now; `clear` empties fields.",
    effect: "crm",
    params: z.object({
      set: Fields.optional(),
      ifEmpty: z.array(Field).optional(),
      clear: z.array(Field).optional(),
    }).strict().refine(atLeastOne, { message: "update_contact sets or clears something" }),
    returns: "none",
  }),
  defineAction({
    verb: "crm.add_tag",
    summary: "Puts tags on the contact.",
    effect: "crm",
    params: z.object({ tags: Tags }).strict(),
    returns: "none",
  }),
  defineAction({
    verb: "crm.remove_tag",
    summary: "Takes tags off the contact. `keep`: tags never taken off, even when `tags` names them (the tags the answer now gives).",
    effect: "crm",
    params: z.object({ tags: Tags, keep: Tags.optional() }).strict(),
    returns: "none",
  }),
  defineAction({
    verb: "crm.mark_dnd",
    summary: "Marks the contact do-not-disturb on a channel, so the delivery gate refuses later messages there.",
    effect: "crm",
    params: z.object({ channel: z.enum(["sms", "email", "all"]) }).strict(),
    returns: "none",
  }),
  defineAction({
    verb: "crm.move_deal",
    summary: "Moves the contact's deal on a pipeline to a stage (one open deal per contact per pipeline), making one when none is open unless ifMissing is skip. Gives back { id }.",
    effect: "crm",
    params: z.object({
      pipeline: Template.min(1),
      stage: Template.min(1),
      /** Move only a deal now in one of these stages; a deal anywhere else is left where it is. */
      fromStages: z.array(Template.min(1)).min(1).optional(),
      ifMissing: z.enum(["create", "skip"]),
      pick: z.enum(["open", "latest"]),
      /** The name for a deal this step makes; `keepName` leaves an existing deal's name alone. */
      name: Template.optional(),
      keepName: z.boolean().optional(),
      owner: Template.optional(),
      value: Template.optional(),
      fields: Fields.optional(),
    }).strict(),
    returns: "optional",
  }),
  defineAction({
    verb: "crm.set_deal_status",
    summary: "Marks the contact's deal on a pipeline open, won, lost or abandoned, only from the statuses in `from` when given.",
    effect: "crm",
    params: z.object({
      pipeline: Template.min(1),
      status: z.enum(["open", "won", "lost", "abandoned"]),
      from: z.array(z.enum(["open", "won", "lost", "abandoned"])).min(1).optional(),
      lostReason: Template.optional(),
    }).strict(),
    returns: "none",
  }),
  defineAction({
    verb: "crm.update_deal",
    summary: "Writes fields and the value on the contact's deal on a pipeline, without moving it.",
    effect: "crm",
    params: z.object({ pipeline: Template.min(1), value: Template.optional(), fields: Fields.optional(), clear: z.array(Field).optional() })
      .strict().refine((p) => p.value !== undefined || atLeastOne({ f: p.fields, c: p.clear }), { message: "update_deal writes something" }),
    returns: "none",
  }),
  defineAction({
    verb: "crm.create_task",
    summary: "Opens a to-do on the contact for a person, due a length of time from now. Its words are content.",
    effect: "crm",
    params: z.object({ title: ContentKey, body: ContentKey.optional(), due: Duration, assignTo: Template.optional() }).strict(),
    returns: "optional",
    content: (p) => [p.title, ...(p.body ? [p.body] : [])],
  }),
  defineAction({
    verb: "crm.add_note",
    summary: "Adds an internal note to the contact. Its words are content.",
    effect: "crm",
    params: z.object({ content: ContentKey }).strict(),
    returns: "none",
    content: (p) => [p.content],
  }),
  defineAction({
    verb: "crm.upsert_record",
    summary: "Writes a record on a CRM custom object (a payment, a sales call), found by our own key or the CRM's record id. Gives back { id }.",
    effect: "crm",
    params: z.object({
      object: Template.min(1),
      key: Template.min(1).optional(),
      recordId: Template.min(1).optional(),
      properties: z.record(Template),
      clear: z.array(z.string().min(1)).optional(),
      /** create: make it when missing; skip: only update one that exists; match: look for it in the CRM by the booking first. */
      ifMissing: z.enum(["create", "skip", "match"]),
      owner: Template.optional(),
    }).strict().refine((p) => p.key !== undefined || p.recordId !== undefined, { message: "upsert_record needs a key (ours) or a recordId (the CRM's)" }),
    returns: "optional",
  }),
  defineAction({
    verb: "crm.relate_records",
    summary: "Links two CRM records by an association (a payment to its contact).",
    effect: "crm",
    params: z.object({ association: Template.min(1), first: Template.min(1), second: Template.min(1) }).strict(),
    returns: "none",
  }),
];
