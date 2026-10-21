import type { Hub } from "../framework/hub";
import type { AgreementCheck } from "../framework/state";
import type { J } from "../framework/types";
import { targetOf } from "./api";
import { ghlApi } from "./index";
import { documentStatus, iso, str } from "./shapes";

/**
 * GHL has no webhook for a signed document, so a sent agreement is looked for (ADR 0003): every 10 seconds for its first
 * 60 minutes, then every 5 minutes, up to 30 days after it was sent. Checking stops when it is signed or voided. One
 * request per location covers every agreement that location is waiting on, whichever offers sent them, so a location
 * waiting on many agreements still spends one request a check (GHL's budget is 100 per 10 s per location).
 *
 * The request is one page of the location's documents, newest first (v1's verified read: GET /proposals/document,
 * limit up to 21). A waiting agreement older than a page of newer documents is found by moving on a page each check
 * until every agreement due has been seen, then starting again from the newest. UNVERIFIED: whether GHL can list by
 * status or by id in one request instead (Phase 0 check 4); if it can, `documentsPage` is the one place to change.
 */
export const FAST_MS = 10_000;
export const FAST_FOR_MS = 60 * 60_000;
export const SLOW_MS = 5 * 60_000;
export const GIVE_UP_MS = 30 * 86_400_000;
export const PAGE = 21;

export const firstCheckAt = (sentAt: Date) => new Date(sentAt.getTime() + FAST_MS);

/** When an agreement sent at `sentAt` is next looked for, after a look at `now`; undefined when it is past 30 days. */
export function nextCheckAt(sentAt: Date, now: Date): Date | undefined {
  const age = now.getTime() - sentAt.getTime();
  if (age >= GIVE_UP_MS) return undefined;
  const next = now.getTime() + (age < FAST_FOR_MS ? FAST_MS : SLOW_MS);
  return new Date(Math.min(next, sentAt.getTime() + GIVE_UP_MS));
}

/** One page of the location's documents. */
async function documentsPage(hub: Hub, check: AgreementCheck, skip: number): Promise<J[]> {
  const conn = await hub.state.connectionById(check.connectionId);
  if (!conn) return [];
  const r = await ghlApi(hub).json<{ documents?: J[] }>(targetOf(conn), { method: "GET", path: "/proposals/document", query: { locationId: check.locationId, limit: PAGE, skip } });
  return r.documents ?? [];
}

/** The agreements job for one location: one request, every agreement due settled or moved on, the next run queued. */
export async function checkAgreements(hub: Hub, locationId: string): Promise<{ requests: number; signed: number; voided: number; expired: number; next?: Date }> {
  const now = hub.now();
  const waiting = await hub.state.agreementChecks({ locationId, status: "waiting" });
  const due = waiting.filter((a) => a.nextCheckAt <= now);
  const out = { requests: 0, signed: 0, voided: 0, expired: 0 } as { requests: number; signed: number; voided: number; expired: number; next?: Date };
  if (due.length) {
    const cursor = await hub.state.version(due[0]!.offerId, "ghl", "cursor", `agreements:${locationId}`);
    const skip = Number(cursor?.state.skip ?? 0);
    let docs: J[] = [];
    try { docs = await documentsPage(hub, due[0]!, skip); out.requests = 1; }
    catch { docs = []; out.requests = 1; }   // GHL was not reachable: each agreement is looked for again at its next time
    const byId = new Map(docs.map((d) => [str(d._id) ?? str(d.id) ?? "", d]));
    let unseen = 0;
    for (const a of due) {
      const d = byId.get(a.agreementId);
      const status = d ? documentStatus(d) : undefined;
      if (!d) unseen++;
      if (status === "signed" || status === "voided") {
        const signer = (Array.isArray(d!.recipients) ? (d!.recipients as J[]) : []).find((r) => r.entityName === "contacts") ?? {};
        const at = new Date(iso(signer.signedDate) ?? iso(d!.updatedAt) ?? now.toISOString());
        await hub.ingest({
          offerId: a.offerId, type: status === "signed" ? "agreement.signed" : "agreement.voided", occurredAt: at, source: "ghl", dedupeKey: `ghl:agreement:${a.agreementId}:${status}`,
          contactId: a.contactId, payload: { agreement: { id: a.agreementId, name: a.name ?? str(d!.name) ?? null, status, sent_at: a.sentAt.toISOString(), ...(status === "signed" ? { signed_at: at.toISOString() } : {}) }, by: "crm" },
        });
        await hub.state.updateAgreementCheck(a.id, { status, lastStatus: status, lastCheckedAt: now, checks: a.checks + 1, settledAt: now });
        out[status]++;
        continue;
      }
      if (status === "viewed" && a.lastStatus !== "viewed") {
        await hub.ingest({ offerId: a.offerId, type: "agreement.viewed", occurredAt: now, source: "ghl", dedupeKey: `ghl:agreement:${a.agreementId}:viewed`, contactId: a.contactId, payload: { agreement: { id: a.agreementId, name: a.name, status: "viewed" }, by: "crm" } });
      }
      const next = nextCheckAt(a.sentAt, now);
      if (!next) {
        await hub.state.updateAgreementCheck(a.id, { status: "expired", lastStatus: status ?? a.lastStatus, lastCheckedAt: now, checks: a.checks + 1, settledAt: now });
        out.expired++;
        continue;
      }
      await hub.state.updateAgreementCheck(a.id, { lastStatus: status ?? a.lastStatus, lastCheckedAt: now, checks: a.checks + 1, nextCheckAt: next });
    }
    // a page that did not show every agreement due: the next check reads the page after it (back to the newest at the end)
    const nextSkip = unseen > 0 && docs.length >= PAGE ? skip + PAGE : 0;
    await hub.state.putVersion({ offerId: due[0]!.offerId, provider: "ghl", kind: "cursor", entityId: `agreements:${locationId}`, versionAt: now, state: { skip: nextSkip }, updatedAt: now });
  }
  const left = await hub.state.agreementChecks({ locationId, status: "waiting" });
  if (left.length) {
    out.next = left[0]!.nextCheckAt;
    await hub.enqueue("ghl_agreements", { locationId }, { runAt: out.next, jobKey: `ghl_agreements:${locationId}` });
  }
  return out;
}
