import { asOperator, many, one } from "@/db/client";
import type { Adapters, Company } from "@/adapters/types";
import { formFields, liveTypeform, type TfResponse, type TypeformApi } from "@/adapters/typeform/client";
import { loadCompany } from "./context";
import { normEmail, normPhone } from "./identity";
import { carriesTag, scopeTag } from "./scope";
import { findInGhl, formsOf, parseResponse, submitApplication, TF_TOKEN_KEY, WRITTEN, type Found, type TypeformFormMap } from "./typeform";

/**
 * D122: the form's existing responses, through the same path as the webhook. Dry run (the default) reads Typeform and GHL
 * and writes nothing anywhere, and says what apply would do. Apply is a deliberate, one-off real write (as D115's backfill),
 * whatever the company's mode: Tyler approves the import as the last step. Oldest first, so a person who applied twice ends
 * with their latest answers; a response already written is skipped, so a re-run (or a batch after a batch) carries on where
 * it stopped. History starts nothing: no New lead, no workflow, unless `newLead` (D123): then each response the door never saw is
 * dispatched as `form.submitted` exactly as the webhook dispatches one, so New from Typeform tags them and starts New lead for
 * whoever is not a lead yet, once per person, in that workflow's own mode.
 */
export type DryRun = {
  form: { id: string; title: string }; at: string;
  responses: { completed: number; partial: number; started: number; first?: string; last?: string };
  people: number; unidentified: number;
  duplicates: { emails: number; responses: number; phones: number };
  ghl: { byEmail: number; byPhone: number; none: number; alreadyTagged: number; readErrors: number; errors: Record<string, number> };
  wouldWrite: { creates: number; updates: number; responses: number; keptStandard: Record<string, number>; tagAdds: number };
  fill: { target: string; question: string; filled: number; pct: number }[];
  hidden: { name: string; target: string; filled: number }[];
  unbound: string[]; alreadyWritten: number;
};

const pct = (n: number, d: number) => (d ? Math.round((n / d) * 1000) / 10 : 0);
const personKey = (email?: string, phone?: string) => normEmail(email) ?? (phone ? `phone:${normPhone(phone)}` : undefined);

/** Small pool: GHL allows about 100 requests per 10 s per location; four at a time stays well under it. */
async function eachLimited<T>(xs: T[], n: number, fn: (x: T) => Promise<void>) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, xs.length) }, async () => { while (i < xs.length) await fn(xs[i++]); }));
}

