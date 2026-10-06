import "./_env";
/**
 * One-command bring-up from a fresh session where the environment already holds the secrets:
 *   SUPABASE_DB_URL (or DATABASE_URL), GHL_PRIVATE_TOKEN, GHL_LOCATION_ID, BINDINGS_KEY
 * Migrates, installs the location as a company in SHADOW with SMS off and every workflow OFF, prints the result.
 * Idempotent. Re-running updates bindings and leaves existing workflows and mode alone.
 *
 *   pnpm bootstrap --name "J. Tyler Ray" --slug jtr --tz America/Phoenix \
 *     --calendar GLWzPNAZPoxkROdFJbPH=closing --calendar RzQgbmwwCIJeHv8YLXO8=closing --calendar kbEwrOhdlzxAHIpNLqF7=first_call
 */
import { migrate } from "@/db/migrate";
import { installCompany } from "@/engine/install";
import { liveAdapters } from "@/adapters";
import { db } from "@/db/client";
const args = process.argv.slice(2);
const opt = (k: string) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : undefined; };
const all = (k: string) => args.map((a, i) => (a === `--${k}` ? args[i + 1] : null)).filter((x): x is string => !!x);
(async () => {
  const pit = process.env.GHL_PRIVATE_TOKEN, location = process.env.GHL_LOCATION_ID;
  for (const [k, v] of [["GHL_PRIVATE_TOKEN", pit], ["GHL_LOCATION_ID", location], ["BINDINGS_KEY", process.env.BINDINGS_KEY], ["SUPABASE_DB_URL or DATABASE_URL", process.env.SUPABASE_DB_URL ?? process.env.DATABASE_URL]] as const)
    if (!v) { console.error(`missing ${k}`); process.exit(1); }
  const m = await migrate();
  console.log(`schema ${m.applied ? "applied" : "already present"}; RLS forced on ${m.rlsTables.length} tenant tables`);
  const r = await installCompany({
    name: opt("name") ?? "Company", slug: opt("slug") ?? "company", timezone: opt("tz") ?? "America/Phoenix",
    locationId: location!, pit: pit!,
    calendars: Object.fromEntries(all("calendar").map((s) => s.split("=") as [string, string])),
    closerCall: opt("closer-call"), bookingCalendar: opt("booking"),
    smsEnabled: false, mode: "shadow", enable: false,
  }, liveAdapters);
  console.log(`company ${opt("slug") ?? "company"} = ${r.companyId} (shadow, SMS off, all workflows OFF)`);
  r.calendars.forEach((s) => console.log(`  ${s}`)); r.installed.forEach((s) => console.log(`  ${s}`));
  await db().end();
})().catch((e) => { console.error(e); process.exit(1); });
