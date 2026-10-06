import "./_env";
/**
 * D16: upload info, pick templates, done.
 *   pnpm install:company --name "Save Your Hair" --slug syh --tz America/Phoenix --location <ghl_location_id> --pit <pit> \
 *       --calendar <ghl_calendar_id>=closing --calendar <ghl_calendar_id>=first_call [--closer-call <ghl_calendar_id>] [--template appointment-reminder ...] [--enable]
 * Idempotent: re-running updates bindings and leaves existing workflows alone.
 * Workflows are installed OFF. Pass --enable to turn on the ones whose required bindings are all present (Tyler's rule: build everything off, enable deliberately).
 */
import { asOperator, one, many } from "@/db/client";
import { encrypt } from "@/engine/crypto";
import { extractManifest, parseDefinition, indexDefinition } from "@/engine/definition";
import { templates } from "@/templates";
import { liveAdapters } from "@/adapters";
import { db } from "@/db/client";

const args = process.argv.slice(2);
const opt = (k: string) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : undefined; };
const all = (k: string) => args.map((a, i) => (a === `--${k}` ? args[i + 1] : null)).filter((x): x is string => !!x);
const need = (k: string) => { const v = opt(k); if (!v) { console.error(`--${k} is required`); process.exit(1); } return v; };

(async () => {
  const name = need("name"), slug = need("slug"), tz = need("tz"), location = need("location"), pit = need("pit");
  const calMap = Object.fromEntries(all("calendar").map((s) => s.split("=") as [string, string]));
  const wanted = all("template").length ? all("template") : templates.map((t) => t.slug);

  const out = await asOperator(async (c) => {
    const co = await one<{ id: string }>(c, `insert into companies (name, slug, timezone) values ($1,$2,$3) on conflict (slug) do update set name=excluded.name, timezone=excluded.timezone returning id`, [name, slug, tz]);
    const companyId = co!.id;
    // every core value becomes a company term (02-data-model §3)
    await c.query(`insert into company_terms (company_id, domain, name, category, is_default, sort)
      select $1, domain, label, value, true, sort from core_categories on conflict (company_id, domain, name) do nothing`, [companyId]);
    // bindings
    const bind = async (key: string, kind: string, value: string) =>
      c.query(`insert into bindings (company_id, key, kind, value) values ($1,$2,$3,$4) on conflict (company_id, key) do update set value=excluded.value, updated_at=now()`, [companyId, key, kind, kind === "secret" ? encrypt(value) : Buffer.from(value)]);
    await bind("crm.location_id", "id", location); await bind("secret.ghl_pit", "secret", pit);
    const ac = { id: companyId, locationId: location, pit, timezone: tz };
    // users from the CRM roster (unclaimed until they log in)
    for (const u of await liveAdapters.read.listUsers(ac))
      await c.query(`insert into users (company_id, email, name, role, ghl_user_id) values ($1,$2,$3,'closer',$4) on conflict (company_id, ghl_user_id) do update set name=excluded.name`, [companyId, u.email ?? `${u.id}@unclaimed.local`, u.name || u.id, u.id]);
    // calendars → appointment types
    const cals = await liveAdapters.read.listCalendars(ac);
    const terms = await many<{ id: string; category: string }>(c, "select id, category from company_terms where company_id=$1 and domain='appointment_type' and is_default", [companyId]);
    const termFor = (cat: string) => terms.find((t) => t.category === cat)?.id;
    for (const k of cals) {
      const cat = calMap[k.id]; if (!cat) { console.log(`  skip calendar "${k.name}" (${k.id}) — no --calendar mapping`); continue; }
      const term = termFor(cat); if (!term) { console.error(`  unknown category ${cat} for calendar ${k.id}`); continue; }
      const du = k.teamMemberIds[0] ? await one<{ id: string }>(c, "select id from users where company_id=$1 and ghl_user_id=$2", [companyId, k.teamMemberIds[0]]) : undefined;
      await c.query(`insert into calendars (company_id, ghl_calendar_id, name, appointment_term, default_user_id) values ($1,$2,$3,$4,$5) on conflict (company_id, ghl_calendar_id) do update set name=excluded.name, appointment_term=excluded.appointment_term`, [companyId, k.id, k.name, term, du?.id ?? null]);
      console.log(`  calendar "${k.name}" → ${cat}`);
    }
    const closerCal = opt("closer-call") ?? Object.entries(calMap).find(([, cat]) => cat === "closing")?.[0];
    if (closerCal) await bind("calendar.closer_call", "id", closerCal);
    // templates → copies
    const installed: string[] = [];
    for (const t of templates.filter((t) => wanted.includes(t.slug))) {
      const def = parseDefinition(t.definition); const manifest = extractManifest(def);
      let tpl = await one<{ id: string; version: number }>(c, "select id, version from workflow_templates where slug=$1", [t.slug]);
      if (!tpl) tpl = await one<{ id: string; version: number }>(c, "insert into workflow_templates (slug, name, description, category, definition, manifest, published_at) values ($1,$2,$3,$4,$5,$6,now()) returning id, version", [t.slug, t.name, t.description, t.category, t.definition, manifest]);
      const exists = await one<{ id: string }>(c, "select id from workflows where company_id=$1 and template_id=$2", [companyId, tpl!.id]);
      if (exists) { installed.push(`${t.slug} (already installed)`); continue; }
      const wf = await one<{ id: string }>(c, `insert into workflows (company_id, template_id, template_version, name, reentry_policy, reentry_window) values ($1,$2,$3,$4,$5,$6) returning id`,
        [companyId, tpl!.id, tpl!.version, t.name, def.reentry, def.reentry_window ? `${def.reentry_window}` : null]);
      await c.query("insert into workflow_versions (workflow_id, version, definition, manifest, note) values ($1,1,$2,$3,'installed from template')", [wf!.id, t.definition, manifest]);
      for (const trig of indexDefinition(def).triggers) await c.query("insert into workflow_triggers (company_id, workflow_id, node_id, event_type, match) values ($1,$2,$3,$4,$5)", [companyId, wf!.id, trig.id, trig.event, trig.match ?? {}]);
      // enable gate: every required binding present AND --enable was passed. Default is OFF.
      const bound = new Set((await many<{ key: string }>(c, "select key from bindings where company_id=$1", [companyId])).map((b) => b.key));
      const missing = manifest.bindings.filter((b) => b.required && !bound.has(b.key)).map((b) => b.key);
      const wantEnable = args.includes("--enable");
      if (wantEnable && !missing.length) await c.query("update workflows set enabled=true where id=$1", [wf!.id]);
      installed.push(`${t.slug} → ${missing.length ? `OFF, missing: ${missing.join(", ")}` : wantEnable ? "enabled" : "installed OFF (pass --enable to turn on)"}`);
    }
    return { companyId, installed };
  });
  console.log(`company ${slug} = ${out.companyId}`); out.installed.forEach((s) => console.log(`  ${s}`));
  await db().end();
})().catch((e) => { console.error(e); process.exit(1); });