export async function dryRunImport(a: { token: string; formId: string; form: TypeformFormMap; bindings: Record<string, string>; ac: Company; adapters: Adapters; api?: TypeformApi; written?: Set<string>; concurrency?: number; retryMs?: number }): Promise<DryRun> {
  const api = a.api ?? liveTypeform;
  const [def, done, partial, started] = await Promise.all([api.getForm(a.token, a.formId), api.responses(a.token, a.formId, "completed"), api.responses(a.token, a.formId, "partial"), api.responses(a.token, a.formId, "started")]);
  const resp = [...done].sort((x, y) => String(x.submitted_at).localeCompare(String(y.submitted_at)));
  const titles = new Map(formFields(def).map((f) => [f.ref, f.title.replace(/\s+/g, " ").trim()]));
  const parsed = resp.map((r) => ({ r, p: parseResponse(a.form, r, a.bindings) }));
  const tag = scopeTag(a.bindings), tags = tag ? [tag] : [];

  // the people: one GHL read set per person (email, else phone), not per response
  const byPerson = new Map<string, { email?: string; phone?: string; n: number }>();
  let unidentified = 0;
  const phones = new Map<string, number>();
  for (const { p } of parsed) {
    const k = personKey(p.std.email, p.std.phone); if (!k) { unidentified++; continue; }
    const cur = byPerson.get(k) ?? { email: p.std.email, phone: p.std.phone, n: 0 }; cur.n++; byPerson.set(k, cur);
    const ph = normPhone(p.std.phone); if (ph) phones.set(ph, (phones.get(ph) ?? 0) + 1);
  }
  const found = new Map<string, Found | null>();
  let readErrors = 0;
  const errors: Record<string, number> = {};
  await eachLimited([...byPerson.entries()], a.concurrency ?? 3, async ([k, v]) => {
    // a read GHL did not answer is asked twice more, after a pause, before it is counted as unread (never as "not in GHL")
    for (let i = 0; ; i++) {
      try { found.set(k, await findInGhl(a.ac, a.adapters, v.email, v.phone)); return; }
      catch (e) {
        if (i < 2) { await new Promise((r) => setTimeout(r, a.retryMs ?? 5000)); continue; }
        readErrors++; const why = /\b(\d{3})\b/.exec(String((e as Error).message))?.[1] ?? String((e as Error).message).slice(0, 40); errors[why] = (errors[why] ?? 0) + 1; return;
      }
    }
  });
  const hits = [...byPerson.keys()].filter((k) => found.has(k)).map((k) => found.get(k)!);
  const keptStandard: Record<string, number> = {};
  let creates = 0, updates = 0, tagAdds = 0;
  const firstSeen = new Set<string>();
  for (const { p } of parsed) {
    const k = personKey(p.std.email, p.std.phone); if (!k || !found.has(k)) continue;   // unread: not guessed either way
    const f = found.get(k);
    if (!f && !firstSeen.has(k)) creates++; else updates++;
    if (!firstSeen.has(k)) tagAdds += tags.filter((t) => !carriesTag(f?.snap.tags, t)).length;
    firstSeen.add(k);
    if (f) for (const [std, key] of [["first_name", "firstName"], ["last_name", "lastName"], ["email", "email"], ["phone", "phone"]] as const) {
      const have = (f.snap as Record<string, unknown>)[key], mine = p.std[std];
      if (typeof have === "string" && have.trim() && mine && (std === "phone" ? normPhone(have) !== normPhone(mine) : have.trim().toLowerCase() !== mine.trim().toLowerCase())) keptStandard[std] = (keptStandard[std] ?? 0) + 1;
    }
  }
  const n = resp.length;
  const fill = Object.entries(a.form.answers).map(([ref, target]) => { const c = parsed.filter(({ p, r }) => (r.answers ?? []).some((x) => x.field.ref === ref) && (p.filled.includes(target))).length; return { target, question: (titles.get(ref) ?? ref).slice(0, 70), filled: c, pct: pct(c, n) }; });
  const hidden = Object.entries(a.form.hidden ?? {}).map(([name, target]) => ({ name, target, filled: resp.filter((r) => (r.hidden?.[name] ?? "").trim()).length }));
  const emailsTwice = [...byPerson.entries()].filter(([k, v]) => !k.startsWith("phone:") && v.n > 1);
  return {
    form: { id: a.formId, title: def.title }, at: new Date().toISOString(),
    responses: { completed: n, partial: partial.length, started: started.length, first: resp[0]?.submitted_at, last: resp[n - 1]?.submitted_at },
    people: byPerson.size, unidentified,
    duplicates: { emails: emailsTwice.length, responses: emailsTwice.reduce((s, [, v]) => s + v.n - 1, 0), phones: [...phones.values()].filter((x) => x > 1).length },
    ghl: { byEmail: hits.filter((h) => h?.by === "email").length, byPhone: hits.filter((h) => h?.by === "phone").length, none: hits.filter((h) => !h).length, alreadyTagged: hits.filter((h) => h && tags.every((t) => carriesTag(h.snap.tags, t))).length, readErrors, errors },
    wouldWrite: { creates, updates, responses: n - unidentified, keptStandard, tagAdds },
    fill, hidden, unbound: [...new Set(parsed.flatMap(({ p }) => p.unbound))].sort(),
    alreadyWritten: a.written ? resp.filter((r) => a.written!.has(`${a.formId}:${r.response_id ?? r.token}`)).length : 0,
  };
}

