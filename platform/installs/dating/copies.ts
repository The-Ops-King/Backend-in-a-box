/**
 * D118: a dating company's own copies of the shipped templates, built from the templates and the company's words file
 * (installs/<company>/words.json), the way installs/pmu/build.py builds PMU's. Only what is the company's own is copied:
 * Deal closed (the welcome email and text) and Setter call logged (why a setter DQs a lead). Everything generic (the
 * company's objects, the closer's option key, the objections) the templates read from the company's settings, so every
 * other workflow stays the template's and keeps getting its upgrades.
 *
 * Words still marked [placeholder] keep their sends from going out: each such send is skipped ("only if there is a welcome
 * copy written", which nothing sets) until the words are the company's and the copies are built again.
 * Build: pnpm exec tsx scripts/build-copies.ts dating-nelly (--check: say whether the files are current, write nothing).
 */
import { templates } from "@/templates";
import { defaultPrompts } from "@/prompts";
import { isPlaceholderCopy } from "@/engine/readiness";

export type DatingWords = {
  welcome: { subject: string; email: string; sms: string };
  /** a3's meaning of a DQ, and a4's words for each setter DQ reason (the setter_dq_reason options) */
  setterDq: { result: string; reasons: Record<string, string> };
};
export type Copy = { workflow: string; note: string; definition: Record<string, unknown> };
type Node = { id: string; type: string; [k: string]: unknown };
type Def = { nodes: Node[]; edges: unknown[] };

const DQ_REASONS = ["budget", "age", "geo", "medical", "timeline", "no_problem", "competitor", "bad_contact", "other"];
const load = (slug: string): Def => structuredClone(templates.find((t) => t.slug === slug)!.definition) as unknown as Def;
const node = (d: Def, id: string) => { const n = d.nodes.find((x) => x.id === id); if (!n) throw new Error(`no node ${id}`); return n; };
/** A send that must not go out while its words are a placeholder: nothing sets vars.welcome_copy_written. */
const HELD = { exists: "vars.welcome_copy_written" };

export function datingCopies(company: string, words: DatingWords): Copy[] {
  const out: Copy[] = [];

  // Deal closed: the company's welcome email and text instead of Hair's
  const dc = load("deal-closed");
  const e1 = node(dc, "e1"), e2 = node(dc, "e2");
  const held = [words.welcome.subject, words.welcome.email, words.welcome.sms].some(isPlaceholderCopy);
  Object.assign(e1, { subject: words.welcome.subject, template: words.welcome.email, title: held ? "Welcome email [placeholder: the words are not written yet, so it is skipped]" : "Welcome email" });
  Object.assign(e2, { template: words.welcome.sms, title: held ? "Welcome text [placeholder: the words are not written yet, so it is skipped]" : "Welcome text" });
  if (held) { e1.only_if = HELD; e2.only_if = HELD; }
  out.push({ workflow: "deal-closed", definition: dc as unknown as Record<string, unknown>,
    note: `${company}: the welcome email and text are the company's own (installs/${company}/words.json)${held ? "; still placeholders, so both are skipped" : ""}, not Hair's (D118)` });

  // Setter call logged: why a setter DQs a lead, in the company's words
  const scl = load("setter-call-logged");
  const reasons = Object.keys(words.setterDq.reasons);
  if (reasons.length !== DQ_REASONS.length || DQ_REASONS.some((r) => !words.setterDq.reasons[r]?.trim())) throw new Error(`setterDq.reasons needs words for each of ${DQ_REASONS.join(", ")}`);
  const a3 = node(scl, "a3"), a4 = node(scl, "a4");
  (a3.criteria as Record<string, string>).dq = words.setterDq.result;
  a4.criteria = Object.fromEntries(DQ_REASONS.map((r) => [r, words.setterDq.reasons[r]]));
  const dqHeld = [words.setterDq.result, ...Object.values(words.setterDq.reasons)].some(isPlaceholderCopy);
  if (dqHeld) a4.title = "Jev: why disqualified? [placeholder: the company's DQ reasons are not written yet]";
  out.push({ workflow: "setter-call-logged", definition: scl as unknown as Record<string, unknown>,
    note: `${company}: why a setter DQs a lead, in the company's words (installs/${company}/words.json)${dqHeld ? "; still placeholders" : ""}, not Hair's (D118)` });
  return out;
}

const OBJECTION_LINE = /"primary_objection": "price"(?: \| "[a-z_]+")* \| ""/;
/**
 * The company's own call prompts, from the shipped defaults: the Sales Call's objection options are its own (salesCall.objections),
 * and a setter's triage does not ask about a medical reason. Bound at install as prompt.<name> (the company's text wins).
 */
export function datingPrompts(objections: string[]): Record<string, string> {
  const line = `"primary_objection": ${[...objections, ""].map((o) => JSON.stringify(o)).join(" | ")}`;
  const own = (name: string) => { const p = defaultPrompts[name]; if (!OBJECTION_LINE.test(p)) throw new Error(`prompt ${name} has no objection line`); return p.replace(OBJECTION_LINE, line); };
  const triage = defaultPrompts.setter_call_notes;
  if (!triage.includes("decision maker, medical)")) throw new Error("setter_call_notes has no medical triage line");
  return { call_notes: own("call_notes"), call_review: own("call_review"), setter_call_notes: triage.replace("decision maker, medical)", "decision maker)") };
}
