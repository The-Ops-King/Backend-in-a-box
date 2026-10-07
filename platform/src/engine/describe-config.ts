import Anthropic from "@anthropic-ai/sdk";
import { jsonSchemaOutputFormat } from "@anthropic-ai/sdk/helpers/json-schema";
import { z } from "zod";
import type { PoolClient } from "pg";
import { many, one } from "@/db/client";
import type { CalendarSnapshot } from "@/adapters/types";
import type { Catalog } from "@/adapters/ghl/catalog";
import { setBinding } from "./settings";
import { DEFAULT_MODEL } from "@/adapters/anthropic/analyst";

/**
 * "This is how we do things here" → concrete settings. The model sees what the engine can already see (every calendar
 * with its questions and hosts, the roster, pipelines and stages) and the person's description, and answers with
 * operations the engine knows how to apply plus questions for whatever the description did not settle. Nothing is
 * applied until a person approves the proposal.
 */
export const Operation = z.discriminatedUnion("op", [
  z.object({ op: z.literal("map_calendar"), calendar_id: z.string(), call_type: z.enum(["first_call", "qualifying", "closing", "follow_up"]), call_type_name: z.string().optional(), booking: z.enum(["self", "setter", "question", "company"]), questions: z.record(z.string()).optional(), active: z.boolean().default(true), why: z.string() }),
  z.object({ op: z.literal("set_setter_rule"), rule: z.enum(["calendar", "question", "either"]), why: z.string() }),
  z.object({ op: z.literal("set_default_closer"), user_id: z.string(), why: z.string() }),
  z.object({ op: z.literal("set_calendar_role"), calendar_id: z.string(), role: z.enum(["closer_call", "booking"]), why: z.string() }),
  z.object({ op: z.literal("add_call_type"), name: z.string(), category: z.enum(["first_call", "qualifying", "closing", "follow_up"]), why: z.string() }),
]);
export const Proposal = z.object({
  summary: z.string(),
  operations: z.array(Operation),
  questions: z.array(z.string()),
});
export type Proposal = z.infer<typeof Proposal>;
export type Operation = z.infer<typeof Operation>;

// The wire schema, by hand: the SDK's zod helper expects zod 4 and this project is on zod 3. Proposal.parse() checks the answer after.
const CALL_TYPES = ["first_call", "qualifying", "closing", "follow_up"] as const;
const PROPOSAL_SCHEMA = {
  type: "object", additionalProperties: false, required: ["summary", "operations", "questions"],
  properties: {
    summary: { type: "string" },
    questions: { type: "array", items: { type: "string" } },
    operations: { type: "array", items: { anyOf: [
      { type: "object", additionalProperties: false, required: ["op", "calendar_id", "call_type", "booking", "why"], properties: { op: { const: "map_calendar" }, calendar_id: { type: "string" }, call_type: { enum: [...CALL_TYPES] }, call_type_name: { type: "string" }, booking: { enum: ["self", "setter", "question", "company"] }, questions: { type: "object", additionalProperties: { type: "string" } }, active: { type: "boolean" }, why: { type: "string" } } },
      { type: "object", additionalProperties: false, required: ["op", "rule", "why"], properties: { op: { const: "set_setter_rule" }, rule: { enum: ["calendar", "question", "either"] }, why: { type: "string" } } },
      { type: "object", additionalProperties: false, required: ["op", "user_id", "why"], properties: { op: { const: "set_default_closer" }, user_id: { type: "string" }, why: { type: "string" } } },
      { type: "object", additionalProperties: false, required: ["op", "calendar_id", "role", "why"], properties: { op: { const: "set_calendar_role" }, calendar_id: { type: "string" }, role: { enum: ["closer_call", "booking"] }, why: { type: "string" } } },
      { type: "object", additionalProperties: false, required: ["op", "name", "category", "why"], properties: { op: { const: "add_call_type" }, name: { type: "string" }, category: { enum: [...CALL_TYPES] }, why: { type: "string" } } },
    ] } },
  },
} as const;

