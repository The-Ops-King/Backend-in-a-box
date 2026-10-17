import "./_env";
/**
 * D122: the existing Typeform responses into GHL, through the webhook's own path.
 *   With the database (DATABASE_URL), the company's bindings:
 *     pnpm exec tsx scripts/import-typeform.ts --company dating-nelly --form AjY7UfXZ [--out report.txt]          dry run: reads only
 *     pnpm exec tsx scripts/import-typeform.ts --company dating-nelly --form AjY7UfXZ --apply [--limit 50] [--new-lead]   real writes, whatever the mode;
 *       --new-lead (D123): each newly imported response is dispatched as the webhook would (New from Typeform: tag, New lead once)
 *   Without it (dry run only), from an install file and tokens in the environment:
 *     pnpm exec tsx scripts/import-typeform.ts --install installs/dating-nelly.json --form AjY7UfXZ --token-env DN_TYPEFORM_TOKEN \
 *       --pit-env DATING2_GHL_PIT --location-env DATING2_GHL_LOCATION_ID [--out report.txt]
 * In production the same is POST /api/admin/typeform-import { company, form, apply?, limit?, newLead? }.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { liveAdapters } from "@/adapters";
import type { Company } from "@/adapters/types";
import { applyImport, companyTypeform, dryRunImport, formatDryRun, writtenKeys } from "@/engine/typeform-import";
import type { TypeformForms } from "@/engine/typeform";

const args = process.argv.slice(2);
const opt = (k: string) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : undefined; };
const need = (k: string) => { const v = opt(k); if (!v) { console.error(`--${k} is required`); process.exit(1); } return v; };
(async () => {
  const formId = need("form"), apply = args.includes("--apply"), out = opt("out");
  let text: string;
  if (opt("install")) {
    if (apply) { console.error("--apply needs the database: use --company"); process.exit(1); }
    const inst = JSON.parse(readFileSync(opt("install")!, "utf8")) as { name: string; timezone: string; locationId: string; scopeTag?: string; crm?: Record<string, string>; typeform?: { forms?: TypeformForms } };
    const form = inst.typeform?.forms?.[formId]; if (!form) { console.error(`${formId} is not in the install file's typeform.forms`); process.exit(1); }
    const token = process.env[need("token-env")], pit = process.env[need("pit-env")], loc = process.env[need("location-env")] ?? inst.locationId;
    if (!token || !pit || !loc) { console.error("set the token, the PIT and the location id in the environment"); process.exit(1); }
    const bindings: Record<string, string> = { ...Object.fromEntries(Object.entries(inst.crm ?? {}).map(([k, v]) => [`crm.${k}`, v])), ...(inst.scopeTag ? { "scope.tag": inst.scopeTag } : {}) };
    const ac: Company = { id: "dry-run", locationId: loc, pit, timezone: inst.timezone, booking: { source: "ghl" } };
    text = formatDryRun(await dryRunImport({ token, formId, form, bindings, ac, adapters: liveAdapters }), `${inst.name}, from ${opt("install")} (no database)`);
  } else {
    const t = await companyTypeform(need("company"));
    const form = t.forms[formId]; if (!form) { console.error(`${formId} is not mapped for this company`); process.exit(1); }
    if (!t.token) { console.error("no Typeform token bound"); process.exit(1); }
    if (apply) text = JSON.stringify({ mode: t.company.mode, ...(await applyImport({ companyId: t.company.id, formId, adapters: liveAdapters, limit: opt("limit") ? Number(opt("limit")) : undefined, newLead: args.includes("--new-lead") })) }, null, 2);
    else text = formatDryRun(await dryRunImport({ token: t.token, formId, form, bindings: t.bindings, ac: t.ac, adapters: liveAdapters, written: await writtenKeys(t.company.id) }), `${t.company.name}, ${t.company.mode}`);
    await (await import("@/db/client")).db().end();
  }
  console.log(text);
  if (out) { writeFileSync(out, text + "\n"); console.log(`\n→ ${out}`); }
})().catch((e) => { console.error(e); process.exit(1); });
