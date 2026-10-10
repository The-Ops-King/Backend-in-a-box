import "./_env";
/**
 * pnpm install:company --name "Save Your Hair" --slug syh --tz America/Phoenix --location <id> [--pit <pit>] \
 *   --calendar <id>=closing --calendar <id>=first_call[:self|:setter] [--closer-call <id>] [--booking <id>] [--template <slug>] [--enable] [--no-sms] [--live]
 *   [--calendly-token <token> [--calendly-user <host email>] [--calendly-phone-question "Phone Number"]]   appointments from Calendly event types instead of GHL calendars
 *   [--fathom-key <api key>] [--fathom-secret <whsec_…>] [--anthropic-key <key>] [--prompt <name>=<file>] [--crm <key>=<id>]
 *   [--qualify-mql "<answer>"]… [--qualify-dq "<answer>"]… [--unanswered-is-mql true|false]   the work-situation answers (with --crm field_contact_work_situation=<id>), D73
 *   [--sales-call-object custom_objects.sales_call] [--sales-call-outcome <value>=showed|noshow|cancelled|rescheduled]… [--sales-dq-disposition dq]…   what the show rate and sales DQs read, D73
 * Workflows install OFF unless --enable. Company runs in SHADOW mode (nothing written to the CRM) unless --live.
 */
import { installCompany } from "@/engine/install";
import { liveAdapters } from "@/adapters";
import { db } from "@/db/client";
import { readFileSync } from "node:fs";
const args = process.argv.slice(2);
const opt = (k: string) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : undefined; };
const all = (k: string) => args.map((a, i) => (a === `--${k}` ? args[i + 1] : null)).filter((x): x is string => !!x);
const need = (k: string) => { const v = opt(k); if (!v) { console.error(`--${k} is required`); process.exit(1); } return v; };
(async () => {
  const out = await installCompany({
    bookingCalendar: opt("booking"),
    name: need("name"), slug: need("slug"), timezone: need("tz"), locationId: need("location"), pit: opt("pit"),   // omit on a re-install: the stored token is kept
    calendars: Object.fromEntries(all("calendar").map((s) => { const [id, rest] = s.split("=") as [string, string]; const [term, kind] = rest.split(":"); return [id, kind ? { term, selfBooked: kind === "self" } : term]; })),
    booking: opt("calendly-token") ? { source: "calendly", token: opt("calendly-token")!, userEmail: opt("calendly-user"), phoneQuestion: opt("calendly-phone-question") } : undefined,
    closerCall: opt("closer-call"),
    recording: opt("fathom-key") || opt("fathom-secret") ? { source: "fathom", apiKey: opt("fathom-key"), webhookSecret: opt("fathom-secret") } : undefined,
    anthropicKey: opt("anthropic-key"),
    prompts: Object.fromEntries(all("prompt").map((s) => { const [name, file] = s.split("=") as [string, string]; return [name, readFileSync(file, "utf8")]; })),
    qualify: all("qualify-mql").length || all("qualify-dq").length || opt("unanswered-is-mql") ? { mqlAnswers: all("qualify-mql").length ? all("qualify-mql") : undefined, dqAnswers: all("qualify-dq").length ? all("qualify-dq") : undefined, unansweredIsMql: opt("unanswered-is-mql") ? opt("unanswered-is-mql") === "true" : undefined } : undefined,
    salesCall: opt("sales-call-object") || all("sales-call-outcome").length || all("sales-dq-disposition").length ? { object: opt("sales-call-object"), outcomes: all("sales-call-outcome").length ? Object.fromEntries(all("sales-call-outcome").map((s) => s.split("=") as [string, "showed"])) : undefined, dqDispositions: all("sales-dq-disposition").length ? all("sales-dq-disposition") : undefined } : undefined,
    crm: Object.fromEntries(all("crm").map((s) => s.split("=") as [string, string])), templates: all("template"), enable: args.includes("--enable"), smsEnabled: args.includes("--no-sms") ? false : args.includes("--sms") ? true : undefined, mode: args.includes("--live") ? "live" : args.includes("--shadow") ? "shadow" : undefined,
  }, liveAdapters);
  console.log(`company = ${out.companyId}`); out.calendars.forEach((s) => console.log(`  ${s}`)); out.installed.forEach((s) => console.log(`  ${s}`));
  console.log(`inbound: zapier secret ${out.inbound.secret}`); console.log(`  payments  ${out.inbound.whopWebhookUrl} (Whop) · ${out.inbound.zapierPaymentUrl} (Zap)`); console.log(`  recordings ${out.inbound.fathomWebhookUrl} (Fathom${out.inbound.fathomWebhook ? `, registered ${out.inbound.fathomWebhook}` : ""}) · ${out.inbound.zapierRecordingUrl} (Zap)`);
  await db().end();
})().catch((e) => { console.error(e); process.exit(1); });
