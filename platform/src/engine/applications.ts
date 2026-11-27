import type { PoolClient } from "pg";
import { one } from "@/db/client";
import { formFields, type TfField, type TfResponse, type TypeformApi } from "@/adapters/typeform/client";
import { dispatchEvent, emitEvent } from "./dispatch";
import { contactByEmail, normPhone } from "./identity";
import { personOf } from "./application-tags";
import { answerText } from "./typeform";

/**
 * D368: an application, finished or left partway, recorded once it is ten minutes old (Tyler, 2026-11-27, for Jay: "read the type
 * form, wait for 10 minutes, check if there is a call booked, if there's no call booked, post to that channel"; a partial is "come in
 * as a lead and not booked"). Typeform tells nobody about a half-finished form, so the ten-minute applications pass (D330) is the
 * only place that sees both kinds. For each response of `typeform.application_forms` it sees, once it is ten minutes past its
 * submission (or, half-finished, its start) and no older than two hours, it records `application.received` about the person, with
 * every answer as the form asked it, and starts the workflows on it. One response is recorded once (`webhook_deliveries`,
 * provider typeform_application). A person the engine does not have yet (GHL made them a moment ago; the poll brings them within a
 * minute) is left for the next pass; after two hours the response is let go. Nothing is written to GHL.
 */
export const APPLICATION_RECEIVED = "application.received";
export const SETTLE_MS = 10 * 60e3, KEEP_MS = 2 * 3600e3;
const SEEN = "typeform_application";

type Status = "complete" | "partial";
export type Answer = { question: string; answer: string };
const CONTACT_TYPES = new Set(["email", "phone_number", "calendly", "contact_info"]);
const NAME_TITLE = /^\s*(first|last|full)?\s*name\s*$/i;

/** The answers a person gave, as the form asked them, in its order; their name, email, phone and the booking step are not answers. */
export function answersOf(r: TfResponse, fields: TfField[]): Answer[] {
  const byId = new Map(fields.map((f) => [f.id, f])), byRef = new Map(fields.map((f) => [f.ref, f]));
  const order = new Map(fields.map((f, i) => [f.id, i]));
  const out: (Answer & { i: number })[] = [];
  for (const a of r.answers ?? []) {
    const f = (a.field?.id ? byId.get(a.field.id) : undefined) ?? byRef.get(a.field?.ref);
    if (!f || CONTACT_TYPES.has(a.type) || CONTACT_TYPES.has(f.type) || NAME_TITLE.test(f.title)) continue;
    const v = answerText(a); if (v === undefined) continue;
    out.push({ question: f.title.replace(/\s+/g, " ").trim(), answer: v, i: order.get(f.id) ?? 999 });
  }
  return out.sort((x, y) => x.i - y.i).map(({ question, answer }) => ({ question, answer }));
}

/** `*Question:* answer`, one per line, for a Slack post. */
export const answersText = (xs: Answer[]) => xs.map((x) => `*${x.question.replace(/[*_]/g, "")}:* ${x.answer}`).join("\n");

/** The engine's person for a response: by email, else by phone; null when the engine does not have them (yet). */
async function personFor(c: PoolClient, companyId: string, r: TfResponse): Promise<{ id: string; ghl: string | null; tags: string[] } | null> {
  const p = personOf(r);
  let id = p.email ? await contactByEmail(c, companyId, p.email) : null;
  const phone = normPhone(p.phone);
  if (!id && phone) id = (await one<{ id: string }>(c, "select i.contact_id as id from contact_identifiers i join contacts ct on ct.id=i.contact_id where i.company_id=$1 and i.kind='phone' and i.value=$2 and i.retired_at is null and ct.merged_into is null limit 1", [companyId, phone]))?.id ?? null;
  if (!id) return null;
  const row = await one<{ ghl: string | null; tags: string[] | null; gone: boolean }>(c, "select ghl_contact_id as ghl, tags, gone_at is not null as gone from contacts where id=$1", [id]);
  return row && !row.gone ? { id, ghl: row.ghl, tags: row.tags ?? [] } : null;
}

export type Recorded = { recorded: number; waiting: number; notYet: number };

export async function recordApplications(c: PoolClient, d: { companyId: string; token: string; tf: TypeformApi; formTags: Record<string, string>; now?: Date },
  responses: { r: TfResponse; status: Status; form: string }[]): Promise<Recorded> {
  const now = (d.now ?? new Date()).getTime(), out: Recorded = { recorded: 0, waiting: 0, notYet: 0 };
  const fieldsOf = new Map<string, TfField[]>();
  for (const { r, status, form } of responses) {
    const at = Date.parse(r.submitted_at ?? r.landed_at ?? "");
    if (!Number.isFinite(at) || now - at > KEEP_MS) continue;
    if (now - at < SETTLE_MS) { out.waiting++; continue; }
    const p = personOf(r);
    if (!p.email && !p.phone) continue;
    const responseId = r.response_id ?? r.token, key = `${form}:${responseId}`;
    if (await one(c, "select 1 from webhook_deliveries where company_id=$1 and provider=$2 and delivery_id=$3", [d.companyId, SEEN, key])) continue;
    const person = await personFor(c, d.companyId, r);
    if (!person) { out.notYet++; continue; }
    if (!fieldsOf.has(form)) fieldsOf.set(form, formFields(await d.tf.getForm(d.token, form)));
    const answers = answersOf(r, fieldsOf.get(form)!);
    if (!(await one(c, "insert into webhook_deliveries (company_id, provider, delivery_id) values ($1,$2,$3) on conflict do nothing returning delivery_id", [d.companyId, SEEN, key]))) continue;
    const hidden = (r.hidden ?? {}) as Record<string, string>;
    const utm = Object.fromEntries(["source", "medium", "campaign", "term", "content"].map((k) => [k, hidden[`utm_${k}`]?.trim() || null]));
    const data = { form_id: form, form_name: d.formTags[form] ?? null, response_id: responseId, status, finished: status === "complete",
      landed_at: r.landed_at ?? null, submitted_at: r.submitted_at ?? null, name: p.name ?? null, email: p.email ?? null, phone: p.phone ?? null,
      answers, answers_text: answersText(answers) || null, utm };
    const ev = await emitEvent(c, { company_id: d.companyId, contact_id: person.id, opportunity_id: null, appointment_id: null, event_type: APPLICATION_RECEIVED, source: "form", occurred_at: new Date(at), data });
    await dispatchEvent(c, ev, { contact: { id: person.id, ghl_contact_id: person.ghl, tags: person.tags }, form: { id: form, name: d.formTags[form] ?? null, response_id: responseId } });
    out.recorded++;
  }
  return out;
}
