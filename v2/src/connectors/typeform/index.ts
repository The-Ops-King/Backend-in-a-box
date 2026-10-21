import type { Hub } from "../framework/hub";
import type { Connection, J, Normalized } from "../framework/types";

/**
 * Typeform, behind the forms port. Its webhook is signed `Typeform-Signature: sha256=<base64 HMAC-SHA256(secret, raw
 * body)>` with the secret the platform set on the form's webhook; the body is { event_id, event_type: form_response,
 * form_response: { form_id, token, submitted_at, hidden, answers[], definition } } (v1's typeform.ts, from Typeform's docs).
 *
 * | Typeform delivery | Canonical fact |
 * | --- | --- |
 * | form_response | form.submitted |
 *
 * Answers are read by the question's `ref`, never its words, through the connection's form map (config, data):
 * `forms: { <form id>: { name?, answers: { <ref>: <canonical field> }, hidden?: { <name>: <canonical field> } } }`, where a
 * canonical field is first_name, last_name, email, phone, or any canonical contact field the CRM's field map knows.
 * What becomes of the person (finding them in the CRM, tagging, a lead) is the offer's workflow on form.submitted.
 */

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const STANDARD = ["first_name", "last_name", "name", "email", "phone"];

/** One answer as words: a choice is its label (or what was typed under Other), several are joined, yes/no is Yes / No. */
export function answerText(a: J): string | undefined {
  const type = String(a.type ?? "");
  switch (type) {
    case "number": return typeof a.number === "number" ? String(a.number) : undefined;
    case "boolean": return a.boolean === true ? "Yes" : a.boolean === false ? "No" : undefined;
    case "choice": { const ch = (a.choice ?? {}) as J; return str(ch.label) ?? str(ch.other); }
    case "choices": { const ch = (a.choices ?? {}) as J; const xs = [...((ch.labels as unknown[]) ?? []), ch.other].map(str).filter((x): x is string => !!x); return xs.length ? xs.join(", ") : undefined; }
    default: { const v = a[type]; return typeof v === "number" ? String(v) : str(v); }
  }
}

export async function normalizeTypeform(hub: Hub, conn: Connection, body: J): Promise<Normalized> {
  if (body.event_type !== "form_response") return { facts: [], outcome: `ignored ${String(body.event_type ?? "an event")}` };
  const r = (body.form_response ?? {}) as J;
  const formId = str(r.form_id);
  const forms = (conn.config.forms ?? {}) as Record<string, { name?: string; answers?: Record<string, string>; hidden?: Record<string, string> }>;
  const form = formId ? forms[formId] : undefined;
  if (!formId || !form) return { facts: [], outcome: `form ${formId ?? "?"} is not mapped on this connection` };
  const responseId = str(r.token) ?? str(r.response_id);
  if (!responseId) return { facts: [], outcome: "a response without a token" };
  const contact: J = {}, fields: J = {};
  const put = (target: string, v: string) => { if (STANDARD.includes(target)) contact[target] = target === "email" ? v.toLowerCase() : v; else fields[target] = v; };
  for (const a of (Array.isArray(r.answers) ? r.answers : []) as J[]) {
    const target = form.answers?.[String((a.field as J | undefined)?.ref ?? "")];
    const v = target ? answerText(a) : undefined;
    if (target && v !== undefined) put(target, v);
  }
  const hidden = (r.hidden ?? {}) as J;
  for (const [name, target] of Object.entries(form.hidden ?? {})) { const v = str(hidden[name]); if (v) put(target, v); }
  const submitted = str(r.submitted_at);
  const at = submitted && !Number.isNaN(Date.parse(submitted)) ? new Date(submitted) : hub.now();
  const hit = await hub.matchContact(conn.offerId, { email: (contact.email as string | undefined) ?? null, phone: (contact.phone as string | undefined) ?? null });
  return {
    outcome: "facts",
    facts: [{
      offerId: conn.offerId, type: "form.submitted", occurredAt: at, source: "typeform", dedupeKey: `typeform:${formId}:${responseId}`, contactId: hit?.id ?? null,
      payload: { form_id: formId, form_name: form.name ?? str((r.definition as J | undefined)?.title) ?? null, response_id: responseId, submitted_at: at.toISOString(), contact, fields, matched: hit?.by ?? null },
    }],
  };
}
