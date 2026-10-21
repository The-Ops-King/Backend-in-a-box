/**
 * pnpm traces [--per-path N] [offer…] — golden traces: up to N (default 5) recent runs of each workflow for every way a run
 * ended, with the event that started it, its steps, sends, Slack posts and CRM writes, every person replaced by a pseudonym.
 * Writes spec/<offer>/traces/<workflow>.json. Read-only over SPEC_DATABASE_URL; nothing else is touched.
 */
import fs from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { readOnlySession } from "../src/spec/sources";
import { exportTraces } from "../src/spec/traces";

const SPEC = path.resolve(__dirname, "../../spec");
const args = process.argv.slice(2);
const at = args.indexOf("--per-path");
const perPath = at >= 0 ? Number(args[at + 1]) : 5;
const offers = args.filter((a, i) => !a.startsWith("--") && (at < 0 || i !== at + 1));

async function main() {
  const url = process.env.SPEC_DATABASE_URL;
  if (!url) throw new Error("SPEC_DATABASE_URL is not set (a read-only role)");
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    const c = client as unknown as import("pg").PoolClient;
    await readOnlySession(c);
    for (const { offer, files } of await exportTraces(c, { perPath, offers })) {
      const dir = path.join(SPEC, offer, "traces");
      fs.mkdirSync(dir, { recursive: true });
      for (const f of files) fs.writeFileSync(path.join(dir, `${f.slug}.json`), JSON.stringify(f, null, 2) + "\n");
      console.log(`${offer}: ${files.length} workflows with runs → spec/${offer}/traces/`);
    }
  } finally { await client.end(); }
}

main().catch((e) => { console.error((e as Error).message); process.exit(1); });
