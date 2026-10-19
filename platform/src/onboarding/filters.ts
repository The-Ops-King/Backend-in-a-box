/**
 * D180 (#53 P1, step 8): the client's own GHL workflows, and the check before every rung up. Tyler: "add a filter on existing
 * GHL workflows so nothing has an issue", reminded "every time as part of the go-live", and (2026-10-19) checked at every rung up.
 *
 * GHL's API lists a location's workflows (id, name, status) but not their triggers or actions, so the engine cannot tell what
 * one fires on: Tyler opens each in GHL and marks it, with the trigger list (09-possibilities, part B) as the guide:
 *   replaced  ours does what it does; it goes off at go-live (fully live checks it reads off)
 *   filtered  it stays, with the `sys-test` filter added in GHL so it never fires on the test contact
 *   harmless  it can fire on what the engine does and nothing bad happens
 *   off       it is off (it must read off in GHL)
 * The step is done when the list has been read and every workflow on it is marked. Their list can change any day, so before every
 * rung up (the company's or one workflow's, every door: setCompanyMode and setWorkflowMode) the engine needs a fresh check: the list
 * read again live, nothing new or unmarked, nothing marked off that is on. The check is used by the one move it was made for and
 * lasts 30 minutes. Companies not onboarded through the wizard (no onboarding row) and template businesses (D183) are not gated.
 */
import type { PoolClient } from "pg";
import { many, one } from "@/db/client";
import { decrypt } from "@/engine/crypto";
import { ghlWorkflows } from "@/adapters/ghl/catalog";

export const MARKS = ["replaced", "filtered", "harmless", "off"] as const;
export type Mark = (typeof MARKS)[number];
export type TheirWorkflow = { id: string; name: string; status: string };
export type Marked = { mark: Mark; note?: string; name: string; status: string; at: string; by: string };
export type Filters = { read_at?: string; list?: TheirWorkflow[]; marks?: Record<string, Marked>; check?: { at: string; by: string; used_at?: string; used_for?: string } };
export const CHECK_MINUTES = 30;

/** A workflow GHL reports as running: published (or active); a draft or inactive one fires on nothing. */
export const isOn = (status: string) => /^(published|active)$/i.test(status.trim());

/** What stands between the live list and a clean check, one line each. */
export function problemsOf(list: TheirWorkflow[], marks: Record<string, Marked>): string[] {
  const out: string[] = [];
  for (const w of list) {
    const m = marks[w.id];
    if (!m) out.push(`${w.name} (${w.status}): not marked yet`);
    else if (m.mark === "off" && isOn(w.status)) out.push(`${w.name}: marked off, but GHL says it is ${w.status}`);
  }
  return out;
}

type Read = { ok: true; list: TheirWorkflow[] } | { ok: false; status: number; why: string };
export type ReadDeps = { workflows: (pit: string, locationId: string) => Promise<TheirWorkflow[]> };
const live: ReadDeps = { workflows: ghlWorkflows };

/** Their workflows read now, outside any transaction (a short read for the key first). */
export async function readTheirWorkflows(op: <T>(fn: (c: PoolClient) => Promise<T>) => Promise<T>, companyId: string, deps: ReadDeps = live): Promise<Read> {
  const keys = await op(async (c) => Object.fromEntries((await many<{ key: string; kind: string; value: Buffer }>(c, "select key, kind, value from bindings where company_id=$1 and key = any($2::text[])", [companyId, ["crm.location_id", "secret.ghl_pit"]]))
    .map((r) => [r.key, r.kind === "secret" ? decrypt(r.value) : r.value.toString("utf8")])));
  if (!keys["crm.location_id"] || !keys["secret.ghl_pit"]) return { ok: false, status: 409, why: "connect their GHL first (Connections): the list is read from it" };
  try { return { ok: true, list: await deps.workflows(keys["secret.ghl_pit"], keys["crm.location_id"]) }; }
  catch (e) { return { ok: false, status: 502, why: `GHL would not list the workflows: ${String((e as Error).message).slice(0, 200)}` }; }
}

const load = async (c: PoolClient, companyId: string) => (await one<{ filters: Filters }>(c, "select filters from onboarding where company_id=$1", [companyId]))?.filters ?? null;
const save = (c: PoolClient, companyId: string, f: Filters) => c.query("update onboarding set filters=$2 where company_id=$1", [companyId, JSON.stringify(f)]);

/** The step's done mark follows the list: set when read and every workflow on it is marked cleanly, taken off otherwise. */
async function syncDone(c: PoolClient, companyId: string, f: Filters) {
  const done = !!f.read_at && !problemsOf(f.list ?? [], f.marks ?? {}).length;
  if (done) await c.query("update onboarding set steps = steps || jsonb_build_object('filters', jsonb_build_object('done_at', now(), 'by', 'filters')) where company_id=$1 and not steps ? 'filters'", [companyId]);
  else await c.query("update onboarding set steps = steps - 'filters' where company_id=$1", [companyId]);
}

