import { NextResponse, after } from "next/server";
import { liveAdapters } from "@/adapters";
import { runNow } from "@/engine/runner";

/** D202: the company's due runs, now, logged on failure (the minute tick still runs whatever this misses). */
export const runCompanyNow = (companyId: string): Promise<void> => runNow(liveAdapters, companyId).then(() => undefined).catch((e) => console.error("runNow:", e));

/**
 * D202: a webhook's answer; when it says something new was taken in (2xx, not a duplicate, not ignored), what that started runs
 * right after the answer goes back instead of on the next minute tick. A refused, repeated or ignored delivery starts nothing.
 */
export function respondAndRun(companyId: string, body: Record<string, unknown>, init?: ResponseInit): NextResponse {
  const status = init?.status ?? 200;
  if (status >= 200 && status < 300 && !body.duplicate && !body.duplicate_delivery && !("ignored" in body) && !("error" in body)) after(() => runCompanyNow(companyId));
  return NextResponse.json(body, init);
}
