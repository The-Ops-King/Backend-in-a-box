import "./_env";
/**
 * pnpm exec tsx scripts/provision-ghl.ts --setup installs/dating/ghl-setup.json --pit-env DATING2_GHL_PIT --location-env DATING2_GHL_LOCATION_ID --out <file.json> [--apply]
 * Additive GHL setup (src/adapters/ghl/provision.ts). Without --apply it only reads and prints the plan. With --apply it creates
 * what is missing; a re-run after a partial failure picks up where it stopped. D121: the setup's calendars go in its
 * `calendarGroup` (made if missing) and take its `team`; the plan shows a team change as `change-on-ours` with before → after. --out gets the install skeleton: the setup's
 * `install` block with every id found or made (crm map, calendars, closerCall, bookingCalendar, salesCall.object).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { ghl } from "@/adapters/ghl/client";
import { provision, printable, summary, type Setup } from "@/adapters/ghl/provision";

const args = process.argv.slice(2);
const opt = (k: string) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : undefined; };
const need = (k: string) => { const v = opt(k); if (!v) { console.error(`--${k} is required`); process.exit(1); } return v; };
(async () => {
  const setup = JSON.parse(readFileSync(need("setup"), "utf8")) as Setup;
  const pitVar = need("pit-env"), locVar = need("location-env"), out = need("out"), apply = args.includes("--apply");
  const pit = process.env[pitVar], loc = process.env[locVar];
  if (!pit || !loc) { console.error(`set ${pitVar} and ${locVar} in the environment`); process.exit(1); }
  const name = (await ghl<{ location?: { name?: string } }>(pit, "GET", `/locations/${loc}`)).location?.name ?? "?";
  console.log(`${apply ? "APPLY" : "DRY RUN (reads only)"} on ${name} (${loc}), setup ${opt("setup")}, prefix "${setup.prefix}"\n`);
  const r = await provision(setup, loc, (m, p, o) => ghl(pit, m, p, o), { apply });
  console.log(printable(r.plan));
  console.log(`\n${summary(r.plan)}`);
  if (r.writes.length) { console.log(`\nwrote ${r.writes.length}:\n  ${r.writes.join("\n  ")}`); console.log(`\nafter: ${summary(r.after ?? [])}`); }
  if (r.install._missing) console.log(`\nnot in the output yet: ${(r.install._missing as string[]).join(", ")}`);
  writeFileSync(out, JSON.stringify(r.install, null, 2) + "\n");
  console.log(`\ninstall skeleton → ${out}`);
})().catch((e) => { console.error(e); process.exit(1); });