export type ConfigFacts = { calendars: CalendarSnapshot[]; mapped: { external_id: string; term_category: string; booking?: string; questions?: Record<string, string> }[]; users: { id: string; name: string; email: string }[]; catalog: Catalog | null; terms: { name: string; category: string }[]; setterRule?: string; defaultCloser?: string };

export function buildPrompt(facts: ConfigFacts, text: string): { system: string; user: string } {
  const cal = facts.calendars.map((c) => `- id ${c.id} · "${c.name}"${c.pooling ? ` · ${c.pooling}` : ""}${c.note ? ` · note: "${c.note}"` : ""}${c.hosts?.length ? ` · hosts: ${c.hosts.map((h) => `${h.name} <${h.email}>`).join(", ")}` : ""}${c.active === false ? " · inactive at the source" : ""}\n    questions: ${c.questions?.length ? c.questions.map((q) => `"${q.name}"${q.type ? ` (${q.type})` : ""}${q.choices ? ` [${q.choices.join(" / ")}]` : ""}`).join("; ") : "none"}${facts.mapped.some((m) => m.external_id === c.id) ? `\n    currently: ${JSON.stringify(facts.mapped.find((m) => m.external_id === c.id))}` : "\n    currently: not mapped"}`).join("\n");
  const system = `You configure a sales-operations engine for a coaching company from a plain-English description of how they work. You only propose operations the engine can apply; you never invent calendars, people or questions that are not in the facts. When the description does not settle something the engine needs, ask a short question instead of guessing.

Vocabulary: call types are first_call (first conversation / triage / discovery), qualifying (a qualification or demo step before the close), closing (the sales call where the offer is made), follow_up. If the company uses its own word (triage, demo, strategy call), map it to the closest category and pass the word as call_type_name.
Setter vs self-booked, per calendar: "self" = every booking on this calendar is self-booked by the prospect; "setter" = every booking was made by a setter; "question" = a booking question names the setter and an empty answer means self-booked; "company" = use the company rule.
Questions: map a booking question to a name the engine uses. Reserved names: setter (who set the call), phone, email. Any other name becomes an intake attribute (snake_case, e.g. noticing_for). Use the question text exactly as listed.
Calendar roles: closer_call = the calendar whose bookings are the closing call the team works from; booking = the self-booking link the engine sends prospects.
Return a proposal: a one-paragraph summary, the operations, and the questions you still need answered.`;
  const user = `FACTS
Calendars at the booking source:
${cal || "(none listed)"}

Roster (GHL users): ${facts.users.map((u) => `${u.name} <${u.email}> id ${u.id}`).join("; ") || "(none)"}
Call types this company has: ${facts.terms.map((t) => `${t.name} (${t.category})`).join(", ")}
Company setter rule now: ${facts.setterRule ?? "calendar (default)"}; default closer now: ${facts.defaultCloser ?? "none"}
${facts.catalog ? `Pipelines: ${facts.catalog.pipelines.map((p) => `${p.name} [${p.stages.map((s) => s.name).join(" → ")}]`).join("; ")}` : ""}

HOW THEY DO THINGS (from the person):
${text.trim()}`;
  return { system, user };
}

export async function proposeConfig(apiKey: string, facts: ConfigFacts, text: string): Promise<Proposal> {
  const client = new Anthropic({ apiKey });
  const { system, user } = buildPrompt(facts, text);
  const res = await client.messages.parse({ model: DEFAULT_MODEL, max_tokens: 16000, output_config: { format: jsonSchemaOutputFormat(PROPOSAL_SCHEMA), effort: "medium" }, system, messages: [{ role: "user", content: user }] });
  if (!res.parsed_output) throw new Error(res.stop_reason === "refusal" ? "the model declined" : "the model's answer could not be read");
  return Proposal.parse(res.parsed_output);
}

