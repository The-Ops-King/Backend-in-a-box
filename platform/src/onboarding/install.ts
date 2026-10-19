/**
 * D176 (#53 P1): the wizard's install step. Everything the earlier steps learned becomes one install (installCompany, D16): the
 * GHL location, the booking source (Calendly's token, or GHL's calendars), the calendars Research mapped with the closer call
 * and the booking link, the ids the CRM build found or made with what the Sales Call's options mean, the team's roles, the keys
 * that register the engine's own webhooks (Whop, Fathom). Then the playbook's copies go on (D170, all or nothing), and the
 * company turns active, still in ghost: the engine starts reading their accounts, every workflow off, nothing written and nothing
 * sent. Templates a playbook workflow takes over (D123) are left out of the install, so nothing has to be removed. A new offer's
 * SMS starts off (its own GHL account has no approved number yet; Tyler turns it on once A2P is through); a takeover keeps theirs.
 * Re-running is safe: install and the playbook are both idempotent.
 */
import type { PoolClient } from "pg";
import { many, one } from "@/db/client";
import { decrypt } from "@/engine/crypto";
import { installCompany, type CalendarMapping, type InstallInput } from "@/engine/install";
import { templates } from "@/templates";
import { playbookOf } from "@/playbooks";
import { applyPlaybook, type ApplyResult } from "@/playbooks/apply";
import { seedFromRelease } from "@/playbooks/template-business";
import type { Intake } from "./intake";
import type { Research } from "./research";
import type { CrmRun } from "./crm";

export type InstallPlan = { input: InstallInput; playbook: string; params: unknown; leftOut: string[] };

/** The install the earlier steps add up to; a refusal names the step still to finish. */
export async function installPlan(c: PoolClient, companyId: string): Promise<{ ok: true; plan: InstallPlan } | { ok: false; status: number; why: string }> {
  const o = await one<{ name: string; slug: string; timezone: string; kind: "new" | "takeover"; intake: Intake; playbook: string | null; params: unknown; research: Research | null; crm: { last?: CrmRun }; steps: Record<string, unknown> }>(c,
    `select co.name, co.slug, co.timezone, o.kind, o.intake, o.playbook, o.params, o.research, o.crm, o.steps from onboarding o join companies co on co.id=o.company_id where o.company_id=$1`, [companyId]);
  if (!o) return { ok: false, status: 404, why: "this company is not being onboarded" };
  const todo = (["offer", "connections", "research", "slack", "crm"] as const).filter((s) => !o.steps[s]);
  if (todo.length) return { ok: false, status: 409, why: `finish ${todo.map((s) => ({ offer: "The offer", connections: "Connections", research: "Research", slack: "Slack", crm: "CRM build" })[s]).join(", ")} first` };
  const r = o.research!, crm = o.crm.last!;
  const b = Object.fromEntries((await many<{ key: string; kind: string; value: Buffer }>(c, "select key, kind, value from bindings where company_id=$1 and key = any($2::text[])", [companyId, ["crm.location_id", "secret.calendly_token", "secret.whop_api_key", "secret.fathom_api_key"]]))
    .map((x) => [x.key, x.kind === "secret" ? decrypt(x.value) : x.value.toString("utf8")]));
  const calendars: Record<string, CalendarMapping> = Object.fromEntries(Object.entries(r.answers.calendars).flatMap(([id, a]) => (a.call_type === "ignore" ? [] : [[id, { term: a.call_type, ...(a.name ? { name: a.name } : {}), ...(a.booking && a.booking !== "company" ? { booking: a.booking } : {}) }]])));
  const email = (id: string) => r.users.find((u) => u.id === id)?.email?.toLowerCase() ?? id;
  const roles = Object.entries(r.answers.team);
  // what a playbook workflow takes over is not installed (D123): its own workflow is made in its place
  const pb = playbookOf(o.playbook!);
  // only to learn which templates its copies take over: the objections it reads for its prompts do not matter here
  const built = pb.build(o.slug, o.params ?? undefined, { calendars, salesCall: { objections: ["price"] } });
  const leftOut = [...new Set(built.copies.flatMap((x) => (x.create?.takesOver ? [x.create.takesOver] : [])))];
  const { salesCall, discoveryCall } = crm.install as { salesCall?: InstallInput["salesCall"]; discoveryCall?: InstallInput["discoveryCall"] };
  const input: InstallInput = {
    name: o.name, slug: o.slug, timezone: o.timezone, locationId: b["crm.location_id"],
    booking: o.intake.booking === "calendly" ? { source: "calendly", token: b["secret.calendly_token"] } : { source: "ghl" },
    calendars, ...(r.answers.closerCall ? { closerCall: r.answers.closerCall } : {}), ...(r.answers.bookingCalendar ? { bookingCalendar: r.answers.bookingCalendar } : {}),
    crm: crm.crm, ...(salesCall ? { salesCall } : {}), ...(discoveryCall ? { discoveryCall } : {}),
    ...(b["secret.whop_api_key"] ? { whop: { apiKey: b["secret.whop_api_key"] } } : {}),
    ...(o.intake.recording === "fathom" && b["secret.fathom_api_key"] ? { recording: { source: "fathom", apiKey: b["secret.fathom_api_key"] } } : {}),
    closers: roles.filter(([, x]) => x === "closer").map(([id]) => email(id)),
    roles: Object.fromEntries(roles.filter(([, x]) => x !== "closer" && x !== "none").map(([id, x]) => [email(id), x as "setter" | "manager" | "owner" | "staff"])),
    templates: templates.map((t) => t.slug).filter((s) => !leftOut.includes(s)),
    enable: false, mode: "ghost", ...(o.kind === "new" ? { smsEnabled: false } : {}),
  };
  return { ok: true, plan: { input, playbook: o.playbook!, params: o.params, leftOut } };
}

