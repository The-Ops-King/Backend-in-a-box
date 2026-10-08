/**
 * The end-of-day form's shape (D34): what a call can end as, and which questions follow each outcome. Pure: no database,
 * safe to import from the browser. A company's own copy lives in `forms` (purpose 'eod') and is merged over these
 * defaults by `mergeEodFields`, so every label, required flag, option list and extra question is theirs to set, while
 * the engine keeps the keys it reasons about (outcome, revenue, cash, next_date...).
 */
export type CallOutcome = "closed" | "deposit" | "follow_up" | "lost" | "dq" | "rescheduled" | "no_show" | "";
export const OUTCOMES: { value: Exclude<CallOutcome, "">; label: string }[] = [
  { value: "closed", label: "Closed" },
  { value: "deposit", label: "Deposit" },
  { value: "follow_up", label: "Follow up" },
  { value: "lost", label: "Lost" },
  { value: "dq", label: "DQ" },
  { value: "rescheduled", label: "Rescheduled / cancelled on the call" },
  { value: "no_show", label: "No-show" },
];
export const outcomeLabel = (v: string) => OUTCOMES.find((o) => o.value === v)?.label ?? (v || "blank");
/** Outcomes where a conversation happened: the showed path, where "about this prospect" makes sense. */
export const HELD: CallOutcome[] = ["closed", "deposit", "follow_up", "lost", "dq"];
/** Outcomes where money changes hands, counted in cash and revenue. */
export const MONEY: CallOutcome[] = ["closed", "deposit"];

export type FieldType = "select" | "text" | "textarea" | "money" | "number" | "date";
export type EodField = {
  key: string; label: string; type: FieldType;
  scope: "call" | "day";          // asked per call, or once for the day
  when?: CallOutcome[];           // call scope: shown only after one of these outcomes is picked; absent = after any outcome
  required: boolean;
  options?: string[];             // select
  help?: string;
  builtin?: boolean;              // the engine reads this key; label/required/options are editable, the key and type are not
};

export const DQ_REASONS = ["Can't afford it", "Not the decision maker", "Not a fit for the program", "Not serious, just looking", "Other"];

export const BUILTIN_FIELDS: EodField[] = [
  { key: "outcome", label: "What happened on the call?", type: "select", scope: "call", required: true, builtin: true },
  { key: "revenue", label: "Contract value ($)", type: "money", scope: "call", when: ["closed", "deposit"], required: true, builtin: true },
  { key: "cash", label: "Cash collected ($)", type: "money", scope: "call", when: ["closed", "deposit"], required: true, builtin: true },
  { key: "next_date", label: "Next follow-up", type: "date", scope: "call", when: ["follow_up"], required: true, builtin: true },
  { key: "next_steps", label: "Next steps", type: "text", scope: "call", when: ["follow_up"], required: true, builtin: true },
  { key: "dq_reason", label: "Why were they a DQ?", type: "select", scope: "call", when: ["dq"], required: true, options: DQ_REASONS, builtin: true },
  { key: "dq_note", label: "DQ note", type: "textarea", scope: "call", when: ["dq"], required: false, builtin: true },
  { key: "about", label: "About this prospect", type: "textarea", scope: "call", when: HELD, required: false, builtin: true },
  { key: "notes", label: "Notes", type: "textarea", scope: "call", required: false, builtin: true },
  { key: "general_notes", label: "Anything else about today?", type: "textarea", scope: "day", required: false, builtin: true },
];
const BUILTIN = new Map(BUILTIN_FIELDS.map((f) => [f.key, f]));

/** The company's list over the defaults: every builtin present (their label, required, options kept; key, type, scope, when fixed), extras kept as stored. */
export function mergeEodFields(stored: EodField[] | null | undefined): EodField[] {
  const own = new Map((stored ?? []).map((f) => [f.key, f]));
  const out: EodField[] = BUILTIN_FIELDS.map((b) => { const s = own.get(b.key); return s ? { ...b, label: s.label || b.label, required: !!s.required, help: s.help || undefined, options: b.type === "select" ? (s.options?.length ? s.options : b.options) : undefined } : { ...b }; });
  for (const f of stored ?? []) if (!BUILTIN.has(f.key) && f.key) out.push({ ...f, builtin: false, when: f.scope === "call" && f.when?.length ? f.when : undefined, options: f.type === "select" ? f.options ?? [] : undefined });
  return out;
}

/** Fields that apply to a call that ended this way (none until an outcome is picked). */
export const fieldsFor = (fields: EodField[], outcome: CallOutcome) => (outcome ? fields.filter((f) => f.scope === "call" && f.key !== "outcome" && (!f.when || f.when.includes(outcome))) : []);
export const dayFields = (fields: EodField[]) => fields.filter((f) => f.scope === "day");

export type CallEntry = {
  appointment_id: string; contact_id: string; contact: string; starts_at: string; href_contact: string | null; recording_url: string | null;
  outcome: CallOutcome;
  revenue: number | null; cash: number | null;        // closed, deposit
  next_date: string | null; next_steps: string;        // follow up
  dq_reason: string; dq_note: string;                  // dq
  about: string; notes: string;
  extra: Record<string, string>;                       // the company's own questions, by key
};
export type DayTotals = { calls_count: number; closes: number; deposits: number; cash: number; revenue: number };
export const totalsOf = (calls: CallEntry[]): DayTotals => ({
  calls_count: calls.length,
  closes: calls.filter((c) => c.outcome === "closed").length,
  deposits: calls.filter((c) => c.outcome === "deposit").length,
  cash: calls.reduce((s, c) => s + (MONEY.includes(c.outcome) ? Number(c.cash ?? 0) : 0), 0),
  revenue: calls.reduce((s, c) => s + (MONEY.includes(c.outcome) ? Number(c.revenue ?? 0) : 0), 0),
});

/** The value a call carries for a field key, as text: "" when nothing. */
export function valueOf(call: CallEntry, key: string): string {
  switch (key) {
    case "outcome": return call.outcome;
    case "revenue": case "cash": return call[key] == null ? "" : String(call[key]);
    case "next_date": return call.next_date ?? "";
    case "next_steps": case "dq_reason": case "dq_note": case "about": case "notes": return call[key] ?? "";
    default: return call.extra?.[key] ?? "";
  }
}

/** Required answers that are blank, as lines a person reads: "Sarah Kim: Next steps". Empty when the day is complete. */
export function missingAnswers(fields: EodField[], calls: CallEntry[], day: Record<string, string>): string[] {
  const out: string[] = [];
  for (const call of calls) {
    const outcomeField = fields.find((f) => f.key === "outcome")!;
    if (!call.outcome) { if (outcomeField.required) out.push(`${call.contact}: ${outcomeField.label}`); continue; }
    for (const f of fieldsFor(fields, call.outcome)) if (f.required && valueOf(call, f.key).trim() === "") out.push(`${call.contact}: ${f.label}`);
  }
  for (const f of dayFields(fields)) if (f.required && (day[f.key] ?? "").trim() === "") out.push(f.label);
  return out;
}
