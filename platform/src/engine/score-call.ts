import type { Analyst, Classifier } from "@/adapters/types";

/**
 * D272 (Tyler, 2026-10-31: the setter call scored as the Zap scored it, "8 category score, dq and academy tags"). A call is scored
 * against the offer's own rubric, a setting (`prompt.setter_call_rubric`), never words in code. Three hands, as the Zap split them:
 *   Jev      every DECISION: whether each category came up (a noul), its 0-2 level (a score), the disqualifier and tag questions.
 *   Claude   every SENTENCE: the summary and one line under each score. It explains the scores; it never sets them.
 *   This     all ARITHMETIC: the fit total, N/A dropped from the denominator, normalised to /10, the form's revenue read.
 * A category that never came up is N/A (out of the denominator), never a 0. A gate the setter never covered scores 1 and is flagged,
 * so skipping the question never scores higher than asking it. Fewer evidenced categories than `min_scored` is no number at all.
 * Jev or Claude down never loses the call: the post says which half is missing.
 */
export type Level3 = [string, string, string];
export type RubricCategory = {
  key: string; label: string; source: "call" | "crm"; gate?: boolean;
  topic?: string; rate?: string; levels: Level3;
  /** fills the gap when the call did not cover it: a form answer read by Jev, or a revenue range read in code against `cutoffs` */
  form?: { field: string; read: "jev" | "revenue"; cutoffs?: [number, number] };
  /** source crm: these form answers all filled is a 2, some a 1, none N/A (a lead who came in another way is not punished) */
  answered_of?: string[];
};
export type Rubric = {
  offer?: string; speakers?: string;
  discussed_at?: number; low_confidence?: number; min_scored?: number; max_state_chars?: number;
  tiers: { min: number; label: string }[];
  /** the form answers both models may read, by the contact field's bound name (crm.field_contact_<name>) → how to say it */
  form_fields?: Record<string, string>;
  categories: RubricCategory[];
  dq_from_scores?: { key: string; when: number; reason: string }[];
  dq_questions?: Record<string, { reason: string; instructions: string }>;
  bonus_tags?: Record<string, { label: string; instructions: string }>;
};
export type CategoryScore = { score: number; source: "call" | "form" | "crm" | "unknown"; confidence: number | null };
export type ScoreResult = {
  ran: boolean; why?: string; fit: number | null; fit_text: string; tier: string; scored: number; evidenced: number; total: number;
  scores: Record<string, CategoryScore & { label: string }>; dq: string[]; tags: string[]; gates_failed: string[]; gates_unknown: string[];
  summary: string; /** the summary as the Zap set it in Slack, in italics and quotes, or nothing */ summary_slack: string; notes: Record<string, string>; ai_error?: string; jev_error?: string;
  /** the block for Slack (mrkdwn) and the same in plain text for the CRM note */
  slack: string; plain: string;
};

const DEFAULTS = { discussed_at: 0.5, low_confidence: 0.4, min_scored: 3, max_state_chars: 100_000 };

/** The rubric as the offer wrote it, or why it cannot be used. */
export function parseRubric(raw: string | undefined | null): { ok: true; rubric: Rubric } | { ok: false; why: string } {
  if (!raw || !raw.trim()) return { ok: false, why: "no rubric: set prompt.setter_call_rubric for this offer" };
  let r: Rubric;
  try { r = JSON.parse(raw) as Rubric; } catch (e) { return { ok: false, why: `the rubric is not JSON: ${(e as Error).message}` }; }
  if (!Array.isArray(r.categories) || !r.categories.length) return { ok: false, why: "the rubric has no categories" };
  for (const c of r.categories) {
    if (!c.key || !c.label || !Array.isArray(c.levels) || c.levels.length !== 3) return { ok: false, why: `category ${c.key ?? "?"} needs a key, a label and exactly 3 levels (0, 1, 2)` };
    if (c.source !== "call" && c.source !== "crm") return { ok: false, why: `category ${c.key}: source is call or crm` };
    if (c.source === "call" && (!c.topic || !c.rate)) return { ok: false, why: `category ${c.key}: a call category needs topic and rate` };
  }
  if (!Array.isArray(r.tiers) || !r.tiers.length) return { ok: false, why: "the rubric has no tiers" };
  return { ok: true, rubric: r };
}

/** The form answers a rubric reads, by the contact field's bound name (crm.field_contact_<name>). */
export const rubricFields = (r: Rubric): string[] => [...new Set([...Object.keys(r.form_fields ?? {}), ...r.categories.flatMap((c) => [...(c.form ? [c.form.field] : []), ...(c.answered_of ?? [])])])];

