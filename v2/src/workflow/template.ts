import { FILTERS, FilterError, type RenderEnv, isAbsent, toText } from "./filters";

/**
 * Templates are text with `{{path | filter:arg | filter}}` in it. A path starts at one of the context's roots. A filter
 * argument is the text after the colon up to the next pipe, or a "quoted string" that may hold pipes, colons and spaces
 * (`\"` and `\\` inside it are escapes).
 */

/** What a run's context holds, by root. `now` is the render's own clock. */
export const ROOTS = [
  "contact", "appointment", "deal", "payment", "recording", "agreement", "event", "reply", "person", "offer", "run",
  "vars", "setting", "secret", "now",
] as const;
export type Root = (typeof ROOTS)[number];

const PATH = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)*$/;

export type FilterCall = { name: string; arg?: string };
export type Expr = { path: string; root: string; filters: FilterCall[]; source: string };
export type Span = { start: number; end: number; expr: Expr };
/** `bad`: where expressions with errors sit, so a render writes nothing there rather than the raw braces. */
export type ParsedTemplate = { spans: Span[]; bad: { start: number; end: number }[]; errors: string[] };

/** Splits one expression's text on pipes outside quoted arguments, and unquotes the arguments. */
function parseExpr(source: string): { expr?: Expr; errors: string[] } {
  const pieces: string[] = [];
  let cur = "", quoted = false;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i]!;
    if (quoted) {
      cur += ch;
      if (ch === "\\" && i + 1 < source.length) cur += source[++i];
      else if (ch === '"') quoted = false;
      continue;
    }
    if (ch === '"' && /:\s*$/.test(cur)) quoted = true;
    if (ch === "|") { pieces.push(cur.trim()); cur = ""; } else cur += ch;
  }
  if (quoted) return { errors: [`{{${source}}}: a quoted argument is not closed`] };
  pieces.push(cur.trim());
  const [path = "", ...rest] = pieces;
  const errors: string[] = [];
  if (!PATH.test(path)) errors.push(`{{${source}}}: "${path}" is not a path`);
  const root = path.split(".")[0] ?? "";
  if (PATH.test(path) && !(ROOTS as readonly string[]).includes(root)) errors.push(`{{${source}}}: "${root}" is not a context root (${ROOTS.join(", ")})`);
  if (root === "now" && path !== "now") errors.push(`{{${source}}}: now has no fields`);
  if ((root === "setting" || root === "secret" || root === "vars") && path === root) errors.push(`{{${source}}}: ${root} needs a name after it`);
  const filters: FilterCall[] = [];
  for (const piece of rest) {
    const at = piece.indexOf(":");
    const name = (at < 0 ? piece : piece.slice(0, at)).trim();
    let arg = at < 0 ? undefined : piece.slice(at + 1).trim();
    if (arg !== undefined && arg.length >= 2 && arg.startsWith('"') && arg.endsWith('"')) arg = arg.slice(1, -1).replace(/\\(["\\])/g, "$1");
    const def = FILTERS[name];
    if (!def) { errors.push(`{{${source}}}: unknown filter "${name}"`); continue; }
    if (def.arg === "none" && arg !== undefined) errors.push(`{{${source}}}: ${name} takes no argument`);
    if (def.arg === "required" && (arg === undefined || arg === "")) errors.push(`{{${source}}}: ${name} needs an argument`);
    if (arg !== undefined && arg !== "" && def.checkArg) { const m = def.checkArg(arg); if (m) errors.push(`{{${source}}}: ${name}: ${m}`); }
    filters.push(arg === undefined ? { name } : { name, arg });
  }
  return errors.length ? { errors } : { expr: { path, root, filters, source }, errors };
}

/** Every `{{…}}` in a template, with what is wrong with any of them. An unclosed `{{` or a stray `}}` is an error. */
export function parseTemplate(t: string): ParsedTemplate {
  const spans: Span[] = [], bad: { start: number; end: number }[] = [], errors: string[] = [];
  let i = 0, textFrom = 0;
  const strays = (from: number, to: number) => { if (t.slice(from, to).includes("}}")) errors.push(`a "}}" with no "{{" before it`); };
  while (i < t.length) {
    const open = t.indexOf("{{", i);
    if (open < 0) break;
    strays(textFrom, open);
    let j = open + 2, quoted = false;
    for (; j < t.length; j++) {
      if (quoted) { if (t[j] === "\\") j++; else if (t[j] === '"') quoted = false; continue; }
      if (t[j] === '"' && /:\s*$/.test(t.slice(open + 2, j))) quoted = true;
      else if (t[j] === "}" && t[j + 1] === "}") break;
    }
    if (j >= t.length) { errors.push(`a "{{" that is never closed`); return { spans, bad, errors }; }
    const source = t.slice(open + 2, j).trim();
    const p = source ? parseExpr(source) : { errors: ["an empty {{}}"] };
    errors.push(...p.errors);
    if (p.expr) spans.push({ start: open, end: j + 2, expr: p.expr });
    else bad.push({ start: open, end: j + 2 });
    i = textFrom = j + 2;
  }
  strays(textFrom, t.length);
  return { spans, bad, errors };
}

/** True when the whole string is one `{{…}}`: its value keeps its type (a number stays a number) in conditions and data. */
export function wholeExpr(t: string): Expr | undefined {
  const p = parseTemplate(t);
  const only = p.spans[0];
  return p.errors.length === 0 && p.spans.length === 1 && only && only.start === 0 && only.end === t.length ? only.expr : undefined;
}

export type Context = Record<string, unknown>;

export function resolvePath(ctx: Context, path: string, env: RenderEnv): unknown {
  if (path === "now") return env.now.toISOString();
  let cur: unknown = ctx;
  for (const part of path.split(".")) {
    if (cur === null || cur === undefined || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/** A value that came out empty where the template did not say it may: the message must not go out. */
export type Blank = { expr: string; path: string; reason: "missing" | "empty" };
export type ExprResult = { value: unknown; blank?: Blank; error?: string };

/** One expression's value, filters applied. Never throws: a refused filter is an `error`, an unintended empty a `blank`. */
export function evaluateExpr(expr: Expr, ctx: Context, env: RenderEnv): ExprResult {
  const raw = resolvePath(ctx, expr.path, env);
  let v = raw;
  try {
    for (const f of expr.filters) v = FILTERS[f.name]!.apply(v, f.arg, env);
  } catch (e) {
    const message = e instanceof FilterError ? e.message : `filter failed: ${String(e)}`;
    return { value: undefined, error: `{{${expr.source}}}: ${message}` };
  }
  const blankOk = expr.filters.some((f) => FILTERS[f.name]!.blankOk);
  if (isAbsent(v) && !blankOk) return { value: v, blank: { expr: expr.source, path: expr.path, reason: raw === undefined || raw === null ? "missing" : "empty" } };
  return { value: v };
}

export type Rendered = {
  text: string;
  /** Expressions that came out empty without an `optional`, `default`, `prefix`, `line` or `link` saying they may. */
  blanks: Blank[];
  /** Template mistakes and refused filters (a past time for `relative`, a date that is not one). */
  errors: string[];
};

/** Renders a template against a context. Never throws; a caller that sends refuses whenever `blanks` or `errors` is not empty. */
export function render(template: string, ctx: Context, env: RenderEnv): Rendered {
  const parsed = parseTemplate(template);
  const blanks: Blank[] = [], errors = [...parsed.errors];
  const pieces = [...parsed.spans, ...parsed.bad.map((b) => ({ ...b, expr: undefined }))].sort((a, b) => a.start - b.start);
  let text = "", at = 0;
  for (const s of pieces) {
    let value: unknown;
    if (s.expr) {
      const r = evaluateExpr(s.expr, ctx, env);
      if (r.blank) blanks.push(r.blank);
      if (r.error) errors.push(r.error);
      value = r.value;
    }
    text += template.slice(at, s.start) + toText(value);
    at = s.end;
  }
  return { text: text + template.slice(at), blanks, errors };
}

/** The setting keys a template reads: `{{setting.slack.channel.payments}}` → "slack.channel.payments". */
export const settingsIn = (t: string): string[] => parseTemplate(t).spans.filter((s) => s.expr.root === "setting").map((s) => s.expr.path.slice("setting.".length));
