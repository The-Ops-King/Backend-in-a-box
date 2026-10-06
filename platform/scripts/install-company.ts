import "./_env";
/**
 * pnpm install:company --name "Save Your Hair" --slug syh --tz America/Phoenix --location <id> --pit <pit> \
 *   --calendar <id>=closing --calendar <id>=first_call[:self|:setter] [--closer-call <id>] [--booking <id>] [--template <slug>] [--enable] [--no-sms] [--live]
 *   [--calendly-token <token> [--calendly-user <host email>] [--calendly-phone-question "Phone Number"]]   appointments from Calendly event types instead of GHL calendars
 * Workflows install OFF unless --enable. Company runs in SHADOW mode (nothing written to the CRM) unless --live.
 */
import { installCompany } from "@/engine/install";
import { liveAdapters } from "@/adapters";
import { db } from "@/db/client";
const args = process.argv.slice(2);
const opt = (k: string) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : undefined; };
const all = (k: string) => args.map((a, i) => (a === `--${k}` ? args[i + 1] : null)).filter((x): x is string => !!x);
const need = (k: string) => { const v = opt(k); if (!v) { console.error(`--${k} is required`); process.exit(1); } return v; };
(async () => {
  const out = await installCompany({
    bookingCalendar: opt("booking"),
    name: need("name"), slug: need("slug"), timezone: need("tz"), locationId: need("location"), pit: need("pit"),
    calendars: Object.fromEntries(all("calendar").map((s) => { const [id, rest] = s.split("=") as [string, string]; const [term, kind] = rest.split(":"); return [id, kind ? { term, selfBooked: kind === "self" } : term]; })),
    booking: opt("calendly-token") ? { source: "calendly", token: opt("calendly-token")!, userEmail: opt("calendly-user"), phoneQuestion: opt("calendly-phone-question") } : undefined,
    closerCall: opt("closer-call"), templates: all("template"), enable: args.includes("--enable"), smsEnabled: args.includes("--no-sms") ? false : args.includes("--sms") ? true : undefined, mode: args.includes("--live") ? "live" : args.includes("--shadow") ? "shadow" : undefined,
  }, liveAdapters);
  console.log(`company = ${out.companyId}`); out.calendars.forEach((s) => console.log(`  ${s}`)); out.installed.forEach((s) => console.log(`  ${s}`));
  await db().end();
})().catch((e) => { console.error(e); process.exit(1); });
