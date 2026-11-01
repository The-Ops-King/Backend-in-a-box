import type { PoolClient } from "pg";
import { many, one } from "@/db/client";
import { MODES, runMode, type Mode } from "./mode";
import type { Issue } from "./readiness";

/**
 * D288 (Tyler: "how can we make sure this doesn't happen again?"). PMU's end of day went live reading GHL's Sales Calls while Call
 * booked, which makes them, still ran in ghost and the Zap that had made them was off: calls were booked with no record and the end
 * of day never asked for them. A workflow that relies on what another makes cannot go live (or quiet) unless that one runs at least
 * as high, or the offer says it is made outside the engine (`golive.outside`: the workflow's name or slug, set on Tyler's word, e.g. a
 * Zap that still makes the Sales Calls).
 */
/** `on`: the workflows that can make it, by template slug or name (an offer's own copy may have no template: Dating's "Closing call booked"); any one of them will do. */
export type Reliance = { what: string; on: string[] };
/** What each workflow relies on, by template slug (or name, for a copy with no template). */
export const RELIES: Record<string, Reliance> = {
  "eod-reminder": { what: "the Sales Calls the end of day asks about", on: ["call-booked", "Closing call booked"] },
  "eod-filed": { what: "the Sales Calls the end of day files", on: ["call-booked", "Closing call booked"] },
  "call-outcome": { what: "the Sales Call each filed outcome is written to", on: ["call-booked", "Closing call booked"] },
  "call-recorded": { what: "the Sales Call each recorded call updates", on: ["call-booked", "Closing call booked"] },
  "setter-call-filed": { what: "the Discovery Call each setter's answer is written to", on: ["setter-call-logged"] },
  "Setter call filed": { what: "the Discovery Call each setter's answer is written to", on: ["setter-call-logged"] },
};
export const OUTSIDE_KEY = "golive.outside";
const rank = (m: Mode) => MODES.indexOf(m);
const WRITES: Mode[] = ["quiet", "live"];

/** Providers the offer says are made outside the engine: a JSON list or words with commas, matched to a slug or a name, any case. */
export function outsideOf(raw: string | undefined | null): string[] {
  if (!raw?.trim()) return [];
  try { const v = JSON.parse(raw); if (Array.isArray(v)) return v.map((x) => String(x).trim().toLowerCase()).filter(Boolean); } catch { /* words */ }
  return raw.split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
}

type Row = { id: string; name: string; slug: string | null; enabled: boolean; own: Mode | null };
/**
 * The blockers for moving these workflows up to their new rungs: each that relies on another needs that one enabled and running at
 * least as high, or named outside. `after(id)` is the rung each workflow runs on after the move (a company's move changes several).
 */
export async function relianceBlockers(c: PoolClient, companyId: string, moving: string[], after: (w: Row) => Mode, slugPrefix: string): Promise<Issue[]> {
  const all = await many<Row>(c, "select w.id, w.name, t.slug, w.enabled, w.mode as own from workflows w left join workflow_templates t on t.id=w.template_id where w.company_id=$1", [companyId]);
  const outside = outsideOf((await one<{ value: Buffer }>(c, "select value from bindings where company_id=$1 and key=$2", [companyId, OUTSIDE_KEY]))?.value.toString("utf8"));
  const out: Issue[] = [];
  for (const w of all.filter((x) => moving.includes(x.id))) {
    const to = after(w); if (!WRITES.includes(to)) continue;
    const need = RELIES[w.slug ?? ""] ?? RELIES[w.name];
    if (!need) continue;
    const named = need.on.map((p) => p.toLowerCase());
    if (named.some((p) => outside.includes(p))) continue;
    const providers = all.filter((x) => named.includes((x.slug ?? "").toLowerCase()) || named.includes(x.name.toLowerCase()));
    if (providers.some((x) => outside.includes(x.name.toLowerCase()) || (x.enabled && rank(after(x)) >= rank(to)))) continue;
    const pr = providers[0];
    out.push({ level: "blocker", href: `${slugPrefix}/w/${pr?.id ?? w.id}`,
      text: `${w.name} relies on ${need.what}, which ${pr ? `${pr.name} makes, and it ${pr.enabled ? `runs in ${after(pr)}` : "is off"}` : `no workflow of this offer makes (${need.on.join(" or ")})`}. Take ${pr?.name ?? "it"} ${to} first, or say it is made outside the engine (${OUTSIDE_KEY}).` });
  }
  return out;
}

/** The rung a workflow runs on after only its own flag changes. */
export const afterOwn = (company: Mode, id: string, mode: Mode | null) => (w: Row) => runMode(company, w.id === id ? mode : w.own);
