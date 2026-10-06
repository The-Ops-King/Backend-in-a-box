import { asOperator, one, many } from "@/db/client";
import { encrypt } from "./crypto";
import { extractManifest, parseDefinition, indexDefinition } from "./definition";
import { templates } from "@/templates";
import { bookingFor, type Adapters, type BookingConfig, type Company } from "@/adapters/types";
import { calendlyUserByEmail, calendlyWhoAmI } from "@/adapters/calendly/read";
import { loadCompany } from "./context";

/** A calendar's mapping: the kind of call it books, and optionally whether every booking on it is self-booked (true) or setter-booked (false). */
export type CalendarMapping = string | { term: string; selfBooked?: boolean };
export type InstallInput = {
  name: string; slug: string; timezone: string; locationId: string; pit: string;
  /** Where appointments live. Default: the CRM's own calendars. Calendly: a read token; `userEmail` narrows event types and events to one host. */
  booking?: { source: "ghl" } | { source: "calendly"; token: string; userEmail?: string; phoneQuestion?: string };
  calendars?: Record<string, CalendarMapping>;   // calendar / event type external id → closing | first_call | qualifying | follow_up
  closerCall?: string;                   // external id bound as calendar.closer_call
  bookingCalendar?: string;              // external id bound as calendar.booking (first-call / self-book link used by lead and reactivation templates)
  crm?: Record<string, string>;          // extra crm.* bindings a template needs: pipeline and stage ids, custom field ids (key without the crm. prefix)
  templates?: string[];                  // slugs; default all
  enable?: boolean;                      // default false — Tyler's rule: build off, enable deliberately
  smsEnabled?: boolean;                  // default true; false when the sub-account has no number
  mode?: "shadow" | "live";             // default shadow: nothing is written to the CRM until you say live
};

