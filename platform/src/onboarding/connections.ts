/**
 * D150 (#53 P1): the wizard's second step, the keys a client's software needs. Which ones follows from the offer's answers
 * (GHL always; Calendly when it books there; Whop, Fathom, Typeform when it uses them; the AI keys always). Each key is tested
 * against its service before anything is kept: a key that does not work is never stored. Kept keys are encrypted (bindings,
 * D100's crypto) under the same names install reads, never shown again (the page shows "ends with 1234"), never logged. The AI
 * keys can instead be copied from a company that has them, inside the engine (D100), so the value passes through no one's
 * hands. The step is done when every key it needs has passed its test.
 */
import type { PoolClient } from "pg";
import { many, one } from "@/db/client";
import { decrypt } from "@/engine/crypto";
import { mask, setBinding } from "@/engine/settings";
import { copySecretBindings, SHAREABLE } from "@/engine/binding-copy";
import { ghlLocationOk } from "@/adapters/ghl/health";
import { calendlyWhoAmI } from "@/adapters/calendly/read";
import { whopPing } from "@/adapters/whop/client";
import { fathomPing } from "@/adapters/fathom/client";
import { typeformPing } from "@/adapters/typeform/client";
import { anthropicPing } from "@/adapters/anthropic/health";
import { jevPing } from "@/adapters/jev/classifier";
import { TF_TOKEN_KEY } from "@/engine/typeform";
import type { Intake } from "./intake";

export type Tested = { ok: true; detail: string } | { ok: false; error: string };
/** Every live call a test makes, so a test can stand in for the services. */
export type Probes = {
  ghl: (pit: string, locationId: string) => Promise<Tested>;
  calendly: (token: string) => Promise<Tested>;
  whop: (key: string) => Promise<Tested>;
  fathom: (key: string) => Promise<Tested>;
  typeform: (token: string) => Promise<Tested>;
  anthropic: (key: string) => Promise<Tested>;
  jev: (key: string) => Promise<Tested>;
};
const err = (e: unknown) => String((e as Error)?.message ?? e).slice(0, 200);
export const liveProbes: Probes = {
  ghl: async (pit, loc) => { const r = await ghlLocationOk(pit, loc); return r.ok ? { ok: true, detail: `GHL location "${r.name ?? loc}"` } : { ok: false, error: r.error ?? "GHL refused" }; },
  calendly: async (t) => { try { const me = await calendlyWhoAmI(t); return { ok: true, detail: `Calendly: ${me.name} (${me.email})` }; } catch (e) { return { ok: false, error: err(e) }; } },
  whop: async (k) => { try { return (await whopPing(k)) ? { ok: true, detail: "Whop: reads payments" } : { ok: false, error: "Whop refused the key (it needs to read payments)" }; } catch (e) { return { ok: false, error: err(e) }; } },
  fathom: async (k) => { const r = await fathomPing(k); return r === true ? { ok: true, detail: "Fathom: reads meetings" } : { ok: false, error: r === false ? "Fathom refused the key" : `Fathom ${r.status ?? "unreachable"}: ${r.detail}` }; },
  typeform: async (t) => { const r = await typeformPing(t); return r.ok ? { ok: true, detail: `Typeform: ${r.alias ?? r.email ?? "account"}` } : { ok: false, error: r.error }; },
  anthropic: async (k) => { const r = await anthropicPing(k); return r.ok ? { ok: true, detail: "Anthropic: key works" } : { ok: false, error: r.error ?? "Anthropic refused the key" }; },
  jev: async (k) => { const r = await jevPing(k); return r.ok ? { ok: true, detail: "Jev: answers" } : { ok: false, error: r.error ?? "Jev refused the key" }; },
};

export type ConnectionId = keyof Probes;
type Field = { name: string; label: string; key: string; kind: "secret" | "id"; help: string };
type Def = { id: ConnectionId; label: string; needed: (a: Intake) => string | null; fields: Field[]; test: (v: Record<string, string>, p: Probes) => Promise<Tested> };

