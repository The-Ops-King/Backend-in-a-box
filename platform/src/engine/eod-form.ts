/**
 * The end-of-day form's shape (D34): what a call can end as, and which questions follow each outcome. Pure: no database,
 * safe to import from the browser. A company's own copy lives in `forms` (purpose 'eod') and is merged over these
 * defaults by `mergeEodFields`, so every label, required flag, option list and extra question is theirs to set, while
 * the engine keeps the keys it reasons about (outcome, revenue, cash, next_date...).
 */
/** An outcome's value: a key of the company's own list (B6, D88). The defaults below are the ones every company starts with. */
export type CallOutcome = string;
/** What an outcome means to the engine: whether they came (attendance) and, for a call that happened, the call outcome category it files (D83: pending is half a close, never a close). */
export type Attendance = "showed" | "noshow" | "rescheduled";
export type CallMeaning = "closed" | "deposit" | "pending" | "follow_up" | "lost" | "unqualified" | "qualified";
/** D143: what a call is on the form: a closing call (the company's outcome list) or a triage call (its own list: set, follow up, DQ, not interested; no money). */
export type CallKind = "closing" | "triage";
/** One answer to "what happened on the call?": the company's label over a meaning. `money`: cash and revenue are asked and counted (closed, deposit by default). */
export type OutcomeChoice = { value: string; label: string; attendance: Attendance; call_outcome?: CallMeaning | null; money?: boolean };
export const DEFAULT_OUTCOMES: OutcomeChoice[] = [
  { value: "closed", label: "Closed", attendance: "showed", call_outcome: "closed", money: true },
  { value: "deposit", label: "Deposit", attendance: "showed", call_outcome: "deposit", money: true },
  { value: "pending", label: "Close pending", attendance: "showed", call_outcome: "pending" },
  { value: "follow_up", label: "Follow up", attendance: "showed", call_outcome: "follow_up" },
  { value: "lost", label: "Lost", attendance: "showed", call_outcome: "lost" },
  { value: "dq", label: "DQ", attendance: "showed", call_outcome: "unqualified" },
  { value: "rescheduled", label: "Rescheduled / cancelled on the call", attendance: "rescheduled" },
  { value: "no_show", label: "No-show", attendance: "noshow" },
];
/** D143: a triage call's answers. "Set" is a call outcome of qualified; not interested is lost; no money is asked. */
export const TRIAGE_OUTCOMES: OutcomeChoice[] = [
  { value: "set", label: "Set (booked a closing call)", attendance: "showed", call_outcome: "qualified" },
  { value: "follow_up", label: "Follow up", attendance: "showed", call_outcome: "follow_up" },
  { value: "dq", label: "DQ", attendance: "showed", call_outcome: "unqualified" },
  { value: "not_interested", label: "Not interested", attendance: "showed", call_outcome: "lost" },
  { value: "rescheduled", label: "Rescheduled / cancelled on the call", attendance: "rescheduled" },
  { value: "no_show", label: "No-show", attendance: "noshow" },
];
/** What the Discovery Call record says for each triage meaning (its call_result options), and for each attendance (its outcome). */
export const TRIAGE_RESULT: Partial<Record<CallMeaning, string>> = { qualified: "set", follow_up: "follow_up", unqualified: "dq", lost: "not_interested" };
/** @deprecated the defaults; a company's list is `outcomesOf(fields)` */
export const OUTCOMES = DEFAULT_OUTCOMES;
/** The company's list: the choices on its outcome field, else the defaults. */
export const outcomesOf = (fields?: EodField[] | null): OutcomeChoice[] => fields?.find((f) => f.key === "outcome")?.choices?.length ? fields.find((f) => f.key === "outcome")!.choices! : DEFAULT_OUTCOMES;
/** The answers a call of this kind takes (D143). */
export const outcomesFor = (kind: CallKind | undefined, fields?: EodField[] | null): OutcomeChoice[] => (kind === "triage" ? TRIAGE_OUTCOMES : outcomesOf(fields));
export const choiceOf = (v: string, fields?: EodField[] | null, kind?: CallKind): OutcomeChoice | undefined => outcomesFor(kind, fields).find((o) => o.value === v);
export const outcomeLabel = (v: string, fields?: EodField[] | null, kind?: CallKind) => choiceOf(v, fields, kind)?.label ?? (v || "blank");
/** Money changes hands: cash and revenue are asked and counted (never on a triage call). */
export const isMoney = (v: string, fields?: EodField[] | null, kind?: CallKind) => { const o = choiceOf(v, fields, kind); return kind !== "triage" && !!o && (o.money ?? (o.call_outcome === "closed" || o.call_outcome === "deposit")); };
/** D119: revenue contracted is asked and counted only on a close: a deposit's cash counts, its revenue does not. */
const isRevenue = (o: OutcomeChoice) => o.call_outcome !== "deposit" && (o.money ?? o.call_outcome === "closed");
export const isRevenueOutcome = (v: string, fields?: EodField[] | null, kind?: CallKind) => { const o = choiceOf(v, fields, kind); return kind !== "triage" && !!o && isRevenue(o); };
/** The value of the company's first answer with this meaning (how the ledger's outcome shows on the form); "" when it has none. */
export function valueFor(fields: EodField[] | null | undefined, m: { attendance?: Attendance; call_outcome?: CallMeaning }, kind?: CallKind): string {
  const list = outcomesFor(kind, fields);
  if (m.call_outcome) return list.find((o) => o.call_outcome === m.call_outcome)?.value ?? "";
  return (list.find((o) => o.attendance === m.attendance && !o.call_outcome) ?? list.find((o) => o.attendance === m.attendance))?.value ?? "";
}
/** @deprecated by meaning: kept for callers that read the default values */
export const HELD: CallOutcome[] = DEFAULT_OUTCOMES.filter((o) => o.attendance === "showed").map((o) => o.value);
export const MONEY: CallOutcome[] = ["closed", "deposit"];

