/**
 * D145 (#49 P1): the wizard's research step. With the keys that passed (D144), the engine reads what the client has: their
 * calendars (GHL) or event types (Calendly) with hosts and booking questions, their GHL team, boards, custom objects and their
 * own GHL workflows (names only: the filters step lists them). The AI (describe-config's proposer, D-describe) reads that and
 * the offer as Tyler described it and suggests which calendar is the sales call, which a setter books, who closes; its guesses
 * pre-fill the answers and its open questions are shown. Tyler confirms or corrects every calendar and every person; nothing
 * is written to the engine's calendars or roster here (install does that, from these answers). Reading is done outside any
 * database transaction (it calls the services and the model), so `researchInput` and `saveResearch` hold the database only
 * for their reads and writes.
 */
import type { PoolClient } from "pg";
import { many, one } from "@/db/client";
import { decrypt } from "@/engine/crypto";
import { ghlCatalog, ghlWorkflows, type Catalog } from "@/adapters/ghl/catalog";
import { calendlyWhoAmI } from "@/adapters/calendly/read";
import { liveAdapters } from "@/adapters";
import { bookingFor, type CalendarSnapshot, type Company } from "@/adapters/types";
import { proposeConfig, type ConfigFacts, type Proposal } from "@/engine/describe-config";
import { emailsOf, type Intake } from "./intake";

export const CALL_TYPES = ["first_call", "qualifying", "closing", "follow_up"] as const;
export type CallType = (typeof CALL_TYPES)[number];
export const ROLES = ["closer", "setter", "manager", "owner", "staff", "none"] as const;
export type Role = (typeof ROLES)[number];
export type CalendarAnswer = { call_type: CallType | "ignore"; name?: string; booking?: "self" | "setter" | "question" | "company" };
export type ResearchAnswers = { calendars: Record<string, CalendarAnswer>; closerCall?: string; bookingCalendar?: string; team: Record<string, Role> };
export type Research = {
  at: string; source: "ghl" | "calendly";
  calendars: CalendarSnapshot[];
  users: { id: string; name: string; email?: string }[];
  pipelines: Catalog["pipelines"]; objects: Catalog["objects"];
  workflows: { id: string; name: string; status: string }[];
  errors: string[];
  proposal: { summary: string; questions: string[]; why: Record<string, string> } | null;
  proposalError?: string;
  answers: ResearchAnswers;
  done?: { at: string; by: string };
};

/** Every outside call research makes, so a test can stand in for the services and the model. */
export type ResearchDeps = {
  catalog: (pit: string, locationId: string) => Promise<Catalog>;
  workflows: (pit: string, locationId: string) => Promise<{ id: string; name: string; status: string }[]>;
  calendars: (co: Company) => Promise<CalendarSnapshot[]>;
  organization: (calendlyToken: string) => Promise<string>;
  propose: (apiKey: string, facts: ConfigFacts, text: string) => Promise<Proposal>;
};
export const liveResearchDeps: ResearchDeps = {
  catalog: ghlCatalog, workflows: ghlWorkflows,
  calendars: (co) => bookingFor(liveAdapters, co).listCalendars(co),
  organization: async (t) => (await calendlyWhoAmI(t)).organization,
  propose: proposeConfig,
};

export type ResearchInput = { companyId: string; timezone: string; intake: Intake; locationId: string; pit: string; calendlyToken?: string; anthropicKey?: string; previous: Research | null };

/** What research needs, read in one short transaction; a refusal says which step to finish first. */
export async function researchInput(c: PoolClient, companyId: string): Promise<{ ok: true; input: ResearchInput } | { ok: false; status: number; why: string }> {
  const o = await one<{ intake: Intake; steps: Record<string, unknown>; research: Research | null; timezone: string }>(c, "select o.intake, o.steps, o.research, co.timezone from onboarding o join companies co on co.id=o.company_id where o.company_id=$1", [companyId]);
  if (!o) return { ok: false, status: 404, why: "this company is not being onboarded" };
  if (!o.steps.connections) return { ok: false, status: 409, why: "finish Connections first: research reads their accounts with those keys" };
  const b = Object.fromEntries((await many<{ key: string; kind: string; value: Buffer }>(c, "select key, kind, value from bindings where company_id=$1 and key = any($2::text[])", [companyId, ["crm.location_id", "secret.ghl_pit", "secret.calendly_token", "secret.anthropic_key"]]))
    .map((r) => [r.key, r.kind === "secret" ? decrypt(r.value) : r.value.toString("utf8")]));
  return { ok: true, input: { companyId, timezone: o.timezone, intake: o.intake, locationId: b["crm.location_id"], pit: b["secret.ghl_pit"], calendlyToken: o.intake.booking === "calendly" ? b["secret.calendly_token"] : undefined,
    anthropicKey: b["secret.anthropic_key"] ?? process.env.ANTHROPIC_API_KEY, previous: o.research } };
}

