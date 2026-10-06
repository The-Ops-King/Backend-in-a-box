import { asOperator, one, many } from "@/db/client";
import { encrypt } from "./crypto";
import { extractManifest, parseDefinition, indexDefinition } from "./definition";
import { templates } from "@/templates";
import type { Adapters } from "@/adapters/types";

export type InstallInput = {
  name: string; slug: string; timezone: string; locationId: string; pit: string;
  calendars?: Record<string, string>;   // ghl_calendar_id → core appointment_type category (closing | first_call | qualifying | follow_up)
  closerCall?: string;                   // ghl_calendar_id bound as calendar.closer_call
  bookingCalendar?: string;              // ghl_calendar_id bound as calendar.booking (first-call / self-book link used by lead and reactivation templates)
  templates?: string[];                  // slugs; default all
  enable?: boolean;                      // default false — Tyler's rule: build off, enable deliberately
  smsEnabled?: boolean;                  // default true; false when the sub-account has no number
  mode?: "shadow" | "live";             // default shadow: nothing is written to the CRM until you say live
};

/** D16: upload info, pick templates, done. Idempotent. Workflows install OFF unless enable=true. */
export async function installCompany(input: InstallInput, adapters: Adapters): Promise<{ companyId: string; calendars: string[]; installed: string[] }> {
  const wanted = input.templates?.length ? input.templates : templates.map((t) => t.slug);
  const calMap = input.calendars ?? {};
  return asOperator(async (c) => {
    const co = await one<{ id: string }>(c, `insert into companies (name, slug, timezone, sms_enabled, mode) values ($1,$2,$3,$4,$5) on conflict (slug) do update set name=excluded.name, timezone=excluded.timezone, sms_enabled=excluded.sms_enabled, mode=excluded.mode returning id`, [input.name, input.slug, input.timezone, input.smsEnabled ?? true, input.mode ?? "shadow"]);
    const companyId = co!.id;
    await c.query(`insert into company_terms (company_id, domain, name, category, is_default, sort) select $1, domain, label, value, true, sort from core_categories on conflict (company_id, domain, name) do nothing`, [companyId]);
    const bind = (key: string, kind: string, value: string) =>
      c.query(`insert into bindings (company_id, key, kind, value) values ($1,$2,$3,$4) on conflict (company_id, key) do update set value=excluded.value, updated_at=now()`, [companyId, key, kind, kind === "secret" ? encrypt(value) : Buffer.from(value)]);
    await bind("crm.location_id", "id", input.locationId); await bind("secret.ghl_pit", "secret", input.pit);
    const ac = { id: companyId, locationId: input.locationId, pit: input.pit, timezone: input.timezone };
    for (const u of await adapters.read.listUsers(ac))
      await c.query(`insert into users (company_id, email, name, role, ghl_user_id) values ($1,$2,$3,'closer',$4) on conflict (company_id, ghl_user_id) do update set name=excluded.name`, [companyId, u.email ?? `${u.id}@unclaimed.local`, u.name || u.id, u.id]);
    const terms = await many<{ id: string; category: string }>(c, "select id, category from company_terms where company_id=$1 and domain='appointment_type' and is_default", [companyId]);
    const calendarsOut: string[] = [];
    for (const k of await adapters.read.listCalendars(ac)) {
      const cat = calMap[k.id]; if (!cat) { calendarsOut.push(`skip "${k.name}" (${k.id}) — no mapping`); continue; }
      const term = terms.find((t) => t.category === cat)?.id; if (!term) { calendarsOut.push(`unknown category ${cat} for ${k.id}`); continue; }
      const du = k.teamMemberIds[0] ? await one<{ id: string }>(c, "select id from users where company_id=$1 and ghl_user_id=$2", [companyId, k.teamMemberIds[0]]) : undefined;
      await c.query(`insert into calendars (company_id, ghl_calendar_id, name, appointment_term, default_user_id) values ($1,$2,$3,$4,$5) on conflict (company_id, ghl_calendar_id) do update set name=excluded.name, appointment_term=excluded.appointment_term`, [companyId, k.id, k.name, term, du?.id ?? null]);
      calendarsOut.push(`"${k.name}" → ${cat}`);
    }
    const closerCal = input.closerCall ?? Object.entries(calMap).find(([, cat]) => cat === "closing")?.[0];
    if (closerCal) await bind("calendar.closer_call", "id", closerCal);
    const bookingCal = input.bookingCalendar ?? Object.entries(calMap).find(([, cat]) => cat === "first_call")?.[0] ?? closerCal;
    if (bookingCal) await bind("calendar.booking", "id", bookingCal);
    const installed: string[] = [];
    for (const t of templates.filter((t) => wanted.includes(t.slug))) {
      const def = parseDefinition(t.definition); const manifest = extractManifest(def);
      let tpl = await one<{ id: string; version: number }>(c, "select id, version from workflow_templates where slug=$1", [t.slug]);
      if (!tpl) tpl = await one<{ id: string; version: number }>(c, "insert into workflow_templates (slug, name, description, category, definition, manifest, published_at) values ($1,$2,$3,$4,$5,$6,now()) returning id, version", [t.slug, t.name, t.description, t.category, t.definition, manifest]);
      if (await one(c, "select 1 from workflows where company_id=$1 and template_id=$2", [companyId, tpl!.id])) { installed.push(`${t.slug} (already installed)`); continue; }
      const wf = await one<{ id: string }>(c, `insert into workflows (company_id, template_id, template_version, name, reentry_policy, reentry_window) values ($1,$2,$3,$4,$5,$6) returning id`, [companyId, tpl!.id, tpl!.version, t.name, def.reentry, def.reentry_window ?? null]);
      await c.query("insert into workflow_versions (workflow_id, version, definition, manifest, note) values ($1,1,$2,$3,'installed from template')", [wf!.id, t.definition, manifest]);
      for (const trig of indexDefinition(def).triggers) await c.query("insert into workflow_triggers (company_id, workflow_id, node_id, event_type, match) values ($1,$2,$3,$4,$5)", [companyId, wf!.id, trig.id, trig.event, trig.match ?? {}]);
      const bound = new Set((await many<{ key: string }>(c, "select key from bindings where company_id=$1", [companyId])).map((b) => b.key));
      const missing = manifest.bindings.filter((b) => b.required && !bound.has(b.key)).map((b) => b.key);
      if (input.enable && !missing.length) await c.query("update workflows set enabled=true where id=$1", [wf!.id]);
      installed.push(`${t.slug} → ${missing.length ? `OFF, missing: ${missing.join(", ")}` : input.enable ? "enabled" : "installed OFF"}`);
    }
    return { companyId, calendars: calendarsOut, installed };
  });
}