/** Apply an approved proposal with the same code paths the settings forms use. */
export async function applyProposal(c: PoolClient, companyId: string, source: string, ops: Operation[], liveCalendars: CalendarSnapshot[]): Promise<string[]> {
  const done: string[] = [];
  for (const op of ops) {
    if (op.op === "map_calendar") {
      const live = liveCalendars.find((x) => x.id === op.calendar_id);
      let term = await one<{ id: string }>(c, "select id from company_terms where company_id=$1 and domain='appointment_type' and category=$2 and active order by (lower(name)=lower($3)) desc, is_default desc, sort limit 1", [companyId, op.call_type, op.call_type_name ?? ""]);
      if (op.call_type_name && !(await one(c, "select 1 from company_terms where company_id=$1 and domain='appointment_type' and lower(name)=lower($2)", [companyId, op.call_type_name]))) {
        term = await one<{ id: string }>(c, "insert into company_terms (company_id, domain, name, category, sort) values ($1,'appointment_type',$2,$3,(select coalesce(max(sort),0)+1 from company_terms where company_id=$1 and domain='appointment_type')) returning id", [companyId, op.call_type_name, op.call_type]);
      }
      if (!term) continue;
      const config = { ...(op.booking !== "company" ? { booking: op.booking } : {}), ...(op.questions && Object.keys(op.questions).length ? { questions: op.questions } : {}) };
      const selfBooked = op.booking === "self" ? true : op.booking === "setter" ? false : null;
      await c.query(`insert into calendars (company_id, source, external_id, name, appointment_term, self_booked, booking_url, config, active) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
        on conflict (company_id, source, external_id) do update set name=excluded.name, appointment_term=excluded.appointment_term, self_booked=excluded.self_booked, booking_url=coalesce(excluded.booking_url, calendars.booking_url), config=excluded.config, active=excluded.active`,
        [companyId, source, op.calendar_id, live?.name ?? op.calendar_id, term.id, selfBooked, live?.bookingUrl ?? null, JSON.stringify(config), op.active]);
      done.push(`mapped "${live?.name ?? op.calendar_id}" → ${op.call_type_name ?? op.call_type} (${op.booking})`);
    } else if (op.op === "set_setter_rule") { await setBinding(c, companyId, "booking.setter_rule", "text", op.rule, "proposal"); done.push(`setter rule → ${op.rule}`); }
    else if (op.op === "set_default_closer") { await setBinding(c, companyId, "crm.default_closer", "id", op.user_id, "proposal"); done.push(`default closer → ${op.user_id}`); }
    else if (op.op === "set_calendar_role") { await setBinding(c, companyId, `calendar.${op.role}`, "id", op.calendar_id, "proposal"); done.push(`calendar.${op.role} → ${op.calendar_id}`); }
    else if (op.op === "add_call_type") { await c.query("insert into company_terms (company_id, domain, name, category, sort) values ($1,'appointment_type',$2,$3,(select coalesce(max(sort),0)+1 from company_terms where company_id=$1 and domain='appointment_type')) on conflict (company_id, domain, name) do nothing", [companyId, op.name, op.category]); done.push(`call type "${op.name}" (${op.category})`); }
  }
  await c.query("insert into audit_log (company_id, action, target_type, target_id, after) values ($1,'config.proposal_applied','company',$1,$2)", [companyId, { done }]);
  return done;
}

export const loadProposal = (c: PoolClient, companyId: string) => one<{ value: { text: string; proposal: Proposal; at: string } }>(c, "select value from engine_state where key=$1", [`proposal:${companyId}`]);
export const storeProposal = (c: PoolClient, companyId: string, text: string, proposal: Proposal) => c.query("insert into engine_state (key, value, updated_at) values ($1,$2,now()) on conflict (key) do update set value=$2, updated_at=now()", [`proposal:${companyId}`, JSON.stringify({ text, proposal, at: new Date().toISOString() })]);
export const clearProposal = (c: PoolClient, companyId: string) => c.query("delete from engine_state where key=$1", [`proposal:${companyId}`]);
export const termsFor = (c: PoolClient, companyId: string) => many<{ name: string; category: string }>(c, "select name, category from company_terms where company_id=$1 and domain='appointment_type' and active order by sort", [companyId]);