export const CONNECTIONS: Def[] = [
  { id: "ghl", label: "GoHighLevel", needed: (a) => (a.crm === "ghl" ? "the CRM: every workflow reads and writes it" : null),
    fields: [
      { name: "locationId", label: "Location ID", key: "crm.location_id", kind: "id", help: "the sub-account's id: Settings → Business Profile, or the part after /location/ in its address" },
      { name: "pit", label: "Private Integration token", key: "secret.ghl_pit", kind: "secret", help: "in the sub-account: Settings → Private Integrations → Create, every scope it offers (contacts, opportunities, calendars, custom objects, documents, conversations). It works in that one sub-account only" },
    ], test: (v, p) => p.ghl(v.pit, v.locationId) },
  { id: "calendly", label: "Calendly", needed: (a) => (a.booking === "calendly" ? "bookings come from Calendly" : null),
    fields: [{ name: "token", label: "Personal access token", key: "secret.calendly_token", kind: "secret", help: "Calendly → Integrations → API and webhooks → Personal access tokens, made by an owner or admin of the organization so every host's event types are read" }],
    test: (v, p) => p.calendly(v.token) },
  { id: "whop", label: "Whop", needed: (a) => (a.payments === "whop" ? "payments come from Whop" : null),
    fields: [{ name: "apiKey", label: "Company API key", key: "secret.whop_api_key", kind: "secret", help: "Whop → Developer → API keys: a company key that reads payments and manages webhooks (install registers the engine's webhook with it)" }],
    test: (v, p) => p.whop(v.apiKey) },
  { id: "fathom", label: "Fathom", needed: (a) => (a.recording === "fathom" ? "calls are recorded in Fathom" : null),
    fields: [{ name: "apiKey", label: "API key", key: "secret.fathom_api_key", kind: "secret", help: "Fathom → Settings → API access, in the account that records the calls (install registers the engine's webhook with it)" }],
    test: (v, p) => p.fathom(v.apiKey) },
  { id: "typeform", label: "Typeform", needed: (a) => (a.application === "typeform" ? "the application is a Typeform" : null),
    fields: [{ name: "token", label: "Personal access token", key: TF_TOKEN_KEY, kind: "secret", help: "Typeform → Account → Personal tokens, with forms:read, responses:read, webhooks:read and webhooks:write" }],
    test: (v, p) => p.typeform(v.token) },
  { id: "anthropic", label: "Anthropic", needed: () => "call notes, scorecards and the Slack bot",
    fields: [{ name: "apiKey", label: "API key", key: "secret.anthropic_key", kind: "secret", help: "console.anthropic.com → API keys; the client's own, or copy one from a company that has it" }],
    test: (v, p) => p.anthropic(v.apiKey) },
  { id: "jev", label: "Jev", needed: () => "reads replies to texts and setter calls",
    fields: [{ name: "apiKey", label: "API key", key: "secret.jev_key", kind: "secret", help: "usually copied from a company that has it" }],
    test: (v, p) => p.jev(v.apiKey) },
];

export type Check = { ok: boolean; at: string; detail?: string; error?: string; by?: string };
export type ConnectionRow = {
  id: ConnectionId; label: string; why: string;
  fields: { name: string; label: string; kind: "secret" | "id"; help: string; set: boolean; shown: string | null }[];
  check: Check | null;
  /** for a key a company may share (D100): the companies it can be copied from */
  copyFrom: string[];
};

export const neededConnections = (a: Intake) => CONNECTIONS.flatMap((d) => { const why = d.needed(a); return why ? [{ d, why }] : []; });

export async function connectionsState(c: PoolClient, companyId: string): Promise<{ rows: ConnectionRow[]; ready: boolean; answered: boolean }> {
  const o = await one<{ intake: Intake; connections: Record<string, Check> }>(c, "select intake, connections from onboarding where company_id=$1", [companyId]);
  if (!o) return { rows: [], ready: false, answered: false };
  const keys = CONNECTIONS.flatMap((d) => d.fields.map((f) => f.key));
  const bound = new Map((await many<{ key: string; kind: string; value: Buffer }>(c, "select key, kind, value from bindings where company_id=$1 and key = any($2::text[])", [companyId, keys])).map((b) => [b.key, b]));
  const donors = await many<{ key: string; slug: string }>(c, `select b.key, co.slug from bindings b join companies co on co.id=b.company_id
    where b.key = any($1::text[]) and b.kind='secret' and co.id<>$2 and co.status<>'archived' order by co.slug`, [SHAREABLE, companyId]);
  const rows = neededConnections(o.intake).map(({ d, why }): ConnectionRow => ({
    id: d.id, label: d.label, why,
    fields: d.fields.map((f) => { const b = bound.get(f.key); const v = b ? (b.kind === "secret" ? decrypt(b.value) : b.value.toString("utf8")) : null;
      return { name: f.name, label: f.label, kind: f.kind, help: f.help, set: !!v, shown: v === null ? null : f.kind === "secret" ? mask("secret", v) : v }; }),
    check: o.connections[d.id] ?? null,
    copyFrom: d.fields.length === 1 && SHAREABLE.includes(d.fields[0].key) ? donors.filter((x) => x.key === d.fields[0].key).map((x) => x.slug) : [],
  }));
  return { rows, ready: rows.length > 0 && rows.every((r) => r.check?.ok && r.fields.every((f) => f.set)), answered: Object.keys(o.intake).length > 0 };
}

export type ConnectResult = { ok: true; check: Check } | { ok: false; status: number; why: string; check?: Check };

