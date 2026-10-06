const BASE = "https://api.calendly.com";

export class CalendlyError extends Error {
  constructor(public status: number, public body: string, public path: string) { super(`Calendly ${status} on ${path}: ${body.slice(0, 300)}`); this.name = "CalendlyError"; }
}

/** Personal access token or OAuth token; read scopes are enough for polling. 500 requests/minute per token (verified). */
export async function calendly<T = unknown>(token: string, path: string, opts: { retries?: number } = {}): Promise<T> {
  const retries = opts.retries ?? 2;
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(path.startsWith("http") ? path : BASE + path, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
    if (res.status === 429 && attempt < retries) { await new Promise((r) => setTimeout(r, 2000 * (attempt + 1))); continue; }
    const text = await res.text();
    if (!res.ok) throw new CalendlyError(res.status, text, path);
    return (text ? JSON.parse(text) : {}) as T;
  }
}

/** Walks `pagination.next_page` until exhausted. */
export async function calendlyAll<T>(token: string, path: string, cap = 1000): Promise<T[]> {
  const out: T[] = [];
  let next: string | null = path;
  while (next && out.length < cap) {
    const page: { collection: T[]; pagination?: { next_page?: string | null } } = await calendly(token, next);
    out.push(...page.collection);
    next = page.pagination?.next_page ?? null;
  }
  return out;
}

export const uuidOf = (uri: string | null | undefined) => (uri ? uri.split("/").filter(Boolean).pop() ?? "" : "");
/** An invitee URI is /scheduled_events/{event}/invitees/{invitee}; the event is the second-to-last segment. */
export const eventUuidOfInvitee = (uri: string | null | undefined) => { const parts = (uri ?? "").split("/").filter(Boolean); const i = parts.indexOf("scheduled_events"); return i >= 0 ? parts[i + 1] ?? "" : ""; };
