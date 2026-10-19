/**
 * D153 (#53 P1): the wizard's CRM build. What the client's playbook needs in their GHL (its boards and stages, the contact and
 * opportunity fields, the Sales Call, Payment and Discovery Call records and their links, src/playbooks/ghl-setup.ts) goes to
 * the additive provisioner (src/adapters/ghl/provision.ts): a dry run first that reads their GHL and says, line by line, what is
 * there and what would be made; then, when Tyler says so, the same plan applied. It only ever creates what is missing; it never
 * renames, retypes or deletes, and touches nothing the setup does not name. The ids it finds or makes (the `crm` map the
 * workflows read) are kept for the install step. A GHL account the client shares with another business takes a prefix on every
 * name, so nothing of ours meets anything of theirs. Like research, the GHL calls run outside any database transaction.
 * Not here yet: a takeover mapped onto the client's own differently-named boards (P2); today a board of another name is made anew.
 */
import type { PoolClient } from "pg";
import { many, one } from "@/db/client";
import { decrypt } from "@/engine/crypto";
import { ghl } from "@/adapters/ghl/client";
import { provision, summary, type Http, type Line, type Setup } from "@/adapters/ghl/provision";
import { playbookOf } from "@/playbooks";
import { OBJECTIONS, oneBoardSetup, twoBoardSetup, type SetupParams } from "@/playbooks/ghl-setup";
import type { OneBoardParams } from "@/playbooks/one-board";
import type { Research } from "./research";

export type CrmOptions = { prefix: string };
export type CrmRun = { at: string; applied: boolean; plan: Line[]; after?: Line[]; summary: string; crm: Record<string, string>; install: Record<string, unknown>; missing: string[]; error?: string };
export type CrmState = { options: CrmOptions; last: CrmRun | null };

/** The option keys a name becomes ("Demo call" → demo_call). */
const keyOf = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");

/** The setup for this client: the playbook's shape, the client's names. Throws, saying what is missing, when it cannot be made yet. */
export function setupFor(o: { playbook: string | null; params: unknown; research: Research | null; timezone: string; options: CrmOptions }): Setup {
  if (!o.playbook) throw new Error("answer The offer first: the playbook says what GHL needs");
  if (!o.research?.done) throw new Error("finish Research first: the closers and the call types come from it");
  const pb = playbookOf(o.playbook), r = o.research;
  const prefix = o.options.prefix.trim(), base = keyOf(prefix);
  // each closer's option on the Sales Call is their first name (D118), as PMU's and Dating's are
  const closerOptions = Object.fromEntries(r.users.filter((u) => r.answers.team[u.id] === "closer" && u.email).map((u) => [u.email!.toLowerCase(), keyOf(u.name.split(/\s+/)[0] || u.email!.split("@")[0])]));
  const named = [...new Set(Object.values(r.answers.calendars).flatMap((a) => (a.call_type !== "ignore" && a.name ? [a.name.trim()] : [])))];
  const p: SetupParams = { prefix: prefix ? `${prefix} – ` : "", objectKey: base ? `${base}_` : "", objectLabel: prefix ? `${prefix} ` : "", timezone: o.timezone, closerOptions,
    objections: (pb.traits.boards === "one" ? (o.params as OneBoardParams | null)?.objections : undefined) ?? OBJECTIONS,
    callTypes: [{ key: "closing", label: "Closing" }, ...named.map((n) => ({ key: keyOf(n), label: n })).filter((c) => c.key !== "closing")] };
  return pb.traits.boards === "one" ? oneBoardSetup(p, o.params as OneBoardParams) : twoBoardSetup(p);
}