/** The reading and the AI's suggestions; no database. Each part that fails is named in `errors` and the rest still counts. */
export async function gather(input: ResearchInput, deps: ResearchDeps = liveResearchDeps): Promise<Research> {
  const errors: string[] = [];
  const msg = (e: unknown) => String((e as Error)?.message ?? e).slice(0, 200);
  const source = input.calendlyToken ? "calendly" : "ghl";
  const [catalog, workflows] = await Promise.all([
    deps.catalog(input.pit, input.locationId).catch((e): Catalog => { errors.push(`GHL lists: ${msg(e)}`); return { users: [], pipelines: [], contactFields: [], opportunityFields: [], associations: [], objects: [], tags: [], errors: [] }; }),
    deps.workflows(input.pit, input.locationId).catch((e) => { errors.push(`GHL workflows: ${msg(e)}`); return []; }),
  ]);
  errors.push(...catalog.errors.map((e) => `GHL ${e}`));
  let calendars: CalendarSnapshot[] = [];
  try {
    const booking: Company["booking"] = source === "calendly" ? { source, token: input.calendlyToken!, organization: await deps.organization(input.calendlyToken!) } : { source: "ghl" };
    calendars = await deps.calendars({ id: input.companyId, locationId: input.locationId, pit: input.pit, timezone: input.timezone, booking });
  } catch (e) { errors.push(`${source === "calendly" ? "Calendly event types" : "GHL calendars"}: ${msg(e)}`); }

  let proposal: Research["proposal"] = null, proposalError: string | undefined, ops: Proposal["operations"] = [];
  if (!input.anthropicKey) proposalError = "no Anthropic key: no suggestions, every calendar is answered by hand";
  else if (calendars.length) {
    try {
      const p = await deps.propose(input.anthropicKey, { calendars, mapped: [], users: catalog.users.map((u) => ({ id: u.id, name: u.name, email: u.email ?? "" })), catalog, terms: CALL_TYPES.map((t) => ({ name: t.replace("_", " "), category: t })) }, describe(input.intake));
      ops = p.operations;
      proposal = { summary: p.summary, questions: p.questions, why: Object.fromEntries(p.operations.flatMap((o) => (o.op === "map_calendar" ? [[o.calendar_id, o.why]] : []))) };
    } catch (e) { proposalError = `the AI's suggestions failed (${msg(e)}): every calendar is answered by hand`; }
  }
  return { at: new Date().toISOString(), source, calendars, users: catalog.users, pipelines: catalog.pipelines, objects: catalog.objects, workflows, errors, proposal, ...(proposalError ? { proposalError } : {}),
    answers: prefill(calendars, catalog.users, input.intake, ops, input.previous?.answers) };
}

/** The offer in the words the proposer reads: Tyler's journey, then what the answers settle. */
export function describe(a: Intake): string {
  const yes = (v: unknown) => (v === true ? "yes" : "no");
  return [String(a.journey ?? "").trim(),
    `Setters book or qualify calls: ${yes(a.setters)}. A short triage call before the closing call: ${yes(a.triage)}. Application form: ${a.application ?? "unknown"}. Bookings in ${a.booking}.`,
    emailsOf(a.closers).length ? `Closers: ${emailsOf(a.closers).join(", ")}.` : "", emailsOf(a.setter_emails).length ? `Setters: ${emailsOf(a.setter_emails).join(", ")}.` : ""].filter(Boolean).join("\n");
}

/** The answers to start from: what Tyler already answered (for calendars and people still there), else the AI's guess, else the offer's emails. */
export function prefill(calendars: CalendarSnapshot[], users: Research["users"], a: Intake, ops: Proposal["operations"], previous?: ResearchAnswers): ResearchAnswers {
  const out: ResearchAnswers = { calendars: {}, team: {} };
  for (const k of calendars) {
    const before = previous?.calendars[k.id];
    const op = ops.find((o) => o.op === "map_calendar" && o.calendar_id === k.id);
    if (before) out.calendars[k.id] = before;
    else if (op && op.op === "map_calendar") out.calendars[k.id] = op.active === false ? { call_type: "ignore" } : { call_type: op.call_type, ...(op.call_type_name ? { name: op.call_type_name } : {}), booking: op.booking };
    else if (k.active === false) out.calendars[k.id] = { call_type: "ignore" };
  }
  const has = (id?: string) => (id && calendars.some((k) => k.id === id) ? id : undefined);
  const role = (r: string) => (ops.find((o) => o.op === "set_calendar_role" && o.role === r) as { calendar_id: string } | undefined)?.calendar_id;
  out.closerCall = has(previous?.closerCall) ?? has(role("closer_call"));
  out.bookingCalendar = has(previous?.bookingCalendar) ?? has(role("booking"));
  const closers = emailsOf(a.closers), setters = emailsOf(a.setter_emails);
  const defaultCloser = (ops.find((o) => o.op === "set_default_closer") as { user_id: string } | undefined)?.user_id;
  for (const u of users) {
    const email = (u.email ?? "").toLowerCase();
    out.team[u.id] = previous?.team[u.id] ?? (closers.includes(email) || u.id === defaultCloser ? "closer" : setters.includes(email) ? "setter" : "staff");
  }
  return out;
}

