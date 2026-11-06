import { commasPing } from "@/adapters/commas/client";

/**
 * D319: the keys a person can add from the offer's Settings page. Each is tested live before it is kept; one the service
 * refuses is never saved. The page never shows a key back (only that it is set and how it ends).
 */
export const ENTERABLE_KEYS: Record<string, { label: string; test: (value: string) => Promise<{ ok: true } | { ok: false; error: string }> }> = {
  "secret.commas_api_key": { label: "Commas API key", test: commasPing },
};