/** A revenue answer ("5-10k", "$4,000 - $8,000", "21k+") read by its lower bound against the rubric's cutoffs; unreadable is N/A, never a guess. */
export function revenueScore(value: unknown, cutoffs: [number, number]): number | null {
  const s = String(value ?? "").toLowerCase().replace(/[$,\s]/g, "");
  const m = s.match(/(\d+(?:\.\d+)?)(k)?/);
  if (!m) return null;
  const n = Number(m[1]);
  const lower = m[2] || n < 1000 ? n * 1000 : n;
  return lower < cutoffs[0] ? 0 : lower < cutoffs[1] ? 1 : 2;
}

/** A Score answer's most likely level. */
export function topLevel(answer: unknown): number | null {
  const p = (answer as { probabilities?: Record<string, number> } | undefined)?.probabilities;
  if (!p) return null;
  let best: string | null = null;
  for (const [k, v] of Object.entries(p)) if (best === null || v > p[best]) best = k;
  return best === null || !Number.isFinite(Number(best)) ? null : Number(best);
}

const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));
export const tierOf = (fit: number, tiers: Rubric["tiers"]) => [...tiers].sort((a, b) => b.min - a.min).find((t) => fit >= t.min)?.label ?? "";

/** The arithmetic and the flags, from Jev's answers (none when Jev did not run). Pure: the tests hold it. */
export function tally(rubric: Rubric, answers: Record<string, Record<string, unknown>> | null, form: Record<string, string>) {
  const at = rubric.discussed_at ?? DEFAULTS.discussed_at;
  const scores: Record<string, CategoryScore> = {};
  const dq: string[] = [], tags: string[] = [];
  if (answers) {
    for (const c of rubric.categories.filter((x) => x.source === "call")) {
      const discussed = answers[`${c.key}__discussed`]?.noul, sc = answers[`${c.key}__score`];
      const lvl = topLevel(sc);
      if (typeof discussed === "number" && discussed >= at && lvl !== null) scores[c.key] = { score: lvl, source: "call", confidence: typeof sc?.confidence === "number" ? sc.confidence : null };
    }
    for (const [k, q] of Object.entries(rubric.dq_questions ?? {})) if (Number(answers[k]?.noul) >= at) dq.push(q.reason);
    for (const [k, t] of Object.entries(rubric.bonus_tags ?? {})) if (Number(answers[k]?.noul) >= at) tags.push(t.label);
    // the form only fills a gap: when the call covered it, the call wins (more recent, and said to a person)
    for (const c of rubric.categories) {
      if (scores[c.key] || !c.form) continue;
      if (c.form.read === "jev") { const a = answers[`${c.key}__form`]; const lvl = topLevel(a); if (lvl !== null) scores[c.key] = { score: lvl, source: "form", confidence: typeof a?.confidence === "number" ? a.confidence : null }; }
      else { const lvl = revenueScore(form[c.form.field], c.form.cutoffs ?? [4000, 8000]); if (lvl !== null) scores[c.key] = { score: lvl, source: "form", confidence: 1 }; }
    }
    for (const c of rubric.categories.filter((x) => x.source === "crm" && x.answered_of?.length)) {
      const n = c.answered_of!.filter((f) => !!form[f]).length;
      if (n) scores[c.key] = { score: n === c.answered_of!.length ? 2 : 1, source: "crm", confidence: 1 };
    }
    // a gate nobody asked about is not a free pass: 1, flagged
    for (const c of rubric.categories.filter((x) => x.gate)) if (!scores[c.key]) scores[c.key] = { score: 1, source: "unknown", confidence: null };
    for (const d of [...(rubric.dq_from_scores ?? [])].reverse()) if (scores[d.key]?.score === d.when && scores[d.key].source !== "unknown") dq.unshift(d.reason);
  }
  const scored = rubric.categories.filter((c) => scores[c.key]);
  const evidenced = scored.filter((c) => scores[c.key].source !== "unknown");
  let fit: number | null = null;
  if (answers && evidenced.length >= (rubric.min_scored ?? DEFAULTS.min_scored)) {
    const total = scored.reduce((s, c) => s + scores[c.key].score, 0);
    fit = Math.round((total / (scored.length * 2)) * 100) / 10;
  }
  return {
    scores, dq: [...new Set(dq)], tags, fit, scored: scored.length, evidenced: evidenced.length, total: rubric.categories.length,
    gates_failed: rubric.categories.filter((c) => c.gate && scores[c.key]?.score === 0 && scores[c.key].source !== "unknown").map((c) => c.label),
    gates_unknown: rubric.categories.filter((c) => c.gate && scores[c.key]?.source === "unknown").map((c) => c.label),
  };
}

