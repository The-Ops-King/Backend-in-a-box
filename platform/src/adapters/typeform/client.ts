import { VendorError } from "@/engine/failures";

/**
 * Typeform's Create API (api.typeform.com, `Authorization: Bearer <personal access token>`). D122.
 * Read from typeform.com/developers on 2026-10-16 and checked read-only against the VIP Matchmaking Application:
 * - `GET /forms/{id}`: `fields[]` with a stable `ref` per question (what answers are mapped by), `hidden[]` (names).
 * - `GET /forms/{id}/responses`: newest first, `page_size` ≤ 1000, `before=<token>` pages back; `response_type` is
 *   `completed` by default, `partial` (answered some, never submitted) and `started` (opened only) on request. Each item has
 *   `response_id` (= `token`), `submitted_at`, `hidden`, `answers[]` (`field.ref`, `type`, and the value under that type).
 * - `GET /forms/{id}/webhooks` → `{ items: [] }`; `GET /forms/{id}/webhooks/{tag}` → the webhook, or 404 with an empty body.
 * - `PUT /forms/{id}/webhooks/{tag}` `{ url, enabled, secret, event_types }` creates or replaces the webhook under that tag
 *   (docs; not run here, the form is not ours to change in a test). A `secret` makes every delivery carry
 *   `Typeform-Signature: sha256=<base64 HMAC-SHA256(secret, raw body)>`. `verify_ssl` is read-only now (https URLs only).
 */
const BASE = "https://api.typeform.com";
const headers = (token: string) => ({ Authorization: `Bearer ${token}`, Accept: "application/json", "Content-Type": "application/json" });

async function tf<T>(token: string, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(BASE + path, { method, headers: headers(token), body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
  const text = await res.text();
  if (!res.ok) throw new VendorError("typeform", res.status, path, text.slice(0, 300));
  return (text ? JSON.parse(text) : {}) as T;
}

export type TfField = { id: string; ref: string; type: string; title: string; properties?: { fields?: TfField[]; choices?: { label: string; ref?: string }[] } };
export type TfForm = { id: string; title: string; fields: TfField[]; hidden?: string[] };
export type TfAnswer = { field: { id?: string; ref: string; type?: string }; type: string } & Record<string, unknown>;
export type TfResponse = { response_id?: string; token: string; landed_at?: string; submitted_at?: string; staged_at?: string; hidden?: Record<string, string>; answers?: TfAnswer[] | null; response_type?: string };
export type TfWebhook = { id?: string; tag: string; url: string; enabled: boolean; event_types?: Record<string, boolean>; form_id?: string };

export const typeformGetForm = (token: string, formId: string) => tf<TfForm>(token, "GET", `/forms/${encodeURIComponent(formId)}`);

/** Every field of a form, groups opened (a group's own fields carry their own refs). */
export const formFields = (f: TfForm): TfField[] => f.fields.flatMap((x) => [x, ...(x.properties?.fields ? formFields({ ...f, fields: x.properties.fields }) : [])]);

/** Every response of one kind, newest first, paged back with `before` (a page holds up to 1000). */
export async function typeformResponses(token: string, formId: string, type: "completed" | "partial" | "started" = "completed", pageSize = 1000): Promise<TfResponse[]> {
  const out: TfResponse[] = [];
  let before: string | undefined;
  for (let page = 0; page < 100; page++) {
    const q = new URLSearchParams({ page_size: String(pageSize), response_type: type });
    if (before) q.set("before", before);
    const r = await tf<{ items?: TfResponse[]; total_items?: number }>(token, "GET", `/forms/${encodeURIComponent(formId)}/responses?${q}`);
    const items = r.items ?? [];
    out.push(...items);
    if (items.length < pageSize) break;
    before = items[items.length - 1].token;
  }
  return out;
}

/** The webhook under our tag as Typeform has it now: `found: false` on 404; `ok: false` when the token cannot read it (with the status). */
export async function typeformGetWebhook(token: string, formId: string, tag: string): Promise<{ ok: true; found: false } | { ok: true; found: true; hook: TfWebhook } | { ok: false; status: number | null; error: string }> {
  try { return { ok: true, found: true, hook: await tf<TfWebhook>(token, "GET", `/forms/${encodeURIComponent(formId)}/webhooks/${encodeURIComponent(tag)}`) }; }
  catch (e) {
    if (e instanceof VendorError && e.status === 404) return { ok: true, found: false };
    return { ok: false, status: e instanceof VendorError ? e.status : null, error: String((e as Error).message).slice(0, 160) };
  }
}

/** Creates the webhook under `tag`, or replaces it whole (a PUT carries everything: url, secret, on, the one event). */
export const typeformPutWebhook = (token: string, formId: string, tag: string, url: string, secret: string) =>
  tf<TfWebhook>(token, "PUT", `/forms/${encodeURIComponent(formId)}/webhooks/${encodeURIComponent(tag)}`, { url, secret, enabled: true, event_types: { form_response: true } });

export type TypeformApi = { getForm: typeof typeformGetForm; responses: typeof typeformResponses; getWebhook: typeof typeformGetWebhook; putWebhook: typeof typeformPutWebhook };
export const liveTypeform: TypeformApi = { getForm: typeformGetForm, responses: typeformResponses, getWebhook: typeformGetWebhook, putWebhook: typeformPutWebhook };
