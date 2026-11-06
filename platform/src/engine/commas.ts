import type { PoolClient } from "pg";
import { one } from "@/db/client";
import type { Adapters } from "@/adapters/types";
import { commasCreateWebhook, commasListTransactions, commasListWebhooks, commasPaymentInputs, commasPing, type CommasTransaction } from "@/adapters/commas/client";
import { dropUnmatchedFailure, recordPayment, type PaymentInput } from "./payments";
import { dispatchEvent } from "./dispatch";
import { raise, resolve } from "./alerts";
import { setBinding } from "./settings";
import type { LoadedCompany } from "./sales-call-backfill";

/**
 * D319 (Tyler: "yes will come through commas ... pull from oct 1"): Commas payments into the ledger the way Whop's come.
 * Commas delivers a webhook at most once and names a payment there by another id than its transaction list, so the list is the
 * one source of payments made: read every 10 minutes (and at once when a webhook says something happened), each payment keyed
 * by its transaction id, so a payment is never recorded twice and a lost webhook only waits for the next read. What is new
 * goes through the same ledger path as a Whop webhook: linked by GHL, else by email, phone or buyer; Payment recorded and the
 * rest start from it. The first read sets where reading starts; history is brought in by `importCommasHistory`, which records
 * rows only and starts nothing.
 */
export const COMMAS_KEY = "secret.commas_api_key", COMMAS_SECRET = "secret.commas_webhook", COMMAS_HOOK = "commas.webhook_id";
export const COMMAS_EVERY_MIN = 10;
const OVERLAP_MS = 2 * 86_400_000;   // a payment Commas lists late is still read: each read looks two days behind where the last one got to
const FAILS_TO_ALERT = 3;
const stateKey = (companyId: string) => `commas_sync:${companyId}`;

type Live = { recorded: number; linked: number; unlinked: number; duplicates: number; skipped: number; runs: number };
/** One payment, as the Whop webhook takes one: recorded, linked, and what it starts started. */
export async function takeCommasPayment(c: PoolClient, co: LoadedCompany, adapters: Adapters, p: PaymentInput, out: Live): Promise<void> {
  if (await dropUnmatchedFailure(c, co.row.id, p)) { out.skipped++; return; }
  const r = await recordPayment(c, co.row.id, p, undefined, { ghl: { ac: co.adapterCompany, adapters, bindings: co.bindings, tz: co.row.timezone } });
  if (r.outcome === "duplicate") { out.duplicates++; return; }
  if (r.outcome === "skipped") { out.skipped++; return; }
  out.recorded++;
  if (r.outcome === "unlinked") { out.unlinked++; out.runs += (await dispatchEvent(c, r.event, {})).length; return; }
  out.linked++; out.runs += (await dispatchEvent(c, r.event, { contact: { id: r.contactId } })).length;
}

/**
 * The read: transactions since the last read (less the overlap) into the ledger. The first read only marks where reading
 * starts (history is imported apart), so connecting never fires a workflow for an old payment. A read that fails changes
 * nothing; three in a row is an alert, cleared by the next one that works.
 */
export async function syncCommas(c: PoolClient, co: LoadedCompany, adapters: Adapters, now = new Date(), list: typeof commasListTransactions = commasListTransactions): Promise<Live & { baseline?: boolean; error?: string }> {
  const out: Live = { recorded: 0, linked: 0, unlinked: 0, duplicates: 0, skipped: 0, runs: 0 };
  const key = co.bindings[COMMAS_KEY]; if (!key) return out;
  const st = (await one<{ value: { since?: string; fails?: number } }>(c, "select value from engine_state where key=$1", [stateKey(co.row.id)]))?.value ?? {};
  const save = (v: Record<string, unknown>) => c.query("insert into engine_state (key, value, updated_at) values ($1,$2,now()) on conflict (key) do update set value=$2, updated_at=now()", [stateKey(co.row.id), v]);
  if (!st.since) { await save({ since: now.toISOString(), fails: 0 }); return { ...out, baseline: true }; }
  let rows: CommasTransaction[];
  try { rows = await list(key, new Date(Date.parse(st.since) - OVERLAP_MS)); }
  catch (e) {
    const fails = (st.fails ?? 0) + 1, error = String((e as Error).message).slice(0, 200);
    await save({ ...st, fails });
    if (fails >= FAILS_TO_ALERT) await raise(c, { companyId: co.row.id, key: "commas:read", level: "error", source: "health", text: `Commas payments can't be read (${fails} tries in a row): ${error}. New payments wait until it can.` });
    return { ...out, error };
  }
  for (const p of rows.flatMap(commasPaymentInputs).sort((a, b) => a.paidAt.getTime() - b.paidAt.getTime())) await takeCommasPayment(c, co, adapters, p, out);
  await save({ since: now.toISOString(), fails: 0 });
  await resolve(c, co.row.id, "commas:read", now);
  return out;
}

