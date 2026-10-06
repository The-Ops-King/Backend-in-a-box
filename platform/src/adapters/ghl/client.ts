const BASE = "https://services.leadconnectorhq.com";

export class GhlError extends Error {
  constructor(public status: number, public body: string, public path: string) { super(`GHL ${status} on ${path}: ${body.slice(0, 300)}`); this.name = "GhlError"; }
}

/** Version header differs by endpoint family (verified in ghl/02-api-facts.md). */
export type GhlVersion = "2021-07-28" | "2021-04-15";

export async function ghl<T = unknown>(pit: string, method: string, path: string, opts: { version?: GhlVersion; body?: unknown; retries?: number } = {}): Promise<T> {
  const version = opts.version ?? "2021-07-28";
  const retries = opts.retries ?? 2;
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(BASE + path, {
      method,
      headers: { Authorization: `Bearer ${pit}`, Version: version, Accept: "application/json", ...(opts.body ? { "Content-Type": "application/json" } : {}) },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    if (res.status === 429 && attempt < retries) { await new Promise((r) => setTimeout(r, 1500 * (attempt + 1))); continue; }
    const text = await res.text();
    if (!res.ok) throw new GhlError(res.status, text, path);
    return (text ? JSON.parse(text) : {}) as T;
  }
}
