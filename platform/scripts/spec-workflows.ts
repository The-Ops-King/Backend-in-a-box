/**
 * pnpm spec [--from repo|db] [offer…] — writes the behavior spec: spec/<offer>/README.md (every workflow) and
 * spec/<offer>/<workflow>.md (every step, its words, conditions, waits, failures, settings and the engine rules on it).
 *
 * --from repo (the default): the repo's install files and shipped templates; labelled "may differ from live".
 * --from db: every offer's current saved versions, read-only, over SPEC_DATABASE_URL (a role that can only read; secrets are
 * never read, only whether one is set). Nothing is written anywhere but spec/.
 */
import fs from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { renderIndex, renderWorkflow, type IndexRow, type OfferInfo } from "../src/spec/render";
import { loadDbOffers, loadRepoOffer, readOnlySession, repoOffers } from "../src/spec/sources";

const SPEC = path.resolve(__dirname, "../../spec");
const args = process.argv.slice(2);
const fromAt = args.indexOf("--from");
const from = fromAt >= 0 ? args[fromAt + 1] : "repo";
const only = args.filter((a, i) => !a.startsWith("--") && (fromAt < 0 || i !== fromAt + 1));
const generatedAt = new Date().toISOString().slice(0, 10);

function write(offer: OfferInfo, rows: IndexRow[]) {
  const dir = path.join(SPEC, offer.slug);
  fs.mkdirSync(dir, { recursive: true });
  for (const f of fs.readdirSync(dir)) if (f.endsWith(".md")) fs.rmSync(path.join(dir, f));   // a removed workflow leaves no stale file
  fs.writeFileSync(path.join(dir, "README.md"), renderIndex(offer, rows, generatedAt));
  for (const { w, removed } of rows) if (!removed) fs.writeFileSync(path.join(dir, `${w.slug}.md`), renderWorkflow(offer, w, generatedAt));
  console.log(`${offer.slug}: ${rows.filter((r) => !r.removed).length} workflows → spec/${offer.slug}/`);
}

async function main() {
  if (from === "repo") {
    for (const slug of repoOffers().filter((s) => !only.length || only.includes(s))) { const { offer, rows } = loadRepoOffer(slug); write(offer, rows); }
    return;
  }
  if (from !== "db") throw new Error(`--from must be repo or db, not ${from}`);
  const url = process.env.SPEC_DATABASE_URL;
  if (!url) throw new Error("SPEC_DATABASE_URL is not set (a read-only role; see the spec README)");
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await readOnlySession(client as unknown as import("pg").PoolClient);
    for (const { offer, rows } of await loadDbOffers(client as unknown as import("pg").PoolClient)) if (!only.length || only.includes(offer.slug)) write(offer, rows);
  } finally { await client.end(); }
}

main().catch((e) => { console.error((e as Error).message); process.exit(1); });
