/** Is the key alive? GET /v1/models costs nothing and fails fast on a revoked key (D33). */
export async function anthropicPing(apiKey: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch("https://api.anthropic.com/v1/models?limit=1", { headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" } });
    return res.ok ? { ok: true } : { ok: false, error: `${res.status} ${(await res.text()).slice(0, 160)}` };
  } catch (e) { return { ok: false, error: String((e as Error).message).slice(0, 160) }; }
}
