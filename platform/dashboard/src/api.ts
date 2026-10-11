import { keepPreviousData, useQuery, useMutation, useQueryClient, type QueryKey } from "@tanstack/react-query";
import type { Chart, PathItem } from "@/api/words";
import type { SetupPage } from "@/api/setup";

export class ApiError extends Error { constructor(public status: number, message: string, public body?: Record<string, unknown>) { super(message); } }

export async function api<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const r = await fetch(path, { ...init, headers: { ...(init?.json !== undefined ? { "content-type": "application/json" } : {}), ...(init?.headers ?? {}) }, body: init?.json !== undefined ? JSON.stringify(init.json) : init?.body, credentials: "same-origin" });
  const body = (await r.json().catch(() => ({}))) as Record<string, unknown>;
  if (r.status === 401) { if (!location.pathname.startsWith("/app/login")) location.assign(`/app/login?next=${encodeURIComponent(location.pathname + location.search)}`); throw new ApiError(401, "sign in first", body); }
  if (!r.ok) throw new ApiError(r.status, String(body.error ?? r.statusText), body);
  return body as T;
}

/** A page's data: fetched once, kept fresh by polling while the page is open (live pages every 15 s). */
export function usePage<T>(key: QueryKey, path: string, opts: { every?: number; enabled?: boolean; keep?: boolean } = {}) {
  return useQuery<T, ApiError>({ queryKey: key, queryFn: () => api<T>(path), refetchInterval: opts.every ?? 15_000, refetchOnWindowFocus: true, enabled: opts.enabled ?? true, retry: (n, e) => e.status >= 500 && n < 2, placeholderData: opts.keep ? keepPreviousData : undefined });
}
export function useAction<TVars, TOut = unknown>(fn: (v: TVars) => Promise<TOut>, invalidate: QueryKey[] = []) {
  const qc = useQueryClient();
  return useMutation<TOut, ApiError, TVars>({ mutationFn: fn, onSettled: () => { for (const k of invalidate) qc.invalidateQueries({ queryKey: k }); } });
}