/** D16: upload info, pick templates, done. Idempotent. Workflows install OFF unless enable=true. */
export async function installCompany(input: InstallInput, adapters: Adapters): Promise<{ companyId: string; calendars: string[]; installed: string[] }> {
  const wanted = input.templates?.length ? input.templates : templates.map((t) => t.slug);
  const calMap: Record<string, { term: string; selfBooked?: boolean }> = Object.fromEntries(Object.entries(input.calendars ?? {}).map(([k, v]) => [k, typeof v === "string" ? { term: v } : v]));
  // resolve the booking source outside the transaction: it talks to Calendly.
  // Omitting `booking` on a re-install keeps whatever the company already uses; it never silently flips it back to GHL.
  let booking: BookingConfig = { source: "ghl" };
  if (!input.booking) {
    const prior = await asOperator(async (c) => {
      const co = await one<{ id: string }>(c, "select id from companies where slug=$1", [input.slug]);
      return co ? (await loadCompany(c, co.id).catch(() => null))?.adapterCompany.booking ?? null : null;
    });
    if (prior) booking = prior;
  }
  if (input.booking?.source === "calendly") {
    const me = await calendlyWhoAmI(input.booking.token);
    const user = input.booking.userEmail ? await calendlyUserByEmail(input.booking.token, me.organization, input.booking.userEmail) : undefined;
    if (input.booking.userEmail && !user) throw new Error(`no Calendly organization member has the email ${input.booking.userEmail}`);
    booking = { source: "calendly", token: input.booking.token, organization: me.organization, user, phoneQuestion: input.booking.phoneQuestion };
  }
  return asOperator(async (c) => {
    // re-running install never silently flips a live company back to shadow or re-enables SMS: only explicitly passed values change
    const co = await one<{ id: string }>(c, `insert into companies (name, slug, timezone, sms_enabled, mode) values ($1,$2,$3,coalesce($4,true),coalesce($5,'shadow'))
      on conflict (slug) do update set name=excluded.name, timezone=excluded.timezone,
        sms_enabled=case when $4::boolean is null then companies.sms_enabled else excluded.sms_enabled end,
        mode=case when $5::text is null then companies.mode else excluded.mode end returning id`, [input.name, input.slug, input.timezone, input.smsEnabled ?? null, input.mode ?? null]);
    const companyId = co!.id;
    await c.query(`insert into company_terms (company_id, domain, name, category, is_default, sort) select $1, domain, label, value, true, sort from core_categories on conflict (company_id, domain, name) do nothing`, [companyId]);
    const bind = (key: string, kind: string, value: string) =>
      c.query(`insert into bindings (company_id, key, kind, value) values ($1,$2,$3,$4) on conflict (company_id, key) do update set value=excluded.value, updated_at=now()`, [companyId, key, kind, kind === "secret" ? encrypt(value) : Buffer.from(value)]);
    await bind("crm.location_id", "id", input.locationId); await bind("secret.ghl_pit", "secret", input.pit);
    if (booking.source === "calendly") {
      await bind("secret.calendly_token", "secret", booking.token); await bind("calendly.organization", "id", booking.organization);
      await bind("calendly.user", "id", booking.user ?? ""); await bind("calendly.phone_question", "text", booking.phoneQuestion ?? "");
    } else if (input.booking) {   // explicitly back to the CRM: drop the Calendly bindings so loadCompany stops choosing it
      await c.query("delete from bindings where company_id=$1 and key in ('secret.calendly_token','calendly.organization','calendly.user','calendly.phone_question')", [companyId]);
    }
    for (const [k, v] of Object.entries(input.crm ?? {})) await bind(`crm.${k}`, "id", v);
    const ac: Company = { id: companyId, locationId: input.locationId, pit: input.pit, timezone: input.timezone, booking };
    for (const u of await adapters.read.listUsers(ac))
      await c.query(`insert into users (company_id, email, name, role, ghl_user_id) values ($1,$2,$3,'closer',$4) on conflict (company_id, ghl_user_id) do update set name=excluded.name`, [companyId, u.email ?? `${u.id}@unclaimed.local`, u.name || u.id, u.id]);
    const terms = await many<{ id: string; category: string }>(c, "select id, category from company_terms where company_id=$1 and domain='appointment_type' and is_default", [companyId]);
    const calendarsOut: string[] = [];
    const listed = await bookingFor(adapters, ac).listCalendars(ac);
    for (const k of listed) {
      const m = calMap[k.id]; if (!m) { calendarsOut.push(`skip "${k.name}" (${k.id}) — no mapping${k.note ? ` [${k.note}]` : ""}`); continue; }
      const term = terms.find((t) => t.category === m.term)?.id; if (!term) { calendarsOut.push(`unknown category ${m.term} for ${k.id}`); continue; }
      const du = k.teamMemberIds[0] ? await one<{ id: string }>(c, "select id from users where company_id=$1 and ghl_user_id=$2", [companyId, k.teamMemberIds[0]]) : undefined;
      await c.query(`insert into calendars (company_id, source, external_id, name, appointment_term, default_user_id, self_booked, booking_url) values ($1,$2,$3,$4,$5,$6,$7,$8)
        on conflict (company_id, source, external_id) do update set name=excluded.name, appointment_term=excluded.appointment_term, self_booked=excluded.self_booked, booking_url=coalesce(excluded.booking_url, calendars.booking_url), active=true`,
        [companyId, booking.source, k.id, k.name, term, du?.id ?? null, m.selfBooked ?? null, k.bookingUrl ?? null]);
      calendarsOut.push(`"${k.name}" → ${m.term}${m.selfBooked === undefined ? "" : m.selfBooked ? " (self-booked)" : " (setter-booked)"}`);
    }
    for (const unknownId of Object.keys(calMap).filter((id) => !listed.some((k) => k.id === id))) calendarsOut.push(`mapping for ${unknownId} matches no calendar at the booking source`);
    // calendars of the other source go quiet rather than being deleted: their appointments and history stay
    await c.query("update calendars set active=false where company_id=$1 and source<>$2", [companyId, booking.source]);
    await c.query("delete from poll_cursors where company_id=$1 and entity like 'appointments:%' and split_part(entity, ':', 2) in (select external_id from calendars where company_id=$1 and not active)", [companyId]);
    const closerCal = input.closerCall ?? Object.entries(calMap).find(([, m]) => m.term === "closing")?.[0];
    if (closerCal) await bind("calendar.closer_call", "id", closerCal);
    const bookingCal = input.bookingCalendar ?? Object.entries(calMap).find(([, m]) => m.term === "first_call")?.[0] ?? closerCal;
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