/** History: every Commas payment since `from` into the ledger as rows only (no workflow starts), the dry run saying what it would add. GHL decides the buyer, as live (D270). */
export async function importCommasHistory(c: PoolClient, co: LoadedCompany, from: Date, dryRun = true, list: typeof commasListTransactions = commasListTransactions, adapters?: Adapters) {
  const key = co.bindings[COMMAS_KEY]; if (!key) throw new Error("no Commas API key on this offer");
  const inputs = (await list(key, from)).flatMap(commasPaymentInputs).sort((a, b) => a.paidAt.getTime() - b.paidAt.getTime());
  const rows: { id: string; when: string; amount: number; status: string; email: string | null; product: unknown; result: string }[] = [];
  for (const p of inputs) {
    const known = await one(c, "select 1 from payments where company_id=$1 and provider='commas' and whop_payment_id=$2", [co.row.id, p.providerPaymentId]);
    let result = known ? "already recorded" : dryRun ? "would record" : "";
    if (!known && !dryRun) {
      if (await dropUnmatchedFailure(c, co.row.id, p)) result = "dropped (failed, matches nobody)";
      else { const r = await recordPayment(c, co.row.id, p, undefined, { dispatch: false, ...(adapters ? { ghl: { ac: co.adapterCompany, adapters, bindings: co.bindings, tz: co.row.timezone } } : {}) }); result = r.outcome === "linked" ? "recorded, linked" : r.outcome === "unlinked" ? "recorded, unlinked" : r.outcome; }
    }
    rows.push({ id: p.providerPaymentId, when: p.paidAt.toISOString(), amount: p.amount, status: p.status, email: p.email ?? null, product: p.raw?.product_name ?? null, result });
  }
  if (!dryRun) await c.query("insert into audit_log (company_id, action, target_type, target_id, after) values ($1,'commas.history_imported','company',$3,$2)", [co.row.id, { from, count: rows.length }, co.row.id]);
  return { dryRun, from: from.toISOString(), count: rows.length, total: Math.round(rows.filter((r) => r.status !== "failed").reduce((s, r) => s + r.amount, 0) * 100) / 100, rows };
}

/** Connect: the key works, then one webhook subscription to this offer's address (reused if Commas has it already, made otherwise), its secret bound. */
export async function connectCommas(c: PoolClient, co: LoadedCompany, baseUrl: string, dryRun = true) {
  const key = co.bindings[COMMAS_KEY]; if (!key) throw new Error("no Commas API key on this offer: add it in Settings first");
  const ping = await commasPing(key); if (!ping.ok) throw new Error(`Commas refused the key: ${ping.error}`);
  const url = `${baseUrl}/api/webhooks/commas/${co.row.id}`;
  const have = (await commasListWebhooks(key)).find((w) => w.webhook_url === url);
  const bound = !!co.bindings[COMMAS_SECRET] && co.bindings[COMMAS_HOOK] === have?.id;
  if (dryRun) return { dryRun: true, url, key: "works", webhook: have ? { id: have.id, active: have.is_active, events: have.event_types, secret_bound: bound } : "would be made", reads_from: "the next 10-minute read marks where reading starts" };
  if (have && bound) return { dryRun: false, url, webhook: have.id, made: false };
  // Commas gives a subscription's secret only when it is made: one we cannot verify is replaced by a new one
  const w = await commasCreateWebhook(key, url);
  await setBinding(c, co.row.id, COMMAS_SECRET, "secret", w.secret_key, "commas connect");
  await setBinding(c, co.row.id, COMMAS_HOOK, "id", w.id, "commas connect");
  await c.query("insert into audit_log (company_id, action, target_type, target_id, after) values ($1,'commas.connected','company',$3,$2)", [co.row.id, { webhook: w.id, url, replaced: have?.id ?? null }, co.row.id]);
  return { dryRun: false, url, webhook: w.id, made: true, replaced: have?.id ?? null };
}
