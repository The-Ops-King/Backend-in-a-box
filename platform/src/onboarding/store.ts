/**
 * D143 (#49 P1): a client being stood up. "Add client" makes the company, in ghost and `onboarding`: the engine neither polls
 * nor ticks it (only active and hosted companies run), but it has an id, so the webhook and Slack URLs that carry it exist from
 * the start. Each wizard step saves what it learned on the onboarding row; nothing is lost when Tyler stops for days.
 */
import type { PoolClient } from "pg";
import { IANAZone } from "luxon";
import { one } from "@/db/client";
import { playbooks } from "@/playbooks";
import { fitReport, intakeProblems, INTAKE_FIELDS, type FitReport, type Intake, type IntakeField } from "./intake";
import { connectionsState, type ConnectionRow } from "./connections";
import type { Research } from "./research";

/** The wizard's steps, in order. `built`: false until its slice of P1 is built, so the page says so instead of pretending. */
export const STEPS = [
  { id: "offer", label: "The offer", about: "the product, how it sells, the software it runs on; picks the playbook and says what fits", built: true },
  { id: "connections", label: "Connections", about: "the keys this client's software needs, each tested live", built: true },
  { id: "research", label: "Research", about: "their calendars, boards, fields and team, and which is which", built: true },
  { id: "slack", label: "Slack", about: "the app's manifest, its token and signing secret, which channel is for what", built: false },
  { id: "crm", label: "CRM build", about: "what the playbook needs in GHL, shown first, then built", built: false },
  { id: "messages", label: "Messages", about: "every text and email a client gets, written and approved", built: false },
  { id: "install", label: "Install", about: "the playbook installed, every workflow off, the company running in ghost", built: false },
  { id: "test", label: "Test passes", about: "each workflow run end to end on a test contact, no errors", built: false },
  { id: "filters", label: "GHL filters", about: "each of the client's GHL workflows replaced, filtered or off, so nothing runs twice", built: false },
  { id: "golive", label: "Go live, per workflow", about: "each workflow up its own rung, one at a time", built: false },
  { id: "live", label: "Fully live", about: "every workflow live and clean, messages, SMS and email checked, the filters done", built: false },
] as const;
export type StepId = (typeof STEPS)[number]["id"];
export type StepDone = { done_at: string; by: string };

export type OnboardingState = {
  company: { id: string; name: string; slug: string; timezone: string; mode: string; status: string };
  kind: "new" | "takeover"; started_at: string; finished_at: string | null;
  steps: { id: StepId; label: string; about: string; built: boolean; done: StepDone | null }[];
  intake: Intake; playbook: string | null; fit: FitReport | null;
  fields: IntakeField[];
  /** D144: the keys the offer needs, what is kept (masked), each one's last live test */
  connections: ConnectionRow[];
  /** D145: what was read from their accounts, the AI's suggestions, Tyler's answers */
  research: Research | null;
  playbooks: { slug: string; name: string; about: string }[];
};

const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
export const slugOf = (name: string) => name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "");

export type CreateResult = { ok: true; id: string; slug: string } | { ok: false; status: number; why: string };

export async function createClient(c: PoolClient, args: { name?: unknown; slug?: unknown; timezone?: unknown; kind?: unknown; by?: string }): Promise<CreateResult> {
  const name = typeof args.name === "string" ? args.name.trim() : "";
  if (!name) return { ok: false, status: 400, why: "a name is required" };
  const slug = typeof args.slug === "string" && args.slug.trim() ? args.slug.trim().toLowerCase() : slugOf(name);
  if (!SLUG.test(slug)) return { ok: false, status: 400, why: "the short name is lowercase letters, numbers and dashes (it is in the dashboard's links)" };
  const timezone = typeof args.timezone === "string" ? args.timezone.trim() : "";
  if (!IANAZone.isValidZone(timezone)) return { ok: false, status: 400, why: `"${timezone}" is not a time zone (America/New_York, America/Phoenix, …)` };
  const kind = args.kind === "takeover" ? "takeover" : args.kind === undefined || args.kind === "new" ? "new" : null;
  if (!kind) return { ok: false, status: 400, why: "kind is new or takeover" };
  if (await one(c, "select 1 from companies where slug=$1", [slug])) return { ok: false, status: 409, why: `there is already a company "${slug}"` };
  const co = (await one<{ id: string }>(c, "insert into companies (name, slug, timezone, mode, status) values ($1,$2,$3,'ghost','onboarding') returning id", [name, slug, timezone]))!;
  await c.query("insert into onboarding (company_id, kind, started_by) values ($1,$2,$3)", [co.id, kind, args.by ?? "dashboard"]);
  await c.query("insert into audit_log (company_id, action, target_type, target_id, after) values ($1,'company.created','company',$2,$3)", [co.id, co.id, { name, slug, timezone, kind, by: args.by ?? "dashboard", status: "onboarding" }]);
  return { ok: true, id: co.id, slug };
}