/* ---- shapes, mirrored from src/api/data.ts ---- */
export type Mode = "shadow" | "test" | "live";
export const MODES: Mode[] = ["shadow", "test", "live"];
export const MODE_ABOUT: Record<Mode, string> = { shadow: "everyone runs; sends are written down, not delivered; nothing is written to the CRM", test: "test contacts get everything for real; everyone else runs as in shadow, nothing written or sent", live: "sends go out and the CRM is written, for everyone" };
export type CompanyHead = { id: string; name: string; slug: string; mode: Mode; timezone: string; status: string };
export type CompaniesPage = { engine: { last_tick: string | null; recovery: boolean; problems: { key: string; level: string; text: string; company?: string | null; href?: string | null }[] }; companies: { id: string; name: string; slug: string; status: string; mode: string; timezone: string; contacts: number; workflows: number; on: number; in_flight: number; needs_hand: number; last_poll: string | null; alerts: number }[] };
export type WorkflowRow = { id: string; name: string; enabled: boolean; stage: string | null; sort: number; origin: string | null; description: string | null; people: number; in_flight: number; needs_hand: number; last_ran: string | null; schedule: string | null; ready: boolean; missing: string[]; gaps: string[]; parse_error?: string };
export type CompanyPage = { company: CompanyHead; stages: { id: string; label: string; about: string }[]; workflows: WorkflowRow[]; issues: { level: string; text: string; href?: string }[]; alerts_open: number };
export type RunListRow = { id: string; who: string; contact_id: string | null; workflow: string; workflow_id: string; state: "ok" | "here" | "warn" | "stop"; at: string; started_at: string; finished_at: string | null; next_run_at: string | null; path: { node_id: string; state: PathItem["state"]; title: string; meta?: string; note?: string }[] };
export type WorkflowPage = { company: CompanyHead; workflow: { id: string; name: string; enabled: boolean; stage: string | null; origin: string | null; description: string | null; version: number; diverged: boolean; last_ran: string | null; schedule: string | null; parse_error: string | null }; tiles: { people: number; in_flight: number; finished: number; needs_hand: number }; chart: Chart | null; runs: RunListRow[]; ready: { ready: boolean; missing: string[]; gaps: string[]; issues: { level: string; text: string }[] } };
export type RunPage = { company: CompanyHead; workflow: { id: string; name: string }; run: { id: string; who: string; contact_id: string | null; user_id: string | null; status: string; state: "ok" | "here" | "warn" | "stop"; at: string; exit_reason: string | null; started_at: string; finished_at: string | null; next_run_at: string | null; appointment: { starts_at: string; status: string; term: string; closer: string | null } | null; shadow: boolean; current_node: string | null; step_error: string | null; step_attempt: number; can_skip: boolean; held: boolean; gave_up: { node: string; title: string; error: string | null; tries: number }[]; contact_truth: { fetched_at: string | null; stale: string | null } }; feed: PathItem[]; next: PathItem[]; chart: Chart | null; states: Record<string, PathItem["state"]>; raw: { steps: unknown[]; context: unknown } };
export type ContactPage = { company: CompanyHead; contact: { id: string; name: string; phone: string | null; email: string | null; timezone: string; tags: string[]; since: string; crm_url: string | null }; facts: [string, string][]; identifiers: [string, string][]; runs: RunListRow[]; next: { workflow: string; run_id: string; title: string; at: string | null; note?: string }[]; harness: { allowed: boolean };
  history: { cards: { id: string; at: string; pipeline: string; from: string | null; to: string | null; status: string | null; by: string }[]; appointments: { id: string; at: string; status: string; kind: string | null; closer: string | null; outcome: string | null; booked_by: string | null }[]; payments: { id: string; at: string; amount: string; currency: string; status: string; kind: string | null }[]; recordings: { id: string; at: string; title: string | null; minutes: number | null; url: string | null; provider: string }[] } };
export type HealthPage = { company: CompanyHead; open: { id: string; level: string; text: string; source: string; first_seen: string; announce_count: number; link: string | null; link_label: string | null }[]; checks: { id: string; label: string; about: string; state: "off" | "na" | "ok" | "warn" | "error"; findings: { ok: boolean; level: string; text: string; href: string | null; href_label: string | null; fix: { label: string; action: string } | null; thread: string | null }[] }[]; resolved: { id: string; text: string; first_seen: string; resolved_at: string }[]; sweep: { workflow_id: string; name: string; enabled: boolean; when: string | null; last_run_at: string | null } | null;
  starts: { event: string; label: string; category: string; workflows: { id: string; name: string; enabled: boolean }[]; seen: number }[];
  jev: { reviewed: number; agreed: number; by_intent: { predicted: string; reviewed: number; agreed: number }[] } };
export type WrapUpsPage = { company: CompanyHead; reports: { id: string; kind: string; period_start: string; period_end: string; generated_at: string; on_demand: boolean; body: string; status: string | null }[]; workflow: { id: string; name: string; enabled: boolean; when: string | null } | null };
export type SetterStats = { id: string; name: string; leads_assigned: number; never_dialled: number; dials: number; answered: number; connected: number; talk_sec: number; contacts_reached: number; leads_dialled_first: number; stl_median_min: number | null; stl_avg_min: number | null; bookings: number };
export type MetricsPage = { company: CompanyHead; from: string; to: string; timezone: string; reached_seconds: number; totals: SetterStats; setters: SetterStats[] };
export type { SetupPage };
export type EodListPage = { company: CompanyHead; reports: { id: string; day: string; closer: string; submitted_at: string | null; reminded_at: string | null; totals: string | null; changes: { field: string; from: unknown; to: unknown; contact?: string }[] }[]; closers: { id: string; name: string; email: string; url: string }[] };
export type { Chart, PathItem };
