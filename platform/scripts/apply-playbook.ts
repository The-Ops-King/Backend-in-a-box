import "./_env";
/**
 * pnpm exec tsx scripts/apply-playbook.ts <company> [--apply] [--copy-settings-from <slug>] — D147: puts the company's playbook
 * (installs/<company>/playbook.json, its params) on the company in the engine through POST /api/admin/playbooks: each copy built
 * from today's templates and saved, all or nothing, nothing removed. A dry run unless --apply. `--copy-settings-from`: first copy
 * that company's offer settings where this one has none of its own ("duplicate PMU"). Needs CRON_SECRET; the engine is BIAB_URL
 * (default https://backend-in-a-box.vercel.app).
 */
import { companyPlaybook } from "../src/playbooks/files";

const args = process.argv.slice(2);
const company = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--copy-settings-from");
const from = args[args.indexOf("--copy-settings-from") + 1];
const apply = args.includes("--apply");
if (!company) { console.error("usage: apply-playbook.ts <company> [--apply] [--copy-settings-from <slug>]"); process.exit(2); }
const secret = process.env.CRON_SECRET ?? process.env.BIAB_CRON_SECRET;
if (!secret) { console.error("CRON_SECRET is not set"); process.exit(2); }
const url = (process.env.BIAB_URL ?? "https://backend-in-a-box.vercel.app").replace(/\/$/, "");
(async () => {
  const { playbook, params } = companyPlaybook(company);
  const r = await fetch(`${url}/api/admin/playbooks`, { method: "POST", headers: { Authorization: `Bearer ${secret}`, "content-type": "application/json" },
    body: JSON.stringify({ company, playbook, params, ...(args.includes("--copy-settings-from") ? { copySettingsFrom: from } : {}), dryRun: !apply, by: "apply-playbook" }) });
  const out = await r.json();
  console.log(JSON.stringify(out, null, 2));
  if (!apply && r.ok) console.log("\nA dry run: nothing was written. Run again with --apply.");
  process.exit(r.ok ? 0 : 1);
})();