/** Jev's questions for one call: per call category "did it come up" and "how good", the form fills, the disqualifiers and tags. */
export function jevQuestions(rubric: Rubric, form: Record<string, string>): Record<string, Record<string, unknown>> {
  const q: Record<string, Record<string, unknown>> = {};
  for (const c of rubric.categories.filter((x) => x.source === "call")) {
    q[`${c.key}__discussed`] = { type: "noul", instructions: `In \`call_transcript\`, does the prospect say anything about ${c.topic}?`, criteria: { true: "The prospect gives some information on this, even vague", false: "The subject never comes up" } };
    q[`${c.key}__score`] = { type: "score", instructions: `Using only \`call_transcript\`, rate ${c.rate}.`, criteria: c.levels };
  }
  for (const c of rubric.categories) if (c.form?.read === "jev" && form[c.form.field]) q[`${c.key}__form`] = { type: "score", instructions: `Using only \`form_answers.${c.form.field}\`, rate ${c.rate ?? c.label}.`, criteria: c.levels };
  for (const [k, d] of Object.entries({ ...(rubric.dq_questions ?? {}), ...(rubric.bonus_tags ?? {}) })) q[k] = { type: "noul", instructions: d.instructions };
  return q;
}

/** What Claude is told about the scores (it explains them; it does not re-score). */
export function scoreLines(rubric: Rubric, scores: Record<string, CategoryScore>): string {
  return rubric.categories.map((c) => {
    const s = scores[c.key];
    if (!s) return `${c.key} (${c.label}): N/A, not discussed`;
    if (s.source === "unknown") return `${c.key} (${c.label}): UNKNOWN, the setter did not cover it`;
    const from = { call: "the call", form: "the form", crm: "CRM form data", unknown: "" }[s.source];
    return `${c.key} (${c.label}): ${s.score} of 2, from ${from}. Rubric for that level: ${c.levels[s.score]}`;
  }).join("\n");
}

/** The fit block as the Zap posted it: the number, the flags above the breakdown, one line per category with Claude's note. */
export function fitBlock(rubric: Rubric, t: ReturnType<typeof tally>, notes: Record<string, string>, why?: string): { slack: string; plain: string } {
  const low = rubric.low_confidence ?? DEFAULTS.low_confidence;
  const lowConf = (c: number | null) => typeof c === "number" && c < low;
  const lines: string[] = [];
  if (why) lines.push(`_${why}_`);
  else {
    lines.push(t.fit === null
      ? `*Fit Quality: Insufficient data to score* (${t.evidenced} of ${t.total} categories came up)`
      : `*Fit Quality: ${fmt(t.fit)}/10 · ${tierOf(t.fit, rubric.tiers)}*${t.scored < t.total ? ` (${t.scored} of ${t.total} scored)` : ""}`);
    if (t.dq.length) lines.push(`:red_circle: *DQ Recommended:* ${t.dq.join("; ")}`);
    for (const g of t.gates_failed) lines.push(`:red_circle: *Gate failed:* ${g}`);
    for (const g of t.gates_unknown) lines.push(`:large_yellow_circle: *Needs review:* setter didn't cover ${g}`);
    for (const tag of t.tags) lines.push(`:label: ${tag}`);
    lines.push("");
    for (const c of rubric.categories) {
      const s = t.scores[c.key], note = notes[c.key];
      const value = !s ? "N/A" : s.source === "unknown" ? "1 (unknown)" : `${s.score}${s.source === "form" ? " (form)" : ""}${lowConf(s.confidence) ? " (low confidence)" : ""}`;
      lines.push(`${c.label}: ${value}${s && s.source !== "unknown" && note ? ` · ${note}` : ""}`);
    }
  }
  const slack = lines.join("\n");
  return { slack, plain: toPlain(slack) };
}

/** Slack markup out, for a CRM note (GHL does not render it). Only *bold* and _italic_ wrappers go, never a * or _ inside the words. */
export const toPlain = (s: string) => s
  .replace(/<([^|>]+)\|([^>]+)>/g, "$2")
  .replace(/:red_circle: /g, "[RED] ").replace(/:large_yellow_circle: /g, "[YELLOW] ").replace(/:label: /g, "[TAG] ")
  .replace(/\*([^*\n]+)\*/g, "$1")
  .replace(/(^|\s)_([^\n]+?)_(?=\s|$)/gm, "$1$2");