export async function onboardingState(c: PoolClient, slug: string): Promise<OnboardingState | null> {
  const r = await one<{ id: string; name: string; slug: string; timezone: string; mode: string; status: string; kind: "new" | "takeover"; intake: Intake; playbook: string | null; fit: FitReport | null; steps: Record<string, StepDone>; research: Research | null; started_at: Date; finished_at: Date | null }>(c,
    `select co.id, co.name, co.slug, co.timezone, co.mode, co.status, o.kind, o.intake, o.playbook, o.fit, o.steps, o.research, o.started_at, o.finished_at
     from companies co join onboarding o on o.company_id=co.id where co.slug=$1`, [slug]);
  if (!r) return null;
  return {
    company: { id: r.id, name: r.name, slug: r.slug, timezone: r.timezone, mode: r.mode, status: r.status },
    kind: r.kind, started_at: r.started_at.toISOString(), finished_at: r.finished_at?.toISOString() ?? null,
    steps: STEPS.map((s) => ({ ...s, done: r.steps[s.id] ?? null })),
    intake: r.intake, playbook: r.playbook, fit: r.fit, fields: INTAKE_FIELDS,
    connections: (await connectionsState(c, r.id)).rows,
    research: r.research,
    playbooks: playbooks.map((p) => ({ slug: p.slug, name: p.name, about: p.about })),
  };
}

export type SaveIntakeResult = { ok: true; playbook: string; fit: FitReport } | { ok: false; status: number; why: string; problems?: string[] };

/**
 * The offer step: the answers checked, the playbook (the closest, or the one Tyler chose) and its fit report saved, the price
 * set as the program price. Saving again replaces the answers; nothing installed is touched (that is the install step's).
 */
export async function saveIntake(c: PoolClient, companyId: string, args: { intake: unknown; playbook?: unknown; by?: string }): Promise<SaveIntakeResult> {
  const row = await one<{ kind: "new" | "takeover" }>(c, "select kind from onboarding where company_id=$1 for update", [companyId]);
  if (!row) return { ok: false, status: 404, why: "this company is not being onboarded" };
  const problems = intakeProblems(args.intake);
  if (problems.length) return { ok: false, status: 422, why: `${problems.length} answer${problems.length === 1 ? "" : "s"} to fix`, problems };
  const chosen = typeof args.playbook === "string" && args.playbook ? args.playbook : undefined;
  if (chosen && !playbooks.some((p) => p.slug === chosen)) return { ok: false, status: 400, why: `no playbook "${chosen}"` };
  const intake = args.intake as Intake;
  const fit = fitReport(intake, row.kind, chosen);
  const done: StepDone = { done_at: new Date().toISOString(), by: args.by ?? "dashboard" };
  await c.query("update onboarding set intake=$2, playbook=$3, fit=$4, steps=steps || jsonb_build_object('offer', $5::jsonb) where company_id=$1", [companyId, intake, fit.playbook, fit, done]);
  await c.query("update companies set contract_value_default=$2 where id=$1", [companyId, Number(intake.price)]);
  await c.query("insert into audit_log (company_id, action, target_type, target_id, after) values ($1,'onboarding.offer','company',$2,$3)", [companyId, companyId, { playbook: fit.playbook, chosen: chosen ?? null, gaps: fit.gaps, by: done.by }]);
  return { ok: true, playbook: fit.playbook, fit };
}