export type InstallOutcome = { ok: true; installed: string[]; calendars: string[]; playbook: ApplyResult } | { ok: false; status: number; why: string; installed?: string[]; playbook?: ApplyResult };

/** After installCompany (its own transaction): the playbook's copies, then the company active in ghost and the step done. */
export async function finishInstall(c: PoolClient, companyId: string, slug: string, plan: InstallPlan, installed: { installed: string[]; calendars: string[] }, by = "dashboard"): Promise<InstallOutcome> {
  const pb = await applyPlaybook(c, { company: slug, playbook: plan.playbook, params: plan.params ?? undefined, by });
  if (!pb.ok) return { ok: false, status: pb.status, why: `installed, but the playbook's copies were not saved: ${pb.why}`, installed: installed.installed, playbook: pb };
  await c.query("update companies set status='active' where id=$1 and status='onboarding'", [companyId]);
  await c.query("update onboarding set steps = steps || jsonb_build_object('install', jsonb_build_object('done_at', now(), 'by', $2::text)) where company_id=$1", [companyId, by]);
  await c.query("insert into audit_log (company_id, action, target_type, target_id, after) values ($1,'onboarding.installed','company',$2,$3)", [companyId, companyId, { playbook: plan.playbook, left_out: plan.leftOut, by }]);
  return { ok: true, installed: installed.installed, calendars: installed.calendars, playbook: pb };
}

/** The whole step, for the route: plan (a short read), install (installCompany's own transaction, it calls the services), finish. */
export async function runInstall(asOp: <T>(fn: (c: PoolClient) => Promise<T>) => Promise<T>, companyId: string, slug: string, adapters: Parameters<typeof installCompany>[1], by = "dashboard"): Promise<InstallOutcome> {
  const p = await asOp((c) => installPlan(c, companyId));
  if (!p.ok) return p;
  // D178: the playbook's latest release (its template business) gives the words and settings the client has none of its own for
  await asOp((c) => seedFromRelease(c, companyId, p.plan.playbook));
  let out;
  try { out = await installCompany(p.plan.input, adapters); }
  catch (e) { return { ok: false, status: 422, why: `the install was refused: ${String((e as Error).message).slice(0, 300)}` }; }
  return asOp((c) => finishInstall(c, companyId, slug, p.plan, out, by));
}