export type FieldType = "select" | "text" | "textarea" | "money" | "number" | "date";
export type EodField = {
  key: string; label: string; type: FieldType;
  scope: "call" | "day";          // asked per call, or once for the day
  when?: CallOutcome[];           // call scope: shown only after one of these outcomes is picked; absent = after any outcome
  required: boolean;
  options?: string[];             // select
  choices?: OutcomeChoice[];      // the outcome field only: the company's list of answers and what each means (B6, D88)
  help?: string;
  builtin?: boolean;              // the engine reads this key; label/required/options are editable, the key and type are not
};

export const DQ_REASONS = ["Can't afford it", "Not the decision maker", "Not a fit for the program", "Not serious, just looking", "Other"];
export const LOST_REASONS = ["Price", "Timing", "Fit", "Ghosted", "Other"];
/** Which answers a builtin follows, by what the answer means (B6: the company's own values change, the meaning does not). */
const FOLLOWS: Record<string, (o: OutcomeChoice) => boolean> = {
  cash: (o) => o.money ?? (o.call_outcome === "closed" || o.call_outcome === "deposit"), revenue: (o) => isRevenue(o),
  next_date: (o) => o.call_outcome === "follow_up", next_steps: (o) => o.call_outcome === "follow_up",
  dq_reason: (o) => o.call_outcome === "unqualified", dq_note: (o) => o.call_outcome === "unqualified", lost_reason: (o) => o.call_outcome === "lost",
  about: (o) => o.attendance === "showed",
};

