import Anthropic from "@anthropic-ai/sdk";
import { jsonSchemaOutputFormat } from "@anthropic-ai/sdk/helpers/json-schema";
import { z } from "zod";
import type { CalendarSnapshot } from "@/adapters/types";
import type { Catalog } from "@/adapters/ghl/catalog";
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