export function formatDryRun(d: DryRun, scope?: string): string {
  const L: string[] = [];
  L.push(`Typeform import, DRY RUN (nothing written to GHL, Typeform or the engine) — ${d.at}`);
  L.push(`Form: ${d.form.title} (${d.form.id})${scope ? ` · ${scope}` : ""}`);
  L.push("");
  L.push(`Responses: ${d.responses.completed} completed (${d.responses.first ?? "?"} → ${d.responses.last ?? "?"}); ${d.responses.partial} partial (answered some, never submitted: not imported); ${d.responses.started} opened only (no answers)`);
  L.push(`People: ${d.people} (by email, else phone); ${d.unidentified} response(s) with neither, skipped`);
  L.push(`Duplicates within Typeform: ${d.duplicates.emails} email(s) submitted more than once (${d.duplicates.responses} extra response(s); the latest answers win); ${d.duplicates.phones} phone(s) on more than one response`);
  L.push(`GHL (read only): ${d.ghl.byEmail} match an existing contact by email, ${d.ghl.byPhone} by phone only, ${d.ghl.none} not in GHL${d.ghl.readErrors ? `, ${d.ghl.readErrors} could not be read (${Object.entries(d.ghl.errors).map(([k, v]) => `${k} ×${v}`).join(", ")}; counted in none of these)` : ""}; ${d.ghl.alreadyTagged} of the matched already carry the tag`);
  L.push(`Apply would: create ${d.wouldWrite.creates} contact(s), update ${d.wouldWrite.updates} time(s) (existing contacts and repeat submissions), add the tag ${d.wouldWrite.tagAdds} time(s), over ${d.wouldWrite.responses} response(s)`);
  const kept = Object.entries(d.wouldWrite.keptStandard);
  L.push(`Standard fields GHL already holds differently (kept, never overwritten): ${kept.length ? kept.map(([k, v]) => `${k} ${v}`).join(", ") : "none"}`);
  if (d.alreadyWritten) L.push(`Already written by an earlier apply: ${d.alreadyWritten} (skipped)`);
  L.push(d.unbound.length ? `Fields not in GHL yet (provision-ghl --apply makes them; until bound they are not written): ${d.unbound.join(", ")}` : "Every mapped field is bound.");
  L.push("");
  L.push("Fill rate by question (of the completed responses):");
  const w = Math.max(...d.fill.map((f) => f.target.length), 10);
  for (const f of d.fill) L.push(`  ${f.target.padEnd(w)}  ${String(f.filled).padStart(4)}  ${String(f.pct).padStart(5)}%  ${f.question}`);
  L.push("Hidden fields (added 2026-10-16; older responses have none):");
  for (const h of d.hidden) L.push(`  ${h.name.padEnd(13)} → ${h.target.padEnd(w)}  ${h.filled} filled`);
  return L.join("\n");
}

/** The written markers already there, for the dry run's "already written" (with a database). */
export const writtenKeys = async (companyId: string) => new Set((await asOperator((c) => many<{ delivery_id: string }>(c, `select delivery_id from webhook_deliveries where company_id=$1 and provider='${WRITTEN}'`, [companyId]))).map((r) => r.delivery_id));

/**
 * Apply: up to `limit` responses not yet written, oldest first, each in its own transaction (a failure leaves the others
 * written and is listed; the next run tries it again). Real writes whatever the mode.
 */
export async function applyImport(a: { companyId: string; formId: string; adapters: Adapters; api?: TypeformApi; limit?: number; newLead?: boolean }): Promise<{ written: number; created: number; updated: number; skipped: number; failed: { response_id: string; error: string }[]; remaining: number; runsStarted: number }> {
  const api = a.api ?? liveTypeform;
  const { bindings } = await asOperator((c) => loadCompany(c, a.companyId));
  const form = formsOf(bindings)[a.formId]; if (!form) throw new Error(`form ${a.formId} is not mapped for this company`);
  const token = bindings[TF_TOKEN_KEY]; if (!token) throw new Error("no Typeform token bound");
  const resp: TfResponse[] = (await api.responses(token, a.formId, "completed")).sort((x, y) => String(x.submitted_at).localeCompare(String(y.submitted_at)));
  const done = await writtenKeys(a.companyId);
  const todo = resp.filter((r) => !done.has(`${a.formId}:${r.response_id ?? r.token}`));
  const limit = Math.max(1, a.limit ?? 50);
  const out = { written: 0, created: 0, updated: 0, skipped: resp.length - todo.length, failed: [] as { response_id: string; error: string }[], remaining: 0, runsStarted: 0 };
  for (const r of todo.slice(0, limit)) {
    try {
      const s = await asOperator(async (c) => { const { row, adapterCompany, bindings: b } = await loadCompany(c, a.companyId); return submitApplication(c, row, adapterCompany, b, a.adapters, a.formId, form, r, { via: "import", real: true, newLead: a.newLead === true }); });
      if (s.outcome === "recorded") { out.written++; out.runsStarted += s.runsStarted; if (s.action === "create") out.created++; else out.updated++; } else out.skipped++;
    } catch (e) { out.failed.push({ response_id: r.response_id ?? r.token, error: String((e as Error).message).slice(0, 200) }); }
  }
  out.remaining = Math.max(0, todo.length - limit) + out.failed.length;
  return out;
}

/** The company's Typeform pieces from the database, for the route and the script. */
export async function companyTypeform(slug: string) {
  return asOperator(async (c) => {
    const co = await one<{ id: string }>(c, "select id from companies where slug=$1", [slug]); if (!co) throw new Error(`no company ${slug}`);
    const { row, adapterCompany, bindings } = await loadCompany(c, co.id);
    return { company: row, ac: adapterCompany, bindings, forms: formsOf(bindings), token: bindings[TF_TOKEN_KEY] };
  });
}