export const BUILTIN_FIELDS: EodField[] = [
  { key: "outcome", label: "What happened on the call?", type: "select", scope: "call", required: true, builtin: true },
  { key: "cash", label: "Cash collected ($)", type: "money", scope: "call", when: ["closed", "deposit"], required: true, builtin: true },
  { key: "revenue", label: "Revenue generated ($)", type: "money", scope: "call", when: ["closed"], required: true, builtin: true },
  { key: "next_date", label: "Next follow-up", type: "date", scope: "call", when: ["follow_up"], required: true, builtin: true },
  { key: "next_steps", label: "Next steps", type: "text", scope: "call", when: ["follow_up"], required: true, builtin: true },
  { key: "dq_reason", label: "Why were they a DQ?", type: "select", scope: "call", when: ["dq"], required: true, options: DQ_REASONS, builtin: true },
  { key: "dq_note", label: "DQ note", type: "textarea", scope: "call", when: ["dq"], required: false, builtin: true },
  { key: "lost_reason", label: "Why were they lost?", type: "select", scope: "call", when: ["lost"], required: true, options: LOST_REASONS, builtin: true },
  { key: "about", label: "About this prospect", type: "textarea", scope: "call", when: HELD, required: false, builtin: true },
  { key: "notes", label: "Notes", type: "textarea", scope: "call", required: false, builtin: true },
  { key: "general_notes", label: "Anything else about today?", type: "textarea", scope: "day", required: false, builtin: true },
];
const BUILTIN = new Map(BUILTIN_FIELDS.map((f) => [f.key, f]));
// a default label we later renamed: a company that saved the form with it never chose it, so it follows the new default
const RETIRED_LABELS: Record<string, string[]> = { revenue: ["Contract value ($)"] };

/** The company's list over the defaults: every builtin present (their label, required, options kept; key, type, scope, when fixed), extras kept as stored. */
export function mergeEodFields(stored: EodField[] | null | undefined): EodField[] {
  const own = new Map((stored ?? []).map((f) => [f.key, f]));
  const choices = cleanChoices(own.get("outcome")?.choices);
  const out: EodField[] = BUILTIN_FIELDS.map((b) => {
    const s = own.get(b.key);
    const f: EodField = s ? { ...b, label: s.label && !RETIRED_LABELS[b.key]?.includes(s.label) ? s.label : b.label, required: !!s.required, help: s.help || undefined, options: b.type === "select" && b.key !== "outcome" ? (s.options?.length ? s.options : b.options) : undefined } : { ...b };
    if (b.key === "outcome") f.choices = choices;
    else if (FOLLOWS[b.key]) f.when = choices.filter(FOLLOWS[b.key]).map((o) => o.value);   // the builtins follow what an answer means, whatever the company calls it
    return f;
  });
  for (const f of stored ?? []) if (!BUILTIN.has(f.key) && f.key) out.push({ ...f, builtin: false, when: f.scope === "call" && f.when?.length ? f.when : undefined, options: f.type === "select" ? f.options ?? [] : undefined });
  return out;
}

/** The company's outcome list as stored, each entry checked; nothing usable stored = the defaults. */
function cleanChoices(stored?: OutcomeChoice[]): OutcomeChoice[] {
  const ok = (stored ?? []).filter((o) => o && typeof o.value === "string" && o.value.trim() && typeof o.label === "string" && ["showed", "noshow", "rescheduled"].includes(o.attendance))
    .map((o) => ({ value: o.value.trim(), label: o.label.trim() || o.value.trim(), attendance: o.attendance, ...(o.attendance === "showed" && o.call_outcome ? { call_outcome: o.call_outcome } : {}), ...(o.money !== undefined ? { money: !!o.money } : {}) }));
  return ok.length ? ok : DEFAULT_OUTCOMES.map((o) => ({ ...o }));
}

/** Fields that apply to a call that ended this way (none until an outcome is picked). A triage call (D143) asks only why a DQ, about them when they came, and notes. */
export function fieldsFor(fields: EodField[], outcome: CallOutcome, kind?: CallKind): EodField[] {
  if (!outcome) return [];
  if (kind === "triage") {
    const o = choiceOf(outcome, fields, kind);
    return fields.filter((f) => f.scope === "call" && (f.key === "notes" || (f.key === "about" && o?.attendance === "showed") || ((f.key === "dq_reason" || f.key === "dq_note") && o?.call_outcome === "unqualified")));
  }
  return fields.filter((f) => f.scope === "call" && f.key !== "outcome" && (!f.when || f.when.includes(outcome)));
}
export const dayFields = (fields: EodField[]) => fields.filter((f) => f.scope === "day");

