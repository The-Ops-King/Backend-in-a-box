/**
 * pnpm exec tsx scripts/render-charts.ts [--out <dir>] [name …] — screenshots of workflow charts drawn by the real
 * dashboard component (D107): each chart is built with chartOf from a template, a PMU copy or a built-in nested fixture,
 * the chart-only page in dashboard/render is built with Vite, and Chromium (Playwright) shoots it at desktop width and on
 * a phone. Names: a template slug, pmu/<file>, nested, or messy (D111: a shape only the plain graph draws). Nothing touches a database.
 * Playwright is resolved from this repo or from NODE_PATH; the browser from CHROMIUM (default /opt/pw-browsers/chromium).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import http from "node:http";
import { createRequire } from "node:module";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { chartOf } from "@/api/words";
import { parseDefinition, type Definition } from "@/engine/definition";
import { templates } from "@/templates";
import { messy } from "@/chart/messy";

const ROOT = path.resolve(__dirname, "..");
const args = process.argv.slice(2);
const outAt = args.indexOf("--out");
const OUT = path.resolve(outAt >= 0 ? args[outAt + 1] : path.join(os.tmpdir(), "charts"));
const names = args.filter((a, i) => a !== "--out" && i !== outAt + 1);
const company = { name: "Acme", timezone: "America/Chicago" };
const pmu = (f: string) => JSON.parse(fs.readFileSync(path.join(ROOT, "installs/pmu", `${f}.json`), "utf8")).definition;

/**
 * The shape Tyler saw cut off (D107): PMU's Call booked with its "A new booking or a reschedule?" card fork inside each
 * booking path, rejoining before the Sales Call record, the Slack card and Done.
 */
function nested(): Definition {
  const d = structuredClone(pmu("call-booked")) as { nodes: { id: string }[]; edges: { from: string; to: string }[] };
  const copy = ["f_card", "c_new", "c_rs", "k3", "k5"];
  for (const id of copy) d.nodes.push({ ...structuredClone(d.nodes.find((n) => n.id === id)!), id: `${id}_s` });
  for (const e of d.edges.filter((x) => copy.includes(x.from))) d.edges.push({ ...structuredClone(e), from: `${e.from}_s`, to: copy.includes(e.to) ? `${e.to}_s` : e.to });
  d.edges.find((e) => e.from === "s5")!.to = "f_card_s";
  return parseDefinition(d);
}
const source = (name: string): Definition => {
  if (name === "nested") return nested();
  if (name === "messy") return messy();
  if (name.startsWith("pmu/")) return parseDefinition(pmu(name.slice(4)));
  const t = templates.find((x) => x.slug === name); if (!t) throw new Error(`no chart named ${name}`);
  return parseDefinition(t.definition);
};
const list = names.length ? names : ["pmu/call-booked", "nested", "pmu/call-outcome", "pmu/call-recorded", "pmu/pre-call-sequence", "setter-call-logged", "messy"];

/** Outfit, the dashboard's face, saved next to the page so the shots measure text the way the dashboard does. */
function font(dir: string): string {
  try {
    const css = execFileSync("curl", ["-sS", "--max-time", "15", "-A", "Mozilla/5.0 Chrome/120", "https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600;700"], { encoding: "utf8" });
    return css.replace(/url\((https:[^)]+)\)/g, (_, url: string) => { const file = path.join(dir, path.basename(url)); if (!fs.existsSync(file)) execFileSync("curl", ["-sS", "--max-time", "15", "-o", file, url]); return `url(${path.basename(url)})`; });
  } catch { console.warn("Outfit could not be fetched; the shots use the fallback face"); return ""; }
}

async function main() {
  const site = path.join(OUT, ".site"); fs.mkdirSync(site, { recursive: true });
  await build({
    root: path.join(ROOT, "dashboard/render"), base: "./", logLevel: "warn", plugins: [react()],
    resolve: { alias: { "@": path.join(ROOT, "src"), "~": path.join(ROOT, "dashboard/src") } },
    build: { outDir: site, emptyOutDir: true },
  });
  const css = font(site);
  const req = createRequire(__filename);
  // Playwright is not a dependency of this repo: the few calls used here, typed by hand
  type Shot = { shot: { title: string; chart: unknown }; css: string };
  type Page = { on(e: "pageerror", f: (e: Error) => void): void; addInitScript(f: (a: Shot) => void, a: Shot): Promise<void>; goto(u: string): Promise<unknown>; waitForSelector(s: string): Promise<unknown>; waitForFunction(f: () => boolean): Promise<unknown>; evaluate<T>(f: () => T): Promise<T>; screenshot(o: object): Promise<unknown>; close(): Promise<void> };
  const pw = req(req.resolve("playwright", { paths: [ROOT, ...(process.env.NODE_PATH ?? "/opt/node-tools/node_modules").split(":")] })) as { chromium: { launch(o: object): Promise<{ newPage(o: object): Promise<Page>; close(): Promise<void> }> } };
  // module scripts do not load from file://: a throwaway static server on a free port
  const types: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".ttf": "font/ttf" };
  const server = http.createServer((q, s) => { const f = path.join(site, decodeURIComponent((q.url ?? "/").split("?")[0]).replace(/^\/$/, "/index.html")); if (!f.startsWith(site) || !fs.existsSync(f)) { s.writeHead(404).end(); return; } s.writeHead(200, { "content-type": types[path.extname(f)] ?? "application/octet-stream" }).end(fs.readFileSync(f)); });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const at = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  const browser = await pw.chromium.launch({ executablePath: process.env.CHROMIUM ?? "/opt/pw-browsers/chromium" });
  for (const name of list) {
    const chart = chartOf(source(name), company);
    for (const [tag, width] of [["desktop", 1000], ["phone", 390]] as const) {
      const page = await browser.newPage({ viewport: { width, height: 800 }, deviceScaleFactor: 2 });
      page.on("pageerror", (e) => console.error(name, e.message));
      await page.addInitScript(({ shot, css }) => { (window as unknown as { __shot: unknown }).__shot = shot; addEventListener("DOMContentLoaded", () => { const s = document.createElement("style"); s.textContent = css; document.head.append(s); }); }, { shot: { title: name, chart }, css });
      await page.goto(at);
      await page.waitForSelector(".chart svg");
      await page.waitForFunction(() => !document.body.innerText.includes("Drawing the chart"));
      await page.evaluate(() => document.fonts.ready.then(() => new Promise((r) => setTimeout(r, 150))));
      const file = path.join(OUT, `${name.replace(/\//g, "-")}.${tag}.png`);
      await page.screenshot({ path: file, fullPage: true });
      console.log(file);
      await page.close();
    }
  }
  await browser.close(); server.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