/**
 * One connection: `values` tested and, only when they work, kept; or `copyFrom` (a shareable key from another company, D100),
 * copied and then tested; or neither, the kept values tested again. Every test is recorded, pass or fail; a failed test of new
 * values keeps nothing.
 */
export async function connect(c: PoolClient, companyId: string, args: { id: unknown; values?: unknown; copyFrom?: unknown; by?: string }, probes: Probes = liveProbes): Promise<ConnectResult> {
  const o = await one<{ intake: Intake; slug: string }>(c, "select o.intake, co.slug from onboarding o join companies co on co.id=o.company_id where o.company_id=$1 for update of o", [companyId]);
  if (!o) return { ok: false, status: 404, why: "this company is not being onboarded" };
  const need = neededConnections(o.intake).find((n) => n.d.id === args.id);
  if (!need) return { ok: false, status: 400, why: Object.keys(o.intake).length ? `${String(args.id)} is not a connection this offer needs` : "answer The offer first: it says which connections are needed" };
  const d = need.d, by = args.by ?? "dashboard";
  let values: Record<string, string>;
  if (args.copyFrom !== undefined) {
    if (d.fields.length !== 1 || !SHAREABLE.includes(d.fields[0].key)) return { ok: false, status: 400, why: `${d.label}'s key is the client's own account: it cannot be copied from another company` };
    // the copy is undone if the key then fails its test: nothing is kept that does not work
    await c.query("savepoint onboarding_copy");
    const r = await copySecretBindings(c, { from: String(args.copyFrom), to: o.slug, keys: [d.fields[0].key], by });
    if (!r.ok) { await c.query("rollback to savepoint onboarding_copy"); return { ok: false, status: r.status, why: r.error }; }
    values = await stored(c, companyId, d);
  } else if (args.values !== undefined) {
    if (!args.values || typeof args.values !== "object") return { ok: false, status: 400, why: "values: { field: value }" };
    const given = args.values as Record<string, unknown>;
    const kept = await stored(c, companyId, d);
    values = {};
    for (const f of d.fields) {
      const v = typeof given[f.name] === "string" ? (given[f.name] as string).trim() : "";
      // a field left blank keeps what is stored (a new token with the same location, say)
      if (v) values[f.name] = v; else if (kept[f.name]) values[f.name] = kept[f.name]; else return { ok: false, status: 400, why: `${f.label} is required` };
    }
  } else {
    values = await stored(c, companyId, d);
    const missing = d.fields.filter((f) => !values[f.name]);
    if (missing.length) return { ok: false, status: 400, why: `nothing stored to test: ${missing.map((f) => f.label).join(", ")}` };
  }
  const t = await d.test(values, probes).catch((e): Tested => ({ ok: false, error: err(e) }));
  if (args.copyFrom !== undefined) await c.query(t.ok ? "release savepoint onboarding_copy" : "rollback to savepoint onboarding_copy");
  const check: Check = t.ok ? { ok: true, at: new Date().toISOString(), detail: t.detail, by } : { ok: false, at: new Date().toISOString(), error: t.error, by };
  if (t.ok && args.values !== undefined) for (const f of d.fields) await setBinding(c, companyId, f.key, f.kind, values[f.name], `onboarding (${by})`);
  await c.query("update onboarding set connections = connections || jsonb_build_object($2::text, $3::jsonb) where company_id=$1", [companyId, d.id, check]);
  await markStep(c, companyId, by);
  return t.ok ? { ok: true, check } : { ok: false, status: 422, why: args.values !== undefined || args.copyFrom !== undefined ? `${d.label} did not accept it, so nothing was kept: ${t.error}` : `${d.label}: ${t.error}`, check };
}

async function stored(c: PoolClient, companyId: string, d: Def): Promise<Record<string, string>> {
  const rows = await many<{ key: string; kind: string; value: Buffer }>(c, "select key, kind, value from bindings where company_id=$1 and key = any($2::text[])", [companyId, d.fields.map((f) => f.key)]);
  return Object.fromEntries(d.fields.flatMap((f) => { const b = rows.find((r) => r.key === f.key); return b ? [[f.name, b.kind === "secret" ? decrypt(b.value) : b.value.toString("utf8")]] : []; }));
}

/** Done while every connection the offer needs has passed its last test; a failed retest takes it back. */
async function markStep(c: PoolClient, companyId: string, by: string) {
  const s = await connectionsState(c, companyId);
  if (s.ready) await c.query("update onboarding set steps = steps || jsonb_build_object('connections', jsonb_build_object('done_at', now(), 'by', $2::text)) where company_id=$1 and not steps ? 'connections'", [companyId, by]);
  else await c.query("update onboarding set steps = steps - 'connections' where company_id=$1", [companyId]);
}