/** Saved after reading; Tyler's answers so far are kept for whatever is still there. */
export async function saveResearch(c: PoolClient, companyId: string, r: Research): Promise<void> {
  await c.query("update onboarding set research=$2, steps = steps - 'research' where company_id=$1", [companyId, r]);
}

/** What is wrong with the answers, one line each; none means research is done. */
export function answerProblems(r: Research, ans: ResearchAnswers): string[] {
  const out: string[] = [], name = (id: string) => r.calendars.find((k) => k.id === id)?.name ?? id;
  for (const id of Object.keys(ans.calendars)) if (!r.calendars.some((k) => k.id === id)) out.push(`${id}: not one of their calendars`);
  for (const k of r.calendars) {
    const x = ans.calendars[k.id];
    if (!x) { out.push(`"${k.name}": say what it books, or ignore it`); continue; }
    if (x.call_type !== "ignore" && !CALL_TYPES.includes(x.call_type)) out.push(`"${k.name}": what it books is one of ${CALL_TYPES.join(", ")}, or ignore`);
    if (x.booking && !["self", "setter", "question", "company"].includes(x.booking)) out.push(`"${k.name}": booked by self, setter, the setter question, or the company rule`);
  }
  const closing = r.calendars.filter((k) => ans.calendars[k.id]?.call_type === "closing");
  if (r.calendars.length && !closing.length) out.push("no calendar books the closing call: say which one does");
  if (closing.length && !ans.closerCall) out.push("say which closing calendar is the closer call the team works from");
  if (ans.closerCall && ans.calendars[ans.closerCall]?.call_type !== "closing") out.push(`the closer call ("${name(ans.closerCall)}") has to be a closing calendar`);
  if (ans.bookingCalendar && (!ans.calendars[ans.bookingCalendar] || ans.calendars[ans.bookingCalendar].call_type === "ignore")) out.push(`the booking link ("${name(ans.bookingCalendar)}") is an ignored calendar`);
  for (const [id, role] of Object.entries(ans.team)) { if (!r.users.some((u) => u.id === id)) out.push(`${id}: not on their GHL team`); else if (!ROLES.includes(role)) out.push(`${r.users.find((u) => u.id === id)!.name}: one of ${ROLES.join(", ")}`); }
  if (!Object.values(ans.team).includes("closer")) out.push("nobody closes: mark at least one closer");
  return out;
}

export type AnswerResult = { ok: true; research: Research } | { ok: false; status: number; why: string; problems?: string[] };
export async function saveResearchAnswers(c: PoolClient, companyId: string, answers: unknown, by = "dashboard"): Promise<AnswerResult> {
  const o = await one<{ research: Research | null }>(c, "select research from onboarding where company_id=$1 for update", [companyId]);
  if (!o) return { ok: false, status: 404, why: "this company is not being onboarded" };
  if (!o.research) return { ok: false, status: 409, why: "read their accounts first" };
  if (!answers || typeof answers !== "object") return { ok: false, status: 400, why: "answers: { calendars, closerCall, bookingCalendar, team }" };
  const a = answers as Partial<ResearchAnswers>;
  const ans: ResearchAnswers = { calendars: a.calendars ?? {}, closerCall: a.closerCall || undefined, bookingCalendar: a.bookingCalendar || undefined, team: a.team ?? {} };
  const problems = answerProblems(o.research, ans);
  const research: Research = { ...o.research, answers: ans, ...(problems.length ? { done: undefined } : { done: { at: new Date().toISOString(), by } }) };
  await c.query("update onboarding set research=$2 where company_id=$1", [companyId, research]);
  if (problems.length) {
    await c.query("update onboarding set steps = steps - 'research' where company_id=$1", [companyId]);
    return { ok: false, status: 422, why: `${problems.length} answer${problems.length === 1 ? "" : "s"} to fix (the rest are kept)`, problems };
  }
  await c.query("update onboarding set steps = steps || jsonb_build_object('research', jsonb_build_object('done_at', now(), 'by', $2::text)) where company_id=$1", [companyId, by]);
  return { ok: true, research };
}