export type CallEntry = {
  appointment_id: string; contact_id: string; contact: string; starts_at: string; href_contact: string | null; recording_url: string | null;
  kind?: CallKind;                                     // D143: absent on a report filed before triage calls were on the form: a closing call
  outcome: CallOutcome;
  hint?: string;                                       // why the outcome is blank (no evidence to pre-fill from)
  moved?: string;                                      // A1 (D88): a card dragged in the CRM filed this outcome; the form says so and asks why
  revenue: number | null; cash: number | null;        // cash: closed, deposit; revenue: closed only (D119)
  next_date: string | null; next_steps: string;        // follow up
  dq_reason: string; dq_note: string;                  // dq
  lost_reason?: string;                                // lost (A1, D88: a card dragged to Lost asks why on the form)
  about: string; notes: string;
  extra: Record<string, string>;                       // the company's own questions, by key
};
export type DayTotals = { calls_count: number; closes: number; deposits: number; cash: number; revenue: number };
/** The day's totals by what each answer means: a close is a closed call outcome (never pending, D83), a deposit its own count. */
export const totalsOf = (calls: CallEntry[], fields?: EodField[] | null): DayTotals => ({
  calls_count: calls.length,
  closes: calls.filter((c) => c.kind !== "triage" && choiceOf(c.outcome, fields)?.call_outcome === "closed").length,
  deposits: calls.filter((c) => c.kind !== "triage" && choiceOf(c.outcome, fields)?.call_outcome === "deposit").length,
  cash: calls.reduce((s, c) => s + (isMoney(c.outcome, fields, c.kind) ? Number(c.cash ?? 0) : 0), 0),
  revenue: calls.reduce((s, c) => s + (isRevenueOutcome(c.outcome, fields, c.kind) ? Number(c.revenue ?? 0) : 0), 0),
});

/** The value a call carries for a field key, as text: "" when nothing. */
export function valueOf(call: CallEntry, key: string): string {
  switch (key) {
    case "outcome": return call.outcome;
    case "revenue": case "cash": return call[key] == null ? "" : String(call[key]);
    case "next_date": return call.next_date ?? "";
    case "next_steps": case "dq_reason": case "dq_note": case "about": case "notes": case "lost_reason": return call[key] ?? "";
    default: return call.extra?.[key] ?? "";
  }
}

/** Required answers that are blank, as lines a person reads: "Sarah Kim: Next steps". Empty when the day is complete. */
export function missingAnswers(fields: EodField[], calls: CallEntry[], day: Record<string, string>): string[] {
  const out: string[] = [];
  for (const call of calls) {
    const outcomeField = fields.find((f) => f.key === "outcome")!;
    if (!call.outcome) { if (outcomeField.required) out.push(`${call.contact}: ${outcomeField.label}`); continue; }
    if (!choiceOf(call.outcome, fields, call.kind)) { out.push(`${call.contact}: ${outcomeField.label}`); continue; }
    for (const f of fieldsFor(fields, call.outcome, call.kind)) if (f.required && valueOf(call, f.key).trim() === "") out.push(`${call.contact}: ${f.label}`);
  }
  for (const f of dayFields(fields)) if (f.required && (day[f.key] ?? "").trim() === "") out.push(f.label);
  return out;
}

/** Answers that can't both be true: more cash collected on a call than the revenue it generated (a typo, or revenue left low). */
export function impossibleAnswers(calls: CallEntry[]): string[] {
  return calls.filter((x) => x.cash != null && x.revenue != null && x.cash > x.revenue).map((x) => `${x.contact}: cash collected is more than revenue generated`);
}
