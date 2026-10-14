/**
 * pnpm exec tsx scripts/sales-call-report.ts <out.html> <report.json> [more.json …] — the Sales Call history route's answers
 * (POST /api/admin/backfill/sales-calls, D115; one file per pass when a window took several) as one page to review before the
 * write: each call, each field with its evidence, the most likely reading of what is unknown. Reads files only.
 */
import fs from "node:fs";
import { salesCallReportHtml } from "@/engine/sales-call-report";
import type { SalesCallReport } from "@/engine/sales-call-backfill";

const [out, ...inputs] = process.argv.slice(2);
if (!out || !inputs.length) { console.error("usage: tsx scripts/sales-call-report.ts <out.html> <report.json> [more.json …]"); process.exit(2); }
const reports = inputs.map((f) => {
  const j = JSON.parse(fs.readFileSync(f, "utf8")) as SalesCallReport & { ok?: boolean; error?: string };
  if (j.ok === false || !Array.isArray(j.rows)) throw new Error(`${f}: not a sales-call answer${j.error ? ` (${j.error})` : ""}`);
  return j;
});
fs.writeFileSync(out, salesCallReportHtml(reports));
console.log(`${out}: ${reports.reduce((n, r) => n + r.rows.length, 0)} calls`);