export type ScoreDeps = { classifier: Classifier; analyst: Analyst; jevKey?: string; anthropicKey?: string };

/** Score one call. Never throws for a model outage: what is missing is said in the result and the block. */
export async function scoreCall(deps: ScoreDeps, args: { rubric: Rubric; prompt: string; transcript: string; form: Record<string, string>; about: string; model?: string }): Promise<ScoreResult> {
  const { rubric, transcript, form } = args;
  const base = { scores: {}, dq: [], tags: [], gates_failed: [], gates_unknown: [], summary: "", summary_slack: "", notes: {}, fit: null, fit_text: "", tier: "", scored: 0, evidenced: 0, total: rubric.categories.length };
  // Jev: every decision
  let answers: Record<string, Record<string, unknown>> | null = null, jevError: string | undefined;
  const maxState = rubric.max_state_chars ?? DEFAULTS.max_state_chars;
  if (transcript.length > maxState) jevError = `transcript too long for Jev (${transcript.length} chars)`;
  else if (!deps.jevKey) jevError = "no Jev key for this offer";
  else if (!deps.classifier.ask) jevError = "this engine has no Jev scorer";
  else {
    const state = { program: rubric.offer ?? "", note: rubric.speakers ?? "", form_answers: form, call_transcript: transcript };
    const r = await deps.classifier.ask(deps.jevKey, state, jevQuestions(rubric, form));
    if ("error" in r) jevError = r.error; else answers = r.answers;
  }
  const t = tally(rubric, answers, form);
  // Claude: every sentence
  let summary = "", notes: Record<string, string> = {}, aiError: string | undefined;
  if (!deps.anthropicKey) aiError = "no Anthropic key for this offer";
  else {
    const formLines = Object.entries(rubric.form_fields ?? {}).map(([f, said]) => `- ${said}: ${form[f] || "(blank)"}`);
    const input = [args.about, "", "Scores:", answers ? scoreLines(rubric, t.scores) : "(not scored)", ...(t.dq.length ? ["", `Flagged as possible disqualifiers: ${t.dq.join("; ")}`] : []),
      ...(formLines.length ? ["", "Form answers:", ...formLines] : []), "", "Transcript (speaker numbers; one is the setter, one the prospect):", "", transcript].join("\n");
    const system = [args.prompt.trim(), rubric.offer ? `\n${rubric.offer}` : "", `\nAnswer with JSON: {"summary": "...", "notes": {${rubric.categories.map((c) => `"${c.key}": "..."`).join(", ")}}}`].join("");
    try {
      const r = await deps.analyst.analyze(deps.anthropicKey, { system, input, format: "json", maxTokens: 4000, ...(args.model ? { model: args.model } : {}) });
      if (r.refused) aiError = "refused";
      else if (!r.parsed || typeof r.parsed !== "object") aiError = r.parseError ?? "no output";
      else { const p = r.parsed as { summary?: unknown; notes?: Record<string, unknown> }; summary = String(p.summary ?? "").trim(); notes = Object.fromEntries(Object.entries(p.notes ?? {}).map(([k, v]) => [k, String(v ?? "").trim()])); }
    } catch (e) { aiError = String((e as Error).message).slice(0, 160); }
  }
  const why = !answers ? `Scoring unavailable: ${jevError}.` : undefined;
  const block = fitBlock(rubric, t, notes, why);
  const tail = aiError ? `\n\n_Summary step failed: ${aiError}._` : "";
  return {
    ...base, ...t, ran: !!answers, ...(why ? { why } : {}), fit_text: t.fit === null ? "" : fmt(t.fit), tier: t.fit === null ? "" : tierOf(t.fit, rubric.tiers),
    scores: Object.fromEntries(Object.entries(t.scores).map(([k, s]) => [k, { ...s, label: rubric.categories.find((c) => c.key === k)!.label }])),
    summary: summary.replace(/"/g, "'"), summary_slack: summary ? `_"${summary.replace(/"/g, "'")}"_` : "", notes, ...(aiError ? { ai_error: aiError } : {}), ...(jevError ? { jev_error: jevError } : {}),
    slack: block.slack + tail, plain: block.plain + (aiError ? `\n\nSummary step failed: ${aiError}.` : ""),
  };
}