/** The list as read now, kept with the marks already made (a workflow gone from GHL drops out of the list; its mark stays in history). */
export async function saveList(c: PoolClient, companyId: string, list: TheirWorkflow[]): Promise<Filters | null> {
  const f = await load(c, companyId); if (!f) return null;
  const next: Filters = { ...f, read_at: new Date().toISOString(), list };
  await save(c, companyId, next); await syncDone(c, companyId, next);
  return next;
}

export async function markWorkflow(c: PoolClient, companyId: string, args: { id?: unknown; mark?: unknown; note?: unknown; by?: string }): Promise<{ ok: true } | { ok: false; status: number; why: string }> {
  const f = await load(c, companyId); if (!f) return { ok: false, status: 404, why: "this company is not being onboarded" };
  const w = (f.list ?? []).find((x) => x.id === args.id);
  if (!w) return { ok: false, status: 400, why: "no such workflow in the list read from GHL: read it again" };
  if (!(MARKS as readonly unknown[]).includes(args.mark)) return { ok: false, status: 400, why: `mark is one of ${MARKS.join(", ")}` };
  if (args.mark === "off" && isOn(w.status)) return { ok: false, status: 422, why: `${w.name} is ${w.status} in GHL: turn it off there, read the list again, then mark it off` };
  const note = typeof args.note === "string" ? args.note.trim().slice(0, 500) : "";
  const next: Filters = { ...f, marks: { ...(f.marks ?? {}), [w.id]: { mark: args.mark as Mark, ...(note ? { note } : {}), name: w.name, status: w.status, at: new Date().toISOString(), by: args.by ?? "dashboard" } } };
  await save(c, companyId, next); await syncDone(c, companyId, next);
  await c.query("insert into audit_log (company_id, action, target_type, target_id, after) values ($1,'onboarding.filter','company',$2,$3)", [companyId, companyId, { workflow: w.name, ghl_id: w.id, mark: args.mark, note: note || null, by: args.by ?? "dashboard" }]);
  return { ok: true };
}

export type CheckResult = { ok: true; at: string; count: number } | { ok: false; status: number; why: string; problems?: string[] };

/**
 * Tyler's check before a rung up: their list read again live (`list`, read by the caller outside the transaction) and saved;
 * refused while anything on it is new, unmarked or marked off and on. A clean check is kept for the next move up.
 */
export async function confirmCheck(c: PoolClient, companyId: string, list: TheirWorkflow[], by = "dashboard"): Promise<CheckResult> {
  const f = await saveList(c, companyId, list); if (!f) return { ok: false, status: 404, why: "this company is not being onboarded" };
  const problems = problemsOf(list, f.marks ?? {});
  if (problems.length) return { ok: false, status: 409, why: `their GHL workflows changed or are not all marked: ${problems.length} to see to first`, problems };
  const at = new Date().toISOString();
  await save(c, companyId, { ...f, check: { at, by } });
  await c.query("insert into audit_log (company_id, action, target_type, target_id, after) values ($1,'onboarding.automations_checked','company',$2,$3)", [companyId, companyId, { workflows: list.length, by }]);
  return { ok: true, at, count: list.length };
}

/**
 * For a move up the ladder (setCompanyMode, setWorkflowMode): null when it may go, else why not. An onboarding company needs a
 * clean check made in the last 30 minutes and not yet used; this move uses it. Inside the mover's transaction.
 */
export async function useCheck(c: PoolClient, companyId: string, what: string): Promise<string | null> {
  const row = await one<{ filters: Filters; template: boolean }>(c, "select o.filters, co.status='template' as template from onboarding o join companies co on co.id=o.company_id where o.company_id=$1 for update of o", [companyId]);
  // D183: a template business is tested in Tyler's own sandbox account, not a client's: its record is the tests' store, not a wizard
  if (!row || row.template) return null;
  const chk = row.filters.check;
  if (!chk || chk.used_at || Date.now() - Date.parse(chk.at) > CHECK_MINUTES * 60e3)
    return "check their GHL workflows first: every move up needs a fresh check that nothing of theirs fires on what the engine does (GHL workflows step, \"Check now\")";
  await save(c, companyId, { ...row.filters, check: { ...chk, used_at: new Date().toISOString(), used_for: what } });
  return null;
}

export type FiltersState = { filters: Filters; rows: (TheirWorkflow & { marked: Marked | null; problem: string | null })[]; problems: string[]; done: boolean; check: { fresh: boolean; at: string | null } };

export async function filtersState(c: PoolClient, companyId: string): Promise<FiltersState | null> {
  const f = await load(c, companyId); if (!f) return null;
  const list = f.list ?? [], marks = f.marks ?? {}, problems = problemsOf(list, marks);
  const chk = f.check;
  return {
    filters: f, problems, done: !!f.read_at && !problems.length,
    rows: list.map((w) => ({ ...w, marked: marks[w.id] ?? null, problem: problemsOf([w], marks)[0] ?? null })),
    check: { fresh: !!chk && !chk.used_at && Date.now() - Date.parse(chk.at) <= CHECK_MINUTES * 60e3, at: chk?.at ?? null },
  };
}
