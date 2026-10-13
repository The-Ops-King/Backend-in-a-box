import { createHash, timingSafeEqual } from "node:crypto";

type Env = Record<string, string | undefined>;
const digest = (s: string) => createHash("sha256").update(s).digest();
/** Constant-time: both sides hashed to 32 bytes first, so neither the content nor the length of the key leaks through timing. */
const sameSecret = (a: string, b: string) => timingSafeEqual(digest(a), digest(b));

/**
 * D98: the operator key is `CRON_SECRET`; while it is being changed, `CRON_SECRET_PREVIOUS` (when set) is accepted too, so the
 * database scheduler, which still sends the old key until it is reinstalled, never misses a minute. Every key is compared.
 */
export function bearerMatches(req: Request, env: Env = process.env): boolean {
  const sent = req.headers.get("authorization") ?? "";
  let ok = false;
  for (const k of [env.CRON_SECRET, env.CRON_SECRET_PREVIOUS]) if (k) ok = sameSecret(sent, `Bearer ${k}`) || ok;
  return ok;
}

/** The admin routes: refused outright when no operator key is configured. */
export function operatorAuthorized(req: Request, env: Env = process.env): boolean {
  return !!env.CRON_SECRET && bearerMatches(req, env);
}

/** The tick: open when no operator key is configured (local development), as it always was. */
export function tickAuthorized(req: Request, env: Env = process.env): boolean {
  return !env.CRON_SECRET || bearerMatches(req, env);
}