export type CrmInput = { companyId: string; locationId: string; pit: string; setup: Setup };
export async function crmInput(c: PoolClient, companyId: string): Promise<{ ok: true; input: CrmInput } | { ok: false; status: number; why: string }> {
  const o = await one<{ playbook: string | null; params: unknown; research: Research | null; crm: { options?: CrmOptions }; timezone: string; steps: Record<string, unknown> }>(c,
    "select o.playbook, o.params, o.research, o.crm, co.timezone, o.steps from onboarding o join companies co on co.id=o.company_id where o.company_id=$1", [companyId]);
  if (!o) return { ok: false, status: 404, why: "this company is not being onboarded" };
  if (!o.steps.connections) return { ok: false, status: 409, why: "finish Connections first: the build uses the GHL token" };
  let setup: Setup;
  try { setup = setupFor({ ...o, options: { prefix: o.crm.options?.prefix ?? "" } }); } catch (e) { return { ok: false, status: 409, why: (e as Error).message }; }
  const b = Object.fromEntries((await many<{ key: string; kind: string; value: Buffer }>(c, "select key, kind, value from bindings where company_id=$1 and key = any($2::text[])", [companyId, ["crm.location_id", "secret.ghl_pit"]]))
    .map((r) => [r.key, r.kind === "secret" ? decrypt(r.value) : r.value.toString("utf8")]));
  return { ok: true, input: { companyId, locationId: b["crm.location_id"], pit: b["secret.ghl_pit"], setup } };
}

/** The plan (a dry run reads only) or the build; no database. A GHL refusal is the run's error, with the plan as far as it got. */
export async function runCrm(input: CrmInput, apply: boolean, http?: Http): Promise<CrmRun> {
  const call: Http = http ?? ((m, p, o) => ghl(input.pit, m, p, o));
  try {
    const r = await provision(input.setup, input.locationId, call, { apply });
    const { _missing, crm, ...rest } = r.install as { _missing?: string[]; crm: Record<string, string> } & Record<string, unknown>;
    const last = r.after ?? r.plan;
    return { at: new Date().toISOString(), applied: apply, plan: r.plan, ...(r.after ? { after: r.after } : {}), summary: summary(last), crm, install: rest, missing: _missing ?? [] };
  } catch (e) {
    return { at: new Date().toISOString(), applied: apply, plan: [], summary: "", crm: {}, install: {}, missing: [], error: String((e as Error).message).slice(0, 300) };
  }
}

/** Kept on the onboarding row; done once a build found or made everything (nothing missing, nothing blocked). */
export async function saveCrm(c: PoolClient, companyId: string, run: CrmRun, by = "dashboard"): Promise<void> {
  await c.query("update onboarding set crm = crm || jsonb_build_object('last', $2::jsonb) where company_id=$1", [companyId, JSON.stringify(run)]);
  const done = run.applied && !run.error && !run.missing.length && !(run.after ?? run.plan).some((l) => l.action === "blocked" || l.action === "create");
  if (done) await c.query("update onboarding set steps = steps || jsonb_build_object('crm', jsonb_build_object('done_at', now(), 'by', $2::text)) where company_id=$1", [companyId, by]);
  else await c.query("update onboarding set steps = steps - 'crm' where company_id=$1", [companyId]);
}

export async function saveCrmOptions(c: PoolClient, companyId: string, o: unknown): Promise<{ ok: true } | { ok: false; status: number; why: string }> {
  const prefix = o && typeof o === "object" && typeof (o as { prefix?: unknown }).prefix === "string" ? (o as { prefix: string }).prefix.trim() : null;
  if (prefix === null) return { ok: false, status: 400, why: "options: { prefix }" };
  if (prefix.length > 30) return { ok: false, status: 400, why: "the prefix is a short name, 30 letters at most" };
  // a new prefix is a new plan: the last one no longer says what would be made
  await c.query("update onboarding set crm = jsonb_build_object('options', jsonb_build_object('prefix', $2::text)), steps = steps - 'crm' where company_id=$1", [companyId, prefix]);
  return { ok: true };
}

export const crmState = async (c: PoolClient, companyId: string): Promise<CrmState | null> => {
  const o = await one<{ crm: { options?: CrmOptions; last?: CrmRun } }>(c, "select crm from onboarding where company_id=$1", [companyId]);
  return o ? { options: { prefix: o.crm.options?.prefix ?? "" }, last: o.crm.last ?? null } : null;
};
